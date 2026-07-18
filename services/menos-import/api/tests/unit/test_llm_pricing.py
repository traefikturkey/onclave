"""Unit tests for LLM pricing snapshot service."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from menos.services.llm_pricing import LLMPricingService


def _build_repo() -> MagicMock:
    repo = MagicMock()
    repo.db = MagicMock()
    return repo


@pytest.mark.asyncio
async def test_initialize_bootstraps_snapshot_when_none_exists():
    repo = _build_repo()
    repo.db.select.return_value = None

    service = LLMPricingService(repo)
    await service.initialize()

    pricing = service.get_model_pricing("openai", "gpt-4o-mini")
    assert pricing["input"] > 0
    assert pricing["output"] > 0
    assert service.get_snapshot_metadata()["source"] == "bootstrap"


@pytest.mark.asyncio
async def test_unknown_model_returns_zero_cost_pricing():
    repo = _build_repo()
    repo.db.select.return_value = None

    service = LLMPricingService(repo)
    await service.initialize()

    pricing = service.get_model_pricing("unknown", "unknown-model")
    assert pricing == {"input": 0.0, "output": 0.0}


@pytest.mark.asyncio
async def test_metadata_marks_snapshot_stale_after_threshold():
    repo = _build_repo()
    stale_at = datetime.now(UTC) - timedelta(days=8)
    repo.db.select.return_value = {
        "refreshed_at": stale_at.isoformat(),
        "source": "persisted",
        "pricing": {"openai": {"gpt-4o-mini": {"input": 0.1, "output": 0.2}}},
    }

    service = LLMPricingService(repo)
    await service.initialize()

    metadata = service.get_snapshot_metadata()
    assert metadata["is_stale"] is True
    assert metadata["age_seconds"] is not None
    assert metadata["age_seconds"] > 0


@pytest.mark.asyncio
async def test_refresh_failure_keeps_last_good_snapshot():
    repo = _build_repo()
    old_timestamp = datetime(2026, 1, 1, tzinfo=UTC)
    repo.db.select.return_value = {
        "refreshed_at": old_timestamp.isoformat(),
        "source": "persisted",
        "pricing": {"openai": {"gpt-4o-mini": {"input": 1.0, "output": 2.0}}},
    }

    service = LLMPricingService(repo)
    await service.initialize()

    with patch.object(
        service, "_build_latest_snapshot", side_effect=RuntimeError("refresh failed")
    ):
        await service.refresh_snapshot()

    pricing = service.get_model_pricing("openai", "gpt-4o-mini")
    assert pricing == {"input": 1.0, "output": 2.0}
    assert service.get_snapshot_metadata()["refreshed_at"] == old_timestamp
