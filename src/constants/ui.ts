// Fixed text and choices for the chat page.

/** The quick-start buttons on the empty screen. A button only shows when its chat exists. */
export const STARTERS = [
  { chat: "manager", tag: "Manager", label: "What should I do today?", text: "What should I do today?" },
  { chat: "researcher", tag: "Researcher", label: "Research a topic", text: "Research " },
  { chat: "reviewer", tag: "Reviewer", label: "Check a draft", text: "Check this draft before I send it: " },
];

/** Ticked by default in the New agent form. */
export const DEFAULT_FORM_TOOLS = ["Read", "Grep", "Glob"];

/** Which avatar animal a well-known agent always gets; any other agent gets one picked from its name. */
export const FIXED_SPECIES: Record<string, string> = { manager: "robot", planner: "owl", reviewer: "cat", researcher: "frog", writer: "bear", "codex-helper": "alien" };

export const USAGE_NOTE =
  "Estimated cost reported by Claude Code (API prices). On a subscription you are not billed this amount; " +
  "it shows how much each agent uses. Plan limits are not available here.";
export const CACHE_NOTE =
  "Claude Code reuses the start of the prompt from a cache when you run the same agent again soon, which is cheaper and faster. " +
  "Warm = the last run is still inside the cache window (1 hour here), so the next run can reuse it. Cold = the window has passed, " +
  "so the next run rebuilds the prompt (about 50k tokens). This is estimated from the last run; part of the prompt changes every run, " +
  "so even a warm cache only covers part of it, and different agents share only the common start.";
