export type PromptReplyMode = "pollable" | "async_message";

export type PromptOriginMetadata = {
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
  sessionId: string;
  correlationId: string;
  agentName?: string;
  projectLabel?: string;
  inReplyToMsgId?: string;
};

export function isPromptReplyMode(value: unknown): value is PromptReplyMode {
  return value === "pollable" || value === "async_message";
}

export function isPromptOriginMetadata(value: unknown): value is PromptOriginMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.nodeId === "string" &&
    record.nodeId.length > 0 &&
    typeof record.hubInstanceId === "string" &&
    record.hubInstanceId.length > 0 &&
    typeof record.endpoint === "string" &&
    record.endpoint.length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.correlationId === "string" &&
    record.correlationId.length > 0 &&
    (record.agentName === undefined || typeof record.agentName === "string") &&
    (record.projectLabel === undefined || typeof record.projectLabel === "string") &&
    (record.inReplyToMsgId === undefined || typeof record.inReplyToMsgId === "string")
  );
}

export function assertAsyncReplyablePrompt(input: {
  msgId: string;
  replyMode?: PromptReplyMode;
  origin?: PromptOriginMetadata;
}): void {
  if (!input.origin) {
    throw new Error(`inbound Onclave message ${input.msgId} does not include reply routing metadata`);
  }
  if (input.replyMode !== "async_message") {
    throw new Error(
      `inbound Onclave message ${input.msgId} expects a normal assistant response; do not use onclave_reply`
    );
  }
  if (input.origin.inReplyToMsgId) {
    throw new Error(`inbound Onclave message ${input.msgId} is already a reply; do not use onclave_reply`);
  }
}
