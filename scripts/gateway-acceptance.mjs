import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import WebSocket from "ws";

const baseUrl = process.env.ONCLAVE_GATEWAY_URL ?? "http://127.0.0.1:8080";
const restartGateway = process.env.ONCLAVE_ACCEPTANCE_RESTART === "1";

async function request(path, options = {}, expected = [200]) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.text();
  if (!expected.includes(response.status)) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${body}`);
  return body ? JSON.parse(body) : undefined;
}

const json = (value) => ({ method: "POST", body: JSON.stringify(value) });

async function setupAgent(role, capabilities) {
  const agentId = `acceptance-${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const privateKey = randomBytes(32);
  const publicKey = await getPublicKeyAsync(privateKey);
  const encodedID = encodeURIComponent(agentId);
  await request("/v1/enroll", json({ agentId, runtimeType: "gateway-acceptance", publicKey: Buffer.from(publicKey).toString("base64") }), [201]);
  await request(`/v1/agents/${encodedID}/approve`, json({}), [204]);
  const challenge = await request(`/v1/agents/${encodedID}/challenge`, json({}));
  const signature = await signAsync(Buffer.from(challenge.nonce, "base64"), privateKey);
  const auth = await request(`/v1/agents/${encodedID}/authenticate`, json({ signature: Buffer.from(signature).toString("base64") }));
  const headers = { Authorization: `Bearer ${auth.sessionToken}` };
  const capabilityRequest = await request(`/v1/agents/${encodedID}/capabilities/request`, { method: "POST", headers });
  await request(`/v1/agents/${encodedID}/capabilities`, {
    ...json({ requestId: capabilityRequest.requestId, nonce: capabilityRequest.nonce, capabilities }), headers,
  }, [204]);
  return { agentId, headers };
}

function openSession(agent, onMessage) {
  const wsUrl = new URL(`/v1/agents/${encodeURIComponent(agent.agentId)}/session`, baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl, { headers: agent.headers });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out opening ${agent.agentId} session`)), 10000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "heartbeat" })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "heartbeat.ack") {
        clearTimeout(timer);
        resolve();
      }
      onMessage(message, socket);
    });
    socket.on("error", reject);
  });
  return { socket, ready };
}

const source = await setupAgent("source", ["message.send", "message.receive"]);
const target = await setupAgent("target", ["message.receive"]);
const taskId = `task-${Date.now()}`;
let delivered = false;
let completed = false;

const onSourceMessage = (message) => {
  if (message.type === "task.event" && message.messageType === "task.completed" && message.taskId === taskId) completed = true;
};
const onTargetMessage = (message, socket) => {
  if (message.type !== "command.delivery" || message.taskId !== taskId) return;
  delivered = true;
  socket.send(JSON.stringify({ type: "task.ack", messageId: message.messageId, taskId }));
  socket.send(JSON.stringify({ type: "task.started", messageId: message.messageId, taskId }));
  socket.send(JSON.stringify({ type: "task.completed", messageId: message.messageId, taskId, result: { passed: true, direction: "target-to-source" } }));
};
let sourceSession = openSession(source, onSourceMessage);
let targetSession;
const submit = () => request("/v1/commands", {
  ...json({
    messageId: `${taskId}-message`, taskId, correlationId: taskId,
    sourceAgentId: source.agentId, targetAgentId: target.agentId, type: "task.assign",
    expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { instruction: "reverse-direction acceptance" },
  }),
  headers: source.headers,
}, [202]);

if (restartGateway) {
  await sourceSession.ready;
  // Declare the durable target queue before submitting, then disconnect the
  // target runtime to prove the command survives the gateway restart.
  const initialTargetSession = openSession(target, onTargetMessage);
  await initialTargetSession.ready;
  initialTargetSession.socket.close();
  await submit();
  sourceSession.socket.close();
  const gatewayContainer = execFileSync("docker", ["ps", "--filter", "label=com.docker.compose.service=onclave", "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
  if (!gatewayContainer) throw new Error("could not find the running Onclave container to restart");
  execFileSync("docker", ["restart", gatewayContainer], { stdio: "inherit" });
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline) {
    try {
      await request("/readyz");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  sourceSession = openSession(source, onSourceMessage);
  targetSession = openSession(target, onTargetMessage);
} else {
  targetSession = openSession(target, onTargetMessage);
  await Promise.all([sourceSession.ready, targetSession.ready]);
  await submit();
}
await Promise.all([sourceSession.ready, targetSession.ready]);
const deadline = Date.now() + 10000;
while ((!delivered || !completed) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
sourceSession.socket.close();
targetSession.socket.close();
if (!delivered || !completed) throw new Error(`reverse-direction flow incomplete: delivered=${delivered} completed=${completed}`);
console.log(JSON.stringify({ sourceAgentId: source.agentId, targetAgentId: target.agentId, taskId, delivered, completed }));
