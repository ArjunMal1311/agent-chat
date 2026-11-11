// Agents are markdown files in agents/: a few `key: value` lines between --- fences, then the job prompt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINES, FORM_MODELS, FORM_TOOLS, MAX_PROMPT, RESERVED_NAMES, SANDBOXES } from "../../constants/agents.ts";

export interface Agent {
  name: string;
  title: string;
  goal: string;
  tools: string[];
  approval: boolean;
  cwd: string;
  timeout: number;
  model: string;
  prompt: string;
  postRoot: string; // folder a finished post may sit in; a POST_READY: line pointing inside it makes a postable draft
  publishCmd: string; // run when you approve such a draft; {dir} is replaced by the post's folder
  engine: "claude" | "codex"; // which CLI runs this agent
  sandbox: "read-only" | "workspace-write"; // codex only: what the agent may touch
  schedule: string; // "HH:MM" local time: the app sends scheduleMessage to this agent once a day while it is running
  scheduleMessage: string;
  beforeRun: string; // a command the app runs (in cwd) before every request to this agent. File-only
  logCmd: string; // run by the app (never by the model) for the chat commands /sent and /reply in this agent's chat. File-only
  search: boolean; // codex only: turn on live web search for this agent
  notesMax: number; // how many REMEMBER notes the agent keeps (newest win). Default 30
}

export function makeAgent(name: string, over: Partial<Agent> = {}): Agent {
  return {
    name,
    title: "",
    goal: "",
    tools: [],
    approval: false,
    cwd: "",
    timeout: 300,
    model: "",
    prompt: "",
    postRoot: "",
    publishCmd: "",
    engine: "claude",
    sandbox: "read-only",
    schedule: "",
    scheduleMessage: "",
    beforeRun: "",
    logCmd: "",
    search: false,
    notesMax: 30,
    ...over,
  };
}

export function expandUser(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function parse(text: string, name: string): Agent {
  const meta: Record<string, string> = {};
  let body = text;
  if (text.startsWith("---")) {
    const end = text.indexOf("---", 3);
    if (end >= 0) {
      for (const line of text.slice(3, end).split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i >= 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      body = text.slice(end + 3);
    }
  }
  const engine = (meta.engine ?? "claude").toLowerCase();
  if (!(ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`agents/${name}.md: engine must be one of ${ENGINES.join(", ")} (got '${engine}')`);
  }
  const sandbox = (meta.sandbox ?? "read-only").toLowerCase();
  if (!(SANDBOXES as readonly string[]).includes(sandbox)) {
    throw new Error(`agents/${name}.md: sandbox must be one of ${SANDBOXES.join(", ")} (got '${sandbox}')`);
  }
  const schedule = meta.schedule ?? "";
  if (schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule)) {
    throw new Error(`agents/${name}.md: schedule must be a 24-hour time like 21:00 (got '${schedule}')`);
  }
  const notesMax = meta.notes_max === undefined ? 30 : Number(meta.notes_max);
  if (!Number.isInteger(notesMax) || notesMax < 1 || notesMax > 2000) throw new Error(`agents/${name}.md: notes_max must be a whole number from 1 to 2000`);
  const timeout = meta.timeout === undefined ? 300 : Number(meta.timeout);
  if (!Number.isInteger(timeout)) throw new Error(`agents/${name}.md: timeout must be a whole number of seconds`);
  return makeAgent(name, {
    engine: engine as Agent["engine"],
    sandbox: sandbox as Agent["sandbox"],
    schedule,
    scheduleMessage: meta.schedule_message || (schedule ? "Run your daily check." : ""),
    beforeRun: meta.before_run ?? "",
    logCmd: meta.log_cmd ?? "",
    search: (meta.search ?? "false").toLowerCase() === "true",
    notesMax,
    title: meta.title ?? name.charAt(0).toUpperCase() + name.slice(1),
    goal: meta.goal ?? "",
    tools: (meta.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    approval: (meta.approval ?? "false").toLowerCase() === "true",
    cwd: meta.cwd ? expandUser(meta.cwd) : "",
    timeout,
    model: meta.model ?? "",
    postRoot: meta.post_root ? expandUser(meta.post_root) : "",
    publishCmd: meta.publish_cmd ?? "",
    prompt: body.trim(),
  });
}

/** First run: when `directory` has no agent files, copy the example agents into it. Returns how many were copied.
 *  Existing files are never overwritten, and a folder that already has agents is left exactly as it is. */
export function seedExamples(directory: string, examples: string): number {
  if (!isDir(examples)) return 0;
  if (isDir(directory) && fs.readdirSync(directory).some((f) => f.endsWith(".md"))) return 0;
  fs.mkdirSync(directory, { recursive: true });
  let copied = 0;
  for (const file of fs.readdirSync(examples).filter((f) => f.endsWith(".md")).sort()) {
    const dest = path.join(directory, file);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, fs.readFileSync(path.join(examples, file), "utf8"));
      copied += 1;
    }
  }
  return copied;
}

/** Return {name: Agent}, with 'manager' first when present. */
export function loadAgents(directory: string): Map<string, Agent> {
  const found = new Map<string, Agent>();
  if (isDir(directory)) {
    for (const file of fs.readdirSync(directory).filter((f) => f.endsWith(".md")).sort()) {
      const name = file.slice(0, -3);
      found.set(name, parse(fs.readFileSync(path.join(directory, file), "utf8"), name));
    }
  }
  const ordered = new Map<string, Agent>();
  const manager = found.get("manager");
  if (manager) {
    ordered.set("manager", manager);
    found.delete("manager");
  }
  for (const [name, agent] of found) ordered.set(name, agent);
  return ordered;
}

// ---- agents made in the app ------------------------------------------------------------

/** Collapse whitespace to one line (a newline would add front-matter keys) and drop the --- fence marker. */
export function oneLine(value: unknown, limit: number): string {
  return String(value ?? "").split(/\s+/).filter(Boolean).join(" ").replaceAll("---", "-").slice(0, limit);
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/^-+|-+$/g, "");
}

/** Check what the New agent form sent. Returns [Agent, file text]; throws Error with a plain message. */
export function agentFromForm(spec: any, taken: Iterable<string> = []): [Agent, string] {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("expected an object");
  const title = oneLine(spec.title, 40);
  const name = slugify(title);
  if (!name) throw new Error("Give the agent a name (letters or numbers).");
  if (RESERVED_NAMES.has(name) || new Set(taken).has(name)) throw new Error(`There is already an agent called “${name}”. Pick another name.`);
  const prompt = String(spec.prompt ?? "").trim();
  if (prompt.length < 10) throw new Error("Write the instructions: what should this agent do?");
  if (prompt.length > MAX_PROMPT) throw new Error(`The instructions are too long (limit ${MAX_PROMPT} characters).`);
  const engine = String(spec.engine || "claude").toLowerCase();
  if (!(ENGINES as readonly string[]).includes(engine)) throw new Error("Engine must be Claude or Codex.");

  const lines = [`title: ${title}`, `goal: ${oneLine(spec.goal, 200)}`];
  if (engine === "claude") {
    const model = String(spec.model || "sonnet").toLowerCase();
    if (!(FORM_MODELS as readonly string[]).includes(model)) throw new Error("Model must be Sonnet or Haiku.");
    const tools: unknown[] = Array.isArray(spec.tools) ? spec.tools : ["Read", "Grep", "Glob"];
    const unknown = tools.filter((t) => !(String(t) in FORM_TOOLS));
    if (unknown.length) throw new Error("Tool not allowed from the form: " + unknown.map(String).join(", ").slice(0, 80));
    lines.push("tools: " + Object.keys(FORM_TOOLS).filter((t) => tools.includes(t)).join(", "), `model: ${model}`);
  } else {
    const model = oneLine(spec.model, 60);
    if (model && !/^[A-Za-z0-9._:-]+$/.test(model)) throw new Error("That model name has characters a model name cannot have.");
    const sandbox = String(spec.sandbox || "read-only").toLowerCase();
    if (!(SANDBOXES as readonly string[]).includes(sandbox)) throw new Error("Access must be read-only or edit files in the folder.");
    lines.push("engine: codex", `sandbox: ${sandbox}`, ...(model ? [`model: ${model}`] : []));
  }
  const cwd = oneLine(spec.cwd, 300);
  if (cwd) {
    if (!isDir(expandUser(cwd))) throw new Error(`That folder does not exist: ${cwd}`);
    lines.push(`cwd: ${cwd}`);
  }
  const timeout = spec.timeout === undefined || spec.timeout === null || spec.timeout === "" || spec.timeout === 0 ? 300 : Number(spec.timeout);
  if (!Number.isFinite(timeout)) throw new Error("Timeout must be a number of seconds.");
  lines.push(`approval: ${spec.approval ? "true" : "false"}`, `timeout: ${Math.max(30, Math.min(Math.trunc(timeout), 1800))}`);
  const text = "---\n" + lines.join("\n") + "\n---\n" + prompt + "\n";
  return [parse(text, name), text];
}
