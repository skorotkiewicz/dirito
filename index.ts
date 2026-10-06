#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { realpath, readdir, stat, mkdir, rename, rm, open } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { resolve, relative, dirname, sep, join } from "node:path";
import workspace from "./workspace.html";

const MAX_FILE = 1024 * 1024;
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
const version = (text: string) => Bun.hash(text).toString(16);

export function proxyConfig(value: string) {
  if (!value) return null;
  const split = value.indexOf("=");
  const prefix = value.slice(0, split);
  if (split < 1 || !/^\/[\w/-]*$/.test(prefix)) fail(400, "Use /api=http://localhost:3000 for a proxy.");
  const target = new URL(value.slice(split + 1));
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash || target.search) {
    fail(400, "Proxy target must be an HTTP URL without credentials, query, or fragment.");
  }
  return { prefix: prefix.replace(/\/$/, "") || "/", target };
}

export async function startWorkspace(directory: string, options: { port?: number; previewPort?: number; watch?: boolean; proxy?: string } = {}) {
  const root = await realpath(resolve(directory));
  if (!(await stat(root)).isDirectory()) fail(400, "Workspace must be a directory.");
  const token = crypto.randomUUID();
  let watching = options.watch ?? false;
  let proxyText = options.proxy ?? "";
  let proxy = proxyConfig(proxyText);
  let watcher: FSWatcher | undefined;
  const events = new Set<Bun.ServerWebSocket<SocketData>>();
  const terminals = new Set<Bun.ServerWebSocket<SocketData>>();
  const reloaders = new Set<Bun.ServerWebSocket<{}>>();
  type SocketData = { kind: "events" | "terminal"; proc?: ReturnType<typeof Bun.spawn> };

  const inside = (path: string) => {
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(path) !== path) fail(403, "Path is outside the workspace.");
    return path;
  };
  async function pathFor(value: unknown, creating = false) {
    if (typeof value !== "string" || value.includes("\0")) fail(400, "Invalid path.");
    const path = inside(resolve(root, value));
    if (creating) {
      inside(await realpath(dirname(path)));
      try { inside(await realpath(path)); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    } else inside(await realpath(path));
    return path;
  }
  const notify = (path: string) => {
    const message = JSON.stringify({ type: "change", path, time: Date.now() });
    for (const ws of events) ws.send(message);
    if (watching) for (const ws of reloaders) ws.send("reload");
  };
  function setWatch(enabled: boolean) {
    watcher?.close();
    watcher = undefined;
    if (enabled) watcher = watch(root, { recursive: true }, (_, filename) => {
      const path = String(filename ?? "");
      if (path.split(/[\\/]/).some(part => ["node_modules", ".git"].includes(part))) return;
      notify(path);
    });
    watching = enabled;
  }
  const errorResponse = (error: any) => {
    const status = error instanceof HttpError ? error.status : ({ ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403 } as Record<string, number>)[error.code] ?? 400;
    return Response.json({ error: error.message || "Request failed." }, { status });
  };

  const preview = Bun.serve<{}>({
    hostname: "127.0.0.1", port: options.previewPort ?? 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/__dev-shell/live") {
          if (req.headers.get("origin") !== server.url.origin) return new Response("Forbidden", { status: 403 });
          return server.upgrade(req, { data: {} }) ? undefined : new Response("Upgrade required", { status: 426 });
        }
        if (proxy && (proxy.prefix === "/" || url.pathname === proxy.prefix || url.pathname.startsWith(proxy.prefix + "/"))) {
          const target = new URL(proxy.target);
          target.pathname = target.pathname.replace(/\/$/, "") + url.pathname;
          target.search = url.search;
          const headers = new Headers(req.headers);
          for (const key of ["host", "connection", "upgrade", "content-length"]) headers.delete(key);
          // ponytail: HTTP proxy only; add WebSocket forwarding when framework HMR is needed.
          return await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body, redirect: "manual" });
        }
        if (!["GET", "HEAD"].includes(req.method)) return new Response("Method not allowed", { status: 405 });
        let path = await pathFor(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
        if ((await stat(path)).isDirectory()) path = await pathFor(relative(root, join(path, "index.html")));
        const file = Bun.file(path);
        if (!(await stat(path)).isFile()) fail(404, "Not a file.");
        const response = new Response(req.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type, "Cache-Control": "no-store" } });
        if (watching && req.method === "GET" && file.type.startsWith("text/html")) {
          return new HTMLRewriter().onDocument({ end(end) {
            end.append(`<script>const s=new WebSocket(location.origin.replace(/^http/,'ws')+'/__dev-shell/live');s.onmessage=()=>location.reload();</script>`, { html: true });
          } }).transform(response);
        }
        return response;
      } catch (error) { return errorResponse(error); }
    },
    websocket: {
      open(ws) { reloaders.add(ws); }, message() {}, close(ws) { reloaders.delete(ws); },
    },
  });

  let server: Bun.Server<SocketData>;
  try {
    setWatch(watching);
    server = Bun.serve<SocketData>({
      hostname: "127.0.0.1", port: options.port ?? 3000,
      development: false,
      maxRequestBodySize: MAX_FILE + 65536,
      routes: { "/": workspace },
      async fetch(req, current) {
        const url = new URL(req.url);
        if (url.origin !== current.url.origin) return new Response("Invalid host", { status: 403 });
        const socket = url.pathname === "/api/socket";
        const provided = socket ? url.searchParams.get("token") : req.headers.get("authorization")?.replace(/^Bearer /, "");
        if (provided !== token) return new Response("Unauthorized", { status: 401 });
        if (req.headers.get("origin") && req.headers.get("origin") !== current.url.origin) return new Response("Forbidden origin", { status: 403 });
        try {
          if (socket) {
            if (req.headers.get("origin") !== current.url.origin) fail(403, "Forbidden origin.");
            const kind = url.searchParams.get("kind");
            if (kind !== "events" && kind !== "terminal") fail(400, "Invalid socket kind.");
            if (kind === "terminal" && terminals.size >= 8) fail(429, "Too many terminals.");
            return current.upgrade(req, { data: { kind } }) ? undefined : new Response("Upgrade required", { status: 426 });
          }
          if (url.pathname === "/api/state" && req.method === "GET") return Response.json({ root, watch: watching, proxy: proxyText, preview: preview.url.origin });
          if (url.pathname === "/api/settings" && req.method === "PUT") {
            const body = await req.json();
            if (typeof body.watch !== "boolean" || typeof body.proxy !== "string") fail(400, "Invalid settings.");
            const nextProxy = proxyConfig(body.proxy);
            setWatch(body.watch);
            proxy = nextProxy; proxyText = body.proxy;
            for (const ws of reloaders) ws.send("reload");
            return Response.json({ ok: true });
          }
          if (url.pathname === "/api/files" && req.method === "GET") {
            const path = await pathFor(url.searchParams.get("path") ?? "");
            const entries = await readdir(path, { withFileTypes: true });
            return Response.json(entries.map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() }))
              .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)));
          }
          if (url.pathname === "/api/file" && req.method === "GET") {
            const path = await pathFor(url.searchParams.get("path"));
            const info = await stat(path);
            if (!info.isFile() || info.size > MAX_FILE) fail(400, "Editor supports text files up to 1 MiB.");
            const bytes = await Bun.file(path).bytes();
            if (bytes.includes(0)) fail(400, "Binary files cannot be edited.");
            let text: string;
            try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(400, "Editor supports UTF-8 text only."); }
            return Response.json({ text, version: version(text) });
          }
          if (url.pathname === "/api/file" && req.method === "PUT") {
            const body = await req.json();
            if (typeof body.text !== "string" || Buffer.byteLength(body.text) > MAX_FILE) fail(400, "File is too large.");
            const path = await pathFor(body.path);
            const handle = await open(path, "r+");
            try {
              if (!(await handle.stat()).isFile()) fail(400, "Not a file.");
              const current = await handle.readFile("utf8");
              if (version(current) !== body.version) fail(409, "File changed on disk. Reopen it before saving.");
              await handle.writeFile(body.text);
              await handle.truncate(Buffer.byteLength(body.text));
              await handle.sync();
            } finally { await handle.close(); }
            notify(body.path);
            return Response.json({ version: version(body.text) });
          }
          if (url.pathname === "/api/files" && req.method === "POST") {
            const body = await req.json();
            const path = await pathFor(body.path, true);
            if (body.directory === true) await mkdir(path);
            else { const handle = await open(path, "wx"); await handle.close(); }
            notify(body.path);
            return Response.json({ ok: true });
          }
          if (url.pathname === "/api/rename" && req.method === "POST") {
            const body = await req.json();
            const from = await pathFor(body.path);
            if (from === root) fail(403, "Cannot rename the workspace root.");
            const to = await pathFor(body.to, true);
            try { await stat(to); fail(409, "Destination already exists."); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
            await rename(from, to); notify(body.path);
            return Response.json({ ok: true });
          }
          if (url.pathname === "/api/files" && req.method === "DELETE") {
            const body = await req.json();
            if (body.confirm !== body.path) fail(400, "Deletion requires confirmation of the path.");
            const path = await pathFor(body.path);
            if (path === root) fail(403, "Cannot delete the workspace root.");
            await rm(path, { recursive: false }); // Non-empty directories require deliberate cleanup in the terminal.
            notify(body.path);
            return Response.json({ ok: true });
          }
          return new Response("Not found", { status: 404 });
        } catch (error) { return errorResponse(error); }
      },
      websocket: {
        maxPayloadLength: 65536,
        open(ws) {
          if (ws.data.kind === "events") { events.add(ws); return; }
          terminals.add(ws);
          try {
            const proc = Bun.spawn([process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh")], {
              cwd: root, env: { ...process.env, TERM: "xterm-256color" },
              terminal: { cols: 100, rows: 24, data(_, data) { ws.sendBinary(data); } },
            });
            ws.data.proc = proc;
            void proc.exited.then(code => { ws.sendBinary(new TextEncoder().encode(`\r\n[Shell exited: ${code}]\r\n`)); ws.close(); });
          } catch (error: any) { ws.sendBinary(new TextEncoder().encode(error.message)); ws.close(); }
        },
        message(ws, raw) {
          if (ws.data.kind !== "terminal") return;
          try {
            const message = JSON.parse(String(raw));
            if (message.type === "input" && typeof message.data === "string") ws.data.proc?.terminal?.write(message.data);
            if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
              ws.data.proc?.terminal?.resize(message.cols, message.rows);
            }
          } catch { ws.close(1008, "Invalid terminal message"); }
        },
        close(ws) {
          events.delete(ws); terminals.delete(ws);
          ws.data.proc?.kill(); ws.data.proc?.terminal?.close();
        },
      },
    });
  } catch (error) { watcher?.close(); await preview.stop(true); throw error; }
  return {
    server, preview, token, url: `${server.url.origin}/#${token}`,
    async stop() {
      watcher?.close();
      for (const ws of terminals) { ws.data.proc?.kill(); ws.data.proc?.terminal?.close(); }
      await Promise.all([server.stop(true), preview.stop(true)]);
    },
  };
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
      watch: { type: "boolean", default: false }, proxy: { type: "string" }, port: { type: "string", default: "3000" },
      "no-open": { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
    } });
    if (values.help) {
      console.log("Usage: dev-shell [dir] [--watch] [--proxy /api=http://localhost:3001] [--port 3000] [--no-open]");
    } else {
      if (positionals.length > 1) throw new Error("Pass one workspace directory.");
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be between 0 and 65535.");
      const app = await startWorkspace(positionals[0] ?? ".", { port, watch: values.watch, proxy: values.proxy });
      console.log(`dev-shell  ${resolve(positionals[0] ?? ".")}\nWorkspace  ${app.url}\nPreview    ${app.preview.url.origin}\nTerminal commands have your user's full permissions. Keep the workspace URL private.`);
      if (!values["no-open"]) {
        try {
          const command = process.platform === "darwin" ? ["open", app.url] : process.platform === "win32" ? ["cmd", "/c", "start", "", app.url] : ["xdg-open", app.url];
          Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
        } catch { console.log("Open the workspace URL in your browser."); }
      }
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await app.stop(); process.exit(0); });
    }
  } catch (error: any) { console.error(error.message); process.exitCode = 1; }
}
