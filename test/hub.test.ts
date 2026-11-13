import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { makeAgent } from "../src/main/agents/agents.ts";
import { normalizeLimits, parseJsonObject, shellSplit } from "../src/main/hub/hub.ts";
import type { Callbacks, RunResult } from "../src/main/runner/runner.ts";
import { defaultAgents, makeHub, tmp, waitFor } from "./helpers.ts";

const usageOf = (over = {}) => ({ model: "claude-sonnet-5-5", cost: 0.155, in: 62190, out: 6, seconds: 3.3, cache_read: 23971, cache_write: 38219, cache_ttl: 3600, ...over });
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const old = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = old;
  }
};

describe("helpers", () => {
  test("a json object is found inside chatter", () => {
    assert.deepEqual(parseJsonObject('Sure! {"agent": "planner", "task": "x"} done'), { agent: "planner", task: "x" });
    assert.equal(parseJsonObject("no json here"), null);
    assert.equal(parseJsonObject("{broken"), null);
  });

  test("shellSplit groups quoted words", () => {
    assert.deepEqual(shellSplit(`./run "a b" 'c d' e\\ f {dir}`), ["./run", "a b", "c d", "e f", "{dir}"]);
    assert.throws(() => shellSplit('"open'));
  });

  test("a limits report is normalised and survives odd shapes", () => {
    const w = normalizeLimits({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 9, status: "allowed" } } });
    assert.deepEqual(w.five_hour, { used: 0.5, resets_at: 9, status: "allowed" });
    assert.deepEqual(normalizeLimits({ rateLimitType: "seven_day", utilization: 0.2 }).seven_day.used, 0.2);
    assert.deepEqual(normalizeLimits("text"), {});
    assert.deepEqual(normalizeLimits({ unifiedWindows: "x" }), {});
  });
});

describe("chat turns", () => {
  test("a message runs the agent and stores the reply", async () => {
    const hub = makeHub(async () => "here is your list");
    hub.send("planner", "plan my day");
    await hub.settle();
    assert.equal(hub.store.last("planner")!.body, "here is your list");
    assert.deepEqual(hub.store.working("planner"), [false, ""]);
  });

  test("usage from the runner is stored with the reply", async () => {
    const hub = makeHub(async () => ({ text: "answer", usage: usageOf() }) as RunResult);
    hub.send("planner", "q");
    await hub.settle();
    assert.equal(hub.store.last("planner")!.meta!.cost, 0.155);
    assert.equal(hub.store.usage("planner").runs, 1);
  });

  test("steps are live while working and kept with the reply, but a steps-only reply is not a counted run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = makeHub(async (_a, _p, cb?: Callbacks) => {
      cb!.onStep!("Reading a/b.md");
      await gate;
      return "done";
    });
    hub.send("planner", "q");
    assert.ok(await waitFor(() => hub.liveSteps("planner").length === 1));
    assert.deepEqual(hub.store.working("planner"), [true, "Reading a/b.md"]);
    release();
    await hub.settle();
    assert.deepEqual(hub.store.last("planner")!.meta!.steps, ["Reading a/b.md"]);
    assert.equal(hub.store.usage("planner").runs, 0);
    assert.deepEqual(hub.liveSteps("planner"), []);
  });

  test("REMEMBER lines are saved, hidden, given back next time, and capped", async () => {
    const seen: string[] = [];
    const hub = makeHub(async (_a, prompt) => {
      seen.push(prompt);
      return seen.length === 1 ? "Answer\nREMEMBER: use lowercase" : "ok";
    });
    hub.send("planner", "first");
    await hub.settle();
    assert.equal(hub.store.last("planner")!.body, "Answer");
    assert.match(fs.readFileSync(path.join(hub.memoryDir, "planner.md"), "utf8"), /use lowercase/);
    hub.send("planner", "second");
    await hub.settle();
    assert.match(seen[1], /use lowercase/);
    const many = makeHub(async () => Array.from({ length: 40 }, (_, i) => `REMEMBER: note ${i}`).join("\n") + "\nbody");
    many.send("planner", "x");
    await many.settle();
    assert.equal(many.notesCount("planner"), 30);
    assert.match(fs.readFileSync(path.join(many.memoryDir, "planner.md"), "utf8"), /note 39/);
  });

  test("a before_run command's output is shown to the agent", async () => {
    const seen: string[] = [];
    const hub = makeHub(async (_a, prompt) => (seen.push(prompt), "ok"));
    hub.agents.get("planner")!.beforeRun = "echo synced-3-reels";
    hub.send("planner", "check today");
    await hub.settle();
    assert.match(seen[0], /synced-3-reels/);
    assert.match(seen[0], /It worked/);
  });

  test("a failing before_run is reported and the agent still runs", async () => {
    const seen: string[] = [];
    const hub = makeHub(async (_a, prompt) => (seen.push(prompt), "ok"));
    hub.agents.get("planner")!.beforeRun = "false";
    hub.send("planner", "check today");
    await hub.settle();
    assert.match(seen[0], /FAILED \(exit 1\)/);
    assert.equal(hub.store.last("planner")!.body, "ok");
  });

  describe("/sent and /reply", () => {
    const DRAFTS =
      "**Today's DMs: 2 of 8**\n\n1. **@corecodevibes** · 4.9k followers\nReel: \"x\" · https://i/p/1/\nDM: hey steffen, saw your reel on x. would you try it?\nWhy: fits\n\n" +
      "2. **@arnitly** · 49.9k followers\nReel: \"y\"\nDM: hey arnav, saw your reel on y. would you try it?\nWhy: fits\n";
    const setup = (output = "RESULT: ok") => {
      const calls: string[][] = [];
      const ran: string[] = [];
      const hub = makeHub(async (_a, prompt) => (ran.push(prompt), "model answer"), {
        poster: async (argv) => (calls.push(argv), [0, "noise from the db\n" + output + "\n"]),
      });
      hub.agents.get("planner")!.logCmd = "./tool dm-log";
      hub.store.add("planner", "planner", DRAFTS);
      return { hub, calls, ran };
    };

    test("/sent logs each drafted DM by code, and the model is not called", async () => {
      const { hub, calls, ran } = setup();
      hub.send("planner", "/sent @corecodevibes arnitly");
      await hub.settle();
      assert.deepEqual(calls, [
        ["./tool", "dm-log", "sent", "corecodevibes", "--text", "hey steffen, saw your reel on x. would you try it?"],
        ["./tool", "dm-log", "sent", "arnitly", "--text", "hey arnav, saw your reel on y. would you try it?"],
      ]);
      assert.equal(ran.length, 0);
      assert.equal(hub.store.last("planner")!.body, "ok\nok"); // only the RESULT lines, not the noise
    });

    test("a draft whose text starts on the line after DM: is found too", async () => {
      const { hub, calls } = setup();
      hub.store.add("planner", "planner", "1. **@newperson** · 3k followers\nReel: \"z\"\nDM:  \nhey sam, saw your reel on z. would you try it?  \nWhy: fits\n");
      hub.send("planner", "/sent newperson");
      await hub.settle();
      assert.deepEqual(calls[0].slice(2), ["sent", "newperson", "--text", "hey sam, saw your reel on z. would you try it?"]);
    });

    test("/sent @a | text logs what was really sent, for one handle", async () => {
      const { hub, calls } = setup();
      hub.send("planner", "/sent @corecodevibes | hey steffen, my own words | with a pipe");
      await hub.settle();
      assert.deepEqual(calls[0].slice(3), ["corecodevibes", "--text", "hey steffen, my own words | with a pipe"]);
      hub.send("planner", "/sent @a @b | text");
      await hub.settle();
      assert.equal(calls.length, 1);
      assert.match(hub.store.last("planner")!.body, /exactly one handle/);
    });

    test("/reply needs one handle and the words, and logs them", async () => {
      const { hub, calls } = setup();
      hub.send("planner", "/reply @arnitly");
      await hub.settle();
      assert.equal(calls.length, 0);
      hub.send("planner", "/reply @arnitly | sure, send it");
      await hub.settle();
      assert.deepEqual(calls[0].slice(2), ["reply", "arnitly", "--text", "sure, send it"]);
    });

    test("a person with no draft in the chat is not logged, and bad handles are refused", async () => {
      const { hub, calls } = setup();
      hub.send("planner", "/sent @someoneelse");
      await hub.settle();
      assert.equal(calls.length, 0);
      assert.match(hub.store.last("planner")!.body, /no draft/);
      hub.send("planner", "/sent @bad;worse");
      await hub.settle();
      assert.equal(calls.length, 0);
      assert.match(hub.store.last("planner")!.body, /could not read the handles/);
    });

    test("a failing log command is reported, never hidden", async () => {
      const hub = makeHub(async () => "x", { poster: async () => [1, "Traceback: boom"] });
      hub.agents.get("planner")!.logCmd = "./tool dm-log";
      hub.store.add("planner", "planner", DRAFTS);
      hub.send("planner", "/sent @arnitly");
      await hub.settle();
      assert.match(hub.store.last("planner")!.body, /failed \(exit 1\)/);
    });

    test("without log_cmd the message is just a message for the agent", async () => {
      const ran: string[] = [];
      const hub = makeHub(async (_a, prompt) => (ran.push(prompt), "ok"));
      hub.send("planner", "/sent @arnitly");
      await hub.settle();
      assert.equal(ran.length, 1);
    });
  });

  test("an agent with a higher notes_max keeps more notes than the default 30", async () => {
    const notes = Array.from({ length: 50 }, (_, i) => `REMEMBER: scouted company${i}`).join("\n");
    const hub = makeHub(async () => "done\n" + notes);
    hub.agents.get("planner")!.notesMax = 100;
    hub.send("planner", "go");
    await hub.settle();
    assert.equal(hub.notesCount("planner"), 50);
    const small = makeHub(async () => "done\n" + notes);
    small.send("planner", "go");
    await small.settle();
    assert.equal(small.notesCount("planner"), 30);
  });

  test("a runner error is shown in the chat", async () => {
    const hub = makeHub(async () => {
      throw new Error("claude is down");
    });
    await quiet(async () => {
      hub.send("planner", "q");
      await hub.settle();
    });
    assert.match(hub.store.last("planner")!.body, /Could not finish: claude is down/);
    assert.deepEqual(hub.store.working("planner"), [false, ""]);
  });

  test("a second request while busy gets a polite reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = makeHub(async () => (await gate, "first answer"));
    hub.send("planner", "one");
    assert.ok(await waitFor(() => hub.store.working("planner")[0]));
    hub.send("planner", "two");
    assert.ok(await waitFor(() => /still working/.test(hub.store.last("planner")!.body)));
    release();
    await hub.settle();
    assert.ok(hub.store.messages("planner").some((m) => m.body === "first answer"));
  });

  test("unknown chats and empty text are rejected", () => {
    const hub = makeHub(async () => "x");
    assert.throws(() => hub.send("nobody", "hi"), /unknown chat/);
    assert.throws(() => hub.send("planner", "   "), /empty message/);
  });
});

describe("approvals, clearing and compacting", () => {
  test("the approval flow", async () => {
    const hub = makeHub(async () => "draft dm");
    hub.send("writer", "draft");
    await hub.settle();
    const draft = hub.store.last("writer")!;
    assert.deepEqual([draft.kind, draft.status], ["approval", "pending"]);
    hub.approve(draft.id, "approved");
    assert.equal(hub.store.message(draft.id)!.status, "approved");
    assert.match(hub.store.last("writer")!.body, /Nothing is sent automatically/);
    assert.throws(() => hub.approve(draft.id, "approved"), /not waiting/);
  });

  test("clear chat and forget notes", async () => {
    const hub = makeHub(async () => "ok\nREMEMBER: a note");
    hub.send("planner", "q");
    await hub.settle();
    hub.forgetNotes("planner");
    assert.equal(hub.notesCount("planner"), 0);
    assert.equal(hub.store.count("planner"), 2);
    assert.equal(hub.clearChat("planner"), 2);
    assert.equal(hub.store.count("planner"), 0);
    assert.throws(() => hub.clearChat("nobody"), /unknown chat/);
  });

  test("clearing is refused while the agent is working", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = makeHub(async () => (await gate, "x"));
    hub.send("planner", "q");
    assert.ok(await waitFor(() => hub.store.working("planner")[0]));
    assert.throws(() => hub.clearChat("planner"), /working right now/);
    release();
    await hub.settle();
  });

  test("compact replaces the history with a summary the agent keeps using", async () => {
    const seen: string[] = [];
    const hub = makeHub(async (agent, prompt) => {
      seen.push(prompt);
      return agent.title === "Compact" ? { text: "- likes short answers", usage: usageOf() } : "reply";
    });
    for (let i = 0; i < 3; i++) {
      hub.send("planner", `q${i}`);
      await hub.settle();
    }
    hub.compactChat("planner");
    await hub.settle();
    assert.equal(hub.store.messages("planner").length, 1);
    assert.match(hub.store.last("planner")!.body, /Compacted 6 messages/);
    assert.match(hub.summaryOf("planner"), /short answers/);
    hub.send("planner", "next");
    await hub.settle();
    assert.match(seen.at(-1)!, /likes short answers/);
  });

  test("compact is refused when short, busy, pending or unknown", async () => {
    const hub = makeHub(async () => "draft");
    assert.throws(() => hub.compactChat("planner"), /too short/);
    assert.throws(() => hub.compactChat("nobody"), /unknown chat/);
    for (let i = 0; i < 3; i++) {
      hub.send("writer", `q${i}`);
      await hub.settle();
    }
    assert.throws(() => hub.compactChat("writer"), /approve or decline/);
  });

  test("a failed compaction changes nothing", async () => {
    const hub = makeHub(async (agent) => {
      if (agent.title === "Compact") throw new Error("no model");
      return "reply";
    });
    for (let i = 0; i < 3; i++) {
      hub.send("planner", `q${i}`);
      await hub.settle();
    }
    await quiet(async () => {
      hub.compactChat("planner");
      await hub.settle();
    });
    assert.equal(hub.store.count("planner"), 6);
    assert.match(hub.store.last("planner")!.body, /Could not compact: no model/);
    assert.equal(hub.summaryOf("planner"), "");
  });
});

describe("access level from the chat's button", () => {
  const withCodex = (seen: string[]) =>
    makeHub(
      async (agent) => {
        seen.push(agent.sandbox);
        return "ok";
      },
      { agents: new Map([...defaultAgents(), ["doctor", makeAgent("doctor", { title: "Doctor", engine: "codex", sandbox: "read-only" })]]) },
    );

  test("a picked level applies to the next run and survives in the store", async () => {
    const seen: string[] = [];
    const hub = withCodex(seen);
    assert.equal(hub.accessOf("doctor"), "read-only");
    hub.setAccess("doctor", "danger-full-access");
    assert.equal(hub.accessOf("doctor"), "danger-full-access");
    hub.send("doctor", "hi");
    await hub.settle();
    assert.deepEqual(seen, ["danger-full-access"]);
    hub.setAccess("doctor", "read-only");
    hub.send("doctor", "again");
    await hub.settle();
    assert.deepEqual(seen, ["danger-full-access", "read-only"]);
  });

  test("only Codex agents, known chats and known levels are accepted", () => {
    const hub = withCodex([]);
    assert.throws(() => hub.setAccess("planner", "workspace-write"), /access must be one of read-only, danger-full-access/);
    hub.setAccess("planner", "danger-full-access"); // a Claude chat may be given full access (every tool)
    assert.equal(hub.accessOf("planner"), "danger-full-access");
    assert.throws(() => hub.setAccess("nobody", "read-only"), /unknown chat/);
    assert.throws(() => hub.setAccess("doctor", "anything-goes"), /access must be one of/);
    assert.equal(hub.accessOf("doctor"), "read-only");
  });
});

describe("model from the chat's dropdown", () => {
  /** A fake Codex home with two visible models, one hidden, and a config default; CODEX_HOME points at it. */
  const withCodexHome = (fn: () => void | Promise<void>) => async () => {
    const home = tmp("codex-");
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "m-one", display_name: "M One", visibility: "list" }, { slug: "m-two", visibility: "list" }, { slug: "m-hidden", visibility: "hide" }] }),
    );
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "m-one"\nmodel_reasoning_effort = "medium"\n');
    const old = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      await fn();
    } finally {
      if (old === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = old;
    }
  };
  const seenBy = (seen: { engine: string; model: string; sandbox: string; tools: string[] }[], extra: Parameters<typeof makeAgent>[1] = {}) =>
    makeHub(
      async (agent) => {
        seen.push({ engine: agent.engine, model: agent.model, sandbox: agent.sandbox, tools: agent.tools });
        return "ok";
      },
      { agents: new Map([...defaultAgents(), ["doctor", makeAgent("doctor", { title: "Doctor", engine: "codex", sandbox: "read-only", ...extra })]]) },
    );

  test("the dropdown lists Claude's models, then only the models Codex says are visible", withCodexHome(() => {
    const hub = seenBy([]);
    assert.deepEqual(hub.modelChoices().map((c) => c.id), ["claude:sonnet", "claude:haiku", "claude:opus", "codex:m-one", "codex:m-two"]);
    assert.deepEqual(hub.modelChoices().map((c) => c.engine), ["claude", "claude", "claude", "codex", "codex"]);
  }));

  test("a picked model applies to the next run; empty goes back to the file's choice", withCodexHome(async () => {
    const seen: { engine: string; model: string; sandbox: string; tools: string[] }[] = [];
    const hub = makeHub(async (agent) => {
      seen.push({ engine: agent.engine, model: agent.model, sandbox: agent.sandbox, tools: agent.tools });
      return "ok";
    }, { agents: new Map([...defaultAgents(), ["planner", makeAgent("planner", { title: "Planner", model: "haiku", tools: ["Read"] })]]) });
    assert.equal(hub.modelOf("planner"), "haiku");
    hub.setModel("planner", "claude:opus");
    assert.deepEqual([hub.pickedModel("planner"), hub.modelOf("planner"), hub.engineOf("planner")], ["claude:opus", "opus", "claude"]);
    hub.send("planner", "hi");
    await hub.settle();
    hub.setModel("planner", "");
    hub.send("planner", "again");
    await hub.settle();
    assert.deepEqual(seen.map((s) => [s.engine, s.model]), [["claude", "opus"], ["claude", "haiku"]]);
  }));

  test("picking a model from the other family switches the program, and back again", withCodexHome(async () => {
    const seen: { engine: string; model: string; sandbox: string; tools: string[] }[] = [];
    const hub = seenBy(seen);
    hub.setAccess("doctor", "danger-full-access");
    hub.setModel("doctor", "claude:sonnet");
    assert.equal(hub.engineOf("doctor"), "claude");
    assert.throws(() => hub.setAccess("doctor", "workspace-write"), /access must be one of read-only, danger-full-access/);
    assert.equal(hub.codexInUse(), false, "no chat runs on Codex now");
    hub.send("doctor", "on claude");
    await hub.settle();
    hub.setModel("doctor", "codex:m-two");
    assert.equal(hub.codexInUse(), true);
    hub.send("doctor", "on codex");
    await hub.settle();
    assert.deepEqual(seen[0], { engine: "claude", model: "sonnet", sandbox: "danger-full-access", tools: ["Read", "Grep", "Glob"] }); // the saved full access follows the chat to Claude (runClaude turns it into every tool)
    assert.deepEqual(seen[1], { engine: "codex", model: "m-two", sandbox: "danger-full-access", tools: [] });
  }));

  test("a Codex chat with no pick shows Codex's configured default but runs without naming a model", withCodexHome(() => {
    const hub = seenBy([]);
    assert.equal(hub.shownModel("doctor"), "m-one");
    assert.equal(hub.modelOf("doctor"), "");
  }));

  test("unknown chats and models outside the list are refused; an old bare pick is ignored", withCodexHome(() => {
    const hub = seenBy([]);
    assert.throws(() => hub.setModel("nobody", "claude:opus"), /unknown chat/);
    assert.throws(() => hub.setModel("planner", "opus; rm -rf /"), /not one of the models/);
    assert.throws(() => hub.setModel("doctor", "codex:m-hidden"), /not one of the models/);
    assert.equal(hub.pickedModel("planner"), "");
    hub.store.setJson("model:doctor", "sonnet"); // what an older build saved
    assert.deepEqual([hub.pickedModel("doctor"), hub.engineOf("doctor")], ["", "codex"]);
  }));
});

describe("agents handing work to each other", () => {
  /** A hub whose agents answer from a script keyed by agent name; records every prompt it was given. */
  const scripted = (answers: Record<string, string>, agents = defaultAgents()) => {
    const prompts: Record<string, string[]> = {};
    const hub = makeHub(async (agent, prompt) => {
      (prompts[agent.name] ||= []).push(prompt);
      return answers[agent.name] ?? "ok";
    }, { agents });
    return { hub, prompts };
  };
  const bodies = (hub: ReturnType<typeof makeHub>, chat: string) => hub.store.messages(chat).map((m) => `${m.sender}: ${m.body}`);

  test("every agent is told who else it can hand work to, but not itself or the Manager", async () => {
    const { hub, prompts } = scripted({});
    hub.send("planner", "hi");
    await hub.settle();
    const prompt = prompts.planner[0];
    assert.match(prompt, /Other agents you can hand work to/);
    assert.match(prompt, /- writer: Writer/);
    assert.doesNotMatch(prompt, /- planner:/);
    assert.doesNotMatch(prompt, /- manager:/);
    assert.match(prompt, /HANDOFF: <name> \| <the task/);
  });

  test("a HANDOFF line runs the other agent and a note with its answer comes back", async () => {
    const { hub, prompts } = scripted({ planner: "On it.\nHANDOFF: writer | draft a post about reels", writer: "Here is the draft" });
    hub.send("planner", "go");
    await hub.settle();
    const planner = bodies(hub, "planner");
    assert.ok(planner.includes("planner: On it."), "the HANDOFF line is not shown");
    assert.ok(planner.some((b) => b.startsWith("planner: Handed to Writer: draft a post about reels")));
    assert.ok(planner.some((b) => b.startsWith("writer: Writer answered:") && b.includes("Here is the draft") && b.includes("This is a draft")), "writer is an approval agent");
    const writer = bodies(hub, "writer");
    assert.equal(writer[0], "planner: From Planner: draft a post about reels");
    assert.match(prompts.writer[0], /Request:\nFrom Planner: draft a post about reels/);
    assert.equal(hub.store.last("writer")!.kind, "approval", "its answer is still a draft for you to approve");
  });

  test("nothing loops: the agent that asked is not callable from the chain, and the caller is not run again", async () => {
    const { hub, prompts } = scripted({ planner: "HANDOFF: writer | do it", writer: "done\nHANDOFF: planner | and again" });
    hub.send("planner", "go");
    await hub.settle();
    assert.equal(prompts.planner.length, 1, "planner ran once");
    assert.doesNotMatch(prompts.writer[0], /- planner:/);
    assert.ok(bodies(hub, "writer").some((b) => b.includes("Hand-off ignored") && b.includes("planner")));
    assert.ok(!bodies(hub, "writer").some((b) => b.includes("HANDOFF:")));
  });

  test("can_call limits who an agent may hand work to", async () => {
    const agents = defaultAgents();
    agents.set("planner", makeAgent("planner", { title: "Planner", canCall: [] }));
    const { hub, prompts } = scripted({ planner: "HANDOFF: writer | do it" }, agents);
    hub.send("planner", "go");
    await hub.settle();
    assert.doesNotMatch(prompts.planner[0], /Other agents you can hand work to/);
    assert.equal(hub.store.count("writer"), 0, "writer was never called");
    assert.ok(bodies(hub, "planner").some((b) => b.includes("Hand-off ignored")));
  });

  test("unknown agents and the Manager cannot be called; one agent once; the chain stops at two", async () => {
    const agents = new Map([...defaultAgents(), ["b", makeAgent("b", { title: "B" })], ["c", makeAgent("c", { title: "C" })], ["d", makeAgent("d", { title: "D" })]]);
    const { hub, prompts } = scripted(
      { planner: "HANDOFF: ghost | x\nHANDOFF: manager | y\nHANDOFF: b | one\nHANDOFF: b | two\nHANDOFF: c | three\nHANDOFF: d | four", b: "HANDOFF: d | from b", c: "HANDOFF: d | from c", d: "end" },
      agents,
    );
    hub.send("planner", "go");
    await hub.settle();
    assert.equal(hub.store.count("manager"), 0);
    assert.equal(prompts.b.length, 1, "b once, even though planner asked twice");
    assert.equal(prompts.c.length, 1, "at most two hand-offs per reply: b and c");
    assert.ok(!prompts.d || prompts.d.length <= 2, "d is only reached through b and c (chain of two), once each");
    for (const chat of ["b", "c"]) assert.ok(!bodies(hub, chat).some((b) => b.includes("HANDOFF:")));
    assert.doesNotMatch(prompts.d?.[0] ?? "", /Other agents you can hand work to/, "the third agent in a chain cannot hand work on");
  });
});

describe("publishing a draft", () => {
  function setup(poster = async (_argv: string[], _cwd: string): Promise<[number, string]> => [0, "POSTED: https://example.com/p/1\n"]) {
    const root = fs.realpathSync(tmp("posts-"));
    const folder = path.join(root, "p1");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "1.png"), "png");
    fs.writeFileSync(path.join(folder, "post.json"), JSON.stringify({ files: ["1.png"], caption: "hello", slides: ["a"] }));
    const calls: string[][] = [];
    const agents = defaultAgents();
    agents.set("poster", makeAgent("poster", { title: "Poster", postRoot: root, publishCmd: "./publish {dir}" }));
    const hub = makeHub(async () => `Here it is.\nPOST_READY: ${folder}`, {
      agents,
      poster: async (argv, cwd) => (calls.push(argv), poster(argv, cwd)),
    });
    return { hub, folder, calls, root };
  }

  test("a POST_READY answer becomes a postable draft and publishes only when approved", async () => {
    const { hub, folder, calls } = setup();
    hub.send("poster", "make it");
    await hub.settle();
    const draft = hub.store.last("poster")!;
    assert.equal(draft.kind, "approval");
    assert.equal(draft.body, "Here it is.");
    assert.equal(draft.meta!.post.dir, folder);
    assert.ok(hub.postImage(draft.id, 0));
    assert.equal(hub.postImage(draft.id, 5), null);
    assert.deepEqual(calls, []);
    hub.approve(draft.id, "approved");
    await hub.settle();
    assert.deepEqual(calls, [["./publish", folder]]);
    assert.match(hub.store.last("poster")!.body, /Published: https:\/\/example.com\/p\/1/);
  });

  test("declining never publishes, and a failed publish says so", async () => {
    const { hub, calls } = setup();
    hub.send("poster", "make it");
    await hub.settle();
    hub.approve(hub.store.last("poster")!.id, "declined");
    await hub.settle();
    assert.deepEqual(calls, []);
    const failing = setup(async () => [1, "boom\nno token"]);
    failing.hub.send("poster", "make it");
    await failing.hub.settle();
    failing.hub.approve(failing.hub.store.last("poster")!.id, "approved");
    await failing.hub.settle();
    assert.match(failing.hub.store.last("poster")!.body, /Could not publish[\s\S]*no token/);
  });

  test("a draft may sit one folder below the post root (root/<account>/<draft>), not two", async () => {
    const root = fs.realpathSync(tmp("posts-"));
    const make = (...parts: string[]) => {
      const folder = path.join(root, ...parts);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "1.png"), "png");
      fs.writeFileSync(path.join(folder, "post.json"), JSON.stringify({ files: ["1.png"], caption: "c" }));
      return folder;
    };
    const kindFor = async (folder: string) => {
      const agents = defaultAgents();
      agents.set("poster", makeAgent("poster", { postRoot: root, publishCmd: "./publish {dir}" }));
      const hub = makeHub(async () => `x\nPOST_READY: ${folder}`, { agents });
      hub.send("poster", "q");
      await hub.settle();
      const last = hub.store.last("poster")!;
      return [last.kind, last.kind === "approval" ? hub.postImage(last.id, 0) : null] as const;
    };
    const [kind, image] = await kindFor(make("main", "d1"));
    assert.equal(kind, "approval");
    assert.ok(image, "its slide can be shown");
    assert.equal((await kindFor(make("a", "b", "c")))[0], "text", "two folders down is refused");
    assert.equal((await kindFor(root))[0], "text", "the root itself is refused");
  });

  test("a folder outside the post root is not postable", async () => {
    const { hub, root } = setup();
    const outside = path.join(fs.realpathSync(tmp("elsewhere-")), "p");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "1.png"), "x");
    fs.writeFileSync(path.join(outside, "post.json"), JSON.stringify({ files: ["1.png"] }));
    const agents = defaultAgents();
    agents.set("poster", makeAgent("poster", { postRoot: root, publishCmd: "./publish {dir}" }));
    const hub2 = makeHub(async () => `x\nPOST_READY: ${outside}`, { agents });
    hub2.send("poster", "q");
    await hub2.settle();
    assert.equal(hub2.store.last("poster")!.kind, "text");
    assert.ok(hub);
  });
});

describe("the Manager", () => {
  const route = (agent: string, task: string) => JSON.stringify({ agent, task });

  test("it hands work to an agent, brings the answer back with a passing check", async () => {
    const hub = makeHub(async (agent, prompt) => {
      if (agent.name === "manager" && prompt.includes("Request:\nAgents you can hand")) return route("planner", "Plan the day");
      if (agent.name === "manager") return '{"verdict":"ok","summary":"Matches the task.","issues":[]}';
      return "1. Do the thing";
    });
    hub.send("manager", "plan my day");
    await hub.settle();
    const messages = hub.store.messages("manager");
    assert.match(messages[1].body, /Sending this to Planner: Plan the day/);
    const relay = messages.at(-1)!;
    assert.match(relay.body, /Planner answered:[\s\S]*1\. Do the thing[\s\S]*Check: looks fine\. Matches the task\./);
    assert.deepEqual([relay.meta!.relay.verdict, relay.meta!.relay.agent], ["ok", "planner"]);
    assert.equal(hub.store.messages("planner")[0].sender, "manager");
  });

  test("a bad answer lists the problems and offers to send it back", async () => {
    const hub = makeHub(async (agent) => {
      if (agent.name === "manager") return agent.prompt.includes("checking") ? '{"verdict":"fix","summary":"Invented a number.","issues":["It says 40 percent."]}' : route("planner", "t");
      return "Growth was 40 percent";
    });
    hub.send("manager", "q");
    await hub.settle();
    const relay = hub.store.last("manager")!;
    assert.match(relay.body, /Check: needs changes\. Invented a number\.\n- It says 40 percent\.[\s\S]*Say “fix it”/);
    assert.equal(relay.meta!.relay.verdict, "fix");
  });

  test("an unreadable check never hides the answer", async () => {
    const hub = makeHub(async (agent) => (agent.name === "manager" ? (agent.prompt.includes("checking") ? "not json" : route("planner", "t")) : "the answer"));
    hub.send("manager", "q");
    await hub.settle();
    const relay = hub.store.last("manager")!;
    assert.match(relay.body, /the answer[\s\S]*I could not check this answer/);
    assert.equal(relay.meta!.relay.verdict, "unchecked");
  });

  test("a failed agent is reported and not checked", async () => {
    let checks = 0;
    const hub = makeHub(async (agent) => {
      if (agent.name === "manager") return agent.prompt.includes("checking") ? (checks++, "{}") : route("planner", "t");
      throw new Error("agent crashed");
    });
    await quiet(async () => {
      hub.send("manager", "q");
      await hub.settle();
    });
    assert.match(hub.store.last("manager")!.body, /Planner could not finish\.[\s\S]*agent crashed/);
    assert.equal(checks, 0);
  });

  test("a draft is marked and still waits in the agent's chat", async () => {
    const hub = makeHub(async (agent) => {
      if (agent.name === "manager") return agent.prompt.includes("checking") ? '{"verdict":"ok","summary":"Fine.","issues":[]}' : route("writer", "draft a note");
      return "Dear team";
    });
    hub.send("manager", "q");
    await hub.settle();
    const relay = hub.store.last("manager")!;
    assert.match(relay.body, /This is a draft\. Approve or decline it in Writer's chat\./);
    assert.equal(relay.meta!.relay.draft, true);
    assert.equal(hub.store.last("writer")!.status, "pending");
  });

  test("it can answer itself and ignores unknown agents", async () => {
    const hub = makeHub(async () => '{"reply":"Ask the planner."}');
    hub.send("manager", "hi");
    await hub.settle();
    assert.equal(hub.store.last("manager")!.body, "Ask the planner.");
    const odd = makeHub(async () => route("ghost", "x"));
    odd.send("manager", "hi");
    await odd.settle();
    assert.equal(odd.store.count("ghost"), 0);
  });
});

describe("limits and new agents", () => {
  test("limits reported during a run are recorded and a partial report keeps the other window", async () => {
    const hub = makeHub(async (_a, _p, cb?: Callbacks) => (cb!.onLimits!({ unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1, status: "allowed" } } }), "ok"));
    hub.send("planner", "q");
    await hub.settle();
    hub.recordLimits({ unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: 2, status: "allowed" } } });
    assert.deepEqual(Object.keys(hub.limits().windows).sort(), ["five_hour", "seven_day"]);
  });

  test("refresh runs one cheap probe and records limits", async () => {
    const hub = makeHub(async (agent, _p, cb?: Callbacks) => {
      assert.equal(agent.name, "probe");
      cb!.onLimits!({ unifiedWindows: { five_hour: { utilization: 0.3, status: "allowed" } } });
      return { text: "ok", usage: usageOf() } as RunResult;
    });
    const usage = await hub.refreshLimits();
    assert.equal(usage.cost, 0.155);
    assert.equal(hub.limits().windows.five_hour.used, 0.3);
  });

  const codexHub = (reader: () => Promise<any>, runner = async () => "ok") => {
    const agents = defaultAgents();
    agents.set("coder", makeAgent("coder", { title: "Coder", engine: "codex" }));
    return makeHub(runner as any, { agents, codexReader: reader });
  };

  test("codex windows: nothing without a codex agent, saved on refresh, last good numbers kept on failure", async () => {
    assert.equal(makeHub(async () => "x").codexLimits(), null);
    let fail = false;
    const hub = codexHub(async () => {
      if (fail) throw new Error("not signed in");
      return { plan: "go", windows: [{ label: "30-day", used: 0.09, resets_at: 5, minutes: 43200 }] };
    });
    await hub.refreshCodexLimits();
    assert.equal(hub.codexLimits()!.windows[0].used, 0.09);
    fail = true;
    await hub.refreshCodexLimits();
    const saved = hub.codexLimits()!;
    assert.equal(saved.windows[0].used, 0.09);
    assert.match(saved.error, /not signed in/);
  });

  test("a recent check is not repeated, and a codex agent run refreshes afterwards while a claude run does not", async () => {
    let reads = 0;
    const hub = codexHub(async () => (reads++, { plan: "", windows: [{ label: "5-hour", used: 0.1, resets_at: null, minutes: 300 }] }));
    await hub.refreshCodexLimits();
    await hub.refreshCodexLimits(600);
    assert.equal(reads, 1);
    hub.send("planner", "q"); // a claude agent
    await hub.settle();
    assert.equal(reads, 1);
    reads = 0;
    const fresh = codexHub(async () => (reads++, { plan: "", windows: [] }));
    fresh.send("coder", "q");
    await fresh.settle();
    assert.equal(reads, 1);
  });

  test("a claude agent from the form is saved, loaded and offered at once; hand-offs see it", async () => {
    const dir = tmp("agents-");
    const hub = makeHub(async () => "x", { agentsDir: dir });
    const name = hub.createAgent({ title: "Notes Bot", goal: "Takes notes", prompt: "Summarise whatever the user pastes." });
    assert.equal(name, "notes-bot");
    assert.ok(fs.existsSync(path.join(dir, "notes-bot.md")));
    assert.ok(hub.agents.has("notes-bot"));
    assert.throws(() => hub.createAgent({ title: "Notes Bot", prompt: "Summarise whatever the user pastes." }), /already an agent/);
    fs.writeFileSync(path.join(dir, "taken.md"), "existing");
    assert.throws(() => hub.createAgent({ title: "Taken", prompt: "Summarise whatever the user pastes." }), /already an agent file/);
    assert.equal(fs.readFileSync(path.join(dir, "taken.md"), "utf8"), "existing");
    assert.equal(hub.agentOptions().enabled, true);
    assert.ok(hub.agentOptions().tools.some((t: any) => t.id === "Read"));
  });

  test("without a folder the form is off", () => {
    const hub = makeHub(async () => "x");
    assert.equal(hub.agentOptions().enabled, false);
    assert.throws(() => hub.createAgent({ title: "A B", prompt: "Do something useful." }), /not switched on/);
  });
});
