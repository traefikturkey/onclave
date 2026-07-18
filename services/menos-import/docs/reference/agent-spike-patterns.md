# Reference: Patterns from agent-spike

This document captures patterns and approaches from `C:\Projects\Personal\agent-spike` that should be adopted as menos matures.

## Project Structure

agent-spike uses a clean separation:

```
compose/
├── api/                    # FastAPI app entry + routers
│   ├── main.py            # App init, router registration, middleware
│   ├── models.py          # Pydantic request/response models
│   ├── middleware/        # Correlation ID, auth
│   └── routers/           # Endpoint groups by domain
├── services/              # Business logic layer (no FastAPI deps)
│   ├── youtube/           # Transcript fetching
│   ├── cache/             # Semantic search
│   ├── archive/           # File storage
│   └── embeddings/        # Vector generation
├── lib/                   # Shared utilities
│   ├── telemetry.py       # OpenTelemetry setup
│   ├── config_manager.py  # Configuration hierarchy
│   └── env_loader.py      # Git-root .env discovery
└── tests/                 # pytest with comprehensive fixtures
```

**Key principle**: Services have no cross-imports. Routers compose services.

## Service Layer Pattern

Each service in agent-spike follows this pattern:

```python
# services/youtube/transcript.py
"""YouTube transcript service - no FastAPI dependencies."""

from menos.config import settings

class TranscriptService:
    """Protocol-based service with factory initialization."""

    def __init__(self, proxy_url: str | None = None):
        self.proxy_url = proxy_url or settings.proxy_url

    async def fetch(self, video_id: str) -> str | None:
        """Fetch transcript for video."""
        # Implementation
        pass

# Factory function with defaults
def create_transcript_service() -> TranscriptService:
    return TranscriptService()
```

**Benefits**:
- Testable (inject mocks via constructor)
- No global state
- Clear dependencies
- Composable

## Configuration Management

agent-spike uses a three-tier hierarchy:

```python
# lib/config_manager.py
class ConfigManager:
    """Priority: env vars > .env file > runtime DB > defaults."""

    def get(self, key: str, default: Any = None) -> Any:
        # 1. Check os.environ
        # 2. Check loaded .env
        # 3. Return default
        pass

    async def get_async(self, key: str, default: Any = None) -> Any:
        # Same as above, plus:
        # 3. Check runtime DB (SurrealDB)
        # 4. Return default
        pass
```

**Type coercion** (env vars are always strings):
```python
def _coerce_type(self, value: str) -> Any:
    if value.lower() in ("true", "yes", "1"):
        return True
    if value.lower() in ("false", "no", "0"):
        return False
    try:
        return int(value)
    except ValueError:
        return value
```

**For menos**: Start simple (env + defaults), add DB-backed settings later if needed.

## Environment Loading

agent-spike discovers .env from git root:

```python
# lib/env_loader.py
def find_git_root() -> Path | None:
    """Walk up directory tree to find .git."""
    current = Path.cwd()
    while current != current.parent:
        if (current / ".git").exists():
            return current
        current = current.parent
    return None

def load_env():
    """Load .env from git root if exists."""
    git_root = find_git_root()
    if git_root:
        env_file = git_root / ".env"
        if env_file.exists():
            load_dotenv(env_file)
```

**Benefit**: Works regardless of CWD (important for CLI tools, tests).

## Docker Multi-Stage Build

agent-spike Dockerfile has 5 stages:

```dockerfile
# Stage 1: Base runtime
FROM python:3.14-slim AS base
# Minimal: locale, timezone, non-root user

# Stage 2: Build tools
FROM base AS build-base
# Add: gcc, cmake, git (for compiling deps)

# Stage 3: Dependency resolution
FROM build-base AS build
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Stage 4: Production
FROM base AS production
COPY --from=build /app/.venv /app/.venv
COPY src/ src/
# Minimal image, no build tools

# Stage 5: Development
FROM build-base AS devcontainer
# Add: docker CLI, gh, jq, zsh, etc.
# For VS Code devcontainer
```

**For menos**: Adopt stages 1-4 for cleaner production images.

## Telemetry (OpenTelemetry)

agent-spike has full OTLP integration:

```python
# lib/telemetry.py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

def setup_telemetry(app: FastAPI, service_name: str = "menos"):
    """Initialize OpenTelemetry with OTLP export."""

    # Configure tracer provider
    provider = TracerProvider(resource=Resource.create({
        "service.name": service_name,
    }))

    # Export to OTLP endpoint (Grafana, SigNoz, etc.)
    otlp_exporter = OTLPSpanExporter(
        endpoint=os.getenv("OTLP_ENDPOINT", "http://localhost:4318/v1/traces")
    )
    provider.add_span_processor(BatchSpanProcessor(otlp_exporter))
    trace.set_tracer_provider(provider)

    # Auto-instrument FastAPI and httpx
    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()
```

**For menos**: Add when deploying to production. Skip for MVP.

## Correlation ID Middleware

agent-spike tracks requests with correlation IDs:

```python
# api/middleware/correlation.py
from contextvars import ContextVar
from uuid import uuid4

correlation_id: ContextVar[str] = ContextVar("correlation_id", default="")

class CorrelationIdMiddleware:
    async def __call__(self, request: Request, call_next):
        # Get from header or generate new
        req_id = request.headers.get("X-Correlation-ID", str(uuid4()))
        correlation_id.set(req_id)

        response = await call_next(request)
        response.headers["X-Correlation-ID"] = req_id
        return response
```

**Usage in logs**:
```python
logger.info("Processing video", extra={"correlation_id": correlation_id.get()})
```

## Testing Fixtures

agent-spike has comprehensive test fixtures:

```python
# tests/conftest.py
import pytest
from unittest.mock import AsyncMock, MagicMock

@pytest.fixture
def mock_youtube_transcript():
    """Mock YouTube transcript API response."""
    return [
        {"start": 0.0, "text": "Hello world"},
        {"start": 5.0, "text": "This is a test"},
    ]

@pytest.fixture
def mock_httpx_client(mock_youtube_transcript):
    """Mock httpx.AsyncClient for API calls."""
    client = AsyncMock()
    client.get.return_value = MagicMock(
        status_code=200,
        json=lambda: {"items": [{"snippet": {"title": "Test"}}]}
    )
    return client

@pytest.fixture
def transcript_service(mock_httpx_client):
    """TranscriptService with mocked dependencies."""
    service = TranscriptService()
    service._client = mock_httpx_client
    return service
```

**Key patterns**:
- Mock at service boundaries (HTTP, DB)
- Use `AsyncMock` for async methods
- Fixtures compose (service fixture uses client fixture)

## Archive Pattern

agent-spike stores expensive data (transcripts, metadata) as JSON:

```python
# services/archive/storage.py
class ArchiveStorage:
    """JSON file storage with optional MinIO backend."""

    def __init__(self, base_path: Path):
        self.base_path = base_path

    async def store(self, key: str, data: dict) -> None:
        path = self.base_path / f"{key}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2))

    async def retrieve(self, key: str) -> dict | None:
        path = self.base_path / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text())
        return None
```

**File structure**:
```
data/archive/youtube/
├── {video_id}/
│   ├── metadata.json
│   ├── transcript.txt
│   └── summary.md
```

**For menos**: Current approach is similar (SQLite + files). Consider JSON archive for portability.

## Lazy Client Initialization

agent-spike initializes expensive clients lazily:

```python
# services/openai_client.py
_client: openai.AsyncOpenAI | None = None
_client_timestamp: float = 0
CLIENT_TTL = 300  # 5 minutes

async def get_openai_client() -> openai.AsyncOpenAI:
    global _client, _client_timestamp

    now = time.time()
    if _client is None or (now - _client_timestamp) > CLIENT_TTL:
        _client = openai.AsyncOpenAI(api_key=settings.openai_api_key)
        _client_timestamp = now

    return _client
```

**Benefits**:
- No startup cost if client unused
- Automatic refresh (handles credential rotation)
- Single instance per process

## Makefile Targets

agent-spike has 40+ Make targets. Key ones to adopt:

```makefile
.PHONY: up down build test lint format

# Development
up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f api

# Testing
test:
	uv run pytest

test-cov:
	uv run pytest --cov=src --cov-report=html

# Code quality
lint:
	uv run ruff check src/

format:
	uv run ruff format src/

# Build
build:
	docker compose build

build-prod:
	docker build --target production -t menos:latest .

# Versioning
bump-patch:
	uv run bump2version patch

bump-minor:
	uv run bump2version minor
```

## Devcontainer Setup

agent-spike uses VS Code devcontainers:

```json
// .devcontainer/devcontainer.json
{
  "name": "menos",
  "dockerComposeFile": "../docker-compose.yml",
  "service": "devcontainer",
  "workspaceFolder": "/workspace",
  "remoteUser": "developer",
  "postCreateCommand": "make setup",
  "customizations": {
    "vscode": {
      "extensions": [
        "ms-python.python",
        "ms-python.vscode-pylance",
        "charliermarsh.ruff"
      ]
    }
  }
}
```

## Summary: Adoption Priority

| Pattern | Priority | Complexity | Benefit |
|---------|----------|------------|---------|
| Service layer | High | Medium | Testability, modularity |
| Config hierarchy | High | Low | Flexibility |
| Docker multi-stage | High | Low | Smaller images |
| Env loading from git root | Medium | Low | CLI convenience |
| Testing fixtures | High | Medium | Reliable tests |
| Correlation IDs | Medium | Low | Debugging |
| Telemetry (OTLP) | Low | Medium | Production observability |
| Lazy clients | Low | Low | Performance |
| Makefile | High | Low | Developer experience |

## Files to Reference

When implementing these patterns, look at:

- `C:\Projects\Personal\agent-spike\compose\lib\config_manager.py`
- `C:\Projects\Personal\agent-spike\compose\lib\env_loader.py`
- `C:\Projects\Personal\agent-spike\compose\services\youtube\`
- `C:\Projects\Personal\agent-spike\compose\tests\conftest.py`
- `C:\Projects\Personal\agent-spike\Dockerfile`
- `C:\Projects\Personal\agent-spike\Makefile`
