"""Tiny publish/subscribe so the server can push "something changed" to every open browser tab."""
import queue
import threading


class Bus:
    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue()
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def publish(self, event):
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put(event)
