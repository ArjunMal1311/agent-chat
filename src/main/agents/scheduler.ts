// Runs agents on their own: an agent file with `schedule: 21:00` gets its `schedule_message` once a day.
//
// It only works while the app is running. If the app was closed at that time it runs the missed check as soon as
// the app starts again the same day (never twice in a day: the last day each agent ran is saved in schedule.json).
import fs from "node:fs";
import path from "node:path";
import type { Hub } from "../hub/hub.ts";

type Clock = () => Date;
type Ran = Record<string, string>;

export class Scheduler {
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private hub: Pick<Hub, "agents" | "send">;
  private now: Clock;
  private intervalMs: number;

  constructor(hub: Pick<Hub, "agents" | "send">, dataDir: string, now: Clock = () => new Date(), intervalMs = 30000) {
    this.hub = hub;
    this.now = now;
    this.intervalMs = intervalMs;
    this.file = path.join(dataDir, "schedule.json");
  }

  private load(): Ran {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  private save(ran: Ran): void {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ran, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** Send the scheduled message to every agent whose time has passed today and has not run today. */
  tick(): string[] {
    const moment = this.now();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
    const clock = `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
    const ran = this.load();
    const sent: string[] = [];
    for (const [name, agent] of [...this.hub.agents]) {
      if (!agent.schedule || clock < agent.schedule || ran[name] === today) continue;
      ran[name] = today;
      this.save(ran); // saved before sending, so a crash can never send it twice
      try {
        this.hub.send(name, agent.scheduleMessage);
        sent.push(name);
      } catch (e) {
        console.error(`scheduler: ${name}: ${(e as Error).message}`); // one bad agent must not stop the others
      }
    }
    return sent;
  }

  start(): void {
    const loop = () => {
      try {
        this.tick();
      } catch (e) {
        console.error(`scheduler: ${(e as Error).message}`);
      }
    };
    loop();
    this.timer = setInterval(loop, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
