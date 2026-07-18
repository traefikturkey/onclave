"""Tests for resource key generation and URL normalization."""

from menos.services.resource_key import generate_resource_key, normalize_url


class TestYoutubeResourceKey:
    """Test YouTube resource key generation."""

    def test_youtube_resource_key(self):
        """YouTube content should produce yt:<video_id> key."""
        key = generate_resource_key("youtube", "dQw4w9WgXcQ")
        assert key == "yt:dQw4w9WgXcQ"


class TestUrlResourceKey:
    """Test URL resource key generation."""

    def test_url_resource_key(self):
        """URL content should produce url:<16-char-base64url-hash> key."""
        key = generate_resource_key("url", "https://example.com/article")
        assert key.startswith("url:")
        # 12 bytes base64url encoded = 16 chars
        assert len(key.split(":")[1]) == 16

    def test_url_resource_key_deterministic(self):
        """Same URL should always produce same key."""
        key1 = generate_resource_key("url", "https://example.com/article")
        key2 = generate_resource_key("url", "https://example.com/article")
        assert key1 == key2

    def test_url_resource_key_different_urls(self):
        """Different URLs should produce different keys."""
        key1 = generate_resource_key("url", "https://example.com/article1")
        key2 = generate_resource_key("url", "https://example.com/article2")
        assert key1 != key2


class TestFallbackResourceKey:
    """Test fallback resource key generation."""

    def test_fallback_resource_key(self):
        """Unknown content types should produce cid:<content_id> key."""
        key = generate_resource_key("document", "abc123")
        assert key == "cid:abc123"


class TestNormalizeUrl:
    """Test URL normalization."""

    def test_normalize_url_lowercase_host(self):
        """Host should be lowercased."""
        result = normalize_url("HTTP://Example.COM/path")
        assert result == "https://example.com/path"

    def test_normalize_url_strip_fragment(self):
        """Fragment (#section) should be removed."""
        result = normalize_url("https://example.com/page#section")
        assert result == "https://example.com/page"

    def test_normalize_url_remove_tracking_params(self):
        """Tracking params (utm_*, fbclid, gclid) should be removed."""
        result = normalize_url(
            "https://example.com/page?utm_source=twitter&utm_medium=social&id=42"
        )
        assert "utm_source" not in result
        assert "utm_medium" not in result
        assert "id=42" in result

    def test_normalize_url_sort_params(self):
        """Query params should be sorted alphabetically."""
        result = normalize_url("https://example.com/page?b=2&a=1")
        assert result == "https://example.com/page?a=1&b=2"

    def test_normalize_url_remove_default_ports(self):
        """Default ports (80 for http, 443 for https) should be removed."""
        result = normalize_url("https://example.com:443/path")
        assert ":443" not in result
        assert result == "https://example.com/path"

    def test_normalize_url_remove_http_default_port(self):
        """Port 80 should be removed (and scheme upgraded to https)."""
        result = normalize_url("http://example.com:80/path")
        assert ":80" not in result

    def test_normalize_url_trailing_slash(self):
        """Trailing slash should be stripped except for root path."""
        result = normalize_url("https://example.com/page/")
        assert result == "https://example.com/page"

    def test_normalize_url_root_trailing_slash_kept(self):
        """Root path trailing slash should be kept."""
        result = normalize_url("https://example.com/")
        assert result == "https://example.com/"

    def test_normalize_url_idempotent(self):
        """Normalizing twice should give the same result."""
        url = "HTTP://Example.COM:443/page?b=2&a=1&utm_source=x#section"
        first = normalize_url(url)
        second = normalize_url(first)
        assert first == second

    def test_normalize_url_preserves_identity_params(self):
        """Identity-bearing params like v=, id= should be preserved."""
        result = normalize_url("https://example.com/watch?v=dQw4w9WgXcQ&utm_source=google")
        assert "v=dQw4w9WgXcQ" in result
        assert "utm_source" not in result
