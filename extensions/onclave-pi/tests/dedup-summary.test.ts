import { describe, expect, it } from "vitest";
import { SeenIds } from "../src/lib/dedup";

describe("SeenIds", () => {
  it("reports duplicates and bounds memory", () => {
    const seen = new SeenIds(3);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("a")).toBe(false);
    seen.add("b");
    seen.add("c");
    seen.add("d");
    expect(seen.has("a")).toBe(false);
    expect(seen.has("d")).toBe(true);
  });

  it("does not evict active delivery records under capacity pressure", () => {
    const seen = new SeenIds(2);
    const first = seen.begin("message", "first");
    seen.begin("task-status", "second");
    expect(() => seen.begin("message", "third")).toThrow("capacity");
    seen.markCompleted(first);
    expect(seen.begin("message", "third").id).toBe("third");
    expect(seen.has("second")).toBe(true);
  });
});
