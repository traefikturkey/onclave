"""Link extraction service for wiki-links and markdown links."""

import re
from dataclasses import dataclass


@dataclass
class ExtractedLink:
    """Represents a link extracted from content."""

    link_text: str
    target: str
    link_type: str
    start_pos: int
    end_pos: int


class LinkExtractor:
    """Extracts and resolves links from markdown content."""

    # Wiki-link patterns: [[Title]] or [[Title|display text]]
    WIKI_LINK_PATTERN = re.compile(r"\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]")

    # Markdown link pattern: [text](url)
    MARKDOWN_LINK_PATTERN = re.compile(r"\[([^\]]+?)\]\(([^)]+?)\)")

    # Code block pattern to exclude links within code blocks
    CODE_BLOCK_PATTERN = re.compile(r"```[\s\S]*?```|`[^`]+?`", re.MULTILINE)

    def extract_links(self, content: str) -> list[ExtractedLink]:
        """
        Extract all links from content.

        Args:
            content: The markdown content to parse

        Returns:
            List of extracted links (wiki-links and internal markdown links)
        """
        links: list[ExtractedLink] = []

        # Find code blocks to exclude them from link extraction
        code_blocks = [
            (match.start(), match.end()) for match in self.CODE_BLOCK_PATTERN.finditer(content)
        ]

        # Extract wiki-links
        for match in self.WIKI_LINK_PATTERN.finditer(content):
            if self._is_in_code_block(match.start(), code_blocks):
                continue

            target = match.group(1).strip()
            display_text = match.group(2).strip() if match.group(2) else target

            links.append(
                ExtractedLink(
                    link_text=display_text,
                    target=target,
                    link_type="wiki",
                    start_pos=match.start(),
                    end_pos=match.end(),
                )
            )

        # Extract markdown links (skip external URLs)
        for match in self.MARKDOWN_LINK_PATTERN.finditer(content):
            if self._is_in_code_block(match.start(), code_blocks):
                continue

            link_text = match.group(1).strip()
            url = match.group(2).strip()

            # Skip external URLs
            if url.startswith(("http://", "https://", "//")):
                continue

            links.append(
                ExtractedLink(
                    link_text=link_text,
                    target=url,
                    link_type="markdown",
                    start_pos=match.start(),
                    end_pos=match.end(),
                )
            )

        # Sort by position
        links.sort(key=lambda x: x.start_pos)

        return links

    def extract_wiki_links(self, content: str) -> list[ExtractedLink]:
        """Extract only wiki-links from content."""
        all_links = self.extract_links(content)
        return [link for link in all_links if link.link_type == "wiki"]

    def extract_markdown_links(self, content: str) -> list[ExtractedLink]:
        """Extract only markdown links from content."""
        all_links = self.extract_links(content)
        return [link for link in all_links if link.link_type == "markdown"]

    async def resolve_link_target(self, target: str) -> str | None:
        """
        Resolve a link target to a content ID.

        Args:
            target: The link target (title or path)

        Returns:
            Content ID if found, None otherwise

        Note:
            This is a stub for now. Will be implemented to query
            the database for content matching the target.
        """
        return None

    def _is_in_code_block(self, position: int, code_blocks: list[tuple[int, int]]) -> bool:
        """Check if a position falls within any code block."""
        return any(start <= position < end for start, end in code_blocks)
