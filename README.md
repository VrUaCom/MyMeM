# MyMeM

MYMEM — a free, open-source memory layer over the Model Context Protocol (MCP) that lets any AI agent (Claude, Cursor, Codex, Windsurf...), on any device, read and write the same shared context instead of starting from zero every session.

## Why

Most AI coding tools keep memory local to one machine and one tool. Work done by an agent on one computer is invisible to an agent on another computer, or even to a different tool on the same computer. MyMeM is a small, self-hostable MCP server that any of those agents can call to remember and recall shared context — combined with a file-based store you sync between machines however you like (git, Syncthing, a synced cloud drive folder — MyMeM doesn't care).

## Status

v0.3.0. Ten tools, file-backed storage, stdio transport. See [`Roadmap`](#roadmap) below.

## Tools

- **`mymem_get_context`** — **start here.** The bounded primary entry point: one objective, one token budget, one call. Returns core memory (always included) plus ranked recall results filling the rest of the budget. Mirrors the `get_ai_context` pattern from the sibling `mcp-space-dmc-rengine` server, so it needs no new mental model if you're already used to that workflow.
- **`mymem_remember`** — store one memory (`fact`, `decision`, `preference`, or `todo`), tagged with which agent and device recorded it.
- **`mymem_recall`** — ranked search over current (non-superseded) memories: lexical/TF-IDF similarity combined with decay-adjusted salience, so relevant *and* fresh (or reinforced) memories rank highest. Not neural embeddings — a dependency-free, zero-cost lexical layer; see [Design notes](#design-notes).
- **`mymem_reinforce`** — explicitly confirm a memory is still relevant, raising its salience and resetting its decay clock.
- **`mymem_list_recent`** — "what changed since I last looked," optionally scoped to one device.
- **`mymem_recall_as_of`** — bi-temporal query: "what did we believe as of `<date>`," not just what's true now. Walks each memory's supersede chain to the version valid at that timestamp.
- **`mymem_supersede`** — correct a memory without deleting it; the original stays retrievable, linked to its replacement, and its validity window closes.
- **`mymem_pin`** / **`mymem_unpin`** / **`mymem_core_memory`** — a small, agent-curated, always-included memory tier (Letta/MemGPT-style "core memory blocks"), separate from queried recall. Call `mymem_core_memory` at the start of a task alongside `mymem_recall` for things that should never depend on guessing the right query wording.

Nothing durable is ever silently deleted. A correction always supersedes, never erases — core memory blocks are the one exception (`mymem_unpin` is a real delete), since they're working state, not durable facts.

## Design notes

MyMeM's recall/decay/core-memory design is a deliberate synthesis, not invented from scratch — each piece is ported from an existing, researched system rather than reinvented:

- **Decay + reinforcement** — tiered hot/warm/cold formula ported from [OpenMemory (CaviraOSS)](https://github.com/CaviraOSS/OpenMemory)'s published approach.
- **Core memory blocks** — pattern from [Letta/MemGPT](https://github.com/letta-ai/letta)'s self-editing core-context model.
- **Bi-temporal recall** — pattern from [Zep/Graphiti](https://github.com/getzep/graphiti)'s "what was true as of when" fact-versioning.
- **TF-IDF similarity** — a plain, zero-dependency lexical layer (no model download, no paid API), chosen deliberately over a real embedding model until usage shows the gap actually matters. Honest about its limits: it catches shared-vocabulary paraphrase, not deep semantic meaning.

## Install & run

```bash
git clone https://github.com/VrUaCom/MyMeM.git
cd MyMeM
npm install
npm run build
node dist/index.js
```

By default memories are stored under `~/.mymem/memories/`. Override with `MYMEM_HOME`.

### Add to an MCP client (e.g. Claude Code / Claude Desktop)

```json
{
  "mcpServers": {
    "mymem": {
      "command": "node",
      "args": ["/absolute/path/to/MyMeM/dist/index.js"],
      "env": { "MYMEM_HOME": "/absolute/path/to/shared/synced/folder" }
    }
  }
}
```

Point `MYMEM_HOME` at a folder that's synced between your devices (a git-tracked folder, a cloud-drive folder, whatever you already use) and every MCP client that connects to MyMeM on any of those devices shares the same memory.

## Roadmap

- **Phase 0** — sync `MYMEM_HOME` between machines via a git remote living in an already-synced cloud-drive folder (no new infrastructure).
- **Phase 1** — the four base tools, file-backed, no database. *(done)*
- **Phase 2** — ship an `AGENTS.md` convention alongside MyMeM so even non-MCP tools get baseline shared context.
- **Phase 3 (advanced recall)** — decay+reinforcement ranking, core memory blocks, bi-temporal recall, lightweight TF-IDF similarity, and `mymem_get_context` composing all of it into one bounded entry-point call. *(current — this repo, v0.3.0)*
- **Phase 3.1 (future)** — a real embedding-based semantic layer, evaluated only once TF-IDF's limits are actually felt in practice, not before.

## License

MIT — see [`LICENSE`](./LICENSE). MyMeM is meant to be embedded anywhere with zero friction, including inside other people's hosted tools.
