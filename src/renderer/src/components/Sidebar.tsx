import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { USAGE_NOTE } from "../../../constants/ui";
import { fmtCountdown, fmtListTime, fmtMoney, previewOf } from "../lib/format";
import { useStore } from "../store";
import type { Chat, LimitWindow } from "../lib/types";

function ChatRow({ c }: { c: Chat }) {
  const current = useStore((s) => s.current);
  const openChat = useStore((s) => s.openChat);
  const p = previewOf(c);
  return (
    <li
      className={"chat" + (c.name === current ? " active" : "") + (c.unread ? " unread" : "") + (c.working ? " working" : "")}
      tabIndex={0}
      onClick={() => void openChat(c.name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openChat(c.name);
        }
      }}
    >
      <Avatar name={c.name} working={c.working} />
      <div className="body">
        <div className="top">
          <span className="name">{c.title}</span>
          <span className="time">{c.last ? fmtListTime(c.last.created) : ""}</span>
        </div>
        <div className="bottom">
          <span className={"preview" + (p.working ? " working" : "")}>{p.text}</span>
          <span className="tags">
            {c.pending ? <span className="pill">{c.pending} draft{c.pending > 1 ? "s" : ""}</span> : null}
            {c.unread ? <span className="badge">{c.unread}</span> : null}
          </span>
        </div>
      </div>
    </li>
  );
}

const level = (w?: LimitWindow | null) => (!w ? "" : w.used >= 0.85 ? " high" : w.used >= 0.6 ? " warn" : "");

/** One limit on one line: label, thin bar, percent, time to reset. */
function LimitRow({ label, w }: { label: string; w?: LimitWindow | null }) {
  if (!w)
    return (
      <div className="ub-line">
        <span className="ub-label">{label}</span>
        <span className="ub-note">no data yet</span>
      </div>
    );
  const left = w.resets_at ? w.resets_at - Date.now() / 1000 : null;
  if (left !== null && left <= 0)
    return (
      <div className="ub-line">
        <span className="ub-label">{label}</span>
        <span className="ub-note">reset since the last check</span>
      </div>
    );
  const pct = Math.round(w.used * 100);
  return (
    <div className={"ub-line" + level(w)} title={left === null ? undefined : `${label}: resets in ${fmtCountdown(left)}`}>
      <span className="ub-label">{label}</span>
      <div className="ub-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(pct, 100)} aria-label={`${label} usage`}>
        <i style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="ub-pct">{pct}%</span>
      <span className="ub-reset">{left === null ? "" : fmtCountdown(left)}</span>
    </div>
  );
}

const minutesAgo = (updated: number) => Math.floor((Date.now() / 1000 - updated) / 60);
const agoText = (mins: number | null) => (mins === null ? "" : mins < 1 ? "just now" : `${mins} min ago`);

function RefreshButton({ title, onRun }: { title: string; onRun: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={"ub-refresh" + (busy ? " busy" : "")}
      type="button"
      title={title}
      aria-label={title}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRun();
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const readCollapsed = () => {
  try {
    return localStorage.getItem("usageCollapsed") === "1";
  } catch {
    return false;
  }
};

function UsageBar() {
  const { limits, codex, refreshClaudeLimits, refreshCodexLimits } = useStore();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const five = limits.windows.five_hour;
  const week = limits.windows.seven_day;
  const claudeAge = limits.updated ? minutesAgo(limits.updated) : null;
  const codexAge = codex?.updated ? minutesAgo(codex.updated) : null;
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("usageCollapsed", next ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
  // Folded: one line with every number, so the panel costs a single row.
  const summary: { key: string; text: string; w?: LimitWindow | null }[] = [
    { key: "5h", text: "5h", w: five },
    { key: "7d", text: "7d", w: week },
    ...(codex?.windows ?? []).map((w) => ({ key: "codex-" + w.label, text: "Codex", w })),
  ];
  return (
    <footer id="usagebar" className={"usagebar" + (collapsed ? " collapsed" : "")} role="status" aria-label="Plan usage">
      <button className="ub-head" type="button" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? "Show plan usage" : "Hide plan usage"}>
        <svg className="ub-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="ub-title">Plan usage</span>
        {collapsed ? (
          <span className="ub-mini">
            {summary.map((s) => (
              <span key={s.key} className={"ub-chip" + level(s.w)}>
                {s.text} {s.w ? Math.round(s.w.used * 100) + "%" : "–"}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <>
          <div className="ub-group">
            <span className="ub-group-name">Claude</span>
            <span className={"ub-age" + (claudeAge !== null && claudeAge >= 30 ? " stale" : "")} title={claudeAge !== null && claudeAge >= 30 ? "May be out of date" : undefined}>
              {claudeAge === null ? "updates after any agent runs" : agoText(claudeAge)}
            </span>
            <RefreshButton title="Refresh Claude usage: runs one tiny call, which uses a little usage itself" onRun={refreshClaudeLimits} />
          </div>
          <LimitRow label="5-hour" w={five} />
          <LimitRow label="7-day" w={week} />
          {codex ? (
            <>
              <div className="ub-group">
                <span className="ub-group-name">
                  Codex{codex.plan ? <em>{codex.plan}</em> : null}
                </span>
                <span className="ub-age">{codex.error ? "" : agoText(codexAge)}</span>
                <RefreshButton title="Refresh Codex usage: runs no model, so it costs nothing" onRun={refreshCodexLimits} />
              </div>
              {codex.windows?.length ? (
                codex.windows.map((w) => <LimitRow key={w.label} label={w.label ?? "limit"} w={w} />)
              ) : (
                <div className="ub-note">{codex.error ? "No numbers yet" : "Reading…"}</div>
              )}
              {codex.error ? (
                <div className="ub-note error">
                  Could not read Codex: {codex.error}
                  {codex.updated ? " · showing the last numbers" : ""}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </footer>
  );
}

export function Sidebar() {
  const { chats, filter, setFilter, openForm, cycleTheme } = useStore();
  useStore((s) => s.tick);
  const q = filter.trim().toLowerCase();
  const manager = chats.find((c) => c.name === "manager");
  const agents = chats.filter((c) => c.name !== "manager");
  const shown = agents.filter((c) => !q || (c.title + " " + c.goal).toLowerCase().includes(q));
  const working = chats.filter((c) => c.working).length;
  const drafts = chats.reduce((n, c) => n + c.pending, 0);
  const todayRuns = chats.reduce((n, c) => n + (c.usage?.today_runs || 0), 0);
  const todayCost = chats.reduce((n, c) => n + (c.usage?.today_cost || 0), 0);
  useEffect(() => {
    const ask = () => {
      if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    };
    document.addEventListener("click", ask, { once: true });
    return () => document.removeEventListener("click", ask);
  }, []);

  return (
    <aside id="sidebar">
      <header className="side-head">
        <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="9" fill="var(--accent)" />
          <circle cx="10" cy="16" r="3" fill="#fff" />
          <circle cx="22" cy="9.5" r="3" fill="#fff" />
          <circle cx="22" cy="22.5" r="3" fill="#fff" />
          <path d="M12.6 14.6 19.4 10.9M12.6 17.4l6.8 3.7" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <div className="brand">Agent Chat</div>
        <button id="new-agent" className="icon-btn" type="button" aria-label="New agent" title="New agent" onClick={() => void openForm()}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <button className="icon-btn" type="button" aria-label="Change theme" title="Theme: system, light, dark" onClick={cycleTheme}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
          </svg>
        </button>
      </header>
      <div className="side-label pin-label">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M9 4h6l-1 6 3 3v2h-4.5v5l-.5.5-.5-.5v-5H7v-2l3-3z" fill="currentColor" />
        </svg>
        Manager
      </div>
      <ul className="chat-list pinned">{manager ? <ChatRow c={manager} /> : null}</ul>
      <div className="search">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input type="search" placeholder="Search agents" autoComplete="off" aria-label="Search agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="summary-row">
        {working || drafts || todayRuns ? (
          <>
            {working ? <span className="chip-s">{working} working</span> : null}
            {drafts ? <span className="chip-s warn">{drafts} draft{drafts > 1 ? "s" : ""} waiting</span> : null}
            {todayRuns ? (
              <span className="chip-s plain" title={USAGE_NOTE}>
                today {todayRuns} run{todayRuns > 1 ? "s" : ""} · ~{fmtMoney(todayCost)}
              </span>
            ) : null}
          </>
        ) : (
          "All agents idle"
        )}
      </div>
      <div className="side-label">
        Agents <span>{q ? `${shown.length} of ${agents.length}` : agents.length}</span>
      </div>
      <ul id="chat-list" className="chat-list">
        {shown.map((c) => (
          <ChatRow key={c.name} c={c} />
        ))}
      </ul>
      <UsageBar />
    </aside>
  );
}
