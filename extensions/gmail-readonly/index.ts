import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk/provider-auth";
import { createGmailReadTool } from "./src/gmail-tool.js";
import { loginGmailOAuth } from "./src/oauth.js";

const PROVIDER_ID = "gmail-readonly";
const PROVIDER_LABEL = "Gmail (Read-Only)";
const ENV_VARS = [
  "OPENCLAW_GMAIL_OAUTH_CLIENT_ID",
  "OPENCLAW_GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
];

export default definePluginEntry({
  id: "gmail-readonly",
  name: "Gmail Read-Only",
  description: "Read-only Gmail integration with OAuth authentication and gmail_read tool",

  register(api) {
    // Register the OAuth provider for `openclaw auth add gmail-readonly`
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/plugins/gmail-readonly",
      aliases: ["gmail"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "oauth",
          label: "Google OAuth (gmail.readonly)",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx: ProviderAuthContext) => {
            const spin = ctx.prompter.progress("Starting Gmail OAuth…");
            try {
              const result = await loginGmailOAuth({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                log: (msg) => ctx.runtime.log(msg),
                note: ctx.prompter.note,
                prompt: async (message) => ctx.prompter.text({ message }),
                progress: spin,
              });

              spin.stop("Gmail OAuth complete");
              return buildOauthProviderAuthResult({
                providerId: PROVIDER_ID,
                defaultModel: "", // not an LLM provider
                access: result.access,
                refresh: result.refresh,
                expires: result.expires,
                email: result.email,
              });
            } catch (err) {
              spin.stop("Gmail OAuth failed");
              await ctx.prompter.note(
                "Trouble with OAuth? Ensure your Google account has Gmail API access enabled in GCP Console.",
                "OAuth help",
              );
              throw err;
            }
          },
        },
      ],
    });

    // Register the gmail_read tool (optional — must be allowlisted)
    api.registerTool(createGmailReadTool(api) as unknown as AnyAgentTool, { optional: true });
  },
});
