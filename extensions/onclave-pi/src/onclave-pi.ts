import { hostname } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { A2A_PROTOCOL_VERSION, createMessage, type AgentCard, type A2AOrigin, type Message, type TaskStatusEvent } from "@onclave/envelope";
import { appendAdapterAuditEvent, type AdapterAuditEventName, type AdapterAuditMetadata } from "./lib/audit";
import { loadApiBaseFromBws } from "./lib/bws";
import { HttpLink, type ConnectionState } from "./lib/connection";
import { CorrelationStore, INBOUND_CUSTOM_TYPE, STATUS_CUSTOM_TYPE } from "./lib/correlation";
import { SeenIds } from "./lib/dedup";
import { handleInbound, shouldTriggerStatusTurn, type Delivered } from "./lib/delivery";
import { buildInformDisplayText, buildMessageFraming, buildStatusFraming } from "./lib/framing";
import { OnclaveHttpClient, resolveApiBase, type Delivery } from "./lib/http-client";
import { loadDefaultRequestSigner } from "./lib/http-signer";
import { isAutoAccepted, loadAdapterPolicy } from "./lib/policy";
import { resolveProjectLabel } from "./lib/project-label";
import { lastAssistantText, runUsage } from "./lib/run-summary";
import { initializeRootCapability, isPiSubagent, ONCLAVE_ROOT_CAPABILITY_ENV, ONCLAVE_SUBAGENT_SENTINEL_ENV } from "./lib/root-capability";

export { initializeRootCapability, isPiSubagent, ONCLAVE_ROOT_CAPABILITY_ENV, ONCLAVE_SUBAGENT_SENTINEL_ENV, resolveApiBase };
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DELIVERY_WAIT_MS = 25_000;
const FOOTER_STATUS_KEY = "onclave-v2";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
const ADAPTER_TOOL_NAMES = ["onclave_instances", "onclave_message"] as const;
type Runtime = { card: AgentCard; link: HttpLink; client: OnclaveHttpClient; state: ConnectionState; correlation: CorrelationStore; seen: SeenIds; ui: ExtensionContext["ui"]; sendMessage: (message: unknown, options: { triggerTurn: boolean; deliverAs: "followUp" }) => void; aliveInstances: number; registered: boolean };
type Audit = (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>;
type RuntimeGetter = () => Runtime | null;

export default function onclavePi(pi: ExtensionAPI): void {
  if (!initializeRootCapability()) return;
  pi.registerFlag("onclave-id", { description: "Override the Onclave instance id", type: "string", default: undefined });
  pi.registerFlag("onclave-url", { description: "HTTPS API base URL for Onclave", type: "string", default: undefined });
  const dir = join(getAgentDir(), "onclave");
  const auditPath = join(dir, "v2-audit.jsonl");
  const policyPath = join(dir, "v2-policy.json");
  const audit: Audit = (event, metadata = {}) => appendAdapterAuditEvent(auditPath, event, metadata);
  let runtime: Runtime | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const inherited = process.env.ONCLAVE_AGENT_ID;
  let exposed: string | undefined;
  pi.on("session_start", async (_event, ctx) => {
    setAdapterToolsActive(pi, false);
    try {
      runtime = await startAdapter(pi, ctx, { audit, policyPath, onRegistered: (id) => { exposed = id; process.env.ONCLAVE_AGENT_ID = id; setAdapterToolsActive(pi, true); }, onDisconnected: () => { setAdapterToolsActive(pi, false); if (process.env.ONCLAVE_AGENT_ID === exposed) { if (inherited === undefined) delete process.env.ONCLAVE_AGENT_ID; else process.env.ONCLAVE_AGENT_ID = inherited; } exposed = undefined; } });
      heartbeat = setInterval(() => { void heartbeatTick(runtime).catch(() => undefined); }, HEARTBEAT_INTERVAL_MS); heartbeat.unref?.();
    } catch (error) { ctx.ui.notify(`Onclave initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  });
  pi.on("session_shutdown", async () => { setAdapterToolsActive(pi, false); if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; } if (runtime !== null) { await shutdownAdapter(runtime, audit); runtime = null; } if (process.env.ONCLAVE_AGENT_ID === exposed) { if (inherited === undefined) delete process.env.ONCLAVE_AGENT_ID; else process.env.ONCLAVE_AGENT_ID = inherited; } exposed = undefined; });
  pi.on("agent_end", async (event) => { if (runtime !== null) await submitRunReply(runtime, event.messages, audit); });
  registerAdapterTools(pi, () => runtime, audit);
  pi.registerCommand("onclave", { description: "Show Onclave instance status", handler: async (_args, ctx) => ctx.ui.notify(statusText(runtime), "info") });
}

export function setAdapterToolsActive(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, active: boolean): void {
  const current = pi.getActiveTools();
  const adapterTools = new Set<string>(ADAPTER_TOOL_NAMES);
  const next = active
    ? [...current, ...ADAPTER_TOOL_NAMES.filter((name) => !current.includes(name))]
    : current.filter((name) => !adapterTools.has(name));
  if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);
}

type StartOptions = { audit: Audit; policyPath: string; onRegistered?: (instanceId: string) => void; onDisconnected?: () => void };
export type ApiBaseLoader = () => Promise<string | undefined>;
export async function resolveAdapterApiBase(explicitUrl: string | undefined, environment: NodeJS.ProcessEnv = process.env, loader: ApiBaseLoader = () => loadApiBaseFromBws(environment)): Promise<string> { if (explicitUrl !== undefined || environment.ONCLAVE_API_BASE !== undefined) return resolveApiBase(explicitUrl, environment); const base = await loader(); if (base === undefined) throw new Error("Onclave BWS bootstrap is missing BITWARDEN_ACCESS_KEY"); return resolveApiBase(base, {}); }

async function startAdapter(pi: ExtensionAPI, ctx: ExtensionContext, options: StartOptions): Promise<Runtime> {
  const card = await buildAgentCard(pi, ctx);
  const client = new OnclaveHttpClient({ apiBase: await resolveAdapterApiBase(readStringFlag(pi, "onclave-url")), signer: await loadDefaultRequestSigner() });
  const runtime = { card, link: undefined as unknown as HttpLink, client, state: "disconnected" as ConnectionState, correlation: new CorrelationStore(), seen: new SeenIds(), ui: ctx.ui, sendMessage: (message: unknown, options: { triggerTurn: boolean; deliverAs: "followUp" }) => pi.sendMessage(message as never, options), aliveInstances: 0, registered: false };
  runtime.link = new HttpLink({ retryBaseMs: 500, retryMaxMs: 15_000, onReady: (signal) => onHttpReady(runtime, options, signal), poll: (signal) => receive(runtime, options, signal), onStateChange: (state, detail) => { runtime.state = state; if (state === "disconnected") { runtime.registered = false; options.onDisconnected?.(); void options.audit("adapter_disconnect", { detail: detail ?? "" }); } refreshFooterStatus(runtime); } });
  runtime.link.start(); refreshFooterStatus(runtime); return runtime;
}
async function onHttpReady(runtime: Runtime, options: StartOptions, signal: AbortSignal): Promise<void> {
  const response = await runtime.client.call({ op: "register", protocol_version: A2A_PROTOCOL_VERSION, card: runtime.card }, signal);
  if (response.ok !== true) throw new Error(`register rejected: ${String(response.error ?? "unknown")}`);
  runtime.registered = true; options.onRegistered?.(runtime.card.agent_id); await updateAliveInstances(runtime); await options.audit("adapter_register", { instance_id: runtime.card.agent_id });
}
async function receive(runtime: Runtime, options: StartOptions, signal: AbortSignal): Promise<void> { const delivery = await runtime.client.next(runtime.card.agent_id, DELIVERY_WAIT_MS, signal); if (delivery === undefined) return; await consume(runtime, delivery, options); }
async function consume(runtime: Runtime, delivery: Delivery, options: StartOptions): Promise<void> {
  const delivered: Delivered = delivery.kind === "message" && delivery.message !== undefined ? { kind: "message", message: delivery.message } : delivery.kind === "task-status" && delivery.status !== undefined ? { kind: "task-status", status: delivery.status } : (() => { throw new Error("invalid delivery"); })();
  const deps = buildDeliveryDeps(runtime, options);
  let decision: "ack" | "reject" = "reject";
  try { decision = await handleInbound(deps, delivered); } finally { await runtime.client.dispose(delivery.deliveryId, decision); }
}
function buildDeliveryDeps(runtime: Runtime, options: StartOptions) {
  return {
    localHost: runtime.card.host, seen: runtime.seen, correlation: runtime.correlation,
    isAutoAcceptedHost: async (host: string) => isAutoAccepted(await loadAdapterPolicy(options.policyPath), host),
    confirmRemote: (message: Message) => runtime.ui.confirm("Onclave cross-host request", `Independent instance ${message.origin.name} [${message.origin.instance_id}] on host ${message.origin.host} requests a turn. Allow it?`),
    createTask: async (message: Message) => {
      if (message.type === "inform") return message;
      const response = await runtime.client.call({ op: "create_task", context_id: message.context_id, origin_instance_id: message.origin.instance_id, assignee_instance_id: runtime.card.agent_id, ...(message.task_id === undefined ? {} : { task_id: message.task_id }) });
      if (response.ok !== true || response.task === undefined) throw new Error(`task creation failed: ${String(response.error ?? "invalid response")}`);
      let task = response.task as { task_id?: unknown; state?: unknown };
      if (message.task_id !== undefined && ["completed", "failed", "canceled", "rejected"].includes(String(task.state))) {
        const followUp = await runtime.client.call({ op: "create_task", context_id: message.context_id, origin_instance_id: message.origin.instance_id, assignee_instance_id: runtime.card.agent_id, prior_task_id: message.task_id });
        if (followUp.ok !== true || followUp.task === undefined) throw new Error(`terminal task continuation failed: ${String(followUp.error ?? "invalid response")}`);
        task = followUp.task as { task_id?: unknown; state?: unknown };
      }
      return typeof task.task_id === "string" && message.task_id !== task.task_id ? { ...message, task_id: task.task_id } : message;
    },
    markWorking: async (message: Message) => {
      if (message.task_id === undefined) return;
      const response = await runtime.client.call({ op: "update_task", task_id: message.task_id, state: "working", destination: message.origin.instance_id, message_id: message.message_id });
      if (response.ok !== true && response.error !== "illegal_transition") throw new Error(`task working transition failed: ${String(response.error)}`);
    },
    deliverTurn: (message: Message) => { runtime.ui.notify?.("Onclave message received", "info"); runtime.correlation.registerInbound(message); runtimeSend(runtime, { customType: INBOUND_CUSTOM_TYPE, content: buildMessageFraming(message), display: true, details: { messageId: message.message_id, contextId: message.context_id, taskId: message.task_id } }, true); },
    deliverInert: (message: Message) => runtimeSend(runtime, { customType: "onclave-inform", content: buildInformDisplayText(message), display: true, details: { messageId: message.message_id, contextId: message.context_id } }, false),
    deliverStatus: (event: TaskStatusEvent) => { if (shouldTriggerStatusTurn(event)) runtimeSend(runtime, { customType: STATUS_CUSTOM_TYPE, content: buildStatusFraming(event), display: true, details: { eventId: event.event_id, taskId: event.task_id, contextId: event.context_id } }, true); else runtimeSend(runtime, { customType: STATUS_CUSTOM_TYPE, content: buildStatusFraming(event), display: true, details: { eventId: event.event_id, taskId: event.task_id, contextId: event.context_id } }, false); },
    publishFailure: async (message: Message, reason: string) => { const failure = createMessage({ type: "inform", origin: origin(runtime.card), destination: message.origin.instance_id, context_id: message.context_id, body: `request declined: ${reason}` }); await runtime.client.publish(failure); },
    registerInbound: (message: Message) => runtime.correlation.registerInbound(message), audit: options.audit,
  };
}
function runtimeSend(runtime: Runtime, message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }, triggerTurn: boolean): void { runtime.sendMessage(message, { triggerTurn, deliverAs: "followUp" }); }

async function submitRunReply(runtime: Runtime, messages: unknown[], audit: Audit): Promise<void> {
  const inbound = runtime.correlation.matchAgentRun(messages); if (inbound === undefined || !runtime.registered || runtime.state !== "connected") return;
  const body = lastAssistantText(messages);
  const reply = createMessage({ type: "inform", origin: origin(runtime.card), destination: inbound.origin.instance_id, context_id: inbound.context_id, body, usage: usage(runUsage(messages)) });
  if (inbound.task_id !== undefined) {
    const status = await runtime.client.call({ op: "update_task", task_id: inbound.task_id, state: "completed", destination: inbound.origin.instance_id, message_id: reply.message_id, body });
    if (status.ok !== true) throw new Error(`task completion transition failed: ${String(status.error ?? "unknown")}`);
  }
  await runtime.client.publish(reply); runtime.correlation.completeInbound(inbound.message_id); await audit("reply_published", { message_id: reply.message_id, context_id: reply.context_id });
}
async function heartbeatTick(runtime: Runtime | null): Promise<void> { if (runtime === null || !runtime.registered || runtime.state !== "connected") return; await runtime.client.call({ op: "heartbeat", agent_id: runtime.card.agent_id }); await updateAliveInstances(runtime); }
async function updateAliveInstances(runtime: Runtime): Promise<void> { const response = await runtime.client.call({ op: "list_agents" }); if (response.ok === true && Array.isArray(response.agents)) runtime.aliveInstances = (response.agents as Array<{ agent_id?: unknown; alive?: unknown }>).filter((item) => item.alive === true && item.agent_id !== runtime.card.agent_id).length; refreshFooterStatus(runtime); }
async function shutdownAdapter(runtime: Runtime, audit: Audit): Promise<void> { try { if (runtime.registered && runtime.state === "connected") { await runtime.client.call({ op: "unregister", agent_id: runtime.card.agent_id }); await audit("adapter_unregister", { instance_id: runtime.card.agent_id }); } } finally { await runtime.link.stop(); runtime.ui.setStatus?.(FOOTER_STATUS_KEY, undefined); runtime.correlation.clear(); } }
function origin(card: AgentCard): A2AOrigin { return { instance_id: card.agent_id, name: card.name, host: card.host, ...(card.project === undefined ? {} : { project: card.project }) }; }
async function buildAgentCard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<AgentCard> { const project = await resolveProjectLabel(ctx.cwd || process.cwd()); const flag = readStringFlag(pi, "onclave-id"); const id = flag === undefined ? `pi-${sanitize(ctx.sessionManager.getSessionId()).replaceAll("-", "").slice(0, 12)}` : sanitize(flag); return { agent_id: id, name: pi.getSessionName?.() ?? id, host: hostname(), project, transport: "https" }; }
function sanitize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "onclave-instance"; }
function readStringFlag(pi: ExtensionAPI, name: string): string | undefined { const value = pi.getFlag(name); return typeof value === "string" && value.length > 0 ? value : undefined; }
function refreshFooterStatus(runtime: Pick<Runtime, "aliveInstances" | "card" | "state" | "ui">): void { const color = runtime.state === "connected" ? ANSI_GREEN : ANSI_RED; runtime.ui.setStatus?.(FOOTER_STATUS_KEY, `Onclave[${runtime.aliveInstances}]: ${color}${runtime.card.agent_id}${ANSI_RESET}`); }
export { refreshFooterStatus };
function statusText(runtime: Runtime | null): string { if (runtime === null) return "Onclave adapter is not initialized"; return `state: ${runtime.state}\ninstance_id: ${runtime.card.agent_id}\nregistered: ${runtime.registered}\ninstances alive: ${runtime.aliveInstances}`; }
function usage(value: { inputTokens?: number; outputTokens?: number } | { input_tokens: number; output_tokens: number }): { input_tokens: number; output_tokens: number } { if ("input_tokens" in value) return value; return { input_tokens: value.inputTokens ?? 0, output_tokens: value.outputTokens ?? 0 }; }
function textResult(text: string, details: Record<string, unknown>) { return { content: [{ type: "text" as const, text }], details }; }

function registerAdapterTools(pi: ExtensionAPI, getRuntime: RuntimeGetter, audit: Audit): void { registerInstancesTool(pi, getRuntime); registerMessageTool(pi, getRuntime, audit); }
function registerInstancesTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void { pi.registerTool({ name: "onclave_instances", label: "Onclave Instances", description: "List live independent Pi instances registered with Onclave.", parameters: Type.Object({}), async execute() { const runtime = requireRuntime(getRuntime); const response = await runtime.client.call({ op: "list_agents" }); if (response.ok !== true) throw new Error(`list_agents failed: ${String(response.error)}`); const instances = Array.isArray(response.agents) ? response.agents : []; return textResult(instances.map((item) => { const agent = item as Record<string, unknown>; return `${String(agent.agent_id)} (${String(agent.name)}) host=${String(agent.host)} alive=${String(agent.alive)}`; }).join("\n") || "no instances registered", { instances }); } }); }
function registerMessageTool(pi: ExtensionAPI, getRuntime: RuntimeGetter, audit: Audit): void {
  pi.registerTool({ name: "onclave_message", label: "Onclave Message", description: "Communicate with an independent Onclave instance: ask for a direct answer, request asynchronous tracked work, or inform peers without triggering a turn.", parameters: Type.Object({ type: Type.String({ description: "ask, request, or inform", enum: ["ask", "request", "inform"] }), to: Type.Optional(Type.String({ description: "Target instance. Omit only for broadcast inform." })), body: Type.String({ maxLength: MAX_MESSAGE_LENGTH }), context_id: Type.Optional(Type.String()), task_id: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_TIMEOUT_MS })) }), async execute(_callId, params) { const runtime = requireRuntime(getRuntime); const type = validateMessageParams(params); const recipients = type === "inform" && params.to === undefined ? await broadcastTargets(runtime) : [params.to as string]; const results: Array<Record<string, unknown>> = []; for (const target of recipients) { const message = createMessage({ type, origin: origin(runtime.card), destination: target, context_id: params.context_id ?? (await import("@onclave/envelope")).ulid(), ...(params.task_id === undefined ? {} : { task_id: params.task_id }), body: params.body }); runtime.correlation.registerOutbound(message); await runtime.client.publish(message); if (type === "inform") { await audit("inform_published", { message_id: message.message_id, to: target }); results.push({ message_id: message.message_id, context_id: message.context_id, to: target }); continue; } if (type === "request") { results.push({ message_id: message.message_id, context_id: message.context_id, to: target, published: true }); continue; } const result = await runtime.correlation.waitFor(message, params.timeout_ms ?? 30_000); results.push({ message_id: message.message_id, context_id: message.context_id, to: target, result: result ?? "timeout" }); } return textResult(`${type} published to ${recipients.length} instance${recipients.length === 1 ? "" : "s"}`, { type, messages: results }); } });
}
export function validateMessageParams(params: { type?: unknown; to?: unknown; body?: unknown; context_id?: unknown; task_id?: unknown; timeout_ms?: unknown }): "ask" | "request" | "inform" { if (params.type !== "ask" && params.type !== "request" && params.type !== "inform") throw new Error("onclave_message.type must be ask, request, or inform"); if (typeof params.body !== "string" || params.body.length === 0 || params.body.length > MAX_MESSAGE_LENGTH) throw new Error("onclave_message.body must be a non-empty message within the size limit"); if (params.to !== undefined && (typeof params.to !== "string" || params.to.length === 0)) throw new Error("onclave_message.to must be a non-empty instance id"); if (params.type !== "inform" && params.to === undefined) throw new Error(`${params.type} requires to`); if (params.type === "inform" && (params.task_id !== undefined || params.timeout_ms !== undefined)) throw new Error("inform does not accept task_id or timeout_ms"); if (params.task_id !== undefined && typeof params.task_id !== "string") throw new Error("task_id must be a string"); if (params.context_id !== undefined && typeof params.context_id !== "string") throw new Error("context_id must be a string"); if (params.timeout_ms !== undefined && (typeof params.timeout_ms !== "number" || !Number.isSafeInteger(params.timeout_ms) || params.timeout_ms < 1 || params.timeout_ms > MAX_WAIT_TIMEOUT_MS)) throw new Error("timeout_ms is outside the allowed range"); return params.type; }
async function broadcastTargets(runtime: Runtime): Promise<string[]> { const response = await runtime.client.call({ op: "list_agents" }); if (response.ok !== true || !Array.isArray(response.agents)) throw new Error(`list_agents failed: ${String(response.error ?? "invalid response")}`); return (response.agents as Array<Record<string, unknown>>).filter((item) => item.alive === true && typeof item.agent_id === "string" && item.agent_id !== runtime.card.agent_id && item.agent_id !== "*").map((item) => item.agent_id as string); }
function requireRuntime(getRuntime: RuntimeGetter): Runtime { const runtime = getRuntime(); if (runtime === null) throw new Error("onclave adapter is not initialized"); return runtime; }
