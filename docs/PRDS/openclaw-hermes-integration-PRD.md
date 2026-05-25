---
created: 2026-05-22
status: draft
parent: ../extensions/onclave-comms/onclave-comms-PRD.md
---

# PRD: OpenClaw/Hermes Integration for Tailnet Pi Agent Comms

## Problem

The Secure LAN/Tailnet Pi communication system defines hubs, trusted peer
routing, observer subscriptions, and Aperture guardrails, but external agent
runtimes need a clean way to join the same network. OpenClaw/Hermes-style agent
gateways already provide agent execution, channel handling, and tool/search
interfaces. Without an integration layer, Pi agents, OpenClaw/Hermes agents, and
operator channels become separate islands with duplicated authentication,
logging, routing, and policy behavior.

The goal is to let OpenClaw/Hermes participate as a first-class node in the
Tailscale-enabled Pi agent communication network while preserving Pi hub trust,
observer subscriptions, Aperture guardrails, and auditability.

## Users / Jobs To Be Done

- Primary user: A Pi operator running multiple agent runtimes across a tailnet.
- Job/story: As an operator, I want OpenClaw/Hermes agents to communicate with Pi
  agents through the same secure hub network instead of using separate ad hoc
  channels.
- Job/story: As a Pi agent, I want to send work to an OpenClaw/Hermes agent and
  subscribe to its status events.
- Job/story: As an OpenClaw/Hermes agent, I want to publish progress, completion,
  and tool/security events into the Pi observer event stream.
- Current workaround: Use direct HTTP calls, Telegram/Discord channels, manual
  copy/paste, or separate agent dashboards that do not share identity, events, or
  guardrail policy.

## Goals

1. Add an integration path for OpenClaw/Hermes to register with a local Pi hub or
   trusted tailnet hub.
2. Allow Pi and OpenClaw/Hermes agents to exchange prompt, task, response, and
   status messages through authenticated hub routing.
3. Map OpenClaw/Hermes jobs, channels, tools, and agents into Pi identities and
   observer events.
4. Route OpenClaw/Hermes LLM traffic through Tailscale Aperture when configured.
5. Enforce Pi tool authorization and guardrail event publishing for integrated
   tool calls where practical.
6. Preserve a single audit trail for cross-runtime workflows.
7. Avoid requiring public internet exposure for local agent gateways.

## Non-Goals

- No rewrite of OpenClaw/Hermes internals in v1.
- No hard dependency on OpenClaw/Hermes for core Pi comms.
- No public ingress requirement.
- No bypass of Tailscale ACLs, Aperture grants, or Pi hub trust.
- No assumption that all OpenClaw/Hermes tools can be fully controlled by Pi in
  v1.
- No bidirectional compatibility with every third-party chat/channel connector in
  v1.
- No direct agent-to-agent sockets outside the hub protocol.

## Researched Platform Context

### OpenClaw Gateway Specifics

OpenClaw already exposes integration surfaces that should shape this feature:

- `POST /tools/invoke` invokes one gateway tool directly over HTTP.
- `/tools/invoke` is always enabled, but guarded by Gateway auth and tool policy.
- The endpoint is a full operator-access surface when used with shared-secret
  bearer auth; it must be treated as privileged, not as a narrow per-user API.
- Shared-secret modes restore broad operator scopes and ignore narrower
  `x-openclaw-scopes` headers.
- Trusted proxy/private-ingress modes can honor identity-bearing headers and
  scopes.
- OpenClaw's HTTP tool surface has a default hard deny list for high-risk tools
  such as `exec`, `spawn`, `shell`, filesystem mutation tools, `apply_patch`,
  `sessions_spawn`, `sessions_send`, `cron`, `gateway`, and `nodes`.
- OpenClaw supports optional channel context headers such as
  `x-openclaw-message-channel` and `x-openclaw-account-id` for group policy
  resolution.
- OpenClaw can run its Gateway on loopback while exposing the control UI and
  WebSocket through Tailscale Serve.
- In Tailscale Serve mode, OpenClaw can verify Tailscale identity headers by
  resolving `x-forwarded-for` through `tailscale whois`.
- OpenClaw documentation states that HTTP API endpoints such as `/v1/*`,
  `/tools/invoke`, and `/api/channels/*` do not automatically use the Tailscale
  identity-header auth path; they still use the configured Gateway HTTP auth mode
  unless intentionally placed behind trusted-proxy or private-ingress auth.

Design implication: the Pi adapter should prefer a trusted-proxy or private
loopback/tailnet deployment and must not blindly share OpenClaw Gateway bearer
credentials. If `/tools/invoke` is used, treat it as privileged operator access
and wrap it with Pi-side authorization and audit.

### Hermes Agent Specifics

Hermes Agent provides a migration path from OpenClaw through
`hermes claw migrate`. The migration documentation maps OpenClaw concepts into
Hermes concepts, including persona, workspace instructions, memories, skills,
model providers, custom providers, agent behavior, MCP servers, messaging
platform credentials, allow lists, approval modes, and command allowlists.

Design implication: OpenClaw and Hermes should not be treated as identical
runtime APIs. The adapter should define a small capability manifest and runtime
backend interface, then implement OpenClaw and Hermes backends separately after
validating the current Hermes API surface.

## Requirements

### Functional Requirements

- Provide an adapter service or Pi extension that speaks both Pi hub protocol and
  OpenClaw/Hermes gateway APIs.
- The adapter must run on the tailnet or on the same host as the OpenClaw/Hermes
  gateway.
- The adapter must authenticate to the Pi hub using the same trust model as other
  local or tailnet agent runtimes.
- The adapter must expose OpenClaw/Hermes agents as Pi-visible agent identities.
- Exposed agent identities must include runtime type, runtime instance ID,
  project/workspace label, capabilities, and supported message/event types.
- Pi agents must be able to send a task or prompt to an OpenClaw/Hermes agent
  through the hub.
- OpenClaw/Hermes agents must be able to send responses back through the hub with
  correlation IDs.
- OpenClaw/Hermes job lifecycle changes must publish observer events.
- The adapter must map at least the following lifecycle states:
  - queued
  - started
  - progress
  - waiting_for_input
  - completed
  - failed
  - cancelled
- The adapter must support observer subscriptions for OpenClaw/Hermes job and
  agent events.
- The adapter must translate OpenClaw/Hermes channel messages into Pi message
  envelopes when configured.
- The adapter must translate Pi message envelopes into OpenClaw/Hermes job or
  channel requests when configured.
- The adapter must preserve message IDs, correlation IDs, originating hub ID,
  source agent ID, target agent ID, and user/operator identity when available.
- The adapter must route OpenClaw/Hermes model calls through Aperture when the
  runtime supports OpenAI-compatible, Anthropic-compatible, or other
  Aperture-supported provider configuration.
- The adapter must publish Aperture/guardrail events associated with
  OpenClaw/Hermes jobs when correlation metadata is available.
- The adapter must provide a capability manifest so Pi can know which operations
  are supported.
- The adapter must audit registration, task creation, message delivery, response
  delivery, event publication, authorization denial, and adapter errors.
- The adapter must avoid logging raw secrets, provider API keys, or private
  prompt bodies unless explicitly configured.

### Required Event Types

- `runtime.openclaw.registered`
- `runtime.openclaw.disconnected`
- `runtime.hermes.registered`
- `runtime.hermes.disconnected`
- `agent.runtime.task.queued`
- `agent.runtime.task.started`
- `agent.runtime.task.progress`
- `agent.runtime.task.waiting_for_input`
- `agent.runtime.task.completed`
- `agent.runtime.task.failed`
- `agent.runtime.task.cancelled`
- `agent.runtime.tool_call.detected`
- `agent.runtime.tool_call.blocked`

## Non-Functional Requirements

- Tailnet-first: adapter communication should happen over Tailscale-private
  addresses, MagicDNS names, or Tailscale services.
- Runtime-neutral envelopes: Pi should not leak OpenClaw/Hermes-specific details
  into core hub routing except through explicit capability metadata.
- Fail explicitly when runtime APIs or capabilities are missing.
- Keep adapter behavior deterministic for routing, ID mapping, retries, and
  status translation.
- Make all cross-runtime messages auditable.
- Bound queue size, retry count, and retained event history.
- Do not weaken the security model for convenience channel integrations.

## Suggested Architecture

```text
Pi Agent A
  |
  v
Local Pi Hub  <==== tailnet WSS/HTTPS ====>  Pi/OpenClaw Adapter
                                               |
                                               v
                                      OpenClaw/Hermes Gateway
                                               |
                                               v
                                      OpenClaw/Hermes Agents
```

For LLM calls:

```text
OpenClaw/Hermes Agent
  -> Tailscale Aperture
  -> ai-guard pre_request hook
  -> LLM provider
```

## Acceptance Criteria

1. [ ] OpenClaw/Hermes agents can register as Pi-visible agents.
   - Verify: Start the adapter against a test OpenClaw/Hermes gateway.
   - Pass: Pi hub lists the runtime agents with stable IDs, labels, and
     capabilities.
   - Fail: Agents are invisible or have unstable identity.

2. [ ] Pi can send a task to an OpenClaw/Hermes agent and receive a response.
   - Verify: Send a task from a Pi agent through the hub to an integrated runtime
     agent.
   - Pass: The task runs, response returns with the same correlation ID, and both
     sides audit the exchange.
   - Fail: Correlation is lost, response is not delivered, or audit entries are
     missing.

3. [ ] OpenClaw/Hermes job status appears in observer subscriptions.
   - Verify: Subscribe to `agent.runtime.task.*` and run a runtime job.
   - Pass: Subscribers receive queued, started, progress, completed or failed
     events.
   - Fail: Job progress requires polling or events omit required metadata.

4. [ ] Aperture can observe integrated runtime LLM traffic.
   - Verify: Configure the runtime to use Aperture as its model gateway.
   - Pass: Aperture attributes requests to the correct Tailscale identity or tag
     and groups sessions where possible.
   - Fail: Runtime requires direct provider keys or bypasses Aperture.

5. [ ] Authorization failures are explicit and audited.
   - Verify: Attempt to send a task to a runtime agent without the required hub,
     runtime, or policy authorization.
   - Pass: The request is rejected and audited with non-secret metadata.
   - Fail: The request is silently dropped or allowed.

6. [ ] Adapter failures do not corrupt hub state.
   - Verify: Stop the OpenClaw/Hermes gateway during an active task.
   - Pass: Pi marks the runtime disconnected, emits an event, and preserves
     pending correlation state until retention expiry.
   - Fail: Hub crashes, loops forever, or loses all state without audit.

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Direct Pi-to-OpenClaw HTTP calls | Simple | Bypasses hub auth, events, and audit | Rejected |
| Treat OpenClaw/Hermes as just another chat channel | Fast integration | Loses agent/task semantics | Rejected |
| Adapter service | Decouples runtimes and preserves Pi hub model | Additional component | Accepted |
| Modify OpenClaw/Hermes core | Deeper integration | Higher maintenance and upstream dependency | Deferred |
| Public webhook ingress | Easy external events | Conflicts with tailnet-private goal | Rejected |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Runtime APIs differ from assumptions | Adapter cannot map states reliably | Validate APIs during planning and version capability manifest |
| Tool calls bypass Pi authorization | Unsafe actions occur | Route supported tools through Pi auth; document gaps explicitly |
| Duplicate task execution after retries | Agents repeat work | Use idempotency keys and correlation IDs |
| Channel messages leak secrets | Sensitive data reaches audit or remote agents | Redact logs and preserve trust labels |
| Integration scope expands too much | Delays core comms | Keep v1 to registration, task send/response, events, and Aperture routing |

## Open Questions

- Which OpenClaw/Hermes API should be treated as the stable integration surface?
- Should the adapter live as a Pi extension, standalone sidecar, or OpenClaw/Hermes
  plugin?
- Can OpenClaw/Hermes expose tool calls before execution, or only after model
  response generation?
- What identity should represent channel-originated human requests?
- Should runtime agents be allowed to initiate Pi tasks, or only respond in v1?

## Plan Handoff

Recommended next command:

```bash
/plan-it .specs/archive/secure-lan-pi-coms/openclaw-hermes-integration-PRD.md
```

Review command:

```bash
/review-it .specs/archive/secure-lan-pi-coms/openclaw-hermes-integration-PRD.md
```
