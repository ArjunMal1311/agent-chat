// Starts the whole app (store, hub, scheduler, HTTP server). Used by the headless CLI and by the Electron window.
import fs from "node:fs";
import path from "node:path";
import { loadAgents, seedExamples } from "./agents.ts";
import { Bus } from "./bus.ts";
import { Hub } from "./hub.ts";
import { runAgent } from "./runner.ts";
import { Scheduler } from "./scheduler.ts";
import { type Served, startServer } from "./server.ts";
import { Store } from "./store.ts";

export interface BootOptions {
  root: string; // the project folder (holds examples/agents)
  agentsDir: string;
  dataDir: string;
  staticDir: string; // the built web page
  port: number;
}

export interface Booted {
  hub: Hub;
  served: Served;
  agentCount: number;
  seeded: number;
  stop: () => Promise<void>;
}

export async function boot(o: BootOptions): Promise<Booted> {
  fs.mkdirSync(o.dataDir, { recursive: true });
  const seeded = seedExamples(o.agentsDir, path.join(o.root, "examples", "agents"));
  const agents = loadAgents(o.agentsDir);
  if (!agents.size) throw new Error(`No agent files found in ${o.agentsDir}/`);
  if (!fs.existsSync(path.join(o.staticDir, "index.html"))) throw new Error(`The web page is not built yet (${o.staticDir}). Run: npm run build`);
  const hub = new Hub({ store: new Store(path.join(o.dataDir, "chat.db")), agents, bus: new Bus(), runner: runAgent, dataDir: o.dataDir, agentsDir: o.agentsDir });
  const scheduler = new Scheduler(hub, o.dataDir); // agents with `schedule: HH:MM` run by themselves once a day while the app is open
  scheduler.start();
  const served = await startServer(hub, o.staticDir, o.port);
  return {
    hub,
    served,
    agentCount: agents.size,
    seeded,
    stop: async () => {
      scheduler.stop();
      await served.close();
      hub.store.db.close();
    },
  };
}
