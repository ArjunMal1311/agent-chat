"""Runs one agent turn through the Claude Code CLI (`claude -p`), streaming what it does as it goes."""
import json
import subprocess
import threading
from dataclasses import dataclass, field

RULES = (
    "\n\nYou are an agent in a chat app. Reply the way you would in a chat message: short, plain, "
    "no preamble. Never send, post, publish or message anyone yourself: you only prepare drafts and "
    "answers for the user, who sends everything by hand. If you learn something worth remembering "
    "for next time, add a separate line starting with REMEMBER: and the note."
)

# Agents never need skills or MCP servers, and loading them adds thousands of tokens to every call
# (measured on this machine: about 62k tokens down to about 49k for a one-word reply).
LEAN_FLAGS = ["--disable-slash-commands", "--strict-mcp-config", "--exclude-dynamic-system-prompt-sections"]


class RunError(Exception):
    pass


@dataclass
class RunResult:
    text: str
    usage: dict = field(default_factory=dict)


def extract_usage(data):
    """Boil Claude Code's JSON result down to the few numbers the chat shows."""
    usage = data.get("usage") or {}
    models = sorted((data.get("modelUsage") or {}).keys())
    tokens_in = (
        (usage.get("input_tokens") or 0)
        + (usage.get("cache_creation_input_tokens") or 0)
        + (usage.get("cache_read_input_tokens") or 0)
    )
    created = usage.get("cache_creation") or {}
    one_hour = created.get("ephemeral_1h_input_tokens") or 0
    five_min = created.get("ephemeral_5m_input_tokens") or 0
    return {
        "model": ", ".join(models),
        "cost": round(float(data.get("total_cost_usd") or 0), 4),
        "in": tokens_in,
        "cache_read": usage.get("cache_read_input_tokens") or 0,
        "cache_write": usage.get("cache_creation_input_tokens") or 0,
        # how long what this run wrote to the cache stays warm: 1 hour or 5 minutes (0 = it wrote nothing)
        "cache_ttl": 3600 if one_hour else (300 if five_min else 0),
        "out": usage.get("output_tokens") or 0,
        "seconds": round((data.get("duration_ms") or 0) / 1000, 1),
        "turns": data.get("num_turns") or 1,
    }


# ---- describing steps in plain words -------------------------------------------------------
def _short_path(path):
    parts = [p for p in str(path or "").split("/") if p]
    return "/".join(parts[-2:]) if parts else "a file"


def describe_tool(name, tool_input):
    tool_input = tool_input or {}
    if name == "Read":
        return "Reading " + _short_path(tool_input.get("file_path"))
    if name == "Grep":
        return "Searching for “" + str(tool_input.get("pattern", ""))[:50] + "”"
    if name == "Glob":
        return "Finding files " + str(tool_input.get("pattern", ""))[:50]
    if name == "Bash":
        return "Running " + " ".join(str(tool_input.get("command", "")).split())[:90]
    if name in ("Edit", "Write", "NotebookEdit"):
        return "Editing " + _short_path(tool_input.get("file_path"))
    if name in ("WebSearch", "WebFetch"):
        return f"{name} " + str(tool_input.get("query") or tool_input.get("url") or "")[:70]
    return f"Using {name}"


def describe_event(event):
    """Steps (short plain strings) a stream event stands for. Most events stand for none."""
    kind = event.get("type")
    content = (event.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    steps = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if kind == "assistant" and block.get("type") == "tool_use":
            steps.append(describe_tool(block.get("name"), block.get("input")))
        elif kind == "user" and block.get("type") == "tool_result" and block.get("is_error"):
            detail = block.get("content")
            if isinstance(detail, list):
                detail = " ".join(str(b.get("text", "")) for b in detail if isinstance(b, dict))
            steps.append("That step failed: " + " ".join(str(detail or "").split())[:80])
    return steps


# ---- reading claude's output -----------------------------------------------------------------
def parse_claude_output(stdout):
    """`claude -p --output-format json` prints one JSON object; hooks may print other lines around it."""
    for line in reversed(stdout.strip().splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and "result" in data:
            return _result_from(data)
    raise RunError("could not read claude's answer: " + stdout.strip()[:300])


def _result_from(data):
    if data.get("is_error"):
        raise RunError(str(data.get("result") or "claude reported an error")[:500])
    return RunResult(str(data.get("result") or "").strip(), extract_usage(data))


def run_claude(agent, prompt, on_step=None, on_limits=None):
    """Run one turn. `on_step(text)` is called for each step as it happens (reading a file, running a command).
    `on_limits(info)` gets Claude Code's plan-limit reports (the 5-hour and 7-day windows) as they arrive."""
    cmd = [
        "claude", "-p", "--output-format", "stream-json", "--verbose",
        *LEAN_FLAGS, "--append-system-prompt", agent.prompt + RULES,
    ]
    if agent.model:
        cmd += ["--model", agent.model]
    if agent.tools:
        cmd += ["--allowedTools", ",".join(agent.tools)]
    try:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, cwd=agent.cwd or None, bufsize=1,
        )
    except FileNotFoundError:
        raise RunError("the `claude` command was not found on PATH")

    timed_out = threading.Event()

    def expire():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(agent.timeout, expire)
    timer.start()
    result, noise = None, []
    try:
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except BrokenPipeError:
            pass
        for raw in proc.stdout:
            line = raw.strip()
            if not line.startswith("{"):
                noise.append(line)
                continue
            try:
                event = json.loads(line)
            except ValueError:
                noise.append(line)
                continue
            if event.get("type") == "result":
                result = event
            elif event.get("type") == "rate_limit_event":
                if on_limits and isinstance(event.get("rate_limit_info"), dict):
                    on_limits(event["rate_limit_info"])
            elif on_step:
                for step in describe_event(event):
                    on_step(step)
        proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
    if timed_out.is_set():
        raise RunError(f"timed out after {agent.timeout}s")
    if result is None:
        tail = " ".join(n for n in noise if n)[-400:]
        raise RunError(tail or f"claude exited with {proc.returncode} and no answer")
    return _result_from(result)
