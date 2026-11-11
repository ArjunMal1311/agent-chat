// HTTP server (Node standard library only): the chat page, a small JSON API, and a live event stream.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Hub } from "../hub/hub.ts";
import { RunError } from "../runner/runner.ts";

const MAX_BODY = 64 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

type Dict = Record<string, any>;

export function chatSummary(hub: Hub, name: string): Dict {
  const agent = hub.agents.get(name)!;
  const [working, detail] = hub.store.working(name);
  const last = hub.store.last(name);
  return {
    name,
    title: agent.title,
    goal: agent.goal,
    approval: agent.approval,
    model: agent.model,
    usage: hub.store.usage(name),
    notes: hub.notesCount(name),
    messages: hub.store.count(name),
    summarized: Boolean(hub.summaryOf(name)),
    steps: working ? hub.liveSteps(name) : [],
    working,
    detail,
    unread: hub.store.unread(name),
    pending: hub.store.pending(name),
    last: last && { sender: last.sender, body: last.body.slice(0, 140), kind: last.kind, created: last.created },
  };
}

export interface Served {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(hub: Hub, staticDir: string, port = 8765, host = "127.0.0.1"): Promise<Served> {
  const allowed = new Set<string>();
  const root = path.resolve(staticDir);

  const send = (res: http.ServerResponse, status: number, body: Buffer | string, type: string) => {
    const data = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(status, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-store" });
    res.end(data);
  };
  const json = (res: http.ServerResponse, payload: unknown, status = 200) => send(res, status, JSON.stringify(payload), "application/json");
  const fail = (res: http.ServerResponse, status: number, message: string) => json(res, { error: message }, status);

  const readBody = (req: http.IncomingMessage): Promise<Dict> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(text ? JSON.parse(text) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  const events = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const unsubscribe = hub.bus.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  };

  const serveStatic = (res: http.ServerResponse, urlPath: string) => {
    const name = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
    const target = path.resolve(root, decodeURIComponent(name));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return fail(res, 404, "not found");
    send(res, 200, fs.readFileSync(target), mimeOf(target));
  };

  const get = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const p = url.pathname;
    if (p === "/api/chats") {
      const chats = [...hub.agents.keys()].map((n) => chatSummary(hub, n));
      chats.sort((a, b) => (b.last?.created ?? 0) - (a.last?.created ?? 0));
      return json(res, { chats });
    }
    if (p === "/api/messages") {
      const chat = url.searchParams.get("chat") ?? "";
      if (!hub.agents.has(chat)) return fail(res, 404, "unknown chat");
      const messages = hub.store.messages(chat);
      // Only what is being returned counts as read; a reply landing right now stays unread.
      hub.store.markRead(chat, messages.length ? messages[messages.length - 1].id : 0);
      return json(res, { chat: chatSummary(hub, chat), messages });
    }
    if (p === "/api/image") {
      const file = hub.postImage(Number(url.searchParams.get("id") ?? "0"), Number(url.searchParams.get("n") ?? "0"));
      if (!file) return fail(res, 404, "not found");
      return send(res, 200, fs.readFileSync(file), mimeOf(file) === "application/octet-stream" ? "image/jpeg" : mimeOf(file));
    }
    if (p === "/api/limits") {
      hub.refreshCodexLimitsSoon(); // in the background; this reply carries what is saved now
      return json(res, { limits: hub.limits(), codex: hub.codexLimits() });
    }
    if (p === "/api/agent-options") return json(res, hub.agentOptions());
    if (p === "/events") return events(req, res);
    return serveStatic(res, p);
  };

  const post = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const data = await readBody(req);
    const chat = String(data.chat ?? "");
    switch (url.pathname) {
      case "/api/send":
        return json(res, { message: hub.send(chat, String(data.text ?? "")) });
      case "/api/approve": {
        const id = Number(data.id);
        if (!Number.isInteger(id)) throw new TypeError("id must be a number");
        return json(res, { message: hub.approve(id, String(data.decision ?? "")) });
      }
      case "/api/clear":
        return json(res, { deleted: hub.clearChat(chat) });
      case "/api/compact":
        hub.compactChat(chat);
        return json(res, { ok: true });
      case "/api/forget":
        hub.forgetNotes(chat);
        return json(res, { ok: true });
      case "/api/codex-limits/refresh":
        await hub.refreshCodexLimits();
        return json(res, { codex: hub.codexLimits() });
      case "/api/agents":
        return json(res, { name: hub.createAgent(data) });
      case "/api/limits/refresh": {
        const usage = await hub.refreshLimits();
        return json(res, { usage, limits: hub.limits() });
      }
    }
    return fail(res, 404, "not found");
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowed.has((req.headers.host ?? "").toLowerCase())) return fail(res, 403, "bad host");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST") {
        // A custom header cannot be sent cross-site without a CORS preflight we never answer.
        if (req.headers["x-agent-chat"] !== "1") return fail(res, 403, "missing header");
        return await post(req, res, url);
      }
      if (req.method === "GET") return await get(req, res, url);
      return fail(res, 405, "method not allowed");
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof RunError) return fail(res, 502, e.message);
      if (e instanceof Error) return fail(res, 400, e.message);
      return fail(res, 500, "server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const real = (server.address() as AddressInfo).port;
  allowed.add(`127.0.0.1:${real}`).add(`localhost:${real}`);
  return {
    server,
    port: real,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
