"""Shared test fixtures."""

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from fastapi.testclient import TestClient

from menos.client.signer import RequestSigner
from menos.services.di import (
    get_docling_client,
    get_job_repository,
    get_minio_storage,
    get_pipeline_orchestrator,
    get_surreal_repo,
)
from menos.services.docling import DoclingResult
from menos.services.embeddings import EmbeddingService, get_embedding_service
from menos.services.youtube import get_youtube_service
from menos.services.youtube_metadata import get_youtube_metadata_service


@pytest.fixture
def ed25519_keypair():
    """Generate ephemeral ed25519 keypair for testing."""
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return private_key, public_key


@pytest.fixture
def request_signer(ed25519_keypair):
    """Create a RequestSigner from test keypair."""
    private_key, _ = ed25519_keypair
    return RequestSigner.from_private_key(private_key)


@pytest.fixture
def keys_dir(ed25519_keypair):
    """Create temp directory with authorized_keys file."""
    _, public_key = ed25519_keypair

    # Get OpenSSH format public key
    public_ssh = public_key.public_bytes(
        encoding=Encoding.OpenSSH,
        format=PublicFormat.OpenSSH,
    ).decode()

    with tempfile.TemporaryDirectory() as tmpdir:
        keys_path = Path(tmpdir)
        auth_keys = keys_path / "authorized_keys"
        auth_keys.write_text(f"{public_ssh} test@localhost\n")
        yield keys_path


@pytest.fixture
def private_key_file(ed25519_keypair):
    """Create temp file with private key in OpenSSH format."""
    private_key, _ = ed25519_keypair

    private_ssh = private_key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.OpenSSH,
        encryption_algorithm=NoEncryption(),
    )

    with tempfile.NamedTemporaryFile(mode="wb", suffix=".key", delete=False) as f:
        f.write(private_ssh)
        f.flush()
        yield Path(f.name)


@pytest.fixture
def mock_surreal_repo():
    """Mock SurrealDB repository."""
    repo = MagicMock()
    repo.connect = AsyncMock()
    repo.list_content = AsyncMock(return_value=([], 0))
    repo.get_content = AsyncMock(return_value=None)
    repo.create_content = AsyncMock()
    repo.delete_content = AsyncMock()
    repo.get_chunks = AsyncMock(return_value=[])
    repo.create_chunk = AsyncMock()
    repo.vector_search = AsyncMock(return_value=[])
    repo.get_graph_data = AsyncMock(return_value=([], []))
    repo.get_neighborhood = AsyncMock(return_value=([], []))
    repo.update_content_extraction_status = AsyncMock()
    repo.find_content_by_resource_key = AsyncMock(return_value=None)
    repo.get_chunk_counts = AsyncMock(return_value={})
    repo.find_content_by_video_id = AsyncMock(return_value=None)
    return repo


@pytest.fixture
def mock_embedding_service():
    """Mock embedding service."""
    service = MagicMock(spec=EmbeddingService)
    service.embed = AsyncMock(return_value=[0.1] * 1024)
    service.embed_batch = AsyncMock(return_value=[[0.1] * 1024])
    service.close = AsyncMock()
    return service


@pytest.fixture
def mock_minio_storage():
    """Mock MinIO storage."""
    storage = MagicMock()
    storage.upload = AsyncMock(return_value=100)
    storage.download = AsyncMock(return_value=b"test content")
    storage.delete = AsyncMock()
    storage.exists = AsyncMock(return_value=True)
    return storage


@pytest.fixture
def mock_youtube_service():
    """Mock YouTube service."""
    service = MagicMock()
    service.extract_video_id = MagicMock(return_value="test_video")
    service.fetch_transcript = MagicMock()
    return service


@pytest.fixture
def mock_metadata_service():
    """Mock YouTube metadata service."""
    service = MagicMock()
    service.fetch_metadata = MagicMock()
    return service


@pytest.fixture
def mock_pipeline_orchestrator():
    """Mock pipeline orchestrator."""
    orchestrator = MagicMock()
    orchestrator.submit = AsyncMock(return_value=None)
    return orchestrator


@pytest.fixture
def mock_docling_client():
    """Mock Docling client."""
    client = MagicMock()
    client.extract_markdown = AsyncMock(
        return_value=DoclingResult(markdown="# Title\nBody", title="Title")
    )
    return client


@pytest.fixture
def mock_job_repository():
    """Mock job repository."""
    repo = MagicMock()
    repo.create_job = AsyncMock()
    repo.get_job = AsyncMock()
    repo.find_active_job_by_resource_key = AsyncMock(return_value=None)
    repo.update_job_status = AsyncMock()
    repo.list_jobs = AsyncMock(return_value=([], 0))
    return repo


@pytest.fixture
def app_with_keys(
    keys_dir,
    monkeypatch,
    mock_surreal_repo,
    mock_embedding_service,
    mock_minio_storage,
    mock_youtube_service,
    mock_metadata_service,
    mock_pipeline_orchestrator,
    mock_job_repository,
    mock_docling_client,
):
    """Create FastAPI app with test keys configured."""
    monkeypatch.setenv("SSH_PUBLIC_KEYS_PATH", str(keys_dir))

    # Reset the key store singleton
    import menos.auth.dependencies as deps

    deps._key_store = None

    # Reload settings with new env
    from menos.config import Settings

    monkeypatch.setattr("menos.config.settings", Settings())
    monkeypatch.setattr("menos.auth.dependencies.settings", Settings())

    from menos.main import app

    # Override dependencies with mocks
    app.dependency_overrides[get_surreal_repo] = lambda: mock_surreal_repo
    app.dependency_overrides[get_embedding_service] = lambda: mock_embedding_service
    app.dependency_overrides[get_minio_storage] = lambda: mock_minio_storage
    app.dependency_overrides[get_youtube_service] = lambda: mock_youtube_service
    app.dependency_overrides[get_youtube_metadata_service] = lambda: mock_metadata_service
    app.dependency_overrides[get_pipeline_orchestrator] = lambda: mock_pipeline_orchestrator
    app.dependency_overrides[get_job_repository] = lambda: mock_job_repository
    app.dependency_overrides[get_docling_client] = lambda: mock_docling_client

    yield app

    # Clean up overrides
    app.dependency_overrides.clear()


@pytest.fixture
def client(app_with_keys):
    """TestClient with auth keys configured."""
    return TestClient(app_with_keys)


@pytest.fixture
def authed_client(client, request_signer):
    """TestClient wrapper that auto-signs requests."""
    return AuthedTestClient(client, request_signer)


class AuthedTestClient:
    """TestClient wrapper that signs requests."""

    def __init__(self, client: TestClient, signer: RequestSigner):
        self.client = client
        self.signer = signer

    def get(self, path: str, **kwargs):
        # Build full path with query params for signature
        params = kwargs.get("params")
        sign_path = path
        if params:
            from urllib.parse import urlencode

            query_string = urlencode(params)
            sign_path = f"{path}?{query_string}"

        headers = self.signer.sign_request("GET", sign_path, host="testserver")
        kwargs.setdefault("headers", {}).update(headers)
        return self.client.get(path, **kwargs)

    def post(self, path: str, **kwargs):
        body = kwargs.get("content") or b""
        if kwargs.get("json"):
            import json

            body = json.dumps(kwargs["json"]).encode()
            # TestClient needs content, not json, when we provide content-digest
            kwargs["content"] = body
            kwargs.pop("json")
            kwargs.setdefault("headers", {})["content-type"] = "application/json"
        sig_body = body if body else None
        headers = self.signer.sign_request("POST", path, body=sig_body, host="testserver")
        kwargs.setdefault("headers", {}).update(headers)
        return self.client.post(path, **kwargs)

    def put(self, path: str, **kwargs):
        body = kwargs.get("content") or b""
        headers = self.signer.sign_request("PUT", path, body=body, host="testserver")
        kwargs.setdefault("headers", {}).update(headers)
        return self.client.put(path, **kwargs)

    def delete(self, path: str, **kwargs):
        headers = self.signer.sign_request("DELETE", path, host="testserver")
        kwargs.setdefault("headers", {}).update(headers)
        return self.client.delete(path, **kwargs)
