"""Smoke test fixtures for live API testing."""

import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest
from minio import Minio
from surrealdb import Surreal

from menos.client.signer import RequestSigner
from menos.config import settings


@pytest.fixture(scope="session")
def smoke_base_url():
    """Get the base URL for the live API from settings.

    Reads API_BASE_URL from .env via menos.config.settings.
    """
    return settings.api_base_url.rstrip("/")


@pytest.fixture(scope="session")
def smoke_request_signer():
    """Create RequestSigner from SSH key file.

    Uses SMOKE_TEST_KEY_FILE env var, defaults to ~/.ssh/id_ed25519
    Gracefully handles missing key file with informative error.
    """
    key_path = os.environ.get("SMOKE_TEST_KEY_FILE", str(Path.home() / ".ssh" / "id_ed25519"))
    key_path = Path(key_path)

    if not key_path.exists():
        pytest.skip(
            f"Smoke test SSH key not found at {key_path}. "
            f"Set SMOKE_TEST_KEY_FILE environment variable or ensure "
            f"~/.ssh/id_ed25519 exists."
        )

    try:
        return RequestSigner.from_file(key_path)
    except ValueError as e:
        pytest.skip(f"Invalid SSH key format: {e}. Only Ed25519 keys are supported.")
    except Exception as e:
        pytest.skip(f"Failed to load SSH key: {e}")


@pytest.fixture(scope="session")
def smoke_http_client(smoke_base_url):
    """Create httpx client for smoke tests with extended timeout."""
    with httpx.Client(base_url=smoke_base_url, timeout=30.0) as client:
        yield client


@pytest.fixture(scope="session")
def smoke_authed_headers(smoke_request_signer):
    """Factory fixture to generate auth headers for requests.

    Usage:
        headers = smoke_authed_headers("GET", "/api/endpoint", host="example.com")
    """

    def _make_headers(
        method: str,
        path: str,
        body: bytes | None = None,
        host: str | None = None,
    ) -> dict[str, str]:
        """Generate signed request headers.

        Args:
            method: HTTP method (GET, POST, etc.)
            path: Request path (must start with /)
            body: Optional request body for POST/PUT requests
            host: Host header value (defaults to localhost)

        Returns:
            Dictionary of signed headers ready to send with request
        """
        return smoke_request_signer.sign_request(method, path, body=body, host=host or "localhost")

    return _make_headers


@pytest.fixture(scope="session")
def smoke_authed_get(smoke_http_client, smoke_base_url, smoke_authed_headers):
    """Helper fixture for authenticated GET requests.

    Usage:
        response = smoke_authed_get("/api/v1/content")
        assert response.status_code == 200
    """
    parsed = urlparse(smoke_base_url)
    host = parsed.netloc or "localhost"

    def _get(path: str) -> httpx.Response:
        """Execute authenticated GET request.

        Args:
            path: Request path (must start with /)

        Returns:
            httpx.Response object
        """
        headers = smoke_authed_headers("GET", path, host=host)
        return smoke_http_client.get(path, headers=headers)

    return _get


@pytest.fixture(scope="session")
def smoke_first_content_id(smoke_authed_get):
    """Get the first content item ID from the database.

    Returns:
        Content item ID string

    Raises:
        pytest.skip: If no content items exist
    """
    response = smoke_authed_get("/api/v1/content?limit=1")
    assert response.status_code == 200, f"Failed to fetch content: {response.status_code}"

    data = response.json()
    items = data.get("items", [])

    if not items:
        pytest.skip("No content items in database")

    return items[0]["id"]


@pytest.fixture(scope="session")
def smoke_first_youtube_content_id(smoke_authed_get):
    """Get the first YouTube content ID from the database.

    Returns:
        Content ID string for a YouTube item

    Raises:
        pytest.skip: If no YouTube content exists
    """
    response = smoke_authed_get("/api/v1/content?content_type=youtube&exclude_tags=")
    assert response.status_code == 200, f"Failed to fetch YouTube content: {response.status_code}"

    data = response.json()
    items = data.get("items", [])

    if not items:
        pytest.skip("No YouTube content in database")

    return items[0]["id"]


@pytest.fixture(scope="session")
def smoke_first_entity_id(smoke_authed_get):
    """Get the first entity ID from the database.

    Returns:
        Entity ID string

    Raises:
        pytest.skip: If no entities exist
    """
    response = smoke_authed_get("/api/v1/entities?limit=1")
    assert response.status_code == 200, f"Failed to fetch entities: {response.status_code}"

    data = response.json()
    items = data.get("items", [])

    if not items:
        pytest.skip("No entities in database")

    return items[0]["id"]


@pytest.fixture(scope="session")
def surreal_db(smoke_base_url):
    """Direct SurrealDB connection, derived from API base URL host.

    Uses SMOKE_SURREALDB_PORT (default 8080) and credentials from menos.config.
    """
    parsed = urlparse(smoke_base_url)
    host = parsed.hostname
    port = os.environ.get("SMOKE_SURREALDB_PORT", "8080")
    surreal_url = f"http://{host}:{port}"

    try:
        db = Surreal(surreal_url)
        db.signin({"username": settings.surrealdb_user, "password": settings.surrealdb_password})
        db.use(settings.surrealdb_namespace, settings.surrealdb_database)
        return db
    except Exception as e:
        pytest.skip(f"Cannot connect to SurrealDB at {surreal_url}: {e}")


@pytest.fixture(scope="session")
def minio_client():
    """Direct S3-compatible client using settings from .env."""
    try:
        raw_endpoint = settings.s3_endpoint_url.strip()
        parsed = urlparse(raw_endpoint if "://" in raw_endpoint else f"http://{raw_endpoint}")
        endpoint = parsed.netloc or parsed.path
        secure = settings.s3_secure
        if parsed.scheme in {"http", "https"}:
            secure = parsed.scheme == "https"

        client = Minio(
            endpoint,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            secure=secure,
            region=settings.s3_region,
        )
        client.list_buckets()  # test connectivity
        return client
    except Exception as e:
        pytest.skip(f"Cannot connect to S3 at {settings.s3_endpoint_url}: {e}")


def pytest_configure(config):
    """Register custom markers for smoke tests."""
    config.addinivalue_line("markers", "smoke: mark test as smoke test (requires live API)")
