import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadIdentityPrivateKeyHex } from "./lib/identity";
import { getOnclavePaths } from "./lib/state";
import { OnclaveGatewayClient, type GatewayTask } from "./lib/gateway-adapter";
import { PiGatewaySession, type PiGatewayCommand } from "./lib/pi-gateway-session";
import type { DeliveredPrompt } from "./lib/messages";

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const REQUIRED_CAPABILITIES = ["message.send", "message.receive"];

type GatewayRuntime = {
  client: OnclaveGatewayClient;
  token: string;
  agentId: string;
  session: PiGatewaySession;
  capabilities: string[];
};

export default function (pi: ExtensionAPI) {
  const paths = getOnclavePaths(join(getAgentDir(), "onclave"));
  let runtime: GatewayRuntime | null = null;
  let sessionUi: ExtensionContext["ui"] | null = null;
  const inbound = new Map<string, DeliveredPrompt>();
  const commands = new Map<string, PiGatewayCommand>();

  pi.on("session_start", async (_event, ctx) => {
    sessionUi = ctx.ui;
    try {
      const gatewayUrl = requiredEnvironment("ONCLAVE_GATEWAY_URL");
      const agentId = requiredEnvironment("ONCLAVE_AGENT_ID");
      const client = new OnclaveGatewayClient({ baseUrl: gatewayUrl });
      const token = await client.authenticateWithPrivateKey(agentId, await loadIdentityPrivateKeyHex(paths));
      const capabilityRequest = await client.requestCapabilities(token, agentId);
      await client.acceptCapabilities(token, agentId, capabilityRequest, REQUIRED_CAPABILITIES);
      const refreshToken = async (): Promise<string> => {
        const refreshed = await client.authenticateWithPrivateKey(agentId, await loadIdentityPrivateKeyHex(paths));
        const refreshedRequest = await client.requestCapabilities(refreshed, agentId);
        await client.acceptCapabilities(refreshed, agentId, refreshedRequest, REQUIRED_CAPABILITIES);
        if (runtime) runtime.token = refreshed;
        return refreshed;
      };
      const session = new PiGatewaySession(client, agentId, refreshToken, async (command) => {
        commands.set(command.messageId, command);
        await deliverInboundPrompt(pi, {
          messageId: command.messageId,
          taskId: command.taskId,
          correlationId: typeof command.correlationId === "string" ? command.correlationId : undefined,
          sourceAgentId: typeof command.sourceAgentId === "string" ? command.sourceAgentId : undefined,
          targetAgentId: typeof command.targetAgentId === "string" ? command.targetAgentId : agentId,
          messageType: typeof command.messageType === "string" ? command.messageType : "task.assign",
          payload: command.payload ?? {},
          instruction: gatewayPromptText(command),
          receivedAt: new Date().toISOString(),
        }, inbound);
      });
      runtime = { client, token, agentId, session, capabilities: [...REQUIRED_CAPABILITIES] };
      session.connect();
      sessionUi?.setStatus?.("onclave", `gateway: ${agentId}`);
    } catch (error) {
      runtime = null;
      ctx.ui.notify(`Onclave gateway initialization failed: ${safeErrorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    runtime?.session.close();
    runtime = null;
    inbound.clear();
    commands.clear();
    sessionUi?.setStatus?.("onclave", undefined);
    sessionUi = null;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!runtime) return;
    const prompt = findInboundPrompt(event.messages, inbound);
    if (!prompt) return;
    const command = commands.get(prompt.messageId);
    if (!command) return;
    const response = extractLastAssistantText(ctx);
    runtime.session.complete(command, { response, status: "completed" });
    commands.delete(prompt.messageId);
    inbound.delete(prompt.messageId);
  });

  pi.registerTool({
    name: "onclave_status",
    label: "Onclave Status",
    description: "Report local Onclave readiness without making a network request.",
    parameters: Type.Object({}),
    async execute() {
      const status = await getLocalStatus(paths, runtime);
      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }], details: status };
    },
  });

  pi.registerTool({
    name: "onclave_send",
    label: "Onclave Send",
    description: "Submit asynchronous work to an enrolled Onclave agent.",
    parameters: Type.Object({
      target_agent_id: Type.String({ description: "Enrolled target agent ID.", minLength: 1, maxLength: 256 }),
      instruction: Type.String({ description: "Instruction to deliver.", minLength: 1, maxLength: MAX_MESSAGE_LENGTH }),
      task_id: Type.Optional(Type.String({ description: "Optional stable task ID.", minLength: 1, maxLength: 256 })),
      correlation_id: Type.Optional(Type.String({ description: "Optional workflow ID.", minLength: 1, maxLength: 256 })),
      expires_at: Type.Optional(Type.String({ description: "Optional RFC3339 UTC expiry.", maxLength: 64 })),
    }),
    async execute(_callId, params) {
      const active = requireRuntime(runtime);
      if (params.expires_at !== undefined && !isRfc3339(params.expires_at)) {
        throw new Error("expires_at must be an RFC3339 timestamp");
      }
      const messageId = `msg_${randomId()}`;
      const taskId = params.task_id ?? `task_${randomId()}`;
      const task = await active.client.submitCommand(active.token, {
        messageId,
        taskId,
        correlationId: params.correlation_id ?? `corr_${randomId()}`,
        sourceAgentId: active.agentId,
        targetAgentId: params.target_agent_id,
        type: "task.assign",
        expiresAt: params.expires_at ?? new Date(Date.now() + MAX_WAIT_TIMEOUT_MS).toISOString(),
        payload: { instruction: params.instruction },
      });
      const details = taskDetails(task, messageId);
      return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "onclave_task",
    label: "Onclave Task",
    description: "Read the current state of an Onclave task.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID to read.", minLength: 1, maxLength: 256 }),
    }),
    async execute(_callId, params) {
      const active = requireRuntime(runtime);
      const task = await active.client.getTask(active.token, params.task_id);
      const details = taskDetails(task);
      return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "onclave_cancel",
    label: "Onclave Cancel",
    description: "Request cancellation of an owned Onclave task.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID to cancel.", minLength: 1, maxLength: 256 }),
      reason: Type.Optional(Type.String({ description: "Reason for cancellation.", maxLength: 2_000 })),
    }),
    async execute(_callId, params) {
      const active = requireRuntime(runtime);
      const task = await active.client.cancelTask(active.token, params.task_id, params.reason);
      const details = taskDetails(task);
      return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "onclave_await",
    label: "Onclave Await",
    description: "Wait for an Onclave task to reach a terminal state.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID to wait for.", minLength: 1, maxLength: 256 }),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_TIMEOUT_MS })),
    }),
    async execute(_callId, params) {
      const active = requireRuntime(runtime);
      const timeoutMs = Math.min(params.timeout_ms ?? 30_000, MAX_WAIT_TIMEOUT_MS);
      const deadline = Date.now() + timeoutMs;
      let task = await active.client.getTask(active.token, params.task_id);
      while (!isTerminal(task) && Date.now() < deadline) {
        await sleep(250);
        task = await active.client.getTask(active.token, params.task_id);
      }
      const details = taskDetails(task);
      return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
    },
  });
}

async function deliverInboundPrompt(
  pi: ExtensionAPI,
  prompt: DeliveredPrompt,
  inbound: Map<string, DeliveredPrompt>,
): Promise<void> {
  inbound.set(prompt.messageId, prompt);
  pi.sendMessage({
    customType: "onclave-inbound",
    content: `[inbound Onclave task ${prompt.taskId}]\n\n${prompt.instruction}`,
    display: true,
    details: {
      message_id: prompt.messageId,
      task_id: prompt.taskId,
      ...(prompt.correlationId ? { correlation_id: prompt.correlationId } : {}),
      ...(prompt.sourceAgentId ? { source_agent_id: prompt.sourceAgentId } : {}),
      ...(prompt.targetAgentId ? { target_agent_id: prompt.targetAgentId } : {}),
      message_type: prompt.messageType,
      payload: prompt.payload,
      received_at: prompt.receivedAt,
    },
  }, { triggerTurn: true, deliverAs: "followUp" });
}

function findInboundPrompt(messages: unknown[], inbound: Map<string, DeliveredPrompt>): DeliveredPrompt | null {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const record = message as { customType?: unknown; details?: { message_id?: unknown } };
    if (record.customType === "onclave-inbound" && typeof record.details?.message_id === "string") {
      return inbound.get(record.details.message_id) ?? null;
    }
  }
  return null;
}

function gatewayPromptText(command: PiGatewayCommand): string {
  const instruction = command.payload?.instruction;
  return typeof instruction === "string" ? instruction : JSON.stringify(command.payload ?? {}, null, 2);
}

function extractLastAssistantText(ctx: ExtensionContext): string {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter((block): block is { type: "text"; text: string } =>
        Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ).map((block) => block.text).join("\n");
    }
  }
  return "";
}

function requireRuntime(runtime: GatewayRuntime | null): GatewayRuntime {
  if (!runtime) throw new Error("Onclave gateway is not initialized");
  return runtime;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function taskDetails(task: GatewayTask, messageId?: string): Record<string, unknown> {
  return {
    ...(messageId ? { message_id: messageId } : {}),
    task_id: task.taskId,
    state: task.state,
    ...(task.progress === undefined ? {} : { progress: task.progress }),
    ...(task.note === undefined ? {} : { note: task.note }),
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.createdAt === undefined ? {} : { created_at: task.createdAt }),
    ...(task.updatedAt === undefined ? {} : { updated_at: task.updatedAt }),
  };
}

function isRfc3339(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isTerminal(task: GatewayTask): boolean {
  return ["completed", "failed", "cancelled", "expired"].includes(task.state);
}

async function getLocalStatus(paths: ReturnType<typeof getOnclavePaths>, runtime: GatewayRuntime | null): Promise<Record<string, unknown>> {
  const gatewayUrl = process.env.ONCLAVE_GATEWAY_URL?.trim();
  const agentId = process.env.ONCLAVE_AGENT_ID?.trim();
  const keyAvailable = await access(paths.privateKey).then(() => true, () => false);
  const configured = Boolean(gatewayUrl && agentId && keyAvailable && isHttpsGatewayUrl(gatewayUrl));
  return {
    configured,
    authenticated: runtime !== null,
    connected: runtime?.session.isConnected() ?? false,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(gatewayUrl && isHttpsGatewayUrl(gatewayUrl) ? { gateway_url: new URL(gatewayUrl).origin } : {}),
    capabilities: runtime?.capabilities ?? [],
  };
}

function isHttpsGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/[a-f0-9]{64}/gi, "[REDACTED]");
}

function randomId(): string {
  return randomBytes(10).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
