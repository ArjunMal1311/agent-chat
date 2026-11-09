"""Agents are markdown files in agents/: a few `key: value` lines between --- fences, then the job prompt."""
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Agent:
    name: str
    title: str = ""
    goal: str = ""
    tools: list = field(default_factory=list)
    approval: bool = False
    cwd: str = ""
    timeout: int = 300
    model: str = ""
    prompt: str = ""


def parse(text, name):
    meta, body = {}, text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            for line in parts[1].splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    meta[key.strip().lower()] = value.strip()
            body = parts[2]
    return Agent(
        name=name,
        title=meta.get("title", name.title()),
        goal=meta.get("goal", ""),
        tools=[t.strip() for t in meta.get("tools", "").split(",") if t.strip()],
        approval=meta.get("approval", "false").lower() == "true",
        cwd=str(Path(meta["cwd"]).expanduser()) if meta.get("cwd") else "",
        timeout=int(meta.get("timeout", "300")),
        model=meta.get("model", ""),
        prompt=body.strip(),
    )


def load_agents(directory):
    """Return {name: Agent}, with 'manager' first when present."""
    found = {}
    for path in sorted(Path(directory).glob("*.md")):
        found[path.stem] = parse(path.read_text(encoding="utf-8"), path.stem)
    ordered = {}
    if "manager" in found:
        ordered["manager"] = found.pop("manager")
    ordered.update(found)
    return ordered
