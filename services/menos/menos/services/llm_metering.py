"""Metered LLM provider wrapper for usage/cost tracking."""

import asyncio
import logging
import time

from menos.services.llm import LLMProvider
from menos.services.llm_pricing import LLMPricingService
from menos.services.storage import SurrealDBRepository

logger = logging.getLogger(__name__)


class MeteringLLMProvider:
    """Decorator that records token/cost metadata for each generate call."""

    def __init__(
        self,
        provider: LLMProvider,
        repo: SurrealDBRepository,
        context_prefix: str,
        provider_name: str,
        model_name: str,
        pricing_service: LLMPricingService,
    ):
        self.provider = provider
        self.repo = repo
        self.context_prefix = context_prefix
        self.provider_name = provider_name
        self.model_name = model_name
        self.pricing_service = pricing_service

        # Preserve common provider attributes expected elsewhere.
        self.model = getattr(provider, "model", model_name)

    def with_context(self, context: str) -> "MeteringLLMProvider":
        """Return a new wrapper that overrides the usage context string."""
        return MeteringLLMProvider(
            provider=self.provider,
            repo=self.repo,
            context_prefix=context,
            provider_name=self.provider_name,
            model_name=self.model_name,
            pricing_service=self.pricing_service,
        )

    async def generate(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        timeout: float = 60.0,
    ) -> str:
        start = time.perf_counter()
        response = await self.provider.generate(
            prompt,
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            timeout=timeout,
        )
        duration_ms = int((time.perf_counter() - start) * 1000)

        input_tokens = len(prompt) // 4
        output_tokens = len(response) // 4

        pricing = self.pricing_service.get_model_pricing(self.provider_name, self.model_name)
        input_price = pricing["input"]
        output_price = pricing["output"]
        estimated_cost = (input_tokens / 1_000_000) * input_price + (
            output_tokens / 1_000_000
        ) * output_price

        snapshot_metadata = self.pricing_service.get_snapshot_metadata()
        usage_record = {
            "provider": self.provider_name,
            "model": self.model_name,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "input_price_per_million": input_price,
            "output_price_per_million": output_price,
            "estimated_cost": estimated_cost,
            "context": self.context_prefix,
            "duration_ms": duration_ms,
            "pricing_snapshot_refreshed_at": snapshot_metadata.get("refreshed_at"),
            "created_at": "time::now()",
        }

        task = asyncio.create_task(self._write_usage_record(usage_record))
        task.add_done_callback(self._on_write_done)
        await asyncio.sleep(0)
        return response

    async def close(self) -> None:
        await self.provider.close()

    async def _write_usage_record(self, usage_record: dict) -> None:
        self.repo.db.create("llm_usage", usage_record)

    def _on_write_done(self, task: asyncio.Task) -> None:
        try:
            task.result()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to write LLM usage record: %s", exc)
