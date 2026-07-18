"""URL detection service for GitHub repos, arXiv papers, DOIs, PyPI, and npm packages."""

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse


@dataclass
class DetectedURL:
    """Represents a URL detected in content."""

    url: str
    url_type: str
    extracted_id: str


class URLDetector:
    """Detects and extracts information from various URL types."""

    # GitHub repository
    GITHUB_REPO_PATTERN = re.compile(
        r"https?://github\.com/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:/|\s|\)|\?|#|$)"
    )

    # arXiv
    ARXIV_PATTERN = re.compile(r"https?://arxiv\.org/abs/(\d{4}\.\d{4,5}(?:v\d+)?)")

    # DOI
    DOI_PATTERN = re.compile(r"https?://doi\.org/(10\.\d{4,}/[^\s<>\"]+?)(?:\s|<|>|\"|$)")

    # PyPI
    PYPI_PATTERN = re.compile(r"https?://pypi\.org/project/([a-zA-Z0-9_-]+)/?(?:\s|\)|\?|#|$)")

    # npm
    NPM_PATTERN = re.compile(
        r"https?://(?:www\.)?npmjs\.com/package/([@a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)?)/?(?:\s|\)|\?|#|$)"
    )

    YOUTUBE_WATCH_PATTERN = re.compile(r"(?:youtube\.com|m\.youtube\.com|www\.youtube\.com)")
    YOUTUBE_SHORT_PATTERN = re.compile(r"(?:youtu\.be)/([0-9A-Za-z_-]{11})")

    def detect_urls(self, text: str) -> list[DetectedURL]:
        """
        Detect all supported URLs in text.

        Args:
            text: The text content to scan for URLs

        Returns:
            List of detected URLs with their types and extracted IDs
        """
        detected: list[tuple[int, DetectedURL]] = []
        detected.extend(self._detect_github(text))
        detected.extend(self._detect_arxiv(text))
        detected.extend(self._detect_doi(text))
        detected.extend(self._detect_pypi(text))
        detected.extend(self._detect_npm(text))
        detected.sort(key=lambda x: x[0])
        return [url for _, url in detected]

    def _detect_github(self, text: str) -> list[tuple[int, DetectedURL]]:
        results = []
        for match in self.GITHUB_REPO_PATTERN.finditer(text):
            owner, repo = match.group(1), match.group(2)
            matched_text = match.group(0).rstrip("/ \t\r\n?#)")
            protocol = "https" if matched_text.startswith("https") else "http"
            results.append(
                (
                    match.start(),
                    DetectedURL(
                        url=f"{protocol}://github.com/{owner}/{repo}",
                        url_type="github_repo",
                        extracted_id=f"{owner}/{repo}",
                    ),
                )
            )
        return results

    def _detect_arxiv(self, text: str) -> list[tuple[int, DetectedURL]]:
        results = []
        for match in self.ARXIV_PATTERN.finditer(text):
            results.append(
                (
                    match.start(),
                    DetectedURL(
                        url=match.group(0).rstrip(" \t\r\n)"),
                        url_type="arxiv",
                        extracted_id=match.group(1),
                    ),
                )
            )
        return results

    def _detect_doi(self, text: str) -> list[tuple[int, DetectedURL]]:
        results = []
        for match in self.DOI_PATTERN.finditer(text):
            results.append(
                (
                    match.start(),
                    DetectedURL(
                        url=match.group(0).rstrip(' \t\r\n<>".)'),
                        url_type="doi",
                        extracted_id=match.group(1),
                    ),
                )
            )
        return results

    def _detect_pypi(self, text: str) -> list[tuple[int, DetectedURL]]:
        results = []
        for match in self.PYPI_PATTERN.finditer(text):
            package = match.group(1)
            matched_text = match.group(0)
            protocol = "https" if matched_text.startswith("https") else "http"
            results.append(
                (
                    match.start(),
                    DetectedURL(
                        url=f"{protocol}://pypi.org/project/{package}",
                        url_type="pypi",
                        extracted_id=package,
                    ),
                )
            )
        return results

    def _detect_npm(self, text: str) -> list[tuple[int, DetectedURL]]:
        results = []
        for match in self.NPM_PATTERN.finditer(text):
            package = match.group(1)
            matched_text = match.group(0)
            protocol = "https" if matched_text.startswith("https") else "http"
            www_part = "www." if "www." in matched_text else ""
            results.append(
                (
                    match.start(),
                    DetectedURL(
                        url=f"{protocol}://{www_part}npmjs.com/package/{package}",
                        url_type="npm",
                        extracted_id=package,
                    ),
                )
            )
        return results

    def detect_github_repos(self, text: str) -> list[DetectedURL]:
        """Detect only GitHub repository URLs."""
        all_urls = self.detect_urls(text)
        return [url for url in all_urls if url.url_type == "github_repo"]

    def detect_arxiv(self, text: str) -> list[DetectedURL]:
        """Detect only arXiv paper URLs."""
        all_urls = self.detect_urls(text)
        return [url for url in all_urls if url.url_type == "arxiv"]

    def detect_dois(self, text: str) -> list[DetectedURL]:
        """Detect only DOI URLs."""
        all_urls = self.detect_urls(text)
        return [url for url in all_urls if url.url_type == "doi"]

    def detect_pypi(self, text: str) -> list[DetectedURL]:
        """Detect only PyPI package URLs."""
        all_urls = self.detect_urls(text)
        return [url for url in all_urls if url.url_type == "pypi"]

    def detect_npm(self, text: str) -> list[DetectedURL]:
        """Detect only npm package URLs."""
        all_urls = self.detect_urls(text)
        return [url for url in all_urls if url.url_type == "npm"]

    def classify_url(self, url: str) -> DetectedURL:
        """Classify a single URL for ingest routing."""
        parsed = urlparse(url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return DetectedURL(url=url, url_type="unknown", extracted_id="")

        youtube_id = self._extract_youtube_id(parsed)
        if youtube_id:
            return DetectedURL(url=url, url_type="youtube", extracted_id=youtube_id)

        detected = self.detect_urls(url)
        if detected:
            return detected[0]

        return DetectedURL(url=url, url_type="web", extracted_id="")

    _YT_ID_RE = re.compile(r"[0-9A-Za-z_-]{11}")

    def _extract_youtube_id(self, parsed_url) -> str | None:
        netloc = (parsed_url.netloc or "").lower()
        path = parsed_url.path or ""

        short_match = self.YOUTUBE_SHORT_PATTERN.search(f"{netloc}{path}")
        if short_match:
            return short_match.group(1)

        if not self.YOUTUBE_WATCH_PATTERN.search(netloc):
            return None

        return self._extract_youtube_watch_id(parsed_url.query, path)

    def _valid_yt_id(self, candidate: str) -> str | None:
        """Return candidate if it matches the YouTube video ID format, else None."""
        return candidate if self._YT_ID_RE.fullmatch(candidate) else None

    def _extract_youtube_watch_id(self, query_string: str, path: str) -> str | None:
        """Extract video ID from a youtube.com watch/shorts/embed URL."""
        query = parse_qs(query_string)
        if "v" in query and query["v"]:
            result = self._valid_yt_id(query["v"][0])
            if result:
                return result

        path_parts = [part for part in path.split("/") if part]
        if len(path_parts) >= 2 and path_parts[0] in {"shorts", "embed"}:
            return self._valid_yt_id(path_parts[1])

        return None
