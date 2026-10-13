export const codingAgents = [
  { id: "codex", name: "Codex", thinking: ["default", "low", "medium", "high", "xhigh"] },
  { id: "pi", name: "Pi", thinking: ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "claude", name: "Claude Code", thinking: ["default", "low", "medium", "high", "max"] },
];

export function agentArguments(id: string, thinking: string) {
  const agent = codingAgents.find(agent => agent.id === id);
  if (!agent) throw new Error("Unknown coding agent. Choose Codex, Pi, or Claude Code.");
  if (!agent.thinking.includes(thinking)) throw new Error("Unsupported thinking level for this agent.");
  if (thinking === "default") return [agent.id];
  if (id === "codex") return [id, "-c", `model_reasoning_effort="${thinking}"`];
  return [id, id === "pi" ? "--thinking" : "--effort", thinking];
}
