---
created: 2026-05-22
status: draft
parent: ../extensions/onclave-comms/onclave-comms-PRD.md
---

# PRD: Technology Stack Architecture for Tailnet Pi Agent Platform

## Problem

The Secure LAN/Tailnet Pi agent platform now spans hub messaging, observer
subscriptions, Aperture guardrails, OpenClaw/Hermes integration, mobile operator
apps, and Proxmox/LXC workspace provisioning. Without an explicit technology
stack boundary, the system risks becoming a mixed implementation where every
component chooses its own language, transport, storage, and security model.

The goal is to define a pragmatic v1 technology stack that keeps each component
in its strongest lane while preserving tailnet-native security, clear service
boundaries, local durability, and manageable operational complexity.

## Users / Jobs To Be Done

- Primary user: A Pi operator/developer building and maintaining the tailnet
  agent platform.
- Job/story: As a developer, I want clear stack choices per subsystem so I do not
  overbuild or duplicate infrastructure.
- Job/story: As an operator, I want the platform to be deployable on personal or
  small-team infrastructure without Kubernetes or enterprise dependencies.
- Job/story: As a security reviewer, I want privileged functions isolated into
  narrow services with auditable interfaces.

## Goals

1. Define the preferred implementation stack for each subsystem.
2. Keep Pi-native protocol and workflow code in TypeScript where practical.
3. Use Go for privileged tailnet services, Proxmox control, and `tsnet`-native
   daemons.
4. Use SQLite and append-only JSONL logs for v1 local durable state.
5. Use HTTPS/WSS over Tailscale as the primary transport.
6. Use Flutter or React Native for mobile, with Flutter preferred for greenfield
   v1.
7. Avoid Kubernetes, Kafka, RabbitMQ, and Postgres in v1 unless planning proves
   they are required.
8. Preserve explicit security boundaries between agents, hubs, provisioners,
   Aperture, and operator clients.

## Non-Goals

- No single monolithic application containing all platform responsibilities.
- No Kubernetes-first deployment model in v1.
- No central cloud control plane requirement.
- No enterprise SIEM, SSO, or policy platform dependency for v1.
- No requirement to rewrite Pi internals outside the extension surface.
- No direct mobile-to-Proxmox or mobile-to-agent privileged control.
- No attempt to standardize on one language for every component.

## Recommended Stack

| Subsystem | Preferred stack | Rationale |
|-----------|-----------------|-----------|
| Pi hub/comms extension | TypeScript, Zod, WebSocket, SQLite | Fits Pi extension ecosystem and schema-heavy protocol work |
| Observer event store | SQLite, JSONL audit logs | Durable enough for v1 without external brokers |
| Workspace provisioner | Go, `tsnet`, Proxmox API, SQLite, systemd | Go fits Tailscale and privileged infra daemon work |
| LXC workspace templates | Debian 12/Ubuntu 24.04, systemd, git, language toolchains | Boring reproducible Linux workspaces |
| Aperture guardrail hook | Go or TypeScript; Go preferred for `tsnet` service | Tailnet service with deterministic request inspection |
| Tool authorization | TypeScript in Pi runtime, optional Go service for shared enforcement | Keeps local tool decisions near agent runtime |
| OpenClaw/Hermes adapter | TypeScript sidecar, optional Go `tsnet` proxy | Protocol glue and schema mapping fit TypeScript |
| Mobile app | Flutter, Riverpod/Bloc, Drift/SQLite, secure storage, APNs/FCM | Strong cross-platform mobile UX and offline state |
| Web dashboard | SvelteKit later | Lightweight internal UI, not required for v1 |
| Policy v1 | YAML + deterministic rules | Simple, reviewable, versioned |
| Policy later | OPA/Rego or Cedar | Only if policy complexity requires it |

## Researched Implementation Context

### Proxmox API and Go Client

Proxmox VE exposes a REST-like API under `/api2/json` and formally describes API
parameters with JSON Schema. API tokens can be used through the
`Authorization: PVEAPIToken=USER@REALM!TOKENID=UUID` header and do not require
CSRF tokens for write requests. Proxmox documents container creation through the
same API surface, and `pvesh` exposes the REST API locally for debugging.

The `github.com/luthermonson/go-proxmox` client is a plausible Go client for v1.
It supports API-token authentication, context-aware calls, typed endpoint
coverage, tests, and integration testing against a real Proxmox endpoint. The
PRD should treat this as a candidate dependency rather than a final choice until
planning validates LXC create/delete/template support against the target Proxmox
version.

Design implication: the Workspace Provisioner should use scoped Proxmox API
tokens, avoid password/ticket auth for automation, and include an integration
smoke test that creates and destroys a disposable LXC without leaving resources
behind.

### Tailscale `tsnet` Services

Tailscale documents `tsnet` as a Go library for embedding a Tailscale node inside
a Go program. It can create distinct tailnet identities and service surfaces for
applications. `tsnet.Server.ListenService` with `ServiceModeHTTP` can register a
Go application as a Tailscale Service, using tailnet policy `tagOwners`,
`autoApprovers`, and grants for reachability.

Design implication: Go services such as Workspace Provisioner, push bridge, and
`ai-guard` can be deployed either behind an existing `tailscaled`/Serve setup or
as `tsnet` service identities. `tsnet` is a strong reason to keep privileged
service daemons in Go.

### Schema Sharing

Because Proxmox itself uses JSON Schema to describe and validate API shapes, the
platform should prefer JSON Schema as the cross-language contract between
TypeScript and Go. TypeScript/Zod remains ergonomic for Pi extension code, but Go
services should validate generated or checked-in JSON Schema fixtures rather than
hand-copying loosely typed structures.

Design implication: planning should decide whether schemas are authored in Zod
and exported to JSON Schema, or authored in JSON Schema first and wrapped by
TypeScript helpers. Either way, cross-language conformance tests are acceptance
critical.

## Requirements

### Functional Requirements

- Pi hub protocol schemas must be defined in TypeScript with runtime validation.
- Protocol envelopes must use JSON over HTTPS/WSS.
- Shared message IDs must use sortable unique IDs such as ULIDs.
- Timestamps must use RFC3339/ISO-8601 UTC strings.
- Hub state must use SQLite for agents, subscriptions, pending deliveries, and
  workflow state.
- Hub audit logs must be append-only JSONL with non-secret metadata.
- Workspace provisioner must be a separate tailnet-only service.
- Workspace provisioner must be implemented in Go unless planning identifies a
  stronger reason to use another stack.
- Workspace provisioner must use scoped Proxmox API credentials.
- Workspace provisioner must persist workspace lifecycle and Proxmox VMID/CTID
  mapping in SQLite.
- Workspace provisioner must publish lifecycle events back to the Pi hub.
- LXC workspaces must be based on hardened unprivileged Linux templates by
  default.
- LXC workspaces must not receive Proxmox API credentials.
- Aperture must be the preferred LLM gateway for agents.
- Guardrail hooks must expose HTTP endpoints compatible with Aperture hook
  payloads and response schemas.
- Guardrail hooks must use deterministic scanning and policy checks before any
  model-assisted classification.
- Tool authorization must happen before execution, not only after Aperture logs a
  tool call.
- OpenClaw/Hermes integration must use a sidecar/adapter boundary rather than
  embedding runtime-specific logic directly in the hub core.
- Mobile clients must fetch full sensitive details over tailnet HTTPS/WSS and use
  push notifications only as minimal pointers.
- All privileged services must support systemd deployment in v1.
- Each service must expose health/status endpoints suitable for tailnet-local
  monitoring.

### Transport Requirements

- Primary service-to-service transport must be HTTPS or WSS over Tailscale.
- Local process communication may use loopback HTTP, Unix sockets, or named pipes
  where platform-appropriate.
- UDP LAN discovery is optional/fallback only when Tailscale-native discovery is
  unavailable.
- Mobile push payloads must not contain raw prompts, secrets, private paths, or
  full command arguments.

### Storage Requirements

- SQLite must be the default local state store for v1 services.
- JSONL must be the default audit log format for v1 services.
- Audit records must include service name, event type, timestamp, correlation ID,
  decision/result, and redacted evidence where applicable.
- S3-compatible export may be added for long-term retention but is not required
  for v1.
- Postgres may be introduced only if planning identifies clear multi-user or
  multi-node state requirements that SQLite cannot satisfy.

### Security Requirements

- Tailscale ACLs/tags must govern network reachability between services.
- Service identities should use Tailscale tags or `tsnet` identities where
  practical.
- Provider API keys must live in Aperture, not on agent workspace machines.
- Proxmox credentials must live only in the Workspace Provisioner.
- Hub registration tokens for workspaces must be short-lived.
- Tool authorization policies must be versioned.
- Human approval decisions must be attributable and auditable.
- Services must fail explicitly when required dependencies or credentials are
  missing.

## Suggested Service Layout

```text
pi-hub-extension/          TypeScript Pi extension
pi-protocol/               Shared TypeScript schemas and fixtures
workspace-provisioner/     Go tsnet Proxmox service
ai-guard/                  Go or TypeScript Aperture hook service
runtime-adapters/          TypeScript OpenClaw/Hermes adapters
mobile-app/                Flutter Android/iOS app
ops/systemd/               Example service units
ops/policies/              YAML policy examples
```

## Deployment Model

V1 should support small-tailnet deployment:

```text
Machine A:
  Pi hub
  Aperture
  ai-guard

Machine B:
  Workspace Provisioner
  Proxmox host/API access

Proxmox:
  LXC workspaces

Phone:
  Tailscale mobile app/VPN
  Pi mobile app
```

Larger deployments may split each service onto separate tailnet nodes.

## Acceptance Criteria

1. [ ] Stack boundaries are documented per subsystem.
   - Verify: Review implementation plan for each subsystem.
   - Pass: Each subsystem has a chosen language, transport, storage model, and
     security boundary.
   - Fail: Components make ad hoc stack choices without rationale.

2. [ ] Pi hub protocol uses TypeScript schemas and runtime validation.
   - Verify: Inspect protocol definitions and tests.
   - Pass: Message envelopes are validated and invalid messages fail explicitly.
   - Fail: Messages are accepted as untyped arbitrary JSON.

3. [ ] Privileged Proxmox control is isolated in a Go provisioner service.
   - Verify: Run a workspace provisioning flow.
   - Pass: Only the provisioner has Proxmox credentials and agents receive no
     Proxmox authority.
   - Fail: Agents, mobile clients, or adapters can call Proxmox directly.

4. [ ] V1 works without Kubernetes, Kafka, RabbitMQ, or Postgres.
   - Verify: Deploy the v1 stack on a small tailnet using systemd services.
   - Pass: Hub, provisioner, guardrail service, and adapters run with SQLite and
     JSONL state.
   - Fail: External cluster infrastructure is required for basic operation.

5. [ ] Mobile app uses push as pointers and tailnet fetch for details.
   - Verify: Trigger approval and security notifications.
   - Pass: Push payloads contain minimal routing metadata and details are fetched
     over tailnet.
   - Fail: Sensitive prompt/tool details are present in APNs/FCM payloads.

6. [ ] Aperture is the preferred LLM gateway path.
   - Verify: Run an agent task from an LXC workspace.
   - Pass: Model traffic is visible in Aperture and attributed to the correct
     identity/tag.
   - Fail: The agent calls provider APIs directly by default.

7. [ ] Audit logs are local, append-only, and redacted.
   - Verify: Trigger hub routing, workspace provisioning, guardrail, and approval
     events.
   - Pass: JSONL audit entries exist with correlation IDs and no raw secrets.
   - Fail: Audit records are missing or include secret material.

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| All TypeScript | Shared language and schemas | Weak fit for `tsnet` and Proxmox daemon work | Rejected |
| All Go | Strong services and tailnet integration | Poor fit for Pi extension/runtime work | Rejected |
| Kubernetes-first | Standard orchestration | Too much control-plane complexity for v1 | Rejected |
| Postgres-first | Strong central database | Adds ops burden before needed | Deferred |
| RabbitMQ/Kafka event bus | Mature messaging | Duplicates hub observer/event model in v1 | Deferred |
| Flutter mobile | Strong cross-platform native UX | New stack if team prefers TS | Preferred |
| React Native mobile | TypeScript reuse | More JS/mobile dependency churn | Acceptable alternative |
| OPA/Rego from day one | Strong policy engine | More complexity than early rules need | Deferred |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Too many languages increase maintenance cost | Slower development | Keep to TypeScript, Go, and one mobile stack only |
| SQLite becomes insufficient | State sync issues | Define migration path to Postgres only when needed |
| Go/TypeScript schema drift | Protocol bugs | Generate JSON Schema fixtures and cross-language tests |
| Mobile stack choice delays app | Slow operator UX delivery | Build minimal web/mobile gateway first if needed |
| Provisioner bugs affect infrastructure | Container sprawl or data loss | Use scoped Proxmox tokens, TTL cleanup, dry-run, and audit |
| Guardrail service becomes overcomplicated | Security false confidence | Keep deterministic controls first and document limits |

## Open Questions

- Should shared protocol schemas be authored in TypeScript/Zod and exported to
  JSON Schema for Go, or authored in JSON Schema first?
- Should `ai-guard` be Go for `tsnet` deployment or TypeScript for shared policy
  logic with Pi?
- Should the mobile app use Flutter or React Native given the expected maintainer
  skill set?
- What SQLite migration library should each language use?
- Should LXC templates be built manually, with Packer, or with Proxmox template
  automation scripts?
- Should the dashboard be deferred entirely until the mobile app exists?

## Plan Handoff

Recommended next command:

```bash
/plan-it .specs/archive/secure-lan-pi-coms/technology-stack-architecture-PRD.md
```

Review command:

```bash
/review-it .specs/archive/secure-lan-pi-coms/technology-stack-architecture-PRD.md
```
