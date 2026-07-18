"""Unit tests for enriched content detail endpoint."""

from menos.models import ContentMetadata


class TestContentDetail:
    def test_happy_path_with_pipeline(self, authed_client, mock_surreal_repo):
        """Returns enriched content with pipeline fields."""
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c1",
            content_type="youtube",
            title="Test Video",
            mime_type="text/plain",
            file_size=5000,
            file_path="youtube/abc/transcript.txt",
            tags=["python"],
            metadata={
                "video_id": "abc",
                "processing_status": "completed",
                "unified_result": {
                    "summary": "A great video about Python",
                    "tier": "A",
                    "quality_score": 85,
                    "tags": ["python", "tutorial"],
                    "topics": [
                        {
                            "name": "Python",
                            "entity_type": "topic",
                            "confidence": "high",
                            "edge_type": "discusses",
                        }
                    ],
                    "additional_entities": [
                        {
                            "name": "pytest",
                            "entity_type": "tool",
                            "confidence": "high",
                            "edge_type": "uses",
                        }
                    ],
                },
            },
        )

        resp = authed_client.get("/api/v1/content/c1")

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "c1"
        assert data["title"] == "Test Video"
        assert data["processing_status"] == "completed"
        assert data["summary"] == "A great video about Python"
        assert data["quality_tier"] == "A"
        assert data["quality_score"] == 85
        assert data["pipeline_tags"] == ["python", "tutorial"]
        assert data["topics"] == ["Python"]
        assert data["entities"] == ["pytest"]
        assert data["mime_type"] == "text/plain"
        assert data["file_size"] == 5000

    def test_no_pipeline_results(self, authed_client, mock_surreal_repo):
        """Returns None for pipeline fields when not yet processed."""
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c2",
            content_type="markdown",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=200,
            file_path="markdown/c2/doc.md",
            metadata={},
        )

        resp = authed_client.get("/api/v1/content/c2")

        assert resp.status_code == 200
        data = resp.json()
        assert data["processing_status"] is None
        assert data["summary"] is None
        assert data["quality_tier"] is None
        assert data["pipeline_tags"] == []
        assert data["topics"] == []

    def test_not_found(self, authed_client, mock_surreal_repo):
        """Returns proper HTTP 404 for missing content."""
        mock_surreal_repo.get_content.return_value = None

        resp = authed_client.get("/api/v1/content/nonexistent")

        assert resp.status_code == 404

    def test_delete_not_found(self, authed_client, mock_surreal_repo):
        """DELETE returns proper HTTP 404 for missing content."""
        mock_surreal_repo.get_content.return_value = None

        resp = authed_client.delete("/api/v1/content/nonexistent")

        assert resp.status_code == 404
