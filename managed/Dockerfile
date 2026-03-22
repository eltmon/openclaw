# MYN Managed OpenClaw Image
# Builds a production-ready OpenClaw image pre-configured for MYN's Kaia AI.
# Each user gets their own instance of this image running on Fly.io.
#
# Build:
#   docker build -f managed/Dockerfile -t registry.fly.io/myn-openclaw:v1.0.0-myn .
# Push:
#   fly auth docker && docker push registry.fly.io/myn-openclaw:v1.0.0-myn
#
# Environment variables expected at runtime (injected by MYN provisioning):
#   MYN_API_BASE          - MYN backend API base URL
#   MYN_AGENT_API_KEY     - API key to authenticate calls back to MYN
#   MYN_PAIRING_INVITE    - One-time invite code for A2A pairing with MYN
#   MYN_PLUGIN_DIR        - Path to the openclaw-plugin (default: /app/myn-plugin)
#   OPENCLAW_AUTH_PASSWORD - HTTP gateway password
#   NVIDIA_API_KEY        - NVIDIA NIM API key (shared, rate-limited via MYN proxy)
#   OPENAI_API_KEY        - (optional) user BYOK key

FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935 AS base

LABEL org.opencontainers.image.title="MYN Kaia (OpenClaw Managed)" \
      org.opencontainers.image.description="MYN-managed OpenClaw instance for Kaia AI" \
      org.opencontainers.image.source="https://github.com/eltmon/openclaw" \
      org.opencontainers.image.licenses="MIT"

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app
RUN chown node:node /app

# Install dependencies (cached layer)
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

# Build application
USER root
COPY --chown=node:node . .

RUN for dir in /app/extensions /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done

USER node
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Install the MYN plugin (openclaw-plugin repo shipped alongside)
COPY --chown=node:node openclaw-plugin/ /app/myn-plugin/
RUN cd /app/myn-plugin && npm install --omit=dev 2>/dev/null || true

USER root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

# Copy managed bootstrap files
COPY --chown=node:node managed/bootstrap.sh /app/managed/bootstrap.sh
COPY --chown=node:node managed/openclaw.managed.json /app/managed/openclaw.managed.json
RUN chmod +x /app/managed/bootstrap.sh

ENV NODE_ENV=production
ENV OPENCLAW_STATE_DIR=/data
ENV NODE_OPTIONS="--max-old-space-size=1536"
# MYN Managed: bind on all interfaces (Fly.io handles TLS termination + auth)
ENV OPENCLAW_BIND=lan

USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run bootstrap then start gateway
CMD ["/bin/sh", "-c", "/app/managed/bootstrap.sh && node /app/openclaw.mjs gateway --allow-unconfigured --port 3000 --bind lan"]
