export interface Usage {
  runs: number;
  cost: number;
  tokens: number;
  out: number;
  seconds: number;
  model: string;
  today_runs: number;
  today_cost: number;
  cache: Cache | null;
}
export interface Cache {
  last_at: number;
  ttl: number;
  warm_until: number | null;
  last_read: number;
  last_write: number;
  last_hit: number | null;
  hit: number | null;
}
export interface Chat {
  name: string;
  title: string;
  goal: string;
  approval: boolean;
  model: string;
  usage: Usage;
  notes: number;
  messages: number;
  summarized: boolean;
  steps: string[];
  working: boolean;
  detail: string;
  unread: number;
  pending: number;
  last: { sender: string; body: string; kind: string; created: number } | null;
}
export interface RunMeta {
  model?: string;
  cost?: number;
  in?: number;
  out?: number;
  seconds?: number;
  cache_read?: number;
  steps?: string[];
  post?: { dir: string; files: string[]; caption: string; slides: string[] };
  relay?: { agent: string; title: string; id: number | null; verdict: "ok" | "fix" | "failed" | "unchecked"; draft?: boolean };
}
export interface Message {
  id: number;
  chat: string;
  sender: string;
  kind: "text" | "approval" | "status";
  body: string;
  status: string;
  created: number;
  meta: RunMeta | null;
}
export interface LimitWindow {
  used: number;
  resets_at: number | null;
  status?: string;
  label?: string;
}
export interface Limits {
  windows: Record<string, LimitWindow>;
  updated: number | null;
}
export interface CodexLimits {
  plan?: string;
  windows: LimitWindow[];
  updated?: number | null;
  error?: string;
}
export interface AgentOptions {
  enabled: boolean;
  tools: { id: string; label: string }[];
  models: string[];
  cwd: string;
}
