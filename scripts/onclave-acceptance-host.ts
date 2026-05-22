#!/usr/bin/env bun
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOnclaveConfig, writeOnclaveConfig, type OnclaveConfig, type StaticPeerConfig } from "../src/onclave/config";
import { loadOrCreateIdentity, type OnclaveIdentity } from "../src/onclave/identity";
import type { HubState } from "../src/onclave/local-hub";
import { getOnclavePaths } from "../src/onclave/state";
import { formatAuthorizedKeyLine } from "../src/onclave/trust";

export type AcceptanceHostOptions = {
  root: string;
  hostName: string;
  peer?: StaticPeerConfig;
  writeStaticPeer: boolean;
  auditScan: boolean;
  initIdentity: boolean;
};

type LocalAcceptanceState = {
  root: string;
  identity: OnclaveIdentity | null;
  hub: HubState | null;
  authorizedKeyLine: string | null;
  config: OnclaveConfig | null;
  auditLogExists: boolean;
};

const DEFAULT_HOST_NAME = "this-host";

export async function loadLocalAcceptanceState(root: string, initIdentity = true): Promise<LocalAcceptanceState> {
  const paths = getOnclavePaths(root);
  const identity = initIdentity ? await loadOrCreateIdentity(paths) : await readJsonFile<OnclaveIdentity>(paths.identity);
  const hub = await readJsonFile<HubState>(paths.hubState);
  const config = await loadOnclaveConfig(paths).catch(() => null);
  const auditLogExists = await fileExists(paths.auditLog);
  return {
    root,
    identity,
    hub,
    authorizedKeyLine: identity ? formatAuthorizedKeyLine(identity) : null,
    config,
    auditLogExists,
  };
}

export function upsertStaticPeer(config: OnclaveConfig, peer: StaticPeerConfig): OnclaveConfig {
  const peers = config.staticPeers.filter((item) => item.name !== peer.name);
  return { version: 1, staticPeers: [...peers, peer] };
}

export function renderAcceptanceHostReport(state: LocalAcceptanceState, options: AcceptanceHostOptions): string {
  const peerName = options.peer?.name ?? "peer-host";
  const lines: string[] = [];
  lines.push(`# onclave acceptance helper: ${options.hostName}`);
  lines.push("");
  lines.push(`State root: ${state.root}`);
  lines.push("");
  lines.push("## Local status");
  lines.push(`- identity: ${state.identity ? state.identity.nodeId : "missing; rerun without --no-init to create it"}`);
  lines.push(`- hub: ${state.hub ? `${state.hub.endpoint} (${state.hub.hubInstanceId})` : "not started yet; run onclave_status in Pi, then rerun this script"}`);
  lines.push(`- config static peers: ${state.config ? state.config.staticPeers.length : "unreadable"}`);
  lines.push(`- audit log: ${state.auditLogExists ? "present" : "not present yet"}`);
  lines.push("");

  lines.push("## Step A: copy this public key line to the other host");
  lines.push("```text");
  lines.push(state.authorizedKeyLine ?? "Rerun without --no-init to create the local Onclave identity.");
  lines.push("```");
  lines.push("");

  lines.push("## Step B: in Pi on the other host, trust this host");
  lines.push("```text");
  lines.push(state.authorizedKeyLine ? `onclave_trust_add public_key_line=\"${state.authorizedKeyLine}\"` : "bun run onclave:acceptance-host -- --host-name host-a");
  lines.push("```");
  lines.push("");

  if (!state.hub) {
    lines.push("## Step C: start Pi with Onclave on this host");
    lines.push("Run `onclave_status` inside Pi to start or discover the local hub, then rerun this helper to print endpoint metadata.");
    lines.push("");
  }

  if (state.hub && state.identity) {
    lines.push("## Step C: values the other host can use to reach this host");
    lines.push("```text");
    lines.push(`endpoint=${state.hub.endpoint.replace(/^https:/, "wss:")}/v1/hub`);
    lines.push(`node_id=${state.identity.nodeId}`);
    lines.push(`hub_instance_id=${state.hub.hubInstanceId}`);
    lines.push("```");
    lines.push("");
  }

  if (options.peer) {
    lines.push("## Step D: test this host reaching the configured peer in Pi");
    lines.push("```text");
    lines.push(`onclave_remote_agents peer_name=\"${peerName}\"`);
    lines.push(`onclave_remote_send peer_name=\"${peerName}\" target_session_id=\"REMOTE_SESSION_ID\" prompt=\"Reply with: onclave acceptance ok\"`);
    lines.push(`onclave_remote_get peer_name=\"${peerName}\" msg_id=\"MSG_ID\"`);
    lines.push("```");
  } else {
    lines.push("## Step D: after you know the other host endpoint, rerun with peer details");
    lines.push("```bash");
    lines.push("bun run onclave:acceptance-host -- --host-name host-a \\");
    lines.push("  --peer-name host-b \\");
    lines.push("  --peer-node-id node_... \\");
    lines.push("  --peer-hub-instance-id hub_... \\");
    lines.push("  --peer-endpoint wss://HOST_B_IP:PORT/v1/hub \\");
    lines.push("  --write-static-peer");
    lines.push("```");
  }
  lines.push("");

  lines.push("## Step E: checks to run in Pi on this host");
  lines.push("```text");
  lines.push("onclave_status");
  lines.push("onclave_peers");
  lines.push("onclave_static_peers");
  lines.push("onclave_agents");
  lines.push("```");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const paths = getOnclavePaths(options.root);
  if (options.peer && options.writeStaticPeer) {
    const config = await loadOnclaveConfig(paths);
    await writeOnclaveConfig(paths, upsertStaticPeer(config, options.peer));
    console.log(`[OK] wrote static peer '${options.peer.name ?? options.peer.nodeId}' to ${paths.config}`);
  }

  const state = await loadLocalAcceptanceState(options.root, options.initIdentity);
  console.log(renderAcceptanceHostReport(state, options));

  if (options.auditScan) {
    await scanAuditLog(paths.auditLog);
  }
}

function parseArgs(args: string[]): AcceptanceHostOptions {
  const options: AcceptanceHostOptions = {
    root: process.env.ONCLAVE_ROOT ?? join(homedir(), ".pi", "onclave"),
    hostName: DEFAULT_HOST_NAME,
    writeStaticPeer: false,
    auditScan: false,
    initIdentity: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      case "--root":
        options.root = requireValue(args, ++index, arg);
        break;
      case "--host-name":
        options.hostName = requireValue(args, ++index, arg);
        break;
      case "--peer-name":
        options.peer = { ...emptyPeer(options.peer), name: requireValue(args, ++index, arg) };
        break;
      case "--peer-node-id":
        options.peer = { ...emptyPeer(options.peer), nodeId: requireValue(args, ++index, arg) };
        break;
      case "--peer-hub-instance-id":
        options.peer = { ...emptyPeer(options.peer), hubInstanceId: requireValue(args, ++index, arg) };
        break;
      case "--peer-endpoint":
        options.peer = { ...emptyPeer(options.peer), endpoint: requireValue(args, ++index, arg) };
        break;
      case "--write-static-peer":
        options.writeStaticPeer = true;
        break;
      case "--audit-scan":
        options.auditScan = true;
        break;
      case "--no-init":
        options.initIdentity = false;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.peer) validatePeer(options.peer);
  return options;
}

function emptyPeer(peer?: Partial<StaticPeerConfig>): StaticPeerConfig {
  return {
    nodeId: peer?.nodeId ?? "",
    hubInstanceId: peer?.hubInstanceId ?? "",
    endpoint: peer?.endpoint ?? "",
    name: peer?.name,
  };
}

function validatePeer(peer: StaticPeerConfig): void {
  if (!peer.nodeId || !peer.hubInstanceId || !peer.endpoint) {
    throw new Error("peer details require --peer-node-id, --peer-hub-instance-id, and --peer-endpoint");
  }
  if (!/^wss:\/\/[^\s]+\/v1\/hub$/.test(peer.endpoint)) {
    throw new Error("--peer-endpoint must be wss://.../v1/hub");
  }
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function scanAuditLog(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    console.log(`\n[WARN] audit log not found: ${path}`);
    return;
  }
  const contents = await readFile(path, "utf8");
  const markers = ["-----" + "BEGIN", "private" + "Key", "key_" + "material", "pass" + "word", "credential", "token"];
  const risky = contents
    .split(/\r?\n/)
    .filter((line) => markers.some((marker) => line.toLowerCase().includes(marker.toLowerCase())));
  console.log(`\nAudit scan: ${risky.length === 0 ? "no obvious secret markers" : `${risky.length} suspicious line(s)`}`);
  for (const line of risky.slice(0, 10)) console.log(line);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function usage(): void {
  console.log(`Usage: bun run onclave:acceptance-host -- [options]

Options:
  --root PATH                  Override Onclave state root. Default: ~/.pi/onclave
  --host-name NAME             Label used in the printed report.
  --peer-name NAME             Static peer name to write/use.
  --peer-node-id ID            Peer node_id from onclave_status.
  --peer-hub-instance-id ID    Peer hub_instance_id from onclave_status.
  --peer-endpoint URL          Peer wss://host:port/v1/hub endpoint.
  --write-static-peer          Write/update the peer in config.json.
  --audit-scan                 Scan audit.log.jsonl for obvious secret markers.
  --no-init                    Do not create the local Onclave identity if missing.
  -h, --help                   Show this help.
`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
