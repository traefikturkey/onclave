"""Frontmatter parsing service for markdown content."""

from typing import Any

import frontmatter


class FrontmatterParser:
    """Parse YAML frontmatter from markdown files."""

    @staticmethod
    def parse(content: str | bytes) -> tuple[str, dict[str, Any]]:
        """Parse frontmatter from markdown content.

        Args:
            content: Markdown content with optional YAML frontmatter

        Returns:
            Tuple of (body_content, metadata_dict)
        """
        if isinstance(content, bytes):
            content = content.decode("utf-8")

        try:
            post = frontmatter.loads(content)
            return post.content, dict(post.metadata)
        except Exception:
            # If frontmatter parsing fails, return content as-is with empty metadata
            return content, {}

    @staticmethod
    def extract_tags(metadata: dict[str, Any], explicit_tags: list[str] | None = None) -> list[str]:
        """Extract and merge tags from frontmatter and explicit tags.

        Args:
            metadata: Parsed frontmatter metadata
            explicit_tags: Tags provided via API parameter

        Returns:
            Deduplicated list of tags
        """
        frontmatter_tags = metadata.get("tags", [])

        # Ensure frontmatter tags is a list
        if isinstance(frontmatter_tags, str):
            frontmatter_tags = [frontmatter_tags]
        elif not isinstance(frontmatter_tags, list):
            frontmatter_tags = []

        # Merge with explicit tags
        all_tags = list(explicit_tags or []) + frontmatter_tags

        # Deduplicate while preserving order
        seen = set()
        unique_tags = []
        for tag in all_tags:
            if isinstance(tag, str) and tag not in seen:
                seen.add(tag)
                unique_tags.append(tag)

        return unique_tags

    @staticmethod
    def extract_title(metadata: dict[str, Any], default: str | None = None) -> str | None:
        """Extract title from frontmatter.

        Args:
            metadata: Parsed frontmatter metadata
            default: Fallback title if not found in frontmatter

        Returns:
            Title from frontmatter or default
        """
        title = metadata.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
        return default
