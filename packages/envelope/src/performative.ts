export const PERFORMATIVES = ["request", "inform", "query", "failure", "not_understood"] as const;

export type Performative = (typeof PERFORMATIVES)[number];

export function isPerformative(value: unknown): value is Performative {
  return typeof value === "string" && (PERFORMATIVES as readonly string[]).includes(value);
}

// Only these performatives may ever start a turn in a receiving session.
// Everything else (inform, failure, not_understood) is structurally inert:
// display or correlation handling only, never a turn or tool call.
const TURN_TRIGGERING: ReadonlySet<Performative> = new Set(["request", "query"]);

export function mayTriggerTurn(performative: Performative): boolean {
  return TURN_TRIGGERING.has(performative);
}
