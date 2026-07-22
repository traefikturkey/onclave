"""Usage and cost reporting endpoints."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from menos.auth.dependencies import AuthenticatedKeyId
from menos.services.di import get_llm_pricing_service, get_surreal_repo
from menos.services.llm_pricing import LLMPricingService
from menos.services.storage import SurrealDBRepository

router = APIRouter(prefix="/usage", tags=["usage"])


class UsageQuery(BaseModel):
    """Query parameters for usage aggregation."""

    start_date: datetime | None = None
    end_date: datetime | None = None
    provider: str | None = None
    model: str | None = None


class UsageBreakdownItem(BaseModel):
    """Per-provider and model usage breakdown."""

    provider: str
    model: str
    calls: int
    input_tokens: int
    output_tokens: int
    estimated_cost: float


class UsageResponse(BaseModel):
    """Aggregated usage totals and breakdown."""

    total_calls: int
    total_input_tokens: int
    total_output_tokens: int
    estimated_total_cost: float
    breakdown: list[UsageBreakdownItem]
    pricing_snapshot: dict[str, Any]


def _to_usage_query(
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> UsageQuery:
    return UsageQuery(
        start_date=start_date,
        end_date=end_date,
        provider=provider,
        model=model,
    )


def _to_breakdown_item(item: dict) -> UsageBreakdownItem:
    return UsageBreakdownItem(
        provider=str(item.get("provider") or ""),
        model=str(item.get("model") or ""),
        calls=int(item.get("calls") or 0),
        input_tokens=int(item.get("input_tokens") or 0),
        output_tokens=int(item.get("output_tokens") or 0),
        estimated_cost=float(item.get("estimated_cost") or 0.0),
    )


@router.get("", response_model=UsageResponse)
async def get_usage(
    key_id: AuthenticatedKeyId,
    query: UsageQuery = Depends(_to_usage_query),
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
    pricing_service: LLMPricingService = Depends(get_llm_pricing_service),
):
    """Return aggregated LLM usage totals and provider/model breakdown."""
    del key_id
    totals = surreal_repo.usage_totals(
        query.start_date, query.end_date, query.provider, query.model
    )
    breakdown_rows = surreal_repo.usage_breakdown(
        query.start_date, query.end_date, query.provider, query.model
    )
    return UsageResponse(
        total_calls=int(totals.get("total_calls") or 0),
        total_input_tokens=int(totals.get("total_input_tokens") or 0),
        total_output_tokens=int(totals.get("total_output_tokens") or 0),
        estimated_total_cost=float(totals.get("estimated_total_cost") or 0.0),
        breakdown=[_to_breakdown_item(item) for item in breakdown_rows],
        pricing_snapshot=pricing_service.get_snapshot_metadata(),
    )
