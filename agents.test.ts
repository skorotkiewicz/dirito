import { test, expect } from "bun:test";
import { codingAgents, agentArguments } from "./agents";
import { mkdtemp, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkspace } from "./index";

test("coding agent arguments preserve defaults and allow only native thinking levels", () => {
  for (const agent of codingAgents) {
    expect(agentArguments(agent.id, "default")).toEqual([agent.id]);
    for (const level of agent.thinking.slice(1)) {
      expect(agentArguments(agent.id, level)).toEqual(agent.id === "codex"
        ? ["codex", "-c", `model_reasoning_effort="${level}"`]
        : [agent.id, agent.id === "pi" ? "--thinking" : "--effort", level]);
    }
  }
  expect(() => agentArguments("bash", "default")).toThrow("Unknown coding agent");
  expect(() => agentArguments("constructor", "default")).toThrow("Unknown coding agent");
  expect(() => agentArguments("codex", "high; touch bad")).toThrow("Unsupported thinking level");
  expect(() => agentArguments("claude", "off")).toThrow("Unsupported thinking level");
  expect(() => agentArguments("pi", "--no-tools")).toThrow("Unsupported thinking level");
});

test("agent PTY checks availability, authorization, arguments, input, and session limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "dirito-agent-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  // A fake CLI keeps this test offline and cannot spend API credits.
  await Bun.write(join(bin, "codex"), `#!/bin/sh
: > agent-started
printf 'AGENT_CWD:'; pwd
printf 'AGENT_ARG:%s\\n' "$@"
printf 'AGENT_READY\\n'
while IFS= read -r line; do
  [ "$line" = exit ] && exit 0
  printf 'AGENT_INPUT:%s\\n' "$line"
done
`);
  await chmod(join(bin, "codex"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  const sockets: WebSocket[] = [];
  let app: Awaited<ReturnType<typeof startWorkspace>> | undefined;
  try {
    app = await startWorkspace(root, { port: 0 });
    const origin = app.server.url.origin;
    const httpSocket = `${origin}/api/socket?kind=agent&token=${app.token}`;
    const probe = (query: string, headers = { Origin: origin }) => fetch(`${httpSocket}&${query}`, { headers });
    const state = await (await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${app.token}` } })).json();
    expect(state.agents.map((agent: any) => [agent.id, agent.available])).toEqual([["codex", true], ["pi", false], ["claude", false]]);
    expect((await probe("agent=bash&thinking=default")).status).toBe(400);
    expect((await probe("agent=codex&thinking=--dangerously-bypass-approvals-and-sandbox")).status).toBe(400);
    expect((await probe("agent=pi&thinking=default")).status).toBe(503);
    expect((await probe("agent=codex&thinking=default", { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await fetch(`${httpSocket}&agent=codex&thinking=default`)).status).toBe(403);
    expect((await fetch(`${origin}/api/socket?kind=agent&token=wrong&agent=codex`, { headers: { Origin: origin } })).status).toBe(401);
    expect((await probe("agent=codex&thinking=default")).status).toBe(426);
    expect(await Bun.file(join(root, "agent-started")).exists()).toBe(false);

    const BunSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    function connect() {
      const ws = new BunSocket(`${httpSocket.replace(/^http/, "ws")}&agent=codex&thinking=high`, { headers: { Origin: origin } });
      ws.binaryType = "arraybuffer"; sockets.push(ws); return ws;
    }
    const ws = connect();
    let output = "";
    let ready!: () => void;
    let input!: () => void;
    const readyResult = new Promise<void>(resolve => { ready = resolve; });
    const inputResult = new Promise<void>(resolve => { input = resolve; });
    const closed = new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true }));
    ws.onmessage = event => {
      output += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      if (output.includes("AGENT_READY")) ready();
      if (output.includes("AGENT_INPUT:hello from browser")) input();
    };
    await readyResult;
    expect(output).toContain(root);
    expect(output).toContain("AGENT_ARG:-c");
    expect(output).toContain('AGENT_ARG:model_reasoning_effort="high"');
    ws.send(JSON.stringify({ type: "resize", cols: 70, rows: 25 }));
    ws.send(JSON.stringify({ type: "input", data: "hello from browser\r" }));
    await inputResult;
    ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
    await closed;
    expect(output).toContain("[Agent exited: 0]");
    for (let i = 0; i < 8; i++) {
      const session = connect();
      await new Promise<void>((resolve, reject) => {
        session.addEventListener("open", () => resolve(), { once: true });
        session.addEventListener("error", reject, { once: true });
      });
    }
    expect((await probe("agent=codex&thinking=high")).status).toBe(429);
    expect((await fetch(`${origin}/api/socket?kind=terminal&token=${app.token}`, { headers: { Origin: origin } })).status).toBe(429);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    for (const ws of sockets) ws.close();
    await app?.stop();
  }
}, 15000);

