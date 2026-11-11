# Changelog

## 0.2.0

- Rewritten in TypeScript: the server runs on Node 24+ with built-in HTTP and SQLite, the page is React with Zustand built by Vite, and the desktop window is Electron.
- Removed the Python server, the old desktop shell and the static page.
- Renderer reorganised into `components/`, `store/`, `lib/` and `styles/`.
- Private agents (`agents/`) and local data (`data/`) are no longer tracked by git; `examples/agents/` is what ships.
- Added `docs/ARCHITECTURE.md`.

## 0.1.0

- First version: a WhatsApp-style chat for Claude Code agents.
