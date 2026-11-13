// The hub: takes your messages, runs agents, hands work between them, and records approvals.
//
// The hub never sends or posts anything to the outside world on its own. An "approval" is only your sign-off
// on a draft; the publish command of an agent runs only after you click Approve.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CLAUDE_MODEL_CHOICES, FILE_SANDBOXES, FORM_MODELS, FORM_TOOLS } from "../../constants/agents.ts";
import {
  BEFORE_RUN_TIMEOUT,
  COMPACT_PROMPT,
  HANDOFF_NOTE_CHARS,
  HANDOFF_RE,
  MAX_HANDOFFS_PER_REPLY,
  MAX_HANDOFF_CHAIN,
  MAX_REVIEWED_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MIN_TO_COMPACT,
  POST_RE,
  PUBLISH_TIMEOUT,
  REMEMBER_RE,
  REVIEW_PROMPT,
} from "../../constants/hub.ts";
import { type Agent, agentFromForm, makeAgent } from "../agents/agents.ts";
import type { Bus } from "./bus.ts";
import { type CodexLimits, readCodexLimits } from "../runner/codexlimits.ts";
import type { RunResult, Runner, Usage } from "../runner/runner.ts";
import type { Message, Store } from "../db/store.ts";

type Dict = Record<string, any>;

/** Runs a command (no shell). Resolves to [exit code, combined output]; never rejects. */
export type Poster = (argv: string[], cwd: string, timeoutSeconds?: number) => Promise<[number, string]>;

export const runCommand: Poster = (argv, cwd, timeoutSeconds = PUBLISH_TIMEOUT) =>
  new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (code: number, text = "") => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve([code, text]);
      }
    };
    const proc = spawn(argv[0], argv.slice(1), { cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(1, out + `TimeoutExpired: command timed out after ${timeoutSeconds} seconds`);
    }, timeoutSeconds * 1000);
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("error", (e) => done(1, `${e.name}: ${e.message}`)); // a missing command
    proc.on("close", (code) => done(code ?? 1, out));
  });

/** Split a command line the way a shell would: spaces separate words, quotes and backslashes group them. */
export function shellSplit(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) words.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) throw new Error("No closing quotation");
  if (started || cur) words.push(cur);
  return words;
}

/** Claude Code's rate-limit report -> {window: {used 0..1, resets_at epoch seconds, status}}. */
/** A draft folder is postable only when it sits inside the agent's post_root: directly in it, or one folder down
 *  (post_root/<account>/<draft>), so a single agent can serve several accounts. Both paths are already real paths. */
function inPostRoot(root: string, folder: string): boolean {
  const rel = path.relative(root, folder);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).length <= 2;
}

/** Where Codex keeps its config and model catalog (`CODEX_HOME`, else `~/.codex`). */
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

export function normalizeLimits(info: unknown): Dict {
  const i: Dict = info && typeof info === "object" ? (info as Dict) : {};
  const windows: Dict = i.unifiedWindows && typeof i.unifiedWindows === "object" ? i.unifiedWindows : {};
  const out: Dict = {};
  for (const key of ["five_hour", "seven_day"]) {
    const window = windows[key] || (i.rateLimitType === key ? i : null);
    if (window && typeof window === "object" && window.utilization != null) {
      out[key] = { used: Number(window.utilization), resets_at: window.resetsAt ?? null, status: window.status || "" };
    }
  }
  return out;
}

/** Pull the first {...} object out of a model answer, or null. */
export function parseJsonObject(text: string): Dict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const squash = (s: unknown, n: number) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, n);
const tail = (text: string, n: number) => text.trim().split("\n").slice(-n).join("\n");
const isResult = (r: unknown): r is RunResult => !!r && typeof r === "object" && "text" in (r as object);

export interface HubOptions {
  store: Store;
  agents: Map<string, Agent>;
  bus: Bus;
  runner: Runner;
  dataDir: string;
  poster?: Poster;
  agentsDir?: string | null;
  codexReader?: () => Promise<CodexLimits>;
}

export class Hub {
  store: Store;
  agents: Map<string, Agent>;
  bus: Bus;
  runner: Runner;
  poster: Poster;
  agentsDir: string | null;
  codexReader: () => Promise<CodexLimits>;
  memoryDir: string;
  private live = new Map<string, string[]>(); // chat -> steps of the run in progress, shown while the agent works
  private tasks = new Set<Promise<unknown>>();
  private codexRefresh: Promise<Dict> | null = null;

  constructor(o: HubOptions) {
    this.store = o.store;
    this.agents = o.agents;
    this.bus = o.bus;
    this.runner = o.runner;
    this.poster = o.poster ?? runCommand;
    this.agentsDir = o.agentsDir ?? null; // where New agent saves; null = not offered
    this.codexReader = o.codexReader ?? readCodexLimits;
    this.memoryDir = path.join(o.dataDir, "memory");
    fs.mkdirSync(this.memoryDir, { recursive: true });
  }

  // ---- helpers ---------------------------------------------------------------------------
  /** Run a turn in the background. Errors are shown in the chat by the turn itself; this never throws. */
  private spawn(work: Promise<unknown>): void {
    const task = work.catch((e) => console.error(e)).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  /** Resolves when every background turn has finished (tests use this; the app never needs it). */
  async settle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  liveSteps(chat: string): string[] {
    return [...(this.live.get(chat) ?? [])];
  }

  private notify(...chats: string[]): void {
    this.bus.publish({ chats });
  }

  // ---- plan limits (the 5-hour and 7-day windows Claude Code reports) ----------------------
  /** Save the newest limits report. A partial report only updates the windows it contains. */
  recordLimits = (info: unknown): void => {
    const fresh = normalizeLimits(info);
    if (!Object.keys(fresh).length) return;
    const saved = this.store.getJson<Dict>("limits", {}) || {};
    this.store.setJson("limits", { windows: { ...(saved.windows || {}), ...fresh }, updated: Date.now() / 1000 });
    this.bus.publish({ limits: true });
  };

  limits(): Dict {
    return this.store.getJson<Dict>("limits", null) || { windows: {}, updated: null };
  }

  // ---- Codex usage windows: read from Codex itself, no model call, so refreshing is free -----
  codexInUse(): boolean {
    return [...this.agents.keys()].some((name) => this.engineOf(name) === "codex");
  }

  /** The saved Codex windows, or null when no agent runs on Codex (then there is nothing to show). */
  codexLimits(): Dict | null {
    return this.codexInUse() ? this.store.getJson<Dict>("codex_limits", null) || { windows: [], updated: null } : null;
  }

  /** Read the windows now. A failed read keeps the last good numbers and records why; it never rejects. */
  refreshCodexLimits(maxAge = 0): Promise<Dict> {
    if (this.codexRefresh) return this.codexRefresh;
    const run = async (): Promise<Dict> => {
      let saved = this.store.getJson<Dict>("codex_limits", null) || {};
      const now = Date.now() / 1000;
      if (maxAge && now - (saved.checked || 0) < maxAge) return saved;
      try {
        saved = { ...(await this.codexReader()), updated: now, checked: now, error: "" };
      } catch (e) {
        saved = { ...saved, checked: now, error: String((e as Error).message ?? e).slice(0, 200) };
      }
      this.store.setJson("codex_limits", saved);
      this.bus.publish({ limits: true });
      return saved;
    };
    this.codexRefresh = run().finally(() => (this.codexRefresh = null));
    return this.codexRefresh;
  }

  /** Refresh in the background unless it was checked less than maxAge seconds ago. Never blocks the caller. */
  refreshCodexLimitsSoon(maxAge = 600): void {
    if (this.codexInUse()) this.spawn(this.refreshCodexLimits(maxAge));
  }

  /** Run one tiny call so Claude Code reports fresh limits. It uses a little usage itself. */
  async refreshLimits(): Promise<Usage> {
    const probe = makeAgent("probe", { title: "Probe", prompt: "Reply with the single word ok.", model: "sonnet", timeout: 90 });
    const result = await this.runner(probe, "ok", { onLimits: this.recordLimits });
    return isResult(result) ? { ...result.usage } : {};
  }

  /** How much a Codex agent may touch right now: the level picked with the chat's Access button if there is one,
   *  otherwise what its file says. Claude agents have a fixed tool list instead, so this is only used for Codex. */
  accessOf(chat: string): Agent["sandbox"] {
    const agent = this.agents.get(chat)!;
    const picked = this.store.getJson<string>("access:" + chat);
    return picked && (FILE_SANDBOXES as readonly string[]).includes(picked) ? (picked as Agent["sandbox"]) : agent.sandbox;
  }

  /** The program and model picked in the chat's model dropdown, or null when the agent's file decides. `id` is
   *  "claude:sonnet" or "codex:gpt-6-luna". A pick the dropdown does not offer (an older build saved a bare name, or
   *  Codex's model list changed) is ignored, so it can never be handed to a program that does not know the model. */
  pickOf(chat: string): { id: string; engine: Agent["engine"]; model: string } | null {
    const id = this.store.getJson<string>("model:" + chat) ?? "";
    const choice = this.modelChoices().find((c) => c.id === id);
    return choice ? { id, engine: choice.engine, model: id.slice(id.indexOf(":") + 1) } : null;
  }

  /** The picked id ("claude:opus"), or "" when the agent's file decides. */
  pickedModel(chat: string): string {
    return this.pickOf(chat)?.id ?? "";
  }

  /** The program the chat's next run uses: the one picked in its dropdown, else the one in its file. */
  engineOf(chat: string): Agent["engine"] {
    return this.pickOf(chat)?.engine ?? this.agents.get(chat)!.engine;
  }

  /** The agent as its next run sees it: its file with the chat's own picks applied (program, model, access).
   *  Used only for the chat's registered agent, never for a helper agent that runs under the same chat name. */
  effectiveAgent(chat: string): Agent {
    const agent = this.agents.get(chat)!;
    const pick = this.pickOf(chat);
    const engine = pick?.engine ?? agent.engine;
    const out: Agent = { ...agent, engine, model: pick ? pick.model : agent.model };
    out.sandbox = this.accessOf(chat); // Codex: its sandbox. Claude: "danger-full-access" means every tool (see runClaude).
    // A Codex agent's file has no tool list (its sandbox limits it instead). Switched to Claude it gets read-only
    // tools so it can still read files; give its file a `tools:` line for anything more.
    if (engine === "claude" && agent.engine === "codex" && !out.tools.length) out.tools = ["Read", "Grep", "Glob"];
    return out;
  }

  /** The model the next run uses ("" = the program's own default). */
  modelOf(chat: string): string {
    return this.effectiveAgent(chat).model;
  }

  /** What the model dropdown lists, for every chat: Claude's models, then the GPT models Codex itself says this login
   *  can use (read from its own cache file; none if Codex has not written one). */
  modelChoices(): { id: string; label: string; engine: Agent["engine"] }[] {
    const claude = CLAUDE_MODEL_CHOICES.map((c) => ({ id: "claude:" + c.id, label: c.label, engine: "claude" as const }));
    try {
      const models: unknown = JSON.parse(fs.readFileSync(path.join(codexHome(), "models_cache.json"), "utf8")).models;
      if (!Array.isArray(models)) return claude;
      const codex = models
        .filter((m) => m && m.visibility === "list" && typeof m.slug === "string")
        .map((m) => ({ id: "codex:" + m.slug, label: String(m.display_name || m.slug), engine: "codex" as const }));
      return [...claude, ...codex];
    } catch {
      return claude;
    }
  }

  /** The model a chat shows when nothing is picked: its file's model, or for Codex the default in Codex's own
   *  config (what `codex exec` uses when no `-m` is passed). Display only; the run is still started without `-m`. */
  shownModel(chat: string): string {
    const model = this.modelOf(chat);
    if (model || this.engineOf(chat) !== "codex") return model;
    try {
      return /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8"))?.[1] ?? "";
    } catch {
      return "";
    }
  }

  /** Pick a model for a chat ("" goes back to the agent file's choice). Picking a model from the other family also
   *  switches the chat to that program. It applies from the next run. */
  setModel(chat: string, id: string): void {
    if (!this.agents.has(chat)) throw new Error("unknown chat");
    const pick = id.trim();
    if (pick && !this.modelChoices().some((c) => c.id === pick)) throw new Error(`${pick} is not one of the models offered.`);
    this.store.setJson("model:" + chat, pick);
    this.notify(chat);
  }

  /** Remember an access level for a chat. It applies from the next run, not the one in progress. Codex chats have
   *  three levels. Claude chats have two: the tools in their file (read-only), or full access (every tool). */
  setAccess(chat: string, level: string): void {
    if (!this.agents.has(chat)) throw new Error("unknown chat");
    const offered = this.engineOf(chat) === "codex" ? FILE_SANDBOXES : (["read-only", "danger-full-access"] as const);
    if (!(offered as readonly string[]).includes(level)) throw new Error(`access must be one of ${offered.join(", ")} for this agent`);
    this.store.setJson("access:" + chat, level);
    this.notify(chat);
  }

  /** Call the runner. Returns [text, meta or null]; meta is the usage plus the steps taken.
   *  Steps are published as they happen so the chat can show what the agent is doing. */
  private async run(chat: string, agent: Agent, prompt: string): Promise<[string, Usage | null]> {
    // The chat's own choices (model dropdown and shield button) apply to its registered agent only, never to a
    // helper agent that happens to run under the same chat name.
    if (this.agents.get(chat) === agent) agent = this.effectiveAgent(chat);
    const steps: string[] = [];
    const onStep = (text: string) => {
      steps.push(text);
      this.live.set(chat, [...steps]);
      this.store.setDetail(chat, text);
      this.notify(chat);
    };
    let result;
    try {
      result = await this.runner(agent, prompt, { onStep, onLimits: this.recordLimits });
    } finally {
      this.live.delete(chat);
    }
    const [text, usage] = isResult(result) ? [result.text, result.usage] : [String(result), null];
    const meta: Usage = usage ? { ...usage } : {};
    if (steps.length) meta.steps = steps.slice(-40);
    return [text, Object.keys(meta).length ? meta : null];
  }

  // ---- agents made in the app --------------------------------------------------------------
  /** What the New agent form offers, and the folder most agents already use. */
  agentOptions(): Dict {
    const folders = [...this.agents.values()].map((a) => a.cwd).filter(Boolean);
    const counts = new Map<string, number>();
    for (const f of folders) counts.set(f, (counts.get(f) || 0) + 1);
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    return {
      enabled: this.agentsDir !== null,
      tools: Object.entries(FORM_TOOLS).map(([id, label]) => ({ id, label })),
      models: [...FORM_MODELS],
      cwd: common,
    };
  }

  /** Validate the form, save it as agents/<name>.md and start offering the chat straight away. */
  createAgent(spec: unknown): string {
    if (this.agentsDir === null) throw new Error("Adding agents from the app is not switched on here.");
    const [agent, text] = agentFromForm(spec, this.agents.keys());
    const file = path.join(this.agentsDir, `${agent.name}.md`);
    try {
      fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" }); // "wx": never overwrite a file that is already there
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`There is already an agent file called ${agent.name}.md.`);
      throw e;
    }
    this.agents = new Map([...this.agents, [agent.name, agent]]); // swap in a new map: readers keep a consistent view
    this.notify(agent.name);
    return agent.name;
  }

  private memoryPath(name: string): string {
    return path.join(this.memoryDir, `${name}.md`);
  }

  private readMemory(name: string): string {
    const p = this.memoryPath(name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  }

  private extractMemory(name: string, text: string): string {
    const notes = [...text.matchAll(REMEMBER_RE)].map((m) => m[1]);
    if (notes.length) {
      const p = this.memoryPath(name);
      const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()) : [];
      const lines = [...existing, ...notes.map((n) => `- ${n.trim()}`)];
      fs.writeFileSync(p, lines.slice(-this.agents.get(name)!.notesMax).join("\n") + "\n");
    }
    return text.replace(REMEMBER_RE, "").trim();
  }

  notesCount(name: string): number {
    const p = this.memoryPath(name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length : 0;
  }

  /** The agents `name` may hand work to in this turn: everyone but itself and the Manager, minus anyone already in the
   *  chain of hand-offs that led here (so nothing loops), limited by its `can_call:` line. None once the chain is long. */
  private callable(name: string, chain: string[]): Agent[] {
    const agent = this.agents.get(name);
    if (!agent || name === "manager" || chain.length >= MAX_HANDOFF_CHAIN) return [];
    return [...this.agents.values()].filter(
      (a) => a.name !== "manager" && a.name !== name && !chain.includes(a.name) && (agent.canCall === null || agent.canCall.includes(a.name)),
    );
  }

  private prompt(name: string, request: string, chain: string[] = []): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = d.toLocaleDateString("en-US", { weekday: "long" });
    const parts = [`Today is ${day} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.`];
    const others = this.callable(name, chain);
    if (others.length) {
      parts.push(
        "Other agents you can hand work to (the app runs them for you; their answer appears in their own chat and a note with it comes back to this chat, but you do not wait for it):\n" +
          others.map((a) => `- ${a.name}: ${a.title}. ${a.goal}`).join("\n") +
          `\nTo hand work over, end your reply with one line per agent: HANDOFF: <name> | <the task, with every detail that agent needs>. Only do this when the request really needs that agent, at most ${MAX_HANDOFFS_PER_REPLY} per reply, and never for work you can do yourself.`,
      );
    }
    const memory = this.readMemory(name);
    if (memory) parts.push("Your notes from earlier runs:\n" + memory);
    const summary = this.summaryOf(name);
    if (summary) parts.push("Summary of the earlier conversation (older messages were compacted away):\n" + summary);
    let history = this.store.recent(name, 12);
    if (history.length && history[history.length - 1][1] === request) history = history.slice(0, -1);
    if (history.length) parts.push("Recent conversation:\n" + history.map(([s, b]) => `${s}: ${b}`).join("\n"));
    parts.push("Request:\n" + request);
    return parts.join("\n\n");
  }

  // ---- public API ------------------------------------------------------------------------
  send(chat: string, text: string): Message {
    text = (text || "").trim();
    if (!this.agents.has(chat)) throw new Error("unknown chat");
    if (!text) throw new Error("empty message");
    const msg = this.store.add(chat, "you", text);
    this.notify(chat);
    const agent = this.agents.get(chat)!;
    if (agent.logCmd && /^\/(sent|reply)(\s|$)/i.test(text)) {
      this.spawn(this.logTurn(chat, agent, text)); // done by the app in code: the model is never involved
      return msg;
    }
    this.spawn(chat === "manager" ? this.managerTurn(text) : this.agentTurn(chat, text));
    return msg;
  }

  /** The `**@handle**` block of the newest message in this chat that has one, and its `DM:` line. */
  findDraft(chat: string, handle: string): string {
    const h = handle.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = new RegExp("\\*\\*@?" + h + "\\*\\*[^\\n]*\\n(?:(?!\\*\\*@)[^\\n]*\\n)*?DM:[ \\t]*(?:\\n[ \\t]*)?([^\\n]+)", "i");
    const msgs = this.store.messages(chat, 60);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].sender !== chat) continue;
      const m = block.exec(msgs[i].body + "\n");
      if (m) return m[1].trim();
    }
    return "";
  }

  /** `/sent @a @b` logs the drafted DM of each; `/sent @a | exact text` logs what you really sent; `/reply @a | their words`. */
  private async logTurn(chat: string, agent: Agent, text: string): Promise<void> {
    const say = (body: string) => {
      this.store.add(chat, chat, body);
      this.notify(chat);
    };
    const m = /^\/(sent|reply)\s*(.*)$/is.exec(text)!;
    const action = m[1].toLowerCase();
    const [left, ...rest] = m[2].split("|");
    const own = rest.join("|").trim();
    const handles = left.split(/[\s,]+/).filter(Boolean);
    const usage = action === "sent" ? "Use /sent @handle @handle (logs the drafts above) or /sent @handle | the exact message you sent." : "Use /reply @handle | what they wrote back.";
    if (!handles.length || handles.some((h) => !/^@?[A-Za-z0-9._]{1,30}$/.test(h))) return say("I could not read the handles. " + usage);
    if (action === "reply" && (handles.length !== 1 || !own)) return say(usage);
    if (own && handles.length !== 1) return say("A message of your own goes with exactly one handle. " + usage);
    const lines: string[] = [];
    for (const handle of handles) {
      const body = own || this.findDraft(chat, handle);
      if (!body) {
        lines.push(`@${handle.replace(/^@/, "")}: I found no draft for this person in this chat, so nothing was logged. Use /sent @${handle.replace(/^@/, "")} | the exact message.`);
        continue;
      }
      let code: number;
      let output: string;
      try {
        [code, output] = await this.poster([...shellSplit(agent.logCmd), action, handle.replace(/^@/, ""), "--text", body], agent.cwd, 60);
      } catch (e) {
        [code, output] = [1, String(e)];
      }
      const results = output.split("\n").filter((l) => l.startsWith("RESULT: ")).map((l) => l.slice(8));
      lines.push(...(results.length ? results : [`@${handle.replace(/^@/, "")}: the log command failed (exit ${code}). ${tail(output, 2)}`]));
    }
    say(lines.join("\n"));
  }

  /** Wipe a chat completely: messages, usage history, the agent's notes and its saved summary. */
  clearChat(chat: string): number {
    if (!this.agents.has(chat)) throw new Error("unknown chat");
    if (this.store.working(chat)[0]) throw new Error("this agent is working right now; clear the chat when it has finished");
    const deleted = this.store.wipe(chat);
    fs.rmSync(this.memoryPath(chat), { force: true });
    this.notify(chat);
    return deleted;
  }

  /** Replace the chat's history with a short summary the agent keeps using. Runs in the background. */
  compactChat(chat: string): void {
    if (!this.agents.has(chat)) throw new Error("unknown chat");
    if (this.store.working(chat)[0]) throw new Error("this agent is working right now; compact the chat when it has finished");
    if (this.store.pending(chat)) throw new Error("approve or decline the waiting drafts first, compacting would delete them");
    if (this.store.count(chat) < MIN_TO_COMPACT) throw new Error("this chat is too short to compact");
    this.spawn(this.compactTurn(chat));
  }

  private async compactTurn(chat: string): Promise<void> {
    const agent = this.agents.get(chat)!;
    if (!this.store.tryStart(chat, "Compacting the conversation…")) return;
    this.notify(chat);
    try {
      const msgs = this.store.messages(chat, 500).filter((m) => m.kind !== "status");
      const lines: string[] = [];
      const previous = (this.store.getJson<Dict>("summary:" + chat, null) || {}).text;
      if (previous) lines.push("Earlier summary:\n" + previous + "\n");
      lines.push(...msgs.map((m) => `${m.sender}: ${m.body.slice(0, 3000)}`));
      const transcript = lines.join("\n").slice(-MAX_TRANSCRIPT_CHARS);
      const helper = makeAgent(chat, { title: "Compact", prompt: COMPACT_PROMPT, model: "sonnet", timeout: 240, cwd: agent.cwd });
      const result = await this.runner(helper, "Conversation to compress:\n\n" + transcript, { onLimits: this.recordLimits });
      const [text, usage] = isResult(result) ? [result.text.trim(), result.usage] : [String(result).trim(), null];
      if (!text) throw new Error("the summary came back empty, nothing was changed");
      this.store.setJson("summary:" + chat, { text, at: Date.now() / 1000, messages: msgs.length });
      this.store.clear(chat);
      this.store.add(chat, chat, `Compacted ${msgs.length} messages into this summary, which ${agent.title} keeps:\n${text}`, "status", "", usage && Object.keys(usage).length ? usage : null);
    } catch (e) {
      console.error(e);
      this.store.add(chat, chat, `Could not compact: ${(e as Error).message}`, "status");
    } finally {
      this.store.finish(chat);
      this.notify(chat);
    }
  }

  summaryOf(chat: string): string {
    return (this.store.getJson<Dict>("summary:" + chat, null) || {}).text ?? "";
  }

  /** Empty the agent's saved notes. Messages are kept. */
  forgetNotes(chat: string): void {
    if (!this.agents.has(chat)) throw new Error("unknown chat");
    fs.rmSync(this.memoryPath(chat), { force: true });
    this.notify(chat);
  }

  approve(messageId: number, decision: string): Message {
    const msg = this.store.resolve(messageId, decision);
    if (!msg) throw new Error("that message is not waiting for approval");
    const post = msg.meta?.post;
    const agent = this.agents.get(msg.chat);
    const publishable = Boolean(post && agent && agent.publishCmd && agent.postRoot);
    let note: string;
    if (decision === "approved") note = publishable ? "Approved. Publishing now…" : "Approved. Nothing is sent automatically: you send it yourself.";
    else note = "Declined.";
    this.store.add(msg.chat, "you", note, "status");
    this.notify(msg.chat);
    if (decision === "approved" && publishable) this.spawn(this.publish(msg.chat, post));
    return msg;
  }

  /** Run the agent's publish command for an approved draft. Only ever reached through approve(). */
  private async publish(chat: string, post: Dict): Promise<void> {
    const agent = this.agents.get(chat)!;
    if (!this.store.tryStart(chat, "Publishing…")) {
      this.store.add(chat, chat, "Could not publish: the agent is busy. Approve again when it has finished.", "status");
      this.notify(chat);
      return;
    }
    this.notify(chat);
    try {
      const argv = shellSplit(agent.publishCmd).map((token) => (token === "{dir}" ? post.dir : token));
      const [code, text] = await this.poster(argv, agent.cwd);
      const line = text.split("\n").find((l) => l.startsWith("POSTED:")) ?? "";
      if (code === 0 && line) {
        this.store.add(chat, chat, "Published: " + line.slice(line.indexOf(":") + 1).trim());
      } else {
        this.store.add(chat, chat, `Could not publish (nothing was published unless the target shows it):\n${tail(text, 6) || "no output"}`);
      }
    } catch (e) {
      console.error(e);
      this.store.add(chat, chat, `Could not publish: ${(e as Error).message}`);
    } finally {
      this.store.finish(chat);
      this.notify(chat);
    }
  }

  /** A line `POST_READY: <folder>` makes the answer a postable draft, but only when the folder sits directly
   *  inside the agent's postRoot and holds a post.json. Returns [text without the line, post info or null]. */
  private extractPost(agent: Agent, text: string): [string, Dict | null] {
    const found = [...text.matchAll(POST_RE)].map((m) => m[1]);
    const clean = text.replace(POST_RE, "").trim();
    if (!found.length || !agent.postRoot || !agent.publishCmd) return [clean, null];
    try {
      const folder = fs.realpathSync(found[found.length - 1].trim());
      const root = fs.realpathSync(agent.postRoot);
      const spec = path.join(folder, "post.json");
      if (!inPostRoot(root, folder) || !fs.statSync(spec).isFile()) return [clean, null];
      const data = JSON.parse(fs.readFileSync(spec, "utf8"));
      const files: string[] = data.files.filter((f: string) => fs.existsSync(path.join(folder, f)) && fs.statSync(path.join(folder, f)).isFile());
      if (!files.length || files.length !== data.files.length) return [clean, null];
      return [clean, { dir: folder, files, caption: data.caption ?? "", slides: data.slides ?? [] }];
    } catch {
      return [clean, null];
    }
  }

  /** Path of slide n of a postable draft, or null. */
  postImage(mid: number, n: number): string | null {
    const msg = this.store.message(mid);
    const post = msg?.meta?.post;
    const agent = msg ? this.agents.get(msg.chat) : undefined;
    if (!post || !agent || !agent.postRoot) return null;
    try {
      const file = post.files[n];
      if (typeof file !== "string") return null;
      const real = fs.realpathSync(path.join(post.dir, file));
      const root = fs.realpathSync(agent.postRoot);
      return path.dirname(real) === fs.realpathSync(post.dir) && inPostRoot(root, path.dirname(real)) && fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  // ---- turns -----------------------------------------------------------------------------
  /** Run the agent's before_run command and describe the result for the agent. A failure is reported, never hidden. */
  private async beforeRun(agent: Agent): Promise<string> {
    let code: number;
    let output: string;
    try {
      [code, output] = await this.poster(shellSplit(agent.beforeRun), agent.cwd, Math.min(agent.timeout, BEFORE_RUN_TIMEOUT));
    } catch (e) {
      [code, output] = [1, String(e)];
    }
    const state = code === 0 ? "worked" : `FAILED (exit ${code}); tell the user it failed and work from the data you already have`;
    return `\n\n[The app ran \`${agent.beforeRun}\` just before this message. It ${state}. Last lines:\n${tail(output, 6)}]`;
  }

  /** Run one agent on a request. Resolves true if it produced an answer. */
  async agentTurn(name: string, request: string, chain: string[] = []): Promise<boolean> {
    const agent = this.agents.get(name)!;
    if (!this.store.tryStart(name, "Starting…")) {
      this.store.add(name, name, "I'm still working on the last request. Ask again in a minute.");
      this.notify(name);
      return false;
    }
    this.notify(name);
    let ok = false;
    try {
      if (agent.beforeRun) request += await this.beforeRun(agent);
      let [out, usage] = await this.run(name, agent, this.prompt(name, request, chain));
      out = this.extractMemory(name, out);
      let post: Dict | null;
      [out, post] = this.extractPost(agent, out);
      let calls: [string, string][];
      let ignored: string[];
      [out, calls, ignored] = this.extractHandoffs(name, out, chain);
      if (post) usage = { ...(usage || {}), post };
      const kind = (agent.approval || post) && out ? "approval" : "text";
      this.store.add(name, name, out || "(no answer)", kind, kind === "approval" ? "pending" : "", usage);
      if (ignored.length) this.store.add(name, name, `Hand-off ignored (not an agent it may call here): ${ignored.join(", ")}.`, "status");
      for (const [target, task] of calls) {
        this.store.add(name, name, `Handed to ${this.agents.get(target)!.title}: ${task}`, "status");
        this.spawn(this.callAgent(name, target, task, [...chain, name]));
      }
      ok = true;
    } catch (e) {
      console.error(e); // shown in the chat, never crashes the server
      this.store.add(name, name, `Could not finish: ${(e as Error).message}`);
    } finally {
      this.store.finish(name);
      this.notify(name);
      if (this.engineOf(name) === "codex") this.refreshCodexLimitsSoon(30); // that run used some of the Codex allowance
    }
    return ok;
  }

  /** Take the `HANDOFF: <agent> | <task>` lines out of a reply. Returns [text without them, the hand-offs it may make,
   *  the names it asked for but may not call]. At most MAX_HANDOFFS_PER_REPLY, each agent once. */
  private extractHandoffs(name: string, text: string, chain: string[]): [string, [string, string][], string[]] {
    const asked = [...text.matchAll(HANDOFF_RE)];
    if (!asked.length) return [text, [], []];
    const allowed = new Set(this.callable(name, chain).map((a) => a.name));
    const calls: [string, string][] = [];
    const ignored: string[] = [];
    for (const m of asked) {
      const target = m[1];
      if (allowed.has(target) && calls.length < MAX_HANDOFFS_PER_REPLY && !calls.some((c) => c[0] === target)) calls.push([target, m[2].trim()]);
      else if (!ignored.includes(target)) ignored.push(target);
    }
    return [text.replace(HANDOFF_RE, "").trim(), calls, ignored];
  }

  /** One agent hands a task to another: the task goes into the other agent's chat in the caller's name, the other agent
   *  runs, and a note with its answer comes back to the caller's chat. The caller is not run again, so nothing loops. */
  private async callAgent(from: string, to: string, task: string, chain: string[]): Promise<void> {
    const caller = this.agents.get(from)!;
    const target = this.agents.get(to)!;
    const request = `From ${caller.title}: ${task}`;
    this.store.add(to, from, request);
    this.notify(to);
    const ok = await this.agentTurn(to, request, chain);
    const answer = this.store.last(to);
    let note: string;
    if (!ok || !answer || answer.sender !== to) {
      note = `${target.title} could not finish this.\n\n${answer && answer.sender === to ? answer.body : ""}`.trim();
    } else {
      const body = answer.body.length > HANDOFF_NOTE_CHARS ? answer.body.slice(0, HANDOFF_NOTE_CHARS) + "…\n(the rest is in their chat)" : answer.body;
      note = `${target.title} answered:\n\n${body}` + (answer.kind === "approval" ? `\n\nThis is a draft. Approve or decline it in ${target.title}'s chat.` : "");
    }
    this.store.add(from, to, note);
    this.notify(from, to);
  }

  private async managerTurn(text: string): Promise<void> {
    const manager = this.agents.get("manager")!;
    if (!this.store.tryStart("manager", "Thinking…")) {
      this.store.add("manager", "manager", "Still on the last request. Ask again in a minute.");
      this.notify("manager");
      return;
    }
    this.notify("manager");
    let handoff: [string, string] | null = null;
    try {
      const roster = [...this.agents.values()].filter((a) => a.name !== "manager").map((a) => `- ${a.name}: ${a.title}. ${a.goal}`).join("\n");
      const request = `Agents you can hand work to:\n${roster}\n\nUser message:\n${text}`;
      const [out, usage] = await this.run("manager", manager, this.prompt("manager", request));
      const decision = parseJsonObject(out) || {};
      const target = decision.agent;
      if (typeof target === "string" && this.agents.has(target) && target !== "manager") {
        const task = String(decision.task || text).trim();
        this.store.add("manager", "manager", `Sending this to ${this.agents.get(target)!.title}: ${task}`, "text", "", usage);
        handoff = [target, task];
      } else {
        this.store.add("manager", "manager", String(decision.reply || out || "(no answer)").trim(), "text", "", usage);
      }
    } catch (e) {
      console.error(e);
      this.store.add("manager", "manager", `Could not finish: ${(e as Error).message}`);
    } finally {
      this.store.finish("manager");
      this.notify("manager");
    }
    if (handoff) await this.handoff(handoff[0], handoff[1], text);
  }

  /** Send the task to the agent in the user's name, wait for the answer, then report it in the Manager's chat. */
  private async handoff(name: string, task: string, request = ""): Promise<void> {
    this.store.add(name, "manager", task);
    this.notify(name);
    const ok = await this.agentTurn(name, task);
    await this.report(name, task, request || task, ok);
  }

  /** Bring the agent's answer into the Manager's chat with the Manager's check of it, so one chat shows everything. */
  private async report(name: string, task: string, request: string, ok: boolean): Promise<void> {
    const agent = this.agents.get(name)!;
    const title = agent.title;
    const answer = this.store.last(name);
    const relay = { agent: name, title, id: answer ? answer.id : null };
    if (!ok || !answer || answer.sender !== name) {
      const reason = answer && answer.sender === name ? answer.body : "";
      this.store.add("manager", "manager", `${title} could not finish.\n\n${reason}`.trim(), "text", "", { relay: { ...relay, verdict: "failed" } });
      this.notify("manager", name);
      return;
    }
    const draft = answer.kind === "approval";
    const [verdict, usage] = await this.review(agent, task, request, answer.body);
    const lines = [`${title} answered:`, "", answer.body];
    if (draft) lines.push("", `This is a draft. Approve or decline it in ${title}'s chat.`);
    let state: string;
    if (verdict === null) {
      lines.push("", "Check: I could not check this answer.");
      state = "unchecked";
    } else if (verdict.verdict === "ok") {
      lines.push("", "Check: looks fine. " + verdict.summary);
      state = "ok";
    } else {
      lines.push("", "Check: needs changes. " + verdict.summary, ...verdict.issues.map((i: string) => `- ${i}`));
      lines.push("", `Say “fix it” and I will send this back to ${title} with those points.`);
      state = "fix";
    }
    this.store.add("manager", "manager", lines.join("\n"), "text", "", { ...(usage || {}), relay: { ...relay, verdict: state, draft } });
    this.notify("manager", name);
  }

  /** The Manager's own check of an answer: one Sonnet run. Resolves to [verdict or null, usage]. */
  private async review(agent: Agent, task: string, request: string, answer: string): Promise<[Dict | null, Usage | null]> {
    if (!this.store.tryStart("manager", `Checking ${agent.title}'s answer…`)) return [null, null];
    this.notify("manager");
    try {
      const prompt =
        `The agent: ${agent.title}. Its job: ${agent.goal || "not stated"}\n\n` +
        `What the user asked the Manager:\n${request}\n\nThe task the Manager sent:\n${task}\n\n` +
        `The agent's answer:\n${answer.slice(0, MAX_REVIEWED_CHARS)}`;
      const checker = makeAgent("manager", { title: "Manager", prompt: REVIEW_PROMPT, model: "sonnet", timeout: 150 });
      const [out, usage] = await this.run("manager", checker, prompt);
      const data = parseJsonObject(out) || {};
      const verdict = String(data.verdict || "").toLowerCase();
      if (verdict !== "ok" && verdict !== "fix") return [null, usage];
      const issues: unknown[] = Array.isArray(data.issues) ? data.issues : [];
      return [
        {
          verdict,
          summary: squash(data.summary, 300),
          issues: verdict === "fix" ? issues.filter((i) => String(i).trim()).map((i) => squash(i, 300)).slice(0, 6) : [],
        },
        usage,
      ];
    } catch (e) {
      console.error(e);
      return [null, null];
    } finally {
      this.store.finish("manager");
      this.notify("manager");
    }
  }
}
