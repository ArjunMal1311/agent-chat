import { STARTERS } from "../../../constants/ui";
import { useStore } from "../store";

/** What the main pane shows before a chat is open. */
export function Empty() {
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
