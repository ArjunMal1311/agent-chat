"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { chats: [], current: null, meta: null, messages: [], filter: "", firstRender: true, maxSeen: 0 };

  const STARTERS = [
    { chat: "manager", tag: "Manager", label: "What should I do today?", text: "What should I do today?" },
    { chat: "networking", tag: "Networking", label: "Draft a LinkedIn note", text: "Draft a LinkedIn connection note for " },
    { chat: "reviewer", tag: "Reviewer", label: "Check a DM", text: "Check this DM before I send it: " },
  ];

  // ---- helpers ---------------------------------------------------------------------------
  async function api(path, body) {
    const options = body
      ? { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Chat": "1" }, body: JSON.stringify(body) }
      : {};
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Escape first, then add a little formatting, so message text can never inject HTML.
  function rich(text) {
    return String(text)
      .split("```")
      .map((part, i) => {
        if (i % 2 === 1) return "<pre><code>" + esc(part.replace(/^\w*\n/, "")) + "</code></pre>";
        return esc(part)
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>");
      })
      .join("");
  }

  function hue(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }
  function avatar(name, title, opts = {}) {
    const initials = (title || name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const h = hue(name);
    const bg = `linear-gradient(135deg, hsl(${h} 55% 52%), hsl(${(h + 28) % 360} 52% 38%))`;
    return (
      `<div${opts.id ? ` id="${opts.id}"` : ""} class="avatar${opts.small ? " small" : ""}" style="background:${bg}">` +
      esc(initials) +
      (opts.working ? '<span class="dot"></span>' : "") +
      "</div>"
    );
  }

  function fmtTime(epoch) {
    return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function fmtListTime(epoch) {
    const d = new Date(epoch * 1000);
    return d.toDateString() === new Date().toDateString()
      ? fmtTime(epoch)
      : d.toLocaleDateString([], { day: "numeric", month: "short" });
  }
  function dayLabel(epoch) {
    const d = new Date(epoch * 1000);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  }

  // ---- usage text ------------------------------------------------------------------------
  const USAGE_NOTE =
    "Estimated cost reported by Claude Code (API prices). On a subscription you are not billed this amount; " +
    "it shows how much each agent uses. Plan limits are not available here.";
  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }
  function fmtMoney(x) {
    return "$" + (x < 0.1 ? x.toFixed(3) : x.toFixed(2));
  }
  function shortModel(model) {
    return String(model || "").replace(/claude-/g, "");
  }
  function runUsageText(u) {
    const bits = [];
    if (u.model) bits.push(shortModel(u.model));
    bits.push(`${fmtTokens((u.in || 0) + (u.out || 0))} tokens (${fmtTokens(u.out || 0)} out)`);
    bits.push(`~${fmtMoney(u.cost || 0)}`);
    if (u.seconds) bits.push(`${u.seconds}s`);
    if (u.in && u.cache_read !== undefined) bits.push(`${Math.round((100 * u.cache_read) / u.in)}% cached`);
    return bits.join(" · ");
  }

  // ---- cache status of a chat (an estimate: the real cache lives on Anthropic's side) -------
  const CACHE_NOTE =
    "Claude Code reuses the start of the prompt from a cache when you run the same agent again soon, which is cheaper and faster. " +
    "Warm = the last run is still inside the cache window (1 hour here), so the next run can reuse it. Cold = the window has passed, " +
    "so the next run rebuilds the prompt (about 50k tokens). This is estimated from the last run; part of the prompt changes every run, " +
    "so even a warm cache only covers part of it, and different agents share only the common start.";
  function pctText(x) {
    return x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`;
  }
  function renderCacheLine() {
    const el = $("head-cache");
    const meta = state.meta;
    if (!meta) return;
    el.title = CACHE_NOTE;
    const cache = meta.usage && meta.usage.cache;
    if (!cache) {
      el.className = "head-cache";
      el.innerHTML = '<span class="dot"></span><span>Cache: no runs yet</span>';
      return;
    }
    if (!cache.warm_until) {
      el.className = "head-cache";
      el.innerHTML = `<span class="dot"></span><span>Cache: unknown · last run ${pctText(cache.last_hit)} from cache</span>`;
      return;
    }
    const left = cache.warm_until - Date.now() / 1000;
    const stats = `last run ${pctText(cache.last_hit)} cached (${fmtTokens(cache.last_read)} read, ${fmtTokens(cache.last_write)} written) · overall ${pctText(cache.hit)}`;
    if (left > 0) {
      el.className = "head-cache warm";
      el.innerHTML = `<span class="dot"></span><span>Cache warm · ${esc(fmtCountdown(left))} left · ${esc(stats)}</span>`;
    } else {
      el.className = "head-cache cold";
      el.innerHTML = `<span class="dot"></span><span>Cache cold · expired ${esc(fmtCountdown(-left))} ago · next run rebuilds it · ${esc(stats)}</span>`;
    }
  }
  function headUsageText(meta) {
    const u = meta.usage || {};
    const model = shortModel(u.model) || meta.model || "default model";
    if (!u.runs) return `${model} · no runs yet`;
    return (
      `${model} · ${u.runs} run${u.runs > 1 ? "s" : ""} · ${fmtTokens(u.tokens)} tokens · ~${fmtMoney(u.cost)}` +
      ` · today ${u.today_runs} run${u.today_runs === 1 ? "" : "s"}, ~${fmtMoney(u.today_cost)}`
    );
  }

  function titleOf(name) {
    const chat = state.chats.find((c) => c.name === name);
    return chat ? chat.title : name;
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 2800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast("Copied");
      } catch (__) {
        toast("Could not copy");
      }
      ta.remove();
    }
  }

  // ---- theme: system -> light -> dark, remembered ----------------------------------------
  function readTheme() {
    try { return localStorage.getItem("theme") || ""; } catch (_) { return ""; }
  }
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  let theme = readTheme();
  applyTheme(theme);
  $("theme").addEventListener("click", () => {
    theme = theme === "" ? "light" : theme === "light" ? "dark" : "";
    try { localStorage.setItem("theme", theme); } catch (_) { /* not remembered */ }
    applyTheme(theme);
    toast("Theme: " + (theme || "system"));
  });

  // ---- chat list -------------------------------------------------------------------------
  function previewOf(c) {
    if (c.working) return { text: c.detail || "working…", working: true };
    if (!c.last) return { text: c.goal || "No messages yet", working: false };
    const prefix = c.last.sender === "you" ? "You: " : "";
    const plain = c.last.body.replace(/^\s*[-*]\s+/gm, "").replace(/[*`#]/g, "").replace(/\s+/g, " ").trim();
    return { text: prefix + plain, working: false };
  }

  function renderStarters() {
    const box = $("starters");
    box.textContent = "";
    for (const s of STARTERS) {
      if (!state.chats.some((c) => c.name === s.chat)) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.chat = s.chat;
      btn.dataset.text = s.text;
      btn.innerHTML = `<small>${esc(s.tag)}</small>${esc(s.label)}`;
      box.appendChild(btn);
    }
  }

  function renderChats() {
    const q = state.filter.trim().toLowerCase();
    const list = $("chat-list");
    list.textContent = "";
    let unreadTotal = 0;
    for (const c of state.chats) {
      unreadTotal += c.unread;
      if (q && !(c.title + " " + c.goal).toLowerCase().includes(q)) continue;
      const li = document.createElement("li");
      li.className = "chat" + (c.name === state.current ? " active" : "") + (c.unread ? " unread" : "");
      li.tabIndex = 0;
      li.dataset.name = c.name;
      const p = previewOf(c);
      li.innerHTML =
        avatar(c.name, c.title, { working: c.working }) +
        `<div class="body"><div class="top"><span class="name">${esc(c.title)}</span>` +
        `<span class="time">${c.last ? esc(fmtListTime(c.last.created)) : ""}</span></div>` +
        `<div class="bottom"><span class="preview${p.working ? " working" : ""}">${esc(p.text)}</span>` +
        `<span class="tags">` +
        (c.pending ? `<span class="pill">${c.pending} draft${c.pending > 1 ? "s" : ""}</span>` : "") +
        (c.unread ? `<span class="badge">${c.unread}</span>` : "") +
        `</span></div></div>`;
      list.appendChild(li);
    }
    const working = state.chats.filter((c) => c.working).length;
    const drafts = state.chats.reduce((n, c) => n + c.pending, 0);
    const parts = [];
    if (working) parts.push(`<span class="chip-s">${working} working</span>`);
    if (drafts) parts.push(`<span class="chip-s warn">${drafts} draft${drafts > 1 ? "s" : ""} waiting</span>`);
    const todayRuns = state.chats.reduce((n, c) => n + ((c.usage || {}).today_runs || 0), 0);
    const todayCost = state.chats.reduce((n, c) => n + ((c.usage || {}).today_cost || 0), 0);
    if (todayRuns) {
      parts.push(
        `<span class="chip-s plain" title="${esc(USAGE_NOTE)}">today ${todayRuns} run${todayRuns > 1 ? "s" : ""} · ~${fmtMoney(todayCost)}</span>`
      );
    }
    $("summary").innerHTML = parts.length ? parts.join("") : "All agents idle";
    document.title = (unreadTotal ? `(${unreadTotal}) ` : "") + "Agent Chat";
  }

  // Desktop notification when an agent writes and you are not looking at that chat.
  const seenUnread = {};
  let seeded = false;
  function notifyNew(chats) {
    for (const c of chats) {
      const before = seenUnread[c.name] || 0;
      const watching = c.name === state.current && document.hasFocus();
      if (seeded && c.unread > before && !watching && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification(c.title, { body: previewOf(c).text, tag: c.name });
        n.onclick = () => {
          window.focus();
          openChat(c.name);
          n.close();
        };
      }
      seenUnread[c.name] = c.unread;
    }
    seeded = true;
  }
  document.addEventListener(
    "click",
    () => {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    },
    { once: true }
  );

  async function loadChats() {
    const data = await api("/api/chats");
    notifyNew(data.chats);
    state.chats = data.chats;
    renderStarters();
    renderChats();
  }

  // ---- conversation ----------------------------------------------------------------------
  function messageEl(m, prev, isNew) {
    if (m.kind === "status") {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = m.body;
      return note;
    }
    const out = m.sender === "you";
    const first = !prev || prev.sender !== m.sender;
    const row = document.createElement("div");
    row.className = "msg " + (out ? "out" : "in") + (first ? " first" : "") + (isNew ? " pop" : "");
    const who = !out && first && m.sender !== state.current ? `<div class="who">${esc(titleOf(m.sender))}</div>` : "";
    let tag = "";
    let extra = "";
    if (m.kind === "approval") {
      if (m.status === "pending") {
        tag = '<div class="tag">Draft</div>';
        extra =
          `<div class="hint">For you to send by hand. Nothing goes out on its own.</div>` +
          `<div class="actions"><button class="btn ok" data-act="approved" data-id="${m.id}">Approve</button>` +
          `<button class="btn no" data-act="declined" data-id="${m.id}">Decline</button></div>`;
      } else if (m.status === "approved") {
        tag = '<div class="tag done">Approved</div>';
      } else {
        tag = '<div class="tag declined">Declined</div>';
      }
    }
    const copy = out ? "" : `<button class="mini" type="button" data-copy="${m.id}" aria-label="Copy message">Copy</button>`;
    row.innerHTML =
      `<div class="bubble ${esc(m.kind)}">${who}${tag}<div class="text">${rich(m.body)}</div>${extra}` +
      (m.meta && m.meta.steps && m.meta.steps.length
        ? `<details class="trace"><summary>${m.meta.steps.length} step${m.meta.steps.length > 1 ? "s" : ""}</summary>` +
          `<ul class="steps">${stepItems(m.meta.steps, false)}</ul></details>`
        : "") +
      (m.meta && (m.meta.model || m.meta.in) ? `<div class="usage" title="${esc(USAGE_NOTE)}">${esc(runUsageText(m.meta))}</div>` : "") +
      `<div class="meta">${copy}<span>${esc(fmtTime(m.created))}</span>${out ? '<span class="ticks">✓✓</span>' : ""}</div></div>`;
    return row;
  }

  // What the agent is doing right now: the steps so far, the newest one spinning.
  function stepItems(steps, activeLast) {
    return steps
      .map((text, i) => {
        const now = activeLast && i === steps.length - 1;
        return (
          `<li class="${now ? "now" : "done"}">` +
          (now ? '<span class="spin" aria-hidden="true"></span>' : '<span class="check" aria-hidden="true">✓</span>') +
          `<span>${esc(text)}</span></li>`
        );
      })
      .join("");
  }
  function activityEl(meta) {
    const all = meta.steps && meta.steps.length ? meta.steps : [meta.detail || "Starting…"];
    const shown = all.slice(-8);
    const earlier = all.length - shown.length;
    const row = document.createElement("div");
    row.className = "msg in typing first";
    row.innerHTML =
      `<div class="bubble activity"><div class="act-title">${esc(meta.title)} is working</div>` +
      (earlier > 0 ? `<div class="act-earlier">${earlier} earlier step${earlier > 1 ? "s" : ""}</div>` : "") +
      `<ul class="steps">${stepItems(shown, true)}</ul></div>`;
    return row;
  }

  function renderThread() {
    const meta = state.meta;
    if (!meta) return;
    $("head-avatar").outerHTML = avatar(meta.name, meta.title, { small: true, id: "head-avatar", working: meta.working });
    $("head-title").textContent = meta.title;
    const sub = $("head-sub");
    sub.textContent = meta.working ? meta.detail || "working…" : meta.goal || "online";
    sub.className = "head-sub" + (meta.working ? " working" : "");
    const usage = $("head-usage");
    usage.textContent = headUsageText(meta);
    usage.title = USAGE_NOTE;
    renderCacheLine();

    const box = $("messages");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    box.textContent = "";
    if (!state.messages.length) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "No messages yet. Say what you want this agent to do.";
      box.appendChild(note);
    }
    let prev = null;
    let prevDay = "";
    for (const m of state.messages) {
      const day = new Date(m.created * 1000).toDateString();
      if (day !== prevDay) {
        const d = document.createElement("div");
        d.className = "day";
        d.textContent = dayLabel(m.created);
        box.appendChild(d);
        prevDay = day;
        prev = null;
      }
      const isNew = !state.firstRender && m.id > state.maxSeen;
      box.appendChild(messageEl(m, prev, isNew));
      prev = m.kind === "status" ? null : m;
    }
    state.maxSeen = state.messages.reduce((n, m) => Math.max(n, m.id), state.maxSeen);
    if (meta.working) box.appendChild(activityEl(meta));
    if (state.firstRender || nearBottom) box.scrollTop = box.scrollHeight;
    state.firstRender = false;
  }

  async function loadMessages() {
    if (!state.current) return;
    const name = state.current;
    const data = await api("/api/messages?chat=" + encodeURIComponent(name));
    if (state.current !== name) return;
    state.meta = data.chat;
    state.messages = data.messages;
    renderThread();
    loadChats();
  }

  async function openChat(name, prefill) {
    closeMenu();
    state.current = name;
    state.firstRender = true;
    state.maxSeen = 0;
    $("empty").hidden = true;
    $("conversation").hidden = false;
    $("app").dataset.view = "thread";
    history.replaceState(null, "", "#" + name);
    renderChats();
    await loadMessages();
    const input = $("input");
    if (prefill) {
      input.value = prefill;
      autosize();
    }
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function closeChat() {
    state.current = null;
    state.meta = null;
    $("app").dataset.view = "list";
    $("conversation").hidden = true;
    $("empty").hidden = false;
    history.replaceState(null, "", location.pathname);
    renderChats();
  }

  async function sendMessage() {
    const input = $("input");
    const text = input.value.trim();
    if (!text || !state.current) return;
    input.value = "";
    autosize();
    try {
      await api("/api/send", { chat: state.current, text });
      await loadMessages();
    } catch (err) {
      input.value = text;
      toast("Could not send: " + err.message);
    }
  }

  function autosize() {
    const input = $("input");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  // ---- plan usage bar: Claude Code's own 5-hour and 7-day numbers -------------------------
  let limits = { windows: {}, updated: null };
  function fmtCountdown(sec) {
    if (sec <= 0) return "now";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${Math.max(m, 1)}m`;
  }
  function limitHtml(label, w) {
    if (!w) return `<span>${label}</span><span>no data yet</span>`;
    const left = w.resets_at ? w.resets_at - Date.now() / 1000 : null;
    if (left !== null && left <= 0) return `<span>${label}</span><span>reset since the last check</span>`;
    const pct = Math.round(w.used * 100);
    const reset = left === null ? "" : `<span>resets in ${fmtCountdown(left)}</span>`;
    return (
      `<span>${label}</span><span class="ub-bar" aria-hidden="true"><i style="width:${Math.min(pct, 100)}%"></i></span>` +
      `<span class="pct">${pct}%</span>${reset}`
    );
  }
  function limitClass(w) {
    if (!w) return "ub-item";
    return "ub-item" + (w.used >= 0.85 ? " high" : w.used >= 0.6 ? " warn" : "");
  }
  function renderLimits() {
    const five = limits.windows.five_hour;
    const week = limits.windows.seven_day;
    $("ub-five").className = limitClass(five);
    $("ub-five").innerHTML = limitHtml("5-hour", five);
    $("ub-week").className = limitClass(week);
    $("ub-week").innerHTML = limitHtml("7-day", week);
    const age = $("ub-age");
    if (!limits.updated) {
      age.textContent = "Updates after any agent runs, or press Refresh";
    } else {
      const mins = Math.floor((Date.now() / 1000 - limits.updated) / 60);
      age.textContent = (mins < 1 ? "updated just now" : `updated ${mins} min ago`) + (mins >= 30 ? " · may be out of date" : "");
    }
  }
  async function loadLimits() {
    try {
      limits = (await api("/api/limits")).limits;
    } catch (_) { /* keep showing the last numbers */ }
    renderLimits();
  }
  $("ub-refresh").addEventListener("click", async () => {
    const btn = $("ub-refresh");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      const res = await api("/api/limits/refresh", {});
      limits = res.limits;
      renderLimits();
      const cost = res.usage && res.usage.cost;
      toast(cost ? `Updated (that check cost ~${fmtMoney(cost)})` : "Updated");
    } catch (err) {
      toast("Could not refresh: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh";
    }
  });
  setInterval(() => {
    renderLimits();
    renderCacheLine();
  }, 30000); // keeps the countdowns and "updated" text moving

  // ---- chat menu: clear chat / forget notes (each asks first) ----------------------------
  const menu = $("menu");
  const menuBtn = $("menu-btn");
  function closeMenu() {
    menu.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  }
  function renderMenu(step) {
    const meta = state.meta;
    if (!meta) return;
    if (step === "clear") {
      const drafts = meta.pending
        ? ` ${meta.pending} draft${meta.pending > 1 ? "s" : ""} still waiting for approval will be deleted too.`
        : "";
      menu.innerHTML =
        `<div class="menu-text">Delete all messages in this chat?${esc(drafts)} Usage totals and the agent's notes stay. This cannot be undone.</div>` +
        `<div class="menu-actions"><button type="button" data-do="cancel">Cancel</button>` +
        `<button type="button" class="danger" data-do="clear">Clear chat</button></div>`;
    } else if (step === "forget") {
      menu.innerHTML =
        `<div class="menu-text">Forget this agent's ${meta.notes} saved note${meta.notes === 1 ? "" : "s"}? It will no longer remember earlier runs. Messages stay.</div>` +
        `<div class="menu-actions"><button type="button" data-do="cancel">Cancel</button>` +
        `<button type="button" class="danger" data-do="forget">Forget notes</button></div>`;
    } else {
      const busy = meta.working;
      menu.innerHTML =
        `<button type="button" role="menuitem" data-do="ask-clear"${busy ? ' disabled title="Wait until the agent has finished"' : ""}>Clear chat…</button>` +
        `<button type="button" role="menuitem" data-do="ask-forget"${meta.notes ? "" : " disabled"}>Forget notes (${meta.notes})…</button>`;
    }
    const first = menu.querySelector("button:not([disabled])");
    if (first) first.focus();
  }
  function openMenu() {
    if (!state.meta) return;
    renderMenu();
    menu.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
  }
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  menu.addEventListener("click", async (e) => {
    e.stopPropagation();
    const btn = e.target.closest("button[data-do]");
    if (!btn || btn.disabled || !state.current) return;
    const action = btn.dataset.do;
    if (action === "ask-clear") return renderMenu("clear");
    if (action === "ask-forget") return renderMenu("forget");
    if (action === "cancel") return closeMenu();
    try {
      if (action === "clear") {
        const res = await api("/api/clear", { chat: state.current });
        toast(`Chat cleared (${res.deleted} message${res.deleted === 1 ? "" : "s"} deleted)`);
      } else {
        await api("/api/forget", { chat: state.current });
        toast("Notes forgotten");
      }
      closeMenu();
      await loadMessages();
    } catch (err) {
      toast(err.message);
      closeMenu();
    }
  });
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      closeMenu();
      menuBtn.focus();
    }
  });

  // ---- events ----------------------------------------------------------------------------
  $("chat-list").addEventListener("click", (e) => {
    const li = e.target.closest(".chat");
    if (li) openChat(li.dataset.name);
  });
  $("chat-list").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("chat")) {
      e.preventDefault();
      openChat(e.target.dataset.name);
    }
  });
  $("starters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) openChat(chip.dataset.chat, chip.dataset.text);
  });
  $("filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderChats();
  });
  $("back").addEventListener("click", closeChat);
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });
  $("input").addEventListener("input", autosize);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  $("messages").addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("button[data-copy]");
    if (copyBtn) {
      const msg = state.messages.find((m) => m.id === Number(copyBtn.dataset.copy));
      if (msg) copyText(msg.body);
      return;
    }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await api("/api/approve", { id: Number(btn.dataset.id), decision: btn.dataset.act });
      await loadMessages();
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });

  // Live updates: the server only says "these chats changed"; we refetch.
  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        await loadChats();
        if (state.current) await loadMessages();
        await loadLimits();
      } catch (_) { /* the next event retries */ }
    }, 120);
  }
  function connect() {
    const es = new EventSource("/events");
    es.onmessage = scheduleRefresh;
    es.onerror = () => {
      es.close();
      setTimeout(connect, 2000);
    };
  }

  // ---- start -----------------------------------------------------------------------------
  loadChats()
    .then(() => {
      const wanted = decodeURIComponent(location.hash.slice(1));
      if (wanted && state.chats.some((c) => c.name === wanted)) openChat(wanted);
    })
    .catch((err) => toast("Could not load chats: " + err.message));
  loadLimits();
  connect();
})();
