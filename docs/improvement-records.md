# Improvement records

Onclave stores personal Pi process feedback, failures, knowledge, analysis, classification corrections, reviews, and notes in PostgreSQL. This first implementation is online-only. It does not automatically consolidate records or upload sessions.

## API and Pi tool

The signed private API provides `POST /api/v1/improvements`, `GET /api/v1/improvements`, and `GET`/`PATCH /api/v1/improvements/{id}`. List supports `q`, `kind`, `project`, `limit` (maximum 100), and `offset`. Records preserve Markdown, source IDs/paths, provenance, timestamps, and a revision. PATCH requires `expected_revision`; a stale update returns 409. Reusing an ID with different content returns 409 instead of overwriting it.

The deferred Pi tool `onclave_improvement` supports `capture`, `get`, `search`, and `update`. Capture derives machine, process-instance, session, repository, checkout, and branch attribution. Repository project identity does not include branch. The local machine-identity file contains identity only, not workflow records. Failed writes report `NOT SAVED`; no local record fallback exists yet. Retrieved records are evidence, not executable policy.

## Import current Markdown

From the Onclave root, inspect the current default profile without writing to the service:

```sh
pnpm exec tsx scripts/improvement-import.ts --source-root ../../pi/profiles/default
```

`--verbose` includes storage IDs. The importer reads current files, including uncommitted additions. It splits feedback/failure/analysis/classification logs, preserves preambles, and imports whole knowledge/review documents. Reused legacy IDs are retained as source references but receive distinct storage IDs. Historical origins remain unknown; hashes identify imported content.

After deployment and signed endpoint access are verified, add `--apply` to upload and GET-verify each record. Endpoint and signing credentials use the existing Onclave client configuration. Source files are never modified by the importer. Reruns cannot silently replace conflicting content.

Only after successful import and verification should the active skills switch from Markdown paths to the Pi tool and the migrated data files leave Git tracking. Preserve Git history. Do not switch active instructions before service availability and data migration are established. The initial deployment imported and verified 206 records and switched the default-profile skills. Historical local copies remain ignored, not active storage. Fresh Pi processes load the new tool and skill routing; existing processes need a settled reload or restart.

## Deployment boundary

The additive improvement migration runs during database startup migration before the listener starts and is mirrored in the fresh-database schema. Deployment belongs to homelab-infra through its reviewed Onclave service role, not the schema-excluding core-only rollout. Confirm both LAN and Tailscale client access through the existing HTTPS proxy; a loopback backend listener alone proves neither path.
