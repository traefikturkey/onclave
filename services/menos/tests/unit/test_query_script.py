"""Tests for the read-only PostgreSQL query script."""

from unittest.mock import MagicMock, patch

import pytest

from scripts.query import _is_read_only, run_query


@pytest.mark.parametrize(
    "statement",
    ["SELECT * FROM content", " with rows as (select 1) select * from rows", "EXPLAIN SELECT 1"],
)
def test_read_only_statements_are_allowed(statement):
    assert _is_read_only(statement)


@pytest.mark.parametrize(
    "statement",
    ["DELETE FROM content", "UPDATE content SET title='x'", "CREATE TABLE x(id int)"],
)
def test_mutating_statements_are_rejected(statement):
    assert not _is_read_only(statement)
    with pytest.raises(ValueError, match="only SELECT"):
        run_query(statement)


def test_run_query_uses_database_and_closes(capsys):
    database = MagicMock()
    database.fetch_all.return_value = [{"id": "content-1"}]
    with patch("scripts.query.get_database", return_value=database):
        assert run_query("SELECT id FROM content") == [{"id": "content-1"}]
    database.open.assert_called_once()
    database.close.assert_called_once()
    assert "content-1" in capsys.readouterr().out
