import type { A2AUsage } from "@onclave/envelope";

// Extracts the final assistant text and token usage from an agent run's
// message list for A2A task replies.

type AssistantLike = {
  role?: unknown;
  content?: unknown;
  usage?: { input?: unknown; output?: unknown };
  stopReason?: unknown;
  errorMessage?: unknown;
};

type TextBlockLike = {
  type?: unknown;
  text?: unknown;
};

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = block as TextBlockLike;
    if (record === null) continue;
    if (record.type !== "text") continue;
    if (typeof record.text !== "string") continue;
    parts.push(record.text);
  }
  return parts.join("\n");
}

export function lastAssistantText(messages: unknown[]): string {
  let text = "";
  for (const message of messages) {
    const record = message as AssistantLike;
    if (record?.role !== "assistant") continue;
    const extracted = textFromContent(record.content);
    if (extracted !== "") text = extracted;
  }
  return text;
}

export function runOutcome(messages: unknown[]): { state: "completed" | "failed" | "canceled"; body: string } {
  const last = [...messages].reverse().find((message) => (message as AssistantLike)?.role === "assistant") as AssistantLike | undefined;
  if (last?.stopReason === "aborted") return { state: "canceled", body: "Pi response canceled." };
  if (last?.stopReason === "error") return { state: "failed", body: typeof last.errorMessage === "string" ? last.errorMessage : "Pi response failed." };
  if (!last || last.stopReason === "toolUse") return { state: "failed", body: "Pi ended without a final response." };
  return { state: "completed", body: lastAssistantText(messages) };
}

function usageNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function runUsage(messages: unknown[]): A2AUsage {
  let input = 0;
  let output = 0;
  for (const message of messages) {
    const record = message as AssistantLike;
    if (record?.role !== "assistant") continue;
    input += usageNumber(record.usage?.input);
    output += usageNumber(record.usage?.output);
  }
  return { input_tokens: input, output_tokens: output };
}
