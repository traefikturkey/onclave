import type { TokenUsage } from "@onclave/envelope";

// Extracts the final assistant text and token usage from an agent run's
// message list for reply envelopes.

type AssistantLike = {
  role?: unknown;
  content?: unknown;
  usage?: { input?: unknown; output?: unknown };
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

function usageNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function runUsage(messages: unknown[]): TokenUsage {
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
