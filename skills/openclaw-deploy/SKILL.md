---
name: openclaw-deploy
description: >
  Deploy the eltmon/openclaw fork to exe.dev. Builds from source, pushes changes,
  updates the running gateway, and verifies health. Handles the full cycle from
  local commit through production restart.
triggers:
  - deploy openclaw
  - update openclaw
  - openclaw deploy
  - push to exe.dev
  - restart openclaw
  - openclaw exe.dev
---

# OpenClaw Fork Deployment (exe.dev)

## Architecture

- **Local repo**: `/home/eltmon/Projects/OpenClaw` (fork of `openclaw/openclaw`)
  - Remote `eltmon`: `git@github.com:eltmon/openclaw.git` (your fork)
  - Remote `origin`: `https://github.com/openclaw/openclaw.git` (upstream)
- **exe.dev instance**: `~/openclaw-fork/` on `openclaw-myn.exe.xyz`
  - Cloned via HTTPS (no SSH key for GitHub on exe.dev)
  - Managed by systemd user service `openclaw-gateway.service`
  - Entry point: `~/openclaw-fork/dist/index.js`

## SSH Access

All commands on exe.dev require double-SSH. Use this pattern:

```bash
ssh exe.dev "ssh openclaw-myn.exe.xyz '<command>'"
```

**Quoting is critical** — use single quotes inside double quotes. For complex commands, base64-encode and pipe.

## Deploy Steps

### 1. Commit and push local changes

```bash
cd /home/eltmon/Projects/OpenClaw
git add <files>
git commit -m "message"
git push eltmon main
```

### 2. Pull, install, and build on exe.dev

```bash
ssh exe.dev "ssh openclaw-myn.exe.xyz 'cd ~/openclaw-fork && git pull && export PATH=\"\$HOME/.npm-global/bin:\$PATH\" && pnpm install && pnpm build'"
```

If pnpm install fails with disk space issues, check `df -h` — the VM has ~19GB total.

### 3. Restart the gateway

```bash
ssh exe.dev "ssh openclaw-myn.exe.xyz 'XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user restart openclaw-gateway.service'"
```

### 4. Verify health

```bash
# Check service status
ssh exe.dev "ssh openclaw-myn.exe.xyz 'XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user status openclaw-gateway.service | head -8'"

# Check latest log for errors
ssh exe.dev "ssh openclaw-myn.exe.xyz 'tail -20 /tmp/openclaw/openclaw-\$(date -u +%Y-%m-%d).log'"

# Verify it's using the fork path
ssh exe.dev "ssh openclaw-myn.exe.xyz 'grep openclaw-fork /tmp/openclaw/openclaw-\$(date -u +%Y-%m-%d).log | tail -1'"
```

## Restart Only (no code changes)

```bash
ssh exe.dev "ssh openclaw-myn.exe.xyz 'XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user restart openclaw-gateway.service'"
```

## Rebasing from Upstream

To pull in upstream OpenClaw changes:

```bash
cd /home/eltmon/Projects/OpenClaw
git fetch origin
git rebase origin/main
# Resolve conflicts if any
git push eltmon main --force-with-lease
```

Then deploy to exe.dev (steps 2-4 above).

## Rollback

If the fork breaks, restore from backup:

```bash
# Extract the old npm-installed version
ssh exe.dev "ssh openclaw-myn.exe.xyz 'cd / && tar xzf ~/Backups/openclaw-backup-2026-03-13-pre-fork.tar.gz'"

# Point systemd back to npm install
ssh exe.dev "ssh openclaw-myn.exe.xyz '
sed -i \"s|openclaw-fork/dist/index.js|.npm-global/lib/node_modules/openclaw/dist/index.js|\" ~/.config/systemd/user/openclaw-gateway.service
XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user daemon-reload
XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user restart openclaw-gateway.service
'"
```

## Key Config Files on exe.dev

| File                                               | Purpose                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `~/.openclaw/openclaw.json`                        | Main config (model, session retention, QMD, hooks)          |
| `~/.openclaw/agents/main/agent/auth-profiles.json` | API keys (Anthropic, Moonshot, ZAI)                         |
| `~/.openclaw/workspace/AGENTS.md`                  | System prompt additions (conversation archive instructions) |
| `~/.config/systemd/user/openclaw-gateway.service`  | Systemd unit file                                           |
| `/tmp/openclaw/openclaw-YYYY-MM-DD.log`            | Daily log files                                             |
| `~/.openclaw/agents/main/sessions/`                | Session transcripts (JSONL + .reset.\* archives)            |
| `~/.openclaw/agents/main/qmd/`                     | QMD database and exported sessions                          |

## Backup Before Risky Changes

```bash
ssh exe.dev "ssh openclaw-myn.exe.xyz 'tar czf ~/Backups/openclaw-backup-\$(date -u +%Y-%m-%d).tar.gz ~/.openclaw/ ~/openclaw-fork/'"
```

## Common Issues

- **Gateway keeps respawning after kill**: It's managed by systemd with `Restart=always`. Use `systemctl --user stop/restart`, not `kill`.
- **scp doesn't work on exe.dev**: Use base64 encoding through SSH or `tar | ssh` pipes.
- **pnpm not found**: Add to PATH: `export PATH="$HOME/.npm-global/bin:$PATH"`
- **Disk full**: Check `du -sh ~/openclaw-fork/node_modules/` — can clear pnpm store with `pnpm store prune`.
