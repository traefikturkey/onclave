import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bootstrapLocalHub, type BootstrapLocalHubResult } from "../src/coms-lan/bootstrap";
import { createLocalAgentRegistration } from "../src/coms-lan/extension-helpers";
import type { LocalAgentRegistration } from "../src/coms-lan/local-registry";
import { getComsLanPaths } from "../src/coms-lan/state";
import { sendWssFrames } from "../src/coms-lan/wss-transport";

const DEFAULT_DISCOVERY_PORT = 48889;
const DEFAULT_BROADCAST_ADDRESS = "255.255.255.255";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("name", {
    description: "Override coms-lan local agent name",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("purpose", {
    description: "Describe this coms-lan local agent purpose",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("color", {
    description: "Hex color #RRGGBB for this coms-lan local agent",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("explicit", {
    description: "Hide this coms-lan local agent from default listings",
    type: "boolean",
    default: false,
  });

  let bootstrap: BootstrapLocalHubResult | null = null;
  let localSessionId: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const paths = getComsLanPaths(`${homedir()}/.pi/coms-lan`);
    bootstrap = await bootstrapLocalHub(paths, {
      host: "127.0.0.1",
      discoveryPort: DEFAULT_DISCOVERY_PORT,
      broadcastAddress: DEFAULT_BROADCAST_ADDRESS,
      now: () => new Date().toISOString(),
      healthCheck: checkHubHealth,
    });

    localSessionId = sessionIdFromContext(ctx);
    if (bootstrap.runtime?.registerLocalAgent) {
      await registerOwnedRuntimeAgent(pi, ctx, bootstrap.runtime.registerLocalAgent, localSessionId);
    }

    ctx.ui?.setStatus?.("coms-lan", bootstrap.started ? "coms-lan hub" : "coms-lan client");
  });

  pi.on("session_shutdown", async () => {
    if (bootstrap?.runtime && localSessionId) {
      bootstrap.runtime.unregisterLocalAgent?.(localSessionId);
    }
    if (bootstrap?.runtime && bootstrap.started) {
      await bootstrap.runtime.stop();
    }
    bootstrap = null;
    localSessionId = null;
  });

  pi.registerTool({
    name: "coms_lan_status",
    label: "Coms LAN Status",
    description: "Show local coms-lan hub status and the public key line to add to trusted peers.",
    parameters: Type.Object({}),
    async execute() {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `hub: ${bootstrap.state.endpoint}\n` +
              `started_here: ${bootstrap.started}\n` +
              `public_key: ${bootstrap.publicAuthorizedKeyLine}`,
          },
        ],
        details: {
          state: bootstrap.state,
          started: bootstrap.started,
          publicAuthorizedKeyLine: bootstrap.publicAuthorizedKeyLine,
        },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_peers",
    label: "Coms LAN Peers",
    description: "List discovered LAN hubs known to this coms-lan runtime.",
    parameters: Type.Object({}),
    async execute() {
      const peers = bootstrap?.runtime?.discoveredPeers?.() ?? [];
      return {
        content: [{ type: "text" as const, text: `${peers.length} discovered peer(s)` }],
        details: { peers },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_agents",
    label: "Coms LAN Agents",
    description: "List local agents registered with this coms-lan runtime.",
    parameters: Type.Object({}),
    async execute() {
      const agents = bootstrap?.runtime?.localAgents?.() ?? [];
      return {
        content: [{ type: "text" as const, text: `${agents.length} local agent(s)` }],
        details: { agents },
      };
    },
  });
}

async function registerOwnedRuntimeAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registerLocalAgent: (registration: LocalAgentRegistration) => unknown,
  sessionId: string
): Promise<void> {
  const registration = await createLocalAgentRegistration({
    sessionId,
    instanceId: `pi_${randomId()}`,
    cwd: ctx.cwd || process.cwd(),
    model: ctx.model?.id ?? "unknown",
    name: readStringFlag(pi, "name"),
    purpose: readStringFlag(pi, "purpose"),
    color: readStringFlag(pi, "color"),
    explicit: pi.getFlag("explicit") === true,
    deliveryEndpoint: `local://${sessionId}`,
  });
  registerLocalAgent(registration);
}

async function checkHubHealth(endpoint: string): Promise<boolean> {
  const url = endpoint.replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/hub";
  try {
    const responses = await sendWssFrames(url, [{ type: "list_agents" }], {
      rejectUnauthorized: false,
      timeoutMs: 2_000,
    });
    return responses.some((response) => response.type === "error" && response.code === "auth_required") || responses.length > 0;
  } catch {
    return false;
  }
}

function sessionIdFromContext(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) return basename(sessionFile).replace(/\W+/g, "_");
  return `session_${randomId()}`;
}

function readStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomId(): string {
  return randomBytes(10).toString("hex");
}
