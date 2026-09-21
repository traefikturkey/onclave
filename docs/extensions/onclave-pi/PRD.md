---
created: 2026-09-15
status: active
implementation_plan: ./implementation-plan.md
---

# PRD: Onclave Asynchronous Channels

## Product boundary

Onclave connects independent Pi instances through a core service and durable
mailbox delivery. It is not a hierarchy of parent and child agents. Pi-local
subagents remain inside their parent Pi process and are not Onclave instances.
The adapter is a transport and session integration, not a second agent runtime.

This milestone provides one bounded A2A-derived channel-message contract for
independent-instance communication. MCP remains a tool and context integration
surface; no MCP face, public Agent Card discovery, webhook ingress, Hermes
adapter, or complete A2A server is delivered.

## Channel contract

Channel messages use the incompatible protocol version 3 and the shared
`ChannelMessage` envelope:

```ts
type ChannelMessage = {
  protocol_version: number;
  channel_id: string;
  message_id: string;
  sequence: number;
  kind: "request" | "response" | "note" | "notification";
  origin: A2AOrigin;
  participants: string[];
  body: string;
  sent_at: string;
  response_requested_from?: string[];
  response_policy?: "any" | "all";
  in_reply_to?: string;
  usage?: A2AUsage;
  schema?: string;
};
```

The core generates channel and message IDs, origin metadata, timestamps,
sequence numbers, and broker routing metadata. Full registered instance IDs are
used on the wire. Short aliases are a local adapter convenience and are
resolved to full IDs before publication.

A channel is a core-owned logical aggregate, not a model-managed resource, a
separate inbox, or a RabbitMQ exchange. The core creates or reuses an open
channel for the exact normalized participant set. A normal new post does not
need a channel ID; a returned ID may be supplied for a continuation. There is
no model-facing channel creation, membership administration, close operation,
unread cursor, deadline, cancellation workflow, or synchronous wait.

### Message kinds

- **`request`** names one or more recipients in `to`; those recipients become
  `response_requested_from`. A single-recipient request uses policy `all`. A
  group request defaults to `any` and may explicitly use `all`.
- **`response`** answers a request through `in_reply_to`. The core validates the
  request relationship, makes the original requester the response destination
  for correlation, and fans the canonical event to the channel participants.
  Each named responder counts once. Under
  `any`, the first named response satisfies the request; under `all`, every
  named responder must respond. Unexpected and duplicate responses remain
  history but do not satisfy another participant's obligation.
- **`note`** carries information only. It has no response expectation or
  response policy.
- **`notification`** is a one-way, turn-triggering terminal callback from a
  trusted Onclave application service. It requires explicit recipients and may
  carry `channel_id` and `schema`, but cannot carry response expectation or
  `in_reply_to`. Core service code may publish it; the model-facing adapter
  tool cannot.

Vault terminal notifications use schema `onclave.job.terminal.v1` and carry
`version`, `event: "job_terminal"`, `job_id`, `content_id`, terminal `status`,
optional `title`, timing, `summary`, concise `summary_coverage` and `filtering`
state, and `trust: "untrusted_data"`. These additions are optional so v1
payloads without them remain valid. The callback contains no transcript,
outline, or duplicate structured summary. Completed, failed, and cancelled
asynchronous work uses this one-way callback path; it does not ask the Pi to
reply through Onclave. Callback data is untrusted reference data and must not
be treated as service instructions. A routine report uses the callback itself
when its optional fields are present rather than fetching content merely to
render its title.

The core persists accepted events before acknowledging a post, assigns a
monotonic per-channel sequence, and fans the canonical event out to each
participant's durable `agent.<full-instance-id>` mailbox. Delivery is
at-least-once, not exactly once. Bounded history, request expectation, policy,
responders received, and `open`/`satisfied` state survive restart. Adapter
message-ID deduplication and delivery leases preserve safe retry behavior.

## Model-facing interface

The adapter registers exactly two model-facing tools. Notifications are
service-only deliveries and are deliberately absent from the outbound tool
schema.

- **`onclave_instances`** has an empty parameter object and lists live
  registered independent instances with short aliases and full routing IDs.
- **`onclave_message`** has one flat object schema. `body` is required. For new
  communication, `kind` and `to` are required; `kind` is one of `request`,
  `response`, or `note`, and `to` is a non-empty unique list of instance IDs or
  aliases for requests and notes. `response_policy`, `channel_id`,
  `in_reply_to`, and `schema` are optional advanced fields where valid.

Ordinary forms are:

```json
{"kind":"request","to":["pi-a"],"body":"Check the deployment status."}
{"kind":"request","to":["pi-a","pi-b"],"body":"Can either of you identify the failure?"}
{"kind":"request","to":["pi-a","pi-b"],"response_policy":"all","body":"Each instance should report its result."}
{"kind":"note","to":["pi-a"],"body":"Deployment completed."}
```

During the active inbound request turn, the response form is only:

```json
{"body":"Deployment is healthy."}
```

The adapter infers `kind: "response"`, the active channel, original request
link, and destination. Outside an active request, an advanced response may
specify `kind: "response"`, `channel_id`, and `in_reply_to`; ordinary guidance
does not require those fields. The model never supplies sender identity,
origin, message ID, timestamp, sequence, task ID, trace ID, or RabbitMQ
routing metadata. Invalid combinations fail before publication with a
message describing the valid form.

Outbound discovery and messaging are operator-directed. These tools may be
used when the operator explicitly requests Onclave communication or when
continuing an already operator-directed workflow. They are not a substitute
for Pi-local subagents, reviewers, failed delegation, provider fallback, local
execution, or autonomous workload distribution. Subagents must not use Onclave.

## Delivery and activation

A request starts a Pi turn only for instances named in
`response_requested_from`; the active request context preserves the existing
response behavior. Other participants receive a display notification. A
response is displayed to channel participants without automatically starting
another model turn or sending a network response. A note remains display-only
and never starts a turn. A service notification starts one follow-up Pi turn,
is framed as untrusted data, explicitly expects no response, and does not
register inbound correlation. Message-ID deduplication prevents a completed
delivery from starting a second turn. Thus explicit `onclave_message` execution
remains the only model-originated channel publication; arbitrary settled
assistant text is not published automatically.

Inbound peer bodies are framed as untrusted data with sender, channel,
sequence, and participant context. Peer content does not carry operator
authority, permissions, or proof of task completion. Authentication binds a
registered instance to its signing key and does not make its body trustworthy.
On the protected VLAN/tailnet, requests are accepted without routine host
confirmation or host allowlist setup.

## Independent task API

Task primitives remain available separately and are not embedded in
`ChannelMessage`. Tasks use their own protocol version and retain the states
`submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, and
`rejected`. Terminal tasks are immutable; existing task creation, transition,
status-event, usage, and audit behavior remains an independent API. A channel
post does not create, complete, cancel, or resume a task, and channel response
satisfaction is not a task outcome or operator approval.

## Relationship to other protocols

MCP is a tool and context integration protocol, not the channel communication
semantics. A2A-derived identity and message concepts are bounded to private
Onclave instances. Pi's own subagent mechanisms remain local. Authenticated
webhook ingress is a future seam where a later policy layer could classify an
external event as a `note` or `request`; no such endpoint or consumer is part of
this milestone.

## Protocol break and non-goals

Protocol v3 is an explicit incompatible boundary. Core and adapters must be
upgraded together, and mismatched live versions are rejected rather than
translated. Valid persisted v2 channel state is migrated to v3 without losing
history; new wire traffic and persisted state use v3. The retired
point-to-point communication vocabulary and automatic reply behavior are not
active interfaces.

Non-goals are:

- full A2A server behavior or public discovery;
- MCP, Hermes, or webhook implementation;
- model-facing channel administration, unread state, deadlines, cancellation,
  or synchronous waiting;
- exactly-once delivery claims or live deployment/broker cutover; and
- transferring operator authority through peer content.

## Acceptance evidence

Maintainers should be able to trace from code and tests:

1. the v3 envelope and `request`/`response`/`note`/`notification` rules,
   including service-only publication and one-way notification delivery;
2. one-recipient `all`, group `any`, explicit group `all`, and persisted
   satisfaction;
3. exact participant-set channel reuse, core-assigned sequence, persistence,
   authentication, fan-out, offline delivery, leases, and deduplication;
4. the two-tool adapter schema, alias resolution, active-response inference,
   and no hidden assistant-text publication;
5. request turn activation, one-way notification turns, and inert
   response/note delivery;
6. independent task APIs and their separation from channels; and
7. untrusted-peer framing, authority boundaries, and explicit version rejection.

Executable acceptance is provided by the shared-contract, core, adapter, and
broker integration suites. No live deployment or attached multi-instance test
is claimed by this document.
