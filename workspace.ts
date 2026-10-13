import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { EditorView } from "@codemirror/view";
import { createEditorState } from "./editor";
import { resizePane } from "./resize";
import type { codingAgents } from "./agents";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const editorContainer = el("editor");
const editor = new EditorView({ parent: editorContainer, state: createEditorState("", "", updateEditor) });
const saveButton = el<HTMLButtonElement>("save");
const token = location.hash.slice(1) || sessionStorage.getItem("dirito-token") || "";
if (token) sessionStorage.setItem("dirito-token", token);
history.replaceState(null, "", location.pathname);
let directory = "";
let selected = "";
let active = "";
let original = "";
let fileVersion = "";
let previewURL = "";
let saving = false;
const dirty = () => !!active && editor.state.sliceDoc() !== original;
const status = (message: string, error = false) => { el("status").textContent = message; el("status").style.color = error ? "#f0afa2" : ""; };
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: response.status === 401 ? "Open the private workspace URL printed in your terminal." : `Request failed: ${response.status}` }));
  if (!response.ok) throw new Error(data.error);
  return data;
}
const run = (action: () => Promise<unknown>) => { void action().catch(error => status(error.message, true)); };
const discard = () => !dirty() || confirm("Discard unsaved changes?");
function updateEditor() {
  el("dirty").textContent = dirty() ? "Unsaved" : "";
  saveButton.disabled = !dirty() || saving;
  const head = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(head);
  el("cursor").textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}
function select(path: string) {
  selected = path;
  el<HTMLButtonElement>("rename").disabled = !path;
  el<HTMLButtonElement>("delete").disabled = !path;
  for (const button of el("files").querySelectorAll("button")) button.classList.toggle("selected", button.dataset.path === path);
}
function clearEditor() {
  active = ""; original = "";
  editor.setState(createEditorState("", "", updateEditor));
  editorContainer.hidden = true; el("editor-empty").hidden = false;
  el("filename").textContent = "Editor"; updateEditor();
}
async function list() {
  const entries: { name: string; directory: boolean; symlink: boolean }[] = await api(`files?path=${encodeURIComponent(directory)}`);
  el("directory").textContent = directory ? `/${directory}` : "/";
  el<HTMLButtonElement>("up").disabled = !directory;
  const items = entries.map(entry => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    button.textContent = `${entry.directory ? "▸ " : entry.symlink ? "↗ " : "  "}${entry.name}`;
    button.title = entry.symlink ? `${path} (symlink)` : path;
    button.dataset.path = path;
    button.classList.toggle("selected", selected === path);
    button.onclick = () => run(async () => {
      if (entry.directory) select(path);
      else {
        if (saving || !discard()) return;
        const file = await api(`file?path=${encodeURIComponent(path)}`);
        select(path); active = path; original = file.text; fileVersion = file.version;
        editor.setState(createEditorState(file.text, path, updateEditor));
        editorContainer.hidden = false; el("editor-empty").hidden = true;
        el("filename").textContent = path; updateEditor(); editor.focus(); status(`Opened ${path}`);
      }
    });
    li.append(button);
    if (entry.directory || entry.symlink) {
      const enter = () => run(async () => { await api(`files?path=${encodeURIComponent(path)}`); directory = path; select(""); await list(); });
      button.ondblclick = enter;
      const open = document.createElement("button");
      open.textContent = "→"; open.className = "enter-folder";
      open.setAttribute("aria-label", `Enter ${entry.name}`); open.onclick = enter; li.append(open);
    }
    return li;
  });
  el("files").replaceChildren(...items);
}
async function save() {
  if (!dirty() || saving) return;
  saving = true; updateEditor();
  const text = editor.state.sliceDoc();
  try {
    const result = await api("file", "PUT", { path: active, text, version: fileVersion });
    original = text; fileVersion = result.version;
    status(`Saved ${active}`);
  } finally { saving = false; updateEditor(); }
}
function reload() {
  if (!previewURL) return;
  el<HTMLIFrameElement>("preview").src = previewURL;
  el<HTMLAnchorElement>("preview-open").href = previewURL;
  el<HTMLInputElement>("preview-path").title = previewURL;
}
function socket(kind: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({ ...params, kind, token });
  return new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/socket?${query}`);
}

function createConsole(id: string, kind: "terminal" | "agent", onClose = () => {}, onOpen = () => {}) {
  const container = el(id);
  const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", theme: { background: "#111612", foreground: "#d8e3d1", cursor: "#b7dc92" }, scrollback: 5000 });
  const fit = new FitAddon();
  terminal.loadAddon(fit); terminal.open(container);
  let connection: WebSocket | undefined;
  function fitTerminal() {
    if (!container.clientWidth || !container.clientHeight) return;
    fit.fit();
    if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
  }
  function connect(params: Record<string, string> = {}) {
    connection?.close(); terminal.reset();
    const ws = socket(kind, params); connection = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (ws !== connection) return;
      fitTerminal(); onOpen();
      if (kind === "agent") terminal.focus(); else status("Terminal ready");
    };
    ws.onmessage = event => { if (ws === connection) terminal.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data); };
    ws.onclose = () => {
      if (ws !== connection) return;
      connection = undefined;
      terminal.write(`\r\n[Disconnected. Use ${kind === "agent" ? "Start" : "New session"} to reconnect.]\r\n`);
      onClose();
    };
    ws.onerror = () => { if (ws === connection) status(`${kind === "agent" ? "Agent" : "Terminal"} connection failed. Check the CLI installation, server, and workspace URL.`, true); };
  }
  function stop() {
    connection?.close(); connection = undefined;
    terminal.write("\r\n[Session closed]\r\n"); onClose();
  }
  terminal.onData(data => { if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "input", data })); });
  new ResizeObserver(fitTerminal).observe(container);
  window.addEventListener("pagehide", stop);
  return { connect, stop, fit: fitTerminal, active: () => !!connection && connection.readyState < WebSocket.CLOSING };
}
const shellConsole = createConsole("terminal", "terminal");
const agentSelect = el<HTMLSelectElement>("agent-select");
const thinkingSelect = el<HTMLSelectElement>("thinking-select");
const startAgent = el<HTMLButtonElement>("start-agent");
const stopAgent = el<HTMLButtonElement>("stop-agent");
let agents: ((typeof codingAgents)[number] & { available: boolean })[] = [];
function updateThinking() {
  const agent = agents.find(agent => agent.id === agentSelect.value);
  thinkingSelect.replaceChildren(...(agent?.thinking ?? []).map(level => new Option(level === "default" ? "Default" : level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1), level)));
  thinkingSelect.disabled = !agent?.available;
  startAgent.disabled = !agent?.available;
}
const agentConsole = createConsole("agent-terminal", "agent", () => {
  startAgent.textContent = "Start"; stopAgent.disabled = true;
  el("agent-status").textContent = "Stopped";
}, () => { el("agent-status").textContent = "Running"; });
agentSelect.onchange = updateThinking;
startAgent.onclick = () => {
  if (agentConsole.active() && !confirm("Restart the coding agent? This ends the current agent session.")) return;
  el("agent-empty").hidden = true; el("agent-terminal").hidden = false;
  startAgent.textContent = "Restart"; stopAgent.disabled = false;
  el("agent-status").textContent = "Starting…";
  agentConsole.connect({ agent: agentSelect.value, thinking: thinkingSelect.value });
};
stopAgent.onclick = agentConsole.stop;
const viewTabs = [el<HTMLButtonElement>("agent-tab"), el<HTMLButtonElement>("preview-tab")];
function showView(index: number) {
  el("agent-panel").hidden = index !== 0; el("agent-status").hidden = index !== 0;
  el("preview-panel").hidden = index !== 1; el("preview-actions").hidden = index !== 1;
  viewTabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
  if (index === 0) requestAnimationFrame(agentConsole.fit);
}
viewTabs.forEach((tab, index) => {
  tab.onclick = () => showView(index);
  tab.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
    showView(target); viewTabs[target]!.focus();
  };
});
resizePane(el("files-resize"), el("file-pane"));
resizePane(el("preview-resize"), el("editor-pane"));
resizePane(el("terminal-resize"), el("terminal-pane"));

document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); run(save); }
});
window.addEventListener("beforeunload", event => { if (dirty() || saving) { event.preventDefault(); event.returnValue = ""; } });
el("save").onclick = () => run(save);
el("refresh").onclick = () => run(list);
el("up").onclick = () => run(async () => { directory = directory.split("/").slice(0, -1).join("/"); select(""); await list(); });
el("reload").onclick = reload;
el<HTMLFormElement>("preview-form").onsubmit = event => {
  event.preventDefault();
  if (!previewURL) return;
  const input = el<HTMLInputElement>("preview-path");
  const path = "/" + input.value.trim().replace(/^\/+/, "");
  const url = new URL(previewURL);
  url.pathname = path.split("/").map(encodeURIComponent).join("/");
  previewURL = url.href;
  input.value = path;
  reload(); status(`Previewing ${url.pathname}`);
};
el("reconnect").onclick = () => { if (confirm("Start a new shell session? The current session will close.")) shellConsole.connect(); };
for (const [id, folder] of [["new-file", false], ["new-folder", true]] as const) {
  el(id).onclick = () => run(async () => {
    const name = prompt(folder ? "New folder name" : "New file name");
    if (!name) return;
    const path = directory ? `${directory}/${name}` : name;
    await api("files", "POST", { path, directory: folder }); await list(); status(`Created ${path}`);
  });
}
el("rename").onclick = () => run(async () => {
  if (!selected || saving || !discard()) return;
  const path = selected;
  const to = prompt("Rename to a workspace-relative path", path);
  if (!to || to === path) return;
  await api("rename", "POST", { path, to });
  if (directory === path || directory.startsWith(path + "/")) directory = directory.replace(path, to);
  clearEditor(); select(""); await list(); status(`Renamed ${path} to ${to}`);
});
el("delete").onclick = () => run(async () => {
  if (!selected || saving) return;
  const path = selected;
  const answer = prompt(`Delete ${path}? This cannot be undone. Type the full path to confirm.`);
  if (answer !== path) return;
  if (!discard()) return;
  await api("files", "DELETE", { path, confirm: answer });
  if (directory === path) directory = path.split("/").slice(0, -1).join("/");
  clearEditor(); select(""); await list(); status(`Deleted ${path}`);
});
el("settings-toggle").onclick = () => {
  const panel = el("settings"); panel.hidden = !panel.hidden;
  el("settings-toggle").setAttribute("aria-expanded", String(!panel.hidden));
};
el<HTMLFormElement>("settings-form").onsubmit = event => {
  event.preventDefault();
  run(async () => {
    await api("settings", "PUT", { watch: el<HTMLInputElement>("watch").checked, proxy: el<HTMLInputElement>("proxy").value.trim() });
    reload(); status("Settings applied");
  });
};

run(async () => {
  const state = await api("state");
  el("root").textContent = state.root; el("root").title = state.root;
  document.title = `${state.root.split(/[\\/]/).filter(Boolean).at(-1)} · dirito`;
  el<HTMLInputElement>("watch").checked = state.watch; el<HTMLInputElement>("proxy").value = state.proxy;
  el("app-version").textContent = `v${state.version}`;
  el("app-version").hidden = false;
  agents = state.agents;
  agentSelect.replaceChildren(...agents.map(agent => {
    const option = new Option(agent.name + (agent.available ? "" : " (not installed)"), agent.id);
    option.disabled = !agent.available; return option;
  }));
  const installed = agents.find(agent => agent.available);
  agentSelect.value = (installed ?? agents[0])?.id ?? "";
  agentSelect.disabled = !installed; updateThinking();
  el("agent-status").textContent = installed ? "Ready" : "Not installed";
  el("agent-hint").textContent = installed ? "Choose an agent and thinking level, then Start. Uses your local CLI login and settings." : "Install Codex, Pi, or Claude Code on PATH and log in locally, then reload this page.";
  previewURL = state.preview;
  reload(); await list(); shellConsole.connect();
  let refreshTimer: ReturnType<typeof setTimeout>;
  let reconnectTimer: ReturnType<typeof setTimeout>;
  function connectEvents() {
    const ws = socket("events");
    ws.onopen = () => { el("connection").textContent = "Local · connected"; };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      el("activity").textContent = `${message.path || "/"} · ${new Date(message.time).toLocaleTimeString()}`;
      if (message.path === active) status(`Disk changed: ${active}. Reopen before editing if another tool changed it.`);
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => run(list), 150);
    };
    ws.onclose = () => { el("connection").textContent = "Disconnected"; reconnectTimer = setTimeout(connectEvents, 2000); };
    window.addEventListener("pagehide", () => { ws.onclose = null; clearTimeout(reconnectTimer); ws.close(); }, { once: true });
  }
  connectEvents(); status("Workspace ready");
});
