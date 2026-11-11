// SQLite storage for chats: messages, read markers, per-chat working state and per-run usage.
// Uses node:sqlite (built into Node 22+), so there is nothing to install or compile.
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
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
`;

export interface Message {
  id: number;
  chat: string;
  sender: string;
  kind: string;
  body: string;
  status: string;
  created: number;
  meta: Record<string, any> | null;
}

type Row = Record<string, any>;
const now = () => Date.now() / 1000;

function toMessage(row: Row): Message {
  let meta: Record<string, any> | null = null;
  try {
    meta = row.meta ? JSON.parse(row.meta) : null;
  } catch {
    meta = null;
  }
  return { ...(row as any), meta };
}

export class Store {
  db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const columns = (table: string) => this.db.prepare(`pragma table_info(${table})`).all().map((r: Row) => r.name);
    if (!columns("messages").includes("meta")) this.db.exec("alter table messages add column meta text not null default ''");
    const usageColumns = columns("usage_log");
    for (const column of ["cache_read", "cache_write", "cache_ttl"]) {
      if (!usageColumns.includes(column)) this.db.exec(`alter table usage_log add column ${column} integer not null default 0`);
    }
    // Usage used to live only on messages. Copy it over once so clearing a chat keeps the totals.
    if (!this.db.prepare("select 1 from usage_log limit 1").get()) {
      for (const row of this.db.prepare("select chat, created, meta from messages where meta!='' order by id").all() as Row[]) {
        this.logUsage(row.chat, row.created, row.meta);
      }
    }
    // A crash can leave "working" set; nothing is running at startup.
    this.db.exec("update state set working=0, detail=''");
  }

  private logUsage(chat: string, created: number, rawMeta: string): void {
    let meta: Row;
    try {
      meta = JSON.parse(rawMeta);
    } catch {
      return;
    }
    this.db
      .prepare(
        "insert into usage_log(chat,created,cost,tokens_in,tokens_out,seconds,model,cache_read,cache_write,cache_ttl) values(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        chat,
        created,
        Number(meta.cost || 0),
        Math.trunc(Number(meta.in || 0)),
        Math.trunc(Number(meta.out || 0)),
        Number(meta.seconds || 0),
        String(meta.model || ""),
        Math.trunc(Number(meta.cache_read || 0)),
        Math.trunc(Number(meta.cache_write || 0)),
        Math.trunc(Number(meta.cache_ttl || 0)),
      );
  }

  add(chat: string, sender: string, body: string, kind = "text", status = "", meta: Record<string, any> | null = null): Message {
    const created = now();
    const rawMeta = meta && Object.keys(meta).length ? JSON.stringify(meta) : "";
    const result = this.db
      .prepare("insert into messages(chat,sender,kind,body,status,created,meta) values(?,?,?,?,?,?,?)")
      .run(chat, sender, kind, body, status, created, rawMeta);
    if (meta && ("cost" in meta || "in" in meta)) this.logUsage(chat, created, rawMeta); // a reply with only steps is not a counted run
    return this.message(Number(result.lastInsertRowid))!;
  }

  getJson<T = any>(key: string, fallback: T | null = null): T | null {
    const row = this.db.prepare("select value from kv where key=?").get(key) as Row | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.db
      .prepare("insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  /** Delete every message in a chat (usage totals are kept). Returns how many were deleted. */
  clear(chat: string): number {
    const result = this.db.prepare("delete from messages where chat=?").run(chat);
    this.db.prepare("delete from reads where chat=?").run(chat);
    return Number(result.changes);
  }

  /** Delete everything stored for one chat: messages, read marks, usage history and the saved summary. */
  wipe(chat: string): number {
    const result = this.db.prepare("delete from messages where chat=?").run(chat);
    this.db.prepare("delete from reads where chat=?").run(chat);
    this.db.prepare("delete from usage_log where chat=?").run(chat);
    this.db.prepare("delete from kv where key=?").run("summary:" + chat);
    return Number(result.changes);
  }

  /** How many text/approval messages a chat holds (status notes are not counted). */
  count(chat: string): number {
    return Number((this.db.prepare("select count(*) c from messages where chat=? and kind!='status'").get(chat) as Row).c);
  }

  message(id: number): Message | null {
    const row = this.db.prepare("select * from messages where id=?").get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  messages(chat: string, limit = 300): Message[] {
    const rows = this.db
      .prepare("select * from (select * from messages where chat=? order by id desc limit ?) order by id")
      .all(chat, limit) as Row[];
    return rows.map(toMessage);
  }

  last(chat: string): Message | null {
    const row = this.db.prepare("select * from messages where chat=? order by id desc limit 1").get(chat) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  /** The last n text/approval messages as [sender, body], oldest first. */
  recent(chat: string, n = 10): [string, string][] {
    const rows = this.db
      .prepare("select sender, body from messages where chat=? and kind!='status' order by id desc limit ?")
      .all(chat, n) as Row[];
    return rows.reverse().map((r) => [r.sender, r.body]);
  }

  /** Totals for this chat's agent runs: all time, and since local midnight. */
  usage(chat: string): Record<string, any> {
    const rows = this.db
      .prepare(
        "select created, cost, tokens_in, tokens_out, seconds, model, cache_read, cache_write, cache_ttl from usage_log where chat=? order by id",
      )
      .all(chat) as Row[];
    const d = new Date();
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
    const total: Record<string, any> = { runs: 0, cost: 0, tokens: 0, out: 0, seconds: 0, model: "", today_runs: 0, today_cost: 0 };
    for (const row of rows) {
      total.runs += 1;
      total.cost += row.cost;
      total.tokens += row.tokens_in + row.tokens_out;
      total.out += row.tokens_out;
      total.seconds += row.seconds;
      total.model = row.model || total.model;
      if (row.created >= midnight) {
        total.today_runs += 1;
        total.today_cost += row.cost;
      }
    }
    total.cost = Math.round(total.cost * 1e4) / 1e4;
    total.today_cost = Math.round(total.today_cost * 1e4) / 1e4;
    total.seconds = Math.round(total.seconds * 10) / 10;
    total.cache = cacheSummary(rows);
    return total;
  }

  unread(chat: string): number {
    const row = this.db
      .prepare(
        "select count(*) c from messages where chat=? and sender!='you' and kind!='status' and id > coalesce((select last_id from reads where chat=?), 0)",
      )
      .get(chat, chat) as Row;
    return Number(row.c);
  }

  /** How many drafts in this chat are still waiting for approval. */
  pending(chat: string): number {
    return Number(
      (this.db.prepare("select count(*) c from messages where chat=? and kind='approval' and status='pending'").get(chat) as Row).c,
    );
  }

  /** Mark messages up to id `upto` (default: the newest) as read. Never moves backwards. */
  markRead(chat: string, upto: number | null = null): void {
    if (upto === null) upto = Number((this.db.prepare("select max(id) m from messages where chat=?").get(chat) as Row).m || 0);
    this.db
      .prepare("insert into reads(chat,last_id) values(?,?) on conflict(chat) do update set last_id=max(last_id, excluded.last_id)")
      .run(chat, upto);
  }

  /** Mark a chat as working. Returns false if it already is (one run at a time). */
  tryStart(chat: string, detail = "working"): boolean {
    const row = this.db.prepare("select working from state where chat=?").get(chat) as Row | undefined;
    if (row && row.working) return false;
    this.db
      .prepare("insert into state(chat,working,detail) values(?,1,?) on conflict(chat) do update set working=1, detail=excluded.detail")
      .run(chat, detail);
    return true;
  }

  /** What a working chat is doing right now (shown in the list and header). */
  setDetail(chat: string, detail: string): void {
    this.db.prepare("update state set detail=? where chat=? and working=1").run(detail, chat);
  }

  finish(chat: string): void {
    this.db
      .prepare("insert into state(chat,working,detail) values(?,0,'') on conflict(chat) do update set working=0, detail=''")
      .run(chat);
  }

  working(chat: string): [boolean, string] {
    const row = this.db.prepare("select working, detail from state where chat=?").get(chat) as Row | undefined;
    return row ? [Boolean(row.working), row.detail] : [false, ""];
  }

  /** Approve or decline a pending approval message. Returns the message, or null. */
  resolve(id: number, decision: string): Message | null {
    if (decision !== "approved" && decision !== "declined") throw new Error("decision must be approved or declined");
    const result = this.db
      .prepare("update messages set status=? where id=? and kind='approval' and status='pending'")
      .run(decision, id);
    return Number(result.changes) === 1 ? this.message(id) : null;
  }
}

/** Estimated cache status for a chat from its runs. null when there are no runs. An estimate: the real cache lives on Anthropic's side. */
function cacheSummary(rows: Row[]): Record<string, any> | null {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const ttl = [...rows].reverse().find((r) => r.cache_ttl)?.cache_ttl || 0;
  const totalIn = rows.reduce((a, r) => a + r.tokens_in, 0);
  const totalRead = rows.reduce((a, r) => a + r.cache_read, 0);
  return {
    last_at: last.created,
    ttl,
    warm_until: ttl ? last.created + ttl : null,
    last_read: last.cache_read,
    last_write: last.cache_write,
    last_hit: last.tokens_in ? last.cache_read / last.tokens_in : null,
    hit: totalIn ? totalRead / totalIn : null,
  };
}
