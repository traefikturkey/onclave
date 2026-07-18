export type DeliveredPrompt = {
  msgId: string;
  targetSessionId: string;
  deliveryEndpoint: string;
  prompt: string;
  hops: number;
  receivedAt: string;
};
