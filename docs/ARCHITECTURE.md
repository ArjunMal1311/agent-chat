# Architecture and project structure

The map of the code. Start here before changing anything.

## How it fits together

```
┌─────────────────────────────────────────────┐
│ Electron window  (src/main/index.ts)        │
│   loads the page from the local server      │
└───────────────┬─────────────────────────────┘
                │ http://127.0.0.1:<port>  (JSON API + server-sent events)
┌───────────────▼─────────────────────────────┐
│ server.ts   web page + API + live stream    │
│ hub.ts      sends messages, hand-offs,      │
│             approvals, memory               │
│ scheduler.ts  agents that run on their own  │
│ store.ts    SQLite (node:sqlite)            │
│ runner.ts   one turn via `claude -p` or     │
│             `codex exec`                    │
└─────────────────────────────────────────────┘
```

- The server runs on Node 24+ with only built-in HTTP and SQLite, so it has no server dependencies.
- `boot.ts` starts the store, hub, scheduler and server. Both entry points use it: `cli.ts` (headless, `npm start`) and `index.ts` (the Electron window, `npm run app`).
- The renderer only talks to the server over HTTP. It does not import anything from `src/main`.

## Project structure

```
src/
  constants/             every fixed value, one file per area, shared by main and renderer
    agents.ts            what an agent file / the New agent form may contain
    hub.ts               hub limits, patterns and prompts
    runner.ts            standing rules, CLI flags, Codex client info
    server.ts            request size limit, served file types
    db.ts                SQLite schema
    app.ts               default ports
    ui.ts                page text and choices: starter buttons, usage notes, avatar species
  main/                  server and desktop shell (Node)
    index.ts             Electron window: npm run app
    cli.ts               headless start: npm start
    boot.ts              starts store, hub, scheduler and server
    agents/
      agents.ts          reads agents/*.md, the New agent form rules, example seeding
      scheduler.ts       agents that run on their own
    runner/
      runner.ts          runs one turn through `claude -p` or `codex exec`
      codexlimits.ts     reads Codex's usage windows
    hub/
      hub.ts             sends messages, runs agents, manager hand-offs, approvals, memory
      bus.ts             in-process event bus behind the live stream
    server/
      server.ts          web page + JSON API + live updates (server-sent events)
    db/
      store.ts           SQLite: messages, unread counts, working state, approvals, usage
  renderer/
    index.html           page shell
    src/
      main.tsx           entry
      App.tsx            top-level layout
      components/        AgentForm, Avatar, Empty, Rich, Sidebar, Thread (App.tsx only wires them together)
      store/             Zustand store (chat state, API calls, live updates)
      lib/               api client, zod schemas for every API reply, types derived from them, formatting helpers
      styles/            app.css
test/                    node:test suite (npm test); helpers.ts holds fakes
examples/agents/         the agents a fresh install starts with
agents/                  your own agents (git-ignored)
data/                    chat database and agent memory (git-ignored)
resources/               app icon
scripts/                 run.sh, install-launcher.sh
docs/                    this file
```

## Where things live

| You want to change | Look in |
|---|---|
| What an agent may do, or the front-matter fields | `src/main/agents/agents.ts` |
| Scheduled agents | `src/main/agents/scheduler.ts` |
| How a turn runs, the tool allowlist, cost and token parsing | `src/main/runner/runner.ts` |
| Hand-offs, approvals, the Manager's check, memory notes | `src/main/hub/hub.ts` |
| An API route or the live stream | `src/main/server/server.ts` |
| Schema or queries | `src/main/db/store.ts` |
| A screen or component | `src/renderer/src/components/` |
| Client state | `src/renderer/src/store/` |
| What the page expects from an API reply | `src/renderer/src/lib/schemas.ts` (types in `types.ts` are derived from it) |

## Conventions

- Within `src/main/`, `index.ts`, `cli.ts` and `boot.ts` are the entry points; everything else sits in a folder by responsibility. Keep new files in the folder that owns the concern, and make a new folder only when a second file needs it.
- Fixed values (limits, prompts, regexes, ports, page text) go in `src/constants/`, in the file for their area, not at the top of the file that uses them. Import them from there; do not re-export them.
- Components live in `components/`, one per file. `App.tsx` stays a thin shell: layout and live-update wiring only.
- Tests are named after the main-process modules: `test/<module>.test.ts`. They use fake `claude` and `codex` binaries (see `test/helpers.ts`), so no network or AI login is needed.
- Your own agents and chat data never go in git: `agents/` and `data/` are ignored. Anything meant to ship goes in `examples/agents/`.
- Run `npm run typecheck` and `npm test` before committing.
