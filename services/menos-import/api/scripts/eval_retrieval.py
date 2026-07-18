#!/usr/bin/env python
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "httpx",
#   "pyyaml",
#   "cryptography",
# ]
# ///
"""Snapshot-based eval harness for menos retrieval quality.

Modes:
  --capture --out <path>   Run all queries, write snapshot markdown.
  --compare <baseline>     Re-run queries, compute per-query metrics, exit 0/1.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx
import yaml

SIGNING_MODULE = Path.home() / ".claude" / "commands" / "yt" / "signing.py"
MENOS_BASE = "http://192.168.16.241:8000"
KEY_FILE = Path.home() / ".ssh" / "id_ed25519"

# Home-path patterns to blind in snippets
_HOME_PATTERNS = [
    re.compile(r"C:\\Users\\mglenn", re.IGNORECASE),
    re.compile(r"C:/Users/mglenn", re.IGNORECASE),
    re.compile(r"/Users/mglenn"),
    re.compile(r"/home/mglenn"),
]
_WS = re.compile(r"\s+")

# Regression thresholds
_THRESHOLD_J5 = 0.6
_THRESHOLD_DELTA = 0.15
_MAX_REGRESSIONS = 2


def _load_signer():
    """Load RequestSigner from the shared signing module."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("signing", SIGNING_MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.RequestSigner.from_file(KEY_FILE)


def _normalize_snippet(text: str) -> str:
    """Collapse whitespace, blind home paths, truncate to 200 chars."""
    for pat in _HOME_PATTERNS:
        text = pat.sub("~", text)
    text = _WS.sub(" ", text).strip()
    return text[:200]


def _signed_post(signer, path: str, body: dict) -> tuple[dict, float]:
    """POST to menos with RFC 9421 signing; return (response_json, latency_ms)."""
    raw = json.dumps(body).encode()
    host = MENOS_BASE.split("://", 1)[1]
    headers = signer.sign_request("POST", path, host, body=raw)
    headers["content-type"] = "application/json"

    t0 = time.perf_counter()
    # Agentic search runs LLM synthesis; Ollama may queue under load — 180s read timeout.
    timeout = httpx.Timeout(connect=5.0, read=180.0, write=10.0, pool=1.0)
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(MENOS_BASE + path, content=raw, headers=headers)
    latency_ms = (time.perf_counter() - t0) * 1000

    resp.raise_for_status()
    return resp.json(), latency_ms


def _run_search(signer, query_text: str, top_k: int = 10) -> tuple[list[dict], float]:
    """Run /api/v1/search; return (results, latency_ms)."""
    data, latency = _signed_post(
        signer,
        "/api/v1/search",
        {"query": query_text, "limit": top_k},
    )
    return data.get("results", []), latency


def _run_agentic(signer, query_text: str, top_k: int = 10) -> tuple[list[dict], float]:
    """Run /api/v1/search/agentic; return (sources, latency_ms)."""
    data, latency = _signed_post(
        signer,
        "/api/v1/search/agentic",
        {"query": query_text, "limit": top_k},
    )
    return data.get("sources", []), latency


def _sort_results(results: list[dict]) -> list[dict]:
    """Stable sort: score desc, ties broken by content_id asc."""
    return sorted(results, key=lambda r: (-round(r.get("score", 0.0), 6), r.get("id", "")))


def _result_to_row(rank: int, r: dict) -> dict:
    """Normalize a result dict into a snapshot row."""
    return {
        "rank": rank,
        "content_id": str(r.get("id", "")),
        "title": str(r.get("title") or ""),
        "score": round(float(r.get("score", 0.0)), 6),
        "snippet": _normalize_snippet(r.get("snippet") or ""),
    }


def _md_table(rows: list[dict]) -> str:
    """Render snapshot rows as a markdown table."""
    if not rows:
        return "_No results_\n"
    lines = [
        "| Rank | content_id | Title | Score | Snippet |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        title = row["title"].replace("|", "\\|")
        snippet = row["snippet"].replace("|", "\\|")
        lines.append(
            f"| {row['rank']} | {row['content_id']} | {title} | {row['score']} | {snippet} |"
        )
    return "\n".join(lines) + "\n"


def _capture_query(signer, q: dict, top_k: int = 10) -> dict:
    """Run both endpoints for one query; return structured result."""
    text = q["text"]

    search_raw, search_ms = _run_search(signer, text, top_k)
    agentic_raw, agentic_ms = _run_agentic(signer, text, top_k)

    search_rows = [_result_to_row(i + 1, r) for i, r in enumerate(_sort_results(search_raw))]
    agentic_rows = [_result_to_row(i + 1, r) for i, r in enumerate(_sort_results(agentic_raw))]

    return {
        "id": q["id"],
        "text": text,
        "category": q.get("category", ""),
        "search": {"rows": search_rows, "latency_ms": round(search_ms, 1)},
        "agentic": {"rows": agentic_rows, "latency_ms": round(agentic_ms, 1)},
    }


def _render_snapshot(results: list[dict]) -> str:
    """Render all query results as a markdown snapshot."""
    lines = ["# menos retrieval eval snapshot\n"]
    for r in results:
        lines.append(f"## {r['id']}: {r['text']}\n")
        lines.append(f"**Category:** {r['category']}\n")

        lines.append("### search\n")
        lines.append(f"_Latency: {r['search']['latency_ms']} ms_\n")
        lines.append(_md_table(r["search"]["rows"]))

        lines.append("### search/agentic\n")
        lines.append(f"_Latency: {r['agentic']['latency_ms']} ms_\n")
        lines.append(_md_table(r["agentic"]["rows"]))

    return "\n".join(lines)


def _load_queries(queries_path: Path) -> list[dict]:
    with queries_path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data["queries"]


def _empty_result() -> dict:
    return {"search": {"rows": [], "latency_ms": 0.0}, "agentic": {"rows": [], "latency_ms": 0.0}}


def cmd_capture(args) -> int:
    """Run all queries against menos and write a snapshot markdown file."""
    queries_path = _resolve_queries_path(args)
    queries = _load_queries(queries_path)
    signer = _load_signer()

    results = []
    for q in queries:
        print(f"  {q['id']} ... ", end="", flush=True)
        try:
            r = _capture_query(signer, q)
            s_ms = r["search"]["latency_ms"]
            a_ms = r["agentic"]["latency_ms"]
            s_n = len(r["search"]["rows"])
            a_n = len(r["agentic"]["rows"])
            print(f"search={s_n} agentic={a_n} ({s_ms}ms / {a_ms}ms)")
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: {exc}")
            r = {"id": q["id"], "text": q["text"], "category": q.get("category", "")}
            r.update(_empty_result())
        results.append(r)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_render_snapshot(results), encoding="utf-8")
    print(f"\nSnapshot written to {out_path}")

    zero_ids = [r["id"] for r in results if not r["search"]["rows"] and not r["agentic"]["rows"]]
    print(f"Queries with zero results: {len(zero_ids)}")
    if zero_ids:
        print("  " + ", ".join(zero_ids))
    return 0


def _is_data_row(line: str) -> bool:
    """Return True if line is a markdown table data row (not header/separator)."""
    return line.startswith("| ") and not line.startswith("| Rank") and not line.startswith("| ---")


def _parse_table_row(line: str) -> dict | None:
    """Parse one markdown table row into a result dict, or None on failure."""
    parts = [p.strip() for p in line.strip("| \n").split("|")]
    if len(parts) < 4:
        return None
    try:
        return {
            "rank": int(parts[0]),
            "content_id": parts[1],
            "title": parts[2],
            "score": float(parts[3]),
            "snippet": parts[4] if len(parts) > 4 else "",
        }
    except (ValueError, IndexError):
        return None


def _parse_section_rows(lines: list[str]) -> dict[str, list[dict]]:
    """Extract search and agentic result rows from a query section's lines."""
    result: dict[str, list[dict]] = {"search": [], "agentic": []}
    current_ep = None
    for line in lines:
        if line.startswith("### search/agentic"):
            current_ep = "agentic"
        elif line.startswith("### search"):
            current_ep = "search"
        elif current_ep and _is_data_row(line):
            row = _parse_table_row(line)
            if row:
                result[current_ep].append(row)
    return result


def _parse_snapshot(md_path: Path) -> dict[str, dict]:
    """Parse snapshot markdown back into a structured dict keyed by query_id."""
    text = md_path.read_text(encoding="utf-8")
    sections = re.split(r"^## ", text, flags=re.MULTILINE)
    snapshot: dict[str, dict] = {}

    for section in sections[1:]:  # skip preamble
        lines = section.split("\n")
        match = re.match(r"^([\w-]+): (.+)$", lines[0].strip())
        if not match:
            continue
        qid = match.group(1)
        snapshot[qid] = _parse_section_rows(lines[1:])

    return snapshot


def _jaccard(set_a: set, set_b: set) -> float:
    union = set_a | set_b
    if not union:
        return 1.0
    return len(set_a & set_b) / len(union)


def _count_concordant_discordant(
    shared: list[str], b_rank: dict[str, int], l_rank: dict[str, int]
) -> tuple[int, int]:
    """Count concordant and discordant pairs for Kendall tau."""
    concordant = discordant = 0
    for i in range(len(shared)):
        for j in range(i + 1, len(shared)):
            a, b = shared[i], shared[j]
            product = (b_rank[a] - b_rank[b]) * (l_rank[a] - l_rank[b])
            if product > 0:
                concordant += 1
            elif product < 0:
                discordant += 1
    return concordant, discordant


def _tau_from_ranks(shared: list[str], b_rank: dict, l_rank: dict) -> float:
    """Compute Kendall tau score from pre-built rank dicts."""
    concordant, discordant = _count_concordant_discordant(shared, b_rank, l_rank)
    total = concordant + discordant
    return 1.0 if total == 0 else (concordant - discordant) / total


def _kendall_tau_top5(baseline_ids: list[str], live_ids: list[str]) -> float:
    """Kendall tau on items present in both top-5 lists."""
    live_set = set(live_ids[:5])
    shared = [x for x in baseline_ids[:5] if x in live_set]
    if len(shared) < 2:
        return 1.0
    b_rank = {cid: i for i, cid in enumerate(baseline_ids[:5]) if cid in shared}
    l_rank = {cid: i for i, cid in enumerate(live_ids[:5]) if cid in shared}
    return _tau_from_ranks(shared, b_rank, l_rank)


def _compare_endpoint(baseline_rows: list[dict], live_rows: list[dict]) -> dict:
    """Compute per-endpoint metrics between baseline and live result rows."""
    b_ids = [r["content_id"] for r in baseline_rows]
    l_ids = [r["content_id"] for r in live_rows]

    b_top1 = baseline_rows[0]["score"] if baseline_rows else 0.0
    l_top1 = live_rows[0]["score"] if live_rows else 0.0

    return {
        "jaccard_5": round(_jaccard(set(b_ids[:5]), set(l_ids[:5])), 4),
        "jaccard_10": round(_jaccard(set(b_ids[:10]), set(l_ids[:10])), 4),
        "top1_delta": round(abs(l_top1 - b_top1), 4),
        "kendall_tau_5": round(_kendall_tau_top5(b_ids, l_ids), 4),
    }


def _query_regressed(s: dict, a: dict) -> bool:
    """True if either endpoint exceeds the regression thresholds."""
    return (
        s["jaccard_5"] < _THRESHOLD_J5
        or s["top1_delta"] > _THRESHOLD_DELTA
        or a["jaccard_5"] < _THRESHOLD_J5
        or a["top1_delta"] > _THRESHOLD_DELTA
    )


def _print_query_metrics(qid: str, s: dict, a: dict, regressed: bool) -> None:
    flag = " [REGRESSION]" if regressed else ""
    print(
        f"  {qid}: "
        f"search J@5={s['jaccard_5']:.2f} J@10={s['jaccard_10']:.2f} "
        f"d1={s['top1_delta']:.3f} τ={s['kendall_tau_5']:.2f} | "
        f"agentic J@5={a['jaccard_5']:.2f} J@10={a['jaccard_10']:.2f} "
        f"d1={a['top1_delta']:.3f} τ={a['kendall_tau_5']:.2f}"
        f"{flag}"
    )


def cmd_compare(args) -> int:
    """Compare live menos against a frozen baseline snapshot."""
    baseline_path = Path(args.compare)
    if not baseline_path.exists():
        print(f"ERROR: baseline not found: {baseline_path}", file=sys.stderr)
        return 2

    queries_path = _resolve_queries_path(args)
    queries = _load_queries(queries_path)
    signer = _load_signer()
    baseline = _parse_snapshot(baseline_path)

    print(f"Comparing against baseline: {baseline_path}")
    print(f"Running {len(queries)} queries...\n")

    regressions = []
    evaluated = 0

    for q in queries:
        try:
            live = _capture_query(signer, q)
        except Exception as exc:  # noqa: BLE001
            print(f"  {q['id']}: ERROR: {exc}")
            continue

        b = baseline.get(q["id"], {"search": [], "agentic": []})
        s_m = _compare_endpoint(b["search"], live["search"]["rows"])
        a_m = _compare_endpoint(b["agentic"], live["agentic"]["rows"])
        regressed = _query_regressed(s_m, a_m)

        _print_query_metrics(q["id"], s_m, a_m, regressed)
        evaluated += 1
        if regressed:
            regressions.append(q["id"])

    n_stable = evaluated - len(regressions)
    verdict = "PASS" if len(regressions) <= _MAX_REGRESSIONS else "FAIL"
    print(f"\n{verdict}: {n_stable}/{evaluated} queries stable")

    if regressions:
        print(f"Regressed queries ({len(regressions)}): {', '.join(regressions)}")

    return 0 if len(regressions) <= _MAX_REGRESSIONS else 1


def _resolve_queries_path(args) -> Path:
    """Resolve eval-queries.yaml: explicit arg or auto-detect from script location."""
    if getattr(args, "queries", None):
        return Path(args.queries)
    spec_dir = Path(__file__).parent.parent / ".specs" / "menos-knowledge-compiler"
    return spec_dir / "eval-queries.yaml"


def main() -> int:
    parser = argparse.ArgumentParser(description="menos retrieval eval harness")
    parser.add_argument("--capture", action="store_true", help="Capture snapshot mode")
    parser.add_argument("--out", help="Output path (required with --capture)")
    parser.add_argument("--compare", metavar="<baseline>", help="Compare against baseline")
    parser.add_argument("--queries", help="Path to eval-queries.yaml (auto-detected if omitted)")
    args = parser.parse_args()

    if args.capture:
        if not args.out:
            parser.error("--out is required with --capture")
        return cmd_capture(args)
    if args.compare:
        return cmd_compare(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
