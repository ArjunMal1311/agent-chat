# Security

agent-chat starts AI agents that can read files and, if you allow it, run commands. Treat it like a terminal, not like a website.

## What it protects against, and what it does not

- **Local only.** The server binds to `127.0.0.1`. There is **no login**. Do not expose the port to a network, a tunnel or a reverse proxy.
- **Other websites.** Requests with a wrong `Host` header, or without the custom `X-Agent-Chat` header, are refused. A web page you visit cannot send that header cross-site without a CORS preflight, which the server never answers.
- **What an agent can do** is exactly what its file allows: Claude agents get only the tools in `tools:` (a `Bash(...)` rule allows that one command pattern), Codex agents get only their `sandbox:`. `danger-full-access` is accepted only when written by hand in the agent file: that agent can then run any command as you, with network, so a hostile caption or comment it reads could steer it. The in-app form cannot set it.
- **Agents made in the app are read-only.** The in-app form cannot give shell commands, `publish_cmd`, `post_root` or `before_run`. Those are written by hand in the agent file, on purpose.
- **Agents can call other agents** with a `HANDOFF:` line, but only agents that exist, never the Manager, never one already in the chain, and only the ones listed in the caller's `can_call:` if it has one. A called agent has exactly its own tools, sandbox and approval rules: a hand-off can make an agent run, it cannot widen what that agent may do. Each hand-off is a real run that costs tokens.
- **An agent with several accounts cannot post to the wrong one.** `scripts/ig-publish.mjs` refuses a draft whose `post.json` names a different account than the folder it sits in, and posts a reel only by its exact name. If you give a posting agent full access (shield button) it can run publish commands itself and the click no longer protects you, so do not.
- **Nothing is published without a click.** The Approve & post button runs the agent's `publish_cmd`. The agent itself has no publish command, a draft may only point inside `post_root`, and a second approval of the same draft is refused.
- **`before_run` and `publish_cmd` run as you.** They are plain commands from a file you control. Read an agent file before you use it, like you would a shell script.

## Your data

Chat history, notes and schedules live in `data/` (git-ignored). Your own agents live in `agents/` (git-ignored). Do not commit either: they can contain private messages and paths.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability") and include steps to reproduce.
