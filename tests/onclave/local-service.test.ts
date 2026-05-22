import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { bindLocalService } from "../../src/onclave/local-service";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("bindLocalService", () => {
  it("binds a local server on an OS-assigned available port", async () => {
    const server = createServer();
    servers.push(server);

    const binding = await bindLocalService(server, { host: "127.0.0.1" });

    expect(binding.host).toBe("127.0.0.1");
    expect(binding.port).toBeGreaterThan(0);
    expect(binding.endpoint).toBe(`https://127.0.0.1:${binding.port}`);
  });

  it("uses a preferred port when it is available", async () => {
    const probe = createServer();
    await bindLocalService(probe, { host: "127.0.0.1" });
    const preferredPort = addressPort(probe);
    await closeServer(probe);

    const server = createServer();
    servers.push(server);

    const binding = await bindLocalService(server, {
      host: "127.0.0.1",
      preferredPort,
    });

    expect(binding.port).toBe(preferredPort);
  });

  it("falls back to an available port when the preferred port is busy", async () => {
    const occupied = createServer();
    servers.push(occupied);
    const occupiedBinding = await bindLocalService(occupied, { host: "127.0.0.1" });

    const server = createServer();
    servers.push(server);
    const binding = await bindLocalService(server, {
      host: "127.0.0.1",
      preferredPort: occupiedBinding.port,
    });

    expect(binding.port).not.toBe(occupiedBinding.port);
    expect(binding.port).toBeGreaterThan(0);
  });

  it("normalizes wildcard hosts to a loopback endpoint", async () => {
    const server = createServer();
    servers.push(server);

    const binding = await bindLocalService(server, { host: "0.0.0.0" });

    expect(binding.host).toBe("0.0.0.0");
    expect(binding.endpoint).toBe(`https://127.0.0.1:${binding.port}`);
  });
});

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
