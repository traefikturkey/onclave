"""Unit tests for LLM metering wrapper."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.services.llm_metering import MeteringLLMProvider


class _PricingStub:
    def __init__(self):
        self.metadata = {
            "refreshed_at": datetime(2026, 1, 1, tzinfo=UTC),
            "source": "persisted",
            "is_stale": False,
            "age_seconds": 0,
        }

    def get_model_pricing(self, provider: str, model: str) -> dict[str, float]:
        if provider == "openai" and model == "gpt-4o-mini":
            return {"input": 0.15, "output": 0.60}
        return {"input": 0.0, "output": 0.0}

    def get_snapshot_metadata(self) -> dict:
        return self.metadata


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(return_value="hello world")
    provider.close = AsyncMock()
    return provider


@pytest.fixture
def mock_repo():
    repo = MagicMock()
    repo.db = MagicMock()
    repo.db.create = MagicMock()
    return repo


@pytest.mark.asyncio
async def test_generate_logs_usage_and_returns_original_response(mock_provider, mock_repo):
    wrapped = MeteringLLMProvider(
        provider=mock_provider,
        repo=mock_repo,
        context_prefix="search:expansion",
        provider_name="openai",
        model_name="gpt-4o-mini",
        pricing_service=_PricingStub(),
    )

    response = await wrapped.generate("abcd", temperature=0.4)

    assert response == "hello world"
    mock_repo.db.create.assert_called_once()
    table_name, payload = mock_repo.db.create.call_args.args
    assert table_name == "llm_usage"
    assert payload["provider"] == "openai"
    assert payload["model"] == "gpt-4o-mini"
    assert payload["context"] == "search:expansion"
    assert payload["input_tokens"] == 1
    assert payload["output_tokens"] == 2
    assert payload["estimated_cost"] > 0
    assert payload["duration_ms"] >= 0


@pytest.mark.asyncio
async def test_generate_handles_db_write_failure_without_breaking_call(mock_provider, mock_repo):
    mock_repo.db.create.side_effect = RuntimeError("db write failed")

    wrapped = MeteringLLMProvider(
        provider=mock_provider,
        repo=mock_repo,
        context_prefix="search:synthesis",
        provider_name="openai",
        model_name="gpt-4o-mini",
        pricing_service=_PricingStub(),
    )

    response = await wrapped.generate("abcd")

    assert response == "hello world"


@pytest.mark.asyncio
async def test_generate_propagates_provider_error(mock_provider, mock_repo):
    mock_provider.generate.side_effect = RuntimeError("provider failed")

    wrapped = MeteringLLMProvider(
        provider=mock_provider,
        repo=mock_repo,
        context_prefix="pipeline",
        provider_name="openai",
        model_name="gpt-4o-mini",
        pricing_service=_PricingStub(),
    )

    with pytest.raises(RuntimeError, match="provider failed"):
        await wrapped.generate("abcd")


@pytest.mark.asyncio
async def test_with_context_overrides_context_for_pipeline_calls(mock_provider, mock_repo):
    wrapped = MeteringLLMProvider(
        provider=mock_provider,
        repo=mock_repo,
        context_prefix="pipeline",
        provider_name="openai",
        model_name="gpt-4o-mini",
        pricing_service=_PricingStub(),
    )

    pipeline_wrapped = wrapped.with_context("pipeline:pipeline_job:abc123")
    await pipeline_wrapped.generate("abcd")

    _, payload = mock_repo.db.create.call_args.args
    assert payload["context"] == "pipeline:pipeline_job:abc123"
