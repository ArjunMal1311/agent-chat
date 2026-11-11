// Runs one agent turn through the Claude Code CLI (`claude -p`) or OpenAI Codex (`codex exec`), streaming what it does.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { LEAN_FLAGS, RULES, SHELL_WRAPPER } from "../../constants/runner.ts";
import type { Agent } from "../agents/agents.ts";

export class RunError extends Error {}

export type Usage = Record<string, any>;
export interface RunResult {
  text: string;
  usage: Usage;
}
export interface Callbacks {
  onStep?: (text: string) => void;
  onLimits?: (info: Record<string, any>) => void;
}
export type Runner = (agent: Agent, prompt: string, callbacks?: Callbacks) => Promise<RunResult | string>;

type Dict = Record<string, any>;
/** `value` if it is a plain object, else {}: stream events are not always shaped the way we expect. */
const dict = (value: unknown): Dict => (value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {});
const num = (value: unknown): number => Number(value) || 0;
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Boil Claude Code's JSON result down to the few numbers the chat shows. */
export function extractUsage(data: Dict): Usage {
  const usage = dict(data.usage);
  const models = Object.keys(dict(data.modelUsage)).sort();
  const created = dict(usage.cache_creation);
  const oneHour = num(created.ephemeral_1h_input_tokens);
  const fiveMin = num(created.ephemeral_5m_input_tokens);
  return {
    model: models.join(", "),
    cost: round(num(data.total_cost_usd), 4),
    in: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    cache_read: num(usage.cache_read_input_tokens),
    cache_write: num(usage.cache_creation_input_tokens),
    // how long what this run wrote to the cache stays warm: 1 hour or 5 minutes (0 = it wrote nothing)
    cache_ttl: oneHour ? 3600 : fiveMin ? 300 : 0,
    out: num(usage.output_tokens),
    seconds: round(num(data.duration_ms) / 1000, 1),
    turns: num(data.num_turns) || 1,
  };
}

// ---- describing steps in plain words ---------------------------------------------------
const shortPath = (p: unknown): string => {
  const parts = String(p ?? "").split("/").filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : "a file";
};
const squash = (s: unknown) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");

export function describeTool(name: unknown, toolInput: unknown): string {
  const input = dict(toolInput);
  if (name === "Read") return "Reading " + shortPath(input.file_path);
  if (name === "Grep") return "Searching for “" + String(input.pattern ?? "").slice(0, 50) + "”";
  if (name === "Glob") return "Finding files " + String(input.pattern ?? "").slice(0, 50);
  if (name === "Bash") return "Running " + squash(input.command).slice(0, 90);
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return "Editing " + shortPath(input.file_path);
  if (name === "WebSearch" || name === "WebFetch") return `${name} ` + String(input.query || input.url || "").slice(0, 70);
  return `Using ${name}`;
}

/** Steps (short plain strings) a stream event stands for. Most events stand for none. */
export function describeEvent(event: unknown): string[] {
  const e = dict(event);
  const content = dict(e.message).content;
  if (!Array.isArray(content)) return [];
  const steps: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (e.type === "assistant" && block.type === "tool_use") {
      steps.push(describeTool(block.name, block.input));
    } else if (e.type === "user" && block.type === "tool_result" && block.is_error) {
      let detail = block.content;
      if (Array.isArray(detail)) detail = detail.filter((b) => b && typeof b === "object").map((b) => String(b.text ?? "")).join(" ");
      steps.push("That step failed: " + squash(detail).slice(0, 80));
    }
  }
  return steps;
}

// ---- reading claude's output -----------------------------------------------------------
function resultFrom(data: Dict): RunResult {
  if (data.is_error) throw new RunError(String(data.result || "claude reported an error").slice(0, 500));
  return { text: String(data.result ?? "").trim(), usage: extractUsage(data) };
}

/** `claude -p --output-format json` prints one JSON object; hooks may print other lines around it. */
export function parseClaudeOutput(stdout: string): RunResult {
  for (const raw of stdout.trim().split("\n").reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (data && typeof data === "object" && "result" in (data as object)) return resultFrom(data as Dict);
  }
  throw new RunError("could not read claude's answer: " + stdout.trim().slice(0, 300));
}

/** Start a CLI, feed it the prompt on stdin, call `onEvent` for each JSON line, collect the other lines as noise. */
function runProcess(
  command: string,
  args: string[],
  agent: Agent,
  input: string,
  onEvent: (event: Dict) => void,
): Promise<{ noise: string[]; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: agent.cwd || undefined, stdio: ["pipe", "pipe", "pipe"] });
    const noise: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, agent.timeout * 1000);
    const onLine = (raw: string) => {
      const line = raw.trim();
      if (!line.startsWith("{")) return void noise.push(line);
      try {
        onEvent(dict(JSON.parse(line)));
      } catch (e) {
        if (e instanceof SyntaxError) noise.push(line);
        else throw e;
      }
    };
    readline.createInterface({ input: proc.stdout! }).on("line", onLine);
    readline.createInterface({ input: proc.stderr! }).on("line", onLine);
    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new RunError(`the \`${command}\` command was not found on PATH`) : err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ noise, code, timedOut });
    });
    proc.stdin!.on("error", () => {}); // the process may exit before reading its input
    proc.stdin!.end(input);
  });
}

/** Run one turn. `onStep(text)` is called for each step as it happens (reading a file, running a command).
 *  `onLimits(info)` gets Claude Code's plan-limit reports (the 5-hour and 7-day windows) as they arrive. */
export async function runClaude(agent: Agent, prompt: string, { onStep, onLimits }: Callbacks = {}): Promise<RunResult> {
  const args = ["-p", "--output-format", "stream-json", "--verbose", ...LEAN_FLAGS, "--append-system-prompt", agent.prompt + RULES];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools.length) args.push("--allowedTools", agent.tools.join(","));
  let result: Dict | null = null;
  const { noise, code, timedOut } = await runProcess("claude", args, agent, prompt, (event) => {
    if (event.type === "result") result = event;
    else if (event.type === "rate_limit_event") {
      if (onLimits && event.rate_limit_info && typeof event.rate_limit_info === "object") onLimits(event.rate_limit_info);
    } else if (onStep) for (const step of describeEvent(event)) onStep(step);
  });
  if (timedOut) throw new RunError(`timed out after ${agent.timeout}s`);
  if (!result) throw new RunError(noise.filter(Boolean).join(" ").slice(-400) || `claude exited with ${code} and no answer`);
  return resultFrom(result);
}

// ---- OpenAI Codex (`codex exec --json`) ------------------------------------------------
// Codex has no per-tool allowlist like Claude Code. What it may do is set by its sandbox
// (read-only by default), so a Codex agent's `tools:` line is ignored.

export function plainCommand(command: unknown): string {
  let text = squash(command);
  const match = SHELL_WRAPPER.exec(text);
  if (match) {
    text = match[1].trim();
    if (text.length >= 2 && text[0] === text[text.length - 1] && "'\"".includes(text[0])) text = text.slice(1, -1);
  }
  return text;
}

/** Steps a `codex exec --json` event stands for. Most events stand for none. */
export function describeCodexEvent(event: unknown): string[] {
  const e = dict(event);
  const item = dict(e.item);
  if (e.type === "item.started") {
    if (item.type === "command_execution") return ["Running " + plainCommand(item.command).slice(0, 90)];
    if (item.type === "web_search") return ["WebSearch " + String(item.query ?? "").slice(0, 70)];
    if (item.type === "mcp_tool_call") return [`Using ${item.server || "tool"}.${item.tool || ""}`.replace(/\.$/, "")];
  } else if (e.type === "item.completed") {
    if (item.type === "command_execution" && item.exit_code !== 0 && item.exit_code != null) {
      return [`That step failed (exit ${item.exit_code}): ` + plainCommand(item.command).slice(0, 60)];
    }
    if (item.type === "file_change") {
      const paths = Array.isArray(item.changes) ? item.changes.map((c: unknown) => shortPath(dict(c).path)) : [];
      return ["Editing " + (paths.slice(0, 3).join(", ") || "files")];
    }
  }
  return [];
}

/** Codex reports tokens only (no cost, no cache write size), so those fields stay 0. */
export function codexUsage(totals: Dict, model: string, seconds: number): Usage {
  return {
    model: model || "codex",
    cost: 0,
    in: num(totals.input_tokens),
    cache_read: num(totals.cached_input_tokens),
    cache_write: 0,
    cache_ttl: 0,
    out: num(totals.output_tokens) + num(totals.reasoning_output_tokens),
    seconds: round(seconds, 1),
    turns: num(totals.turns) || 1,
  };
}

/** Same contract as runClaude (`onLimits` is unused: Codex reports none). The agent's prompt goes in front of the
 *  conversation, because Codex has no append-system-prompt flag. */
export async function runCodex(agent: Agent, prompt: string, { onStep }: Callbacks = {}): Promise<RunResult> {
  const sandbox = agent.sandbox === "workspace-write" ? "workspace-write" : "read-only";
  const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", sandbox];
  if (agent.model) args.push("-m", agent.model);
  if (agent.search) args.push("-c", "web_search=live"); // Codex's own search tool; the sandbox itself still has no network
  args.push("-"); // the prompt comes on stdin
  const full = "<instructions>\n" + agent.prompt + RULES + "\n</instructions>\n\n" + prompt;
  const started = Date.now();
  let answer: string | null = null;
  let failure: string | null = null;
  const totals: Dict = { turns: 0 };
  const { noise, code, timedOut } = await runProcess("codex", args, agent, full, (event) => {
    const item = dict(event.item);
    if (event.type === "item.completed" && item.type === "agent_message") {
      answer = String(item.text ?? "").trim();
    } else if (event.type === "turn.completed") {
      totals.turns += 1;
      for (const [key, value] of Object.entries(dict(event.usage))) {
        if (typeof value === "number") totals[key] = (totals[key] || 0) + value;
      }
    } else if (event.type === "turn.failed") {
      failure = String(dict(event.error).message || "codex reported an error");
    } else if (event.type === "error") {
      failure = String(event.message || "codex reported an error"); // a top-level error ends the run
    } else if (onStep) for (const step of describeCodexEvent(event)) onStep(step);
  });
  if (timedOut) throw new RunError(`timed out after ${agent.timeout}s`);
  if (failure && answer === null) throw new RunError((failure as string).slice(0, 500));
  if (answer === null) throw new RunError(noise.filter(Boolean).join(" ").slice(-400) || `codex exited with ${code} and no answer`);
  return { text: answer, usage: codexUsage(totals, agent.model, (Date.now() - started) / 1000) };
}

/** The runner the app uses: each agent's `engine:` line picks Claude Code or Codex. */
export const runAgent: Runner = (agent, prompt, callbacks) =>
  (agent.engine === "codex" ? runCodex : runClaude)(agent, prompt, callbacks);
