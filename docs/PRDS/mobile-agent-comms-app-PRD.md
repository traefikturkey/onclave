---
created: 2026-05-22
status: draft
parent: PRD.md
---

# PRD: Mobile Agent Comms App for Tailnet Pi Workflows

## Problem

Many agent operators use Telegram, Discord, Slack, or similar chat tools as a
remote control plane for agents. These tools are convenient, but they are not
purpose-built for agent workflows, secure tailnet identity, structured task
state, observer subscriptions, prompt/response correlation, approval gates,
Aperture guardrail events, or sensitive audit requirements.

The goal is to create Android and iOS apps that replace generic chat channels
for Pi agent communication. The app should provide a mobile-first operator
experience for starting tasks, monitoring agents, receiving security/job events,
approving risky actions, and reviewing outputs across the Secure
LAN/Tailnet Pi communication network.

## Users / Jobs To Be Done

- Primary user: A Pi operator who wants to monitor and control local or tailnet
  agents from a phone.
- Job/story: As an operator, I want push notifications for important agent
  events, so I do not need to watch terminal sessions or chat channels.
- Job/story: As an operator, I want to approve or deny risky tool calls from my
  phone with enough context to make a safe decision.
- Job/story: As an operator, I want structured task and agent views instead of a
  flat chat transcript.
- Job/story: As an operator, I want mobile access to remain private to my
  tailnet and governed by the same hub and Aperture policies.
- Current workaround: Telegram bots, Discord bots, Slack channels, email alerts,
  GitHub notifications, or manual SSH/TUI access.

## Goals

1. Provide Android and iOS apps for Secure LAN/Tailnet Pi agent operations.
2. Replace generic chat-based agent control with structured agent workflows.
3. Connect to Pi hubs over Tailscale-private endpoints where available.
4. Support task creation, status monitoring, event subscriptions, approvals, and
   audit review.
5. Provide push notifications for selected observer events.
6. Support human approval flows for tool authorization, guardrail decisions, and
   workspace infrastructure requests.
7. Allow operators to approve, monitor, terminate, and retain Proxmox/LXC agent
   workspaces through hub-mediated controls.
8. Preserve prompt/response correlation, agent identity, project labels, hub
   identity, and workspace identity in the UI.
9. Avoid exposing agent hubs publicly by default.

## Non-Goals

- No full replacement for the Pi terminal/TUI in v1.
- No public multi-tenant cloud service requirement in v1.
- No generic Telegram/Discord/Slack clone.
- No direct mobile-to-agent sockets bypassing the hub.
- No direct mobile-to-Proxmox API access.
- No local model execution on the mobile device in v1.
- No unrestricted file browser for agent machines.
- No production deployment approval without explicit policy support.
- No storage of provider API keys on the mobile device.

## Researched Platform Context

### Tailscale Mobile and App Connectivity Context

Tailscale's documented app-embedding primitive is `tsnet`, a Go library that can
embed a Tailscale node directly into an application. `tsnet` can create a
separate tailnet identity, hostname, IP address, and ACL surface per embedded
service. This is attractive for server-side mobile gateways and push bridges, but
it is not a drop-in mobile SDK requirement for iOS and Android clients.

Design implication: v1 should not assume the mobile app can embed Tailscale
networking directly. The safer requirement is that the phone uses the standard
Tailscale mobile client/VPN to reach MagicDNS, Tailscale Serve, or tailnet
service endpoints. A separate Go-based mobile gateway or push bridge may use
`tsnet` to join the tailnet as its own service identity.

### Tailscale Serve and Identity Headers

Tailscale Serve can expose a loopback service to the tailnet over HTTPS and can
provide identity-aware request metadata to the backend. OpenClaw's Tailscale
integration documents a practical pattern: keep the gateway bound to loopback,
let Tailscale Serve handle HTTPS/routing, and verify identity headers by checking
Tailscale's local identity data rather than trusting client-provided headers.

Design implication: the mobile app should prefer HTTPS endpoints exposed through
Tailscale Serve or tailnet services. The Pi mobile API must verify identity
server-side and must not trust arbitrary forwarded headers unless they originate
from a known local Tailscale Serve/trusted-proxy path.

### Push Notification Constraint

APNs and FCM are outside the tailnet. Therefore push notifications cannot be
assumed to have the same privacy boundary as tailnet traffic. Push payloads must
be minimal pointers and safe summaries only. Full task, prompt, approval, and
security-event details must be fetched after the app reconnects to the Pi hub or
mobile gateway over the tailnet.

## Requirements

### Functional Requirements

- Provide native or cross-platform Android and iOS applications.
- The app must connect to one or more Pi hubs through Tailscale-private hostnames,
  MagicDNS names, or configured tailnet service URLs.
- The app must authenticate using tailnet identity where possible.
- The app must support manual hub configuration for development and fallback.
- The app must list trusted hubs visible to the operator.
- The app must list agents registered with selected hubs.
- Agent lists must show agent ID, runtime type, machine/hub, project label,
  status, current task, and last activity.
- The app must allow creating a new task or prompt for a selected agent or agent
  group.
- Task creation must support title, prompt/body, priority, target agent, target
  project, attachments/links where supported, and approval policy hints.
- The app must show task timelines with structured events rather than only chat
  messages.
- The app must subscribe to observer events through the hub.
- The app must allow users to choose notification subscriptions by event type,
  agent, project, severity, and hub.
- The app must show guardrail/security events emitted by Aperture and Pi
  authorization services.
- The app must support approval, denial, and request-more-info actions for
  tool-call authorization events.
- The app must support approval, denial, and request-more-info actions for
  Proxmox/LXC workspace provisioning requests when policy requires human review.
- Workspace approval details must show repo, ref, requested template, CPU, memory,
  disk, TTL, network policy, requester identity, target agent profile, risk
  flags, and policy reason.
- Approval decisions must include operator identity, timestamp, policy context,
  decision, optional comment, and correlation ID.
- The app must support acknowledging or muting notifications.
- The app must support viewing recent audit entries with redacted evidence.
- The app must show workspace lifecycle state for approved LXC workspaces,
  including requested, approval required, provisioning, running, failed,
  terminating, retained for debugging, and destroyed.
- The app must allow authorized operators to request workspace termination.
- The app must allow authorized operators to request retain-for-debugging when a
  workspace would otherwise be destroyed by TTL.
- The app must not expose raw Proxmox credentials, node credentials, or direct
  Proxmox API controls.
- The app must support secure local storage for hub configuration and session
  tokens where required.
- The app must not store raw provider API keys.
- The app must not log prompt bodies, secrets, or approval details to mobile OS
  logs.
- The app must handle offline mode by showing cached non-sensitive metadata and
  reconnecting subscriptions when network access returns.
- The app must make stale/offline state visually obvious.
- The app must support deep links from push notifications into the relevant task,
  approval, or event detail screen.

### Mobile Push Requirements

- The system must define a push notification bridge that turns selected observer
  events into APNs/FCM notifications.
- Push notification payloads must avoid secrets, raw prompt bodies, private keys,
  and full command arguments.
- Push notifications must include enough metadata to route the app to the right
  hub/task/event after opening.
- Operators must be able to disable push notifications globally or per event
  scope.
- High-risk approval notifications must be distinguishable from informational
  status notifications.

### Required Screens

- Hub connection list
- Agent list
- Agent detail
- Task list
- Task detail/timeline
- New task/prompt composer
- Approval queue
- Approval detail
- Workspace/provisioning queue
- Workspace detail
- Security/guardrail events
- Notification subscription settings
- Audit/event search
- App settings

### Required Event Categories

The app must understand these event categories:

- task lifecycle
- agent status
- observer subscription delivery
- human approval required
- approval decision recorded
- guardrail/security event
- budget/quota event
- workspace provisioning event
- workspace cleanup/retention event
- hub trust/connectivity event
- runtime integration event

## Non-Functional Requirements

- Mobile-first UX: quick triage and approval should be possible in under a
  minute.
- Secure by default: no public hub exposure and no raw secrets in push payloads.
- Tailnet-native: prefer Tailscale connectivity and identity over bot tokens.
- Clear provenance: every task, event, and approval should show source hub,
  agent, project, and correlation metadata.
- Accessibility: support readable typography, dark mode, dynamic type, and
  screen-reader labels for critical controls.
- Reliability: reconnect subscriptions after app resume, network change, or hub
  restart.
- Battery-aware: use push notifications and resumable event streams instead of
  constant foreground polling.
- Audit-friendly: approval decisions must be durable and attributable.

## Suggested Architecture

```text
Android/iOS App
  |
  | tailnet HTTPS/WSS
  v
Pi Mobile Gateway or Pi Hub Mobile API
  |
  +--> Observer subscriptions
  +--> Task/prompt routing
  +--> Approval decisions
  +--> Workspace provisioning status/control
  +--> Audit/event search
  |
  v
Pi Hub Network  <====> Agents / OpenClaw/Hermes / Aperture guardrails
       |
       v
Workspace Provisioner <====> Proxmox API / LXC workspaces
```

For push notifications:

```text
Pi Hub event
  -> Push bridge
  -> APNs/FCM minimal notification
  -> Mobile app opens
  -> App fetches full event details over tailnet
```

## Security Model

- The mobile app should never be treated as an agent hub.
- The mobile app is an operator client with scoped permissions.
- The hub must authorize every mobile action.
- The mobile app must never call the Proxmox API directly; all infrastructure
  actions must go through the Pi hub and Workspace Provisioner.
- Push notification payloads are pointers, not full sensitive content.
- Approval decisions must be signed or otherwise strongly attributed where
  practical.
- Lost or revoked mobile devices must be removable through Tailscale device
  controls and hub session revocation.
- Mobile clients must not bypass Aperture, guardrail hooks, or tool authorization
  policies.

## Acceptance Criteria

1. [ ] The app can connect to a Pi hub over the tailnet.
   - Verify: Configure the app with a MagicDNS or tailnet service endpoint.
   - Pass: The app authenticates, lists hubs/agents, and shows current status.
   - Fail: Public internet exposure or bot-token-style auth is required.

2. [ ] The app can create and track an agent task.
   - Verify: Submit a task to a selected agent from the mobile composer.
   - Pass: The task appears in the task timeline with correlated status events
     through completion or failure.
   - Fail: The user sees only unstructured chat or loses correlation.

3. [ ] Observer event subscriptions drive notifications without polling.
   - Verify: Subscribe to task completion and guardrail events, then trigger
     matching events.
   - Pass: The app receives push or live updates and can open the related detail
     view.
   - Fail: The app must poll continuously or misses events.

4. [ ] Approval flows work from mobile.
   - Verify: Trigger a tool call requiring approval.
   - Pass: The app shows risk context, allows approve/deny/request-info, and the
     hub records the decision with operator identity.
   - Fail: The decision is unaudited or the tool executes without approval.

5. [ ] Workspace infrastructure approvals work from mobile.
   - Verify: Trigger a Proxmox/LXC workspace request that requires approval due
     to repo, resource, TTL, template, or network policy.
   - Pass: The app shows repo/ref, resource request, template, TTL, network
     policy, requester, risk flags, and allows approve/deny/request-info through
     the hub.
   - Fail: The app calls Proxmox directly, omits critical risk context, or the
     provisioner acts without an auditable hub decision.

6. [ ] Workspace lifecycle can be monitored and controlled from mobile.
   - Verify: Approve a workspace, watch it provision and run, then terminate or
     retain it for debugging.
   - Pass: The app shows lifecycle events and authorized actions are routed
     through the hub to the Workspace Provisioner.
   - Fail: The app shows stale lifecycle state or bypasses hub/provisioner
     authorization.

7. [ ] Push notifications do not leak sensitive content.
   - Verify: Trigger events containing prompt text, command arguments, and secret
     fixtures.
   - Pass: Push payloads contain only minimal routing metadata and safe summaries.
   - Fail: Raw prompts, secrets, or sensitive command arguments appear in push
     payloads.

8. [ ] Offline and reconnect behavior is clear.
   - Verify: Disconnect the phone from the tailnet, trigger events, then
     reconnect.
   - Pass: The app shows stale state while offline and resumes event streams or
     fetches missed events after reconnect.
   - Fail: The app silently shows stale data as current.

9. [ ] Device revocation blocks access.
   - Verify: Revoke the mobile device or session and attempt to reconnect.
   - Pass: The hub rejects the client and the app shows a clear re-auth message.
   - Fail: The app continues to control agents or workspaces after revocation.

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Continue using Telegram bots | Familiar, push built in | Weak workflow structure, external channel trust | Rejected |
| Web-only dashboard | Easier to build | Weaker mobile notifications and native UX | Possible companion |
| Native mobile apps | Best mobile UX and notifications | More platform work | Accepted goal |
| Public cloud relay | Easy mobile connectivity | Conflicts with private tailnet-first model | Rejected for v1 |
| Direct mobile-to-agent control | Low latency | Bypasses hub security and audit | Rejected |
| Direct mobile-to-Proxmox control | Full infra control from phone | Exposes privileged infrastructure API and bypasses provisioner policy | Rejected |
| Push payloads with full details | Convenient | Leaks sensitive content to APNs/FCM surfaces | Rejected |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mobile push leaks sensitive data | Secrets or prompts exposed | Send pointers and safe summaries only |
| Approval UX lacks enough context | Operators approve unsafe actions | Show command/path/risk summaries and policy reason |
| Tailnet mobile connectivity is hard for users | App adoption suffers | Provide setup guide and manual endpoint fallback |
| App becomes a full chat client | Scope creep | Center UI on tasks, events, approvals, and agents |
| Lost phone can control agents or workspaces | Security incident | Use Tailscale revocation, scoped sessions, and hub authz |
| Insufficient workspace approval context | Operator approves expensive or unsafe LXC creation | Show repo/ref, resources, template, TTL, network policy, and risk flags |
| Offline events are missed | Operators lose trust | Use durable event cursors and reconnect replay |

## Open Questions

- Should v1 be native Swift/Kotlin, React Native, Flutter, or a PWA plus native
  push wrapper?
- Should the app talk directly to each Pi hub or through a dedicated mobile
  gateway service?
- How should Tailscale mobile identity be surfaced to the hub on iOS and Android?
- What approval actions should require biometric confirmation?
- Which workspace actions should require biometric confirmation: provision,
  terminate, retain for debugging, or resource escalation?
- What event retention window should be available to mobile clients?
- Should the app support attachments in v1, or only text, links, and task IDs?
- Should notification routing use a self-hosted push bridge, vendor push services,
  or both?

## Plan Handoff

Recommended next command:

```bash
/plan-it .specs/archive/secure-lan-pi-coms/mobile-agent-comms-app-PRD.md
```

Review command:

```bash
/review-it .specs/archive/secure-lan-pi-coms/mobile-agent-comms-app-PRD.md
```
