# PRD: menos Service Discovery

Parent PRD: [Homelab Platform Architecture](2026-07-26-homelab-platform-architecture-PRD.md)

Status: draft. Created 2026-07-26, revised 2026-07-27 after adversarial review.

## Purpose

A client should reach menos without being configured with its address.

## Decision

The client derives the menos URL from a domain plus the existing hostname
convention:

```text
https://menos.<domain>/api/v1
```

Resolution order in the client:

1. If `MENOS_API_BASE` is set, use it and stop.
2. Otherwise build `https://menos.<HOST_DOMAIN>/api/v1`.
3. If `HOST_DOMAIN` is also unset, raise an error naming both
   variables.

**No DNS record is created and no DNS tooling changes.** The A record for
`menos.<domain>` already exists in the private `values/dns-records.local.json`,
and `menos_server_name` is already the deployed convention, served by Caddy on
port 443.

Two details a naive implementation gets wrong:

**The API base includes a path.** `.dotfiles/.env.example:18` documents
`MENOS_API_BASE=https://menos.example.net/api/v1`, and
`.dotfiles/tools/menos-youtube/list_videos.py:68-70` signs `/api/v1/content`
while requesting `{api_base}/content`. A base without `/api/v1` would request
`/content` while the RFC 9421 signature covers `/api/v1/content`, and every
request would fail signature verification.

**Do not put an explicit port in the URL.** `signing.py:62` signs
`"@authority"` derived from `urlparse(base).netloc`. With `:443` present that
yields `menos.example.internal:443`, while httpx strips the default port and
sends `Host: menos.example.internal`. Verified: the signed authority and the
transmitted Host would not match, and every request would fail. Omit the port.

## Why not SRV

An earlier revision of this document specified a DNS SRV record
(`_menos._tcp.<domain>`), which required extending
`homelab-infra/infra/ansible/scripts/apply-technitium-dns.py` with a new record
type, a separate service-name validator for underscore labels, a four-field
idempotency comparison, and a `dnspython` dependency in the client.

Adversarial review rejected it, correctly:

- **The A record already exists.** Discovery in the DNS sense is already solved.
  The SRV work would have added a second record pointing at the same host.
- **Every SRV degree of freedom is unused.** Port flexibility is moot because
  the design fixes port 443. Priority and weight are moot with one instance;
  the proposed schema hardcoded both to zero. That is a config knob for values
  that do not vary, which this project's constraints explicitly forbid.
- **It carried most of the risk.** Roughly two thirds of the defects the review
  found existed only because of the SRV machinery, including a live-mutation
  hazard where declaring the record would have caused the next routine
  `just apply` to push it without any DNS-specific review gate.

The research behind SRV was not wasted and is preserved below, because it
answers questions that will recur.

## Why not broadcast

The original idea was a UDP broadcast where a client asks and menos answers. It
was rejected because it is subnet-bound by construction and the client runs on a
laptop that leaves the subnet.

DNS keeps working away from home: the workstation's tailnet interface carries
the tailnet domain, the homelab domain is in the machine's global suffix search
list rather than bound to the Ethernet interface, and the operator's existing
Tailscale configuration already resolves homelab names over the tailnet.
Broadcast could never do this.

Note the client builds a fully qualified name rather than relying on the suffix
search list. The workstation's list places two employer domains ahead of the
homelab domain, so a partially qualified lookup would query an internal service
name against employer DNS first.

## Change site

`.dotfiles/tools/menos-youtube/api_config.py`, function `get_api_base()` at
lines 37-45. It currently loads `~/.dotfiles/.env`, reads `MENOS_API_BASE`, and
raises when the value is empty:

```python
value = os.getenv("MENOS_API_BASE", "").strip()
if not value:
    raise RuntimeError(
        "MENOS_API_BASE is required; set it in the environment or ~/.dotfiles/.env"
    )
```

The change inserts the convention path before the raise. `MENOS_API_BASE` keeps
precedence, so existing setups are unaffected.

Note `get_api_host()` at lines 48-51 calls `get_api_base()` again, so the
function runs twice per invocation. Harmless now that no network lookup is
involved, but worth knowing if that ever changes.

This puts the work in `.dotfiles`, not in `onclave`, even though this PRD lives
with menos.

## Scope

In scope:

- Convention-based URL derivation in `get_api_base()`, with `MENOS_API_BASE`
  keeping precedence.
- `HOST_DOMAIN` documented in `.env.example`.
- An actionable error naming both variables when neither is set.
- Unit tests that actually run in the repo's test command.

Out of scope:

- Any DNS record change. Nothing is added to `dns-records.local.json`.
- Any change to `apply-technitium-dns.py`.
- Tailscale and tailnet routing. A separate instance runs outside this work.
- Backup and restore for menos or anything else.
- Storage architecture.
- Telemetry transport.
- A general service registry.
- Changes to joyride.

## Acceptance criteria

1. A client with no `MENOS_API_BASE` derives the URL and completes a signed API
   call.
   - Verify: unset `MENOS_API_BASE` and confirm it is absent from **both**
     `~/.dotfiles/.env` and `~/.dotfiles/.secrets`, set
     `HOST_DOMAIN`, then run the `/yt` listing command.
   - `api_config.py:15-21` falls back to `.secrets` when `.env` is absent, so
     clearing only `.env` does not produce an unconfigured client and the test
     would pass without exercising the new path.
   - This exercises RFC 9421 signing, not just URL construction. A base missing
     `/api/v1`, or carrying an explicit `:443`, fails here. That is the point.
2. `MENOS_API_BASE` still takes precedence.
   - Verify: set it to a deliberately wrong value and confirm the client uses it
     and fails there rather than falling back to the convention.
3. With neither variable set, the error names both.
   - Verify: unit test.
   - The current message at `api_config.py:42-44` names only `MENOS_API_BASE`.

## Later, not now

If a service ever needs to be reachable on a port other than 443, or if more
than one menos instance needs priority or weight, DNS SRV becomes the right
mechanism and the research below applies. Until then the hostname convention
carries the same information for less machinery.

### Preserved SRV research

Verified 2026-07-27, retained so it is not re-derived:

- **Technitium Forwarder zones serve locally declared records.** A request is
  forwarded to the FWD target only when no matching record exists in the zone.
  The repo already relies on this by adding A and CNAME records into Forwarder
  zones in production.
  Sources: [Technitium help](https://technitium.com/dns/help.html),
  [DnsServer discussion #818](https://github.com/TechnitiumSoftware/DnsServer/discussions/818).
- **Technitium's API supports SRV** at `/api/zones/records/add` with `priority`,
  `weight`, `port`, and `target`, taking a fully qualified `domain` plus a
  separate `zone`, matching the shape `apply-technitium-dns.py:208` already
  uses.
  Source: [Technitium APIDOCS.md](https://github.com/TechnitiumSoftware/DnsServer/blob/master/APIDOCS.md).
- **Do not create a more specific Primary zone.** A Primary zone is
  authoritative and answers NXDOMAIN for names it does not hold rather than
  falling through to the forwarder. Technitium's guidance is one conditional
  forwarder zone per domain.
- **`DNS_NAME_RE` at `apply-technitium-dns.py:15` rejects underscore labels.**
  Verified: `_menos._tcp.example.internal` fails, `menos.example.internal`
  passes. SRV would need a separate service-name validator; loosening the shared
  regex would weaken A and CNAME validation.
- **There is no DNS-specific review gate.** `just plan` runs `tofu plan` only
  and never shows DNS records. `technitium-dns.yml` runs unconditionally for
  enabled services during `just apply`. Any future DNS record change goes live
  on the next routine apply for any reason, with no separate review.

## Sources

| Claim | Source |
|---|---|
| menos A record already exists | private `values/dns-records.local.json`, `a_records`, verified 2026-07-27 |
| menos hostname convention and Caddy on 443 | `homelab-infra/scaffold/ansible/inventory/local.yml` (`menos_server_name`), `roles/menos_onramp/templates/menos.caddy.j2` |
| API base includes `/api/v1` | `.dotfiles/.env.example:18`, `.dotfiles/tools/menos-youtube/list_videos.py:68-70` |
| Explicit `:443` breaks signing | `.dotfiles/tools/menos-youtube/signing.py:62` signs `@authority` from `urlparse(base).netloc`; httpx strips the default port from the Host header. Verified empirically |
| Client falls back to `.secrets` | `.dotfiles/tools/menos-youtube/api_config.py:15-21` |
| `get_api_base()` runs twice | `api_config.py:48-51` |
| Technitium DNS sync supports only FWD, A, CNAME | `homelab-infra/infra/ansible/scripts/apply-technitium-dns.py:267,289,307` |
| No DNS dry-run gate | `homelab-infra/scripts/plan-infra.sh` (tofu only), `scripts/apply-ansible-services.py`, `infra/ansible/playbooks/technitium-dns.yml` |
| Workstation suffix search list ordering | `Get-DnsClientGlobalSetting` on the primary workstation, 2026-07-27. Machine state, not repository state |

## Revision note

The 2026-07-26 revision specified DNS SRV. A seven-reviewer adversarial panel on
2026-07-27 found that the A record already existed, that every SRV-specific
capability was unused, and that the SRV machinery carried most of the plan's
defect surface including a live-mutation hazard. This revision adopts the
hostname convention instead. The DNS-over-broadcast decision is unchanged.
