import { randomBytes } from "node:crypto";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import WebSocket from "ws";

const baseUrl = process.env.ONCLAVE_GATEWAY_URL ?? "http://127.0.0.1:8080";
const agentId = `acceptance-${Date.now()}`;
const privateKey = randomBytes(32);
const publicKey = await getPublicKeyAsync(privateKey);

async function request(path, options = {}, expected = [200]) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${body}`);
  }
  return body ? JSON.parse(body) : undefined;
}

const json = (value) => ({ method: "POST", body: JSON.stringify(value) });
await request("/v1/enroll", json({
  agentId,
  runtimeType: "gateway-acceptance",
  publicKey: Buffer.from(publicKey).toString("base64"),
}), [201]);
await request(`/v1/agents/${encodeURIComponent(agentId)}/approve`, json({}), [204]);
const challenge = await request(`/v1/agents/${encodeURIComponent(agentId)}/challenge`, json({}));
const signature = await signAsync(Buffer.from(challenge.nonce, "base64"), privateKey);
const auth = await request(`/v1/agents/${encodeURIComponent(agentId)}/authenticate`, json({
  signature: Buffer.from(signature).toString("base64"),
}));
const headers = { Authorization: `Bearer ${auth.sessionToken}` };
const capabilityRequest = await request(`/v1/agents/${encodeURIComponent(agentId)}/capabilities/request`, { method: "POST", headers });
await request(`/v1/agents/${encodeURIComponent(agentId)}/capabilities`, {
  ...json({ requestId: capabilityRequest.requestId, nonce: capabilityRequest.nonce, capabilities: ["message.send", "message.receive"] }),
  headers,
}, [204]);

const wsUrl = new URL(`/v1/agents/${encodeURIComponent(agentId)}/session`, baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(wsUrl, { headers });
const taskId = `task-${Date.now()}`;
let ready = false;
let delivered = false;
let completed = false;
const finished = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for gateway acceptance flow")), 10000);
  socket.on("open", () => {
    ready = true;
    socket.send(JSON.stringify({ type: "heartbeat" }));
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "session.ready") return;
    if (message.type === "heartbeat.ack") {
      void request("/v1/commands", {
        ...json({
          messageId: `${taskId}-message`, taskId, correlationId: taskId,
          sourceAgentId: agentId, targetAgentId: agentId, type: "task.assign",
          expiresAt: new Date(Date.now() + 60000).toISOString(), payload: { instruction: "gateway acceptance" },
        }),
        headers,
      }, [202]).catch(reject);
      return;
    }
    if (message.type === "command.delivery") {
      delivered = true;
      socket.send(JSON.stringify({ type: "task.ack", messageId: message.messageId, taskId: message.taskId }));
      socket.send(JSON.stringify({ type: "task.started", messageId: message.messageId, taskId: message.taskId }));
      socket.send(JSON.stringify({ type: "task.completed", messageId: message.messageId, taskId: message.taskId, result: { passed: true } }));
      return;
    }
    if (message.type === "task.event" && message.messageType === "task.completed") {
      completed = true;
      clearTimeout(timer);
      resolve();
    }
  });
  socket.on("error", reject);
});
await finished;
socket.close();
if (!ready || !delivered || !completed) throw new Error("gateway acceptance flow did not complete");
console.log(JSON.stringify({ agentId, taskId, delivered, completed }));
