"""Unit tests for usage reporting endpoint."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

from menos.services.di import get_llm_pricing_service, get_surreal_repo


class _PricingServiceStub:
    def __init__(self, is_stale: bool = False):
        self._is_stale = is_stale

    def get_snapshot_metadata(self) -> dict:
        return {
            "refreshed_at": datetime(2026, 1, 1, tzinfo=UTC),
            "is_stale": self._is_stale,
            "age_seconds": 42,
            "source": "persisted",
        }


def _usage_aggregate_result() -> list[dict]:
    return [
        {
            "result": [
                {
                    "total_calls": 3,
                    "total_input_tokens": 400,
                    "total_output_tokens": 150,
                    "estimated_total_cost": 0.0042,
                }
            ]
        }
    ]


def _usage_breakdown_result() -> list[dict]:
    return [
        {
            "result": [
                {
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "calls": 2,
                    "input_tokens": 300,
                    "output_tokens": 100,
                    "estimated_cost": 0.003,
                },
                {
                    "provider": "openrouter",
                    "model": "openrouter/aurora-alpha",
                    "calls": 1,
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "estimated_cost": 0.0012,
                },
            ]
        }
    ]


def test_usage_endpoint_returns_aggregates_and_breakdown(authed_client, app_with_keys):
    mock_repo = MagicMock()
    mock_repo.db = MagicMock()
    mock_repo.db.query.side_effect = [_usage_aggregate_result(), _usage_breakdown_result()]

    async def _repo_dep():
        return mock_repo

    async def _pricing_dep():
        return _PricingServiceStub(is_stale=False)

    app_with_keys.dependency_overrides[get_surreal_repo] = _repo_dep
    app_with_keys.dependency_overrides[get_llm_pricing_service] = _pricing_dep

    response = authed_client.get("/api/v1/usage")

    assert response.status_code == 200
    data = response.json()
    assert data["total_calls"] == 3
    assert data["total_input_tokens"] == 400
    assert data["total_output_tokens"] == 150
    assert data["estimated_total_cost"] == 0.0042
    assert len(data["breakdown"]) == 2
    assert data["pricing_snapshot"]["is_stale"] is False


def test_usage_endpoint_supports_filters(authed_client, app_with_keys):
    mock_repo = MagicMock()
    mock_repo.db = MagicMock()
    mock_repo.db.query.side_effect = [_usage_aggregate_result(), _usage_breakdown_result()]

    async def _repo_dep():
        return mock_repo

    async def _pricing_dep():
        return _PricingServiceStub(is_stale=False)

    app_with_keys.dependency_overrides[get_surreal_repo] = _repo_dep
    app_with_keys.dependency_overrides[get_llm_pricing_service] = _pricing_dep

    response = authed_client.get(
        "/api/v1/usage",
        params={"provider": "openai", "model": "gpt-4o-mini"},
    )

    assert response.status_code == 200
    assert mock_repo.db.query.call_count == 2
    _, params = mock_repo.db.query.call_args_list[0].args
    assert params["provider"] == "openai"
    assert params["model"] == "gpt-4o-mini"


def test_usage_endpoint_returns_empty_totals_when_no_rows(authed_client, app_with_keys):
    mock_repo = MagicMock()
    mock_repo.db = MagicMock()
    mock_repo.db.query.side_effect = [[{"result": []}], [{"result": []}]]

    async def _repo_dep():
        return mock_repo

    async def _pricing_dep():
        return _PricingServiceStub(is_stale=True)

    app_with_keys.dependency_overrides[get_surreal_repo] = _repo_dep
    app_with_keys.dependency_overrides[get_llm_pricing_service] = _pricing_dep

    response = authed_client.get("/api/v1/usage")

    assert response.status_code == 200
    data = response.json()
    assert data["total_calls"] == 0
    assert data["total_input_tokens"] == 0
    assert data["total_output_tokens"] == 0
    assert data["estimated_total_cost"] == 0.0
    assert data["breakdown"] == []
    assert data["pricing_snapshot"]["is_stale"] is True


def test_usage_endpoint_requires_auth(client):
    response = client.get("/api/v1/usage")
    assert response.status_code == 401
