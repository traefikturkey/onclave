export type DeliveredPrompt = {
  messageId: string;
  taskId: string;
  correlationId?: string;
  sourceAgentId?: string;
  targetAgentId?: string;
  messageType: string;
  payload: Record<string, unknown>;
  instruction: string;
  receivedAt: string;
};
