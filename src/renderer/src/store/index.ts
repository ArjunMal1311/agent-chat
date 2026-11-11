import { create } from "zustand";
import { api } from "../lib/api";
import {
  AgentOptionsSchema,
  ChatsResponse,
  ClearResponse,
  CodexRefreshResponse,
  CreateAgentResponse,
  Ignored,
  LimitsRefreshResponse,
  LimitsResponse,
  MessagesResponse,
} from "../lib/schemas";
import { fmtMoney, previewOf } from "../lib/format";
import type { AgentOptions, Chat, CodexLimits, Limits, Message } from "../lib/types";

type Theme = "" | "light" | "dark";
export type MenuStep = null | "main" | "compact" | "clear" | "forget";

const readTheme = (): Theme => {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "";
  } catch {
    return "";
  }
};
const applyTheme = (theme: Theme) => {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
};

interface State {
  chats: Chat[];
  current: string | null;
  meta: Chat | null;
  messages: Message[];
  filter: string;
  limits: Limits;
  codex: CodexLimits | null;
  toastText: string;
  theme: Theme;
  menu: MenuStep;
  formOpen: boolean;
  options: AgentOptions | null;
  prefill: { text: string; n: number };
  firstRender: boolean;
  tick: number;

  loadChats: () => Promise<void>;
  loadMessages: () => Promise<void>;
  loadLimits: () => Promise<void>;
  openChat: (name: string, prefill?: string) => Promise<void>;
  closeChat: () => void;
  send: (text: string) => Promise<boolean>;
  approve: (id: number, decision: string) => Promise<void>;
  setFilter: (q: string) => void;
  cycleTheme: () => void;
  toast: (text: string) => void;
  setMenu: (step: MenuStep) => void;
  runMenu: (action: "clear" | "compact" | "forget") => Promise<void>;
  refreshClaudeLimits: () => Promise<void>;
  refreshCodexLimits: () => Promise<void>;
  openForm: () => Promise<void>;
  closeForm: () => void;
  createAgent: (spec: Record<string, unknown>) => Promise<void>;
  bumpTick: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
const seenUnread: Record<string, number> = {};
let seeded = false;

export const useStore = create<State>((set, get) => ({
  chats: [],
  current: null,
  meta: null,
  messages: [],
  filter: "",
  limits: { windows: {}, updated: null },
  codex: null,
  toastText: "",
  theme: readTheme(),
  menu: null,
  formOpen: false,
  options: null,
  prefill: { text: "", n: 0 },
  firstRender: true,
  tick: 0,

  toast(text) {
    set({ toastText: text });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toastText: "" }), 2800);
  },

  async loadChats() {
    const data = await api("/api/chats", ChatsResponse);
    // Desktop notification when an agent writes and you are not looking at that chat.
    for (const c of data.chats) {
      const before = seenUnread[c.name] || 0;
      const watching = c.name === get().current && document.hasFocus();
      if (seeded && c.unread > before && !watching && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification(c.title, { body: previewOf(c).text, tag: c.name });
        n.onclick = () => {
          window.focus();
          void get().openChat(c.name);
          n.close();
        };
      }
      seenUnread[c.name] = c.unread;
    }
    seeded = true;
    const unread = data.chats.reduce((n, c) => n + c.unread, 0);
    document.title = (unread ? `(${unread}) ` : "") + "Agent Chat";
    set({ chats: data.chats });
  },

  async loadMessages() {
    const name = get().current;
    if (!name) return;
    const data = await api("/api/messages?chat=" + encodeURIComponent(name), MessagesResponse);
    if (get().current !== name) return;
    set({ meta: data.chat, messages: data.messages });
    void get().loadChats();
  },

  async loadLimits() {
    try {
      const data = await api("/api/limits", LimitsResponse);
      set({ limits: data.limits, codex: data.codex || null });
    } catch {
      /* keep showing the last numbers */
    }
  },

  async openChat(name, prefill) {
    set({ menu: null, current: name, firstRender: true, messages: [], meta: null });
    history.replaceState(null, "", "#" + name);
    await get().loadMessages();
    if (prefill) set({ prefill: { text: prefill, n: get().prefill.n + 1 } });
  },

  closeChat() {
    history.replaceState(null, "", location.pathname);
    set({ current: null, meta: null, messages: [], menu: null });
  },

  async send(text) {
    const chat = get().current;
    if (!text.trim() || !chat) return false;
    try {
      await api("/api/send", Ignored, { chat, text: text.trim() });
      await get().loadMessages();
      return true;
    } catch (err) {
      get().toast("Could not send: " + (err as Error).message);
      return false;
    }
  },

  async approve(id, decision) {
    try {
      await api("/api/approve", Ignored, { id, decision });
      await get().loadMessages();
    } catch (err) {
      get().toast((err as Error).message);
      throw err;
    }
  },

  setFilter: (filter) => set({ filter }),

  cycleTheme() {
    const t = get().theme;
    const next: Theme = t === "" ? "light" : t === "light" ? "dark" : "";
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* not remembered */
    }
    applyTheme(next);
    set({ theme: next });
    get().toast("Theme: " + (next || "system"));
  },

  setMenu: (menu) => set({ menu }),

  async runMenu(action) {
    const chat = get().current;
    if (!chat) return;
    try {
      if (action === "clear") {
        const res = await api("/api/clear", ClearResponse, { chat });
        get().toast(`Chat wiped (${res.deleted} message${res.deleted === 1 ? "" : "s"} deleted)`);
      } else if (action === "compact") {
        await api("/api/compact", Ignored, { chat });
        get().toast("Compacting… the chat shows progress");
      } else {
        await api("/api/forget", Ignored, { chat });
        get().toast("Notes forgotten");
      }
      set({ menu: null });
      await get().loadMessages();
    } catch (err) {
      get().toast((err as Error).message);
      set({ menu: null });
    }
  },

  async refreshClaudeLimits() {
    try {
      const res = await api("/api/limits/refresh", LimitsRefreshResponse, {});
      set({ limits: res.limits });
      const cost = res.usage?.cost;
      get().toast(cost ? `Updated (that check cost ~${fmtMoney(cost)})` : "Updated");
    } catch (err) {
      get().toast("Could not refresh: " + (err as Error).message);
    }
  },

  async refreshCodexLimits() {
    try {
      set({ codex: (await api("/api/codex-limits/refresh", CodexRefreshResponse, {})).codex });
    } catch (err) {
      get().toast("Could not refresh Codex: " + (err as Error).message);
    }
  },

  async openForm() {
    set({ menu: null, formOpen: true, options: null });
    try {
      set({ options: await api("/api/agent-options", AgentOptionsSchema) });
    } catch {
      set({ options: { enabled: false, tools: [], models: [], cwd: "" } });
    }
  },
  closeForm: () => set({ formOpen: false }),

  async createAgent(spec) {
    const res = await api("/api/agents", CreateAgentResponse, spec); // throws with the server's plain message
    set({ formOpen: false });
    await get().loadChats();
    get().toast("Agent created");
    await get().openChat(res.name);
  },

  bumpTick: () => set((s) => ({ tick: s.tick + 1 })),
}));

applyTheme(readTheme());
