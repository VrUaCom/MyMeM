# MyMeM

MYMEM — a free, open-source memory layer over the Model Context Protocol (MCP) that lets any AI agent (Claude, Cursor, Codex, Windsurf...), on any device, read and write the same shared context instead of starting from zero every session.

## Why

Most AI coding tools keep memory local to one machine and one tool. Work done by an agent on one computer is invisible to an agent on another computer, or even to a different tool on the same computer. MyMeM is a small, self-hostable MCP server that any of those agents can call to remember and recall shared context — combined with a file-based store you sync between machines however you like (git, Syncthing, a synced cloud drive folder — MyMeM doesn't care).

## Status

Early / v0.1.0. Four tools, file-backed storage, stdio transport. See [`Roadmap`](#roadmap) below.

## Tools

- **`mymem_remember`** — store one memory (`fact`, `decision`, `preference`, or `todo`), tagged with which agent and device recorded it.
- **`mymem_recall`** — keyword search over current (non-superseded) memories.
- **`mymem_list_recent`** — "what changed since I last looked," optionally scoped to one device.
- **`mymem_supersede`** — correct a memory without deleting it; the original stays retrievable, linked to its replacement.

Nothing is ever silently deleted. A correction always supersedes, never erases.

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
- **Phase 1** — this repo: the four tools above, file-backed, no database. *(current)*
- **Phase 2** — ship an `AGENTS.md` convention alongside MyMeM so even non-MCP tools get baseline shared context.
- **Phase 3** — evaluate a real memory-engine backend (only once real usage shows the need) — candidates already researched: Mem0/OpenMemory, CouchDB/PouchDB.

## License

MIT — see [`LICENSE`](./LICENSE). MyMeM is meant to be embedded anywhere with zero friction, including inside other people's hosted tools.
