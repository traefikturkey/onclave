"""Unit tests for URL detector service."""


from menos.services.url_detector import URLDetector


class TestURLDetector:
    """Tests for URL detection service."""

    def setup_method(self):
        """Set up test fixtures."""
        self.detector = URLDetector()

    def test_detect_github_repo_basic(self):
        """Test detecting basic GitHub repository URL."""
        text = "Check out https://github.com/python/cpython for details."
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://github.com/python/cpython"
        assert urls[0].url_type == "github_repo"
        assert urls[0].extracted_id == "python/cpython"

    def test_detect_github_repo_with_trailing_slash(self):
        """Test GitHub URL with trailing slash."""
        text = "See https://github.com/owner/repo/ for code."
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://github.com/owner/repo"
        assert urls[0].extracted_id == "owner/repo"

    def test_detect_github_repo_with_path(self):
        """Test GitHub URL with additional path components."""
        text = "Link: https://github.com/owner/repo/blob/main/README.md"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://github.com/owner/repo"
        assert urls[0].extracted_id == "owner/repo"

    def test_detect_github_repo_with_query_params(self):
        """Test GitHub URL with query parameters."""
        text = "Visit https://github.com/owner/repo?tab=readme"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://github.com/owner/repo"
        assert urls[0].extracted_id == "owner/repo"

    def test_detect_github_repo_with_anchor(self):
        """Test GitHub URL with anchor."""
        text = "See https://github.com/owner/repo#readme"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://github.com/owner/repo"
        assert urls[0].extracted_id == "owner/repo"

    def test_detect_github_repo_with_git_extension(self):
        """Test GitHub URL with .git extension."""
        text = "Clone https://github.com/owner/repo.git"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "owner/repo"

    def test_detect_github_repo_with_hyphens_underscores(self):
        """Test GitHub repo with hyphens and underscores."""
        text = "Link: https://github.com/my-org/my_repo-name"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "my-org/my_repo-name"

    def test_detect_arxiv_basic(self):
        """Test detecting basic arXiv URL."""
        text = "Read https://arxiv.org/abs/2301.12345 for details."
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://arxiv.org/abs/2301.12345"
        assert urls[0].url_type == "arxiv"
        assert urls[0].extracted_id == "2301.12345"

    def test_detect_arxiv_with_version(self):
        """Test arXiv URL with version number."""
        text = "Paper: https://arxiv.org/abs/2301.12345v2"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "2301.12345v2"

    def test_detect_arxiv_five_digit_suffix(self):
        """Test arXiv ID with 5-digit suffix."""
        text = "See https://arxiv.org/abs/1234.56789"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "1234.56789"

    def test_detect_doi_basic(self):
        """Test detecting basic DOI URL."""
        text = "Reference: https://doi.org/10.1234/example.paper.2024"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://doi.org/10.1234/example.paper.2024"
        assert urls[0].url_type == "doi"
        assert urls[0].extracted_id == "10.1234/example.paper.2024"

    def test_detect_doi_with_special_chars(self):
        """Test DOI with special characters."""
        text = "DOI: https://doi.org/10.1000/xyz123(abc)def"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "10.1000/xyz123(abc)def"

    def test_detect_doi_followed_by_period(self):
        """Test DOI URL at end of sentence."""
        text = "See https://doi.org/10.1234/example."
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://doi.org/10.1234/example"

    def test_detect_doi_followed_by_whitespace(self):
        """Test DOI URL followed by whitespace."""
        text = "Link https://doi.org/10.1234/example and more text"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "10.1234/example"

    def test_detect_pypi_basic(self):
        """Test detecting basic PyPI package URL."""
        text = "Install from https://pypi.org/project/requests/"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://pypi.org/project/requests"
        assert urls[0].url_type == "pypi"
        assert urls[0].extracted_id == "requests"

    def test_detect_pypi_with_hyphens(self):
        """Test PyPI package with hyphens."""
        text = "Get https://pypi.org/project/python-dateutil"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "python-dateutil"

    def test_detect_pypi_with_query_params(self):
        """Test PyPI URL with query parameters."""
        text = "Link: https://pypi.org/project/requests?tab=files"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://pypi.org/project/requests"

    def test_detect_npm_basic(self):
        """Test detecting basic npm package URL."""
        text = "Install https://www.npmjs.com/package/express"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://www.npmjs.com/package/express"
        assert urls[0].url_type == "npm"
        assert urls[0].extracted_id == "express"

    def test_detect_npm_without_www(self):
        """Test npm URL without www prefix."""
        text = "Get https://npmjs.com/package/react"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "react"

    def test_detect_npm_scoped_package(self):
        """Test npm scoped package."""
        text = "Install https://npmjs.com/package/@types/node"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "@types/node"

    def test_detect_npm_with_trailing_slash(self):
        """Test npm URL with trailing slash."""
        text = "Link: https://npmjs.com/package/express/"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].url == "https://npmjs.com/package/express"

    def test_detect_multiple_urls_mixed_types(self):
        """Test detecting multiple URLs of different types."""
        text = """
        GitHub: https://github.com/python/cpython
        arXiv: https://arxiv.org/abs/2301.12345
        DOI: https://doi.org/10.1234/example
        PyPI: https://pypi.org/project/requests
        npm: https://npmjs.com/package/express
        """
        urls = self.detector.detect_urls(text)

        assert len(urls) == 5
        url_types = [url.url_type for url in urls]
        assert "github_repo" in url_types
        assert "arxiv" in url_types
        assert "doi" in url_types
        assert "pypi" in url_types
        assert "npm" in url_types

    def test_detect_multiple_same_type(self):
        """Test detecting multiple URLs of the same type."""
        text = """
        Repo1: https://github.com/owner1/repo1
        Repo2: https://github.com/owner2/repo2
        Repo3: https://github.com/owner3/repo3
        """
        urls = self.detector.detect_urls(text)

        assert len(urls) == 3
        assert all(url.url_type == "github_repo" for url in urls)
        ids = [url.extracted_id for url in urls]
        assert "owner1/repo1" in ids
        assert "owner2/repo2" in ids
        assert "owner3/repo3" in ids

    def test_detect_github_repos_only(self):
        """Test extracting only GitHub repos."""
        text = """
        GitHub: https://github.com/owner/repo
        PyPI: https://pypi.org/project/requests
        Another GitHub: https://github.com/python/cpython
        """
        urls = self.detector.detect_github_repos(text)

        assert len(urls) == 2
        assert all(url.url_type == "github_repo" for url in urls)

    def test_detect_arxiv_only(self):
        """Test extracting only arXiv papers."""
        text = """
        Paper: https://arxiv.org/abs/2301.12345
        GitHub: https://github.com/owner/repo
        Another paper: https://arxiv.org/abs/1234.5678
        """
        urls = self.detector.detect_arxiv(text)

        assert len(urls) == 2
        assert all(url.url_type == "arxiv" for url in urls)

    def test_detect_dois_only(self):
        """Test extracting only DOIs."""
        text = """
        DOI: https://doi.org/10.1234/example
        npm: https://npmjs.com/package/express
        Another DOI: https://doi.org/10.5678/another
        """
        urls = self.detector.detect_dois(text)

        assert len(urls) == 2
        assert all(url.url_type == "doi" for url in urls)

    def test_detect_pypi_only(self):
        """Test extracting only PyPI packages."""
        text = """
        PyPI: https://pypi.org/project/requests
        GitHub: https://github.com/owner/repo
        Another PyPI: https://pypi.org/project/flask
        """
        urls = self.detector.detect_pypi(text)

        assert len(urls) == 2
        assert all(url.url_type == "pypi" for url in urls)

    def test_detect_npm_only(self):
        """Test extracting only npm packages."""
        text = """
        npm: https://npmjs.com/package/react
        arXiv: https://arxiv.org/abs/2301.12345
        Another npm: https://npmjs.com/package/vue
        """
        urls = self.detector.detect_npm(text)

        assert len(urls) == 2
        assert all(url.url_type == "npm" for url in urls)

    def test_empty_text(self):
        """Test detection from empty text."""
        urls = self.detector.detect_urls("")
        assert len(urls) == 0

    def test_text_with_no_urls(self):
        """Test text without any supported URLs."""
        text = "Just plain text with no URLs at all."
        urls = self.detector.detect_urls(text)
        assert len(urls) == 0

    def test_text_with_unsupported_urls(self):
        """Test text with URLs that don't match patterns."""
        text = """
        https://example.com
        https://google.com
        https://stackoverflow.com/questions/12345
        """
        urls = self.detector.detect_urls(text)
        assert len(urls) == 0

    def test_partial_matches_not_detected(self):
        """Test that partial matches don't trigger false positives."""
        text = """
        Not GitHub: https://notgithub.com/owner/repo
        Not arXiv: https://notarxiv.org/abs/1234.5678
        Not PyPI: https://notpypi.org/project/package
        """
        urls = self.detector.detect_urls(text)
        assert len(urls) == 0

    def test_github_repo_with_dots_in_name(self):
        """Test GitHub repo with dots in repository name."""
        text = "https://github.com/owner/repo.name.js"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 1
        assert urls[0].extracted_id == "owner/repo.name.js"

    def test_complex_document_with_multiple_urls(self):
        """Test detection from complex markdown document."""
        text = """
# Research Notes

## Papers
- Attention mechanism: https://arxiv.org/abs/1706.03762
- DOI reference: https://doi.org/10.1234/nature.2024.001

## Code
- Implementation: https://github.com/tensorflow/tensorflow
- Another repo: https://github.com/pytorch/pytorch/tree/main

## Dependencies
- Python: https://pypi.org/project/torch
- JavaScript: https://npmjs.com/package/@tensorflow/tfjs

Random text and https://google.com (not detected).
        """
        urls = self.detector.detect_urls(text)

        assert len(urls) == 6
        url_types = [url.url_type for url in urls]
        assert url_types.count("arxiv") == 1
        assert url_types.count("doi") == 1
        assert url_types.count("github_repo") == 2
        assert url_types.count("pypi") == 1
        assert url_types.count("npm") == 1

    def test_urls_in_markdown_links(self):
        """Test URLs within markdown link syntax."""
        text = "[PyPI](https://pypi.org/project/requests) and [GitHub](https://github.com/owner/repo)"
        urls = self.detector.detect_urls(text)

        assert len(urls) == 2
        assert urls[0].url_type == "pypi"
        assert urls[1].url_type == "github_repo"
