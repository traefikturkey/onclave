"""Unit tests for PostgreSQL-backed usage reporting."""

from unittest.mock import MagicMock

from menos.services.di import get_llm_pricing_service, get_surreal_repo


class _PricingServiceStub:
    def __init__(self, is_stale: bool):
        self.is_stale = is_stale

    def get_snapshot_metadata(self):
        return {
            "refreshed_at": None,
            "is_stale": self.is_stale,
            "age_seconds": None,
            "source": "test",
        }


def _install(app, repo, *, stale=False):
    async def _repo_dep():
        return repo

    async def _pricing_dep():
        return _PricingServiceStub(stale)

    app.dependency_overrides[get_surreal_repo] = _repo_dep
    app.dependency_overrides[get_llm_pricing_service] = _pricing_dep


def test_usage_endpoint_returns_aggregates_and_breakdown(authed_client, app_with_keys):
    repo = MagicMock()
    repo.usage_totals.return_value = {
        "total_calls": 3,
        "total_input_tokens": 100,
        "total_output_tokens": 25,
        "estimated_total_cost": 0.012,
    }
    repo.usage_breakdown.return_value = [
        {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "calls": 3,
            "input_tokens": 100,
            "output_tokens": 25,
            "estimated_cost": 0.012,
        }
    ]
    _install(app_with_keys, repo)

    data = authed_client.get("/api/v1/usage").json()
    assert data["total_calls"] == 3
    assert data["breakdown"][0]["model"] == "gpt-4o-mini"


def test_usage_endpoint_passes_filters(authed_client, app_with_keys):
    repo = MagicMock()
    repo.usage_totals.return_value = {}
    repo.usage_breakdown.return_value = []
    _install(app_with_keys, repo)

    response = authed_client.get(
        "/api/v1/usage", params={"provider": "openai", "model": "gpt-4o-mini"}
    )
    assert response.status_code == 200
    assert repo.usage_totals.call_args.args[2:] == ("openai", "gpt-4o-mini")
    assert repo.usage_breakdown.call_args.args[2:] == ("openai", "gpt-4o-mini")


def test_usage_endpoint_returns_empty_totals(authed_client, app_with_keys):
    repo = MagicMock()
    repo.usage_totals.return_value = {}
    repo.usage_breakdown.return_value = []
    _install(app_with_keys, repo, stale=True)
    data = authed_client.get("/api/v1/usage").json()
    assert data["total_calls"] == 0
    assert data["breakdown"] == []
    assert data["pricing_snapshot"]["is_stale"] is True


def test_usage_endpoint_requires_auth(client):
    assert client.get("/api/v1/usage").status_code == 401
