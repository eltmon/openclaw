# Mind Your Now Fork — OpenClaw for Kaia AI

This is the **Mind Your Now (MYN)** fork of [OpenClaw](https://github.com/openclaw/openclaw).
It powers **Kaia**, the AI assistant built into the MYN productivity platform.

MYN auto-provisions this fork for every user. If you're reading this, your Kaia
instance is running on this codebase.

## Fork philosophy

This fork has **zero source code changes** from upstream. All Kaia-specific
behavior is achieved through configuration. This keeps merging upstream
painless and avoids divergence.

The default config template lives at [`config/kaia-defaults.json`](config/kaia-defaults.json)
and is applied during auto-provisioning.

## What the Kaia config does

The provisioning config (`config/kaia-defaults.json`) sets three things
that upstream leaves off or defaults conservatively:

### QMD memory backend (`memory.backend: "qmd"`)

Upstream default: `builtin` (SQLite FTS only).
Kaia default: `qmd` (hybrid BM25 + vector + reranking).

Kaia needs to search across your notes, tasks, and conversation history with
high recall. The builtin SQLite FTS backend does keyword matching only. QMD
adds semantic vector search and LLM reranking so Kaia can find relevant
context even when your query doesn't share exact words with the source.

If QMD is not installed, the gateway falls back to the builtin backend
automatically with a logged warning. Nothing breaks.

### Context pruning (`contextPruning.mode: "cache-ttl"`, `ttl: "4h"`)

Upstream default: off (only auto-enabled for Anthropic auth users with 1h TTL).
Kaia default: on for all providers, 4h TTL.

During a conversation, tool results (file reads, web fetches, API responses)
pile up in the context window. Without pruning, they eat token budget until
compaction kicks in and loses everything at once.

Context pruning reclaims space gradually:

- Tool results older than the TTL (4 hours) become eligible
- The last 3 assistant turns are always protected (`keepLastAssistants: 3`)
- **Soft trim** (at 30% context usage): keeps first + last 1500 chars of large results
- **Hard clear** (at 50% context usage): replaces stale results with a placeholder

The 4h TTL (vs upstream's 1h for Anthropic users) means Kaia keeps tool
results available longer — important because MYN users often reference
earlier planning context within a session.

### Memory flush before compaction (`compaction.memoryFlush.enabled: true`)

Upstream default: already enabled with `softThresholdTokens: 4000`.
Kaia default: same (explicitly set to be clear about intent).

Before the context window is compacted (summarized and trimmed), the agent
gets a chance to write important decisions and context to disk as markdown
memory files. This ensures durable knowledge survives compaction. We set
this explicitly so the behavior is visible in config, not hidden in code
defaults.

## Prerequisites

- **Node.js 22+**
- **Bun** (required by QMD)
- **Python 3** and **build-essential** (required to compile QMD's native SQLite module)

## Install QMD

QMD is a local-first search sidecar by [@tobi](https://github.com/tobi/qmd).
It must be installed separately and available on the gateway's `PATH`.

### macOS

```bash
brew install oven-sh/bun/bun   # if you don't have bun
bun install -g https://github.com/tobi/qmd
```

### Linux (Ubuntu/Debian)

```bash
# Install bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install build deps (needed for better-sqlite3 native module)
sudo apt-get install -y python3 python3-dev build-essential

# Install QMD
bun install -g https://github.com/tobi/qmd
```

### Verify

```bash
qmd --version
# Expected: qmd 2.x.x
```

If `bun install -g` completes but `qmd --version` shows a module-not-found
error, the package was installed from source and needs building:

```bash
cd ~/.bun/install/global/node_modules/@tobilu/qmd
bun install && bun run build
```

Then retry `qmd --version`.

## Install the gateway

```bash
npm install -g github:eltmon/openclaw
# or: pnpm add -g github:eltmon/openclaw

openclaw onboard --install-daemon
```

## Apply the Kaia config

After onboarding, apply the Kaia defaults:

```bash
# One-shot: merge kaia-defaults.json into your config
openclaw config set memory.backend qmd
openclaw config set agents.defaults.compaction.mode safeguard
openclaw config set agents.defaults.compaction.memoryFlush.enabled true
openclaw config set agents.defaults.compaction.memoryFlush.softThresholdTokens 4000
openclaw config set agents.defaults.contextPruning.mode cache-ttl
openclaw config set agents.defaults.contextPruning.ttl 4h
openclaw config set agents.defaults.contextPruning.keepLastAssistants 3
```

Or verify what's set:

```bash
openclaw config get memory
openclaw config get agents.defaults.compaction
openclaw config get agents.defaults.contextPruning
```

Check the gateway log for:

```
qmd memory startup initialization armed for agent "main"
```

## Manual override

Any setting can be changed after provisioning:

```bash
# Switch back to builtin memory
openclaw config set memory.backend builtin

# Disable context pruning
openclaw config set agents.defaults.contextPruning.mode off

# Restart the gateway to apply
```

## Boot instructions: search before answering

Good search is only half the solution. The agent also needs to _think_ to
search before answering from its training data.

The provisioning flow patches the workspace `AGENTS.md` (OpenClaw's boot
instructions file) with a "Search Before Answering" section and creates a
`LEARNINGS.md` file. These templates live in:

- [`config/kaia-agents-patch.md`](config/kaia-agents-patch.md) — appended to `AGENTS.md`
- [`config/kaia-learnings.md`](config/kaia-learnings.md) — seeded as `LEARNINGS.md`

The patch instructs the agent to:

1. **Search daily logs** (`memory/YYYY-MM-DD.md`) for recent context
2. **Check LEARNINGS.md** for accumulated corrections and preferences
3. **Use QMD hybrid search** when keyword search alone misses

This closes the retrieval loop: QMD provides high-quality search results,
and the boot instructions ensure the agent actually uses them instead of
hallucinating from stale training data.

During provisioning, apply them:

```bash
# Append search-before-answering instructions to AGENTS.md
cat config/kaia-agents-patch.md >> ~/.openclaw/workspace/AGENTS.md

# Seed LEARNINGS.md (only if it doesn't exist yet)
cp -n config/kaia-learnings.md ~/.openclaw/workspace/LEARNINGS.md
```

## How Kaia uses QMD

When Kaia answers a question, the gateway searches your indexed memory files
(markdown notes, conversation exports, task history) using QMD's hybrid
retrieval pipeline:

1. **BM25** keyword search for exact term matches
2. **Vector search** for semantic similarity (runs locally via node-llama-cpp, no external API)
3. **Reranking** to combine and order results

Results are injected into Kaia's context window so she can reference your
actual notes and history — not just the current conversation.

QMD indexes are stored per-agent under `~/.openclaw/agents/<agentId>/qmd/`
and update automatically in the background.

## Auto-provisioning (MYN platform)

When MYN provisions a new user's Kaia instance, the setup flow:

1. Installs this fork (`github:eltmon/openclaw`)
2. Installs QMD (`bun install -g https://github.com/tobi/qmd`)
3. Applies `config/kaia-defaults.json` settings
4. Patches `AGENTS.md` with search-before-answering instructions
5. Seeds `LEARNINGS.md` for accumulated knowledge
6. Configures the MYN plugin for API access
7. Starts the gateway

No user action required. The builtin fallback ensures the gateway starts
even if QMD installation fails during provisioning.

## Staying in sync with upstream

This fork has zero source code changes, so upstream merges should be clean:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git  # once
git fetch upstream
git merge upstream/main
```

## Links

- **Upstream**: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **QMD**: [tobi/qmd](https://github.com/tobi/qmd)
- **MYN Plugin**: [@mind-your-now/openclaw-plugin](https://github.com/mindyournow/openclaw-plugin)
- **MYN Skills**: [@mind-your-now/skills](https://github.com/mindyournow/myn-skills)
- **Mind Your Now**: [mindyournow.com](https://mindyournow.com)
