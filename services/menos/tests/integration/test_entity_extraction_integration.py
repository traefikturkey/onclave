"""Integration tests for pipeline orchestrator wiring into ingest routes."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

from menos.models import ContentMetadata, PipelineJob
from menos.services.url_detector import DetectedURL


class TestYouTubeIngestPipelineIntegration:
    """End-to-end mock test verifying ingest calls pipeline orchestrator."""

    def test_ingest_video_submits_to_pipeline_orchestrator(
        self,
        authed_client,
        mock_surreal_repo,
        mock_youtube_service,
        mock_metadata_service,
        mock_minio_storage,
        mock_pipeline_orchestrator,
    ):
        """Full chain: ingest -> orchestrator.submit called with correct args."""
        mock_transcript = MagicMock()
        mock_transcript.video_id = "integration_vid"
        mock_transcript.language = "en"
        mock_transcript.segments = [
            MagicMock(text="Deep dive into RAG", start=0.0, duration=5.0),
        ]
        mock_transcript.full_text = "Deep dive into RAG pipelines " * 50
        mock_transcript.timestamped_text = "[00:00] Deep dive into RAG pipelines"
        mock_youtube_service.extract_video_id.return_value = "integration_vid"
        mock_youtube_service.fetch_transcript.return_value = mock_transcript
        mock_metadata_service.fetch_metadata.side_effect = ValueError("No API key")

        created_content = ContentMetadata(
            id="int_content1",
            content_type="youtube",
            title="YouTube: integration_vid",
            mime_type="text/plain",
            file_size=2000,
            file_path="youtube/integration_vid/transcript.txt",
            author="test_user",
            created_at=datetime.now(UTC),
        )
        mock_surreal_repo.create_content = AsyncMock(return_value=created_content)

        submitted_job = PipelineJob(
            id="pipeline-job-1",
            resource_key="yt:integration_vid",
            content_id="int_content1",
        )
        mock_pipeline_orchestrator.submit = AsyncMock(return_value=submitted_job)

        with patch(
            "menos.routers.ingest.URLDetector.classify_url",
            return_value=DetectedURL(
                url="https://www.youtube.com/watch?v=integration_vid",
                url_type="youtube",
                extracted_id="integration_vid",
            ),
        ):
            response = authed_client.post(
                "/api/v1/ingest",
                json={"url": "https://www.youtube.com/watch?v=integration_vid"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["content_id"] == "int_content1"
        assert data["content_type"] == "youtube"
        assert data["title"] == "YouTube: integration_vid"
        assert data["job_id"] == "pipeline-job-1"

        # Verify orchestrator was called with correct args
        mock_pipeline_orchestrator.submit.assert_called_once_with(
            "int_content1",
            mock_transcript.full_text,
            "youtube",
            "YouTube: integration_vid",
            "yt:integration_vid",
        )
