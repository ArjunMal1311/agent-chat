"""HTTP server (standard library only): the chat page, a small JSON API, and a live event stream."""
import json
import mimetypes
import queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .runner import RunError

MAX_BODY = 64 * 1024
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def chat_summary(hub, name):
    agent = hub.agents[name]
    working, detail = hub.store.working(name)
    last = hub.store.last(name)
    return {
        "name": name,
        "title": agent.title,
        "goal": agent.goal,
        "approval": agent.approval,
        "model": agent.model,
        "usage": hub.store.usage(name),
        "notes": hub.notes_count(name),
        "steps": hub.live_steps(name) if working else [],
        "working": working,
        "detail": detail,
        "unread": hub.store.unread(name),
        "pending": hub.store.pending(name),
        "last": last
        and {
            "sender": last["sender"],
            "body": last["body"][:140],
            "kind": last["kind"],
            "created": last["created"],
        },
    }


def make_handler(hub, allowed_hosts):
    class Handler(BaseHTTPRequestHandler):
        server_version = "agentchat"

        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        # ---- plumbing --------------------------------------------------------------------
        def _host_ok(self):
            return (self.headers.get("Host") or "").lower() in allowed_hosts

        def _json(self, payload, status=200):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status, message):
            self._json({"error": message}, status)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ValueError("body too large")
            return json.loads(self.rfile.read(length) or b"{}")

        # ---- routes ----------------------------------------------------------------------
        def do_GET(self):
            if not self._host_ok():
                return self._error(403, "bad host")
            url = urlparse(self.path)
            if url.path == "/api/chats":
                chats = [chat_summary(hub, n) for n in hub.agents]
                chats.sort(key=lambda c: (c["last"] or {}).get("created", 0), reverse=True)
                return self._json({"chats": chats})
            if url.path == "/api/messages":
                chat = (parse_qs(url.query).get("chat") or [""])[0]
                if chat not in hub.agents:
                    return self._error(404, "unknown chat")
                messages = hub.store.messages(chat)
                # Only what is being returned counts as read; a reply landing right now stays unread.
                hub.store.mark_read(chat, messages[-1]["id"] if messages else 0)
                return self._json({"chat": chat_summary(hub, chat), "messages": messages})
            if url.path == "/api/limits":
                return self._json({"limits": hub.limits()})
            if url.path == "/events":
                return self._events()
            return self._static(url.path)

        def do_POST(self):
            if not self._host_ok():
                return self._error(403, "bad host")
            # A custom header cannot be sent cross-site without a CORS preflight we never answer.
            if self.headers.get("X-Agent-Chat") != "1":
                return self._error(403, "missing header")
            try:
                data = self._body()
                path = urlparse(self.path).path
                if path == "/api/send":
                    msg = hub.send(str(data.get("chat", "")), str(data.get("text", "")))
                    return self._json({"message": msg})
                if path == "/api/approve":
                    msg = hub.approve(int(data.get("id")), str(data.get("decision", "")))
                    return self._json({"message": msg})
                if path == "/api/clear":
                    return self._json({"deleted": hub.clear_chat(str(data.get("chat", "")))})
                if path == "/api/forget":
                    hub.forget_notes(str(data.get("chat", "")))
                    return self._json({"ok": True})
                if path == "/api/limits/refresh":
                    usage = hub.refresh_limits()
                    return self._json({"usage": usage, "limits": hub.limits()})
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self._error(400, str(exc))
            except RunError as exc:
                return self._error(502, str(exc))
            return self._error(404, "not found")

        def _events(self):
            q = hub.bus.subscribe()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        event = q.get(timeout=15)
                        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                hub.bus.unsubscribe(q)

        def _static(self, path):
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            target = (STATIC_DIR / name).resolve()
            if STATIC_DIR not in target.parents or not target.is_file():
                return self._error(404, "not found")
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def make_server(hub, host="127.0.0.1", port=8765):
    server = ThreadingHTTPServer((host, port), BaseHTTPRequestHandler)
    real_port = server.server_address[1]
    allowed = {f"127.0.0.1:{real_port}", f"localhost:{real_port}"}
    server.RequestHandlerClass = make_handler(hub, allowed)
    server.daemon_threads = True
    return server
