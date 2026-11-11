import type { RunMeta, Usage } from "./types";

export const fmtTime = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const fmtListTime = (epoch: number) => {
  const d = new Date(epoch * 1000);
  return d.toDateString() === new Date().toDateString() ? fmtTime(epoch) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};
export function dayLabel(epoch: number): string {
  const d = new Date(epoch * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
export const fmtMoney = (x: number) => "$" + (x < 0.1 ? x.toFixed(3) : x.toFixed(2));
export const shortModel = (model?: string) => String(model || "").replace(/claude-/g, "");
export function fmtCountdown(sec: number): string {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}
export const pctText = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);

export function runUsageText(u: RunMeta): string {
  const bits: string[] = [];
  if (u.model) bits.push(shortModel(u.model));
  bits.push(`${fmtTokens((u.in || 0) + (u.out || 0))} tokens (${fmtTokens(u.out || 0)} out)`);
  if (u.cost) bits.push(`~${fmtMoney(u.cost)}`); // Codex reports no cost, so nothing to show for it
  if (u.seconds) bits.push(`${u.seconds}s`);
  if (u.in && u.cache_read !== undefined) bits.push(`${Math.round((100 * u.cache_read) / u.in)}% cached`);
  return bits.join(" · ");
}

export function previewOf(c: { working: boolean; detail: string; last: { sender: string; body: string } | null; goal: string }) {
  if (c.working) return { text: c.detail || "working…", working: true };
  if (!c.last) return { text: c.goal || "No messages yet", working: false };
  const prefix = c.last.sender === "you" ? "You: " : "";
  const plain = c.last.body.replace(/^\s*[-*]\s+/gm, "").replace(/[*`#]/g, "").replace(/\s+/g, " ").trim();
  return { text: prefix + plain, working: false };
}

export type UsageLike = Pick<Usage, "runs">;
