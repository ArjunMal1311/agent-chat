import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { agentFromForm, loadAgents, parse, seedExamples } from "../src/main/agents/agents.ts";
import { tmp } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = path.join(ROOT, "examples", "agents");

describe("agent files", () => {
  test("front matter is parsed", () => {
    const a = parse("---\ntitle: Planner\ngoal: Plan\ntools: Read, Grep\napproval: true\ntimeout: 60\n---\nDo the job.", "planner");
    assert.equal(a.title, "Planner");
    assert.deepEqual(a.tools, ["Read", "Grep"]);
    assert.equal(a.approval, true);
    assert.equal(a.timeout, 60);
    assert.equal(a.prompt, "Do the job.");
  });

  test("a file without front matter still loads", () => {
    const a = parse("Just a prompt", "solo");
    assert.equal(a.name, "solo");
    assert.equal(a.prompt, "Just a prompt");
  });

  test("engine and sandbox default to claude and read-only", () => {
    const a = parse("---\ntitle: X\n---\nGo.", "x");
    assert.deepEqual([a.engine, a.sandbox], ["claude", "read-only"]);
    const b = parse("---\nengine: codex\nsandbox: workspace-write\n---\nGo.", "x");
    assert.deepEqual([b.engine, b.sandbox], ["codex", "workspace-write"]);
  });

  test("an unknown engine or sandbox is refused by name", () => {
    assert.throws(() => parse("---\nengine: gemini\n---\nGo.", "x"), /engine must be one of/);
    assert.throws(() => parse("---\nsandbox: anything-goes\n---\nGo.", "x"), /sandbox must be one of/);
  });

  test("a hand-written file may ask for full access (the form still may not, see agentFromForm below)", () => {
    const a = parse("---\nengine: codex\nsandbox: danger-full-access\n---\nGo.", "x");
    assert.equal(a.sandbox, "danger-full-access");
  });

  test("notes_max is read, defaults to 30 and must be a sane number", () => {
    assert.equal(parse("---\nnotes_max: 400\n---\nGo.", "x").notesMax, 400);
    assert.equal(parse("Go.", "x").notesMax, 30);
    for (const bad of ["0", "x", "5000", "1.5"]) assert.throws(() => parse(`---\nnotes_max: ${bad}\n---\nGo.`, "x"), /notes_max/);
  });

  test("search and log_cmd are read, and are off by default", () => {
    const a = parse("---\nengine: codex\nsearch: true\nlog_cmd: ./x dm-log\n---\nGo.", "x");
    assert.deepEqual([a.search, a.logCmd], [true, "./x dm-log"]);
    const b = parse("---\nengine: codex\n---\nGo.", "x");
    assert.deepEqual([b.search, b.logCmd], [false, ""]);
  });

  test("schedule, message and before_run are read", () => {
    const a = parse("---\nschedule: 21:00\n---\nGo.", "x");
    assert.deepEqual([a.schedule, a.scheduleMessage], ["21:00", "Run your daily check."]);
    assert.equal(parse("---\nschedule: 08:30\nschedule_message: Good morning\n---\nGo.", "x").scheduleMessage, "Good morning");
    assert.deepEqual([parse("---\ntitle: X\n---\nGo.", "x").schedule, parse("---\ntitle: X\n---\nGo.", "x").scheduleMessage], ["", ""]);
    assert.equal(parse("---\nbefore_run: ./sync --x\n---\nGo.", "x").beforeRun, "./sync --x");
    for (const bad of ["9pm", "25:00", "21:60", "9:00"]) assert.throws(() => parse(`---\nschedule: ${bad}\n---\nGo.`, "x"), /schedule must be/, bad);
  });

  test("loadAgents puts the manager first and ignores other files", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.md"), "---\ntitle: A\n---\nx");
    fs.writeFileSync(path.join(dir, "manager.md"), "---\ntitle: M\n---\nx");
    fs.writeFileSync(path.join(dir, "notes.txt"), "no");
    assert.deepEqual([...loadAgents(dir).keys()], ["manager", "a"]);
  });
});

describe("example agents", () => {
  test("every example parses and the manager is there", () => {
    const agents = loadAgents(EXAMPLES);
    assert.ok(agents.has("manager"));
    assert.ok(agents.size >= 5);
    for (const a of agents.values()) assert.ok(a.title && a.goal && a.prompt, a.name);
  });

  test("the plain examples cannot run commands or publish", () => {
    const agents = loadAgents(EXAMPLES);
    for (const name of ["planner", "reviewer", "researcher", "writer"]) {
      const a = agents.get(name)!;
      assert.deepEqual(a.tools.filter((t) => t.startsWith("Bash")), [], name);
      assert.deepEqual([a.publishCmd, a.postRoot], ["", ""], name);
    }
    assert.equal(agents.get("codex-helper")!.sandbox, "read-only");
    const daily = agents.get("daily-check")!;
    assert.equal(daily.schedule, "18:00");
    assert.ok(daily.beforeRun.startsWith("git log"));
  });

  test("an empty or missing folder gets the examples; a folder with agents is left alone", () => {
    const target = path.join(tmp(), "agents");
    assert.equal(seedExamples(target, EXAMPLES), fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".md")).length);
    assert.ok(loadAgents(target).has("manager"));
    const mine = tmp();
    fs.writeFileSync(path.join(mine, "mine.md"), "---\ntitle: Mine\n---\nHi");
    assert.equal(seedExamples(mine, EXAMPLES), 0);
    assert.deepEqual(fs.readdirSync(mine), ["mine.md"]);
    assert.equal(seedExamples(path.join(tmp(), "a"), path.join(tmp(), "nope")), 0);
  });

  test("no shipped file names a personal agent, account or path", () => {
    const personal = ["ground" + "rules", "fly" + "tdev", "fyre" + "dev", "oot" + "to", "socials" + "-instagram", "/home/" + "atg", "dm-" + "targeter", "reel-" + "doctor"];
    const skip = new Set([".git", "node_modules", "data", "agents", "__pycache__", "out", "dist"]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!/\.(png|ico|jpg|db|pyc|lock)$/i.test(entry.name) && !entry.name.includes("package-lock") && entry.name !== "agents.test.ts") {
          let text = "";
          try {
            text = fs.readFileSync(full, "utf8").toLowerCase();
          } catch {
            continue;
          }
          for (const word of personal) if (text.includes(word)) hits.push(`${path.relative(ROOT, full)}: ${word}`);
        }
      }
    };
    walk(ROOT);
    assert.deepEqual(hits, []);
  });
});

describe("the New agent form", () => {
  const spec = (over: Record<string, unknown> = {}) => ({ title: "Daily Brief", goal: "Brief me", prompt: "Summarise the notes in the folder.", ...over });

  test("a claude agent gets sonnet and read-only tools by default", () => {
    const [agent, text] = agentFromForm(spec());
    assert.equal(agent.name, "daily-brief");
    assert.deepEqual(agent.tools, ["Read", "Grep", "Glob"]);
    assert.equal(agent.model, "sonnet");
    assert.match(text, /^---\ntitle: Daily Brief\n/);
  });

  test("a codex agent gets its sandbox and no tools line", () => {
    const [agent, text] = agentFromForm(spec({ engine: "codex", sandbox: "workspace-write" }));
    assert.deepEqual([agent.engine, agent.sandbox, agent.tools], ["codex", "workspace-write", []]);
    assert.ok(!text.includes("tools:"));
  });

  test("what the form must not allow is refused", () => {
    assert.throws(() => agentFromForm(spec({ tools: ["Read", "Bash"] })), /Tool not allowed/);
    assert.throws(() => agentFromForm(spec({ model: "opus" })), /Sonnet or Haiku/);
    assert.throws(() => agentFromForm(spec({ prompt: "short" })), /instructions/);
    assert.throws(() => agentFromForm(spec({ title: "   " })), /name/);
    assert.throws(() => agentFromForm(spec({ title: "Manager" })), /already an agent/);
    assert.throws(() => agentFromForm(spec({ engine: "codex", sandbox: "danger-full-access" })), /Access must be/);
    assert.throws(() => agentFromForm(spec({ cwd: "/definitely/not/a/folder" })), /does not exist/);
    assert.throws(() => agentFromForm("nope"), /expected an object/);
  });

  test("the form cannot set post, publish, schedule or before_run fields", () => {
    const [agent] = agentFromForm(spec({ post_root: "/tmp", publish_cmd: "rm -rf /", before_run: "x", schedule: "10:00" }));
    assert.deepEqual([agent.postRoot, agent.publishCmd, agent.beforeRun, agent.schedule], ["", "", "", ""]);
  });

  test("newlines and fences in one-line fields cannot add settings", () => {
    const [agent] = agentFromForm(spec({ goal: "Brief\npublish_cmd: evil\n---\nmore" }));
    assert.equal(agent.publishCmd, "");
    assert.ok(!agent.goal.includes("\n"));
  });

  test("a taken name is refused", () => {
    assert.throws(() => agentFromForm(spec(), ["daily-brief"]), /already an agent/);
  });
});
