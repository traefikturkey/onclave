"""Shared utility for extracting JSON from LLM responses."""

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Strip reasoning model think blocks (e.g. DeepSeek R1)
_THINK_PATTERN = re.compile(r"<think>[\s\S]*?</think>", re.DOTALL)


def extract_json(response: str) -> dict[str, Any]:
    """Extract JSON from LLM response, handling markdown code blocks and think tags.

    Args:
        response: Raw LLM response

    Returns:
        Parsed JSON dictionary, or empty dict if parsing fails
    """
    # Strip <think>...</think> blocks from reasoning models
    cleaned = _THINK_PATTERN.sub("", response).strip()

    # Try direct parse first
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code blocks or bare JSON objects
    patterns = [
        r"```json\s*\n?(.*?)\n?```",
        r"```\s*\n?(.*?)\n?```",
        r"\{[\s\S]*\}",
    ]

    for pattern in patterns:
        match = re.search(pattern, cleaned, re.DOTALL)
        if match:
            try:
                json_str = match.group(1) if "```" in pattern else match.group(0)
                return json.loads(json_str)
            except (json.JSONDecodeError, IndexError):
                continue

    logger.warning("Failed to parse LLM response as JSON: %s", cleaned[:200])
    return {}
