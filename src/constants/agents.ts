// What an agent file or the New agent form may contain.

export const ENGINES = ["claude", "codex"] as const;
export const SANDBOXES = ["read-only", "workspace-write"] as const; // never "danger-full-access": a chat agent has no business there

// The form deliberately offers less than a hand-written file: read-only Claude tools, Sonnet or Haiku (never
// Opus), and Codex only in its read-only or workspace-write sandbox. Shell commands (Bash(...) rules), editing
// tools, publish_cmd and post_root stay file-only, so nothing made from a web form can run or post anything.
export const FORM_TOOLS: Record<string, string> = {
  Read: "Read files",
  Grep: "Search inside files",
  Glob: "Find files by name",
  WebSearch: "Search the web",
  WebFetch: "Open web pages",
};
export const FORM_MODELS = ["sonnet", "haiku"] as const;
export const RESERVED_NAMES = new Set(["manager", "probe"]);
export const MAX_PROMPT = 8000;
