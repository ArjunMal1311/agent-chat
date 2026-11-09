import http.client
import json
import tempfile
import threading
import time
import unittest

from agentchat.agents import Agent
from agentchat.bus import Bus
from agentchat.hub import Hub
from agentchat.server import make_server
from agentchat.store import Store


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        agents = {
            "manager": Agent("manager", title="Manager"),
            "planner": Agent("planner", title="Planner", goal="Plans the day"),
        }
        cls.hub = Hub(Store(), agents, Bus(), lambda agent, prompt: "reply from planner", tempfile.mkdtemp())
        cls.server = make_server(cls.hub, "127.0.0.1", 0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def call(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = dict(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            hdrs.setdefault("Content-Type", "application/json")
        if host is not None:
            conn.putrequest(method, path, skip_host=True)
            conn.putheader("Host", host)
            for k, v in hdrs.items():
                conn.putheader(k, v)
            conn.putheader("Content-Length", str(len(data or b"")))
            conn.endheaders(data)
        else:
            conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            return resp.status, json.loads(raw)
        except ValueError:
            return resp.status, raw

    def test_chats_are_listed(self):
        status, data = self.call("GET", "/api/chats")
        self.assertEqual(status, 200)
        self.assertEqual({c["name"] for c in data["chats"]}, {"manager", "planner"})

    def test_page_is_served(self):
        status, body = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Agent Chat", body)

    def test_post_without_the_custom_header_is_refused(self):
        status, _ = self.call("POST", "/api/send", {"chat": "planner", "text": "hi"})
        self.assertEqual(status, 403)

    def test_wrong_host_is_refused(self):
        status, _ = self.call("GET", "/api/chats", host="evil.example")
        self.assertEqual(status, 403)

    def test_send_and_read_back(self):
        status, _ = self.call("POST", "/api/send", {"chat": "planner", "text": "hello"}, {"X-Agent-Chat": "1"})
        self.assertEqual(status, 200)
        end = time.time() + 3
        messages = []
        while time.time() < end:
            _, data = self.call("GET", "/api/messages?chat=planner")
            messages = data["messages"]
            if any(m["sender"] == "planner" for m in messages):
                break
            time.sleep(0.05)
        self.assertEqual([m["sender"] for m in messages][:2], ["you", "planner"])
        _, chats = self.call("GET", "/api/chats")
        planner = next(c for c in chats["chats"] if c["name"] == "planner")
        self.assertEqual(planner["unread"], 0)  # reading the chat marks it read

    def test_bad_requests_get_400_or_404(self):
        self.assertEqual(self.call("POST", "/api/send", {"chat": "nobody", "text": "x"}, {"X-Agent-Chat": "1"})[0], 400)
        self.assertEqual(self.call("POST", "/api/approve", {"id": 9999, "decision": "approved"}, {"X-Agent-Chat": "1"})[0], 400)
        self.assertEqual(self.call("GET", "/api/messages?chat=nobody")[0], 404)

    def test_limits_endpoints(self):
        status, data = self.call("GET", "/api/limits")
        self.assertEqual(status, 200)
        self.assertIn("windows", data["limits"])
        self.assertEqual(self.call("POST", "/api/limits/refresh", {})[0], 403)  # needs the header
        status, data = self.call("POST", "/api/limits/refresh", {}, {"X-Agent-Chat": "1"})
        self.assertEqual(status, 200)
        self.assertIn("limits", data)

    def test_clear_and_forget_endpoints(self):
        hdr = {"X-Agent-Chat": "1"}
        self.assertEqual(self.call("POST", "/api/clear", {"chat": "manager"})[0], 403)  # needs the header
        self.hub.store.add("manager", "you", "to be cleared")
        status, data = self.call("POST", "/api/clear", {"chat": "manager"}, hdr)
        self.assertEqual((status, data["deleted"]), (200, 1))
        self.assertEqual(self.call("POST", "/api/clear", {"chat": "nobody"}, hdr)[0], 400)
        self.assertEqual(self.call("POST", "/api/forget", {"chat": "manager"}, hdr)[0], 200)
        self.assertEqual(self.call("POST", "/api/forget", {"chat": "nobody"}, hdr)[0], 400)

    def test_files_outside_static_are_not_served(self):
        self.assertEqual(self.call("GET", "/../README.md")[0], 404)
        self.assertEqual(self.call("GET", "/%2e%2e/README.md")[0], 404)


if __name__ == "__main__":
    unittest.main()
