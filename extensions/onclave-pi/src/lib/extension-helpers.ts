import { createHash } from "node:crypto";
import type { LocalAgentRegistration } from "./local-registry";
import { resolveProjectLabel, type GitRunner } from "./project-label";

export type CreateLocalAgentRegistrationInput = {
  sessionId: string;
  instanceId: string;
  cwd: string;
  model: string;
  name?: string;
  sessionName?: string;
  purpose?: string;
  color?: string;
  explicit?: boolean;
  deliveryEndpoint: string;
  gitRunner?: GitRunner;
};

const FALLBACK_PALETTE = [
  "#7c3aed",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#db2777",
];

export async function createLocalAgentRegistration(
  input: CreateLocalAgentRegistrationInput
): Promise<LocalAgentRegistration> {
  assertRequired(input.sessionId, "sessionId");
  assertRequired(input.instanceId, "instanceId");
  assertRequired(input.cwd, "cwd");
  assertRequired(input.model, "model");
  assertRequired(input.deliveryEndpoint, "deliveryEndpoint");

  if (input.color && !isValidHexColor(input.color)) {
    throw new Error("color must be #RRGGBB");
  }

  return {
    sessionId: input.sessionId,
    instanceId: input.instanceId,
    name:
      firstNonEmptyString(input.name) ??
      firstNonEmptyString(input.sessionName) ??
      defaultAgentName(input.sessionId),
    projectLabel: await resolveProjectLabel(input.cwd, input.gitRunner),
    model: input.model,
    purpose: input.purpose ?? "",
    color: input.color ?? fallbackColor(input.sessionId),
    explicit: input.explicit === true,
    deliveryEndpoint: input.deliveryEndpoint,
  };
}

function firstNonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultAgentName(sessionId: string): string {
  const suffix = sessionId.length > 6 ? sessionId.slice(-6) : sessionId;
  return `agent-${suffix}`;
}

function fallbackColor(sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  const index = Number(BigInt(`0x${hash}`) % BigInt(FALLBACK_PALETTE.length));
  return FALLBACK_PALETTE[index] ?? FALLBACK_PALETTE[0];
}

function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function assertRequired(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}
