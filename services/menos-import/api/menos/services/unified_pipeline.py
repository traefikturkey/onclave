"""Unified pipeline service combining classification and entity extraction in one LLM call."""

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from Levenshtein import distance

from menos.config import Settings
from menos.models import (
    EdgeType,
    EntityType,
    ExtractedEntity,
    PreDetectedValidation,
    UnifiedResult,
)
from menos.services.llm import LLMProvider
from menos.services.llm_json import extract_json
from menos.services.normalization import normalize_name
from menos.services.storage import SurrealDBRepository

logger = logging.getLogger(__name__)

VALID_TIERS = {"S", "A", "B", "C", "D"}
LABEL_PATTERN = re.compile(r"^[a-z][a-z0-9-]*$")


def _dedup_label(
    new_label: str,
    existing_labels: list[str],
    max_distance: int = 2,
) -> str | None:
    """Check if a new label is a near-duplicate of an existing label.

    Uses normalize_name() + Levenshtein distance for deterministic matching.

    Args:
        new_label: The candidate new label
        existing_labels: Known labels in the vault
        max_distance: Maximum edit distance to consider as duplicate

    Returns:
        Existing label name if duplicate found, None if genuinely new
    """
    normalized_new = normalize_name(new_label)

    for existing in existing_labels:
        normalized_existing = normalize_name(existing)
        if distance(normalized_new, normalized_existing) <= max_distance:
            return existing

    return None


def _parse_topic_hierarchy(topic_str: str) -> list[str]:
    """Parse a topic hierarchy string into a list of components.

    "AI > LLMs > RAG" -> ["AI", "LLMs", "RAG"]
    """
    parts = [p.strip() for p in topic_str.split(">")]
    return [p for p in parts if p]


def _confidence_to_float(confidence: str) -> float:
    """Convert confidence string to float value."""
    mapping = {"high": 0.9, "medium": 0.7, "low": 0.5}
    return mapping.get(confidence.lower(), 0.6)


def _edge_type_from_string(edge_str: str) -> EdgeType:
    """Convert edge type string to EdgeType enum."""
    mapping = {
        "discusses": EdgeType.DISCUSSES,
        "mentions": EdgeType.MENTIONS,
        "cites": EdgeType.CITES,
        "uses": EdgeType.USES,
        "demonstrates": EdgeType.DEMONSTRATES,
    }
    return mapping.get(edge_str.lower(), EdgeType.MENTIONS)


def _entity_type_from_string(type_str: str) -> EntityType:
    """Convert entity type string to EntityType enum."""
    mapping = {
        "topic": EntityType.TOPIC,
        "repo": EntityType.REPO,
        "paper": EntityType.PAPER,
        "tool": EntityType.TOOL,
        "person": EntityType.PERSON,
    }
    return mapping.get(type_str.lower(), EntityType.TOPIC)


UNIFIED_PROMPT_TEMPLATE = """You are a content analyst. Evaluate the content and provide \
classification ratings, tags, and entity extraction in a single response.

CONTENT TYPE: {content_type}
CONTENT TITLE: {title}

## EXISTING TAGS (prefer these over creating new ones)
{existing_tags}

## PRE-DETECTED ENTITIES (already found via URL/keyword matching)
{pre_detected_entities_json}

## EXISTING TOPICS (strongly prefer these)
{existing_topics}

## TAG CO-OCCURRENCE PATTERNS
{tag_cooccurrence}

## QUALITY DISTRIBUTION (calibrate your ratings)
Current distribution: {tier_distribution}
Aim for a balanced distribution. Most content should be B or C tier.

## KNOWN ALIASES
{known_aliases}

## RULES

### Tags
- Assign up to 10 tags from existing tags above
- You may create up to {max_new_tags} NEW tags if needed (lowercase, hyphenated)
- Tags must be single lowercase words or hyphenated (e.g. "kubernetes", "home-lab")

### Quality Rating
- Assign a quality tier: S (exceptional), A (great), B (good), C (mediocre), D (poor)
- Assign a quality score from 1-100 where 50 = average, 80+ = exceptional, <30 = low value
- Provide brief explanations (2-3 bullet points each)

### Summary
- Generate a summary: a 2-3 sentence overview followed by 3-5 bullet points of main topics

### Topics
- Extract 3-7 hierarchical topics
- Format: "Parent > Child > Grandchild" (e.g., "AI > LLMs > RAG")
- PREFER existing topics over creating new ones

### Pre-detected Validations
- For each pre-detected entity, confirm edge_type:
  discusses, mentions, uses, cites, demonstrates

### Additional Entities
- Only extract repos/tools/papers NOT in the pre-detected list
- Must be substantively discussed, not just name-dropped

<CONTENT>
{content_text}
</CONTENT>

Respond ONLY with valid JSON (no markdown, no code blocks):
{{
  "tags": ["existing-tag-1", "existing-tag-2"],
  "new_tags": ["genuinely-new-tag"],
  "tier": "B",
  "tier_explanation": ["Reason 1", "Reason 2"],
  "quality_score": 55,
  "score_explanation": ["Reason 1", "Reason 2"],
  "summary": "2-3 sentence overview.\\n\\n- Bullet 1\\n- Bullet 2",
  "topics": [
    {{"name": "AI > LLMs > RAG", "confidence": "high", "edge_type": "discusses"}}
  ],
  "pre_detected_validations": [
    {{"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": true}}
  ],
  "additional_entities": [
    {{"type": "repo", "name": "FAISS", "confidence": "medium", "edge_type": "mentions"}}
  ]
}}"""


class PipelineStageError(Exception):
    """Error with pipeline stage context for observability."""

    def __init__(self, stage: str, code: str, message: str):
        self.stage = stage
        self.code = code
        self.message = message
        super().__init__(f"[{stage}] {code}: {message}")


def _parse_tier_and_score(data: dict[str, Any]) -> tuple[str, int]:
    """Extract and validate tier + quality score from LLM data."""
    tier = str(data.get("tier", "C")).upper()
    if tier not in VALID_TIERS:
        tier = "C"
    raw_score = data.get("quality_score", 50)
    try:
        score = int(raw_score)
    except (ValueError, TypeError):
        score = 50
    return tier, max(1, min(100, score))


def _apply_new_tag(
    new_tag: str,
    tags: list[str],
    new_tags: list[str],
    existing_tags: list[str],
    alias_mappings: list[tuple[str, str]] | None,
) -> None:
    """Apply a single candidate new tag: dedup against existing, record alias or append."""
    existing_match = _dedup_label(new_tag, existing_tags + tags)
    if existing_match:
        if alias_mappings is not None and normalize_name(new_tag) != normalize_name(existing_match):
            alias_mappings.append((new_tag, existing_match))
        if existing_match not in tags:
            tags.append(existing_match)
    elif new_tag not in tags:
        tags.append(new_tag)
        new_tags.append(new_tag)


def _valid_labels(raw: Any) -> list[str]:
    """Return only valid label strings from a raw list."""
    if not isinstance(raw, list):
        return []
    return [t for t in raw if isinstance(t, str) and LABEL_PATTERN.match(t)]


def _parse_tags(
    data: dict[str, Any],
    existing_tags: list[str],
    settings: Settings,
    alias_mappings: list[tuple[str, str]] | None,
) -> tuple[list[str], list[str]]:
    """Extract and dedup tags + new_tags from LLM data."""
    tags = _valid_labels(data.get("tags", []))
    new_tags: list[str] = []
    max_new = settings.unified_pipeline_max_new_tags
    for new_tag in _valid_labels(data.get("new_tags", [])):
        if len(new_tags) >= max_new:
            break
        _apply_new_tag(new_tag, tags, new_tags, existing_tags, alias_mappings)
    return tags, new_tags


def _parse_explanations(data: dict[str, Any]) -> tuple[list[str], list[str], str]:
    """Extract tier_explanation, score_explanation, and summary from LLM data."""
    tier_explanation = data.get("tier_explanation", [])
    if not isinstance(tier_explanation, list):
        tier_explanation = []
    tier_explanation = [str(e) for e in tier_explanation if e]

    score_explanation = data.get("score_explanation", [])
    if not isinstance(score_explanation, list):
        score_explanation = []
    score_explanation = [str(e) for e in score_explanation if e]

    summary = data.get("summary", "")
    if not isinstance(summary, str):
        summary = ""
    return tier_explanation, score_explanation, summary


def _parse_topics(data: dict[str, Any], settings: Settings) -> list[ExtractedEntity]:
    """Extract topic entities from LLM data."""
    topics: list[ExtractedEntity] = []
    raw_topics = data.get("topics", [])
    if not isinstance(raw_topics, list):
        return topics
    for topic_data in raw_topics:
        if not isinstance(topic_data, dict):
            continue
        name = topic_data.get("name", "")
        if not name:
            continue
        if len(topics) >= settings.entity_max_topics_per_content:
            break
        confidence = topic_data.get("confidence", "medium")
        if _confidence_to_float(confidence) < settings.entity_min_confidence:
            continue
        hierarchy = _parse_topic_hierarchy(name)
        topics.append(
            ExtractedEntity(
                entity_type=EntityType.TOPIC,
                name=hierarchy[-1] if hierarchy else name,
                confidence=confidence,
                edge_type=_edge_type_from_string(topic_data.get("edge_type", "discusses")),
                hierarchy=hierarchy,
            )
        )
    return topics


def _parse_validations(data: dict[str, Any]) -> list[PreDetectedValidation]:
    """Extract pre-detected entity validations from LLM data."""
    validations: list[PreDetectedValidation] = []
    for val_data in data.get("pre_detected_validations", []):
        if not isinstance(val_data, dict):
            continue
        entity_id = val_data.get("entity_id", "")
        if not entity_id:
            continue
        validations.append(
            PreDetectedValidation(
                entity_id=entity_id,
                edge_type=_edge_type_from_string(val_data.get("edge_type", "mentions")),
                confirmed=val_data.get("confirmed", True),
            )
        )
    return validations


def _parse_additional_entities(data: dict[str, Any], settings: Settings) -> list[ExtractedEntity]:
    """Extract additional (non-pre-detected) entities from LLM data."""
    additional: list[ExtractedEntity] = []
    for ent_data in data.get("additional_entities", []):
        if not isinstance(ent_data, dict):
            continue
        name = ent_data.get("name", "")
        if not name:
            continue
        confidence = ent_data.get("confidence", "medium")
        if _confidence_to_float(confidence) < settings.entity_min_confidence:
            continue
        additional.append(
            ExtractedEntity(
                entity_type=_entity_type_from_string(ent_data.get("type", "tool")),
                name=name,
                confidence=confidence,
                edge_type=_edge_type_from_string(ent_data.get("edge_type", "mentions")),
                hierarchy=None,
            )
        )
    return additional


_RECOGNIZED_FIELDS = frozenset(
    {
        "tags",
        "new_tags",
        "tier",
        "quality_score",
        "topics",
        "pre_detected_validations",
        "additional_entities",
        "summary",
    }
)


def parse_unified_response(
    data: dict[str, Any],
    existing_tags: list[str],
    settings: Settings,
    alias_mappings: list[tuple[str, str]] | None = None,
) -> UnifiedResult | None:
    """Parse and validate a unified LLM response.

    Args:
        data: Parsed JSON from LLM
        existing_tags: Known tags for dedup
        settings: Application settings

    Returns:
        UnifiedResult or None if payload is malformed
    """
    if not data or not any(k in data for k in _RECOGNIZED_FIELDS):
        return None

    tier, score = _parse_tier_and_score(data)
    tags, new_tags = _parse_tags(data, existing_tags, settings, alias_mappings)
    tier_explanation, score_explanation, summary = _parse_explanations(data)
    topics = _parse_topics(data, settings)
    validations = _parse_validations(data)
    additional = _parse_additional_entities(data, settings)

    return UnifiedResult(
        tags=tags,
        new_tags=new_tags,
        tier=tier,
        tier_explanation=tier_explanation,
        quality_score=score,
        score_explanation=score_explanation,
        summary=summary,
        topics=topics,
        pre_detected_validations=validations,
        additional_entities=additional,
    )


@dataclass
class _ProcessOptions:
    """Optional parameters for UnifiedPipelineService.process."""

    pre_detected: list
    existing_topics: list[str] | None
    job_id: str | None


@dataclass
class _ContentRequest:
    """Required content fields for a pipeline run."""

    content_id: str
    content_text: str
    content_type: str
    title: str


@dataclass
class _PromptContext:
    """Fetched context needed to build the LLM prompt."""

    existing_tags: list[str]
    prompt_topics: list[str]
    tag_cooccurrence: dict
    tier_distribution: dict
    known_aliases: dict


class UnifiedPipelineService:
    """Service for unified content classification and entity extraction."""

    def __init__(
        self,
        llm_provider: LLMProvider,
        repo: SurrealDBRepository,
        settings: Settings,
    ):
        """Initialize unified pipeline service.

        Args:
            llm_provider: LLM provider for text generation
            repo: SurrealDB repository for tag lookups
            settings: Application settings
        """
        self.llm = llm_provider
        self.repo = repo
        self.settings = settings

    def _provider_for_job(self, job_id: str | None) -> LLMProvider:
        """Return provider with per-job metering context when supported."""
        if not job_id:
            return self.llm
        with_context = getattr(self.llm, "with_context", None)
        if callable(with_context):
            return with_context(f"pipeline:{job_id}")
        return self.llm

    @staticmethod
    def _format_cooccurrence(cooccurrence: dict[str, list[str]]) -> str:
        if not cooccurrence:
            return "None yet"
        lines = [
            f"- {tag} often appears with: {', '.join(related_tags)}"
            for tag, related_tags in sorted(cooccurrence.items())
            if related_tags
        ]
        return "\n".join(lines) if lines else "None yet"

    @staticmethod
    def _format_distribution(distribution: dict[str, int]) -> str:
        if not distribution:
            return "No data"
        total = sum(max(count, 0) for count in distribution.values())
        if total <= 0:
            return "No data"

        parts = []
        for tier in ["S", "A", "B", "C", "D"]:
            count = max(distribution.get(tier, 0), 0)
            pct = round((count / total) * 100)
            parts.append(f"{tier}={pct}%")
        return ", ".join(parts)

    @staticmethod
    def _format_aliases(aliases: dict[str, str]) -> str:
        if not aliases:
            return "None yet"
        return ", ".join(f"{variant} -> {canonical}" for variant, canonical in aliases.items())

    async def _resolve_prompt_topics(self, existing_topics: list[str] | None) -> list[str]:
        if existing_topics:
            return existing_topics

        topic_entities = await self.repo.get_topic_hierarchy()
        topics = []
        for topic in topic_entities:
            if topic.hierarchy:
                topics.append(" > ".join(topic.hierarchy))
            elif topic.name:
                topics.append(topic.name)
        return topics

    def _truncate_content(self, content_text: str, content_id: str, job_id: str | None) -> str:
        t0 = time.monotonic()
        truncated = content_text[:10000]
        if len(content_text) > 10000:
            truncated += "\n\n[Content truncated...]"
        logger.info(
            "stage.truncation job_id=%s content_id=%s ms=%d",
            job_id,
            content_id,
            int((time.monotonic() - t0) * 1000),
        )
        return truncated

    async def _fetch_context(
        self, content_id: str, job_id: str | None, existing_topics: list[str] | None
    ) -> "_PromptContext":
        t0 = time.monotonic()
        try:
            (
                tags_data,
                prompt_topics,
                tag_cooccurrence,
                tier_distribution,
                known_aliases,
            ) = await asyncio.gather(
                self.repo.list_tags_with_counts(),
                self._resolve_prompt_topics(existing_topics),
                self.repo.get_tag_cooccurrence(),
                self.repo.get_tier_distribution(),
                self.repo.get_tag_aliases(),
            )
            existing_tags = [t["name"] for t in tags_data]
        except Exception as e:
            raise PipelineStageError(
                "context_fetch",
                "CONTEXT_FETCH_ERROR",
                str(e)[:500],
            ) from e
        logger.info(
            "stage.context_fetch job_id=%s content_id=%s ms=%d tags=%d topics=%d",
            job_id,
            content_id,
            int((time.monotonic() - t0) * 1000),
            len(existing_tags),
            len(prompt_topics),
        )
        return _PromptContext(
            existing_tags=existing_tags,
            prompt_topics=prompt_topics,
            tag_cooccurrence=tag_cooccurrence,
            tier_distribution=tier_distribution,
            known_aliases=known_aliases,
        )

    def _build_prompt(
        self, req: "_ContentRequest", truncated: str, pre_detected: list, ctx: "_PromptContext"
    ) -> str:
        pre_detected_json = json.dumps(
            [
                {
                    "entity_id": (f"entity:{e.id}" if e.id else f"entity:{e.normalized_name}"),
                    "type": e.entity_type.value,
                    "name": e.name,
                }
                for e in pre_detected
            ],
            indent=2,
        )
        return UNIFIED_PROMPT_TEMPLATE.format(
            content_type=req.content_type,
            title=req.title,
            existing_tags=(", ".join(ctx.existing_tags[:50]) if ctx.existing_tags else "None yet"),
            pre_detected_entities_json=pre_detected_json,
            existing_topics=(
                ", ".join(ctx.prompt_topics[:20]) if ctx.prompt_topics else "None yet"
            ),
            tag_cooccurrence=self._format_cooccurrence(ctx.tag_cooccurrence),
            tier_distribution=self._format_distribution(ctx.tier_distribution),
            known_aliases=self._format_aliases(ctx.known_aliases),
            max_new_tags=self.settings.unified_pipeline_max_new_tags,
            content_text=truncated,
        )

    async def _call_llm(
        self, llm_provider: LLMProvider, prompt: str, content_id: str, job_id: str | None
    ) -> str:
        t0 = time.monotonic()
        try:
            response = await llm_provider.generate(
                prompt,
                temperature=0.3,
                max_tokens=3000,
                timeout=120.0,
            )
        except Exception as e:
            raise PipelineStageError(
                "llm_call",
                "LLM_CALL_ERROR",
                str(e)[:500],
            ) from e
        logger.info(
            "stage.llm_call job_id=%s content_id=%s ms=%d token_est=%d",
            job_id,
            content_id,
            int((time.monotonic() - t0) * 1000),
            len(prompt) // 4 + len(response) // 4,
        )
        return response

    async def _parse_llm_response(
        self,
        llm_provider: LLMProvider,
        response: str,
        existing_tags: list[str],
        content_id: str,
        job_id: str | None,
    ) -> tuple[UnifiedResult, list[tuple[str, str]]]:
        t0 = time.monotonic()
        data = extract_json(response)
        if not data:
            logger.warning(
                "stage.parse.retry job_id=%s content_id=%s raw_len=%d",
                job_id,
                content_id,
                len(response),
            )
            correction_prompt = (
                "Your previous response was not valid JSON. "
                "Convert the following content into the exact JSON format requested. "
                "Respond ONLY with valid JSON, no markdown, no explanation.\n\n"
                f"{response[:3000]}"
            )
            try:
                retry_response = await llm_provider.generate(
                    correction_prompt,
                    temperature=0.1,
                    max_tokens=3000,
                    timeout=60.0,
                )
                data = extract_json(retry_response)
            except Exception:
                pass

        if not data:
            raise PipelineStageError(
                "parse",
                "EMPTY_RESPONSE",
                f"Empty unified pipeline response for {content_id}",
            )

        alias_mappings: list[tuple[str, str]] = []
        result = parse_unified_response(data, existing_tags, self.settings, alias_mappings)
        if result is None:
            raise PipelineStageError(
                "parse",
                "PARSE_FAILED",
                f"Failed to parse unified response for {content_id}",
            )
        logger.info(
            "stage.parse job_id=%s content_id=%s ms=%d",
            job_id,
            content_id,
            int((time.monotonic() - t0) * 1000),
        )
        return result, alias_mappings

    async def _run_pipeline(
        self, req: "_ContentRequest", opts: "_ProcessOptions"
    ) -> UnifiedResult | None:
        truncated = self._truncate_content(req.content_text, req.content_id, opts.job_id)
        ctx = await self._fetch_context(req.content_id, opts.job_id, opts.existing_topics)
        prompt = self._build_prompt(req, truncated, opts.pre_detected, ctx)
        llm_provider = self._provider_for_job(opts.job_id)
        response = await self._call_llm(llm_provider, prompt, req.content_id, opts.job_id)
        result, alias_mappings = await self._parse_llm_response(
            llm_provider, response, ctx.existing_tags, req.content_id, opts.job_id
        )
        result.model = getattr(llm_provider, "model", "fallback_chain")
        result.processed_at = datetime.now(UTC).isoformat()
        if alias_mappings:
            unique_aliases = sorted(set(alias_mappings))
            await asyncio.gather(
                *[
                    self.repo.record_tag_alias(variant=variant, canonical=canonical)
                    for variant, canonical in unique_aliases
                ]
            )
        logger.info(
            "pipeline.complete job_id=%s content_id=%s tier=%s score=%d tags=%s topics=%d",
            opts.job_id,
            req.content_id,
            result.tier,
            result.quality_score,
            result.tags,
            len(result.topics),
        )
        return result

    async def process(
        self,
        content_id: str,
        content_text: str,
        content_type: str,
        title: str,
        **kwargs: Any,
    ) -> UnifiedResult | None:
        """Run unified classification + entity extraction pipeline.

        Args:
            content_id: Content ID
            content_text: Full content text
            content_type: Type of content (youtube, markdown, etc.)
            title: Content title
            **kwargs: pre_detected, existing_topics, job_id (all optional)

        Returns:
            UnifiedResult or None if skipped/failed
        """
        job_id = kwargs.get("job_id")
        if not self.settings.unified_pipeline_enabled:
            logger.debug(
                "Unified pipeline disabled, skipping %s job_id=%s",
                content_id,
                job_id,
            )
            return None
        req = _ContentRequest(
            content_id=content_id,
            content_text=content_text,
            content_type=content_type,
            title=title,
        )
        opts = _ProcessOptions(
            pre_detected=kwargs.get("pre_detected") or [],
            existing_topics=kwargs.get("existing_topics"),
            job_id=job_id,
        )
        return await self._run_pipeline(req, opts)
