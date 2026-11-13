import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { makeAgent } from "../src/main/agents/agents.ts";
import { RunError, describeCodexEvent, describeEvent, describeTool, extractUsage, parseClaudeOutput, runAgent, runClaude, runCodex } from "../src/main/runner/runner.ts";
import { fakeCli, tmp, withPath } from "./helpers.ts";

const STREAM = `
out({type: "system", subtype: "hook_started"});
out("some hook noise");
out({type: "assistant", message: {content: [{type: "tool_use", name: "Read", input: {file_path: "/home/a/plans/gtm-plan.md"}}]}});
out({type: "user", message: {content: [{type: "tool_result", is_error: true, content: "boom   happened"}]}});
out({type: "assistant", message: {content: [{type: "tool_use", name: "Bash", input: {command: "./socials   utils x tracking ideas"}}]}});
out({type: "assistant", message: {content: [{type: "text", text: "final"}]}});
out({type: "result", subtype: "success", is_error: false, result: JSON.stringify(process.argv.slice(2)), total_cost_usd: 0.05, duration_ms: 1500, num_turns: 2,
  usage: {input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 9}, modelUsage: {"claude-sonnet-5-5": {}}});
`;

describe("describing steps", () => {
  test("tools are described in plain words", () => {
    assert.equal(describeTool("Read", { file_path: "/a/b/c.md" }), "Reading b/c.md");
    assert.equal(describeTool("Grep", { pattern: "x" }), "Searching for “x”");
    assert.equal(describeTool("Bash", { command: "ls   -la" }), "Running ls -la");
    assert.equal(describeTool("WebSearch", { query: "cats" }), "WebSearch cats");
    assert.equal(describeTool("Mystery", {}), "Using Mystery");
  });

  test("events become steps and most events become none", () => {
    assert.deepEqual(describeEvent({ type: "system" }), []);
    assert.deepEqual(describeEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), []);
    assert.deepEqual(describeEvent({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ text: "bad  thing" }] }] } }), ["That step failed: bad thing"]);
  });

  test("odd shapes do not crash", () => {
    assert.deepEqual(describeEvent({ type: "assistant", message: "text" }), []);
    assert.deepEqual(describeEvent(null), []);
    assert.deepEqual(describeEvent({ type: "assistant", message: { content: ["x", null, 5] } }), []);
    assert.deepEqual(describeCodexEvent({ type: "item.started", item: "oops" }), []);
    assert.deepEqual(describeCodexEvent({ type: "item.completed", item: { type: "file_change", changes: "nope" } }), ["Editing files"]);
    assert.equal(extractUsage({ usage: "x", modelUsage: "y" }).in, 0);
  });
});

describe("usage parsing", () => {
  test("usage is read from claude's JSON even with hook noise", () => {
    const out = 'hook noise\n{"result":"hi","total_cost_usd":0.155,"duration_ms":3289,"num_turns":1,"usage":{"input_tokens":2,"cache_creation_input_tokens":38219,"cache_read_input_tokens":23971,"output_tokens":6,"cache_creation":{"ephemeral_1h_input_tokens":38219,"ephemeral_5m_input_tokens":0}},"modelUsage":{"claude-sonnet-5-5":{}}}\nmore noise';
    const r = parseClaudeOutput(out);
    assert.equal(r.text, "hi");
    assert.deepEqual([r.usage.in, r.usage.cache_ttl, r.usage.cost, r.usage.seconds], [62192, 3600, 0.155, 3.3]);
  });

  test("the cache window is one hour, five minutes or none", () => {
    const ttl = (created: object) => extractUsage({ usage: { cache_creation: created } }).cache_ttl;
    assert.equal(ttl({ ephemeral_1h_input_tokens: 5 }), 3600);
    assert.equal(ttl({ ephemeral_5m_input_tokens: 5 }), 300);
    assert.equal(ttl({}), 0);
  });

  test("error results and garbage raise", () => {
    assert.throws(() => parseClaudeOutput('{"is_error":true,"result":"rate limited"}'), /rate limited/);
    assert.throws(() => parseClaudeOutput("not json"), RunError);
  });
});

describe("runClaude at full access", () => {
  const argvOf = async (cwd: string) => {
    const agent = makeAgent("t", { prompt: "job", tools: ["Read"], timeout: 20, sandbox: "danger-full-access", cwd });
    return JSON.parse((await withPath(fakeCli("claude", STREAM), () => runClaude(agent, "hi"))).text) as string[];
  };

  test("every tool is allowed, plus the MCP servers named in the folder's .mcp.json", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { apify: { command: "x" }, other: { command: "y" } } }));
    const argv = await argvOf(dir);
    assert.equal(argv[argv.indexOf("--mcp-config") + 1], path.join(dir, ".mcp.json"));
    const tools = argv[argv.indexOf("--allowedTools") + 1].split(",");
    for (const t of ["Bash", "Edit", "Write", "WebFetch", "mcp__apify", "mcp__other"]) assert.ok(tools.includes(t), t);
    assert.ok(argv.includes("--strict-mcp-config"), "servers outside that file stay blocked");
  });

  test("without a .mcp.json it is every built-in tool and no MCP config", async () => {
    const argv = await argvOf(tmp());
    assert.ok(!argv.includes("--mcp-config"));
    assert.ok(argv[argv.indexOf("--allowedTools") + 1].split(",").includes("Bash"));
  });

  test("at any other level the file's own tool list is used", async () => {
    const agent = makeAgent("t", { prompt: "job", tools: ["Read"], timeout: 20, sandbox: "read-only", cwd: tmp() });
    const argv = JSON.parse((await withPath(fakeCli("claude", STREAM), () => runClaude(agent, "hi"))).text) as string[];
    assert.equal(argv[argv.indexOf("--allowedTools") + 1], "Read");
    assert.ok(!argv.includes("--mcp-config"));
  });
});

describe("runClaude", () => {
  test("steps stream out and the result is read", async () => {
    const agent = makeAgent("t", { prompt: "job", tools: ["Read", "Bash(./socials utils x:*)"], model: "haiku", timeout: 20 });
    const steps: string[] = [];
    const result = await withPath(fakeCli("claude", STREAM), () => runClaude(agent, "hello", { onStep: (s) => steps.push(s) }));
    assert.deepEqual(steps, ["Reading plans/gtm-plan.md", "That step failed: boom happened", "Running ./socials utils x tracking ideas"]);
    assert.deepEqual([result.usage.model, result.usage.in, result.usage.cost, result.usage.turns], ["claude-sonnet-5-5", 153, 0.05, 2]);
    const argv: string[] = JSON.parse(result.text);
    for (const flag of ["-p", "--verbose", "--disable-slash-commands", "--strict-mcp-config", "--exclude-dynamic-system-prompt-sections"]) assert.ok(argv.includes(flag), flag);
    assert.equal(argv[argv.indexOf("--model") + 1], "haiku");
    assert.equal(argv[argv.indexOf("--allowedTools") + 1], "Read,Bash(./socials utils x:*)");
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  });

  test("rate-limit reports are passed on and are not steps", async () => {
    const body = `out({type: "rate_limit_event", rate_limit_info: {unifiedWindows: {five_hour: {utilization: 0.5, resetsAt: 9, status: "allowed"}}}});\nout({type: "result", is_error: false, result: "ok"});`;
    const reports: any[] = [];
    const steps: string[] = [];
    await withPath(fakeCli("claude", body), () => runClaude(makeAgent("t", { timeout: 20 }), "hello", { onStep: (s) => steps.push(s), onLimits: (i) => reports.push(i) }));
    assert.deepEqual(steps, []);
    assert.equal(reports[0].unifiedWindows.five_hour.utilization, 0.5);
  });

  test("it works without callbacks", async () => {
    const r = await withPath(fakeCli("claude", STREAM), () => runClaude(makeAgent("t", { timeout: 20 }), "hello"));
    assert.equal(r.usage.out, 9);
  });

  test("an error result raises with its message", async () => {
    await withPath(fakeCli("claude", `out({type: "result", is_error: true, result: "rate limited"});`), async () => {
      await assert.rejects(runClaude(makeAgent("t", { timeout: 20 }), "hello"), /rate limited/);
    });
  });

  test("no result raises with whatever was printed", async () => {
    await withPath(fakeCli("claude", `out("it broke badly"); process.exit(3);`), async () => {
      await assert.rejects(runClaude(makeAgent("t", { timeout: 20 }), "hello"), /it broke badly/);
    });
  });

  test("a run that takes too long is stopped", async () => {
    await withPath(fakeCli("claude", `setTimeout(() => {}, 30000);`), async () => {
      await assert.rejects(runClaude(makeAgent("t", { timeout: 1 }), "hello"), /timed out after 1s/);
    });
  });

  test("a missing claude is reported plainly", async () => {
    const old = process.env.PATH;
    process.env.PATH = tmp();
    try {
      await assert.rejects(runClaude(makeAgent("t", { timeout: 5 }), "hello"), /not found/);
    } finally {
      process.env.PATH = old;
    }
  });
});

const CODEX_STREAM = `
out({type: "thread.started", thread_id: "t1"});
out({type: "item.completed", item: {id: "i0", type: "error", message: "hooks config is deprecated"}});
out("plain noise line");
out({type: "turn.started"});
out({type: "item.started", item: {id: "i1", type: "command_execution", command: "/bin/bash -lc 'ls   -la .'", exit_code: null, status: "in_progress"}});
out({type: "item.completed", item: {id: "i1", type: "command_execution", command: "/bin/bash -lc 'ls   -la .'", exit_code: 0, status: "completed"}});
out({type: "item.started", item: {id: "i2", type: "command_execution", command: "/bin/bash -lc 'grep nothing x'", exit_code: null, status: "in_progress"}});
out({type: "item.completed", item: {id: "i2", type: "command_execution", command: "/bin/bash -lc 'grep nothing x'", exit_code: 2, status: "completed"}});
out({type: "item.completed", item: {id: "i3", type: "agent_message", text: JSON.stringify({argv: process.argv.slice(2), prompt: PROMPT})}});
out({type: "turn.completed", usage: {input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5}});
`;

describe("runCodex", () => {
  test("steps, answer and usage are read and warnings are ignored", async () => {
    const agent = makeAgent("t", { prompt: "the job", model: "gpt-x", timeout: 20, engine: "codex", sandbox: "read-only" });
    const steps: string[] = [];
    const result = await withPath(fakeCli("codex", CODEX_STREAM), () => runCodex(agent, "what is in here?", { onStep: (s) => steps.push(s) }));
    assert.deepEqual(steps, ["Running ls -la .", "Running grep nothing x", "That step failed (exit 2): grep nothing x"]);
    assert.deepEqual([result.usage.in, result.usage.cache_read, result.usage.out, result.usage.cost, result.usage.model], [1000, 400, 35, 0, "gpt-x"]);
    const got = JSON.parse(result.text);
    assert.deepEqual(got.argv.slice(0, 2), ["exec", "--json"]);
    assert.equal(got.argv[got.argv.indexOf("-s") + 1], "read-only");
    assert.equal(got.argv[got.argv.indexOf("-m") + 1], "gpt-x");
    assert.equal(got.argv.at(-1), "-");
    assert.match(got.prompt, /the job/);
    assert.match(got.prompt, /what is in here\?/);
  });

  test("search turns on Codex live web search, and is off by default", async () => {
    const run = async (search: boolean) =>
      JSON.parse((await withPath(fakeCli("codex", CODEX_STREAM), () => runCodex(makeAgent("t", { timeout: 20, engine: "codex", search }), "x"))).text).argv as string[];
    const on = await run(true);
    assert.equal(on[on.indexOf("-c") + 1], "web_search=live");
    assert.ok(on.indexOf("-c") < on.indexOf("-"), "the option comes before the prompt marker");
    assert.ok(!(await run(false)).includes("-c"));
  });

  test("the sandbox cannot be widened by a bad value", async () => {
    const agent = makeAgent("t", { timeout: 20, engine: "codex", sandbox: "anything-goes" as any });
    const got = JSON.parse((await withPath(fakeCli("codex", CODEX_STREAM), () => runCodex(agent, "x"))).text);
    assert.equal(got.argv[got.argv.indexOf("-s") + 1], "read-only");
  });

  test("full access is passed to Codex only when the agent file named it", async () => {
    const agent = makeAgent("t", { timeout: 20, engine: "codex", sandbox: "danger-full-access" });
    const got = JSON.parse((await withPath(fakeCli("codex", CODEX_STREAM), () => runCodex(agent, "x"))).text);
    assert.equal(got.argv[got.argv.indexOf("-s") + 1], "danger-full-access");
  });

  test("a failed turn raises with its message; no answer raises with what was printed", async () => {
    const agent = makeAgent("t", { timeout: 20, engine: "codex" });
    await withPath(fakeCli("codex", `out({type: "turn.failed", error: {message: "model refused"}});`), async () => {
      await assert.rejects(runCodex(agent, "x"), /model refused/);
    });
    await withPath(fakeCli("codex", `out("it broke"); process.exit(2);`), async () => {
      await assert.rejects(runCodex(agent, "x"), /it broke/);
    });
  });

  test("a slow run is stopped and a missing codex is reported", async () => {
    await withPath(fakeCli("codex", `setTimeout(() => {}, 30000);`), async () => {
      await assert.rejects(runCodex(makeAgent("t", { timeout: 1, engine: "codex" }), "x"), /timed out after 1s/);
    });
    const old = process.env.PATH;
    process.env.PATH = tmp();
    try {
      await assert.rejects(runCodex(makeAgent("t", { timeout: 5, engine: "codex" }), "x"), /not found/);
    } finally {
      process.env.PATH = old;
    }
  });

  test("each agent gets the engine it asks for", async () => {
    const folder = fakeCli("claude", `out({type: "result", is_error: false, result: "from claude"});`);
    const codex = fakeCli("codex", `out({type: "item.completed", item: {type: "agent_message", text: "from codex"}});`);
    await withPath(folder, () =>
      withPath(codex, async () => {
        assert.equal((await runAgent(makeAgent("a", { timeout: 20 }), "x") as any).text, "from claude");
        assert.equal((await runAgent(makeAgent("b", { timeout: 20, engine: "codex" }), "x") as any).text, "from codex");
      }),
    );
  });
});
