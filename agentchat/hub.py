"""The hub: takes your messages, runs agents, hands work between them, and records approvals.

The hub never sends or posts anything to the outside world. An "approval" is only your sign-off
on a draft; you do the sending yourself.
"""
import datetime
import inspect
import json
import re
import threading
from pathlib import Path

import time

from .agents import Agent
from .runner import RunResult

REMEMBER_RE = re.compile(r"^REMEMBER:\s*(.+)$", re.M)
MAX_NOTES = 30  # an agent keeps its newest notes only, so its notes file cannot grow without limit


def normalize_limits(info):
    """Claude Code's rate-limit report -> {window: {used 0..1, resets_at epoch seconds, status}}."""
    windows = info.get("unifiedWindows") or {}
    out = {}
    for key in ("five_hour", "seven_day"):
        window = windows.get(key) or (info if info.get("rateLimitType") == key else None)
        if window and window.get("utilization") is not None:
            out[key] = {
                "used": float(window["utilization"]),
                "resets_at": window.get("resetsAt"),
                "status": window.get("status") or "",
            }
    return out


def parse_json_object(text):
    """Pull the first {...} object out of a model answer, or None."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


class Hub:
    def __init__(self, store, agents, bus, runner, data_dir):
        self.store = store
        self.agents = agents
        self.bus = bus
        self.runner = runner
        self.memory_dir = Path(data_dir) / "memory"
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self._live = {}  # chat -> steps of the run in progress, shown while the agent works
        self._live_lock = threading.Lock()

    # ---- helpers -------------------------------------------------------------------------
    def live_steps(self, chat):
        with self._live_lock:
            return list(self._live.get(chat, ()))

    # ---- plan limits (the 5-hour and 7-day windows Claude Code reports) -------------------
    def record_limits(self, info):
        """Save the newest limits report. A partial report only updates the windows it contains."""
        fresh = normalize_limits(info)
        if not fresh:
            return
        saved = self.store.get_json("limits", {}) or {}
        windows = {**(saved.get("windows") or {}), **fresh}
        self.store.set_json("limits", {"windows": windows, "updated": time.time()})
        self.bus.publish({"limits": True})

    def limits(self):
        saved = self.store.get_json("limits", None)
        return saved or {"windows": {}, "updated": None}

    def refresh_limits(self):
        """Run one tiny call so Claude Code reports fresh limits. It uses a little usage itself."""
        probe = Agent("probe", title="Probe", prompt="Reply with the single word ok.", model="haiku", timeout=90)
        result = self._call_runner(probe, "ok", on_limits=self.record_limits)
        return dict(result.usage) if isinstance(result, RunResult) else {}

    def _call_runner(self, agent, prompt, **callbacks):
        """Call the runner with whichever callbacks it accepts (a test runner may take just two arguments)."""
        accepted = inspect.signature(self.runner).parameters
        return self.runner(agent, prompt, **{k: v for k, v in callbacks.items() if k in accepted})

    def _run(self, chat, agent, prompt):
        """Call the runner. Returns (text, meta or None); meta is the usage plus the steps taken.

        Steps are published as they happen so the chat can show what the agent is doing."""
        steps = []

        def on_step(text):
            steps.append(text)
            with self._live_lock:
                self._live[chat] = list(steps)
            self.store.set_detail(chat, text)
            self._notify(chat)

        try:
            result = self._call_runner(agent, prompt, on_step=on_step, on_limits=self.record_limits)
        finally:
            with self._live_lock:
                self._live.pop(chat, None)
        text, usage = (result.text, result.usage) if isinstance(result, RunResult) else (str(result), None)
        meta = dict(usage) if usage else {}
        if steps:
            meta["steps"] = steps[-40:]
        return text, (meta or None)

    def _notify(self, *chats):
        self.bus.publish({"chats": list(chats)})

    def _memory_path(self, name):
        return self.memory_dir / f"{name}.md"

    def _read_memory(self, name):
        path = self._memory_path(name)
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""

    def _extract_memory(self, name, text):
        notes = REMEMBER_RE.findall(text)
        if notes:
            path = self._memory_path(name)
            existing = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()] if path.exists() else []
            lines = existing + [f"- {note.strip()}" for note in notes]
            path.write_text("\n".join(lines[-MAX_NOTES:]) + "\n", encoding="utf-8")
        return REMEMBER_RE.sub("", text).strip()

    def notes_count(self, name):
        path = self._memory_path(name)
        if not path.exists():
            return 0
        return sum(1 for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip())

    def _prompt(self, name, request):
        now = datetime.datetime.now()
        parts = [f"Today is {now:%A %Y-%m-%d}."]
        memory = self._read_memory(name)
        if memory:
            parts.append("Your notes from earlier runs:\n" + memory)
        history = self.store.recent(name, 12)
        if history and history[-1][1] == request:
            history = history[:-1]
        if history:
            parts.append("Recent conversation:\n" + "\n".join(f"{s}: {b}" for s, b in history))
        parts.append("Request:\n" + request)
        return "\n\n".join(parts)

    # ---- public API ----------------------------------------------------------------------
    def send(self, chat, text):
        text = (text or "").strip()
        if chat not in self.agents:
            raise ValueError("unknown chat")
        if not text:
            raise ValueError("empty message")
        msg = self.store.add(chat, "you", text)
        self._notify(chat)
        target = self._manager_turn if chat == "manager" else self._agent_turn
        args = (text,) if chat == "manager" else (chat, text)
        threading.Thread(target=target, args=args, daemon=True).start()
        return msg

    def clear_chat(self, chat):
        """Delete a chat's messages. Usage totals and the agent's notes are kept."""
        if chat not in self.agents:
            raise ValueError("unknown chat")
        if self.store.working(chat)[0]:
            raise ValueError("this agent is working right now; clear the chat when it has finished")
        deleted = self.store.clear(chat)
        self._notify(chat)
        return deleted

    def forget_notes(self, chat):
        """Empty the agent's saved notes. Messages are kept."""
        if chat not in self.agents:
            raise ValueError("unknown chat")
        self._memory_path(chat).unlink(missing_ok=True)
        self._notify(chat)

    def approve(self, message_id, decision):
        msg = self.store.resolve(message_id, decision)
        if not msg:
            raise ValueError("that message is not waiting for approval")
        if decision == "approved":
            note = "Approved. Nothing is sent automatically: you send it yourself."
        else:
            note = "Declined."
        self.store.add(msg["chat"], "you", note, kind="status")
        self._notify(msg["chat"])
        return msg

    # ---- turns ---------------------------------------------------------------------------
    def _agent_turn(self, name, request):
        """Run one agent on a request. Returns True if it produced an answer."""
        agent = self.agents[name]
        if not self.store.try_start(name, "Starting…"):
            self.store.add(name, name, "I'm still working on the last request. Ask again in a minute.")
            self._notify(name)
            return False
        self._notify(name)
        ok = False
        try:
            out, usage = self._run(name, agent, self._prompt(name, request))
            out = self._extract_memory(name, out)
            kind = "approval" if agent.approval and out else "text"
            self.store.add(
                name,
                name,
                out or "(no answer)",
                kind=kind,
                status="pending" if kind == "approval" else "",
                meta=usage,
            )
            ok = True
        except Exception as exc:  # shown in the chat, never crashes the server
            self.store.add(name, name, f"Could not finish: {exc}")
        finally:
            self.store.finish(name)
            self._notify(name)
        return ok

    def _manager_turn(self, text):
        manager = self.agents["manager"]
        if not self.store.try_start("manager", "Thinking…"):
            self.store.add("manager", "manager", "Still on the last request. Ask again in a minute.")
            self._notify("manager")
            return
        self._notify("manager")
        handoff = None
        try:
            roster = "\n".join(
                f"- {a.name}: {a.title}. {a.goal}" for a in self.agents.values() if a.name != "manager"
            )
            request = f"Agents you can hand work to:\n{roster}\n\nUser message:\n{text}"
            out, usage = self._run("manager", manager, self._prompt("manager", request))
            decision = parse_json_object(out) or {}
            target = decision.get("agent")
            if target in self.agents and target != "manager":
                task = str(decision.get("task") or text).strip()
                title = self.agents[target].title
                self.store.add("manager", "manager", f"Sending this to {title}: {task}", meta=usage)
                handoff = (target, task)
            else:
                reply = str(decision.get("reply") or out or "(no answer)").strip()
                self.store.add("manager", "manager", reply, meta=usage)
        except Exception as exc:
            self.store.add("manager", "manager", f"Could not finish: {exc}")
        finally:
            self.store.finish("manager")
            self._notify("manager")
        if handoff:
            self._handoff(*handoff)

    def _handoff(self, name, task):
        self.store.add(name, "manager", task)
        self._notify(name)
        ok = self._agent_turn(name, task)
        title = self.agents[name].title
        self.store.add(
            "manager",
            "manager",
            f"{title} has answered. Open its chat." if ok else f"{title} could not finish. Open its chat.",
        )
        self._notify("manager", name)
