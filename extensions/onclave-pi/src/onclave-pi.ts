// Onclave v2 Pi adapter. Phase 1 stub: proves the shared envelope package
// compiles into the extension; the adapter runtime lands in phase 3.
import { ENVELOPE_VERSION, type Envelope } from "@onclave/envelope";

export const ONCLAVE_PI_ENVELOPE_VERSION = ENVELOPE_VERSION;

export type PendingInbound = {
  envelope: Envelope;
  receivedAt: string;
};

export default function onclavePi(): void {
  // Adapter registration arrives in phase 3.
}
