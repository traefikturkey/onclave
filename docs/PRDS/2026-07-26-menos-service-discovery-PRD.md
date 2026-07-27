# PRD: menos Service Discovery via DNS SRV

Parent PRD: [Homelab Platform Architecture](2026-07-26-homelab-platform-architecture-PRD.md)

Status: draft, 2026-07-26.

## Purpose

A Pi instance should find menos without being configured with its address.

## Decision

Publish one DNS SRV record and have the menos client resolve it.

```text
_menos._tcp.<domain>.  300  IN  SRV  0 0 443 menos.<domain>.
```

Client resolution:

1. If `MENOS_API_BASE` is set, use it and stop.
2. SRV lookup for the fully qualified `_menos._tcp.<domain>.`
3. Build `https://<target>:<port>/api/v1`.
4. On lookup failure, raise an error naming both the query attempted and
   `MENOS_API_BASE`.

Two details that are not obvious and that a naive implementation gets wrong:

**The API base includes a path.** `.dotfiles/.env.example:18` documents
`MENOS_API_BASE=https://menos.example.net/api/v1`, and
`.dotfiles/tools/menos-youtube/list_videos.py:68-70` signs the path
`/api/v1/content` while requesting `{api_base}/content`. A discovered base
without `/api/v1` would request `/content` while the RFC 9421 signature covers
`/api/v1/content`, and every request would fail signature verification even
though DNS succeeded. The client appends `/api/v1` as a constant. It is a
property of the menos API version, not of the deployment, so it does not belong
in DNS.

**Query the fully qualified name, do not rely on the search suffix.** The
primary workstation's global DNS suffix search list contains four entries: two
employer domains, the tailnet domain, and the homelab domain, in that order. A
bare `_menos._tcp` lookup would be tried against the employer domains first,
sending queries for an internal service name to employer DNS servers before
reaching the right suffix. The client therefore needs the domain as an explicit
value rather than an inherited one.

Scheme is convention: port 443 means https.

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

The change replaces the raise with an SRV lookup and keeps the raise as the
final fallback when that also fails. `MENOS_API_BASE` stays the override and
keeps precedence, so existing setups are unaffected.

Note this puts the client-side work in the `.dotfiles` repo, not in `onclave`,
even though this PRD lives with menos.

### Dependency

Python's standard library cannot perform SRV lookups; `socket.getaddrinfo`
resolves A and AAAA only. `dnspython` is not currently present in
`.dotfiles/tools/menos-youtube/pyproject.toml:6-11`, whose dependencies are
`youtube-transcript-api`, `google-api-python-client`, `httpx`, and
`cryptography`.

Options:

- Add `dnspython` to that `pyproject.toml`. One pure-Python dependency, works
  the same on Windows, Git Bash, WSL, Linux, and macOS.
- Shell out to `nslookup -type=SRV` or `dig SRV`. No dependency, but the output
  format and tool availability differ across the platforms this repo supports.

`dnspython` is the recommended option given the cross-platform requirement.

## Why DNS and not gossip

The original idea was a UDP broadcast where a Pi instance asks and menos
answers. It was rejected because it is subnet-bound by construction and the
client runs on a laptop that leaves the subnet.

DNS keeps working away from home. The workstation's tailnet interface carries
the tailnet domain, the homelab domain is in the machine's global suffix search
list rather than being bound to the Ethernet interface, and the operator's
existing Tailscale configuration already resolves homelab names over the
tailnet. Broadcast could never do this.

Two supporting points, stated at the strength the evidence supports:

- Every `*_vlan_id` in `homelab-infra` private `values/terraform.tfvars` is
  currently `null` and managed hosts are configured within a single `/24`. That
  removes topology as an objection to broadcast on the managed hosts. It does
  not establish that every relevant client shares one broadcast domain, since
  workstation firewalls, wireless isolation, VPN interfaces, and container
  networking all affect this and none were tested.
- `joyride/plugins/docker-cluster/discovery.go:14-23,109-143` implements
  broadcast peer discovery between joyride nodes. That is peer discovery among
  equals, not client-to-service discovery, so it demonstrates familiarity with
  the technique rather than a working precedent for this use case. Gossip is the
  right tool for peers with no authority; DNS is the right tool when there is an
  authority, which here is Technitium.

## Scope

In scope:

- SRV record support in `homelab-infra`'s DNS sync tooling. Decided 2026-07-27:
  extend the script rather than place the record by hand. A hand-placed record
  in an otherwise declarative DNS setup exists nowhere in git and will not
  survive review or rebuild.
- One SRV record declared in the DNS records file.
- SRV resolution in the menos client, with `MENOS_API_BASE` override.
- An actionable error on resolution failure.

### Tooling change

`homelab-infra/infra/ansible/scripts/apply-technitium-dns.py` currently supports
three record types: `FWD` at line 267, `A` at 289, and `CNAME` at 307. There is
no SRV path.

The records file uses type-specific top-level keys rather than a generic record
list. `scaffold/dns-records.local.json` has `settings`, `zones`, `a_records`,
and CNAME equivalents, where `a_records` maps a name directly to an address
string.

SRV cannot reuse that shape, because a record carries priority, weight, port,
and target rather than a single value. Keeping the existing convention of a map
keyed by fully qualified name, the addition is:

```json
"srv_records": {
  "_menos._tcp.example.internal": {
    "priority": 0,
    "weight": 0,
    "port": 443,
    "target": "menos.example.internal"
  }
}
```

Work required:

- a `srv_records` key whose values are objects rather than strings;
- an ensure function following the existing `A` and `CNAME` pattern, including
  the `record_matches` idempotency check at line 213. Note that check compares a
  single field, so SRV needs it extended to compare four;
- validation that rejects malformed entries rather than passing them to the API.

The four object keys map one-to-one onto the Technitium API parameters, so no
translation layer is needed. See Zone behavior below for the API contract.

This is modest and localized, but it is real work and roughly doubles the size
of this PRD compared with the record-only version.

Out of scope:

- Tailscale and tailnet routing. The operator runs a separate Tailscale instance
  outside this work; the `tailscale_client` LXC in `homelab-infra` is declared
  with `tailscale_client_enabled = false` and is not being configured here.
- Backup and restore for menos or any other component. Deferred until the stack
  stabilizes.
- Storage architecture.
- Telemetry transport. Telemetry will exist; how it ships is an open question.
- A general service registry with health, tags, or liveness.
- Changes to joyride.

## Zone behavior: resolved

**Locally declared records inside a Forwarder zone are served locally.** In
Technitium forwarder zones, a request is forwarded to the server named in the
FWD record only when no matching record exists in the zone. Adding a record to
the zone therefore answers it directly, and everything else keeps forwarding to
joyride.

This matches what the repository already does: `apply-technitium-dns.py:244`
creates zones with `{"type": "Forwarder"}` and then adds `A` and `CNAME`
records into them, which works in production today. SRV is the same mechanism
with a different record type.

**SRV is supported by the Technitium API.** `/api/zones/records/add` accepts
`type=SRV` with four parameters beyond the common ones:

| Parameter | Meaning |
|---|---|
| `priority` | Lower is tried first |
| `weight` | Share of traffic among equal-priority targets |
| `port` | Service port |
| `target` | Hostname providing the service |

The API takes a fully qualified `domain` plus a separate `zone`, which is the
shape `apply-technitium-dns.py:208` already uses. That convention needs no
change.

**Do not create a more specific Primary zone.** An earlier draft proposed a
Primary zone for `_menos._tcp.<domain>` as a fallback if records in a Forwarder
zone were not served. That is wrong and would break forwarding: a Primary zone
is authoritative and answers NXDOMAIN for names it does not hold rather than
falling through. Technitium's guidance is to keep one conditional forwarder zone
per domain and add records to it.

Nothing blocks implementation. One live confirmation is still cheap and worth
doing before writing the client:

```text
dig SRV _test._tcp.<domain> @<technitium-address>
```

Sources: [Technitium help](https://technitium.com/dns/help.html),
[DnsServer discussion #818](https://github.com/TechnitiumSoftware/DnsServer/discussions/818),
[Technitium API docs](https://github.com/TechnitiumSoftware/DnsServer/blob/master/APIDOCS.md).

## Acceptance criteria

1. A client with no menos configuration resolves menos and completes a signed
   API call.
   - Verify: unset `MENOS_API_BASE` in the environment, and confirm it is absent
     from **both** `~/.dotfiles/.env` and `~/.dotfiles/.secrets`. Then run
     `/yt list` and observe a successful request.
   - `api_config.py:15-21` falls back to `.secrets` when `.env` is absent, so
     clearing only `.env` does not produce an unconfigured client and the test
     would pass without exercising discovery at all.
   - This criterion exercises RFC 9421 signing, not just DNS. A discovered base
     missing `/api/v1` resolves correctly and still fails here, which is the
     point.
2. `MENOS_API_BASE` overrides discovery.
   - Verify: set it to a deliberately wrong value, confirm the client uses it and
     fails there rather than falling back to SRV.
3. Discovery failure is actionable.
   - Verify: query a domain with no SRV record; the error names the query
     attempted and `MENOS_API_BASE`.
   - The existing message at `api_config.py:42-44` names only the variable. It
     does not satisfy this criterion and must be extended.
4. The DNS tooling change is idempotent.
   - Verify: run the Technitium sync twice against an unchanged records file and
     confirm the second run reports no changes, matching the behavior of the
     existing `A` and `CNAME` paths.

## Later, not now

If more services need discovery, joyride emitting SRV from Docker labels is the
natural path, since its gossip already replicates the record store. That would
first require record lifecycle handling, because a stale SRV is worse than a
stale A record. Two known gaps:

- `joyride/plugins/docker-cluster/delegate.go:74-115` - `FullState` carries no
  tombstones, so a dropped remove can never converge. Anti-entropy only
  exchanges records that exist.
- Records are not reaped when the publishing node fails; membership failure does
  not remove what that node published.

Neither matters for a static record.

## Cleanup to fold into the plan

Not built here, recorded so the implementation plan can pick it up:

- `homelab-infra` private `values/` holds roughly 2.42 GiB of backup tarballs in
  git history across 101 tracked files. Largest single blob is a 1.1 GB Forgejo
  state archive; there are also several 92-98 MB Hermes state archives including
  near-duplicates. On-disk `values/` is 8.7 GB, mostly `migration-staging/`
  (3.4 G) and `service-backups/` (1.8 G).
- Decision taken: stop the growth, leave the existing packfile alone. No history
  rewrite.

## Sources

Repository facts in this document were read directly during the 2026-07-26
session. Paths are given relative to each repository root.

| Claim | Source |
|---|---|
| Broadcast discovery exists in joyride | `joyride/plugins/docker-cluster/discovery.go:14-23,109-143` |
| Gossip is `hashicorp/memberlist` v0.5.4, not Serf | `joyride/go.mod:8-10`, `joyride/plugins/docker-cluster/cluster.go:8-10` |
| Gossip payload is A-record only | `joyride/plugins/docker-cluster/message.go:17-26` |
| Nodes advertise no metadata | `joyride/plugins/docker-cluster/delegate.go:42-45` |
| No tombstones in full-state sync | `joyride/plugins/docker-cluster/delegate.go:74-115` |
| Three-node gossip test harness exists | `joyride/docker-compose.cluster-test.yml` (`coredns-node1..3`) |
| Cluster-test healthchecks target the wrong port | `joyride/docker-compose.cluster-test.yml:29,54,82` use `:8080`; `joyride/Corefile.cluster:39` serves `health :5454`. Unrelated latent bug, not fixed here |
| Flat network, no VLANs in use | `homelab-infra` private `values/terraform.tfvars`, all `*_vlan_id = null` |
| Tailscale client declared but disabled | `homelab-infra` private `values/terraform.tfvars:67` |
| menos exposed via shared Caddy on the onramp host | `homelab-infra/infra/ansible/roles/menos_onramp/tasks/main.yml:262-277` and `roles/menos_onramp/templates/menos.caddy.j2:1-9` (implementation, more durable than the prose contract, whose line numbers shifted during the 2026-07-26 reconciliation) |
| menos app definition and services | `onclave/deploy/app/menos/compose.yaml` |
| `MENOS_API_BASE` is the existing convention and is currently required | `.dotfiles/tools/menos-youtube/api_config.py:37-45` |
| `MENOS_BASE` in `eval_retrieval.py:28` is a module constant with a placeholder IP, not an env var | `onclave/services/menos/scripts/eval_retrieval.py:28` |
| Workstation DNS suffix search list contains the homelab domain globally, plus the tailnet domain on the Tailscale interface | `Get-DnsClientGlobalSetting` and `Get-DnsClient` on the primary workstation, 2026-07-27. This is machine state, not repository state, and is not guaranteed on another machine |
| Technitium DNS sync supports only FWD, A, and CNAME | `homelab-infra/infra/ansible/scripts/apply-technitium-dns.py:267,289,307` |
| Forwarder zones serve locally declared records and forward only unmatched names | Technitium documentation and maintainer guidance, retrieved 2026-07-27: [help](https://technitium.com/dns/help.html), [discussion #818](https://github.com/TechnitiumSoftware/DnsServer/discussions/818). Corroborated by this repo already adding A and CNAME records into Forwarder zones in production |
| Technitium API accepts `type=SRV` with `priority`, `weight`, `port`, `target` | [Technitium APIDOCS.md](https://github.com/TechnitiumSoftware/DnsServer/blob/master/APIDOCS.md), retrieved 2026-07-27 |
| A more specific Primary zone is the wrong fallback; it answers NXDOMAIN rather than falling through | Same Technitium sources. This corrects an earlier draft of this document |
| Homelab zones are Forwarder zones pointing at joyride | `apply-technitium-dns.py:244` and the `zones` map in `scaffold/dns-records.local.json` |
| API base includes the `/api/v1` path | `.dotfiles/.env.example:18`, `.dotfiles/tools/menos-youtube/list_videos.py:68-70` |
| Client falls back to `.secrets` when `.env` is absent | `.dotfiles/tools/menos-youtube/api_config.py:15-21` |
| values/ size and largest blobs | `git count-objects -vH` and `git rev-list --objects --all` in `homelab-infra/values` |

Related decisions from the same session, recorded outside this document:

- Service roles: `homelab-infra` provisions all Proxmox guests; `onramp-vNext`
  is the service catalog; `onclave` is the AI incubator with a promotion path
  into the vNext catalog. The substrate-versus-app half of this was already in
  `homelab-infra/docs/onramp-app-platform-contract.md` and had not been acted
  on. The provisioning, catalog, and secret-backend halves were added to that
  document during the 2026-07-26 session and are uncommitted, so treat them as
  new rather than as prior art.
- Secrets: Bitwarden Secrets Manager is the only secret source in use. Infisical
  remains a deployed service but is not a secret source. A provider interface is
  future work. Services declare required secret names rather than their
  location.
- Ingress: Caddy is the target; the Traefik-labeled service corpus in the
  original `onramp` repo is ported after the stack stabilizes, not now. Roughly
  280 definitions sit at the top level of `services-available/`, but the count
  is unstable across the repository's own documentation and should be measured
  rather than quoted.
