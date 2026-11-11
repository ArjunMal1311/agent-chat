import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { makeAgent, type Agent } from "../src/main/agents.ts";
import { Scheduler } from "../src/main/scheduler.ts";
import { tmp } from "./helpers.ts";

const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 10, day, h, m);
};

function make(agents: Record<string, Agent>, clock: { now: Date }, folder = tmp()) {
  const sent: [string, string][] = [];
  const hub = { agents: new Map(Object.entries(agents)), send: (chat: string, text: string) => void sent.push([chat, text]) } as any;
  return { sent, folder, hub, sched: new Scheduler(hub, folder, () => clock.now) };
}
const doctor = () => makeAgent("daily-check", { schedule: "21:00", scheduleMessage: "Daily check" });

describe("scheduler", () => {
  test("nothing is sent before the time", () => {
    const { sent, sched } = make({ "daily-check": doctor() }, { now: at(11, "20:59") });
    assert.deepEqual(sched.tick(), []);
    assert.deepEqual(sent, []);
  });

  test("it is sent once when the time comes and not again that day", () => {
    const clock = { now: at(11, "21:00") };
    const { sent, sched } = make({ "daily-check": doctor() }, clock);
    sched.tick();
    clock.now = at(11, "21:30");
    sched.tick();
    clock.now = at(11, "23:59");
    sched.tick();
    assert.deepEqual(sent, [["daily-check", "Daily check"]]);
  });

  test("it runs again the next day", () => {
    const clock = { now: at(11, "21:00") };
    const { sent, sched } = make({ "daily-check": doctor() }, clock);
    sched.tick();
    clock.now = at(12, "21:01");
    sched.tick();
    assert.equal(sent.length, 2);
  });

  test("a missed check runs when the app starts later the same day", () => {
    const { sched } = make({ "daily-check": doctor() }, { now: at(11, "22:40") });
    assert.deepEqual(sched.tick(), ["daily-check"]);
  });

  test("a restart does not send it twice", () => {
    const clock = { now: at(11, "21:05") };
    const { sent, hub, folder, sched } = make({ "daily-check": doctor() }, clock);
    sched.tick();
    new Scheduler(hub, folder, () => clock.now).tick();
    assert.equal(sent.length, 1);
  });

  test("agents without a schedule are left alone", () => {
    const { sched } = make({ planner: makeAgent("planner") }, { now: at(11, "23:00") });
    assert.deepEqual(sched.tick(), []);
  });

  test("one failing agent does not stop the others", () => {
    const { hub, sched } = make({ a: makeAgent("a", { schedule: "21:00", scheduleMessage: "x" }), b: makeAgent("b", { schedule: "21:00", scheduleMessage: "y" }) }, { now: at(11, "21:10") });
    const original = hub.send;
    hub.send = (chat: string, text: string) => {
      if (chat === "a") throw new Error("unknown chat");
      original(chat, text);
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(sched.tick(), ["b"]);
    } finally {
      console.error = quiet;
    }
  });
});
