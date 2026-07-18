"""Unit tests for graph router related-content endpoint."""

from unittest.mock import AsyncMock

from menos.models import ContentMetadata, RelatedContent


def _make_content(content_id: str = "c1") -> ContentMetadata:
    return ContentMetadata(
        id=content_id,
        content_type="document",
        title="Test Doc",
        mime_type="text/plain",
        file_size=100,
        file_path=f"document/{content_id}/test.txt",
    )


class TestRelatedContentEndpoint:
    """Tests for GET /api/v1/content/{content_id}/related."""

    def test_related_content_requires_auth(self, client):
        resp = client.get("/api/v1/content/c1/related")
        assert resp.status_code == 401

    def test_related_content_returns_404_when_source_missing(
        self, authed_client, mock_surreal_repo
    ):
        mock_surreal_repo.get_content = AsyncMock(return_value=None)

        resp = authed_client.get("/api/v1/content/missing/related")

        assert resp.status_code == 404
        assert resp.json()["detail"] == "Content not found"

    def test_related_content_returns_empty_list(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content = AsyncMock(return_value=_make_content("c1"))
        mock_surreal_repo.get_related_content = AsyncMock(return_value=[])

        resp = authed_client.get("/api/v1/content/c1/related")

        assert resp.status_code == 200
        assert resp.json() == []
        mock_surreal_repo.get_related_content.assert_awaited_once_with(
            content_id="c1", limit=10, window="12m"
        )

    def test_related_content_response_includes_shared_entities(
        self, authed_client, mock_surreal_repo
    ):
        mock_surreal_repo.get_content = AsyncMock(return_value=_make_content("c1"))
        mock_surreal_repo.get_related_content = AsyncMock(
            return_value=[
                RelatedContent(
                    content_id="c2",
                    title="Related",
                    content_type="youtube",
                    shared_entity_count=3,
                    shared_entities=["topic:python", "repo:uv", "person:astral"],
                )
            ]
        )

        resp = authed_client.get("/api/v1/content/c1/related")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["content_id"] == "c2"
        assert data[0]["shared_entity_count"] == 3
        assert data[0]["shared_entities"] == ["topic:python", "repo:uv", "person:astral"]

    def test_related_content_validates_limit_bounds(self, authed_client):
        resp_low = authed_client.get("/api/v1/content/c1/related", params={"limit": 0})
        resp_high = authed_client.get("/api/v1/content/c1/related", params={"limit": 51})

        assert resp_low.status_code == 422
        assert resp_high.status_code == 422

    def test_related_content_validates_window(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content = AsyncMock(return_value=_make_content("c1"))
        mock_surreal_repo.get_related_content = AsyncMock(return_value=[])

        resp_invalid = authed_client.get("/api/v1/content/c1/related", params={"window": "12x"})
        resp_zero = authed_client.get("/api/v1/content/c1/related", params={"window": "0"})
        resp_duration = authed_client.get("/api/v1/content/c1/related", params={"window": "8w"})

        assert resp_invalid.status_code == 422
        assert resp_zero.status_code == 200
        assert resp_duration.status_code == 200
        mock_surreal_repo.get_related_content.assert_any_await(
            content_id="c1", limit=10, window="0"
        )
        mock_surreal_repo.get_related_content.assert_any_await(
            content_id="c1", limit=10, window="8w"
        )
