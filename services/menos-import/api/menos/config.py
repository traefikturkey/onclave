"""Configuration settings."""

from pathlib import Path
from typing import Literal

from pydantic import ConfigDict
from pydantic_settings import BaseSettings

# Type aliases for agent configuration
LLMProviderType = Literal["ollama", "openai", "anthropic", "openrouter", "none"]
RerankerProviderType = Literal["rerankers", "llm", "none"]


class Settings(BaseSettings):
    """Application settings loaded from environment."""

    model_config = ConfigDict(
        env_file=[".env", "../.env"],
        extra="ignore",
    )

    # Menos API (for client scripts)
    api_base_url: str = "http://localhost:8000"

    # SurrealDB
    surrealdb_url: str = "http://localhost:8000"
    surrealdb_user: str = "root"
    surrealdb_password: str = "root"
    surrealdb_namespace: str = "menos"
    surrealdb_database: str = "menos"

    # S3-compatible storage (Garage)
    s3_endpoint_url: str = "localhost:3900"
    s3_access_key: str = "minio"
    s3_secret_key: str = "minio123"
    s3_secure: bool = False
    s3_bucket: str = "menos"
    s3_region: str = "garage"

    # Ollama (embeddings only)
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "mxbai-embed-large"

    # Docling
    docling_url: str = "http://docling-serve:5001"

    # Auth
    ssh_public_keys_path: Path = Path("/keys")

    # Webshare Proxy (required for YouTube transcript fetching)
    webshare_proxy_username: str
    webshare_proxy_password: str

    # YouTube Data API
    youtube_api_key: str | None = None

    # Agent settings
    agent_expansion_provider: LLMProviderType = "openrouter"
    agent_expansion_model: str = ""
    agent_rerank_provider: RerankerProviderType = "none"
    agent_rerank_model: str = "cross-encoder/ms-marco-MiniLM-L-12-v2"
    agent_synthesis_provider: LLMProviderType = "openrouter"
    agent_synthesis_model: str = ""

    # Cloud LLM API keys
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    openrouter_api_key: str | None = None

    # Unified Pipeline
    unified_pipeline_enabled: bool = True
    unified_pipeline_provider: LLMProviderType = "openrouter"
    unified_pipeline_model: str = ""
    unified_pipeline_max_concurrency: int = 4
    unified_pipeline_max_new_tags: int = 3

    # Pipeline Callbacks
    callback_url: str | None = None
    callback_secret: str | None = None

    # API Keys for Metadata Fetching (optional)
    semantic_scholar_api_key: str | None = None

    # Extraction Limits
    entity_max_topics_per_content: int = 7
    entity_min_confidence: float = 0.6
    entity_fetch_external_metadata: bool = True

    @property
    def app_version(self) -> str:
        """Read app version from pyproject.toml."""
        import re

        pyproject = Path(__file__).parent.parent / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
        return match.group(1) if match else "unknown"


settings = Settings()


def get_settings() -> Settings:
    """Get application settings (for dependency injection)."""
    return settings
