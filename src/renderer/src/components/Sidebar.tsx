import { useEffect } from "react";
import { Avatar } from "./Avatar";
import { USAGE_NOTE, fmtCountdown, fmtListTime, fmtMoney, previewOf } from "../lib/format";
import { useStore } from "../store";
import type { Chat, LimitWindow } from "../lib/types";

function ChatRow({ c }: { c: Chat }) {
  const current = useStore((s) => s.current);
  const openChat = useStore((s) => s.openChat);
  const p = previewOf(c);
  return (
    <li
      className={"chat" + (c.name === current ? " active" : "") + (c.unread ? " unread" : "")}
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

function limitClass(w?: LimitWindow | null) {
  if (!w) return "ub-item";
  return "ub-item" + (w.used >= 0.85 ? " high" : w.used >= 0.6 ? " warn" : "");
}

function LimitBody({ label, w }: { label: string; w?: LimitWindow | null }) {
  if (!w)
    return (
      <div className="ub-row">
        <span className="ub-label">{label}</span>
        <span className="ub-sub">no data yet</span>
      </div>
    );
  const left = w.resets_at ? w.resets_at - Date.now() / 1000 : null;
  if (left !== null && left <= 0)
    return (
      <div className="ub-row">
        <span className="ub-label">{label}</span>
        <span className="ub-sub">reset since the last check</span>
      </div>
    );
  const pct = Math.round(w.used * 100);
  return (
    <>
      <div className="ub-row">
        <span className="ub-label">{label}</span>
        <span className="ub-pct">{pct}%</span>
      </div>
      <div className="ub-bar" aria-hidden="true">
        <i style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {left === null ? null : <div className="ub-sub">resets in {fmtCountdown(left)}</div>}
    </>
  );
}

const ago = (updated: number) => {
  const mins = Math.floor((Date.now() / 1000 - updated) / 60);
  return mins;
};

function UsageBar() {
  const { limits, codex, refreshClaudeLimits, refreshCodexLimits } = useStore();
  const five = limits.windows.five_hour;
  const week = limits.windows.seven_day;
  const claudeAge = limits.updated ? ago(limits.updated) : null;
  const codexAge = codex?.updated ? ago(codex.updated) : null;
  const press = (fn: () => Promise<void>) => async (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh";
    }
  };
  return (
    <footer id="usagebar" className="usagebar" role="status" aria-label="Claude Code plan usage">
      <div className="ub-head">
        <span className="ub-title">Plan usage</span>
      </div>
      <div className="ub-group-title">
        <span>Claude</span>
        <button className="ub-btn" type="button" title="Runs one tiny call so Claude Code reports fresh numbers. It uses a little usage itself." onClick={press(refreshClaudeLimits)}>
          Refresh
        </button>
      </div>
      <div className={limitClass(five)}>
        <LimitBody label="5-hour" w={five} />
      </div>
      <div className={limitClass(week)}>
        <LimitBody label="7-day" w={week} />
      </div>
      <div className="ub-age">
        {claudeAge === null ? "Updates after any agent runs" : (claudeAge < 1 ? "updated just now" : `updated ${claudeAge} min ago`) + (claudeAge >= 30 ? " · may be out of date" : "")}
      </div>
      {codex ? (
        <div className="ub-codex">
          <div className="ub-group-title">
            <span>
              Codex <em>{codex.plan ? codex.plan + " plan" : ""}</em>
            </span>
            <button className="ub-btn" type="button" title="Asks Codex for your current numbers. This runs no model, so it costs nothing." onClick={press(refreshCodexLimits)}>
              Refresh
            </button>
          </div>
          <div className="ub-codex-list">
            {codex.windows?.length ? (
              codex.windows.map((w) => (
                <div key={w.label} className={limitClass(w)}>
                  <LimitBody label={w.label ?? "limit"} w={w} />
                </div>
              ))
            ) : (
              <div className="ub-sub">{codex.error ? "No numbers yet" : "Reading…"}</div>
            )}
          </div>
          <div className={"ub-age" + (codex.error ? " error" : "")}>
            {codex.error
              ? `Could not read Codex: ${codex.error}${codex.updated ? " · showing the last numbers" : ""}`
              : codexAge === null
                ? ""
                : codexAge < 1
                  ? "updated just now"
                  : `updated ${codexAge} min ago`}
          </div>
        </div>
      ) : null}
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
