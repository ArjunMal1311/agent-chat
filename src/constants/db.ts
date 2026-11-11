// The SQLite schema, applied on every start (every statement is `if not exists`).

export const SCHEMA = `
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
