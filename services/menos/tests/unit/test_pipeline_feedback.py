"""Focused tests for pipeline feedback loop behavior."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.services.unified_pipeline import UnifiedPipelineService


def _make_settings():
    settings = MagicMock()
    settings.unified_pipeline_enabled = True
    settings.unified_pipeline_max_new_tags = 3
    settings.entity_max_topics_per_content = 7
    settings.entity_min_confidence = 0.6
    return settings


def _make_llm(payload: dict) -> MagicMock:
    llm = MagicMock()
    llm.model = "test-model"
    llm.generate = AsyncMock(return_value=json.dumps(payload))
    llm.with_context = MagicMock(return_value=llm)
    return llm


def _make_repo() -> MagicMock:
    repo = MagicMock()
    repo.list_tags_with_counts = AsyncMock(return_value=[{"name": "programming", "count": 10}])
    repo.get_topic_hierarchy = AsyncMock(return_value=[])
    repo.get_tag_cooccurrence = AsyncMock(return_value={"python": ["api", "fastapi"]})
    repo.get_tier_distribution = AsyncMock(return_value={"S": 1, "A": 2, "B": 5, "C": 2, "D": 0})
    repo.get_tag_aliases = AsyncMock(return_value={"k8s": "kubernetes"})
    repo.record_tag_alias = AsyncMock()
    return repo


@pytest.mark.asyncio
async def test_prompt_includes_feedback_sections():
    llm = _make_llm(
        {
            "tags": ["programming"],
            "new_tags": [],
            "tier": "B",
            "quality_score": 55,
            "topics": [],
            "pre_detected_validations": [],
            "additional_entities": [],
            "summary": "ok",
        }
    )
    repo = _make_repo()
    service = UnifiedPipelineService(llm_provider=llm, repo=repo, settings=_make_settings())

    await service.process("c1", "text", "markdown", "title", job_id="job-1")

    prompt = llm.generate.call_args.args[0]
    assert "## TAG CO-OCCURRENCE PATTERNS" in prompt
    assert "python often appears with: api, fastapi" in prompt
    assert "## QUALITY DISTRIBUTION (calibrate your ratings)" in prompt
    assert "Current distribution: S=10%, A=20%, B=50%, C=20%, D=0%" in prompt
    assert "## KNOWN ALIASES" in prompt
    assert "k8s -> kubernetes" in prompt


@pytest.mark.asyncio
async def test_process_fetches_prompt_context_with_gather(monkeypatch):
    llm = _make_llm(
        {
            "tags": ["programming"],
            "new_tags": [],
            "tier": "B",
            "quality_score": 55,
            "topics": [],
            "pre_detected_validations": [],
            "additional_entities": [],
            "summary": "ok",
        }
    )
    repo = _make_repo()
    service = UnifiedPipelineService(llm_provider=llm, repo=repo, settings=_make_settings())

    real_gather = asyncio.gather
    gather_calls: list[int] = []

    async def gather_spy(*args, **kwargs):
        gather_calls.append(len(args))
        return await real_gather(*args, **kwargs)

    monkeypatch.setattr("menos.services.unified_pipeline.asyncio.gather", gather_spy)

    await service.process("c1", "text", "markdown", "title", job_id="job-1")

    assert 5 in gather_calls
    repo.list_tags_with_counts.assert_awaited_once()
    repo.get_tag_cooccurrence.assert_awaited_once()
    repo.get_tier_distribution.assert_awaited_once()
    repo.get_tag_aliases.assert_awaited_once()


@pytest.mark.asyncio
async def test_prompt_uses_graceful_fallback_for_empty_feedback():
    llm = _make_llm(
        {
            "tags": ["programming"],
            "new_tags": [],
            "tier": "B",
            "quality_score": 55,
            "topics": [],
            "pre_detected_validations": [],
            "additional_entities": [],
            "summary": "ok",
        }
    )
    repo = _make_repo()
    repo.get_tag_cooccurrence = AsyncMock(return_value={})
    repo.get_tier_distribution = AsyncMock(return_value={})
    repo.get_tag_aliases = AsyncMock(return_value={})
    service = UnifiedPipelineService(llm_provider=llm, repo=repo, settings=_make_settings())

    await service.process("c1", "text", "markdown", "title", job_id="job-1")

    prompt = llm.generate.call_args.args[0]
    assert "## TAG CO-OCCURRENCE PATTERNS\nNone yet" in prompt
    assert "Current distribution: No data" in prompt
    assert "## KNOWN ALIASES\nNone yet" in prompt


@pytest.mark.asyncio
async def test_records_alias_when_levenshtein_dedup_maps_variant():
    llm = _make_llm(
        {
            "tags": ["programming"],
            "new_tags": ["programing"],
            "tier": "B",
            "quality_score": 55,
            "topics": [],
            "pre_detected_validations": [],
            "additional_entities": [],
            "summary": "ok",
        }
    )
    repo = _make_repo()
    service = UnifiedPipelineService(llm_provider=llm, repo=repo, settings=_make_settings())

    await service.process("c1", "text", "markdown", "title", job_id="job-1")

    repo.record_tag_alias.assert_awaited_once_with(variant="programing", canonical="programming")


@pytest.mark.asyncio
async def test_does_not_record_alias_for_exact_duplicate():
    llm = _make_llm(
        {
            "tags": ["programming"],
            "new_tags": ["programming"],
            "tier": "B",
            "quality_score": 55,
            "topics": [],
            "pre_detected_validations": [],
            "additional_entities": [],
            "summary": "ok",
        }
    )
    repo = _make_repo()
    service = UnifiedPipelineService(llm_provider=llm, repo=repo, settings=_make_settings())

    await service.process("c1", "text", "markdown", "title", job_id="job-1")

    repo.record_tag_alias.assert_not_awaited()
