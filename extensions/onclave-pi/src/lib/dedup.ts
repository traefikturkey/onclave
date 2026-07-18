// Bounded receiver-side dedup on message id: at-least-once delivery from the
// broker plus this set yields at-least-once processing without double turns.
export class SeenIds {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 1000) {}

  // Returns false when the id was already seen.
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }
}
