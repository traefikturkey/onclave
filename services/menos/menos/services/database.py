"""PostgreSQL connection and query primitives."""

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Any

from psycopg import Connection, sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class PostgresDatabase:
    """Small connection-pool wrapper kept private to repositories."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        database: str,
        user: str,
        password: str,
        **pool_options: int,
    ) -> None:
        conninfo = make_conninfo(
            host=host,
            port=port,
            dbname=database,
            user=user,
            password=password,
            connect_timeout=10,
        )
        min_size = pool_options.pop("min_size", 1)
        max_size = pool_options.pop("max_size", 10)
        if pool_options:
            name = sorted(pool_options)[0]
            raise TypeError(f"unexpected PostgreSQL pool option: {name}")
        self._pool = ConnectionPool(
            conninfo,
            min_size=min_size,
            max_size=max_size,
            kwargs={"row_factory": dict_row, "autocommit": False},
            open=False,
        )

    def open(self) -> None:
        self._pool.open(wait=True, timeout=15)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def connection(self) -> Iterator[Connection[dict[str, Any]]]:
        with self._pool.connection() as connection:
            yield connection

    def check(self) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()

    def fetch_one(self, statement: str, params: Sequence[Any] | dict[str, Any] = ()) -> dict | None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(statement, params)
            return cursor.fetchone()

    def fetch_all(self, statement: str, params: Sequence[Any] | dict[str, Any] = ()) -> list[dict]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(statement, params)
            return list(cursor.fetchall())

    def execute(self, statement: str, params: Sequence[Any] | dict[str, Any] = ()) -> int:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(statement, params)
            return cursor.rowcount

    def execute_values(
        self,
        statement: sql.Composed,
        values: Sequence[Sequence[Any]],
    ) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.executemany(statement, values)
