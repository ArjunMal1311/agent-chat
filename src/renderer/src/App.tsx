import { useEffect } from "react";
import { AgentForm } from "./components/AgentForm";
import { Sidebar } from "./components/Sidebar";
import { useStore } from "./store";
import { Thread } from "./components/Thread";

const STARTERS = [
  { chat: "manager", tag: "Manager", label: "What should I do today?", text: "What should I do today?" },
  { chat: "researcher", tag: "Researcher", label: "Research a topic", text: "Research " },
  { chat: "reviewer", tag: "Reviewer", label: "Check a draft", text: "Check this draft before I send it: " },
];

function Empty() {
  const chats = useStore((s) => s.chats);
  const openChat = useStore((s) => s.openChat);
  return (
    <div id="empty">
      <svg className="empty-logo" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--accent)" />
        <circle cx="10" cy="16" r="3" fill="#fff" />
        <circle cx="22" cy="9.5" r="3" fill="#fff" />
        <circle cx="22" cy="22.5" r="3" fill="#fff" />
        <path d="M12.6 14.6 19.4 10.9M12.6 17.4l6.8 3.7" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <h1 className="empty-title">What should we work on?</h1>
      <p className="empty-sub">Message an agent directly, or ask the Manager and it will pick the right one.</p>
      <div className="chips">
        {STARTERS.filter((s) => chats.some((c) => c.name === s.chat)).map((s) => (
          <button key={s.chat + s.label} type="button" className="chip" onClick={() => void openChat(s.chat, s.text)}>
            <small>{s.tag}</small>
            {s.label}
          </button>
        ))}
      </div>
      <p className="empty-note">Agents prepare drafts. Nothing is sent or posted until you approve it.</p>
    </div>
  );
}

export function App() {
  const { current, toastText, loadChats, loadMessages, loadLimits, openChat, bumpTick, toast } = useStore();

  useEffect(() => {
    let refresh: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (refresh) return;
      // Live updates: the server only says "these chats changed"; we refetch.
      refresh = setTimeout(async () => {
        refresh = null;
        try {
          await loadChats();
          if (useStore.getState().current) await loadMessages();
          await loadLimits();
        } catch {
          /* the next event retries */
        }
      }, 120);
    };
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      es = new EventSource("/events");
      es.onmessage = schedule;
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    loadChats()
      .then(() => {
        const chats = useStore.getState().chats;
        const wanted = decodeURIComponent(location.hash.slice(1));
        if (wanted && chats.some((c) => c.name === wanted)) void openChat(wanted);
        // On a wide screen start in the Manager's chat: it is the one place to run everything from.
        else if (matchMedia("(min-width: 761px)").matches && chats.some((c) => c.name === "manager")) void openChat("manager");
      })
      .catch((err) => toast("Could not load chats: " + err.message));
    void loadLimits();
    connect();
    const limits = setInterval(loadLimits, 5 * 60 * 1000); // the server re-reads Codex's numbers at most every 10 minutes
    const tick = setInterval(bumpTick, 30000); // keeps the countdowns and "updated" text moving
    return () => {
      es?.close();
      clearTimeout(retry);
      clearInterval(limits);
      clearInterval(tick);
    };
  }, []);

  return (
    <>
      <div id="app" data-view={current ? "thread" : "list"}>
        <Sidebar />
        <main id="thread">{current ? <Thread /> : <Empty />}</main>
      </div>
      <AgentForm />
      {toastText ? <div id="toast" role="status">{toastText}</div> : null}
    </>
  );
}
