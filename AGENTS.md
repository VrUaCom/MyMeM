# AGENTS.md — MyMeM

This file follows the [AGENTS.md](https://agents.md) convention (Linux Foundation Agentic AI Foundation) — a plain, tool-agnostic context file read by Claude Code, Codex, Cursor, Copilot, Gemini CLI, Windsurf, and others on project open. It complements MyMeM's own MCP tools rather than replacing them: this file is static, always-known context; MyMeM's tools are dynamic, queried-on-demand memory.

## What this project is

MyMeM is a free, open-source (MIT) memory layer over the Model Context Protocol. Any AI agent, on any device, can call its tools to remember and recall shared context. It does not do anything by itself — it's a small stdio MCP server plus a file-backed store you point at a synced folder (git, Drive, Syncthing — your choice).

## Tools available if you connect to this server

`mymem_remember`, `mymem_recall`, `mymem_reinforce`, `mymem_list_recent`, `mymem_recall_as_of`, `mymem_supersede`, `mymem_pin`, `mymem_unpin`, `mymem_core_memory`. See [README.md](./README.md) for what each does.

## Working on this codebase

- `src/store.ts` — the memory store: one JSON file per record (git-mergeable), decay/salience, bi-temporal fields, core memory blocks.
- `src/decay.ts` — OpenMemory-derived decay+reinforcement formula. Keep it dependency-free.
- `src/similarity.ts` — TF-IDF cosine similarity. Deliberately not a neural embedding model — see README "Design notes" before "upgrading" this without a real usage-driven reason.
- No database, no external services, no paid APIs. If a change would introduce one, stop and check with the owner first — that's a hard project constraint, not a style preference.
- Nothing durable is ever deleted (`mymem_supersede`, not overwrite). Core memory blocks (`mymem_unpin`) are the one intentional exception — they're working state, not durable facts.
- Build: `npm run build`. No test framework wired yet — verify changes with a live stdio smoke test against a throwaway `MYMEM_HOME` (see git history for examples).

## Related project

MyMeM's design is informed by (and periodically cross-pollinates with) a larger sibling project, **MCP Space DMC Rengine**, which has its own much larger `get_ai_context` retrieval tool and four-layer knowledge graph. Improvements proven here first (decay ranking, core memory, bi-temporal recall) get proposed there separately — never assume this repo and that one share a codebase or a release cycle.
