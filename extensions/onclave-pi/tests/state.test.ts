import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getOnclavePaths } from "../src/lib/state";

describe("onclave state helpers", () => {
  it("derives all state paths under the configured root", () => {
    const root = join("tmp", "pi-root");
    const paths = getOnclavePaths(root);

    expect(paths.root).toBe(root);
    expect(paths.privateKey).toBe(join(root, "identity.key"));
  });
});
