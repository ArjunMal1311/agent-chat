#!/usr/bin/env node
// Publishes ONE approved Instagram draft. The app runs this as an agent's publish_cmd, and only after you click
// "Approve & post" under the draft. It never decides anything itself: it reads the account and the kind of post from
// the draft's post.json, then runs the matching command of the socials project (the working directory, where
// ./socials lives). On success it prints a line "POSTED: <link>", which is what the app waits for.
//
//   node ig-publish.mjs <draft folder>
//
// post.json needs  { "profile": "<account>", "files": [...], "caption": "..." }
//   carousel / image post (default):  ./socials instagram <profile> post publish <folder>
//   reel  ("type": "reel", "name": "<render name>"):  ./socials instagram <profile> publish run --name <name> --limit 1
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

const dir = process.argv[2];
if (!dir) fail("usage: ig-publish.mjs <draft folder>");

let folder;
let post;
try {
  folder = fs.realpathSync(dir);
  post = JSON.parse(fs.readFileSync(path.join(folder, "post.json"), "utf8"));
} catch {
  fail(`no readable post.json in ${dir}`);
}

const profile = String(post.profile ?? "");
if (!/^[A-Za-z0-9_-]{1,40}$/.test(profile)) fail("post.json has no valid account (profile)");
// A draft lives in <root>/<account>/<draft>. Its post.json must name that same account, so a draft cannot be made
// to post to a different account than the folder it sits in.
if (path.basename(path.dirname(folder)) !== profile) fail(`this draft is not inside the "${profile}" folder, so it will not be posted`);

const reel = post.type === "reel";
const name = String(post.name ?? "");
if (reel && !/^[A-Za-z0-9._-]{1,120}$/.test(name)) fail("a reel draft needs post.json \"name\" (the render's file name without .mp4)");

const args = reel ? ["instagram", profile, "publish", "run", "--name", name, "--limit", "1"] : ["instagram", profile, "post", "publish", folder];
const run = spawnSync("./socials", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 25 * 60 * 1000 });
if (run.error) fail(`could not run ./socials in ${process.cwd()}: ${run.error.message}`, 1);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) process.exit(run.status ?? 1);

if (reel) {
  // The reel command prints "  <name>: <link or status>" for a reel it posted, and only the queue (exit 0) when
  // nothing was ready. Only the first case counts as posted.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^\\s*${escaped}:\\s*(\\S.*)$`, "m").exec(run.stdout ?? "");
  if (!line) fail("The reel command finished but did not report this reel as posted (it may be held or already posted). Nothing was published.", 1);
  console.log("POSTED: " + line[1].trim());
}
