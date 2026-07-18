import { randomBytes } from "node:crypto";
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
          msgId: command.messageId,
          targetSessionId: agentId,
          deliveryEndpoint: gatewayUrl,
          prompt: gatewayPromptText(command),
          hops: 0,
          receivedAt: new Date().toISOString(),
        }, inbound);
      });
      runtime = { client, token, agentId, session };
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
    const command = commands.get(prompt.msgId);
    if (!command) return;
    const response = extractLastAssistantText(ctx);
    runtime.session.complete(command, { response, status: "completed" });
    commands.delete(prompt.msgId);
    inbound.delete(prompt.msgId);
  });

  pi.registerTool({
    name: "onclave_send",
    label: "Onclave Send",
    description: "Submit a task prompt to an enrolled Onclave agent through the gateway.",
    parameters: Type.Object({
      target_agent_id: Type.String({ description: "Enrolled target agent ID.", maxLength: 256 }),
      prompt: Type.String({ description: "Prompt to deliver.", maxLength: MAX_MESSAGE_LENGTH }),
    }),
    async execute(_callId, params) {
      const active = requireRuntime(runtime);
      const messageId = `msg_${randomId()}`;
      const taskId = `task_${randomId()}`;
      const task = await active.client.submitCommand(active.token, {
        messageId,
        taskId,
        correlationId: `corr_${randomId()}`,
        sourceAgentId: active.agentId,
        targetAgentId: params.target_agent_id,
        type: "task.assign",
        expiresAt: new Date(Date.now() + MAX_WAIT_TIMEOUT_MS).toISOString(),
        payload: { instruction: params.prompt },
      });
      return {
        content: [{ type: "text" as const, text: `task submitted: ${taskId}` }],
        details: { messageId, taskId, task },
      };
    },
  });

  pi.registerTool({
    name: "onclave_get",
    label: "Onclave Get",
    description: "Retrieve an Onclave task by task ID.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by onclave_send." }),
    }),
    async execute(_callId, params) {
      const active = requireRuntime(runtime);
      const task = await active.client.getTask(active.token, params.task_id);
      return {
        content: [{ type: "text" as const, text: formatTask(task) }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "onclave_await",
    label: "Onclave Await",
    description: "Wait for an Onclave task to reach a terminal state.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by onclave_send." }),
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
      return {
        content: [{ type: "text" as const, text: formatTask(task) }],
        details: { task },
      };
    },
  });
}

async function deliverInboundPrompt(
  pi: ExtensionAPI,
  prompt: DeliveredPrompt,
  inbound: Map<string, DeliveredPrompt>,
): Promise<void> {
  inbound.set(prompt.msgId, prompt);
  pi.sendMessage({
    customType: "onclave-inbound",
    content: `[inbound onclave task ${prompt.msgId}]\n\n${prompt.prompt}`,
    display: true,
    details: { msgId: prompt.msgId },
  }, { triggerTurn: true, deliverAs: "followUp" });
}

function findInboundPrompt(messages: unknown[], inbound: Map<string, DeliveredPrompt>): DeliveredPrompt | null {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const record = message as { customType?: unknown; details?: { msgId?: unknown } };
    if (record.customType === "onclave-inbound" && typeof record.details?.msgId === "string") {
      return inbound.get(record.details.msgId) ?? null;
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

function formatTask(task: GatewayTask): string {
  return `${task.taskId}: ${task.state}${task.result === undefined ? "" : `\n${JSON.stringify(task.result, null, 2)}`}`;
}

function isTerminal(task: GatewayTask): boolean {
  return ["completed", "failed", "cancelled", "expired"].includes(task.state);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomId(): string {
  return randomBytes(10).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
