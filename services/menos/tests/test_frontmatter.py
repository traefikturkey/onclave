"""Tests for frontmatter parsing service."""


from menos.services.frontmatter import FrontmatterParser


class TestFrontmatterParser:
    """Test frontmatter parsing functionality."""

    def test_parse_with_yaml_frontmatter(self):
        """Parse markdown with YAML frontmatter."""
        content = """---
title: My Document
tags:
  - python
  - api
author: John Doe
---
# Content here

This is the body.
"""
        body, metadata = FrontmatterParser.parse(content)

        assert "# Content here" in body
        assert "This is the body." in body
        assert metadata["title"] == "My Document"
        assert metadata["tags"] == ["python", "api"]
        assert metadata["author"] == "John Doe"

    def test_parse_without_frontmatter(self):
        """Parse markdown without frontmatter."""
        content = """# Just a heading

Some content without frontmatter.
"""
        body, metadata = FrontmatterParser.parse(content)

        assert body.strip() == content.strip()
        assert metadata == {}

    def test_parse_bytes_input(self):
        """Parse bytes input."""
        content = b"""---
title: Test
---
Body content
"""
        body, metadata = FrontmatterParser.parse(content)

        assert "Body content" in body
        assert metadata["title"] == "Test"

    def test_parse_empty_frontmatter(self):
        """Parse markdown with empty frontmatter."""
        content = """---
---
# Content
"""
        body, metadata = FrontmatterParser.parse(content)

        assert "# Content" in body
        assert metadata == {}

    def test_extract_tags_from_list(self):
        """Extract tags when frontmatter has list."""
        metadata = {"tags": ["python", "api", "testing"]}
        tags = FrontmatterParser.extract_tags(metadata)

        assert tags == ["python", "api", "testing"]

    def test_extract_tags_from_string(self):
        """Extract tags when frontmatter has single string."""
        metadata = {"tags": "python"}
        tags = FrontmatterParser.extract_tags(metadata)

        assert tags == ["python"]

    def test_extract_tags_missing(self):
        """Extract tags when frontmatter has no tags."""
        metadata = {"title": "Test"}
        tags = FrontmatterParser.extract_tags(metadata)

        assert tags == []

    def test_extract_tags_invalid_type(self):
        """Extract tags when frontmatter has invalid type."""
        metadata = {"tags": 123}
        tags = FrontmatterParser.extract_tags(metadata)

        assert tags == []

    def test_merge_tags_with_explicit(self):
        """Merge frontmatter tags with explicit tags."""
        metadata = {"tags": ["python", "api"]}
        explicit_tags = ["testing", "docs"]
        tags = FrontmatterParser.extract_tags(metadata, explicit_tags=explicit_tags)

        # Explicit tags come first
        assert tags == ["testing", "docs", "python", "api"]

    def test_merge_tags_deduplication(self):
        """Deduplicate tags when merging."""
        metadata = {"tags": ["python", "api", "testing"]}
        explicit_tags = ["testing", "docs", "python"]
        tags = FrontmatterParser.extract_tags(metadata, explicit_tags=explicit_tags)

        # No duplicates, preserves order of first occurrence
        assert tags == ["testing", "docs", "python", "api"]

    def test_merge_tags_with_none_explicit(self):
        """Merge tags when explicit tags is None."""
        metadata = {"tags": ["python", "api"]}
        tags = FrontmatterParser.extract_tags(metadata, explicit_tags=None)

        assert tags == ["python", "api"]

    def test_merge_tags_filters_non_strings(self):
        """Filter out non-string items from tags."""
        metadata = {"tags": ["python", 123, "api", None, "testing"]}
        tags = FrontmatterParser.extract_tags(metadata)

        assert tags == ["python", "api", "testing"]

    def test_extract_title_present(self):
        """Extract title from frontmatter."""
        metadata = {"title": "My Document"}
        title = FrontmatterParser.extract_title(metadata)

        assert title == "My Document"

    def test_extract_title_with_whitespace(self):
        """Extract title and trim whitespace."""
        metadata = {"title": "  My Document  "}
        title = FrontmatterParser.extract_title(metadata)

        assert title == "My Document"

    def test_extract_title_missing(self):
        """Extract title when missing returns None."""
        metadata = {"author": "John"}
        title = FrontmatterParser.extract_title(metadata)

        assert title is None

    def test_extract_title_missing_with_default(self):
        """Extract title when missing returns default."""
        metadata = {"author": "John"}
        title = FrontmatterParser.extract_title(metadata, default="Default Title")

        assert title == "Default Title"

    def test_extract_title_empty_string(self):
        """Extract title when empty string returns default."""
        metadata = {"title": "   "}
        title = FrontmatterParser.extract_title(metadata, default="Default")

        assert title == "Default"

    def test_extract_title_non_string(self):
        """Extract title when non-string returns default."""
        metadata = {"title": 123}
        title = FrontmatterParser.extract_title(metadata, default="Default")

        assert title == "Default"

    def test_real_world_example(self):
        """Test with realistic markdown document."""
        content = """---
title: Python Best Practices
tags:
  - python
  - coding-standards
  - best-practices
author: Tech Team
date: 2024-01-15
---

# Python Best Practices

## Introduction

This document outlines our team's Python coding standards.

## Code Style

Use PEP 8 for all Python code.
"""
        body, metadata = FrontmatterParser.parse(content)

        assert "# Python Best Practices" in body
        assert "## Introduction" in body
        assert metadata["title"] == "Python Best Practices"
        assert len(metadata["tags"]) == 3
        assert "python" in metadata["tags"]

        # Extract tags and title
        title = FrontmatterParser.extract_title(metadata, default="Untitled")
        tags = FrontmatterParser.extract_tags(metadata, explicit_tags=["documentation"])

        assert title == "Python Best Practices"
        assert tags == ["documentation", "python", "coding-standards", "best-practices"]

    def test_malformed_yaml(self):
        """Handle malformed YAML gracefully."""
        content = """---
title: Test
tags: [python, api
---
Body
"""
        # Should gracefully handle malformed YAML by returning content as-is
        body, metadata = FrontmatterParser.parse(content)

        # Should return empty metadata and full content on error
        assert isinstance(metadata, dict)
        assert metadata == {}
        assert "Body" in body

    def test_frontmatter_with_dashes_in_content(self):
        """Ensure content with --- doesn't confuse parser."""
        content = """---
title: Test
---
# Content

Some text

---

More text after horizontal rule
"""
        body, metadata = FrontmatterParser.parse(content)

        assert metadata["title"] == "Test"
        assert "---" in body  # Horizontal rule should be in body
        assert "More text after horizontal rule" in body
