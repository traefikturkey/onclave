---
created: 2026-05-25
status: draft
parents:
  - ../extensions/onclave-pi/onclave-pi-PRD.md
  - observer-subscriptions-PRD.md
  - tailscale-aperture-guardrails-PRD.md
  - openclaw-hermes-integration-PRD.md
  - mobile-agent-comms-app-PRD.md
  - technology-stack-architecture-PRD.md
---

# PRD: Onclave Agentic Software Factory

## Problem

Software delivery with multiple coding agents is difficult to operate safely at
scale. Agents need secure communication, shared task state, isolated workspaces,
model and tool guardrails, human approvals, durable audit trails, and mobile
operator visibility. Without a unified factory layer, each runtime tends to
invent its own messaging, workspace, policy, and notification paths, creating
coordination gaps and inconsistent security boundaries.

The goal is to define Onclave as an agentic software factory where specialized
agents plan, implement, test, review, document, and release software through a
shared task and event model. The current Pi communication plugin should become
`onclave-pi`: the trusted communication fabric between agents, hubs,
runtimes, guardrails, workspace services, and operator clients.

## Users / Jobs To Be Done

- Primary user: A developer or operator running several local or tailnet-connected
  coding agents.
- Job/story: As an operator, I want to submit a software change request and have
  the factory coordinate planning, implementation, review, test, and handoff
  across specialized agents.
- Job/story: As an operator, I want each agent action to be routed through secure
  hubs, policy checks, workspace isolation, and audit logging.
- Job/story: As an agent, I want to subscribe to relevant task, review, test,
  approval, and guardrail events instead of polling other agents.
- Job/story: As a reviewer, I want a clear provenance trail showing which agent,
  workspace, hub, model session, approval, and policy decision contributed to a
  change.
- Current workaround: Run agents manually in separate terminals, copy context
  between sessions, rely on generic chat notifications, and review outputs
  without consistent correlation or policy enforcement.

## Goals

1. Define Onclave as the secure multi-agent software factory product.
2. Rename the current communication plugin concept to `onclave-pi` so Onclave
   can encompass orchestration, workspaces, guardrails, mobile UX, and runtime
   integrations.
3. Use `onclave-pi` hubs as the only network communication path between
   factory agents and runtimes.
4. Support task decomposition, assignment, status tracking, review loops, test
   execution, and release handoff.
5. Use observer subscriptions for event-driven coordination across agents,
   workspaces, guardrails, and operator clients.
6. Run risky or untrusted work in isolated Proxmox/LXC workspaces with explicit
   provisioning, retention, and teardown controls.
7. Route model traffic through Aperture where configured and enforce Pi-side tool
   authorization before tool execution.
8. Integrate external runtimes such as OpenClaw and Hermes through adapters
   rather than bypassing `onclave-pi`.
9. Provide mobile-first operator controls for notifications, approvals, task
   monitoring, workspace lifecycle, and audit review.
10. Preserve local-first and tailnet-first deployment without requiring
    Kubernetes, Kafka, RabbitMQ, Postgres, or a public control plane for v1.

## Naming and Package Boundaries

- `Onclave` is the overall agentic software factory product and system.
- `onclave-pi` is the Pi plugin and protocol component responsible for hub
  discovery, registration, trusted messaging, and observer subscriptions.
- Factory-level orchestration, workspace provisioning, guardrails, mobile
  clients, and runtime adapters are Onclave subsystems that communicate through
  `onclave-pi` but are not themselves the comms plugin.
- Existing references to the early `onclave` Pi plugin should be treated as
  legacy naming and migrated to `onclave-pi` during implementation planning.

The naming policy is locked for the current stage:

- Product, repo, and architecture language should use `Onclave`.
- Internal extension/package/directory names should use `onclave-pi` when
  referring specifically to the communication subsystem.
- User-facing tool names should remain on the current `onclave_*` and
  `/onclave-*` surface for now.
- Runtime state should remain under `~/.pi/onclave/` for now.

This keeps the product vision broad while avoiding unnecessary churn in the
existing operator workflow, tests, and local state handling.

## Near-Term Monorepo Repository Strategy

The repository should remain a monolithic repo in v1. The immediate goal is not
maximum separation; it is clearer naming and simpler navigation while the only
substantial implementation is still the communication subsystem.

Near-term repository guidance:

- Keep `onclave-pi` consolidated under a single extension subtree for now.
- Prefer one clear home for comms entrypoints, internal implementation, tests,
  and helper scripts instead of splitting early across many top-level packages.
- Keep factory-wide docs, root scripts, and workspace configuration at the repo
  root.
- Defer `services/`, `apps/`, and additional `packages/` directories until real
  code exists for those subsystems.
- Preserve light internal boundaries inside the `onclave-pi` subtree so later
  extraction remains straightforward.

Recommended near-term layout:

```text
extensions/
  onclave-pi/
    package.json
    README.md
    src/
      onclave-pi.ts
      lib/
      ui/
      protocol/
    tests/
    scripts/
```

The `lib/` area should hold the current reusable communication logic. The
extension entrypoint should stay thin and call into `lib/` rather than becoming
an all-in-one implementation file.

## Repository Migration Plan

The repository migration should happen in small, low-surprise steps.

### Phase 1: Rename and Consolidate the Existing Comms Subsystem

- Create a working branch before moving files.
- Rename `extensions/pi-onclave/` to `extensions/onclave-pi/`.
- Move code from `packages/core/src/onclave/` into
  `extensions/onclave-pi/src/lib/`.
- Move tests from `tests/onclave/` into `extensions/onclave-pi/tests/`.
- Move `scripts/onclave-acceptance-host.ts` into
  `extensions/onclave-pi/scripts/`.
- Update root `package.json`, `justfile`, test commands, and import paths.
- Preserve behavior while changing names and locations.

Illustrative path mapping:

| Current path | Near-term path |
|--------------|----------------|
| `extensions/pi-onclave/src/onclave.ts` | `extensions/onclave-pi/src/onclave-pi.ts` |
| `packages/core/src/onclave/*` | `extensions/onclave-pi/src/lib/*` |
| `tests/onclave/*` | `extensions/onclave-pi/tests/*` |
| `scripts/onclave-acceptance-host.ts` | `extensions/onclave-pi/scripts/onclave-acceptance-host.ts` |

### Phase 2: Add Factory-Specific Areas Only When Real Code Exists

Add new top-level areas only when they have concrete implementation value:

- `services/` when the workspace provisioner, `ai-guard`, or runtime adapters
  become deployable daemons.
- `apps/` when the mobile client or another operator-facing app is real.
- Additional `packages/` only when shared contracts or non-extension libraries
  truly have more than one active consumer.

### Phase 3: Split Further Only When Pressure Is Real

A later split from the single `onclave-pi` subtree is justified when one or
more of these become true:

- a non-Pi service needs the comms library without extension wiring
- shared contracts must be consumed by Go or mobile code
- the extension subtree becomes crowded enough that navigation slows down
- comms, factory orchestration, and deployable services now have clearly
  different release and test needs

At that point, the likely next structure is a monorepo with explicit
`extensions/`, `services/`, `apps/`, and selective shared `packages/`, but not
before.

## Non-Goals

- No autonomous production deployment without explicit policy and approval
  support.
- No direct agent-to-agent network sockets outside `onclave-pi`.
- No direct mobile-to-agent or mobile-to-Proxmox privileged control.
- No public multi-tenant cloud control plane in v1.
- No global Internet-scale queue, DHT, or gossip mesh in v1.
- No replacement for Pi itself, and no assumption that `onclave-pi` alone is
  the whole Onclave product.
- No assumption that every repository, runtime, or tool is safe to automate.
- No storage of provider API keys, Proxmox credentials, private keys, or raw
  secrets in agent workspaces or mobile clients.
- No exactly-once distributed execution guarantee in v1.

## Factory Scope

The v1 factory coordinates software work through these roles. A single runtime
instance may perform multiple roles, but the protocol should represent the role
for audit and routing.

| Role | Responsibilities |
|------|------------------|
| Intake | Accept operator requests, normalize task metadata, create correlation IDs |
| Planner | Break requests into work items, dependencies, and acceptance checks |
| Workspace manager | Request, approve, provision, retain, and destroy isolated workspaces |
| Implementer | Make code changes inside an approved workspace or local checkout |
| Tester | Run targeted and full validation commands, publish structured results |
| Reviewer | Inspect diffs, test results, risks, and policy events before handoff |
| Documentation agent | Update PRDs, README files, design docs, or changelogs when requested |
| Release coordinator | Prepare handoff artifacts, release notes, and deployment requests |
| Guardrail service | Evaluate model requests, tool calls, secrets, policy, and budgets |
| Operator client | Provide human approval, monitoring, notification, and audit UX |

## Recommended Architecture

```text
Operator / Mobile App
  |
  | tailnet HTTPS/WSS
  v
onclave-pi Hub Network  <==== authenticated WSS ====>  onclave-pi Hub Network
  |                                                   |
  +--> Pi agents                                     +--> OpenClaw/Hermes adapter
  +--> Observer subscriptions                        +--> Runtime agents
  +--> Tool authorization
  +--> Audit/event store
  |
  +--> Workspace Provisioner  ---> Proxmox/LXC workspaces
  |
  +--> Aperture / ai-guard  ---> model providers
```

All network-visible factory communication must pass through authenticated
`onclave-pi` hubs. Local process communication may use loopback or
platform-local channels, but local agents must still register with the local
`onclave-pi` hub before participating in factory workflows.

## Onclave Comms Requirements

### Hub and Trust Model

- The factory must use one `onclave-pi` hub per machine.
- Multiple local Pi instances and runtime adapters must register with the local
  hub.
- Hubs must discover or start through `onclave-pi` state under
  `~/.pi/onclave-pi/`.
- Implementations should provide a migration path from legacy `~/.pi/onclave/`
  state created before the communication plugin rename.
- Hub-to-hub communication must use authenticated WSS with Ed25519
  challenge-response.
- Trusted peers must be authorized through `ssh-ed25519` public keys in an
  `authorized_keys`-style file.
- Unknown hubs may be discovered and displayed but must not list agents, receive
  events, or send tasks.
- Discovery packets must not include prompts, secrets, raw repository paths,
  private keys, or tool arguments.
- All trust changes, authentication attempts, message sends, message receives,
  and policy decisions must be audited.

### Agent Registration

Registered factory participants must advertise:

- agent ID and runtime instance ID
- hub ID and machine identity
- role or roles
- runtime type, such as Pi, OpenClaw, Hermes, provisioner, guardrail, or mobile
  gateway
- project label, repository label, branch/ref, or workspace label when available
- capability manifest
- supported task types and event types
- local delivery endpoint or hub-mediated delivery channel
- current status and last activity timestamp

### Message Envelopes

Factory messages must preserve:

- message ID
- task ID
- workflow ID
- correlation ID
- source hub and agent IDs
- target hub and agent IDs or role selectors
- operator identity when available
- workspace identity when applicable
- policy version and approval state when applicable
- redaction and sensitivity labels

## Workflow Requirements

### Task Intake and Planning

- Operators must be able to create a factory task with title, body, repository,
  target branch/ref, priority, desired outcome, constraints, and acceptance
  criteria.
- The factory must create stable task, workflow, and correlation IDs.
- Planner agents must be able to decompose a task into ordered or parallel work
  items.
- Work items must declare required capabilities, repository scope, workspace
  needs, risk level, and expected validation.
- Plans must be reviewable before execution when policy requires approval.
- Plans must be versioned so later changes can be audited.

### Assignment and Coordination

- The hub must assign work items by explicit target agent or capability-based
  role selection.
- Agents must publish task lifecycle events for queued, started, progress,
  blocked, waiting for input, completed, failed, and cancelled states.
- Dependent agents must use observer subscriptions rather than polling.
- Agents must be able to request clarification, hand work back, or escalate to a
  human approval queue.
- The system must support cancellation and graceful stop requests for workflows,
  tasks, and workspaces.

### Review and Validation

- Implementer agents must publish diffs, changed file summaries, validation
  commands, and risk notes as structured events or artifacts.
- Tester agents must publish validation command results with exit code, summary,
  relevant logs, and redacted evidence.
- Reviewer agents must inspect implementation outputs, test results, audit
  events, and guardrail decisions before marking a work item ready for handoff.
- The factory must not claim a task is complete unless required acceptance
  checks are satisfied or explicitly waived by an authorized operator.
- Release handoff must summarize changes, tests, risks, approvals, remaining
  work, and artifact links.

## Observer Subscription Requirements

- The factory must use `onclave-pi` observer subscriptions for event-driven
  coordination.
- Subscriptions must include stable subscription IDs, event types, filters, lease
  duration, and optional resume cursor.
- Events must include stable event IDs, event type, producer identity, timestamp,
  correlation ID, metadata, and optional payload.
- Delivery must be at least once with acknowledgments, retries, replay cursors,
  and bounded retention.
- Hubs must authorize subscription creation before accepting it.
- Hubs must not fan out all local events to every trusted hub by default.
- Remote subscription advertisements must include only the minimum metadata
  needed for routing.
- Subscription lifecycle, event routing, delivery, acknowledgments, retries,
  expiry, drops, and denials must be audited.

### Required Factory Event Types

The factory must reserve these event families:

- `factory.workflow.created`
- `factory.workflow.started`
- `factory.workflow.completed`
- `factory.workflow.failed`
- `factory.workflow.cancelled`
- `factory.task.planned`
- `factory.task.assigned`
- `factory.task.started`
- `factory.task.progress`
- `factory.task.blocked`
- `factory.task.waiting_for_input`
- `factory.task.completed`
- `factory.task.failed`
- `factory.review.requested`
- `factory.review.approved`
- `factory.review.changes_requested`
- `factory.validation.started`
- `factory.validation.completed`
- `factory.validation.failed`
- `factory.artifact.created`
- `factory.release.ready`
- `human.approval.required`
- `human.approval.recorded`

The factory must also consume and preserve event types from related PRDs,
including agent lifecycle, runtime integration, guardrail, budget, workspace,
hub trust, and mobile notification categories.

## Workspace Requirements

- Risky, untrusted, or parallel work must be eligible to run in isolated
  Proxmox/LXC workspaces.
- Workspace requests must be routed through the `onclave-pi` hub to a
  Workspace Provisioner service.
- Mobile clients and agents must never call the Proxmox API directly.
- Workspace provisioning requests must include repository, ref, template, CPU,
  memory, disk, TTL, network policy, requester identity, target role, risk flags,
  and policy reason.
- Policy must decide whether provisioning is allowed, blocked, or requires human
  approval.
- Workspaces must receive only short-lived hub registration material and must not
  receive Proxmox credentials or provider API keys.
- Workspace lifecycle states must include requested, approval required,
  provisioning, running, failed, terminating, retained for debugging, and
  destroyed.
- Operators must be able to terminate or retain workspaces through hub-mediated
  controls.
- Workspace lifecycle events must be published to observer subscriptions and
  audit logs.

## Guardrail and Tool Authorization Requirements

- Factory agents should route model traffic through Aperture when configured.
- Agents must not require direct provider API keys when Aperture credential
  injection is available.
- The factory must support an `ai-guard` hook service for request inspection,
  secret detection, prompt-injection handling, request modification, blocking,
  and audit enrichment.
- Guardrail hooks must publish security, budget, and model-request events into
  the observer stream.
- Tool execution must pass through Pi-side tool authorization before execution.
- Tool authorization must evaluate tool name, arguments, target paths, network
  destinations, action type, agent identity, project label, workspace identity,
  risk category, and policy version when available.
- Tool authorization decisions must be `allow`, `block`, or `require_approval`.
- Private keys, credential directories, `.env` files, and provider credentials
  must be blocked by default unless explicit policy allows access.
- High-risk actions such as deployment, package publishing, destructive file
  operations, credential changes, protected-branch pushes, and workspace resource
  escalation must require approval unless policy explicitly allows them.
- Guardrail and tool authorization audit entries must contain non-secret
  metadata, policy version, decision, reason, confidence where applicable, and
  correlation IDs.

## Runtime Integration Requirements

- OpenClaw and Hermes must integrate through an adapter or sidecar that registers
  as an `onclave-pi` participant.
- The adapter must expose runtime agents with stable identities, capabilities,
  project/workspace labels, supported messages, and supported event types.
- Pi agents and external runtime agents must exchange tasks, prompts, responses,
  and status events only through hub-mediated routing.
- Runtime lifecycle states must map to factory task events.
- Runtime tool and model events must be correlated with factory tasks where
  possible.
- Adapter failures must be explicit, audited, and must not corrupt hub state.
- Runtime APIs that provide broad operator access, such as generic tool-invoke
  endpoints, must be wrapped with Pi-side authorization and audit.

## Mobile Operator Requirements

- Mobile clients must connect through tailnet HTTPS/WSS endpoints or configured
  development endpoints.
- Mobile clients are operator clients, not agent hubs.
- The mobile app must list hubs, agents, workspaces, tasks, approvals,
  guardrail/security events, and audit entries visible to the operator.
- The mobile app must support task creation, task monitoring, approval decisions,
  workspace termination, workspace retain-for-debugging, notification settings,
  and deep links from notifications.
- Push notifications must contain only minimal routing metadata and safe
  summaries.
- Full task, prompt, approval, workspace, and security details must be fetched
  over the tailnet after the app opens.
- Approval decisions must include operator identity, timestamp, policy context,
  decision, optional comment, and correlation ID.
- Device revocation and hub session revocation must block further access.

## Storage and Audit Requirements

- `onclave-pi` hub state must use SQLite for agents, tasks, subscriptions,
  pending deliveries, workflow state, and durable cursors.
- Audit logs must be append-only JSONL by default.
- Audit records must include service name, event type, timestamp, correlation ID,
  actor, source, target, decision or result, and redacted evidence where
  applicable.
- Prompt bodies, raw secrets, private keys, provider credentials, full command
  arguments, and private local paths must not be written to audit logs by
  default.
- Event retention, pending delivery queues, audit retention, and artifact
  retention must be bounded and configurable.
- Cross-service contracts should use JSON Schema fixtures or generated schemas to
  avoid TypeScript/Go schema drift.

## Technology Stack Requirements

The repository structure should stay aligned with the implementation stack:

- TypeScript remains the default language inside `extensions/onclave-pi/`
  for the current communication subsystem work.
- Root workspace tooling should continue to support a single monorepo developer
  workflow through `pnpm`, `just`, and repo-level test/typecheck commands.
- New Go, mobile, or service-oriented code should not force an early repo split;
  it should earn its own top-level directory only when the code is real.


- Pi hub, protocol, task orchestration, and runtime adapters should use
  TypeScript where practical.
- Protocol validation should use TypeScript schemas with runtime validation and
  JSON Schema compatibility for cross-language services.
- Workspace Provisioner should be a Go service using Tailscale or `tsnet`, the
  Proxmox API, SQLite, and systemd deployment.
- Guardrail services may use Go or TypeScript; Go is preferred when `tsnet`
  service identity is required.
- Mobile should use Flutter unless planning selects React Native based on
  maintainer constraints.
- V1 must work with SQLite and JSONL without Kubernetes, Kafka, RabbitMQ, or
  Postgres.
- All privileged services must expose health/status endpoints suitable for
  tailnet-local monitoring.

## Security Requirements

- The factory must be secure by default: discovered peers, new agents, and new
  workspaces have no privileges until authorized.
- Tailscale ACLs, tags, or `tsnet` identities should govern service reachability.
- `onclave-pi` trusted-key authentication must govern hub-to-hub messaging.
- Hub authorization must govern task routing, event subscriptions, mobile
  actions, workspace requests, and runtime adapter operations.
- Workspace isolation must prevent agent workspaces from receiving infrastructure
  credentials.
- Guardrails and tool authorization must prevent model output from directly
  becoming privileged action.
- All approvals must be attributable and auditable.
- Services must fail explicitly when credentials, policy, schemas, or required
  dependencies are missing.
- Security controls must prefer deterministic checks, allowlists, denylists,
  budgets, schemas, and policy rules before model-assisted classification.

## Acceptance Criteria

1. [ ] A software change request can create a factory workflow.
   - Verify: Submit a task through a Pi tool or mobile client.
   - Pass: The system creates workflow, task, and correlation IDs and publishes
     `factory.workflow.created`.
   - Fail: Work starts without durable identity or correlation metadata.

2. [ ] Agents coordinate through `onclave-pi` only.
   - Verify: Run planner, implementer, tester, and reviewer agents on two trusted
     hubs.
   - Pass: All task, response, and event traffic flows through authenticated
     `onclave-pi` hubs.
   - Fail: Agents use direct network sockets or unauthenticated side channels.

3. [ ] Observer subscriptions drive dependent work without polling.
   - Verify: Have a tester subscribe to implementation completion events.
   - Pass: The tester wakes on a matching event, ACKs it, and publishes
     validation results.
   - Fail: The tester polls task state or misses the event.

4. [ ] Workspace provisioning is isolated and approval-aware.
   - Verify: Trigger a high-risk task requiring an LXC workspace.
   - Pass: The provisioner receives a hub-mediated request, policy requires or
     records approval, and the workspace registers with short-lived credentials.
   - Fail: Agents or mobile clients call Proxmox directly or receive Proxmox
     credentials.

5. [ ] Guardrails block unsafe model or tool behavior.
   - Verify: Submit test fixtures for private keys, provider keys, protected
     paths, and destructive commands.
   - Pass: Model requests or tool calls are blocked, modified, or sent for
     approval with redacted audit events.
   - Fail: Unsafe actions execute solely because an agent requested them.

6. [ ] OpenClaw/Hermes agents participate through adapters.
   - Verify: Register a runtime adapter and assign a factory task to one of its
     agents.
   - Pass: The runtime agent is visible with capabilities, receives the task,
     returns status and response events, and preserves correlation IDs.
   - Fail: The integration bypasses `onclave-pi` or loses task identity.

7. [ ] Mobile operator workflows are pointer-notification safe.
   - Verify: Trigger task completion, approval required, guardrail block, and
     workspace lifecycle events.
   - Pass: Push notifications contain only safe routing metadata and full details
     are fetched over tailnet HTTPS/WSS.
   - Fail: Push payloads expose prompt text, secrets, paths, or full command
     arguments.

8. [ ] Audit logs support review without leaking secrets.
   - Verify: Complete a workflow involving planning, implementation, testing,
     review, guardrail events, and a workspace.
   - Pass: JSONL audit entries include correlation metadata, decisions, actors,
     and redacted evidence.
   - Fail: Required events are missing or raw secrets are stored.

9. [ ] The v1 stack deploys on a small tailnet without external cluster
   infrastructure.
   - Verify: Run hubs, provisioner, guardrail service, adapter, and mobile API
     with systemd or local processes.
   - Pass: SQLite and JSONL provide local durability and no Kubernetes, Kafka,
     RabbitMQ, or Postgres dependency is required.
   - Fail: Basic operation requires cluster infrastructure.

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Manual multi-agent terminals | Simple and flexible | Weak coordination, audit, and policy consistency | Rejected as factory model |
| Central external broker | Mature queue semantics | Adds operational dependency and duplicates `onclave-pi` observer routing | Rejected for v1 |
| Direct runtime-to-runtime calls | Low overhead | Bypasses hub trust, subscriptions, and audit | Rejected |
| Public cloud control plane | Easy remote access | Conflicts with private tailnet-first deployment | Rejected for v1 |
| All work in local checkouts | Fast for trusted tasks | Weak isolation for risky or parallel work | Allowed only by policy |
| Proxmox/LXC workspaces | Strong local isolation and lifecycle control | Requires provisioner and approvals | Accepted |
| `onclave-pi` hub fabric | Matches existing secure comms model | Requires hub lifecycle and trust setup | Accepted |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents loop or duplicate work | Token waste, conflicting changes | Use task state, event IDs, leases, idempotency keys, and cancellation |
| Guardrails create false confidence | Unsafe actions may still occur | Keep tool authorization mandatory and document enforcement boundaries |
| Workspace sprawl | Resource exhaustion | TTLs, quotas, approval, lifecycle audits, and cleanup jobs |
| Subscription queues grow without bound | Disk or memory exhaustion | Bounded retention, leases, retry caps, and audited drops |
| Runtime adapters map state incorrectly | Lost progress or duplicate execution | Capability manifests, conformance tests, and explicit failure modes |
| Mobile approval lacks context | Unsafe human approvals | Include policy reason, diff/test/workspace context, and risk flags |
| Audit logs leak sensitive data | Credential exposure | Redaction, hashing, safe summaries, and secret fixtures in tests |
| Too much stack complexity | Slow delivery | Keep v1 to Onclave plus `onclave-pi`, SQLite, JSONL, Go services, TypeScript adapters, and one mobile stack |

## Open Questions

- What is the smallest useful v1 workflow: plan/implement/test/review, or
  intake/implement/review only?
- Should factory task state live primarily inside the `onclave-pi` hub or in
  a separate factory coordinator service registered with `onclave-pi`?
- Which roles require dedicated agents in v1, and which can be capabilities on a
  smaller set of agents?
- What default policies should require human approval for workspace provisioning,
  tool calls, branch pushes, package publishing, and deployment requests?
- Should cross-agent artifacts be stored in hub SQLite, filesystem artifacts, or
  a separate artifact service?
- How should merge conflict resolution be modeled when multiple workspaces change
  the same repository?
- What is the default retention window for workflows, events, audit logs,
  workspaces, and artifacts?
- Should release coordination stop at handoff notes in v1, or support PR creation
  when explicitly approved?

## Plan Handoff

Recommended next commands:

```bash
git checkout docs/onclave-pi-monorepo-plan
/plan-it docs/PRDS/agentic-software-factory-PRD.md
```

Review command:

```bash
/review-it docs/PRDS/agentic-software-factory-PRD.md
```

Notes for planner:

- Treat Onclave as the factory and `onclave-pi` as its communication fabric.
- Reuse the parent PRD trust model and observer subscription semantics while
  updating implementation names from legacy `onclave` plugin references to
  `onclave-pi`.
- Keep privileged infrastructure, model routing, tool authorization, and mobile
  actions hub-mediated and auditable.
- Define the narrowest v1 factory workflow before implementing broad role
  orchestration.
