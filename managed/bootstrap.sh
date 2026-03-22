#!/bin/sh
# MYN Managed OpenClaw Bootstrap Script
#
# Idempotent — runs on EVERY container start, safe to re-run.
# First-boot tasks are gated by sentinel files in $OPENCLAW_STATE_DIR.
#
# Environment variables (injected by Fly.io secrets + MYN provisioning):
#   MYN_API_BASE          - MYN backend URL (e.g. https://api.mindyournow.com)
#   MYN_AGENT_API_KEY     - API key for authenticating requests to MYN
#   MYN_PAIRING_INVITE    - One-time invite code for A2A pairing
#   OPENCLAW_AUTH_PASSWORD - Gateway HTTP auth password
#   NVIDIA_API_KEY        - Shared NVIDIA NIM key (rate-limited by MYN proxy)
#   OPENAI_API_KEY        - (optional) user BYOK key

set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="${STATE_DIR}/openclaw.json"
PAIRED_SENTINEL="${STATE_DIR}/.myn-paired"
BOOTSTRAP_LOG="${STATE_DIR}/bootstrap.log"

log() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$BOOTSTRAP_LOG"
}

log "=== MYN Managed Bootstrap starting ==="

# Ensure state directory exists (mounted Fly volume)
mkdir -p "$STATE_DIR"

# ── Step 1: Apply managed config (every boot) ──────────────────────────────
# Copy base managed config if config doesn't exist yet
if [ ! -f "$CONFIG_FILE" ]; then
    log "Applying base managed config..."
    cp /app/managed/openclaw.managed.json "$CONFIG_FILE"
fi

# Set auth password from environment
if [ -n "$OPENCLAW_AUTH_PASSWORD" ]; then
    log "Configuring gateway auth..."
    node /app/openclaw.mjs config set gateway.auth.password "$OPENCLAW_AUTH_PASSWORD" --config "$CONFIG_FILE" 2>/dev/null || \
    node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
cfg.gateway = cfg.gateway || {};
cfg.gateway.auth = cfg.gateway.auth || {};
cfg.gateway.auth.password = process.env.OPENCLAW_AUTH_PASSWORD;
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
" || log "Warning: could not set auth password via config command"
fi

# ── Step 2: Configure model provider (every boot) ──────────────────────────
if [ -n "$NVIDIA_API_KEY" ]; then
    log "Configuring NVIDIA NIM provider..."
    # NVIDIA NIM uses OpenAI-compatible API
    node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
cfg.providers = cfg.providers || {};
cfg.providers['nvidia-nim'] = {
    type: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY,
    label: 'NVIDIA NIM (via MYN)'
};
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.model = cfg.agents.defaults.model || 'nvidia-nim/meta/llama-3.1-nemotron-70b-instruct';
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
" 2>/dev/null || log "Warning: could not configure NVIDIA provider"
fi

if [ -n "$OPENAI_API_KEY" ]; then
    log "Configuring user BYOK OpenAI key..."
    node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
cfg.providers = cfg.providers || {};
cfg.providers.openai = cfg.providers.openai || {};
cfg.providers.openai.apiKey = process.env.OPENAI_API_KEY;
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
" 2>/dev/null || log "Warning: could not configure OpenAI BYOK"
fi

# ── Step 3: Install MYN plugin (every boot, idempotent) ────────────────────
MYN_PLUGIN_DIR="${MYN_PLUGIN_DIR:-/app/myn-plugin}"
if [ -d "$MYN_PLUGIN_DIR" ]; then
    log "Installing MYN plugin from $MYN_PLUGIN_DIR..."
    # Register plugin via symlink in agent plugins directory
    PLUGINS_DIR="${STATE_DIR}/plugins"
    mkdir -p "$PLUGINS_DIR"
    if [ ! -L "${PLUGINS_DIR}/myn" ]; then
        ln -sf "$MYN_PLUGIN_DIR" "${PLUGINS_DIR}/myn"
        log "MYN plugin symlink created"
    else
        log "MYN plugin symlink already exists"
    fi

    # Configure plugin with MYN API credentials
    if [ -n "$MYN_API_BASE" ] && [ -n "$MYN_AGENT_API_KEY" ]; then
        log "Configuring MYN plugin credentials..."
        node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
cfg.plugins = cfg.plugins || {};
cfg.plugins.myn = {
    apiBase: process.env.MYN_API_BASE,
    apiKey: process.env.MYN_AGENT_API_KEY
};
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
" 2>/dev/null || log "Warning: could not configure MYN plugin"
    fi
fi

# ── Step 4: A2A pairing with MYN (first boot only) ─────────────────────────
if [ ! -f "$PAIRED_SENTINEL" ] && [ -n "$MYN_PAIRING_INVITE" ]; then
    log "Performing first-boot A2A pairing with MYN..."

    # Wait for MYN API to be reachable
    MYN_HEALTH="${MYN_API_BASE:-https://api.mindyournow.com}/api/v1/health"
    RETRIES=10
    while [ $RETRIES -gt 0 ]; do
        if node -e "fetch('$MYN_HEALTH').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
            log "MYN API is reachable"
            break
        fi
        log "Waiting for MYN API... ($RETRIES retries left)"
        sleep 3
        RETRIES=$((RETRIES - 1))
    done

    if [ $RETRIES -gt 0 ]; then
        # Redeem the pairing invite via MYN's A2A endpoint
        REDEEM_RESULT=$(node -e "
fetch('${MYN_API_BASE:-https://api.mindyournow.com}/api/v1/agent/redeem-invite', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': process.env.MYN_AGENT_API_KEY || ''
    },
    body: JSON.stringify({
        inviteCode: process.env.MYN_PAIRING_INVITE,
        agentName: 'kaia',
        displayName: 'Kaia (MYN Managed)'
    })
}).then(r => r.json()).then(d => {
    if (d.error) { console.error('Pairing failed:', d.error); process.exit(1); }
    console.log('Paired successfully');
}).catch(e => { console.error('Pairing error:', e.message); process.exit(1); })
" 2>&1) || true

        if echo "$REDEEM_RESULT" | grep -q "Paired successfully"; then
            touch "$PAIRED_SENTINEL"
            log "A2A pairing completed successfully"
        else
            log "Warning: A2A pairing did not complete: $REDEEM_RESULT"
            # Non-fatal: instance still starts, pairing can be retried
        fi
    else
        log "Warning: MYN API not reachable, skipping pairing"
    fi
elif [ -f "$PAIRED_SENTINEL" ]; then
    log "A2A pairing already completed (sentinel exists)"
fi

log "=== Bootstrap complete, starting gateway ==="
