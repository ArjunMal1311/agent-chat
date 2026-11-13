// Limits, patterns and prompts used by the hub (hand-offs, memory, compacting, the Manager's check).

export const REMEMBER_RE = /^REMEMBER:\s*(.+)$/gm;
export const POST_RE = /^POST_READY:\s*(.+)$/gm;
// Agent-to-agent hand-offs: a reply line `HANDOFF: <agent> | <task>`. At most this many per reply; at most this many
// agents may already be in the chain (so A -> B -> C is the longest, and nobody is called twice in one chain); and
// how much of the answer is copied back into the caller's chat.
export const HANDOFF_RE = /^HANDOFF:\s*([A-Za-z0-9_-]+)\s*\|\s*(.+)$/gm;
export const MAX_HANDOFFS_PER_REPLY = 2;
export const MAX_HANDOFF_CHAIN = 2;
export const HANDOFF_NOTE_CHARS = 1200;
export const PUBLISH_TIMEOUT = 900;
export const BEFORE_RUN_TIMEOUT = 180; // a before_run command that takes longer than this is cut off and reported as failed
export const MAX_REVIEWED_CHARS = 12000;
export const MIN_TO_COMPACT = 4; // fewer messages than this is not worth a model call
export const MAX_TRANSCRIPT_CHARS = 60000;

export const COMPACT_PROMPT =
  "You compress a chat into a short briefing so the same agent can carry on without the full history. " +
  "Keep: decisions made, facts learned, what the user wants and prefers, open tasks and their state, and any " +
  "names, ids, handles, dates and numbers exactly as written. Drop greetings, tool chatter and anything finished " +
  "or superseded. Write plain bullet points, at most 250 words, no preamble. If an earlier summary is given, " +
  "fold it in rather than repeating it.";
export const REVIEW_PROMPT =
  "You are the Manager, checking an agent's answer before the user relies on it. You are given what the user asked, " +
  "the task you sent, the agent's job and its answer. Answer with ONLY one JSON object: " +
  '{"verdict": "ok" or "fix", "summary": "<one short sentence>", "issues": ["<specific problem>", ...]}. ' +
  'Use "fix" only for a concrete problem: the answer does not do what the task asked, it breaks the agent\'s stated job, ' +
  "it states numbers, facts, names or quotes that the task does not give and that are not marked as unknown, " +
  "it says it sent, posted or published something (agents only prepare drafts), it is cut off, or it says it could not do the task. " +
  "Do not nitpick style or length. You cannot check facts outside the text: if unsure, say so in the summary and still use " +
  '"ok". "issues" is empty when the verdict is "ok".';
