# Menos cutover notes

## C1 - Fresh export

- Snapshot: `20260719T223202Z`
- Legacy deployment path: `<legacy-deploy-path>`
- Quiesce started: `2026-07-19T22:32:06Z`
- Quiesce ended: `2026-07-19T22:33:06Z`
- Legacy API source revision: `864a84d0f516554cc18302b788ed2d5b8898b311`
- SurrealDB export SHA256: `2b2e53b68efa0700516ad9536136895f684c29e5812ce47e8f2a7de0716a9e0f`
- Transfer archive SHA256: `3ab6c76f6dd708a05ffb0bfd6c8b608e56cd67cf50b5ab03af3026b1bcd9b772`
- Snapshot and controller-staging checksum verification: passed
- Legacy API restart and `/health`: passed
- Legacy Ollama recovery: running CPU-only with `mxbai-embed-large`; all three parity queries returned results

Record counts:

| Table | Count |
| --- | ---: |
| `content` | 1,337 |
| `chunk` | 45,932 |
| `link` | 0 |
| `content_entity` | 253 |
| `entity` | 209 |
| `pipeline_job` | 29 |
| `llm_usage` | 0 |
| `tag_alias` | 6 |

Object-storage inventory:

- Objects: 3,967
- Bytes: 28,897,635
- Sorted key-list SHA256: `d71cabe8e4dd7404aebe663ab892fc90c54897575d106e909bc90455dd448673`

Authorization decision:

- The legacy file has five unique public-key fingerprints.
- The new stack retains only its one explicitly approved managed principal.
- C2 must not copy or merge the other legacy public keys.

Vector index:

- `idx_chunk_embedding`
- `MTREE DIMENSION 1024 DIST COSINE`

Rollback boundary: the legacy stack is running and remains authoritative. The snapshot can be abandoned without changing consumers.
