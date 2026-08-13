import type { Channel } from "amqplib";
import { parseEnvelope, parseRpcRequest, type AgentOrigin, type RpcRequest } from "@onclave/envelope";
import { AgentDeliveryService, type DeliveryDisposition } from "../agent-delivery";
import { AgentKeyMismatchError } from "../registry";
import type { CoreServices } from "../rpc";
import { handleRpcRequest, publishEnvelope } from "../rpc";
import { HttpError } from "./errors";
import { jsonResponse, rawResponse, type VaultHandlers } from "./http";

export const MAX_AGENT_LONG_POLL_WAIT_MS = 25_000;

export type AgentRouteDependencies = {
  services: CoreServices;
  channel: () => Channel | undefined;
  deliveries: AgentDeliveryService;
};

type JsonObject = Record<string, unknown>;

function bodyValidationError(message: string): HttpError {
  return new HttpError(422, [{ loc: ["body"], msg: message, type: "value_error" }]);
}

function queryValidationError(name: string, message: string): HttpError {
  return new HttpError(422, [{ loc: ["query", name], msg: message, type: "value_error" }]);
}

function parseJsonObject(body: Buffer): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw bodyValidationError("JSON decode error");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bodyValidationError("Input should be a valid dictionary");
  }
  return value as JsonObject;
}

function requestKeyId(keyId: string | undefined): string {
  if (keyId === undefined) throw new HttpError(401, "Missing signature headers");
  return keyId;
}

function requiredAgentId(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw queryValidationError("agent_id", "Field required");
  }
  return value;
}

function waitMs(value: string | undefined): number {
  if (value === undefined) return MAX_AGENT_LONG_POLL_WAIT_MS;
  if (!/^\d+$/.test(value)) {
    throw queryValidationError("wait_ms", "Input should be a valid integer");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed > MAX_AGENT_LONG_POLL_WAIT_MS) {
    throw queryValidationError("wait_ms", `Input should be less than or equal to ${MAX_AGENT_LONG_POLL_WAIT_MS}`);
  }
  return parsed;
}

function requireKnownAgentKey(services: CoreServices, agentId: string, keyId: string): void {
  const agent = services.registry.get(agentId);
  if (agent === undefined) throw new HttpError(404, "Agent not found");
  if (agent.key_id !== keyId) throw new HttpError(403, "Agent is bound to a different key");
}

function requireExistingAgentKey(services: CoreServices, agentId: string, keyId: string): void {
  const agent = services.registry.get(agentId);
  if (agent !== undefined && agent.key_id !== keyId) {
    throw new HttpError(403, "Agent is bound to a different key");
  }
}

function requireAuthorizedOrigin(services: CoreServices, origin: AgentOrigin, keyId: string): void {
  const agent = services.registry.get(origin.agent_id);
  if (agent === undefined) throw new HttpError(404, "Agent not found");
  if (agent.key_id !== keyId) throw new HttpError(403, "Agent is bound to a different key");
  if (
    agent.name !== origin.name
    || agent.host !== origin.host
    || agent.project !== origin.project
  ) {
    throw new HttpError(403, "Envelope origin does not match registered agent");
  }
}

function requireRecordExchangeParticipant(services: CoreServices, request: Extract<RpcRequest, { op: "record_exchange" }>, keyId: string): void {
  const fromAgent = services.registry.get(request.from_agent_id);
  const toAgent = services.registry.get(request.to_agent_id);
  if (fromAgent?.key_id !== keyId && toAgent?.key_id !== keyId) {
    throw new HttpError(403, "Signing key is not bound to a record_exchange participant");
  }
}

function brokerChannel(deps: AgentRouteDependencies): Channel {
  const channel = deps.channel();
  if (channel === undefined) throw new HttpError(503, "Broker unavailable");
  return channel;
}

function disposition(body: JsonObject): DeliveryDisposition {
  const value = body.disposition;
  if (value === "ack" || value === "reject") return value;
  throw bodyValidationError("disposition must be 'ack' or 'reject'");
}

/** Builds the signed HTTPS agent transport handlers. */
export function createAgentRouteHandlers(deps: AgentRouteDependencies): VaultHandlers {
  return {
    agentsRpc: async (request) => {
      const keyId = requestKeyId(request.keyId);
      const parsed = parseRpcRequest(parseJsonObject(request.body));
      if (!parsed.ok) throw bodyValidationError(parsed.error);

      if (parsed.request.op === "register") {
        requireExistingAgentKey(deps.services, parsed.request.card.agent_id, keyId);
      } else if (parsed.request.op === "heartbeat" || parsed.request.op === "unregister") {
        requireKnownAgentKey(deps.services, parsed.request.agent_id, keyId);
      } else if (parsed.request.op === "record_exchange") {
        requireRecordExchangeParticipant(deps.services, parsed.request, keyId);
      }

      try {
        return jsonResponse(await handleRpcRequest(deps.services, brokerChannel(deps), parsed.request, keyId));
      } catch (error) {
        if (error instanceof AgentKeyMismatchError) {
          throw new HttpError(403, error.message);
        }
        throw error;
      }
    },
    agentsMessages: (request) => {
      const keyId = requestKeyId(request.keyId);
      const parsed = parseEnvelope(parseJsonObject(request.body));
      if (!parsed.ok) throw bodyValidationError(parsed.error);
      requireAuthorizedOrigin(deps.services, parsed.envelope.from, keyId);
      publishEnvelope(brokerChannel(deps), parsed.envelope);
      return jsonResponse({ ok: true, message_id: parsed.envelope.id }, 202);
    },
    agentsMessagesNext: async (request) => {
      const keyId = requestKeyId(request.keyId);
      const agentId = requiredAgentId(request.query.agent_id);
      requireKnownAgentKey(deps.services, agentId, keyId);
      let delivered;
      try {
        delivered = await deps.deliveries.next(agentId, keyId, waitMs(request.query.wait_ms));
      } catch {
        throw new HttpError(503, "Broker unavailable");
      }
      if (delivered === undefined) return rawResponse("", undefined, 204);
      return jsonResponse({ delivery_id: delivered.deliveryId, envelope: delivered.envelope });
    },
    agentsMessageDisposition: (request) => {
      const keyId = requestKeyId(request.keyId);
      const result = deps.deliveries.dispose(request.params.delivery_id ?? "", keyId, disposition(parseJsonObject(request.body)));
      if (result === "not_found") throw new HttpError(404, "Delivery not found");
      if (result === "wrong_key") throw new HttpError(403, "Delivery is bound to a different key");
      return jsonResponse({ ok: true });
    },
  };
}
