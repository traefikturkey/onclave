---
created: 2026-07-18
status: draft
---

# PRD: Onclave Agentic Software Factory

## Purpose

Onclave is a private, gateway-mediated software factory for coordinating coding
agents, runtime integrations, isolated workspaces, policy controls, and human
operators.

This document is the single future-facing product PRD. It describes capabilities
that are not yet implemented. It does not reproduce the current gateway API,
RabbitMQ topology, SQLite schema, enrollment flow, or runtime-extension behavior;
those are documented by the active architecture and extension contracts.

## Current Baseline

The repository already contains a containerized Go gateway under
`services/onclave`, a shared protocol package under
`packages/onclave-comms-protocol`, and first-party Pi and Hermes integrations
under `extensions/`. The gateway is the sole public runtime boundary. RabbitMQ
and gateway persistence are internal implementation details, and runtime
integrations must use the public HTTPS/WebSocket contract.

The future work in this PRD builds on that boundary. It must not reintroduce
direct runtime-to-RabbitMQ access, direct runtime-to-database access, direct
mobile-to-agent sockets, or the obsolete LAN-hub architecture.

## Users and Jobs To Be Done

- As a developer, I want to submit a software change request and have the
  factory coordinate planning, implementation, testing, review, and handoff.
- As an operator, I want risky work to run in an isolated, policy-approved
  workspace rather than on an uncontrolled host.
- As an agent, I want to receive only the tasks, events, tools, and credentials
  allowed by my identity and current workspace.
- As a reviewer, I want a provenance trail linking the request, plan, agents,
  workspace, model sessions, approvals, tests, artifacts, and final handoff.
- As an operator, I want mobile visibility into task progress, approvals,
  workspace state, security events, and failures without exposing sensitive
  payloads in push notifications.
- As a runtime integrator, I want OpenClaw, Hermes, and future runtimes to join
  through a stable adapter contract rather than custom gateway internals.

## Goals

1. Provide a durable factory workflow for planning, assigning, executing,
   testing, reviewing, and handing off software work.
2. Coordinate agents through authenticated gateway tasks and event subscriptions.
3. Isolate risky, untrusted, or parallel work in managed Proxmox/LXC workspaces.
4. Integrate external runtimes through capability-declaring adapters.
5. Route model access through Aperture where configured and enforce tool policy
   before execution.
6. Give operators auditable approval, monitoring, notification, and workspace
   controls.
7. Keep the deployment private, tailnet-first, local-first, and operationally
   small for the first future release.
8. Preserve durable correlation, auditability, redaction, and explicit failure
   across every subsystem.

## Non-Goals

- Replacing Pi, Hermes, OpenClaw, Aperture, or the Onclave gateway.
- Recreating or documenting gateway internals in this product PRD.
- Reintroducing direct LAN peer discovery, one-hub-per-machine routing, UDP
  discovery, self-signed hub-to-hub TLS, or `authorized_keys`-based LAN trust.
- Direct agent-to-agent sockets outside the gateway contract.
- Direct mobile-to-agent, mobile-to-workspace, or mobile-to-Proxmox privileged
  control.
- Autonomous production deployment without explicit policy and approval.
- Public multi-tenant cloud control plane in the first future release.
- Exactly-once distributed execution guarantees.
- Storing provider API keys, Proxmox credentials, private keys, or raw secrets in
  agent workspaces, mobile clients, or audit records.
- Supporting every third-party runtime, channel, or tool in the first release.

## Product Boundaries

```text
Operator / Mobile Client
          |
          | authenticated HTTPS/WSS
          v
Onclave Gateway
   |       |        |        |
   |       |        |        +--> Audit and event history
   |       |        +-----------> Guardrail / approval services
   |       +--------------------> Workspace provisioner
   +----------------------------> Runtime adapters and agents

Workspace Provisioner ---> Proxmox/LXC workspaces
Guardrail path -------> Aperture ---> model providers
```

The gateway remains the only public coordination boundary. Future services may
have their own deployment and storage, but they communicate through documented
contracts and never depend on gateway internals or broker topology.

## Future Scope

### 1. Factory Workflows

The factory must represent a software request as a durable workflow with stable
workflow, task, correlation, workspace, artifact, and approval identifiers.

A workflow may contain ordered or parallel work items. Each work item must
declare its repository scope, target ref, required capabilities, risk level,
workspace requirements, expected validation, dependencies, and acceptance
criteria.

The workflow must support these lifecycle states:

- `planned`
- `queued`
- `assigned`
- `started`
- `progress`
- `blocked`
- `waiting_for_input`
- `review_required`
- `validation_required`
- `completed`
- `failed`
- `cancelled`

Required behavior:

- Operators can create, inspect, pause, resume, cancel, and approve workflows.
- Planners can decompose requests into traceable work items.
- Assignments can target an explicit agent or a capability-bearing role.
- Agents can request clarification, return work, or escalate to an operator.
- Workflow dependencies prevent downstream execution until prerequisites are
  satisfied or explicitly waived.
- Completion requires the configured acceptance checks or an attributable waiver.
- Release handoff summarizes changes, tests, risks, approvals, artifacts, and
  remaining work.

### 2. Agent and Runtime Participation

Future participants must register through a supported adapter or gateway
contract and advertise:

- stable agent identity and runtime instance identity;
- runtime type and version;
- supported roles and capabilities;
- supported task and event types;
- project, repository, branch, or workspace label when available;
- current status and last activity;
- delivery and cancellation capabilities;
- policy-relevant identity metadata.

The first-party Hermes and Pi integrations remain separate runtime packages.
OpenClaw and future runtimes must use separate adapter backends behind a
runtime-neutral capability manifest. Runtime-specific API details must not leak
into factory routing or shared event schemas.

### 3. Observer-Driven Coordination

Future factory coordination must use authenticated event subscriptions instead
of polling wherever an event can express the dependency.

Subscriptions must support:

- stable subscription IDs;
- event-type and metadata filters;
- lease duration and expiry;
- optional resume cursor;
- authorization and revocation;
- at-least-once delivery;
- acknowledgments, bounded retries, replay, and retention limits;
- delivery-attempt and denial audit records.

Events must include stable event IDs, type, producer identity, timestamp,
correlation ID, non-secret metadata, and an optional redacted payload.

Required future event families include:

```text
factory.workflow.*
factory.task.*
factory.review.*
factory.validation.*
factory.artifact.*
factory.release.*
workspace.*
runtime.*
ai.request.*
ai.tool_call.*
security.*
human.approval.*
mobile.notification.*
```

The implementation must avoid broadcasting all events to every runtime. Event
routing must be authorized, filtered, bounded, and auditable.

### 4. Workspace Provisioning

Risky, untrusted, or parallel work must be eligible for an isolated workspace
managed by a dedicated provisioner service.

Workspace requests must include:

- repository and target ref;
- workspace template;
- CPU, memory, and disk limits;
- lifetime and retention policy;
- network policy;
- requester and target-agent identity;
- risk flags and policy reason;
- required tools and validation commands.

The provisioner must:

- use scoped Proxmox credentials unavailable to agents and mobile clients;
- create hardened, unprivileged LXC workspaces by default;
- issue only short-lived gateway registration material to a workspace;
- persist workspace-to-Proxmox identity mapping;
- publish lifecycle events;
- support termination and optional retention for debugging;
- fail safely when provisioning, teardown, or policy checks fail.

Workspace lifecycle states must include:

```text
requested
approval_required
provisioning
running
failed
terminating
retained
destroyed
```

### 5. Runtime Integrations

The adapter contract must allow a runtime to:

- register and disconnect cleanly;
- expose stable identities and capabilities;
- receive tasks and return correlated responses;
- publish queued, started, progress, waiting, completed, failed, and cancelled
  lifecycle events;
- expose supported tool and channel capabilities;
- preserve source, target, operator, workspace, message, and correlation IDs;
- report authorization denials and adapter failures;
- avoid logging raw secrets or unredacted prompt bodies.

OpenClaw and Hermes must have separate backends because their APIs, policy
models, and lifecycle semantics differ. Runtime integrations must prefer private
HTTPS/WSS or tailnet services and must not require public ingress.

Any privileged runtime endpoint, including OpenClaw tool invocation, must be
wrapped with gateway authorization, capability checks, and audit logging.

### 6. Model Guardrails and Tool Authorization

Aperture should be the preferred model gateway when available. Agents should
not require direct provider keys when Aperture credential injection is enabled.

The future guardrail path must include an `ai-guard` service or equivalent that
can:

- inspect `pre_request` model requests;
- detect prompt injection and untrusted instructions;
- detect, redact, or block high-confidence secrets;
- relabel untrusted retrieved context as data rather than instructions;
- enforce identity, grant, quota, and budget policy;
- return `allow`, `block`, or `modify` decisions;
- emit asynchronous request and tool-call audit events;
- support bounded timeouts and explicit fail-closed or fail-open policy by agent.

Model observation must not be treated as tool authorization. Before a tool
executes, policy must evaluate at least:

- tool name and arguments;
- target paths and network destinations;
- action and risk category;
- agent, runtime, project, and workspace identity;
- policy version and approval state.

Tool decisions must be `allow`, `block`, or `require_approval`. Private keys,
credential directories, `.env` files, destructive filesystem operations,
protected-branch pushes, deployment, package publishing, and credential changes
must be blocked or approval-gated by default.

Guardrails must map controls to prompt injection, sensitive information
disclosure, supply-chain risk, data poisoning, improper output handling,
excessive agency, system-prompt leakage, retrieval provenance, misinformation,
and unbounded consumption.

### 7. Human Approval and Operator Experience

Operators must be able to review and decide:

- workflow plans and exceptions;
- workspace provisioning and resource escalation;
- tool calls requiring approval;
- guardrail blocks and policy overrides;
- protected-branch changes and release handoffs;
- workspace retention and destruction;
- runtime enrollment or capability changes.

Approval records must include the approving identity, decision, reason, policy
version, request/correlation ID, timestamp, and expiry where applicable.

A future mobile client is an operator client, not an agent hub. It must provide
scoped views for tasks, events, approvals, workspace state, security findings,
and audit history. Push notifications must contain only minimal pointers;
sensitive details must be fetched over authenticated HTTPS/WSS.

The mobile client must never call Proxmox or runtime control APIs directly.
Lost or revoked devices and sessions must be removable without changing agent
state manually.

## Security and Privacy Requirements

- Every future service must authenticate the caller and authorize the requested
  operation before execution.
- Authorization decisions must be attributable, versioned, and auditable.
- Secrets must be redacted from prompts, events, logs, artifacts, notifications,
  and test evidence wherever possible.
- Sensitive payloads must have explicit retention and access rules.
- Correlation IDs must enable incident reconstruction without requiring raw
  prompt storage.
- Services must fail explicitly when dependencies, credentials, or policy
  decisions are unavailable.
- Tailnet/private-network reachability should be preferred over public ingress.
- Future services must expose health and readiness information suitable for
  private operational monitoring.
- Cross-platform behavior must be considered for Windows, Linux, macOS, WSL,
  Git Bash, and MSYS2 where the owning runtime supports those environments.

## Preferred Technology Direction

This is a direction, not an implementation claim:

| Subsystem | Preferred direction |
|---|---|
| Shared protocol schemas | TypeScript schemas with runtime validation and generated cross-language contracts where needed |
| Gateway/runtime clients | TypeScript over the public HTTPS/WebSocket contract |
| Privileged provisioner | Go, with scoped Proxmox access and private deployment |
| Local service state | SQLite where a future service needs durable local state |
| Audit export | Append-only structured records with redaction; external retention is optional |
| Mobile client | Flutter preferred for greenfield, React Native acceptable if it materially improves delivery |
| Model gateway | Tailscale Aperture where available |
| Policy enforcement | Deterministic checks first; policy engine or model-assisted classification only as a supplement |
| Deployment | Private tailnet services and systemd/Compose-style operational simplicity before orchestration platforms |

Kubernetes, Kafka, Postgres, and additional brokers are not first-release
requirements. They may be introduced only when a demonstrated scale or
multi-user requirement cannot be met by the current gateway and local-service
approach.

## Phased Future Scope

### Phase A: Factory Workflow Foundation

- Define workflow, task, artifact, approval, and correlation schemas.
- Add workflow/task lifecycle events and gateway-mediated task coordination.
- Add observer subscriptions needed for dependency-driven workflows.
- Add structured result and handoff artifacts.

### Phase B: Workspace and Policy Controls

- Implement the isolated workspace provisioner.
- Add workspace lifecycle events and retention controls.
- Add tool authorization and approval workflows.
- Add initial `ai-guard` request inspection and redaction.

### Phase C: Runtime Expansion

- Implement capability-based adapter contracts.
- Add separate OpenClaw and Hermes backends where their APIs support the
  contract.
- Add cross-runtime task correlation, lifecycle mapping, and audit coverage.

### Phase D: Operator and Mobile Experience

- Add operator views for workflows, approvals, workspaces, events, and audit.
- Add mobile notifications as redacted pointers.
- Add mobile approval and workspace controls through the gateway.

Phases may overlap, but no phase may bypass the public gateway contract or
security requirements from earlier phases.

## Future Acceptance Criteria

1. A workflow can be created, decomposed, assigned, paused, resumed, cancelled,
   and completed with stable correlated identifiers.
2. A dependent task starts from an event subscription rather than polling and
   preserves replay/resume behavior after a consumer disconnects.
3. A workflow requiring isolation creates a policy-approved LXC workspace,
   publishes lifecycle events, and leaves Proxmox credentials inaccessible to the
   agent.
4. A reviewer can inspect changed artifacts, structured validation results,
   policy decisions, approvals, and redacted audit evidence before handoff.
5. A runtime adapter can register a test runtime, expose capabilities, accept a
   correlated task, publish lifecycle events, and recover from runtime
   disconnection without corrupting gateway state.
6. OpenClaw and Hermes integrations remain separate implementations while sharing
   the runtime-neutral contract.
7. A model request containing a high-confidence secret or prompt-injection test
   fixture is blocked or safely modified before provider forwarding.
8. A proposed high-risk tool call is blocked or approval-gated before execution,
   even when the model gateway merely observed the call.
9. Guardrail, workflow, workspace, approval, runtime, and mobile events are
   available to authorized subscribers with non-secret metadata.
10. A mobile operator can approve an eligible action and inspect its result over
    authenticated HTTPS/WSS without direct Proxmox or agent access.
11. A complete workflow audit can be reconstructed from correlated structured
    records without storing raw credentials or requiring unrestricted prompt
    retention.
12. The future stack can run privately without Kubernetes, Kafka, Postgres, or a
    public control plane unless a later scale decision explicitly approves them.

## Open Questions

- What is the minimum workflow schema that supports parallel work without
  prematurely becoming a general scheduler?
- Which future event families and subscription filters are required for the first
  workflow implementation?
- Should workflow artifacts live in the gateway, object storage, or a dedicated
  artifact service?
- What provisioner API and Proxmox template lifecycle should be standardized?
- Should `ai-guard` be a Go service, a TypeScript service, or a gateway-adjacent
  extension?
- Which tool authorization policy engine is justified: a small local policy
  engine, Cerbos, Oso, or another system?
- Which OpenClaw and Hermes APIs are stable enough for adapter conformance?
- Should runtime adapters be deployable services, host extensions, or both?
- Which mobile stack and notification bridge best fit private tailnet operation?
- What default event and audit retention windows are acceptable for sensitive
  task payloads?
- Which actions require human approval by default, and which may be delegated to
  policy?

## Authority and Maintenance

This document is authoritative for future Onclave product scope. Current runtime
behavior is authoritative only in:

- `docs/agent-gateway.md`;
- `docs/agent-extension-contract.md`;
- the active runtime guides under `docs/extensions/`;
- the implementation and tests in the repository.

When a future capability is implemented, remove its detailed requirement from
this PRD and document the resulting behavior in the applicable contract or
operator guide. Keep this document focused on remaining future scope.
