import { test, expect } from "bun:test";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkspace } from "./index";

// DOM types from xterm omit Bun's custom WebSocket headers option.
const BunSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };

// Scratch directories are kept in the OS temp directory, never in the user's workspace.
test("workspace files, permissions, proxy, watching, and PTY", async () => {
  const root = await mkdtemp(join(tmpdir(), "dirito-test-"));
  const outside = await mkdtemp(join(tmpdir(), "dirito-outside-"));
  await Bun.write(join(root, "index.html"), "<!doctype html><h1>Preview works</h1>");
  await Bun.write(join(root, "notes.txt"), "first");
  await Bun.write(join(root, "binary.bin"), new Uint8Array([0, 255]));
  await Bun.write(join(root, ".env"), "SECRET=private");
  await Bun.write(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(root, "escape"));
  await symlink(join(root, ".env"), join(root, "env-alias"));
  await symlink(join(root, "missing"), join(root, "dangling"));
  await mkdir(join(root, "folder"));
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { return Response.json({ path: new URL(req.url).pathname, method: req.method, body: await req.text() }); } });
  const app = await startWorkspace(root, { port: 0, watch: true });
  const sockets: WebSocket[] = [];
  async function api(path: string, method = "GET", body?: unknown) {
    return fetch(`${app.server.url.origin}/api/${path}`, { method, headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  function connect(url: string, origin: string) {
    const ws = new BunSocket(url, { headers: { Origin: origin } }); sockets.push(ws); return ws;
  }
  const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", reject, { once: true }); });
  try {
    const html = await (await fetch(app.server.url)).text();
    expect(html).toContain("File manager");
    expect((await fetch(`${app.server.url}api/state`)).status).toBe(401);
    expect((await fetch(`${app.server.url}api/state`, { headers: { Authorization: `Bearer ${app.token}`, Origin: "https://attacker.example" } })).status).toBe(403);
    expect((await fetch(`${app.server.url}api/state`, { headers: { Authorization: `Bearer ${app.token}`, Host: "attacker.example" } })).status).toBe(403);
    expect((await api("files?path=../")).status).toBe(403);
    expect((await api("files?path=escape")).status).toBe(403);
    expect((await api("files", "POST", { path: "escape/new.txt" })).status).toBe(403);
    expect((await api("file?path=binary.bin")).status).toBe(400);
    expect((await (await api("files")).json()).some((entry: any) => entry.name === "notes.txt")).toBe(true);

    const initial = await (await api("file?path=notes.txt")).json();
    expect(initial.text).toBe("first");
    expect((await api("file", "PUT", { path: "notes.txt", text: "updated", version: initial.version })).status).toBe(200);
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe("updated");
    expect((await api("file", "PUT", { path: "notes.txt", text: "stale", version: initial.version })).status).toBe(409);
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe("updated");
    const updated = await (await api("file?path=notes.txt")).json();
    await Bun.write(join(root, "notes.txt"), "external edit");
    expect((await api("file", "PUT", { path: "notes.txt", text: "lost", version: updated.version })).status).toBe(409);
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe("external edit");

    expect((await api("files", "POST", { path: "new.txt" })).status).toBe(200);
    expect((await api("files", "POST", { path: "new.txt" })).status).toBe(409);
    expect((await api("rename", "POST", { path: "new.txt", to: "notes.txt" })).status).toBe(409);
    expect((await api("rename", "POST", { path: "new.txt", to: "dangling" })).status).toBe(409);
    expect((await api("rename", "POST", { path: "new.txt", to: "renamed.txt" })).status).toBe(200);
    expect((await api("files", "DELETE", { path: "renamed.txt" })).status).toBe(400);
    expect((await api("files", "DELETE", { path: "renamed.txt", confirm: "renamed.txt" })).status).toBe(200);
    expect((await api("files", "DELETE", { path: "folder", confirm: "folder" })).status).toBe(200);
    expect((await api("files", "DELETE", { path: "", confirm: "" })).status).toBe(403);

    const preview = await (await fetch(app.preview.url)).text();
    expect(preview).toContain("Preview works"); expect(preview).toContain("/__dirito/live");
    expect((await fetch(`${app.preview.url}.env`)).status).toBe(403);
    expect((await fetch(`${app.preview.url}env-alias`)).status).toBe(403);
    expect((await fetch(`${app.preview.url}escape/secret.txt`)).status).toBe(403);
    expect((await fetch(app.preview.url, { headers: { Host: "attacker.example" } })).status).toBe(403);
    expect((await api("settings", "PUT", { watch: true, proxy: `/api=${upstream.url.origin}` })).status).toBe(200);
    const proxied = await (await fetch(`${app.preview.url}api/example`, { method: "POST", body: "hello" })).json();
    expect(proxied).toEqual({ path: "/api/example", method: "POST", body: "hello" });
    expect((await api("settings", "PUT", { watch: true, proxy: "/api=file:///etc" })).status).toBe(400);
    await api("settings", "PUT", { watch: true, proxy: "" });

    const live = connect(`${app.preview.url.origin.replace(/^http/, "ws")}/__dirito/live`, app.preview.url.origin);
    await opened(live);
    const reload = new Promise<string>(resolve => live.addEventListener("message", event => resolve(String(event.data)), { once: true }));
    await Bun.write(join(root, "watched.txt"), "changed");
    expect(await reload).toBe("reload");
    await api("settings", "PUT", { watch: false, proxy: "" });
    expect(await (await fetch(app.preview.url)).text()).not.toContain("/__dirito/live");

    const shell = connect(`${app.server.url.origin.replace(/^http/, "ws")}/api/socket?kind=terminal&token=${app.token}`, app.server.url.origin);
    let output = "";
    shell.binaryType = "arraybuffer";
    const result = new Promise<void>(resolve => shell.addEventListener("message", event => {
      output += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      if (output.includes("PTY_OK") && output.includes(root)) resolve();
    }));
    await opened(shell);
    shell.send(JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
    // The output marker is split to avoid matching the terminal's echo of the input.
    shell.send(JSON.stringify({ type: "input", data: "pwd; printf 'PTY_%s\\n' OK\r" }));
    await result;
    expect(output).toContain("PTY_OK"); expect(output).toContain(root);
  } finally {
    for (const socket of sockets) socket.close();
    await app.stop(); await upstream.stop(true);
  }
}, 15000);
