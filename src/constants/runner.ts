// What every agent turn is run with: the standing rules, the CLI flags and how Codex is told who is asking.

export const RULES =
  "\n\nYou are an agent in a chat app. Reply the way you would in a chat message: short, plain, " +
  "no preamble. Never send, post, publish or message anyone yourself: you only prepare drafts and " +
  "answers for the user, who sends everything by hand. If you learn something worth remembering " +
  "for next time, add a separate line starting with REMEMBER: and the note.";

// Agents never need skills or MCP servers, and loading them adds thousands of tokens to every call.
export const LEAN_FLAGS = ["--disable-slash-commands", "--strict-mcp-config", "--exclude-dynamic-system-prompt-sections"];

// Codex wraps shell commands as `/bin/bash -lc <command>`; this takes the wrapper off so the chat shows the command itself.
export const SHELL_WRAPPER = /^\/(?:usr\/)?bin\/(?:ba|z)?sh\s+-l?c\s+(.*)$/s;

// Sent to `codex app-server` when asking for the usage windows.
export const CODEX_CLIENT = { name: "agent-chat", title: "Agent Chat", version: "1.0" };
