"""Unit tests for unified pipeline DI wiring."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from menos.services.llm import LLMProvider
from menos.services.llm_metering import MeteringLLMProvider


class TestGetUnifiedPipelineProvider:
    """Tests for get_unified_pipeline_provider factory."""

    def setup_method(self):
        """Clear lru_cache between tests."""
        from menos.services.di import get_unified_pipeline_provider

        get_unified_pipeline_provider.cache_clear()

    def test_returns_noop_for_none_provider(self):
        """Provider type 'none' returns NoOpLLMProvider."""
        from menos.services.di import get_unified_pipeline_provider

        mock_settings = MagicMock()
        mock_settings.unified_pipeline_provider = "none"
        mock_settings.unified_pipeline_model = ""

        with patch("menos.services.di.settings", mock_settings):
            provider = get_unified_pipeline_provider()

        assert isinstance(provider, LLMProvider)

    def test_returns_ollama_provider(self):
        """Provider type 'ollama' returns OllamaLLMProvider."""
        from menos.services.di import get_unified_pipeline_provider

        mock_settings = MagicMock()
        mock_settings.unified_pipeline_provider = "ollama"
        mock_settings.unified_pipeline_model = "test-model"
        mock_settings.ollama_url = "http://localhost:11434"

        with patch("menos.services.di.settings", mock_settings):
            provider = get_unified_pipeline_provider()

        assert isinstance(provider, LLMProvider)

    def test_raises_for_unknown_provider(self):
        """Unknown provider type raises ValueError."""
        from menos.services.di import get_unified_pipeline_provider

        mock_settings = MagicMock()
        mock_settings.unified_pipeline_provider = "invalid"
        mock_settings.unified_pipeline_model = ""

        with patch("menos.services.di.settings", mock_settings):
            with pytest.raises(ValueError, match="Unknown unified pipeline provider"):
                get_unified_pipeline_provider()

    def test_openrouter_requires_api_key(self):
        """OpenRouter provider uses build_openrouter_chain."""
        from menos.services.di import get_unified_pipeline_provider

        mock_settings = MagicMock()
        mock_settings.unified_pipeline_provider = "openrouter"
        mock_settings.unified_pipeline_model = "test-model"
        mock_settings.openrouter_api_key = "test-key"

        with patch("menos.services.di.settings", mock_settings):
            provider = get_unified_pipeline_provider()

        assert isinstance(provider, LLMProvider)


class TestGetUnifiedPipelineService:
    """Tests for get_unified_pipeline_service factory."""

    def setup_method(self):
        """Clear lru_cache between tests."""
        from menos.services.di import get_unified_pipeline_provider

        get_unified_pipeline_provider.cache_clear()

    @pytest.mark.asyncio
    async def test_returns_unified_pipeline_service(self):
        """Factory returns a UnifiedPipelineService instance."""
        from menos.services.di import get_unified_pipeline_service
        from menos.services.unified_pipeline import UnifiedPipelineService

        mock_settings = MagicMock()
        mock_settings.unified_pipeline_provider = "none"
        mock_settings.unified_pipeline_model = ""

        mock_repo = MagicMock()
        mock_repo.connect = AsyncMock()

        with (
            patch("menos.services.di.settings", mock_settings),
            patch("menos.services.di.get_surreal_repo", AsyncMock(return_value=mock_repo)),
        ):
            service = await get_unified_pipeline_service()

        assert isinstance(service, UnifiedPipelineService)


class TestDIBoundary:
    """Tests enforcing DI metering boundary for feature services."""

    @pytest.mark.asyncio
    async def test_agent_service_receives_metered_wrappers(self):
        from menos.services.di import (
            get_agent_service,
            get_expansion_provider,
            get_synthesis_provider,
        )

        get_expansion_provider.cache_clear()
        get_synthesis_provider.cache_clear()

        mock_settings = MagicMock()
        mock_settings.agent_expansion_provider = "openai"
        mock_settings.agent_expansion_model = "gpt-4o-mini"
        mock_settings.agent_synthesis_provider = "openai"
        mock_settings.agent_synthesis_model = "gpt-4o-mini"
        mock_settings.agent_rerank_provider = "none"
        mock_settings.agent_rerank_model = ""
        mock_settings.openai_api_key = "test-key"
        mock_settings.ollama_url = "http://localhost:11434"
        mock_settings.anthropic_api_key = None
        mock_settings.openrouter_api_key = None

        mock_repo = MagicMock()
        mock_repo.connect = AsyncMock()

        mock_pricing = MagicMock()
        mock_pricing.get_model_pricing.return_value = {"input": 0.0, "output": 0.0}
        mock_pricing.get_snapshot_metadata.return_value = {
            "refreshed_at": None,
            "is_stale": False,
            "age_seconds": None,
            "source": "bootstrap",
        }

        with (
            patch("menos.services.di.settings", mock_settings),
            patch("menos.services.di.get_surreal_repo", AsyncMock(return_value=mock_repo)),
            patch(
                "menos.services.di.get_llm_pricing_service", AsyncMock(return_value=mock_pricing)
            ),
        ):
            service = await get_agent_service()

        assert isinstance(service.expansion_provider, MeteringLLMProvider)
        assert isinstance(service.synthesis_provider, MeteringLLMProvider)

    @pytest.mark.asyncio
    async def test_llm_reranker_uses_metered_provider(self):
        from menos.services.di import (
            get_agent_service,
            get_expansion_provider,
            get_reranker,
            get_synthesis_provider,
        )
        from menos.services.reranker import LLMRerankerProvider

        get_expansion_provider.cache_clear()
        get_synthesis_provider.cache_clear()
        get_reranker.cache_clear()

        mock_settings = MagicMock()
        mock_settings.agent_expansion_provider = "openai"
        mock_settings.agent_expansion_model = "gpt-4o-mini"
        mock_settings.agent_synthesis_provider = "openai"
        mock_settings.agent_synthesis_model = "gpt-4o-mini"
        mock_settings.agent_rerank_provider = "llm"
        mock_settings.agent_rerank_model = ""
        mock_settings.openai_api_key = "test-key"
        mock_settings.ollama_url = "http://localhost:11434"
        mock_settings.anthropic_api_key = None
        mock_settings.openrouter_api_key = None

        mock_repo = MagicMock()
        mock_repo.connect = AsyncMock()

        mock_pricing = MagicMock()
        mock_pricing.get_model_pricing.return_value = {"input": 0.0, "output": 0.0}
        mock_pricing.get_snapshot_metadata.return_value = {
            "refreshed_at": None,
            "is_stale": False,
            "age_seconds": None,
            "source": "bootstrap",
        }

        with (
            patch("menos.services.di.settings", mock_settings),
            patch("menos.services.di.get_surreal_repo", AsyncMock(return_value=mock_repo)),
            patch(
                "menos.services.di.get_llm_pricing_service", AsyncMock(return_value=mock_pricing)
            ),
        ):
            service = await get_agent_service()

        assert isinstance(service.reranker, LLMRerankerProvider)
        assert isinstance(service.reranker.llm_provider, MeteringLLMProvider)
