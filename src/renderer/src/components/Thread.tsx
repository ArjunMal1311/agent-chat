import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { CACHE_NOTE, USAGE_NOTE, dayLabel, fmtCountdown, fmtMoney, fmtTime, fmtTokens, pctText, runUsageText, shortModel } from "../lib/format";
import { Rich } from "./Rich";
import { useStore } from "../store";
import type { Chat, Message as Msg } from "../lib/types";

const titleOf = (chats: Chat[], name: string) => chats.find((c) => c.name === name)?.title ?? name;

function copyText(text: string, toast: (t: string) => void) {
  navigator.clipboard.writeText(text).then(
    () => toast("Copied"),
    () => toast("Could not copy"),
  );
}

function Steps({ steps, activeLast }: { steps: string[]; activeLast: boolean }) {
  return (
    <ul className="steps">
      {steps.map((text, i) => {
        const now = activeLast && i === steps.length - 1;
        return (
          <li key={i} className={now ? "now" : "done"}>
            {now ? <span className="spin" aria-hidden="true" /> : <span className="check" aria-hidden="true">✓</span>}
            <span>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Message({ m, prev, isNew }: { m: Msg; prev: Msg | null; isNew: boolean }) {
  const chats = useStore((s) => s.chats);
  const toast = useStore((s) => s.toast);
  const approve = useStore((s) => s.approve);
  const openChat = useStore((s) => s.openChat);
  const [busy, setBusy] = useState(false);

  if (m.kind === "status") return <div className="note">{m.body}</div>;
  const out = m.sender === "you";
  const first = !prev || prev.sender !== m.sender;
  const post = m.meta?.post;
  const relay = m.meta?.relay;
  const slides = post ? (
    <>
      <div className="slides-head">
        <span className="ig">Draft</span>
        <span>
          {post.files.length} slide{post.files.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="slides">
        {post.files.map((_, i) => (
          <a key={i} href={`/api/image?id=${m.id}&n=${i}`} target="_blank" rel="noopener noreferrer">
            <img src={`/api/image?id=${m.id}&n=${i}`} alt={`Slide ${i + 1}`} loading="lazy" />
            <span className="n">
              {i + 1}/{post.files.length}
            </span>
          </a>
        ))}
      </div>
      <details className="trace">
        <summary>Caption</summary>
        <div className="text">
          <Rich text={post.caption} />
        </div>
      </details>
    </>
  ) : null;

  let tag: React.ReactNode = null;
  let extra: React.ReactNode = null;
  if (m.kind === "approval") {
    if (m.status === "pending") {
      tag = <div className="tag">Draft</div>;
      extra = (
        <>
          {slides}
          <div className="hint">{post ? "Approve publishes this right away." : "For you to send by hand. Nothing goes out on its own."}</div>
          <div className="actions">
            {(["approved", "declined"] as const).map((decision) => (
              <button
                key={decision}
                className={"btn " + (decision === "approved" ? "ok" : "no")}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await approve(m.id, decision);
                  } catch {
                    setBusy(false);
                  }
                }}
              >
                {decision === "approved" ? (post ? "Approve & post" : "Approve") : "Decline"}
              </button>
            ))}
          </div>
        </>
      );
    } else if (m.status === "approved") {
      tag = <div className="tag done">Approved</div>;
      extra = slides;
    } else {
      tag = <div className="tag declined">Declined</div>;
      extra = slides;
    }
  }
  // An agent's answer relayed into the Manager's chat: show the Manager's verdict and a way to open the agent's chat.
  if (relay) {
    tag =
      relay.verdict === "ok" ? (
        <div className="tag done">Checked · looks fine</div>
      ) : relay.verdict === "fix" ? (
        <div className="tag">Checked · needs changes</div>
      ) : relay.verdict === "failed" ? (
        <div className="tag declined">Could not finish</div>
      ) : (
        <div className="tag plain">Not checked</div>
      );
    extra = (
      <>
        {extra}
        <button className="open-btn" type="button" onClick={() => void openChat(relay.agent)}>
          {relay.draft ? "Review the draft in" : "Open"} {relay.title}’s chat →
        </button>
      </>
    );
  }
  const steps = m.meta?.steps;
  return (
    <div className={"msg " + (out ? "out" : "in") + (first ? " first" : "") + (isNew ? " pop" : "")}>
      {out ? null : <div className="gutter">{first ? <Avatar name={m.sender} /> : null}</div>}
      <div className={`bubble ${m.kind}${relay ? " relay " + relay.verdict : ""}`}>
        {!out && first ? (
          <div className="who">
            <b>{titleOf(chats, m.sender)}</b>
            <span className="when">{fmtTime(m.created)}</span>
          </div>
        ) : null}
        {tag}
        <div className="text">
          <Rich text={m.body} />
        </div>
        {extra}
        {steps && steps.length ? (
          <details className="trace">
            <summary>
              {steps.length} step{steps.length > 1 ? "s" : ""}
            </summary>
            <Steps steps={steps} activeLast={false} />
          </details>
        ) : null}
        {m.meta && (m.meta.model || m.meta.in) ? (
          <div className="usage" title={USAGE_NOTE}>
            {runUsageText(m.meta)}
          </div>
        ) : null}
        <div className="meta">
          {out ? null : (
            <button className="mini" type="button" aria-label="Copy message" onClick={() => copyText(m.body, toast)}>
              Copy
            </button>
          )}
          {out ? <span>{fmtTime(m.created)}</span> : null}
        </div>
      </div>
    </div>
  );
}

function Activity({ meta }: { meta: Chat }) {
  const all = meta.steps?.length ? meta.steps : [meta.detail || "Starting…"];
  const shown = all.slice(-8);
  const earlier = all.length - shown.length;
  return (
    <div className="msg in typing first">
      <div className="gutter">
        <Avatar name={meta.name} />
      </div>
      <div className="bubble activity">
        <div className="act-title">{meta.title} is working</div>
        {earlier > 0 ? (
          <div className="act-earlier">
            {earlier} earlier step{earlier > 1 ? "s" : ""}
          </div>
        ) : null}
        <Steps steps={shown} activeLast />
      </div>
    </div>
  );
}

function CacheLine({ meta }: { meta: Chat }) {
  useStore((s) => s.tick);
  const cache = meta.usage?.cache;
  if (!cache)
    return (
      <div className="head-cache" title={CACHE_NOTE}>
        <span className="dot" />
        <span>no cache yet</span>
      </div>
    );
  const stats = `last run ${pctText(cache.last_hit)} cached (${fmtTokens(cache.last_read)} read, ${fmtTokens(cache.last_write)} written) · overall ${pctText(cache.hit)}`;
  const title = `${CACHE_NOTE}\n\n${stats}`;
  if (!cache.warm_until)
    return (
      <div className="head-cache" title={title}>
        <span className="dot" />
        <span>cache unknown · {pctText(cache.last_hit)} hit</span>
      </div>
    );
  const left = cache.warm_until - Date.now() / 1000;
  return left > 0 ? (
    <div className="head-cache warm" title={title}>
      <span className="dot" />
      <span>
        cache warm · {fmtCountdown(left)} left · {pctText(cache.last_hit)} hit
      </span>
    </div>
  ) : (
    <div className="head-cache cold" title={title}>
      <span className="dot" />
      <span>cache cold · {fmtCountdown(-left)} ago</span>
    </div>
  );
}

function HeadUsage({ meta }: { meta: Chat }) {
  const u = meta.usage;
  const model = shortModel(u?.model) || meta.model || "default model";
  return (
    <div className="head-usage" title={USAGE_NOTE}>
      {!u?.runs ? (
        <>
          <span className="stat">{model}</span>
          <span className="stat">no runs yet</span>
        </>
      ) : (
        <>
          <span className="stat"><b>{model}</b></span>
          <span className="stat"><b>{u.runs}</b> run{u.runs > 1 ? "s" : ""}</span>
          <span className="stat"><b>{fmtTokens(u.tokens)}</b> tokens</span>
          {u.cost ? <span className="stat">~<b>{fmtMoney(u.cost)}</b></span> : null}
          <span className="stat">
            today <b>{u.today_runs}</b>
            {u.today_cost ? ` · ~${fmtMoney(u.today_cost)}` : ""}
          </span>
        </>
      )}
    </div>
  );
}

function Menu({ meta }: { meta: Chat }) {
  const { menu, setMenu, runMenu } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [menu]);
  if (!menu) return null;
  const busy = meta.working;
  const why = busy ? "Wait until the agent has finished" : meta.pending ? "Approve or decline the waiting drafts first" : meta.messages < 4 ? "Too short to compact" : "";
  const actions = (doIt: string, label: string, danger = false) => (
    <div className="menu-actions">
      <button type="button" onClick={() => setMenu(null)}>Cancel</button>
      <button type="button" className={danger ? "danger" : undefined} onClick={() => void runMenu(doIt as "clear")}>{label}</button>
    </div>
  );
  return (
    <div id="menu" className="menu" role="menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      {menu === "clear" ? (
        <>
          <div className="menu-text">
            Wipe this chat completely? All messages
            {meta.pending ? ` ${meta.pending} draft${meta.pending > 1 ? "s" : ""} still waiting for approval will be deleted too.` : ""}, its usage history, the agent's notes and any saved summary are deleted. The agent starts from nothing. This cannot be undone.
          </div>
          {actions("clear", "Clear everything", true)}
        </>
      ) : menu === "compact" ? (
        <>
          <div className="menu-text">
            Compact this chat? The agent writes a short summary of the {meta.messages} messages, they are replaced by it, and the agent keeps using the summary. It costs one run (about 50k tokens on Sonnet).
          </div>
          {actions("compact", "Compact")}
        </>
      ) : menu === "forget" ? (
        <>
          <div className="menu-text">
            Forget this agent's {meta.notes} saved note{meta.notes === 1 ? "" : "s"}? It will no longer remember earlier runs. Messages stay.
          </div>
          {actions("forget", "Forget notes", true)}
        </>
      ) : (
        <>
          <button type="button" role="menuitem" disabled={!!why} title={why || undefined} onClick={() => setMenu("compact")}>Compact chat…</button>
          <button type="button" role="menuitem" disabled={busy} title={busy ? "Wait until the agent has finished" : undefined} onClick={() => setMenu("clear")}>Clear chat (wipe everything)…</button>
          <button type="button" role="menuitem" disabled={!meta.notes} onClick={() => setMenu("forget")}>Forget notes ({meta.notes})…</button>
        </>
      )}
    </div>
  );
}

function Composer({ meta }: { meta: Chat }) {
  const send = useStore((s) => s.send);
  const prefill = useStore((s) => s.prefill);
  const current = useStore((s) => s.current);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const size = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };
  useEffect(() => {
    setText("");
  }, [current]);
  useEffect(() => {
    if (prefill.text) setText(prefill.text);
  }, [prefill.n]);
  useLayoutEffect(size, [text]);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [current, prefill.n]);
  const submit = async () => {
    const value = text;
    if (!value.trim()) return;
    setText("");
    if (!(await send(value))) setText(value);
  };
  return (
    <form
      id="composer"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="composer-box">
        <textarea
          id="input"
          ref={ref}
          rows={1}
          value={text}
          placeholder={meta.name === "manager" ? "Tell the Manager what you want done…" : "Message this agent…"}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button id="send" type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="composer-hint">
        <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
      </div>
    </form>
  );
}

export function Thread() {
  const { meta, messages, firstRender, closeChat, menu, setMenu } = useStore();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const maxSeen = useRef(0);
  const wasFirst = useRef(true);
  const current = useStore((s) => s.current);

  useEffect(() => {
    maxSeen.current = 0;
    stick.current = true;
    wasFirst.current = true;
  }, [current]);

  const newestBefore = maxSeen.current;
  const first = wasFirst.current;
  useLayoutEffect(() => {
    const el = box.current;
    if (el && (stick.current || firstRender)) el.scrollTop = el.scrollHeight;
    maxSeen.current = messages.reduce((n, m) => Math.max(n, m.id), maxSeen.current);
    if (messages.length) wasFirst.current = false;
  }, [messages, meta?.working, meta?.steps?.length, firstRender]);

  useEffect(() => {
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [setMenu]);

  if (!meta) return null;
  const items: React.ReactNode[] = [];
  let prev: Msg | null = null;
  let prevDay = "";
  for (const m of messages) {
    const day = new Date(m.created * 1000).toDateString();
    if (day !== prevDay) {
      items.push(<div key={`d${m.id}`} className="day">{dayLabel(m.created)}</div>);
      prevDay = day;
      prev = null;
    }
    items.push(<Message key={m.id} m={m} prev={prev} isNew={!first && m.id > newestBefore} />);
    prev = m.kind === "status" ? null : m;
  }
  return (
    <section id="conversation">
      <header className="head">
        <button id="back" className="icon-btn" type="button" aria-label="Back to chats" onClick={closeChat}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="m14.5 5.5-6.5 6.5 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <Avatar name={meta.name} small working={meta.working} />
        <div className="head-text">
          <div className="head-line">
            <div className="head-title">{meta.title}</div>
            <div className={"head-sub" + (meta.working ? " working" : "")}>{meta.working ? meta.detail || "working…" : meta.goal || "online"}</div>
          </div>
          <div className="head-stats">
            <HeadUsage meta={meta} />
            <CacheLine meta={meta} />
          </div>
        </div>
        <button
          className="icon-btn menu-btn"
          type="button"
          aria-label="Chat options"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(menu ? null : "main");
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="5.5" cy="12" r="1.8" fill="currentColor" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            <circle cx="18.5" cy="12" r="1.8" fill="currentColor" />
          </svg>
        </button>
        <Menu meta={meta} />
      </header>
      <div
        id="messages"
        role="log"
        aria-live="polite"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        }}
      >
        {messages.length ? null : <div className="note">No messages yet. Say what you want this agent to do.</div>}
        {items}
        {meta.working ? <Activity meta={meta} /> : null}
      </div>
      <Composer meta={meta} />
    </section>
  );
}

