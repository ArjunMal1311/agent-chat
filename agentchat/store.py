"""SQLite storage for chats: messages, read markers, per-chat working state and per-run usage."""
import json
import sqlite3
import threading
import time

SCHEMA = """
create table if not exists messages(
  id integer primary key autoincrement,
  chat text not null,
  sender text not null,
  kind text not null default 'text',
  body text not null,
  status text not null default '',
  created real not null,
  meta text not null default ''
);
create index if not exists messages_chat on messages(chat, id);
create table if not exists reads(chat text primary key, last_id integer not null default 0);
create table if not exists state(chat text primary key, working integer not null default 0, detail text not null default '');
create table if not exists usage_log(
  id integer primary key autoincrement,
  chat text not null,
  created real not null,
  cost real not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  seconds real not null default 0,
  model text not null default '',
  cache_read integer not null default 0,
  cache_write integer not null default 0,
  cache_ttl integer not null default 0
);
create index if not exists usage_chat on usage_log(chat, id);
create table if not exists kv(key text primary key, value text not null);
"""


def _row(row):
    """A message row as a dict; `meta` (usage JSON text) becomes a dict or None."""
    data = dict(row)
    raw = data.get("meta") or ""
    try:
        data["meta"] = json.loads(raw) if raw else None
    except ValueError:
        data["meta"] = None
    return data


class Store:
    def __init__(self, path=":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript(SCHEMA)
            columns = [r["name"] for r in self.db.execute("pragma table_info(messages)")]
            if "meta" not in columns:  # database made before usage tracking existed
                self.db.execute("alter table messages add column meta text not null default ''")
            usage_columns = [r["name"] for r in self.db.execute("pragma table_info(usage_log)")]
            for column in ("cache_read", "cache_write", "cache_ttl"):  # added after the table first existed
                if column not in usage_columns:
                    self.db.execute(f"alter table usage_log add column {column} integer not null default 0")
            # Usage used to live only on messages. Copy it over once so clearing a chat keeps the totals.
            if not self.db.execute("select 1 from usage_log limit 1").fetchone():
                for row in self.db.execute("select chat, created, meta from messages where meta!='' order by id").fetchall():
                    self._log_usage(row["chat"], row["created"], row["meta"])
            # A crash can leave "working" set; nothing is running at startup.
            self.db.execute("update state set working=0, detail=''")
            self.db.commit()

    def _log_usage(self, chat, created, raw_meta):
        try:
            meta = json.loads(raw_meta)
        except ValueError:
            return
        self.db.execute(
            "insert into usage_log(chat,created,cost,tokens_in,tokens_out,seconds,model,cache_read,cache_write,cache_ttl)"
            " values(?,?,?,?,?,?,?,?,?,?)",
            (
                chat,
                created,
                float(meta.get("cost") or 0),
                int(meta.get("in") or 0),
                int(meta.get("out") or 0),
                float(meta.get("seconds") or 0),
                str(meta.get("model") or ""),
                int(meta.get("cache_read") or 0),
                int(meta.get("cache_write") or 0),
                int(meta.get("cache_ttl") or 0),
            ),
        )

    def add(self, chat, sender, body, kind="text", status="", meta=None):
        with self.lock:
            now = time.time()
            raw_meta = json.dumps(meta) if meta else ""
            cur = self.db.execute(
                "insert into messages(chat,sender,kind,body,status,created,meta) values(?,?,?,?,?,?,?)",
                (chat, sender, kind, body, status, now, raw_meta),
            )
            if meta and ("cost" in meta or "in" in meta):  # a reply with only steps is not a counted run
                self._log_usage(chat, now, raw_meta)
            self.db.commit()
            return self.message(cur.lastrowid)

    def get_json(self, key, default=None):
        with self.lock:
            row = self.db.execute("select value from kv where key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except ValueError:
            return default

    def set_json(self, key, value):
        with self.lock:
            self.db.execute(
                "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value",
                (key, json.dumps(value)),
            )
            self.db.commit()

    def clear(self, chat):
        """Delete every message in a chat (usage totals are kept). Returns how many were deleted."""
        with self.lock:
            cur = self.db.execute("delete from messages where chat=?", (chat,))
            self.db.execute("delete from reads where chat=?", (chat,))
            self.db.commit()
            return cur.rowcount

    def message(self, mid):
        with self.lock:
            row = self.db.execute("select * from messages where id=?", (mid,)).fetchone()
        return _row(row) if row else None

    def messages(self, chat, limit=300):
        with self.lock:
            rows = self.db.execute(
                "select * from (select * from messages where chat=? order by id desc limit ?) order by id",
                (chat, limit),
            ).fetchall()
        return [_row(r) for r in rows]

    def last(self, chat):
        with self.lock:
            row = self.db.execute(
                "select * from messages where chat=? order by id desc limit 1", (chat,)
            ).fetchone()
        return _row(row) if row else None

    def recent(self, chat, n=10):
        """The last n text/approval messages as (sender, body), oldest first."""
        with self.lock:
            rows = self.db.execute(
                "select sender, body from messages where chat=? and kind!='status' order by id desc limit ?",
                (chat, n),
            ).fetchall()
        return [(r["sender"], r["body"]) for r in reversed(rows)]

    def usage(self, chat):
        """Totals for this chat's agent runs: all time, and since local midnight."""
        with self.lock:
            rows = self.db.execute(
                "select created, cost, tokens_in, tokens_out, seconds, model, cache_read, cache_write, cache_ttl"
                " from usage_log where chat=? order by id",
                (chat,),
            ).fetchall()
        now = time.localtime()
        midnight = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, 0, 0, 0, 0, 0, -1))
        total = {"runs": 0, "cost": 0.0, "tokens": 0, "out": 0, "seconds": 0.0, "model": "", "today_runs": 0, "today_cost": 0.0}
        for row in rows:
            total["runs"] += 1
            total["cost"] += row["cost"]
            total["tokens"] += row["tokens_in"] + row["tokens_out"]
            total["out"] += row["tokens_out"]
            total["seconds"] += row["seconds"]
            total["model"] = row["model"] or total["model"]
            if row["created"] >= midnight:
                total["today_runs"] += 1
                total["today_cost"] += row["cost"]
        total["cost"] = round(total["cost"], 4)
        total["today_cost"] = round(total["today_cost"], 4)
        total["seconds"] = round(total["seconds"], 1)
        total["cache"] = self._cache_summary(rows)
        return total

    @staticmethod
    def _cache_summary(rows):
        """Estimated cache status for a chat from its runs. None when there are no runs.

        Warm means the last run is still inside the cache window its writes were given (1 hour or
        5 minutes), so the next run can reuse the start of the prompt. This is an estimate: the real
        cache lives on Anthropic's side and cannot be queried."""
        if not rows:
            return None
        last = rows[-1]
        ttl = next((r["cache_ttl"] for r in reversed(rows) if r["cache_ttl"]), 0)
        total_in = sum(r["tokens_in"] for r in rows)
        total_read = sum(r["cache_read"] for r in rows)
        return {
            "last_at": last["created"],
            "ttl": ttl,
            "warm_until": last["created"] + ttl if ttl else None,
            "last_read": last["cache_read"],
            "last_write": last["cache_write"],
            "last_hit": last["cache_read"] / last["tokens_in"] if last["tokens_in"] else None,
            "hit": total_read / total_in if total_in else None,
        }

    def unread(self, chat):
        with self.lock:
            row = self.db.execute(
                "select count(*) c from messages where chat=? and sender!='you' and kind!='status' "
                "and id > coalesce((select last_id from reads where chat=?), 0)",
                (chat, chat),
            ).fetchone()
        return row["c"]

    def pending(self, chat):
        """How many drafts in this chat are still waiting for approval."""
        with self.lock:
            row = self.db.execute(
                "select count(*) c from messages where chat=? and kind='approval' and status='pending'", (chat,)
            ).fetchone()
        return row["c"]

    def mark_read(self, chat, upto=None):
        """Mark messages up to id `upto` (default: the newest) as read. Never moves backwards."""
        with self.lock:
            if upto is None:
                upto = self.db.execute("select max(id) m from messages where chat=?", (chat,)).fetchone()["m"] or 0
            self.db.execute(
                "insert into reads(chat,last_id) values(?,?) "
                "on conflict(chat) do update set last_id=max(last_id, excluded.last_id)",
                (chat, upto),
            )
            self.db.commit()

    def try_start(self, chat, detail="working"):
        """Mark a chat as working. Returns False if it already is (one run at a time)."""
        with self.lock:
            row = self.db.execute("select working from state where chat=?", (chat,)).fetchone()
            if row and row["working"]:
                return False
            self.db.execute(
                "insert into state(chat,working,detail) values(?,1,?) "
                "on conflict(chat) do update set working=1, detail=excluded.detail",
                (chat, detail),
            )
            self.db.commit()
            return True

    def set_detail(self, chat, detail):
        """What a working chat is doing right now (shown in the list and header)."""
        with self.lock:
            self.db.execute("update state set detail=? where chat=? and working=1", (detail, chat))
            self.db.commit()

    def finish(self, chat):
        with self.lock:
            self.db.execute(
                "insert into state(chat,working,detail) values(?,0,'') "
                "on conflict(chat) do update set working=0, detail=''",
                (chat,),
            )
            self.db.commit()

    def working(self, chat):
        with self.lock:
            row = self.db.execute("select working, detail from state where chat=?", (chat,)).fetchone()
        return (bool(row["working"]), row["detail"]) if row else (False, "")

    def resolve(self, mid, decision):
        """Approve or decline a pending approval message. Returns the message, or None."""
        if decision not in ("approved", "declined"):
            raise ValueError("decision must be approved or declined")
        with self.lock:
            cur = self.db.execute(
                "update messages set status=? where id=? and kind='approval' and status='pending'",
                (decision, mid),
            )
            self.db.commit()
            if cur.rowcount != 1:
                return None
            return self.message(mid)
