"""Tests for unified pipeline response parser."""

from unittest.mock import MagicMock

import pytest

from menos.models import EdgeType, EntityType, UnifiedResult
from menos.services.unified_pipeline import parse_unified_response


@pytest.fixture
def mock_settings():
    """Create mock settings for unified pipeline."""
    s = MagicMock()
    s.unified_pipeline_max_new_tags = 3
    s.entity_max_topics_per_content = 7
    s.entity_min_confidence = 0.6
    return s


@pytest.fixture
def existing_tags():
    """Existing tags in the vault."""
    return ["programming", "kubernetes", "devops", "python"]


@pytest.fixture
def valid_payload():
    """A valid unified LLM response payload."""
    return {
        "tags": ["programming", "kubernetes"],
        "new_tags": ["homelab"],
        "tier": "B",
        "tier_explanation": ["Reason 1", "Reason 2"],
        "quality_score": 55,
        "score_explanation": ["Reason 1", "Reason 2"],
        "summary": "2-3 sentence overview.\n\n- Bullet 1\n- Bullet 2",
        "topics": [
            {"name": "AI > LLMs > RAG", "confidence": "high", "edge_type": "discusses"}
        ],
        "pre_detected_validations": [
            {"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": True}
        ],
        "additional_entities": [
            {"type": "repo", "name": "FAISS", "confidence": "medium", "edge_type": "mentions"}
        ],
    }


class TestValidParsing:
    """Test parsing of a valid unified response payload."""

    def test_returns_unified_result(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert result is not None
        assert isinstance(result, UnifiedResult)

    def test_tags_parsed(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert "programming" in result.tags
        assert "kubernetes" in result.tags

    def test_new_tags_included(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert "homelab" in result.tags

    def test_new_tags_tracked(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert "homelab" in result.new_tags

    def test_tier_parsed(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert result.tier == "B"

    def test_tier_explanation_parsed(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert result.tier_explanation == ["Reason 1", "Reason 2"]

    def test_quality_score_parsed(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert result.quality_score == 55

    def test_score_explanation_parsed(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert result.score_explanation == ["Reason 1", "Reason 2"]

    def test_summary_parsed(self, valid_payload, existing_tags, mock_settings):
        result = parse_unified_response(valid_payload, existing_tags, mock_settings)
        assert "overview" in result.summary
        assert "- Bullet 1" in result.summary


class TestTagValidation:
    """Test tag format validation (^[a-z][a-z0-9-]*$)."""

    def test_valid_tags_accepted(self, existing_tags, mock_settings):
        data = {
            "tags": ["valid-tag", "ok"],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "valid-tag" in result.tags
        assert "ok" in result.tags

    def test_uppercase_tags_rejected(self, existing_tags, mock_settings):
        data = {
            "tags": ["UPPERCASE"],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "UPPERCASE" not in result.tags

    def test_tags_with_spaces_rejected(self, existing_tags, mock_settings):
        data = {
            "tags": ["has spaces"],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "has spaces" not in result.tags

    def test_tags_starting_with_number_rejected(self, existing_tags, mock_settings):
        data = {
            "tags": ["123start"],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "123start" not in result.tags

    def test_invalid_new_tags_rejected(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": ["INVALID", "good-tag"],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "INVALID" not in result.tags
        assert "good-tag" in result.tags


class TestTierValidation:
    """Test tier validation (S/A/B/C/D, invalid defaults to C)."""

    @pytest.mark.parametrize("tier", ["S", "A", "B", "C", "D"])
    def test_valid_tiers_accepted(self, tier, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": tier, "quality_score": 50}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.tier == tier

    def test_invalid_tier_defaults_to_c(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "X", "quality_score": 50}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.tier == "C"

    def test_lowercase_tier_uppercased(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "a", "quality_score": 50}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.tier == "A"

    def test_missing_tier_defaults_to_c(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "quality_score": 50}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.tier == "C"


class TestScoreClamping:
    """Test quality score clamping (1-100)."""

    def test_score_above_100_clamped(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "S", "quality_score": 150}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.quality_score == 100

    def test_score_below_1_clamped(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "D", "quality_score": -5}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.quality_score == 1

    def test_score_at_boundary_100(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "S", "quality_score": 100}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.quality_score == 100

    def test_score_at_boundary_1(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "D", "quality_score": 1}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.quality_score == 1

    def test_non_numeric_score_defaults(self, existing_tags, mock_settings):
        data = {"tags": [], "new_tags": [], "tier": "C", "quality_score": "not-a-number"}
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert 1 <= result.quality_score <= 100


class TestNewTagsDedup:
    """Test new_tags deduplication against existing tags."""

    def test_exact_duplicate_mapped_to_existing(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": ["programming"],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "programming" in result.tags
        assert "programming" not in result.new_tags

    def test_near_duplicate_mapped_to_existing(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": ["programing"],  # One letter off
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "programming" in result.tags
        assert "programing" not in result.tags

    def test_genuinely_new_tag_kept(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": ["homelab"],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert "homelab" in result.tags
        assert "homelab" in result.new_tags

    def test_max_new_tags_respected(self, existing_tags, mock_settings):
        mock_settings.unified_pipeline_max_new_tags = 2
        data = {
            "tags": [],
            "new_tags": ["tag-a", "tag-b", "tag-c", "tag-d"],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        genuinely_new = [t for t in result.new_tags]
        assert len(genuinely_new) <= 2


class TestTopicParsing:
    """Test topic hierarchy parsing."""

    def test_topic_hierarchy_parsed(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": [
                {"name": "AI > LLMs > RAG", "confidence": "high", "edge_type": "discusses"}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.topics) == 1
        assert result.topics[0].hierarchy == ["AI", "LLMs", "RAG"]
        assert result.topics[0].name == "RAG"
        assert result.topics[0].entity_type == EntityType.TOPIC

    def test_topic_edge_type_mapped(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": [
                {"name": "Python", "confidence": "high", "edge_type": "discusses"}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.topics[0].edge_type == EdgeType.DISCUSSES

    def test_topic_confidence_preserved(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": [
                {"name": "AI", "confidence": "medium", "edge_type": "discusses"}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.topics[0].confidence == "medium"

    def test_low_confidence_topics_filtered(self, existing_tags, mock_settings):
        mock_settings.entity_min_confidence = 0.6
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": [
                {"name": "AI", "confidence": "high", "edge_type": "discusses"},
                {"name": "Maybe", "confidence": "low", "edge_type": "mentions"},
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.topics) == 1
        assert result.topics[0].name == "AI"

    def test_max_topics_respected(self, existing_tags, mock_settings):
        mock_settings.entity_max_topics_per_content = 2
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": [
                {"name": "A", "confidence": "high", "edge_type": "discusses"},
                {"name": "B", "confidence": "high", "edge_type": "discusses"},
                {"name": "C", "confidence": "high", "edge_type": "discusses"},
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.topics) == 2

    def test_empty_topic_name_skipped(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": [
                {"name": "", "confidence": "high", "edge_type": "discusses"},
                {"name": "Valid", "confidence": "high", "edge_type": "discusses"},
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.topics) == 1
        assert result.topics[0].name == "Valid"


class TestPreDetectedValidations:
    """Test parsing of pre-detected entity validations."""

    def test_validation_parsed(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "pre_detected_validations": [
                {"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": True}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.pre_detected_validations) == 1
        assert result.pre_detected_validations[0].entity_id == "entity:langchain"
        assert result.pre_detected_validations[0].edge_type == EdgeType.USES
        assert result.pre_detected_validations[0].confirmed is True

    def test_unconfirmed_validation(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "pre_detected_validations": [
                {"entity_id": "entity:foo", "edge_type": "mentions", "confirmed": False}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.pre_detected_validations[0].confirmed is False

    def test_missing_entity_id_skipped(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "pre_detected_validations": [
                {"edge_type": "uses", "confirmed": True}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.pre_detected_validations) == 0


class TestAdditionalEntityParsing:
    """Test parsing of additional entities."""

    def test_additional_entity_parsed(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "additional_entities": [
                {"type": "repo", "name": "FAISS", "confidence": "medium",
                 "edge_type": "mentions"}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.additional_entities) == 1
        assert result.additional_entities[0].name == "FAISS"
        assert result.additional_entities[0].entity_type == EntityType.REPO
        assert result.additional_entities[0].edge_type == EdgeType.MENTIONS

    def test_tool_entity_type(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "additional_entities": [
                {"type": "tool", "name": "Docker", "confidence": "high",
                 "edge_type": "uses"}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result.additional_entities[0].entity_type == EntityType.TOOL

    def test_low_confidence_entity_filtered(self, existing_tags, mock_settings):
        mock_settings.entity_min_confidence = 0.6
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "additional_entities": [
                {"type": "repo", "name": "Skip", "confidence": "low",
                 "edge_type": "mentions"},
                {"type": "repo", "name": "Keep", "confidence": "high",
                 "edge_type": "mentions"},
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.additional_entities) == 1
        assert result.additional_entities[0].name == "Keep"

    def test_missing_name_skipped(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "additional_entities": [
                {"type": "repo", "name": "", "confidence": "high",
                 "edge_type": "mentions"}
            ],
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert len(result.additional_entities) == 0


class TestMalformedPayload:
    """Test that malformed payloads return None."""

    def test_empty_dict_returns_none(self, existing_tags, mock_settings):
        result = parse_unified_response({}, existing_tags, mock_settings)
        assert result is None

    def test_missing_required_fields_returns_none(self, existing_tags, mock_settings):
        result = parse_unified_response({"random": "data"}, existing_tags, mock_settings)
        assert result is None

    def test_non_dict_topics_handled(self, existing_tags, mock_settings):
        data = {
            "tags": [],
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
            "topics": "not a list",
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result is not None
        assert result.topics == []

    def test_non_list_tags_handled(self, existing_tags, mock_settings):
        data = {
            "tags": "not a list",
            "new_tags": [],
            "tier": "C",
            "quality_score": 50,
        }
        result = parse_unified_response(data, existing_tags, mock_settings)
        assert result is not None
        assert result.tags == []
