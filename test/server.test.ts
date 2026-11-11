import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { makeAgent } from "../src/main/agents/agents.ts";
import { startServer, type Served } from "../src/main/server/server.ts";
import { defaultAgents, makeHub, tmp, waitFor } from "./helpers.ts";

let served: Served;
let hub: ReturnType<typeof makeHub>;
let base: string;
let agentsDir: string;

const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });
const post = (p: string, body: unknown, headers: Record<string, string> = { "X-Agent-Chat": "1" }) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

before(async () => {
  const staticDir = tmp("static-");
  fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>Agent Chat</h1>");
  fs.writeFileSync(path.join(path.dirname(staticDir), "secret.txt"), "secret");
  agentsDir = tmp("agents-");
  const agents = defaultAgents();
  agents.set("coder", makeAgent("coder", { title: "Coder", engine: "codex" }));
  hub = makeHub(async () => "hello back", {
    agents,
    agentsDir,
    codexReader: async () => ({ plan: "go", windows: [{ label: "30-day", used: 0.09, resets_at: 5, minutes: 43200 }] }),
  });
  served = await startServer(hub, staticDir, 0);
  base = `http://127.0.0.1:${served.port}`;
});
after(async () => {
  await hub.settle();
  await served.close();
});

describe("server", () => {
  test("chats are listed and the page is served", async () => {
    const chats = (await (await get("/api/chats")).json()).chats;
    assert.deepEqual(chats.map((c: any) => c.name).sort(), ["coder", "manager", "planner", "writer"]);
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Chat/);
  });

  test("a POST without the custom header and a wrong host are refused", async () => {
    assert.equal((await post("/api/send", { chat: "planner", text: "hi" }, {})).status, 403);
    const wrong = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: served.port, path: "/api/chats", headers: { Host: "evil.example" } }, (r) => (r.resume(), resolve(r.statusCode!)));
    });
    assert.equal(wrong, 403);
  });

  test("send and read back, marking the chat read", async () => {
    const sent = await (await post("/api/send", { chat: "planner", text: "hello" })).json();
    assert.equal(sent.message.body, "hello");
    assert.ok(await waitFor(() => hub.store.last("planner")?.body === "hello back"));
    const read = await (await get("/api/messages?chat=planner")).json();
    assert.deepEqual(read.messages.map((m: any) => m.body), ["hello", "hello back"]);
    assert.equal(read.chat.unread, 0);
    assert.equal(read.chat.usage.runs, 0);
  });

  test("bad requests get 400 or 404", async () => {
    assert.equal((await get("/api/messages?chat=ghost")).status, 404);
    assert.equal((await post("/api/send", { chat: "ghost", text: "x" })).status, 400);
    assert.equal((await post("/api/send", { chat: "planner", text: "  " })).status, 400);
    assert.equal((await post("/api/approve", { id: "x", decision: "approved" })).status, 400);
    assert.equal((await post("/api/nothing", {})).status, 404);
    assert.equal((await fetch(base + "/api/send", { method: "POST", headers: { "X-Agent-Chat": "1" }, body: "{bad" })).status, 400);
    assert.equal((await fetch(base + "/api/chats", { method: "DELETE" })).status, 405);
  });

  test("files outside the static folder are not served", async () => {
    assert.equal((await get("/../secret.txt")).status, 404);
    assert.equal((await get("/%2e%2e/secret.txt")).status, 404);
    assert.equal((await get("/missing.js")).status, 404);
  });

  test("clear, forget and compact endpoints", async () => {
    await hub.settle();
    assert.equal((await post("/api/forget", { chat: "planner" })).status, 200);
    assert.equal((await post("/api/compact", { chat: "planner" })).status, 400); // too short
    const cleared = await (await post("/api/clear", { chat: "planner" })).json();
    assert.equal(cleared.deleted, 2);
  });

  test("limits endpoints carry the codex windows and a refresh reads them now", async () => {
    const first = await (await get("/api/limits")).json();
    assert.deepEqual(first.limits, { windows: {}, updated: null });
    const refreshed = await (await post("/api/codex-limits/refresh", {})).json();
    assert.equal(refreshed.codex.windows[0].used, 0.09);
    assert.equal(refreshed.codex.plan, "go");
  });

  test("the New agent route: options, create, listed, and what the form disallows is a 400", async () => {
    const options = await (await get("/api/agent-options")).json();
    assert.equal(options.enabled, true);
    const created = await post("/api/agents", { title: "Route Bot", prompt: "Summarise whatever the user pastes." });
    assert.equal((await created.json()).name, "route-bot");
    assert.ok(fs.existsSync(path.join(agentsDir, "route-bot.md")));
    const names = (await (await get("/api/chats")).json()).chats.map((c: any) => c.name);
    assert.ok(names.includes("route-bot"));
    assert.equal((await post("/api/agents", { title: "Bad Bot", prompt: "Do something useful.", tools: ["Bash"] })).status, 400);
  });

  test("the event stream sends a connected line and then changes", async () => {
    const res = await fetch(base + "/events");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /: connected/);
    hub.bus.publish({ chats: ["planner"] });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /data: \{"chats":\["planner"\]\}/);
    await reader.cancel();
  });
});
