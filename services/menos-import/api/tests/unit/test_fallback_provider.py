"""Unit tests for FallbackProvider."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.services.llm_providers import FallbackProvider


def _make_provider(name: str, *, fail: bool = False, result: str = "ok"):
    """Create a mock LLMProvider.

    Args:
        name: Provider name (for identification)
        fail: If True, generate() raises RuntimeError
        result: Return value for generate() on success
    """
    p = MagicMock()
    p.name = name
    if fail:
        p.generate = AsyncMock(side_effect=RuntimeError(f"{name} failed"))
    else:
        p.generate = AsyncMock(return_value=result)
    p.close = AsyncMock()
    return p


class TestFallbackProvider:
    """Tests for FallbackProvider fallback behavior."""

    @pytest.mark.asyncio
    async def test_first_provider_succeeds(self):
        """When first provider succeeds, return its result immediately."""
        p1 = _make_provider("first", result="first-result")
        p2 = _make_provider("second", result="second-result")

        fb = FallbackProvider([("first", p1), ("second", p2)])
        result = await fb.generate("test prompt")

        assert result == "first-result"
        p1.generate.assert_called_once()
        p2.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_falls_back_on_failure(self):
        """When first provider fails, try second and return its result."""
        p1 = _make_provider("first", fail=True)
        p2 = _make_provider("second", result="fallback-result")

        fb = FallbackProvider([("first", p1), ("second", p2)])
        result = await fb.generate("test prompt")

        assert result == "fallback-result"
        p1.generate.assert_called_once()
        p2.generate.assert_called_once()

    @pytest.mark.asyncio
    async def test_all_providers_fail_raises_runtime_error(self):
        """When all providers fail, raise RuntimeError with summary."""
        p1 = _make_provider("alpha", fail=True)
        p2 = _make_provider("beta", fail=True)
        p3 = _make_provider("gamma", fail=True)

        fb = FallbackProvider([("alpha", p1), ("beta", p2), ("gamma", p3)])

        with pytest.raises(RuntimeError, match="All providers failed"):
            await fb.generate("test prompt")

    @pytest.mark.asyncio
    async def test_close_closes_all_providers(self):
        """close() should close every provider in the chain."""
        p1 = _make_provider("first")
        p2 = _make_provider("second")
        p3 = _make_provider("third")

        fb = FallbackProvider([("first", p1), ("second", p2), ("third", p3)])
        await fb.close()

        p1.close.assert_called_once()
        p2.close.assert_called_once()
        p3.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_passes_kwargs_to_provider(self):
        """All keyword arguments should be forwarded to the provider."""
        p1 = _make_provider("first", result="done")

        fb = FallbackProvider([("first", p1)])
        await fb.generate(
            "prompt",
            system_prompt="sys",
            max_tokens=100,
            temperature=0.5,
            timeout=30.0,
        )

        p1.generate.assert_called_once_with(
            "prompt",
            system_prompt="sys",
            max_tokens=100,
            temperature=0.5,
            timeout=30.0,
        )

    def test_empty_providers_raises_value_error(self):
        """Creating FallbackProvider with empty list should raise."""
        with pytest.raises(ValueError, match="at least one provider"):
            FallbackProvider([])
