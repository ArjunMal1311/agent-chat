// Run: node src/main/cli.ts [--port 8765] [--agents agents] [--data data]
// Starts the chat server on its own (no window). The desktop app starts the same server inside Electron.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "./boot.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function option(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export async function main(): Promise<void> {
  const booted = await boot({
    root,
    port: Number(option("port", "8765")),
    agentsDir: path.resolve(option("agents", "agents")),
    dataDir: path.resolve(option("data", "data")),
    staticDir: path.resolve(option("static", path.join(root, "out", "renderer"))),
  });
  if (booted.seeded) console.log(`First run: copied ${booted.seeded} example agents into the agents folder. Edit them or add your own there.`);
  console.log(`Agent chat on http://127.0.0.1:${booted.served.port}  (${booted.agentCount} agents). Ctrl+C to stop.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
