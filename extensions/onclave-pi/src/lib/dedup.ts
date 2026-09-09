import type { Message } from "@onclave/envelope";

export type DeliveryDomain = "message" | "task-status";

export type DeliveryRecord = {
  domain: DeliveryDomain;
  id: string;
  prepared?: Message;
  correlationApplied: boolean;
  correlated?: boolean;
  registered: boolean;
  workingMarked: boolean;
  piDelivered: boolean;
  auditAttempted: boolean;
  completed: boolean;
  active: boolean;
};

/**
 * Bounded receiver-side delivery state. Records are retained after completion
 * so a broker redelivery can be acknowledged without replaying Pi side effects.
 * Pending records are never evicted: capacity pressure must let the lease
 * expire rather than silently suppress an unfinished delivery.
 */
export class SeenIds {
  private readonly records = new Map<string, DeliveryRecord>();

  constructor(private readonly maxEntries = 1000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive safe integer");
  }

  begin(domain: DeliveryDomain, id: string): DeliveryRecord {
    const key = this.key(domain, id);
    const existing = this.records.get(key);
    if (existing !== undefined) return existing;
    this.makeRoom();
    if (this.records.size >= this.maxEntries) throw new Error("Onclave delivery deduplication capacity is exhausted");
    const record: DeliveryRecord = {
      domain, id, correlationApplied: false, registered: false,
      workingMarked: false, piDelivered: false, auditAttempted: false,
      completed: false, active: false,
    };
    this.records.set(key, record);
    return record;
  }

  markCompleted(record: DeliveryRecord): void {
    record.completed = true;
  }

  get(domain: DeliveryDomain, id: string): DeliveryRecord | undefined {
    return this.records.get(this.key(domain, id));
  }

  // Kept for the small public helper's existing callers and tests. A legacy
  // add is an already-completed record, unlike delivery processing above.
  add(id: string): boolean {
    const existing = this.records.get(this.key("message", id));
    if (existing !== undefined) return false;
    const record = this.begin("message", id);
    this.markCompleted(record);
    return true;
  }

  has(id: string): boolean {
    return [...this.records.values()].some((record) => record.id === id);
  }

  clear(): void {
    this.records.clear();
  }

  private key(domain: DeliveryDomain, id: string): string { return `${domain}:${id}`; }

  private makeRoom(): void {
    while (this.records.size >= this.maxEntries) {
      const oldest = [...this.records.entries()].find(([, record]) => record.completed);
      if (oldest === undefined) return;
      this.records.delete(oldest[0]);
    }
  }
}
