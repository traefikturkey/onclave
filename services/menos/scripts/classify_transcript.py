#!/usr/bin/env python
"""Classify a YouTube transcript using multiple LLM models."""

import asyncio
import sys
from datetime import UTC, datetime
from pathlib import Path

from minio import Minio
from surrealdb import Surreal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from menos.config import settings  # noqa: E402
from menos.services.llm import OllamaLLMProvider  # noqa: E402
from menos.services.llm_providers import AnthropicProvider, OpenRouterProvider  # noqa: E402

SYSTEM_PROMPT = """\
# IDENTITY and PURPOSE

You are an ultra-wise and brilliant classifier and judge of content. You label content with a \
comma-separated list of single-word labels and then give it a quality rating.

Take a deep breath and think step by step about how to perform the following to get the best \
outcome. You have a lot of freedom to do this the way you think is best.

# STEPS:

- Label the content with up to 20 single-word labels, such as: cybersecurity, philosophy, \
nihilism, poetry, writing, etc. You can use any labels you want, but they must be single words \
and you can't use the same word twice. This goes in a section called LABELS:.

- Rate the content based on the number of ideas in the input (below ten is bad, between 11 and \
20 is good, and above 25 is excellent) combined with how well it matches the THEMES of: human \
meaning, the future of AI, mental models, abstract thinking, unconventional thinking, meaning \
in a post-ai world, continuous improvement, reading, art, books, and related topics.

## Use the following rating levels:

- S Tier: (Must Consume Original Content Immediately): 18+ ideas and/or STRONG theme matching \
with the themes in STEP #2.

- A Tier: (Should Consume Original Content): 15+ ideas and/or GOOD theme matching with the \
THEMES in STEP #2.

- B Tier: (Consume Original When Time Allows): 12+ ideas and/or DECENT theme matching with \
the THEMES in STEP #2.

- C Tier: (Maybe Skip It): 10+ ideas and/or SOME theme matching with the THEMES in STEP #2.

- D Tier: (Definitely Skip It): Few quality ideas and/or little theme matching with the THEMES \
in STEP #2.

- Provide a score between 1 and 100 for the overall quality ranking, where 100 is a perfect \
match with the highest number of high quality ideas, and 1 is the worst match with a low number \
of the worst ideas.

The output should look like the following:

LABELS:

Cybersecurity, Writing, Running, Copywriting, etc.

RATING:

S Tier: (Must Consume Original Content Immediately)

Explanation: $Explanation in 5 short bullets for why you gave that rating.$

CONTENT SCORE:

$The 1-100 quality score$

Explanation: $Explanation in 5 short bullets for why you gave that score.$

## OUTPUT INSTRUCTIONS

1. You only output Markdown.
2. Do not give warnings or notes; only output the requested sections."""

MODELS = [
    ("haiku", "anthropic", "claude-3-5-haiku-20241022"),
    ("sonnet", "anthropic", "claude-sonnet-4-5-20250929"),
    ("opus", "anthropic", "claude-opus-4-6"),
    ("aurora", "openrouter", "openrouter/aurora-alpha"),
    ("pony", "openrouter", "openrouter/pony-alpha"),
    ("gpt-oss", "openrouter", "openai/gpt-oss-120b:free"),
    ("glm4", "openrouter", "z-ai/glm-4.5-air:free"),
    ("step3", "openrouter", "stepfun/step-3.5-flash:free"),
    ("trinity", "openrouter", "arcee-ai/trinity-large-preview:free"),
    ("gemma3", "openrouter", "google/gemma-3-27b-it:free"),
]


def _stringify_record_ids(row: dict) -> dict:
    """Convert RecordID values in a row dict to strings."""
    return {k: str(v.id) if hasattr(v, "id") else v for k, v in row.items()}


def parse_results(result):
    """Parse SurrealDB v2 query results into a flat list of dicts."""
    if not result or not isinstance(result, list) or len(result) == 0:
        return []
    first = result[0]
    raw_items = first["result"] if isinstance(first, dict) and "result" in first else result
    return [_stringify_record_ids(dict(item)) for item in raw_items]


def get_latest_youtube() -> dict:
    """Fetch the most recent YouTube content record from SurrealDB."""
    url = settings.surrealdb_url.replace("ws://", "http://").replace("wss://", "https://")
    db = Surreal(url)
    db.signin({"username": settings.surrealdb_user, "password": settings.surrealdb_password})
    db.use(settings.surrealdb_namespace, settings.surrealdb_database)
    result = db.query(
        "SELECT * FROM content WHERE content_type = 'youtube' ORDER BY created_at DESC LIMIT 1"
    )
    rows = parse_results(result)
    if not rows:
        print("No YouTube content found in database.", file=sys.stderr)
        sys.exit(1)
    return rows[0]


def download_transcript(file_path: str) -> str:
    """Download transcript text from S3-compatible storage."""
    client = Minio(
        settings.s3_endpoint_url,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        secure=settings.s3_secure,
        region=settings.s3_region,
    )
    bucket = settings.s3_bucket
    response = client.get_object(bucket, file_path)
    try:
        return response.read().decode("utf-8")
    finally:
        response.close()
        response.release_conn()


def build_provider(slug: str, provider_type: str, model_id: str):
    """Build an LLM provider instance."""
    if provider_type == "anthropic":
        if not settings.anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        return AnthropicProvider(api_key=settings.anthropic_api_key, model=model_id)
    elif provider_type == "openrouter":
        if not settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY not set")
        return OpenRouterProvider(api_key=settings.openrouter_api_key, model=model_id)
    elif provider_type == "ollama":
        return OllamaLLMProvider(base_url=settings.ollama_url, model=model_id)
    else:
        raise ValueError(f"Unknown provider type: {provider_type}")


async def classify_with_model(slug: str, provider, transcript: str, title: str) -> tuple[str, str]:
    """Run classification on a single model, return (slug, result_text)."""
    timeout = 300.0 if slug == "qwen3" else 120.0
    user_prompt = f"# Content Title: {title}\n\n# Transcript:\n\n{transcript}"

    try:
        print(f"  [{slug}] Sending to {provider.model}...")
        result = await provider.generate(
            user_prompt,
            system_prompt=SYSTEM_PROMPT,
            max_tokens=4096,
            temperature=0.3,
            timeout=timeout,
        )
        print(f"  [{slug}] Done ({len(result)} chars)")
        return slug, result
    except Exception as e:
        error_msg = f"ERROR: {e}"
        print(f"  [{slug}] Failed: {e}", file=sys.stderr)
        return slug, error_msg
    finally:
        await provider.close()


def write_result(video_id: str, slug: str, model_id: str, title: str, result_text: str) -> Path:
    """Write classification result to a markdown file."""
    data_dir = Path(__file__).resolve().parent.parent.parent / "data"
    data_dir.mkdir(exist_ok=True)

    out_path = data_dir / f"classify_{video_id}_{slug}.md"
    timestamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    frontmatter = f"""\
---
model: {model_id}
video_id: {video_id}
title: "{title}"
timestamp: {timestamp}
---

"""
    out_path.write_text(frontmatter + result_text, encoding="utf-8")
    return out_path


async def main():
    # Step 1: Get latest YouTube content
    print("Fetching latest YouTube content from SurrealDB...")
    record = get_latest_youtube()
    title = record.get("title", "Unknown")
    video_id = record.get("source_id", record.get("id", "unknown"))
    file_path = record.get("file_path", "")
    print(f"  Found: {title}")
    print(f"  Video ID: {video_id}")

    # Step 2: Download transcript from MinIO
    if not file_path:
        print("No file_path in record, cannot download transcript.", file=sys.stderr)
        sys.exit(1)
    print(f"Downloading transcript from S3 storage ({file_path})...")
    transcript = download_transcript(file_path)
    print(f"  Transcript length: {len(transcript)} chars")

    # Step 3: Build providers and run classification in parallel
    data_dir = Path(__file__).resolve().parent.parent.parent / "data"
    providers = {}
    for slug, provider_type, model_id in MODELS:
        out_path = data_dir / f"classify_{video_id}_{slug}.md"
        if out_path.exists():
            print(f"  [{slug}] Skipping (already exists: {out_path.name})")
            continue
        try:
            providers[slug] = (build_provider(slug, provider_type, model_id), model_id)
        except RuntimeError as e:
            print(f"  [{slug}] Skipping: {e}", file=sys.stderr)

    if not providers:
        print("All models already have results. Nothing to do.")
        return

    print(f"Running classification across {len(providers)} model(s)...")

    tasks = [
        classify_with_model(slug, provider, transcript, title)
        for slug, (provider, _) in providers.items()
    ]

    results = await asyncio.gather(*tasks)

    # Step 4: Write results to files
    print("\nWriting results...")
    for slug, result_text in results:
        _, model_id = providers[slug]
        out_path = write_result(video_id, slug, model_id, title, result_text)
        print(f"  {out_path}")

    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
