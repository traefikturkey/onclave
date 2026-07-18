"""Pricing snapshot service for LLM cost estimation."""

import asyncio
import copy
import logging
from datetime import UTC, datetime
from typing import Any

from menos.services.storage import SurrealDBRepository

logger = logging.getLogger(__name__)


class LLMPricingService:
    """Maintains a persisted LLM pricing snapshot with scheduled refresh."""

    SNAPSHOT_ID = "llm_pricing_snapshot:active"

    def __init__(
        self,
        repo: SurrealDBRepository,
        *,
        refresh_interval_seconds: int = 24 * 60 * 60,
        stale_after_seconds: int = 7 * 24 * 60 * 60,
    ):
        self.repo = repo
        self.refresh_interval_seconds = refresh_interval_seconds
        self.stale_after_seconds = stale_after_seconds

        self._pricing: dict[str, dict[str, dict[str, float]]] = {}
        self._refreshed_at: datetime | None = None
        self._source: str = "bootstrap"
        self._scheduler_task: asyncio.Task | None = None

    async def initialize(self) -> None:
        """Load persisted snapshot or bootstrap defaults on first run."""
        persisted = self._load_persisted_snapshot()
        if persisted is not None:
            self._apply_snapshot(persisted)
            return

        snapshot = self._build_latest_snapshot()
        refreshed_at = datetime.now(UTC)
        self._pricing = snapshot
        self._refreshed_at = refreshed_at
        self._source = "bootstrap"
        self._persist_snapshot(snapshot, refreshed_at, self._source)

    def get_model_pricing(self, provider: str, model: str) -> dict[str, float]:
        """Return input/output pricing for provider/model, or zero-pricing for unknowns."""
        provider_map = self._pricing.get(provider, {})
        model_map = provider_map.get(model)
        if model_map is None:
            return {"input": 0.0, "output": 0.0}
        return {
            "input": float(model_map.get("input", 0.0)),
            "output": float(model_map.get("output", 0.0)),
        }

    def get_snapshot_metadata(self) -> dict[str, Any]:
        """Return staleness and provenance metadata for current snapshot."""
        age_seconds: int | None = None
        is_stale = True
        if self._refreshed_at is not None:
            age_seconds = int((datetime.now(UTC) - self._refreshed_at).total_seconds())
            is_stale = age_seconds > self.stale_after_seconds

        return {
            "refreshed_at": self._refreshed_at,
            "is_stale": is_stale,
            "age_seconds": age_seconds,
            "source": self._source,
        }

    async def refresh_snapshot(self) -> None:
        """Refresh snapshot and persist updates; keep last-good snapshot on failure."""
        try:
            snapshot = self._build_latest_snapshot()
            refreshed_at = datetime.now(UTC)
            self._pricing = snapshot
            self._refreshed_at = refreshed_at
            self._source = "bootstrap"
            self._persist_snapshot(snapshot, refreshed_at, self._source)
        except Exception:
            logger.exception("Pricing refresh failed, retaining last-good snapshot")

    async def start_scheduler(self) -> None:
        """Start in-process periodic snapshot refresh task."""
        if self._scheduler_task is not None and not self._scheduler_task.done():
            return
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    async def stop_scheduler(self) -> None:
        """Stop in-process periodic snapshot refresh task."""
        if self._scheduler_task is None:
            return
        self._scheduler_task.cancel()
        try:
            await self._scheduler_task
        except asyncio.CancelledError:
            pass
        finally:
            self._scheduler_task = None

    async def _scheduler_loop(self) -> None:
        while True:
            await asyncio.sleep(self.refresh_interval_seconds)
            await self.refresh_snapshot()

    def _load_persisted_snapshot(self) -> dict[str, Any] | None:
        record = self.repo.db.select(self.SNAPSHOT_ID)
        if isinstance(record, list):
            if not record:
                return None
            record = record[0]

        if not isinstance(record, dict):
            return None
        if not record.get("pricing"):
            return None
        return record

    def _apply_snapshot(self, snapshot: dict[str, Any]) -> None:
        self._pricing = snapshot.get("pricing", {})
        self._refreshed_at = self._coerce_datetime(snapshot.get("refreshed_at"))
        self._source = str(snapshot.get("source") or "persisted")

    def _persist_snapshot(
        self,
        snapshot: dict[str, dict[str, dict[str, float]]],
        refreshed_at: datetime,
        source: str,
    ) -> None:
        payload = {
            "pricing": snapshot,
            "refreshed_at": refreshed_at.isoformat(),
            "source": source,
        }
        try:
            self.repo.db.query(
                "UPSERT llm_pricing_snapshot:active CONTENT $payload",
                {"payload": payload},
            )
        except Exception:
            logger.exception("Failed to persist LLM pricing snapshot")

    def _build_latest_snapshot(self) -> dict[str, dict[str, dict[str, float]]]:
        # Bootstrap defaults are only used if no persisted snapshot exists yet,
        # or as the source for periodic refresh in this phase.
        return copy.deepcopy(_BOOTSTRAP_PRICING)

    def _coerce_datetime(self, value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=UTC)
        if not isinstance(value, str) or not value:
            return None
        try:
            parsed = datetime.fromisoformat(value)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            return None


_BOOTSTRAP_PRICING: dict[str, dict[str, dict[str, float]]] = {
    "openai": {
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    },
    "anthropic": {
        "claude-3-5-haiku-20241022": {"input": 0.80, "output": 4.00},
    },
    "openrouter": {
        "openrouter/aurora-alpha": {"input": 0.00, "output": 0.00},
        "openai/gpt-oss-120b:free": {"input": 0.00, "output": 0.00},
        "deepseek/deepseek-r1-0528:free": {"input": 0.00, "output": 0.00},
        "google/gemma-3-27b-it:free": {"input": 0.00, "output": 0.00},
    },
    "ollama": {
        "default": {"input": 0.00, "output": 0.00},
    },
}
