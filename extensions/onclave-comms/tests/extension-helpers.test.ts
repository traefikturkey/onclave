import { describe, expect, it } from "vitest";
import { createLocalAgentRegistration } from "../src/lib/extension-helpers";

describe("createLocalAgentRegistration", () => {
  it("creates a local registration with explicit metadata", async () => {
    const registration = await createLocalAgentRegistration({
      sessionId: "session-abcdef",
      instanceId: "instance-1",
      cwd: "/repo/onclave",
      model: "test-model",
      name: "planner",
      purpose: "planning",
      color: "#123456",
      explicit: true,
      deliveryEndpoint: "local://session-abcdef",
      gitRunner: async (_cwd, args) => {
        if (args.join(" ") === "rev-parse --is-inside-work-tree") return "true\n";
        if (args.join(" ") === "rev-parse --git-common-dir") return "/repo/onclave/.git\n";
        if (args.join(" ") === "rev-parse --git-dir") return "/repo/onclave/.git\n";
        if (args.join(" ") === "branch --show-current") return "main\n";
        return "";
      },
    });

    expect(registration).toEqual({
      sessionId: "session-abcdef",
      instanceId: "instance-1",
      name: "planner",
      projectLabel: "onclave@main",
      model: "test-model",
      purpose: "planning",
      color: "#123456",
      explicit: true,
      deliveryEndpoint: "local://session-abcdef",
    });
  });

  it("applies stable defaults for optional metadata", async () => {
    const registration = await createLocalAgentRegistration({
      sessionId: "session-123456",
      instanceId: "instance-1",
      cwd: "/tmp/scratch",
      model: "test-model",
      deliveryEndpoint: "local://session-123456",
      gitRunner: async () => {
        throw new Error("not git");
      },
    });

    expect(registration.name).toBe("agent-123456");
    expect(registration.projectLabel).toBe("scratch");
    expect(registration.purpose).toBe("");
    expect(registration.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(registration.explicit).toBe(false);
  });

  it("rejects invalid color overrides", async () => {
    await expect(
      createLocalAgentRegistration({
        sessionId: "session-123456",
        instanceId: "instance-1",
        cwd: "/tmp/scratch",
        model: "test-model",
        color: "blue",
        deliveryEndpoint: "local://session-123456",
      })
    ).rejects.toThrow(/color must be #RRGGBB/);
  });
});
