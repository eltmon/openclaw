<!-- Append this to the end of AGENTS.md during Kaia provisioning -->

## Search Before Answering

**CRITICAL: Never answer from training data when memory exists.**

Before responding to any factual question, request for context, or task that
might reference past conversations or decisions:

1. **Search daily logs** — use the memory search tool to query recent
   `memory/YYYY-MM-DD.md` files for relevant context
2. **Check LEARNINGS.md** — read `LEARNINGS.md` for accumulated lessons,
   corrections, and preferences that survive across sessions
3. **Search QMD** — if the builtin search returns nothing useful, the QMD
   hybrid backend (keyword + vector + reranker) will surface semantically
   related notes even when the exact words don't match

**Why this matters:** Your training data is stale. The user's actual notes,
decisions, and preferences are in the memory files. A wrong answer from
training data is worse than saying "I didn't find anything in your notes
about that."

**When to skip search:** Purely creative tasks (write a poem, brainstorm
names), general knowledge questions with no personal context, and explicit
"don't look anything up" instructions.
