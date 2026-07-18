"""Unit tests for startup lifespan behavior in menos.main."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos import main


@pytest.mark.asyncio
async def test_log_version_drift_logs_stale_items(monkeypatch):
    settings = SimpleNamespace(app_version="0.5.0")
    repo = MagicMock()
    repo.get_version_drift_report = AsyncMock(
        return_value={
            "current_version": "0.5.0",
            "total_stale": 7,
            "unknown_version_count": 2,
        }
    )

    mock_logger = MagicMock()
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_surreal_repo", AsyncMock(return_value=repo))
    monkeypatch.setattr(main, "logger", mock_logger)

    await main._log_version_drift()

    mock_logger.info.assert_called_once_with(
        "version_drift: %d stale items (current=%s, unknown_versions=%d)",
        7,
        "0.5.0",
        2,
    )


@pytest.mark.asyncio
async def test_log_version_drift_logs_no_stale_content(monkeypatch):
    settings = SimpleNamespace(app_version="0.5.0")
    repo = MagicMock()
    repo.get_version_drift_report = AsyncMock(
        return_value={
            "current_version": "0.5.0",
            "total_stale": 0,
            "unknown_version_count": 3,
        }
    )

    mock_logger = MagicMock()
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_surreal_repo", AsyncMock(return_value=repo))
    monkeypatch.setattr(main, "logger", mock_logger)

    await main._log_version_drift()

    mock_logger.info.assert_called_once_with(
        "version_drift: no stale content (current=%s, unknown_versions=%d)",
        "0.5.0",
        3,
    )


@pytest.mark.asyncio
async def test_log_version_drift_warns_and_continues_on_error(monkeypatch):
    settings = SimpleNamespace(app_version="0.5.0")
    mock_logger = MagicMock()

    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_surreal_repo", AsyncMock(side_effect=RuntimeError("boom")))
    monkeypatch.setattr(main, "logger", mock_logger)

    await main._log_version_drift()

    mock_logger.warning.assert_called_once()


@pytest.mark.asyncio
async def test_lifespan_runs_drift_log_after_migration_and_purge(monkeypatch):
    call_order: list[str] = []
    mock_pricing = MagicMock()
    mock_pricing.start_scheduler = AsyncMock(
        side_effect=lambda: call_order.append("start_scheduler")
    )
    mock_pricing.stop_scheduler = AsyncMock(side_effect=lambda: call_order.append("stop_scheduler"))

    monkeypatch.setattr(main, "run_migrations", lambda: call_order.append("migrations"))
    monkeypatch.setattr(main, "_run_purge", lambda: call_order.append("purge"))
    monkeypatch.setattr(
        main, "_log_version_drift", AsyncMock(side_effect=lambda: call_order.append("drift"))
    )
    monkeypatch.setattr(main, "get_llm_pricing_service", AsyncMock(return_value=mock_pricing))
    monkeypatch.setattr(main, "background_tasks", [])

    async with main.lifespan(MagicMock()):
        call_order.append("yield")

    assert call_order == [
        "migrations",
        "purge",
        "drift",
        "start_scheduler",
        "yield",
        "stop_scheduler",
    ]
