"""Unit tests for content download endpoint."""

from menos.models import ContentMetadata


class TestContentDownload:
    def test_happy_path(self, authed_client, mock_surreal_repo, mock_minio_storage):
        """Downloads file with correct content type and disposition."""
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c1",
            content_type="markdown",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="markdown/c1/document.md",
        )
        mock_minio_storage.download.return_value = b"# Hello World"

        resp = authed_client.get("/api/v1/content/c1/download")

        assert resp.status_code == 200
        assert resp.content == b"# Hello World"
        assert "text/markdown" in resp.headers.get("content-type", "")
        assert 'filename="document.md"' in resp.headers.get(
            "content-disposition", ""
        )

    def test_content_not_found(self, authed_client, mock_surreal_repo):
        """Returns 404 for unknown content ID."""
        mock_surreal_repo.get_content.return_value = None

        resp = authed_client.get("/api/v1/content/nonexistent/download")

        assert resp.status_code == 404

    def test_file_missing_in_storage(
        self, authed_client, mock_surreal_repo, mock_minio_storage
    ):
        """Returns 404 when MinIO file is missing."""
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c1",
            content_type="markdown",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="markdown/c1/document.md",
        )
        mock_minio_storage.download.side_effect = RuntimeError(
            "MinIO download failed"
        )

        resp = authed_client.get("/api/v1/content/c1/download")

        assert resp.status_code == 404

    def test_auth_required(self, client):
        """Returns 401 without authentication."""
        resp = client.get("/api/v1/content/c1/download")

        assert resp.status_code == 401
