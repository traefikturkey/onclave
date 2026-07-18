"""Smoke tests for production services."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.smoke


class TestSurrealDBConnection:
    def test_can_connect_and_authenticate(self, surreal_db):
        """Verify SurrealDB is reachable and accepts credentials."""
        result = surreal_db.query("SELECT * FROM content LIMIT 1")
        assert result is not None

    def test_can_query_content_table(self, surreal_db):
        result = surreal_db.query("SELECT count() FROM content GROUP ALL")
        assert result is not None

    def test_can_query_with_filter(self, surreal_db):
        result = surreal_db.query(
            "SELECT * FROM content WHERE content_type = 'youtube' LIMIT 1"
        )
        assert result is not None

    def test_can_query_with_order_by(self, surreal_db):
        result = surreal_db.query(
            "SELECT * FROM content ORDER BY created_at DESC LIMIT 1"
        )
        assert result is not None


class TestMinIOConnection:
    def test_can_connect_and_list_bucket(self, minio_client):
        """Verify MinIO is reachable and bucket exists."""
        buckets = minio_client.list_buckets()
        bucket_names = [b.name for b in buckets]
        assert "menos" in bucket_names

    def test_can_read_a_file(self, minio_client):
        """Verify we can download a transcript file."""
        objects = list(
            minio_client.list_objects("menos", prefix="youtube/", recursive=False)
        )
        assert len(objects) > 0, "No youtube/ prefixes found in bucket"

        # Get first video directory
        first_prefix = objects[0].object_name
        video_id = first_prefix.rstrip("/").split("/")[-1]

        # Download transcript
        transcript_path = f"youtube/{video_id}/transcript.txt"
        response = minio_client.get_object("menos", transcript_path)
        data = response.read()
        response.close()
        response.release_conn()
        assert len(data) > 0


class TestAPIConnection:
    def test_health_endpoint(self, smoke_http_client):
        response = smoke_http_client.get("/health")
        assert response.status_code == 200

    def test_ready_endpoint(self, smoke_http_client):
        response = smoke_http_client.get("/ready")
        assert response.status_code == 200

    def test_authenticated_content_list(self, smoke_authed_get):
        response = smoke_authed_get("/api/v1/content?limit=1")
        assert response.status_code == 200


class TestQueryScriptEndToEnd:
    """Tests for query.py script (requires PYTHONPATH and SurrealDB access)."""

    @staticmethod
    def _script_env() -> dict[str, str]:
        """Build env with PYTHONPATH set to api/ directory."""
        api_dir = str(Path(__file__).resolve().parent.parent.parent)
        return {**os.environ, "PYTHONPATH": api_dir}

    @staticmethod
    def _api_dir() -> str:
        return str(Path(__file__).resolve().parent.parent.parent)

    def test_select_query_returns_results(self):
        result = subprocess.run(
            [sys.executable, "scripts/query.py", "SELECT * FROM content LIMIT 1"],
            capture_output=True,
            text=True,
            cwd=self._api_dir(),
            env=self._script_env(),
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert len(result.stdout.strip()) > 0

    def test_json_output_is_valid(self):
        result = subprocess.run(
            [
                sys.executable,
                "scripts/query.py",
                "--json",
                "SELECT * FROM content LIMIT 1",
            ],
            capture_output=True,
            text=True,
            cwd=self._api_dir(),
            env=self._script_env(),
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        parsed = json.loads(result.stdout)
        assert isinstance(parsed, list)

    def test_dangerous_query_rejected(self):
        result = subprocess.run(
            [sys.executable, "scripts/query.py", "DELETE FROM content"],
            capture_output=True,
            text=True,
            cwd=self._api_dir(),
            env=self._script_env(),
        )
        assert result.returncode == 1
