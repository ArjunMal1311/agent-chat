# agent-chat

A WhatsApp-style chat for your agents. Each agent is a chat with one job; you can see which are working, message one directly, or message the Manager and it hands the request to the right agent. Agents prepare drafts. **Nothing is sent or posted for you**: "Approve" is only your sign-off on a draft, and you send it by hand.

TypeScript end to end: the server runs on Node 24 or newer using only its built-in HTTP server and SQLite (no server dependencies), and the page is React with Zustand, built by Vite. The desktop window is Electron. Agents run through the Claude Code CLI (`claude -p`) or OpenAI Codex (`codex exec`), so they use your existing logins.

## Run

```
npm install
npm start                       # builds the page, then serves it at http://127.0.0.1:8765
node src/main/cli.ts --port 9000   # after `npm run build`
npm test                        # the test suite (no network or AI login needed)
npm run typecheck
```

It listens on localhost only. There is no login, so do not expose the port to a network.

On the first run, if `agents/` is empty or missing, the example agents from `examples/agents/` are copied into it (a Manager, Planner, Reviewer, Researcher, Writer, a Codex helper and a scheduled Daily check). Edit them or add your own there; `agents/` is git-ignored, so your agents stay on your machine. See `SECURITY.md` before using it for anything real.

## Desktop app

An Electron window with the chat server running inside it (one process, nothing else to start).

```
npm install            # once: React, Vite, Electron, TypeScript (Electron is about 100 MB with its binary)
npm run app            # builds and opens the app
npm run smoke          # starts it hidden, checks the page rendered, prints SMOKE ok, exits
./scripts/install-launcher.sh   # optional: adds "Agent Chat" to your application menu (writes one .desktop file)
npm run dev            # development: hot reload for the page
```

- The window only shows the local chat page; links go to your normal browser. Closing the window quits the app.
- Desktop notifications appear when an agent writes while you are not looking at its chat (permission is asked on your first click).
- `AGENT_CHAT_PORT`, `AGENT_CHAT_AGENTS` and `AGENT_CHAT_DATA` change the port (default 48765) and the folders.
- Tested here: the smoke test on Linux (Wayland, Electron 45). Notifications and the menu launcher have not been tried.

## Add or change an agent

**In the app:** press the **+** at the top of the sidebar. Fill in a name, what it does, the instructions, whether it runs on Claude or Codex, and the folder it works in. It is saved as `agents/<name>.md` and the chat appears straight away (the Manager can hand work to it too); no restart needed. Agents made this way are deliberately limited: Claude agents get only read-only tools (read files, search, find files, web search, open pages) and Sonnet or Haiku, Codex agents get read-only or edit-in-folder access, and nothing made in the form can run commands or post. To give an agent shell commands (`Bash(...)` rules) or a publish step, write its file by hand as below. Changing or deleting an agent is also done on its file, then a restart.

Each agent is a markdown file in `agents/`. The file name is the agent's id.

```
---
title: Planner
goal: Tells you today's checklist
tools: Read, Grep, Glob
approval: false
cwd: ~/projects/my-project
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

## Codex agents (OpenAI Codex CLI)

Any agent can run on Codex instead of Claude Code: add `engine: codex` to its file. The app calls `codex exec --json`, so it uses your existing Codex login, and the chat looks the same (live steps, reply, tokens). `examples/agents/codex-helper.md` is a ready-made example (read-only questions about a repo).

```
engine: codex
sandbox: read-only        # or workspace-write; read-only is the default
model: <a Codex model>    # optional; leave out to use Codex's own default
```

- **Permissions are different.** Claude agents get an exact tool allowlist (`tools:`). Codex has no such list, so `tools:` is ignored for Codex agents and what they may touch is set by `sandbox:`. `read-only` lets it read files and run read-only commands; `workspace-write` also lets it edit files inside the agent's `cwd`, with no network. `danger-full-access` is refused. Keep agents that must not change anything, or that publish, on Claude.
- **Cost and cache:** Codex reports tokens only, so its replies show no `~$` figure and the cache chip stays "unknown".
- **Codex limits:** when at least one agent runs on Codex, the usage panel at the bottom of the sidebar gets a **Codex** group under the Claude one, with whichever windows your plan reports (this account shows one 30-day window; other plans show a 5-hour and a weekly one). The numbers come from Codex itself (`codex app-server`, request `account/rateLimits/read`), so reading them runs no model and costs nothing: they refresh after every Codex agent run, at most every 10 minutes while the page is open, and with the group's own Refresh button. If a read fails, the last good numbers stay and the reason is shown.
- **Compact chat** summarises with Sonnet (Claude Code), also for a Codex agent's chat.
- Each run starts a fresh, unsaved Codex session (`--ephemeral`); like the Claude agents, it only sees the last 12 messages plus its notes. Codex still loads your `~/.codex/config.toml` and any `AGENTS.md` in the agent's folder.
- Tested here: Codex CLI 0.166.0, one real read-only run plus tests with a fake `codex`.

## The Manager runs everything

The Manager is pinned at the top of the sidebar, apart from the agents, and the app opens in its chat on a wide screen. Tell it what you want in plain words; it does not do the work itself.

1. It picks the right agent and sends the task for you (you see "Sending this to Planner: …", and the task also appears in the agent's own chat).
2. When the agent has answered, the answer is brought back into the Manager's chat in a card, followed by the Manager's **check**: one extra Sonnet run that looks at what you asked, the task, the agent's job and the answer. The card is marked *looks fine* or *needs changes* (with the specific problems), or *not checked* if the check itself could not be read; an agent that failed is reported without a check.
3. Follow up in the same chat: "fix it", "shorten it", "ask planner again". The Manager sees the check and sends the agent a new task with the points to change.

An agent's draft that needs your approval (and its Approve & post button) still lives in that agent's chat; the card has a button that opens it. The Manager never approves or posts for you. Each hand-off costs the Manager's routing run, the agent's run, and the check run.

## Claude Code plan usage (bottom of the sidebar)

The panel at the bottom of the sidebar shows your account's real **5-hour** and **7-day** usage with reset countdowns, turning amber at 60% and red at 85%. The numbers come from Claude Code itself: every agent run streams a rate-limit report, and the app saves the newest one (so it also survives restarts). They are account-wide, so they include your other Claude Code use, not only the agents.

- The bar updates whenever any agent runs. It cannot update by itself without a call, so it shows "updated N min ago" (and "may be out of date" after 30 min).
- **Refresh** runs one tiny call on the Sonnet model (about 50k tokens) so Claude Code reports fresh numbers. That check counts toward your usage too.
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
- **Chat menu (the three dots in a chat header):**
  - *Compact chat* asks the agent (Sonnet, one run of about 50k tokens) to write a short summary of the conversation, replaces all the messages with it, and keeps feeding that summary to the agent on every later run. Use it when a chat is long but you want the agent to remember the decisions. Refused while the agent is working, while drafts wait for approval, or when the chat has fewer than 4 messages. If the summary fails nothing changes.
  - *Clear chat* wipes everything for that agent: messages (including waiting drafts), usage history, the agent's notes and any saved summary. Refused while the agent is working. The account-wide plan usage bar is not per chat and stays.
  - *Forget notes* empties the agent's `data/memory/<agent>.md` only.
- An agent keeps only its newest 30 notes.
- An agent only sees its last 12 messages plus its notes, so a long chat does not make runs more expensive.

## Layout

`src/main/` is the server and Electron shell, `src/renderer/` is the chat screen (React, TypeScript, Zustand), `test/` is the suite, and `examples/agents/` is what a fresh install starts with. The full map is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); changes are in [CHANGELOG.md](CHANGELOG.md).

## Safety

- Localhost only; requests with a wrong `Host` or without the `X-Agent-Chat` header are refused.
- Agents are told never to send or post anything, and get only the tools in their file.
- Data (chat database, memory notes) lives in `data/`, which git ignores.

## Approving and publishing from the chat

An agent can hand you something to approve and publish (a post, a file, a release note). Nothing happens until you click.

1. The agent does its work and ends its reply with a line `POST_READY: <folder>`.
2. The reply arrives as a draft with its images and an **Approve & post** button. Decline drops it.
3. On approve, the app itself runs the agent's `publish_cmd` (the agent has no publish command), and the chat then shows the result or the error.

How it is wired: an agent file may set `post_root` (the only folder a draft may sit in) and `publish_cmd` (with `{dir}` replaced by the draft's folder). When an answer ends with `POST_READY: <folder>`, and that folder is directly inside `post_root` and holds a `post.json` with its image files, the answer becomes a postable draft. Any other path is ignored. A second Approve click on the same draft is refused. Writing `post_root` and `publish_cmd` is file-only: nothing made in the in-app form can set them.

## Agents that run on their own

Add `schedule: 21:00` (24-hour local time) and optionally `schedule_message: ...` to an agent file. Once a day the app sends that message to the agent as if you had typed it. It only works while the app is running; a check missed because the app was closed runs when it opens the same day, never twice in one day (`data/schedule.json` remembers). `before_run: <command>` runs a command (in the agent's `cwd`) before every request to that agent and shows its output to the agent, which is useful for an agent whose sandbox has no network. See `examples/agents/daily-check.md`.

## Not built yet

Running from your phone (needs a safe tunnel and a login), agents reading each other's chats automatically.
