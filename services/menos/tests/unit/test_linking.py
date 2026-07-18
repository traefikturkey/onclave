"""Tests for link extraction service."""

import pytest

from menos.services.linking import LinkExtractor


class TestLinkExtractor:
    """Test suite for LinkExtractor."""

    def setup_method(self):
        """Set up test fixtures."""
        self.extractor = LinkExtractor()

    def test_simple_wiki_link(self):
        """Test extraction of simple wiki-link."""
        content = "See [[Python]] for more info."
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        assert links[0].target == "Python"
        assert links[0].link_text == "Python"
        assert links[0].link_type == "wiki"
        assert links[0].start_pos == 4
        assert links[0].end_pos == 14

    def test_wiki_link_with_display_text(self):
        """Test wiki-link with custom display text."""
        content = "Learn [[Python|the language]] here."
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        assert links[0].target == "Python"
        assert links[0].link_text == "the language"
        assert links[0].link_type == "wiki"

    def test_wiki_link_with_spaces(self):
        """Test wiki-link with spaces in title."""
        content = "Check [[Getting Started]] guide."
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        assert links[0].target == "Getting Started"
        assert links[0].link_text == "Getting Started"

    def test_simple_markdown_link_internal(self):
        """Test internal markdown link."""
        content = "See [docs](./docs/README.md) for info."
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        assert links[0].target == "./docs/README.md"
        assert links[0].link_text == "docs"
        assert links[0].link_type == "markdown"

    def test_markdown_link_external_url_skipped(self):
        """Test that external URLs are skipped."""
        content = """
        Internal: [local](./file.md)
        External: [google](https://google.com)
        Also external: [http](http://example.com)
        Protocol relative: [cdn](//cdn.example.com)
        """
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        assert links[0].target == "./file.md"

    def test_multiple_links_mixed_types(self):
        """Test multiple links of different types."""
        content = """
        Wiki link: [[Python]]
        Markdown: [guide](./guide.md)
        Another wiki: [[Django|framework]]
        Another md: [readme](README.md)
        """
        links = self.extractor.extract_links(content)

        assert len(links) == 4
        assert links[0].link_type == "wiki"
        assert links[0].target == "Python"
        assert links[1].link_type == "markdown"
        assert links[1].target == "./guide.md"
        assert links[2].link_type == "wiki"
        assert links[2].target == "Django"
        assert links[3].link_type == "markdown"
        assert links[3].target == "README.md"

    def test_links_in_code_blocks_ignored(self):
        """Test that links in code blocks are ignored."""
        content = """
        Normal link: [[Python]]

        ```python
        # This [[should not]] be extracted
        url = "[also ignored](./file.md)"
        ```

        Another normal: [[Valid]]

        Inline code: `[[also ignored]]` and `[skipped](file.md)`
        """
        links = self.extractor.extract_links(content)

        assert len(links) == 2
        assert links[0].target == "Python"
        assert links[1].target == "Valid"

    def test_nested_brackets_in_wiki_links(self):
        """Test handling of nested brackets."""
        content = "Link: [[Title with [brackets] inside]]"
        links = self.extractor.extract_links(content)

        # Should not match due to nested brackets breaking the pattern
        assert len(links) == 0

    def test_malformed_wiki_link_missing_closing(self):
        """Test malformed wiki-link with missing closing brackets."""
        content = "Broken [[link without closing"
        links = self.extractor.extract_links(content)

        assert len(links) == 0

    def test_malformed_wiki_link_extra_pipe(self):
        """Test malformed wiki-link with multiple pipes."""
        content = "Malformed [[title|text|extra]]"
        links = self.extractor.extract_links(content)

        # Should match only up to first pipe
        assert len(links) == 1
        assert links[0].target == "title"
        assert links[0].link_text == "text|extra"

    def test_malformed_markdown_link_missing_url(self):
        """Test malformed markdown link with missing URL."""
        content = "Broken [text]()"
        links = self.extractor.extract_links(content)

        # Regex requires at least one character, so empty URL doesn't match
        assert len(links) == 0

    def test_malformed_markdown_link_missing_closing_paren(self):
        """Test malformed markdown link without closing parenthesis."""
        content = "Broken [text](url"
        links = self.extractor.extract_links(content)

        assert len(links) == 0

    def test_empty_content(self):
        """Test extraction from empty content."""
        links = self.extractor.extract_links("")
        assert len(links) == 0

    def test_content_with_no_links(self):
        """Test content without any links."""
        content = "Just plain text with no links at all."
        links = self.extractor.extract_links(content)
        assert len(links) == 0

    def test_adjacent_links(self):
        """Test multiple links next to each other."""
        content = "See [[Python]][[Django]][guide](./file.md)"
        links = self.extractor.extract_links(content)

        assert len(links) == 3
        assert links[0].target == "Python"
        assert links[1].target == "Django"
        assert links[2].target == "./file.md"

    def test_links_sorted_by_position(self):
        """Test that links are returned sorted by position."""
        content = "[z](z.md) [[y]] [x](x.md) [[w]]"
        links = self.extractor.extract_links(content)

        assert len(links) == 4
        targets = [link.target for link in links]
        assert targets == ["z.md", "y", "x.md", "w"]

    def test_wiki_link_with_special_characters(self):
        """Test wiki-link with special characters in title."""
        content = "See [[C++ Programming]] and [[Node.js]]"
        links = self.extractor.extract_links(content)

        assert len(links) == 2
        assert links[0].target == "C++ Programming"
        assert links[1].target == "Node.js"

    def test_markdown_link_with_relative_paths(self):
        """Test various relative path formats."""
        content = """
        [file1](./docs/file.md)
        [file2](../parent/file.md)
        [file3](file.md)
        [file4](/absolute/path.md)
        """
        links = self.extractor.extract_links(content)

        assert len(links) == 4
        assert links[0].target == "./docs/file.md"
        assert links[1].target == "../parent/file.md"
        assert links[2].target == "file.md"
        assert links[3].target == "/absolute/path.md"

    def test_extract_wiki_links_only(self):
        """Test extracting only wiki-links."""
        content = "[[Wiki1]] [markdown](file.md) [[Wiki2]]"
        links = self.extractor.extract_wiki_links(content)

        assert len(links) == 2
        assert all(link.link_type == "wiki" for link in links)
        assert links[0].target == "Wiki1"
        assert links[1].target == "Wiki2"

    def test_extract_markdown_links_only(self):
        """Test extracting only markdown links."""
        content = "[[Wiki]] [md1](file1.md) [[Another]] [md2](file2.md)"
        links = self.extractor.extract_markdown_links(content)

        assert len(links) == 2
        assert all(link.link_type == "markdown" for link in links)
        assert links[0].target == "file1.md"
        assert links[1].target == "file2.md"

    def test_multiline_code_block_with_links(self):
        """Test that multiline code blocks properly exclude links."""
        content = """
        Before [[link1]]

        ```python
        def example():
            # [[should not match]]
            url = "[also not matched](file.md)"
            return "[[nope]]"
        ```

        After [[link2]]
        """
        links = self.extractor.extract_links(content)

        assert len(links) == 2
        assert links[0].target == "link1"
        assert links[1].target == "link2"

    def test_inline_code_with_links(self):
        """Test that inline code properly excludes links."""
        content = "Normal [[link]] and `[[code link]]` and another [[real link]]"
        links = self.extractor.extract_links(content)

        assert len(links) == 2
        assert links[0].target == "link"
        assert links[1].target == "real link"

    def test_wiki_link_whitespace_trimmed(self):
        """Test that whitespace in wiki-links is trimmed."""
        content = "[[ Python ]] and [[Django | framework ]]"
        links = self.extractor.extract_links(content)

        assert len(links) == 2
        assert links[0].target == "Python"
        assert links[0].link_text == "Python"
        assert links[1].target == "Django"
        assert links[1].link_text == "framework"

    def test_markdown_link_whitespace_trimmed(self):
        """Test that whitespace in markdown links is trimmed."""
        content = "[ text ]( file.md )"
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        assert links[0].link_text == "text"
        assert links[0].target == "file.md"

    @pytest.mark.asyncio
    async def test_resolve_link_target_stub(self):
        """Test that resolve_link_target returns None (stub implementation)."""
        result = await self.extractor.resolve_link_target("Python")
        assert result is None

    def test_position_tracking_accuracy(self):
        """Test that start_pos and end_pos are accurate."""
        content = "Text [[link]] more text"
        links = self.extractor.extract_links(content)

        assert len(links) == 1
        extracted = content[links[0].start_pos:links[0].end_pos]
        assert extracted == "[[link]]"

    def test_complex_document_structure(self):
        """Test extraction from a complex markdown document."""
        content = """
# Title

Introduction with [[WikiLink]] and [markdown](./file.md).

## Code Example

```python
# [[This should not match]]
url = "[neither should this](file.md)"
```

## More Content

See [[Python|the language]] for details.
Also check [docs](../docs/README.md).

Inline code: `[[ignore]]` and normal [[extract]].

External links: [google](https://google.com) are ignored.
Internal: [local](./local.md) are kept.
        """
        links = self.extractor.extract_links(content)

        assert len(links) == 6
        targets = [link.target for link in links]
        assert "WikiLink" in targets
        assert "./file.md" in targets
        assert "Python" in targets
        assert "../docs/README.md" in targets
        assert "extract" in targets
        assert "./local.md" in targets
