"""Dependency injection container for services."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from functools import lru_cache

from minio import Minio

from menos.config import settings
from menos.services.agent import AgentService
from menos.services.database import PostgresDatabase
from menos.services.docling import DoclingClient
from menos.services.embeddings import get_embedding_service
from menos.services.llm import LLMProvider, OllamaLLMProvider
from menos.services.llm_metering import MeteringLLMProvider
from menos.services.llm_pricing import LLMPricingService
from menos.services.llm_providers import (
    AnthropicProvider,
    FallbackProvider,
    NoOpLLMProvider,
    OpenAIProvider,
    OpenRouterProvider,
)
from menos.services.reranker import (
    LLMRerankerProvider,
    NoOpRerankerProvider,
    RerankerLibraryProvider,
    RerankerProvider,
)
from menos.services.storage import PostgresRepository, S3Storage

_llm_pricing_service: LLMPricingService | None = None


def _provider_name(provider: LLMProvider) -> str:
    if isinstance(provider, OpenAIProvider):
        return "openai"
    if isinstance(provider, AnthropicProvider):
        return "anthropic"
    if isinstance(provider, OpenRouterProvider):
        return "openrouter"
    if isinstance(provider, OllamaLLMProvider):
        return "ollama"
    return provider.__class__.__name__.lower()


def _provider_model(provider: LLMProvider) -> str:
    return str(getattr(provider, "model", "unknown"))


def _wrap_provider_with_metering(
    provider: LLMProvider,
    repo: PostgresRepository,
    pricing_service: LLMPricingService,
    context_prefix: str,
) -> LLMProvider:
    if isinstance(provider, NoOpLLMProvider):
        return provider

    if isinstance(provider, FallbackProvider):
        wrapped_chain: list[tuple[str, LLMProvider]] = []
        for name, child_provider in provider.providers:
            if isinstance(child_provider, NoOpLLMProvider):
                wrapped_chain.append((name, child_provider))
                continue

            wrapped_chain.append(
                (
                    name,
                    MeteringLLMProvider(
                        provider=child_provider,
                        repo=repo,
                        context_prefix=context_prefix,
                        provider_name=_provider_name(child_provider),
                        model_name=_provider_model(child_provider),
                        pricing_service=pricing_service,
                    ),
                )
            )
        return FallbackProvider(wrapped_chain)

    return MeteringLLMProvider(
        provider=provider,
        repo=repo,
        context_prefix=context_prefix,
        provider_name=_provider_name(provider),
        model_name=_provider_model(provider),
        pricing_service=pricing_service,
    )


def _new_database() -> PostgresDatabase:
    return PostgresDatabase(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_database,
        user=settings.postgres_user,
        password=settings.postgres_password,
        min_size=settings.postgres_pool_min_size,
        max_size=settings.postgres_pool_max_size,
    )


@asynccontextmanager
async def get_storage_context() -> AsyncGenerator[tuple[S3Storage, PostgresRepository], None]:
    """Create and manage storage service instances."""
    s3_client = Minio(
        settings.s3_endpoint_url,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        secure=settings.s3_secure,
        region=settings.s3_region,
    )
    repo = PostgresRepository(_new_database())
    await repo.connect()
    try:
        yield S3Storage(s3_client, settings.s3_bucket), repo
    finally:
        repo.close()


async def get_s3_storage() -> S3Storage:
    """Get S3-compatible storage instance for dependency injection."""
    s3_client = Minio(
        settings.s3_endpoint_url,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        secure=settings.s3_secure,
        region=settings.s3_region,
    )
    return S3Storage(s3_client, settings.s3_bucket)


# Backwards-compatible alias for routers not yet updated
get_minio_storage = get_s3_storage


async def get_postgres_repo() -> PostgresRepository:
    """Get a connected PostgreSQL repository for dependency injection."""
    repo = PostgresRepository(_new_database())
    await repo.connect()
    return repo


get_surreal_repo = get_postgres_repo


async def get_llm_pricing_service() -> LLMPricingService:
    """Get singleton LLM pricing service for DI and lifespan orchestration."""
    global _llm_pricing_service

    if _llm_pricing_service is not None:
        return _llm_pricing_service

    repo = await get_postgres_repo()
    service = LLMPricingService(repo)
    await service.initialize()
    _llm_pricing_service = service
    return service


def build_openrouter_chain(model: str = "") -> LLMProvider:
    """Build an OpenRouter provider with fallback chain.

    If model is specified, returns a plain OpenRouterProvider for that model.
    If model is empty, returns a FallbackProvider with aurora-alpha as primary,
    then GPT-OSS 120B, DeepSeek R1, then Gemma 3 27B.

    Args:
        model: Specific model to use, or empty for fallback chain

    Returns:
        LLMProvider instance (single or fallback chain)
    """
    key = settings.openrouter_api_key
    if not key:
        raise ValueError("openrouter_api_key must be set for openrouter provider")

    if model:
        return OpenRouterProvider(key, model)

    chain = [
        ("aurora", OpenRouterProvider(key, "openrouter/aurora-alpha")),
        ("gpt-oss", OpenRouterProvider(key, "openai/gpt-oss-120b:free")),
        ("deepseek", OpenRouterProvider(key, "deepseek/deepseek-r1-0528:free")),
        ("gemma3", OpenRouterProvider(key, "google/gemma-3-27b-it:free")),
    ]
    return FallbackProvider(chain)


@lru_cache(maxsize=1)
def get_expansion_provider() -> LLMProvider:
    """Get singleton expansion LLM provider based on settings.

    Returns the appropriate LLM provider instance for query expansion:
    - "ollama" -> OllamaLLMProvider
    - "openai" -> OpenAIProvider
    - "anthropic" -> AnthropicProvider
    - "openrouter" -> OpenRouterProvider
    - "none" -> NoOpLLMProvider

    Returns:
        LLMProvider instance configured for expansion
    """
    provider_type = settings.agent_expansion_provider
    model = settings.agent_expansion_model

    if provider_type == "ollama":
        return OllamaLLMProvider(settings.ollama_url, model)
    elif provider_type == "openai":
        if not settings.openai_api_key:
            raise ValueError("openai_api_key must be set when using openai expansion provider")
        return OpenAIProvider(settings.openai_api_key, model)
    elif provider_type == "anthropic":
        if not settings.anthropic_api_key:
            msg = "anthropic_api_key must be set for anthropic expansion provider"
            raise ValueError(msg)
        return AnthropicProvider(settings.anthropic_api_key, model)
    elif provider_type == "openrouter":
        return build_openrouter_chain(model)
    elif provider_type == "none":
        return NoOpLLMProvider()
    else:
        raise ValueError(f"Unknown expansion provider: {provider_type}")


@lru_cache(maxsize=1)
def get_synthesis_provider() -> LLMProvider:
    """Get singleton synthesis LLM provider based on settings.

    Returns the appropriate LLM provider instance for result synthesis:
    - "ollama" -> OllamaLLMProvider
    - "openai" -> OpenAIProvider
    - "anthropic" -> AnthropicProvider
    - "openrouter" -> OpenRouterProvider
    - "none" -> NoOpLLMProvider

    Returns:
        LLMProvider instance configured for synthesis
    """
    provider_type = settings.agent_synthesis_provider
    model = settings.agent_synthesis_model

    if provider_type == "ollama":
        return OllamaLLMProvider(settings.ollama_url, model)
    elif provider_type == "openai":
        if not settings.openai_api_key:
            msg = "openai_api_key must be set for openai synthesis provider"
            raise ValueError(msg)
        return OpenAIProvider(settings.openai_api_key, model)
    elif provider_type == "anthropic":
        if not settings.anthropic_api_key:
            msg = "anthropic_api_key must be set for anthropic synthesis provider"
            raise ValueError(msg)
        return AnthropicProvider(settings.anthropic_api_key, model)
    elif provider_type == "openrouter":
        return build_openrouter_chain(model)
    elif provider_type == "none":
        return NoOpLLMProvider()
    else:
        raise ValueError(f"Unknown synthesis provider: {provider_type}")


@lru_cache(maxsize=1)
def get_reranker(llm_provider: LLMProvider | None = None) -> RerankerProvider:
    """Get singleton reranker provider based on settings.

    Returns the appropriate reranker provider instance:
    - "rerankers" -> RerankerLibraryProvider
    - "llm" -> LLMRerankerProvider using synthesis provider
    - "none" -> NoOpRerankerProvider

    Returns:
        RerankerProvider instance configured for reranking
    """
    provider_type = settings.agent_rerank_provider
    model = settings.agent_rerank_model

    if provider_type == "rerankers":
        return RerankerLibraryProvider(model)
    elif provider_type == "llm":
        provider = llm_provider if llm_provider is not None else get_synthesis_provider()
        return LLMRerankerProvider(provider)
    elif provider_type == "none":
        return NoOpRerankerProvider()
    else:
        raise ValueError(f"Unknown reranker provider: {provider_type}")


async def get_agent_service() -> AgentService:
    """Get AgentService instance for dependency injection.

    Constructs AgentService with all required dependencies:
    - expansion_provider from get_expansion_provider()
    - synthesis_provider from get_synthesis_provider()
    - reranker from get_reranker()
    - embedding_service from get_embedding_service()
    - postgres_repo from get_postgres_repo()

    Returns:
        Configured AgentService instance
    """
    postgres_repo = await get_postgres_repo()
    pricing_service = await get_llm_pricing_service()
    expansion_provider = _wrap_provider_with_metering(
        get_expansion_provider(),
        postgres_repo,
        pricing_service,
        "search:expansion",
    )
    synthesis_provider = _wrap_provider_with_metering(
        get_synthesis_provider(),
        postgres_repo,
        pricing_service,
        "search:synthesis",
    )
    reranker = get_reranker(synthesis_provider)
    embedding_service = get_embedding_service()

    return AgentService(
        expansion_provider=expansion_provider,
        reranker=reranker,
        synthesis_provider=synthesis_provider,
        embedding_service=embedding_service,
        surreal_repo=postgres_repo,
    )


@lru_cache(maxsize=1)
def get_unified_pipeline_provider() -> LLMProvider:
    """Get singleton unified pipeline LLM provider based on settings.

    Returns:
        LLMProvider instance configured for unified pipeline
    """
    provider_type = settings.unified_pipeline_provider
    model = settings.unified_pipeline_model

    if provider_type == "ollama":
        return OllamaLLMProvider(settings.ollama_url, model)
    elif provider_type == "openai":
        if not settings.openai_api_key:
            raise ValueError("openai_api_key must be set for openai unified pipeline provider")
        return OpenAIProvider(settings.openai_api_key, model)
    elif provider_type == "anthropic":
        if not settings.anthropic_api_key:
            msg = "anthropic_api_key must be set for anthropic unified pipeline provider"
            raise ValueError(msg)
        return AnthropicProvider(settings.anthropic_api_key, model)
    elif provider_type == "openrouter":
        return build_openrouter_chain(model)
    elif provider_type == "none":
        return NoOpLLMProvider()
    else:
        raise ValueError(f"Unknown unified pipeline provider: {provider_type}")


async def get_unified_pipeline_service():
    """Get UnifiedPipelineService instance for dependency injection."""
    from menos.services.unified_pipeline import UnifiedPipelineService

    repo = await get_postgres_repo()
    pricing_service = await get_llm_pricing_service()
    provider = _wrap_provider_with_metering(
        get_unified_pipeline_provider(),
        repo,
        pricing_service,
        "pipeline",
    )
    return UnifiedPipelineService(
        llm_provider=provider,
        repo=repo,
        settings=settings,
    )


async def get_job_repository():
    """Get JobRepository instance for dependency injection."""
    from menos.services.jobs import JobRepository

    repo = await get_postgres_repo()
    return JobRepository(repo)


async def get_pipeline_orchestrator():
    """Get PipelineOrchestrator instance for dependency injection."""
    from menos.services.pipeline_orchestrator import PipelineOrchestrator

    pipeline = await get_unified_pipeline_service()
    job_repo = await get_job_repository()
    repo = await get_postgres_repo()
    callback = get_callback_service()
    return PipelineOrchestrator(pipeline, job_repo, repo, settings, callback)


def get_callback_service():
    """Get CallbackService instance for dependency injection."""
    from menos.services.callbacks import CallbackService

    return CallbackService(settings)


def get_docling_client() -> DoclingClient:
    """Get Docling client instance for dependency injection."""
    return DoclingClient(settings.docling_url)
