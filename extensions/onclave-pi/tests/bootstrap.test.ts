import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => ".test-profile" }));
vi.mock("../src/lib/audit", () => ({ appendAdapterAuditEvent: vi.fn(async () => undefined) }));

import { BwsCommandExecutionError } from "../src/lib/bws";
import { resolveAdapterApiBase, resolveAdapterApiBaseWithRecovery } from "../src/onclave-pi";

const BASE = "https://onclave.example/api/v1";

describe("Onclave Bitwarden bootstrap recovery", () => {
  it("uses bounded rapid retries before becoming degraded", async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new BwsCommandExecutionError())
      .mockRejectedValueOnce(new BwsCommandExecutionError())
      .mockResolvedValue(BASE);
    const states: string[] = [];
    const warning = vi.fn();

    await expect(resolveAdapterApiBaseWithRecovery(loader, {
      initialAttempts: 3,
      initialRetryDelaysMs: [0, 0],
      onStateChange: (state) => states.push(state),
      onWarning: warning,
    })).resolves.toBe(BASE);

    expect(loader).toHaveBeenCalledTimes(3);
    expect(warning).not.toHaveBeenCalled();
    expect(states).toEqual(["retrying", "ready"]);
  });

  it("warns once and keeps one low-frequency recovery loop alive", async () => {
    const controller = new AbortController();
    const loader = vi.fn()
      .mockRejectedValueOnce(new BwsCommandExecutionError())
      .mockRejectedValueOnce(new BwsCommandExecutionError())
      .mockResolvedValue(BASE);
    const states: string[] = [];
    const warning = vi.fn();

    const recovery = resolveAdapterApiBaseWithRecovery(loader, {
      signal: controller.signal,
      initialAttempts: 2,
      initialRetryDelaysMs: [0],
      backgroundRetryMs: 5,
      onStateChange: (state) => states.push(state),
      onWarning: warning,
    });

    await expect(recovery).resolves.toBe(BASE);
    expect(loader).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith();
    expect(states).toEqual(["retrying", "degraded", "ready"]);
    controller.abort();
  });

  it("cancels pending recovery without launching another BWS attempt", async () => {
    const controller = new AbortController();
    const loader = vi.fn().mockRejectedValue(new BwsCommandExecutionError());
    const recovery = resolveAdapterApiBaseWithRecovery(loader, {
      signal: controller.signal,
      initialAttempts: 1,
      backgroundRetryMs: 60_000,
      onWarning: vi.fn(),
    });

    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    controller.abort();
    await expect(recovery).rejects.toMatchObject({ name: "AbortError" });
    expect(loader).toHaveBeenCalledOnce();
  });

  it("fails permanent bootstrap errors without retrying", async () => {
    const permanent = [
      "Onclave BWS bootstrap is missing BITWARDEN_ACCESS_KEY",
      "Onclave BWS bootstrap requires a valid ONCLAVE_BWS_PROJECT_ID",
      "Onclave BWS bootstrap is missing BITWARDEN_API_SERVER",
      "Onclave BWS returned invalid JSON",
      "Onclave BWS returned an unsupported response",
      "Onclave BWS secret ONCLAVE_API_BASE is missing",
    ];

    for (const message of permanent) {
      const loader = vi.fn().mockRejectedValue(new Error(message));
      await expect(resolveAdapterApiBaseWithRecovery(loader, { initialAttempts: 3, initialRetryDelaysMs: [0, 0] })).rejects.toThrow(message);
      expect(loader).toHaveBeenCalledOnce();
    }
  });

  it("bypasses BWS and bootstrap recovery for explicit endpoints", async () => {
    const loader = vi.fn().mockRejectedValue(new BwsCommandExecutionError());

    await expect(resolveAdapterApiBase("https://explicit.example", {
      BITWARDEN_ACCESS_KEY: "bootstrap-token",
    }, loader)).resolves.toBe("https://explicit.example/api/v1/");
    await expect(resolveAdapterApiBase(undefined, {
      ONCLAVE_API_BASE: "https://environment.example",
      BITWARDEN_ACCESS_KEY: "bootstrap-token",
    }, loader)).resolves.toBe("https://environment.example/api/v1/");
    expect(loader).not.toHaveBeenCalled();

    const invalidEndpoint = vi.fn().mockImplementation(() => resolveAdapterApiBase("https://explicit.example/api/v2"));
    await expect(resolveAdapterApiBaseWithRecovery(invalidEndpoint, { initialAttempts: 3, initialRetryDelaysMs: [0, 0] })).rejects.toThrow("ONCLAVE_API_BASE");
    expect(invalidEndpoint).toHaveBeenCalledOnce();
  });
});
