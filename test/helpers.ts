import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAgent, type Agent } from "../src/main/agents.ts";
import { Bus } from "../src/main/bus.ts";
import { Hub, type HubOptions } from "../src/main/hub.ts";
import type { Runner } from "../src/main/runner.ts";
import { Store } from "../src/main/store.ts";

export const tmp = (prefix = "ac-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return predicate();
}

export function defaultAgents(): Map<string, Agent> {
  return new Map<string, Agent>([
    ["manager", makeAgent("manager", { title: "Manager" })],
    ["planner", makeAgent("planner", { title: "Planner", goal: "Plans the day" })],
    ["writer", makeAgent("writer", { title: "Writer", approval: true })],
  ]);
}

export function makeHub(runner: Runner, over: Partial<HubOptions> = {}): Hub {
  return new Hub({ store: new Store(), agents: defaultAgents(), bus: new Bus(), runner, dataDir: tmp(), ...over });
}

/** A temporary executable named `name` (a node script). Returns the folder to put first on PATH. */
export function fakeCli(name: string, body: string): string {
  const dir = tmp("cli-");
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nconst fs = require("fs");\nconst PROMPT = fs.readFileSync(0, "utf8");\nconst out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o));\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return dir;
}

export async function withPath<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.PATH;
  process.env.PATH = folder + path.delimiter + old;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

/** Like fakeCli, but does not read stdin up front: for a program that talks back and forth (an app server). */
export function fakeRaw(name: string, body: string): string {
  const dir = tmp("cli-");
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nconst out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o));\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return dir;
}
