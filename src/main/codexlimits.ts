// OpenAI Codex's usage windows, read through `codex app-server` (its `account/rateLimits/read` request).
//
// This asks Codex's own app server for the numbers its /status screen shows. It runs no model, so it costs nothing,
// and it uses the Codex login that is already on this machine. Only the windows and the plan name are kept:
// the reply also holds an account id, which is dropped here and never stored.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { RunError } from "./runner.ts";

const CLIENT = { name: "agent-chat", title: "Agent Chat", version: "1.0" };

export interface CodexWindow {
  label: string;
  used: number;
  resets_at: number | null;
  minutes: number | null;
}
export interface CodexLimits {
  plan: string;
  windows: CodexWindow[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A plain name for a window length: 300 -> "5-hour", 10080 -> "7-day", 43200 -> "30-day". */
export function windowLabel(minutes: unknown): string {
  if (!isNum(minutes) || minutes <= 0) return "limit";
  if (minutes < 60) return `${Math.round(minutes)}-minute`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}-hour`;
  return `${Math.round(minutes / 1440)}-day`;
}

/** {plan, windows} from Codex's `rateLimits` object. Codex may report one window or two (and which ones depends on
 *  the plan), so every window that is there is kept. */
export function normalize(rateLimits: unknown): CodexLimits {
  if (!rateLimits || typeof rateLimits !== "object") return { plan: "", windows: [] };
  const rl = rateLimits as Record<string, any>;
  const windows: CodexWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = rl[key];
    if (!w || typeof w !== "object" || !isNum(w.usedPercent)) continue;
    windows.push({
      label: windowLabel(w.windowDurationMins),
      used: Math.max(0, Math.min(w.usedPercent / 100, 1)),
      resets_at: isNum(w.resetsAt) ? w.resetsAt : null,
      minutes: isNum(w.windowDurationMins) ? w.windowDurationMins : null,
    });
  }
  return { plan: typeof rl.planType === "string" && rl.planType !== "unknown" ? rl.planType : "", windows };
}

/** Ask a short-lived `codex app-server` for the current windows. Throws RunError with a plain reason. */
export async function readCodexLimits(timeoutSeconds = 30): Promise<CodexLimits> {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  let exited = false;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const fail = (error: Error) => {
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  proc.on("error", (err: NodeJS.ErrnoException) =>
    fail(err.code === "ENOENT" ? new RunError("the `codex` command was not found on PATH") : new RunError(`could not talk to codex: ${err.message}`)),
  );
  proc.on("close", () => {
    exited = true;
    fail(new RunError("codex stopped before it answered"));
  });
  proc.stdin!.on("error", () => {});
  readline.createInterface({ input: proc.stdout! }).on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || !("id" in message)) return;
    const w = waiting.get(message.id);
    if (!w) return;
    waiting.delete(message.id);
    if (message.error) w.reject(new RunError("codex said: " + String(message.error?.message || message.error).slice(0, 200)));
    else w.resolve(message.result || {});
  });

  const request = (id: number, method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new RunError(`codex did not answer within ${timeoutSeconds}s`));
      }, timeoutSeconds * 1000);
      waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      proc.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });

  try {
    await request(1, "initialize", { clientInfo: CLIENT });
    proc.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    const result = await request(2, "account/rateLimits/read", null);
    const data = normalize(result.rateLimits);
    if (!data.windows.length) throw new RunError("codex reported no usage windows (not signed in with a ChatGPT account?)");
    return data;
  } finally {
    if (!exited) proc.kill("SIGKILL");
  }
}
