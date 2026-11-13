import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { tmp } from "./helpers.ts";

// scripts/ig-publish.mjs is the publish command of the Instagram agent. These tests run it against a fake `./socials`
// that records its arguments, so nothing is ever posted.
const WRAPPER = path.resolve("scripts/ig-publish.mjs");

function project() {
  const dir = fs.realpathSync(tmp("socials-"));
  fs.writeFileSync(
    path.join(dir, "socials"),
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.FAKE_OUT || "");
process.exit(Number(process.env.FAKE_CODE || 0));
`,
  );
  fs.chmodSync(path.join(dir, "socials"), 0o755);
  return dir;
}

function draft(root: string, account: string, post: Record<string, unknown>) {
  const folder = path.join(root, "tmp", "posts", account, "d1");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "post.json"), JSON.stringify({ files: ["1.png"], caption: "hi", ...post }));
  return folder;
}

function publish(root: string, folder: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [WRAPPER, folder], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  const argsFile = path.join(root, "args.json");
  return { code: r.status, out: r.stdout, err: r.stderr, args: fs.existsSync(argsFile) ? (JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[]) : null };
}

describe("ig-publish", () => {
  test("a carousel draft runs post publish for the account named in post.json", () => {
    const root = project();
    const folder = draft(root, "main", { profile: "main" });
    const r = publish(root, folder, { FAKE_OUT: "POSTED: https://instagram.com/p/1\n" });
    assert.equal(r.code, 0);
    assert.deepEqual(r.args, ["instagram", "main", "post", "publish", folder]);
    assert.match(r.out, /^POSTED: https:\/\/instagram.com\/p\/1/m);
  });

  test("a draft whose post.json names another account than its folder is never posted", () => {
    const root = project();
    const folder = draft(root, "other", { profile: "main" });
    const r = publish(root, folder);
    assert.equal(r.code, 2);
    assert.equal(r.args, null, "./socials was not run");
    assert.match(r.err, /not inside the "main" folder/);
  });

  test("an account name that is not a plain name is refused", () => {
    const root = project();
    for (const profile of ["../x", "a b", "", "x;rm"]) {
      const r = publish(root, draft(root, "main", { profile }));
      assert.equal(r.code, 2, profile);
      assert.equal(r.args, null);
    }
  });

  test("a reel draft posts exactly that render, once, and reports it as POSTED", () => {
    const root = project();
    const folder = draft(root, "main", { profile: "main", type: "reel", name: "reel-1" });
    const r = publish(root, folder, { FAKE_OUT: "  take/out/reel-1.mp4  READY\nPosting reel-1 as a trial (MANUAL)...\n  reel-1: https://instagram.com/reel/9\n" });
    assert.equal(r.code, 0);
    assert.deepEqual(r.args, ["instagram", "main", "publish", "run", "--name", "reel-1", "--limit", "1"]);
    assert.match(r.out, /^POSTED: https:\/\/instagram.com\/reel\/9$/m);
  });

  test("a reel that was held or already posted is a failure, not a success", () => {
    const root = project();
    const folder = draft(root, "main", { profile: "main", type: "reel", name: "reel-1" });
    const r = publish(root, folder, { FAKE_OUT: "  take/out/reel-1.mp4  held: caption is empty\n" });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /POSTED:/);
    assert.match(r.err, /Nothing was published/);
  });

  test("a reel draft needs a plain render name", () => {
    const root = project();
    const r = publish(root, draft(root, "main", { profile: "main", type: "reel", name: "../evil" }));
    assert.equal(r.code, 2);
    assert.equal(r.args, null);
  });

  test("a failing socials command fails the publish and prints no POSTED line", () => {
    const root = project();
    const r = publish(root, draft(root, "main", { profile: "main" }), { FAKE_CODE: "3", FAKE_OUT: "no token\n" });
    assert.equal(r.code, 3);
    assert.doesNotMatch(r.out, /POSTED:/);
  });
});
