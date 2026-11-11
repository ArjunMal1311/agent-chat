import assert from "node:assert/strict";
import path from "node:path";
import test, { describe } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/main/db/store.ts";
import { tmp } from "./helpers.ts";

const usage = (over = {}) => ({ cost: 0.1, in: 100, out: 10, seconds: 2, model: "sonnet", cache_read: 60, cache_write: 20, cache_ttl: 3600, ...over });

describe("store", () => {
  test("usage is saved with a message and totalled", () => {
    const s = new Store();
    s.add("c", "bot", "a", "text", "", usage());
    s.add("c", "bot", "b", "text", "", usage({ cost: 0.2 }));
    s.add("c", "bot", "steps only", "text", "", { steps: ["x"] }); // not a counted run
    const u = s.usage("c");
    assert.equal(u.runs, 2);
    assert.equal(u.cost, 0.3);
    assert.equal(u.tokens, 220);
    assert.equal(u.today_runs, 2);
    assert.equal(u.model, "sonnet");
  });

  test("cache status is warm inside the window and cold after it", () => {
    const s = new Store();
    s.add("c", "bot", "a", "text", "", usage());
    const cache = s.usage("c").cache;
    assert.equal(cache.ttl, 3600);
    assert.ok(cache.warm_until > Date.now() / 1000);
    assert.equal(cache.last_hit, 0.6);
    assert.equal(new Store().usage("none").cache, null);
  });

  test("a run that wrote nothing keeps the last known window", () => {
    const s = new Store();
    s.add("c", "bot", "a", "text", "", usage());
    s.add("c", "bot", "b", "text", "", usage({ cache_write: 0, cache_ttl: 0, cache_read: 100 }));
    assert.equal(s.usage("c").cache.ttl, 3600);
    assert.equal(s.usage("c").cache.last_hit, 1);
  });

  test("clearing a chat keeps its usage totals; wiping removes them", () => {
    const s = new Store();
    s.add("c", "bot", "a", "text", "", usage());
    assert.equal(s.clear("c"), 1);
    assert.equal(s.usage("c").runs, 1);
    s.setJson("summary:c", { text: "x" });
    s.wipe("c");
    assert.equal(s.usage("c").runs, 0);
    assert.equal(s.getJson("summary:c"), null);
  });

  test("usage already on messages is copied into the log once, and an old database is upgraded", () => {
    const file = path.join(tmp(), "old.db");
    const db = new DatabaseSync(file);
    db.exec("create table messages(id integer primary key autoincrement, chat text not null, sender text not null, kind text not null default 'text', body text not null, status text not null default '', created real not null)");
    db.prepare("insert into messages(chat,sender,body,created) values('c','bot','hi',1)").run();
    db.close();
    const s = new Store(file);
    assert.equal(s.messages("c").length, 1);
    s.add("c", "bot", "x", "text", "", usage());
    assert.equal(s.usage("c").runs, 1);
    s.db.close();
    assert.equal(new Store(file).usage("c").runs, 1);
  });

  test("unread counts only agent messages until read", () => {
    const s = new Store();
    s.add("c", "you", "q");
    const a = s.add("c", "bot", "a");
    s.add("c", "bot", "status", "status");
    assert.equal(s.unread("c"), 1);
    s.markRead("c", a.id);
    assert.equal(s.unread("c"), 0);
    s.markRead("c", 0); // never moves backwards
    assert.equal(s.unread("c"), 0);
  });

  test("pending counts only unresolved drafts, and a draft resolves once", () => {
    const s = new Store();
    const d = s.add("c", "bot", "draft", "approval", "pending");
    s.add("c", "bot", "draft two", "approval", "pending");
    s.add("c", "bot", "plain");
    assert.equal(s.pending("c"), 2);
    assert.equal(s.resolve(d.id, "approved")?.status, "approved");
    assert.equal(s.resolve(d.id, "declined"), null);
    assert.equal(s.pending("c"), 1);
    assert.throws(() => s.resolve(d.id, "maybe"));
  });

  test("one run at a time per chat, and a crash does not leave it working", () => {
    const file = path.join(tmp(), "w.db");
    const s = new Store(file);
    assert.equal(s.tryStart("c", "x"), true);
    assert.equal(s.tryStart("c", "y"), false);
    assert.deepEqual(s.working("c"), [true, "x"]);
    s.setDetail("c", "z");
    s.db.close();
    assert.deepEqual(new Store(file).working("c"), [false, ""]);
  });

  test("recent skips status notes and returns oldest first; messages keeps the newest", () => {
    const s = new Store();
    for (let i = 1; i <= 5; i++) s.add("c", "you", `m${i}`);
    s.add("c", "bot", "note", "status");
    assert.deepEqual(s.recent("c", 3).map((r) => r[1]), ["m3", "m4", "m5"]);
    assert.deepEqual(s.messages("c", 2).map((m) => m.body), ["m5", "note"]);
    assert.equal(s.count("c"), 5);
  });
});
