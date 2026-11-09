"""Run: python3 -m agentchat [--port 8765] [--agents agents] [--data data]"""
import argparse
from pathlib import Path

from .agents import load_agents
from .bus import Bus
from .hub import Hub
from .runner import run_claude
from .server import make_server
from .store import Store


def main():
    parser = argparse.ArgumentParser(description="WhatsApp-style chat for your agents (localhost only).")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--agents", default="agents")
    parser.add_argument("--data", default="data")
    args = parser.parse_args()

    data = Path(args.data)
    data.mkdir(parents=True, exist_ok=True)
    agents = load_agents(args.agents)
    if not agents:
        raise SystemExit(f"No agent files found in {args.agents}/")
    hub = Hub(Store(str(data / "chat.db")), agents, Bus(), run_claude, data)
    server = make_server(hub, "127.0.0.1", args.port)
    print(f"Agent chat on http://127.0.0.1:{server.server_address[1]}  ({len(agents)} agents). Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
