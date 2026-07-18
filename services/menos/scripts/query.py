#!/usr/bin/env python
"""Run SurrealQL queries against the menos database."""

import argparse
import asyncio
import json
import sys

from surrealdb import Surreal

from menos.config import settings

DANGEROUS_PREFIXES = ("DELETE", "UPDATE", "CREATE", "REMOVE", "DEFINE")


def _stringify_record_ids(row: dict) -> dict:
    """Convert RecordID values in a row dict to strings."""
    return {k: str(v.id) if hasattr(v, "id") else v for k, v in row.items()}


def parse_results(result):
    """Parse SurrealDB v2 query results into a flat list of dicts."""
    if not result or not isinstance(result, list) or len(result) == 0:
        return []
    first = result[0]
    raw_items = first["result"] if isinstance(first, dict) and "result" in first else result
    return [_stringify_record_ids(dict(item)) for item in raw_items]


def _collect_columns(rows: list) -> list:
    """Return ordered unique column names from all rows."""
    seen: set = set()
    columns = []
    for row in rows:
        for key in row:
            if key not in seen:
                columns.append(key)
                seen.add(key)
    return columns


def _compute_widths(columns: list, rows: list) -> dict:
    """Compute per-column display widths (capped at 80)."""
    widths = {}
    for col in columns:
        values = [str(row.get(col, "")) for row in rows]
        widths[col] = min(max(len(col), max((len(v) for v in values), default=0)), 80)
    return widths


def format_table(rows):
    """Format rows as an aligned text table."""
    if not rows:
        print("(no results)")
        return

    columns = _collect_columns(rows)
    widths = _compute_widths(columns, rows)

    print("  ".join(col.ljust(widths[col]) for col in columns))
    print("  ".join("-" * widths[col] for col in columns))
    for row in rows:
        line = "  ".join(str(row.get(col, "")).ljust(widths[col])[: widths[col]] for col in columns)
        print(line)
    print(f"\n({len(rows)} row{'s' if len(rows) != 1 else ''})")


async def run_query(query: str, output_json: bool = False, db_url: str | None = None):
    """Execute a SurrealQL query and print results."""
    # Safety check: reject write operations
    stripped = query.strip().upper()
    for prefix in DANGEROUS_PREFIXES:
        if stripped.startswith(prefix):
            print(f"Error: {prefix} queries are not allowed (read-only mode)", file=sys.stderr)
            sys.exit(1)

    url = db_url or settings.surrealdb_url.replace("ws://", "http://").replace("wss://", "https://")
    db = Surreal(url)
    db.signin({"username": settings.surrealdb_user, "password": settings.surrealdb_password})
    db.use(settings.surrealdb_namespace, settings.surrealdb_database)

    result = db.query(query)
    rows = parse_results(result)

    if output_json:
        print(json.dumps(rows, indent=2, default=str))
    else:
        format_table(rows)


def main():
    parser = argparse.ArgumentParser(description="Run SurrealQL queries against menos database")
    parser.add_argument("query", help="SurrealQL query string")
    parser.add_argument("--json", action="store_true", dest="output_json", help="Output raw JSON")
    parser.add_argument("--db-url", default=None, help="SurrealDB URL override")
    args = parser.parse_args()

    asyncio.run(run_query(args.query, args.output_json, args.db_url))


if __name__ == "__main__":
    main()
