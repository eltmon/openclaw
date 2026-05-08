import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import { type AnyAgentTool, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { refreshAccessToken } from "./oauth.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

const ACTIONS = ["search", "read", "labels"] as const;

const GmailReadSchema = Type.Object({
  action: optionalStringEnum(ACTIONS, {
    description:
      'Action to perform: "search" (default), "read" (get full message), or "labels" (list labels).',
    default: "search",
  }),
  query: Type.Optional(
    Type.String({
      description:
        'Gmail search query (same syntax as Gmail search box). Examples: "from:user@example.com", "is:unread", "subject:hello", "after:2026/01/01", "has:attachment".',
    }),
  ),
  messageId: Type.Optional(
    Type.String({
      description: "Message ID to read (required when action is 'read').",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum number of messages to return (1-50, default 10).",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

type OAuthCredential = {
  type: "oauth";
  provider: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
};

/**
 * Resolve the Gmail OAuth credential by reading auth-profiles.json from disk.
 * Looks for provider "gmail-readonly" in the main agent's auth profiles.
 */
function resolveGmailCredential(): OAuthCredential | undefined {
  const stateDir = process.env.OPENCLAW_STATE_DIR || join(process.env.HOME || "~", ".openclaw");
  const authPath = join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  try {
    const raw = readFileSync(authPath, "utf-8");
    const store = JSON.parse(raw) as { profiles?: Record<string, OAuthCredential> };
    if (!store.profiles) {
      return undefined;
    }
    for (const [_id, cred] of Object.entries(store.profiles)) {
      if (cred?.provider === "gmail-readonly" && cred?.type === "oauth") {
        return cred;
      }
    }
  } catch {
    // File doesn't exist or parse error
  }
  return undefined;
}

/**
 * Get a valid access token, refreshing if needed.
 */
async function getAccessToken(credential: OAuthCredential): Promise<string> {
  // If token is still valid (with 5min buffer), use it
  if (credential.access && credential.expires && Date.now() < credential.expires) {
    return credential.access;
  }
  // Otherwise refresh
  if (!credential.refresh) {
    throw new Error(
      "Gmail OAuth refresh token not found. Run 'openclaw auth add gmail-readonly' to authenticate.",
    );
  }
  const refreshed = await refreshAccessToken(credential.refresh);
  // Update the credential in-place for this session
  credential.access = refreshed.access;
  credential.expires = refreshed.expires;
  return refreshed.access;
}

type GmailMessageHeader = { name: string; value: string };
type GmailMessagePart = {
  mimeType: string;
  headers?: GmailMessageHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
};
type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
};

function getHeader(headers: GmailMessageHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Recursively extract text/plain body from MIME parts. */
function extractTextBody(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractTextBody(child);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

/** Format a full message into a clean summary. */
function formatMessage(msg: GmailMessage) {
  const headers = msg.payload?.headers;
  const body = msg.payload ? extractTextBody(msg.payload) : "";
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    labels: msg.labelIds,
    snippet: msg.snippet,
    body: body.length > 8000 ? body.slice(0, 8000) + "\n[truncated]" : body,
  };
}

async function gmailFetch(accessToken: string, path: string): Promise<unknown> {
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API error (${response.status}): ${errorText}`);
  }
  return response.json();
}

async function searchMessages(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<unknown> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
  });
  if (query) {
    params.set("q", query);
  }

  const listResult = (await gmailFetch(accessToken, `/users/me/messages?${params}`)) as {
    messages?: Array<{ id: string; threadId: string }>;
    resultSizeEstimate?: number;
  };

  if (!listResult.messages?.length) {
    return { messages: [], resultSizeEstimate: 0, query };
  }

  // Fetch full message details for each result
  const messages = await Promise.all(
    listResult.messages.map(async (m) => {
      const full = (await gmailFetch(
        accessToken,
        `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      )) as GmailMessage;
      return {
        id: full.id,
        threadId: full.threadId,
        from: getHeader(full.payload?.headers, "From"),
        to: getHeader(full.payload?.headers, "To"),
        subject: getHeader(full.payload?.headers, "Subject"),
        date: getHeader(full.payload?.headers, "Date"),
        labels: full.labelIds,
        snippet: full.snippet,
      };
    }),
  );

  return {
    messages,
    resultSizeEstimate: listResult.resultSizeEstimate,
    query,
  };
}

async function readMessage(accessToken: string, messageId: string): Promise<unknown> {
  const msg = (await gmailFetch(
    accessToken,
    `/users/me/messages/${messageId}?format=full`,
  )) as GmailMessage;
  return formatMessage(msg);
}

async function listLabels(accessToken: string): Promise<unknown> {
  const result = (await gmailFetch(accessToken, "/users/me/labels")) as {
    labels: Array<{ id: string; name: string; type: string }>;
  };
  return {
    labels: result.labels.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
    })),
  };
}

export function createGmailReadTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    label: "Gmail Read",
    name: "gmail_read",
    description: [
      "Search and read emails from Gmail (read-only).",
      "Actions: 'search' (default) to find emails by query, 'read' to get a full message by ID, 'labels' to list available labels.",
      "Uses Gmail search syntax for queries (same as the Gmail search box).",
    ].join(" "),
    parameters: GmailReadSchema,
    // ownerOnly removed — single-owner instance

    async execute(_toolCallId: string, args: Record<string, unknown>) {
      const credential = resolveGmailCredential();
      if (!credential) {
        return jsonResult({
          error: "gmail_not_configured",
          message:
            "Gmail OAuth not configured. Run 'openclaw auth add gmail-readonly' to authenticate, or set up auth profiles manually.",
        });
      }

      let accessToken: string;
      try {
        accessToken = await getAccessToken(credential);
      } catch (err) {
        return jsonResult({
          error: "gmail_auth_failed",
          message: err instanceof Error ? err.message : "Failed to get Gmail access token",
        });
      }

      const action = readStringParam(args, "action") ?? "search";
      const query = readStringParam(args, "query") ?? "";
      const messageId = readStringParam(args, "messageId");
      const maxResults = readNumberParam(args, "maxResults", { integer: true }) ?? 10;

      try {
        switch (action) {
          case "read": {
            if (!messageId) {
              return jsonResult({
                error: "missing_message_id",
                message: "messageId is required when action is 'read'",
              });
            }
            const message = await readMessage(accessToken, messageId);
            return jsonResult(message);
          }
          case "labels": {
            const labels = await listLabels(accessToken);
            return jsonResult(labels);
          }
          case "search":
          default: {
            const results = await searchMessages(accessToken, query, maxResults);
            return jsonResult(results);
          }
        }
      } catch (err) {
        return jsonResult({
          error: "gmail_api_error",
          message: err instanceof Error ? err.message : "Gmail API request failed",
        });
      }
    },
  };
}
