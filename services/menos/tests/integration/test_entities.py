"""Integration tests for entity endpoints."""

from unittest.mock import AsyncMock

from menos.models import EntityModel, EntitySource, EntityType


class TestEntityEndpointsAuth:
    """Tests for entity endpoint authentication."""

    def test_entities_list_requires_auth(self, client):
        """Test that entity list requires authentication."""
        from fastapi.testclient import TestClient

        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.get("/api/v1/entities")

        assert response.status_code == 401

    def test_entity_get_requires_auth(self, client):
        """Test that entity get requires authentication."""
        from fastapi.testclient import TestClient

        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.get("/api/v1/entities/test123")

        assert response.status_code == 401

    def test_entity_delete_requires_auth(self, client):
        """Test that entity delete requires authentication."""
        from fastapi.testclient import TestClient

        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.delete("/api/v1/entities/test123")

        assert response.status_code == 401


class TestEntityListEndpoint:
    """Tests for entity list endpoint."""

    def test_list_entities_empty(self, authed_client, mock_surreal_repo):
        """Test listing entities when none exist."""
        mock_surreal_repo.list_entities = AsyncMock(return_value=([], 0))

        response = authed_client.get("/api/v1/entities")

        assert response.status_code == 200
        data = response.json()
        assert data["items"] == []
        assert data["total"] == 0

    def test_list_entities_with_results(self, authed_client, mock_surreal_repo):
        """Test listing entities with results."""
        from datetime import datetime

        entities = [
            EntityModel(
                id="test1",
                entity_type=EntityType.TOPIC,
                name="Machine Learning",
                normalized_name="machinelearning",
                source=EntitySource.AI_EXTRACTED,
                created_at=datetime.now(),
            ),
            EntityModel(
                id="test2",
                entity_type=EntityType.REPO,
                name="LangChain",
                normalized_name="langchain",
                source=EntitySource.URL_DETECTED,
                created_at=datetime.now(),
            ),
        ]
        mock_surreal_repo.list_entities = AsyncMock(return_value=(entities, 2))

        response = authed_client.get("/api/v1/entities")

        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 2
        assert data["items"][0]["name"] == "Machine Learning"
        assert data["items"][1]["name"] == "LangChain"

    def test_list_entities_filter_by_type(self, authed_client, mock_surreal_repo):
        """Test listing entities filtered by type."""
        from datetime import datetime

        entities = [
            EntityModel(
                id="test1",
                entity_type=EntityType.REPO,
                name="LangChain",
                normalized_name="langchain",
                source=EntitySource.URL_DETECTED,
                created_at=datetime.now(),
            ),
        ]
        mock_surreal_repo.list_entities = AsyncMock(return_value=(entities, 1))

        response = authed_client.get("/api/v1/entities", params={"entity_type": "repo"})

        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["entity_type"] == "repo"

    def test_list_entities_invalid_type(self, authed_client):
        """Test listing entities with invalid type returns 400."""
        response = authed_client.get("/api/v1/entities", params={"entity_type": "invalid"})

        assert response.status_code == 400


class TestEntityGetEndpoint:
    """Tests for entity get endpoint."""

    def test_get_entity_not_found(self, authed_client, mock_surreal_repo):
        """Test getting non-existent entity."""
        mock_surreal_repo.get_entity = AsyncMock(return_value=None)

        response = authed_client.get("/api/v1/entities/nonexistent")

        assert response.status_code == 404

    def test_get_entity_success(self, authed_client, mock_surreal_repo):
        """Test getting existing entity."""
        from datetime import datetime

        entity = EntityModel(
            id="test1",
            entity_type=EntityType.TOPIC,
            name="Machine Learning",
            normalized_name="machinelearning",
            hierarchy=["AI", "Machine Learning"],
            source=EntitySource.AI_EXTRACTED,
            created_at=datetime.now(),
        )
        mock_surreal_repo.get_entity = AsyncMock(return_value=entity)

        response = authed_client.get("/api/v1/entities/test1")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "test1"
        assert data["name"] == "Machine Learning"
        assert data["hierarchy"] == ["AI", "Machine Learning"]


class TestEntityContentEndpoint:
    """Tests for entity content endpoint."""

    def test_get_entity_content_not_found(self, authed_client, mock_surreal_repo):
        """Test getting content for non-existent entity."""
        mock_surreal_repo.get_entity = AsyncMock(return_value=None)

        response = authed_client.get("/api/v1/entities/nonexistent/content")

        assert response.status_code == 404

    def test_get_entity_content_empty(self, authed_client, mock_surreal_repo):
        """Test getting content for entity with no links."""
        from datetime import datetime

        entity = EntityModel(
            id="test1",
            entity_type=EntityType.TOPIC,
            name="ML",
            normalized_name="ml",
            source=EntitySource.AI_EXTRACTED,
            created_at=datetime.now(),
        )
        mock_surreal_repo.get_entity = AsyncMock(return_value=entity)
        mock_surreal_repo.get_content_for_entity = AsyncMock(return_value=[])

        response = authed_client.get("/api/v1/entities/test1/content")

        assert response.status_code == 200
        data = response.json()
        assert data["items"] == []


class TestEntityUpdateEndpoint:
    """Tests for entity update endpoint."""

    def test_update_entity_not_found(self, authed_client, mock_surreal_repo):
        """Test updating non-existent entity."""
        mock_surreal_repo.get_entity = AsyncMock(return_value=None)

        response = authed_client.client.patch(
            "/api/v1/entities/nonexistent",
            json={"name": "New Name"},
            headers=authed_client.signer.sign_request(
                "PATCH", "/api/v1/entities/nonexistent", host="testserver"
            ),
        )

        assert response.status_code == 404

    def test_update_entity_no_changes(self, authed_client, mock_surreal_repo):
        """Test updating entity with no changes."""
        from datetime import datetime

        entity = EntityModel(
            id="test1",
            entity_type=EntityType.TOPIC,
            name="ML",
            normalized_name="ml",
            source=EntitySource.AI_EXTRACTED,
            created_at=datetime.now(),
        )
        mock_surreal_repo.get_entity = AsyncMock(return_value=entity)

        response = authed_client.client.patch(
            "/api/v1/entities/test1",
            json={},
            headers=authed_client.signer.sign_request(
                "PATCH", "/api/v1/entities/test1", host="testserver"
            ),
        )

        assert response.status_code == 400


class TestEntityDeleteEndpoint:
    """Tests for entity delete endpoint."""

    def test_delete_entity_not_found(self, authed_client, mock_surreal_repo):
        """Test deleting non-existent entity."""
        mock_surreal_repo.get_entity = AsyncMock(return_value=None)

        response = authed_client.delete("/api/v1/entities/nonexistent")

        assert response.status_code == 404

    def test_delete_entity_success(self, authed_client, mock_surreal_repo):
        """Test deleting existing entity."""
        from datetime import datetime

        entity = EntityModel(
            id="test1",
            entity_type=EntityType.TOPIC,
            name="ML",
            normalized_name="ml",
            source=EntitySource.AI_EXTRACTED,
            created_at=datetime.now(),
        )
        mock_surreal_repo.get_entity = AsyncMock(return_value=entity)
        mock_surreal_repo.delete_entity = AsyncMock()

        response = authed_client.delete("/api/v1/entities/test1")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "deleted"
        assert data["id"] == "test1"


class TestTopicHierarchyEndpoint:
    """Tests for topic hierarchy endpoint."""

    def test_get_topic_hierarchy_empty(self, authed_client, mock_surreal_repo):
        """Test getting topic hierarchy when no topics exist."""
        mock_surreal_repo.get_topic_hierarchy = AsyncMock(return_value=[])

        response = authed_client.get("/api/v1/entities/topics")

        assert response.status_code == 200
        data = response.json()
        assert data["topics"] == []

    def test_get_topic_hierarchy_with_topics(self, authed_client, mock_surreal_repo):
        """Test getting topic hierarchy with topics."""
        from datetime import datetime

        topics = [
            EntityModel(
                id="ai",
                entity_type=EntityType.TOPIC,
                name="AI",
                normalized_name="ai",
                hierarchy=["AI"],
                source=EntitySource.AI_EXTRACTED,
                created_at=datetime.now(),
            ),
            EntityModel(
                id="llms",
                entity_type=EntityType.TOPIC,
                name="LLMs",
                normalized_name="llms",
                hierarchy=["AI", "LLMs"],
                source=EntitySource.AI_EXTRACTED,
                created_at=datetime.now(),
            ),
        ]
        mock_surreal_repo.get_topic_hierarchy = AsyncMock(return_value=topics)

        response = authed_client.get("/api/v1/entities/topics")

        assert response.status_code == 200
        data = response.json()
        # AI is a root topic
        assert len(data["topics"]) >= 1


class TestDuplicatesEndpoint:
    """Tests for potential duplicates endpoint."""

    def test_get_duplicates_empty(self, authed_client, mock_surreal_repo):
        """Test getting duplicates when none exist."""
        mock_surreal_repo.find_potential_duplicates = AsyncMock(return_value=[])

        response = authed_client.get("/api/v1/entities/duplicates")

        assert response.status_code == 200
        data = response.json()
        assert data["groups"] == []

    def test_get_duplicates_with_results(self, authed_client, mock_surreal_repo):
        """Test getting duplicates with results."""
        from datetime import datetime

        group = [
            EntityModel(
                id="ml1",
                entity_type=EntityType.TOPIC,
                name="Machine Learning",
                normalized_name="machinelearning",
                source=EntitySource.AI_EXTRACTED,
                created_at=datetime.now(),
            ),
            EntityModel(
                id="ml2",
                entity_type=EntityType.TOPIC,
                name="MachineLearning",
                normalized_name="machinelearning",
                source=EntitySource.AI_EXTRACTED,
                created_at=datetime.now(),
            ),
        ]
        mock_surreal_repo.find_potential_duplicates = AsyncMock(return_value=[group])

        response = authed_client.get("/api/v1/entities/duplicates")

        assert response.status_code == 200
        data = response.json()
        assert len(data["groups"]) == 1
        assert len(data["groups"][0]["entities"]) == 2
