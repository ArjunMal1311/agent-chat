# Changelog

## Unreleased

- New avatars in place of the cartoon animals: a flat coloured circle with the agent's initials, the colour picked from its name. The colours are in `src/constants/ui.ts`.
- Draft folders for Approve & post may now sit one folder below `post_root` (`post_root/<account>/<draft>`), so one agent can prepare posts for several accounts. New `scripts/ig-publish.mjs` publish command reads the account (and post or reel) from the draft and runs the right command of the socials project; it prints `POSTED:` only when something was really posted.
- Agents can hand work to each other. Every agent now sees the other agents in its prompt and can end a reply with `HANDOFF: <agent> | <task>`; the app runs that agent and posts its answer back as a note in the caller's chat. Limited to 2 per reply, a chain of 3 agents, no repeats in a chain, never the Manager; `can_call:` in an agent file restricts or turns it off. See the README.
- A hand-written agent file may now set `sandbox: danger-full-access` (Codex with no sandbox: network and shell as you). The New agent form still offers only `read-only` and `workspace-write`; anything unrecognised still falls back to `read-only`.
- The model chip in every chat header is now a dropdown listing every model: Claude (Sonnet, Haiku, Opus) and the GPT models Codex itself reports for your login (read from `~/.codex/models_cache.json`). Picking one from the other family switches that chat to the other program from its next run (a Codex agent switched to Claude gets read-only tools unless its file has a `tools:` line). "Agent's own choice" goes back to the file. Saved per chat in the database; helper runs such as the Manager's answer check are not affected.
- New shield button at the top right of every chat that switches the access level from the next run (with a confirmation step for full access), saved per chat in the database; it turns red while full access is on. Codex chats: Read only, Edit files in its folder, Full access. Claude chats: the tools in the agent's file, or Full access, which allows every tool plus the MCP servers in the `.mcp.json` of the agent's folder (so a Claude chat can use Apify). The level follows the chat when you switch it between Claude and Codex.

## 0.2.0

- Rewritten in TypeScript: the server runs on Node 24+ with built-in HTTP and SQLite, the page is React with Zustand built by Vite, and the desktop window is Electron.
- Removed the Python server, the old desktop shell and the static page.
- Renderer reorganised into `components/`, `store/`, `lib/` and `styles/`.
- Private agents (`agents/`) and local data (`data/`) are no longer tracked by git; `examples/agents/` is what ships.
- Added `docs/ARCHITECTURE.md`.
- All constants moved into one folder, `src/constants/` (agents, hub, runner, server, db, app, ui). The two port numbers are now defined once each.
- `Empty` moved out of `App.tsx` into `components/Empty.tsx`.
- `src/main/` grouped into `agents/`, `runner/`, `hub/`, `server/` and `db/`.
- The page now checks every API reply with zod (`lib/schemas.ts`) and reports the route and field when a reply has the wrong shape; the renderer types are derived from the schemas.

## 0.1.0

- First version: a WhatsApp-style chat for Claude Code agents.
