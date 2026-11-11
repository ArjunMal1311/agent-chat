import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startServer, type Served } from "../src/main/server/server.ts";
import { api } from "../src/renderer/src/lib/api.ts";
import {
  AgentOptionsSchema,
  ChatsResponse,
  ClearResponse,
  CodexRefreshResponse,
  Ignored,
  LimitsRefreshResponse,
  LimitsResponse,
  MessagesResponse,
} from "../src/renderer/src/lib/schemas.ts";
import { defaultAgents, makeHub, tmp, waitFor } from "./helpers.ts";

// The page trusts these schemas, so check them against what the real server sends.

let served: Served;
let hub: ReturnType<typeof makeHub>;
let base: string;

before(async () => {
  const staticDir = tmp("static-");
  fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>Agent Chat</h1>");
  hub = makeHub(async () => "hello back", {
    agents: defaultAgents(),
    agentsDir: tmp("agents-"),
    codexReader: async () => ({ plan: "go", windows: [{ label: "30-day", used: 0.09, resets_at: 5, minutes: 43200 }] }),
  });
  served = await startServer(hub, staticDir, 0);
  base = `http://127.0.0.1:${served.port}`;
});
after(async () => {
  await hub.settle();
  await served.close();
});

describe("renderer schemas against the real API", () => {
  test("chats, messages and limits parse", async () => {
    await api(base + "/api/send", Ignored, { chat: "planner", text: "hello" });
    assert.ok(await waitFor(() => hub.store.last("planner")?.body === "hello back"));

    const chats = await api(base + "/api/chats", ChatsResponse);
    assert.ok(chats.chats.length >= 3);

    const thread = await api(base + "/api/messages?chat=planner", MessagesResponse);
    assert.equal(thread.chat.name, "planner");
    assert.ok(thread.messages.length >= 2);

    const limits = await api(base + "/api/limits", LimitsResponse);
    assert.equal(limits.codex === null || Array.isArray(limits.codex.windows), true);
  });

  test("agent options, refresh and clear replies parse", async () => {
    const options = await api(base + "/api/agent-options", AgentOptionsSchema);
    assert.equal(typeof options.enabled, "boolean");
    await api(base + "/api/limits/refresh", LimitsRefreshResponse, {});
    await api(base + "/api/codex-limits/refresh", CodexRefreshResponse, {});
    const cleared = await api(base + "/api/clear", ClearResponse, { chat: "planner" });
    assert.equal(typeof cleared.deleted, "number");
  });

  test("a reply of the wrong shape is rejected with the route and field named", async () => {
    await assert.rejects(
      api(base + "/api/limits", ChatsResponse),
      (err: Error) => /Unexpected reply from .*\/api\/limits: chats:/.test(err.message),
    );
  });

  test("a server error keeps the server's message", async () => {
    await assert.rejects(api(base + "/api/send", Ignored, { chat: "nobody", text: "hi" }), (err: Error) => err.message.length > 0 && !/Unexpected reply/.test(err.message));
  });
});
