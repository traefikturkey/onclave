---
created: 2026-05-22
status: draft
source_plan: ./IMPLEMENTATION_PLAN.md
---

# Future Task: Ergonomic Trust Management for Onclave

## Purpose

This document captures a future design direction for making `Onclave` trust
setup less manual while preserving the current security model.

This is intentionally a future item to be hashed out after v1. It is not a
committed implementation plan for the current milestone.

## Current v1 Behavior

Today, the trust model is:

1. Hosts discover each other automatically over UDP.
2. Discovered peers remain visible but untrusted.
3. Operators explicitly exchange public `ssh-ed25519 ...` lines.
4. Each host adds the peer public key to
   `~/.pi/onclave/authorized_keys`.
5. Remote auth and messaging succeed only after that trust setup exists.

This is secure and explicit, but operator-heavy.

## Problem to Solve

The current trust UX requires too much manual coordination:

- copy/paste public key lines between hosts;
- manual file edits or repeated `onclave_trust_add` use;
- external coordination to know which peer should trust which other peer;
- unnecessary friction during repeated LAN pairing and acceptance testing.

The goal is to reduce operator friction without weakening the PRD's explicit
trust model.

## Design Constraints

Any future trust UX should preserve these properties:

- no automatic trust of discovered peers;
- no background trust creation just because a host is visible on the LAN;
- all trust changes remain explicit and auditable;
- existing `authorized_keys` remains the durable source of trust;
- host operators can still inspect and manage trust material directly;
- future UX should layer on top of the current trust gate, not replace it with
  hidden state.

## Recommended Direction

### Recommendation 1: Trust Request and Approval Flow

Preferred next step.

Add an explicit trust-request workflow so a host can ask for trust and the peer
operator can approve or deny it from inside Pi.

Potential future commands/tools:

- `onclave_trust_request`
- `onclave_trust_requests`
- `onclave_trust_approve`
- `onclave_trust_deny`
- `onclave_trust_remove`

Target flow:

1. Host A discovers Host B.
2. Host A sends a trust request containing public key, node ID, endpoint
   metadata, and fingerprint.
3. Host B sees a pending request in Pi.
4. Host B explicitly approves or denies the request.
5. Approval appends the public key to `authorized_keys` and records an audit
   event.

Why this is the best fit:

- removes manual copy/paste in the common case;
- preserves explicit operator approval;
- keeps trust auditable;
- stays aligned with the current security model.

### Recommendation 2: Trust Removal / Revocation UX

Add a first-class removal path so operators do not need to hand-edit
`authorized_keys` for common revocation cases.

Potential future tools:

- `onclave_trust_list`
- `onclave_trust_remove fingerprint="SHA256:..."`
- `onclave_trust_remove node_id="node_..."`

Why it matters:

- trust add without trust remove is incomplete UX;
- operators need a reversible trust workflow;
- explicit removal is easier to audit and explain than file edits.

### Recommendation 3: Optional Invite / Pairing UX

Consider a second-stage pairing flow only after the approval-based model exists.

Potential future commands/tools:

- `onclave_trust_invite`
- `onclave_trust_join`

Possible shape:

- one host generates a short-lived invite or pairing blob;
- the other host imports it;
- approval still occurs explicitly, or the invite carries narrow,
  single-purpose authorization metadata.

Why it is lower priority:

- more protocol and state complexity;
- easier to get wrong than request/approve;
- not necessary to solve the main v1 operator pain.

### Recommendation 4: Keep TOFU Optional, Not Default

A trust-on-first-use mode may be useful later, but it should never replace the
explicit default model.

If ever added, it should be:

- opt-in only;
- clearly labeled as less strict than explicit approval;
- accompanied by fingerprint review and audit logging.

## Suggested Future Sequencing

1. Implement trust list and trust remove UX.
2. Design and implement trust request / approve / deny flow.
3. Re-run multi-host operator testing.
4. Only then evaluate pairing invites or optional TOFU.

## Open Questions for Future Design

- Should trust requests be delivered over the existing discovered WSS path, or
  should they use a separate request channel?
- Should approval always require a human action in the Pi session, or can a
  config allow auto-approval for pre-scoped environments?
- What should the durable storage model for pending trust requests be?
- Should a trust request include a human-readable host label in addition to node
  ID and fingerprint?
- Should trust removal immediately affect live authenticated sessions, or only
  on the next remote auth attempt?

## Non-Recommendations

These are explicitly not recommended as the default path:

- automatic trust of discovered peers;
- silent background trust creation;
- discovery-triggered auto-auth that also creates authorization;
- replacing `authorized_keys` with hidden opaque trust state.

## Relationship to the Implementation Plan

This document supports the post-v1 trust management UX item listed in:

- `docs/IMPLEMENTATION_PLAN.md`
- `docs/STATUS.md`

It should be treated as a design reference for future planning, not as a
required v1 completion item.
