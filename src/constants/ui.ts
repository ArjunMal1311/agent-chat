// Fixed text and choices for the chat page.

/** The quick-start buttons on the empty screen. A button only shows when its chat exists. */
export const STARTERS = [
  { chat: "manager", tag: "Manager", label: "What should I do today?", text: "What should I do today?" },
  { chat: "researcher", tag: "Researcher", label: "Research a topic", text: "Research " },
  { chat: "reviewer", tag: "Reviewer", label: "Check a draft", text: "Check this draft before I send it: " },
];

/** Ticked by default in the New agent form. */
export const DEFAULT_FORM_TOOLS = ["Read", "Grep", "Glob"];

/** Avatar colours: flat and calm. An agent gets one of these, picked from its name, so it keeps the same colour. */
export const AVATAR_COLORS = ["#6b7cff", "#14a38b", "#e0568a", "#e08a2e", "#3d8bf2", "#8b5cf6", "#d9534f", "#5b6b82", "#2faa5c", "#c4569e", "#0f9fb5", "#a8812a", "#7a6ff0", "#e0654a", "#4f9a3a", "#5470c6"];

export const USAGE_NOTE =
  "Estimated cost reported by Claude Code (API prices). On a subscription you are not billed this amount; " +
  "it shows how much each agent uses. Plan limits are not available here.";
export const CACHE_NOTE =
  "Claude Code reuses the start of the prompt from a cache when you run the same agent again soon, which is cheaper and faster. " +
  "Warm = the last run is still inside the cache window (1 hour here), so the next run can reuse it. Cold = the window has passed, " +
  "so the next run rebuilds the prompt (about 50k tokens). This is estimated from the last run; part of the prompt changes every run, " +
  "so even a warm cache only covers part of it, and different agents share only the common start.";
