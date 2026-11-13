// What an agent file or the New agent form may contain.

export const ENGINES = ["claude", "codex"] as const;
export const SANDBOXES = ["read-only", "workspace-write"] as const; // what the New agent form may offer
// A hand-written agent file may also ask for Codex's full access (shell, network, files anywhere you can). The
// form never offers it, so nothing made from a web page can get it; you opt in by editing the file yourself.
export const FILE_SANDBOXES = [...SANDBOXES, "danger-full-access"] as const;

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
// What the model dropdown in a Claude chat offers (a file may name any model; the form never offers Opus).
export const CLAUDE_MODEL_CHOICES = [
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "opus", label: "Opus" },
] as const;
export const RESERVED_NAMES = new Set(["manager", "probe"]);
export const MAX_PROMPT = 8000;
