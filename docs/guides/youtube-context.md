# YouTube context contract

This guide defines the shared contract for whole-video transcript context. The
contract is additive. Existing content records with only `summary` and the
original transcript object remain readable.

## Transcript representations

A stored YouTube item may expose three related representations:

- `original` is the unmodified source. It preserves the source text and, when
  available, the original caption segment boundaries and video timestamps.
- `timed` is a timestamped view of the original source. It is available only
  when every retained source segment has reliable start and duration values.
- `analysis` is the retained source used for model analysis, new embeddings,
  and default whole-transcript retrieval. Its segments retain source segment
  IDs and original timestamps when timing is available.

Untimed supplied text remains valid. It is marked `timing: "unavailable"` and
must not receive invented timestamps. A filtering operation that removes every
segment returns an empty `analysis` text and does not restore original text to
fill a request.

The original artifact remains the compatibility object. Analysis consumers must
select the `analysis` artifact explicitly through the resolver or download
variant contract. The raw HTTP download keeps its historical default of
`variant: "original"`; a model-facing whole-transcript consumer defaults to
analysis and must request original explicitly.

## SponsorBlock lookup and filtering provenance

SponsorBlock is best effort and is consulted only by a whole-transcript access
when compatible stored information is missing or an eligible successful empty
result has expired. Metadata, summary, outline, list, and search-snippet reads
do not trigger a lookup. A failed lookup is not a negative match and may be
retried by a later eligible whole-transcript access.

The stored `sponsorblock` state is separate from the transcript `filtering`
outcome:

- `matched` records exact video matches, `sponsor` category, `skip` action,
  interval IDs, and validated original-video intervals.
- `empty` records a successful no-match lookup and its negative-cache
  timestamps.
- `unavailable` records that the service could not provide a result. It does
  not claim that the video has no advertisements.
- Filtering additionally reports `incompatible_intervals` and
  `timing_unavailable` when a lookup exists but cannot safely remove caption
  segments.

A successful empty lookup stores `publication_date`, `looked_up_at`, and
`retry_eligible_at`. The retry time is 24 hours after lookup for a video younger
than seven days or with unknown publication time, and 30 days for a video at
least seven days old. The age is evaluated at lookup time, not when the next
read occurs. Rechecking happens only during a later eligible whole-transcript
access. Positive matches are reused without a periodic refresh policy.

Only intervals wholly containing a caption segment remove that segment. Partial
overlap is retained because caption boundaries are not word timing. Original
text and timestamps are never mutated. The filtering contract records counts,
removed source segment IDs, interval IDs, lookup state, timing, and the
conservative boundary policy.

SponsorBlock data is attributed to SponsorBlock at
`https://sponsor.ajay.app/` under CC BY-NC-SA 4.0. This attribution and license
constraint applies to retained provenance. Commercial use requires separate
permission and is outside this contract.

## Analysis result contract

New whole-video analysis stores one canonical `structured_summary`:

```json
{
  "version": 1,
  "overview": "A concise overview.",
  "key_points": ["A mechanism", "A demonstrated result"]
}
```

The scalar `summary` is derived from this object as the overview followed by
blank-line-separated `- ` key points. A supplied scalar is not an independent
second authoring result. Old scalar-only records remain readable and have
unknown or legacy coverage rather than retroactively being labelled filtered.

`outline` is a separate versioned object:

```json
{
  "version": 1,
  "sections": [
    {
      "heading": "Experiment",
      "description": "The speaker compares two approaches.",
      "source": {
        "segment_ids": ["segment-12", "segment-13"],
        "start_seconds": 615,
        "end_seconds": 742
      }
    }
  ]
}
```

Source times and ranges are in original-video seconds. The `source` member is
omitted when reliable timing is unavailable. An outline is navigation, not a
record of removed sponsor intervals.

`summary_coverage` reports whether a result covered all retained source:

- `full` requires analysis-source counts and a generation method of
  `single_call`, `map_reduce`, or `no_retained_content`.
- `partial` reports incomplete current coverage.
- `legacy` identifies historical output whose source boundaries are not known.
- `unknown` is used when no reliable coverage claim can be made.

Full means every retained source unit entered analysis. It does not claim that
an output repeats every fact. Current transcript provenance and historical
summary, outline, and embedding-index provenance are separate metadata. A lazy
filter refresh does not regenerate old summaries or indexes.

The content detail route exposes `structured_summary`, `outline`,
`summary_coverage`, and concise `filtering` state additively. It reads stored
metadata only and never performs SponsorBlock lookup or materializes a missing
analysis object. Legacy scalar-only summaries are reported with
`summary_coverage.status: "legacy"`; legacy transcript filtering is reported as
`not_attempted` with `reason: "legacy_unknown"` and unknown segment counts.

## Pi content projection contract

The adapter's single-item `get` operation is a model-context projection, not a
new service read. Its compact default includes identity, title/type/status, the
legacy-compatible scalar `summary` (derived from `structured_summary` when
available), concise `summary_coverage` and `filtering`, tags and pipeline tags,
topics/entities, and useful YouTube metadata such as resource key, video ID,
channel, publication date, and duration. It omits the outline, canonical
`structured_summary`, raw `metadata.unified_result`, private `file_path`, and
other diagnostic/storage details by default.

`fields` accepts documented top-level names or dotted `metadata.*` paths and
returns only those present values in deterministic order. For example:

```json
{"fields":["title"]}
{"fields":["summary","outline","summary_coverage"]}
{"fields":["metadata.transcript_analysis.filtering"]}
```

`full: true` returns the existing tool-visible record, including additive fields,
but never private storage credentials or `file_path`; `fields` and `full` cannot
be combined. Projection never downloads a transcript and never authorizes a
SponsorBlock lookup. The outline is therefore explicitly requested navigation,
not hidden transcript context.

## Terminal callback contract

`onclave.job.terminal.v1` remains a protocol-v3, one-way notification. Its
optional `title`, scalar `summary`, `summary_coverage` status/method, and
concise `filtering` state are sufficient for a routine completion/failure report
when present. It does not include a transcript, outline, or duplicate canonical
summary. Pi reports the callback directly, does not reply through
`onclave_message`, and does not poll or fetch content merely to repeat it. Older
callbacks without these optional fields remain valid; content is fetched only
when the requested report needs missing detail.

## Download and resolver contract

`TranscriptDownloadVariant` is either `original` or `analysis`. The raw HTTP
`GET /api/v1/content/{content_id}/download` keeps its historical default of
`variant=original`; callers request the model-facing representation explicitly
with `?variant=analysis`. The response remains the raw transcript text, with
these additive headers identifying what was served:

- `x-transcript-variant` is `original` or `analysis`.
- `x-transcript-object-key` is the selected stored object key. When available,
  `x-transcript-object-sha256` identifies its content digest.
- `x-transcript-filtering` is a compact JSON object containing `outcome`,
  `reason`, `lookup_state`, `timing`, `retained_segment_count`, and
  `excluded_segment_count`.

Artifact metadata includes the object key, media type, byte length, checksum
when available, creation time, and source representation. The typed client
preserves the raw response and accepts `{ variant: "analysis" }` options;
omitting the option preserves the original default.

All whole-transcript consumers use the same `WholeTranscriptResolver`:

```ts
resolve({
  content_id,
  variant: "analysis",
  access: "download" // ingest, process, reprocess, embedding_reindex, download
})
```

The resolver returns one selected transcript representation, its artifact,
current transcript provenance, SponsorBlock lookup state when present, and
filtering provenance. It may lazily persist a missing analysis view during an
eligible access. Resolving a transcript does not authorize an LLM call, summary
regeneration, or replacement of historical embeddings.
