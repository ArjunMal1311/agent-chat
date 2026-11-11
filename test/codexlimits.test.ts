import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { normalize, readCodexLimits, windowLabel } from "../src/main/runner/codexlimits.ts";
import { fakeRaw, tmp, withPath } from "./helpers.ts";

// A fake `codex app-server`: answers initialize, then account/rateLimits/read, one JSON object per line.
const cli = (reply: string) =>
  fakeRaw(
    "codex",
    `require("readline").createInterface({input: process.stdin}).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") out({id: m.id, result: {userAgent: "fake"}});
  if (m.method === "account/rateLimits/read") { ${reply} }
});`,
  );

describe("codex limits", () => {
  test("window lengths get plain names", () => {
    assert.deepEqual([300, 10080, 43200, 30, 0].map(windowLabel), ["5-hour", "7-day", "30-day", "30-minute", "limit"]);
    assert.equal(windowLabel("x"), "limit");
  });

  test("one or two windows are kept as reported, and odd shapes give no windows", () => {
    const one = normalize({ planType: "go", primary: { usedPercent: 9, windowDurationMins: 43200, resetsAt: 7 }, secondary: null });
    assert.deepEqual(one, { plan: "go", windows: [{ label: "30-day", used: 0.09, resets_at: 7, minutes: 43200 }] });
    assert.equal(normalize({ primary: { usedPercent: 250, windowDurationMins: 300 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } }).windows.length, 2);
    assert.equal(normalize({ primary: { usedPercent: 250, windowDurationMins: 300 } }).windows[0].used, 1);
    assert.deepEqual(normalize("x"), { plan: "", windows: [] });
    assert.deepEqual(normalize({ primary: "bad", planType: "unknown" }), { plan: "", windows: [] });
  });
});

describe("readCodexLimits", () => {
  const rateReply = `out({id: m.id, result: {rateLimits: {planType: "go", primary: {usedPercent: 9, windowDurationMins: 43200, resetsAt: 7}}, accountId: "secret-id"}});`;

  test("the windows are read and the account id is not kept", async () => {
    const data = await withPath(cli(rateReply), () => readCodexLimits(5));
    assert.equal(data.windows[0].used, 0.09);
    assert.ok(!JSON.stringify(data).includes("secret-id"));
  });

  test("an error reply is reported with its message", async () => {
    await withPath(cli(`out({id: m.id, error: {message: "not signed in"}});`), async () => {
      await assert.rejects(readCodexLimits(5), /codex said: not signed in/);
    });
  });

  test("a reply without windows is an error, not an empty bar", async () => {
    await withPath(cli(`out({id: m.id, result: {rateLimits: {}}});`), async () => {
      await assert.rejects(readCodexLimits(5), /no usage windows/);
    });
  });

  test("codex exiting early is reported, a silent codex times out, a missing codex is plain", async () => {
    await withPath(cli(`process.exit(1);`), async () => {
      await assert.rejects(readCodexLimits(5), /stopped before it answered/);
    });
    await withPath(cli(`/* never answers */`), async () => {
      await assert.rejects(readCodexLimits(1), /did not answer within 1s/);
    });
    const old = process.env.PATH;
    process.env.PATH = tmp();
    try {
      await assert.rejects(readCodexLimits(2), /not found/);
    } finally {
      process.env.PATH = old;
    }
  });
});
