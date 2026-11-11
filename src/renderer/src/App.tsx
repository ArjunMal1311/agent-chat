import { useEffect } from "react";
import { AgentForm } from "./components/AgentForm";
import { Empty } from "./components/Empty";
import { Sidebar } from "./components/Sidebar";
import { useStore } from "./store";
import { Thread } from "./components/Thread";

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
