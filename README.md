# agent-chat

A WhatsApp-style chat for your agents. Each agent is a chat with one job; you can see which are working, message one directly, or message the Manager and it hands the request to the right agent. Agents prepare drafts. **Nothing is sent or posted for you**: "Approve" is only your sign-off on a draft, and you send it by hand.

No dependencies: Python 3 standard library on the server, plain HTML/CSS/JS in the browser. Agents run through the Claude Code CLI (`claude -p`), so they use your existing Claude login.

## Run

```
python3 -m agentchat            # http://127.0.0.1:8765
python3 -m agentchat --port 9000
```

It listens on localhost only. There is no login, so do not expose the port to a network.

## Desktop app (Linux)

An Electron window around the same chat. It starts the Python server itself and stops it when you close the window.

```
cd desktop
npm install          # once: installs Electron 44.9.3 (about 300 MB with its binary)
./run.sh             # opens the app
./run.sh --smoke     # starts it hidden, loads the page, prints SMOKE ok, exits
./install-launcher.sh   # optional: adds "Agent Chat" to your application menu (writes one .desktop file)
```

- `run.sh` unsets `ELECTRON_RUN_AS_NODE`. Some editors set it, and then Electron runs as plain Node with no window.
- The window only shows the local chat page; links go to your normal browser. Closing the window quits the app.
- Desktop notifications appear when an agent writes while you are not looking at its chat (permission is asked on your first click).
- Set `AGENT_CHAT_PYTHON` to use a different Python.
- Tested here: the smoke test on Wayland (Electron 44.9.3, Ubuntu). Notifications and the app-menu launcher have not been tried.

## Add or change an agent

Each agent is a markdown file in `agents/`. The file name is the agent's id.

```
---
title: Planner
goal: Tells you today's checklist
tools: Read, Grep, Glob
approval: false
cwd: ~/Documents/Personal/socials-instagram
timeout: 180
---
The job prompt goes here.
```

- `tools`: the only tools the agent may use (passed to `--allowedTools`). Leave empty for none. Keep this as small as the job allows.
- `approval: true`: its answers arrive as drafts with Approve / Decline buttons.
- `cwd`: the folder it works in.
- `manager.md` is special: it reads the roster of the other agents and answers with JSON to hand work over.
- An agent can add a line starting `REMEMBER:`; it is hidden from the chat, saved in `data/memory/<agent>.md`, and shown to the agent on its next run.

Restart the server after editing agent files. Optional `model:` line (for example `model: haiku`) picks the model for that agent.

## Claude Code plan usage (the bar at the top)

The bar above both panes shows your account's real **5-hour** and **7-day** usage with reset countdowns, turning amber at 60% and red at 85%. The numbers come from Claude Code itself: every agent run streams a rate-limit report, and the app saves the newest one (so it also survives restarts). They are account-wide, so they include your other Claude Code use, not only the agents.

- The bar updates whenever any agent runs. It cannot update by itself without a call, so it shows "updated N min ago" (and "may be out of date" after 30 min).
- **Refresh** runs one tiny call on the haiku model (about 50k tokens, about $0.01 estimated) so Claude Code reports fresh numbers. That check counts toward your usage too.
- No account tokens or credentials are read; only the utilization, reset time and status for the two windows are stored.

## Cache status of a chat

Each chat header shows the cache state for that agent, for example `Cache warm · 59m left · last run 65% cached (107.2k read, 58.0k written) · overall 57%`. Each reply also shows its own "% cached".

- **Warm** means the last run is still inside the cache window its writes were given (1 hour here, read from Claude Code's usage report), so the next run can reuse part of the prompt: cheaper and faster. **Cold** means that window has passed and the next run rebuilds it (about 50k tokens). **Unknown** means older runs saved before cache data was recorded.
- It is an estimate from the last run's time plus its window; the real cache is on Anthropic's side and cannot be queried.
- "% cached" is cache-read tokens over all input tokens for the run. Even a warm cache covers only part of the prompt, because some of it changes on every run (measured: about half, even for two calls back to back). Agents share only the common start of the prompt.

## What an agent is doing

While an agent works, its chat shows a live card instead of a typing indicator: each step as it happens ("Reading outreach/gtm-plan.md", "Searching for 'seats'", "Running ./socials ..."), finished steps ticked and the current one spinning. The chat list and header show the current step too. When the reply arrives, a "N steps" row under it expands to the full list. Steps come from Claude Code's streaming output (`--output-format stream-json`); a failed step shows as "That step failed: ...".

## Usage, clearing and notes

- Every reply shows the model, tokens, estimated cost and seconds. Each chat header shows that agent's totals and today's; the list shows today's total. The cost is Claude Code's API-price estimate, not a bill, and plan limits are not available.
- Each run starts a fresh `claude -p`, so a simple question costs roughly 50k tokens of base context plus the work (skills and MCP servers are switched off for agents to keep it down). Calls within an hour reuse the 1-hour cache for the shared start of the prompt.
- **Chat menu (the three dots in a chat header):** *Clear chat* deletes that chat's messages after an in-page confirmation (it also deletes drafts still waiting, and is refused while the agent is working). Usage totals and the agent's notes are kept. *Forget notes* empties the agent's `data/memory/<agent>.md`.
- An agent keeps only its newest 30 notes.
- An agent only sees its last 12 messages plus its notes, so a long chat does not make runs more expensive.

## Layout

```
agentchat/store.py    SQLite: messages, unread counts, working state, approvals
agentchat/agents.py   reads agents/*.md
agentchat/hub.py      sends messages, runs agents, manager hand-offs, approvals, memory
agentchat/runner.py   calls `claude -p` for one turn
agentchat/server.py   web page + JSON API + live updates (server-sent events)
static/               the chat screen
tests/                python3 -m unittest discover -s tests -t .
```

## Safety

- Localhost only; requests with a wrong `Host` or without the `X-Agent-Chat` header are refused.
- Agents are told never to send or post anything, and get only the tools in their file.
- Data (chat database, memory notes) lives in `data/`, which git ignores.

## Not built yet

Running from your phone (needs a safe tunnel and a login), agents reading each other's chats automatically, scheduled runs.
