#!/usr/bin/env python3
"""Run a read-only SQL query against the Menos PostgreSQL database."""

import argparse
import json

from menos.config import settings
from menos.services.database import PostgresDatabase


def get_database() -> PostgresDatabase:
    return PostgresDatabase(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_database,
        user=settings.postgres_user,
        password=settings.postgres_password,
        min_size=1,
        max_size=1,
    )


def _is_read_only(statement: str) -> bool:
    normalized = statement.lstrip().lower()
    return normalized.startswith(("select ", "with ", "explain "))


def run_query(statement: str, output_json: bool = False) -> list[dict]:
    if not _is_read_only(statement):
        raise ValueError("only SELECT, WITH, and EXPLAIN statements are allowed")
    database = get_database()
    database.open()
    try:
        rows = database.fetch_all(statement)
    finally:
        database.close()
    if output_json:
        print(json.dumps(rows, default=str, indent=2))
    else:
        for row in rows:
            print(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a read-only PostgreSQL query")
    parser.add_argument("query", help="SQL SELECT, WITH, or EXPLAIN statement")
    parser.add_argument("--json", action="store_true", dest="output_json")
    args = parser.parse_args()
    run_query(args.query, args.output_json)


if __name__ == "__main__":
    main()
