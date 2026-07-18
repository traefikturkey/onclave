"""Unit tests for URL filter service."""

from menos.services.url_filter import apply_heuristic_filter, is_blocked_by_heuristic


class TestIsBlockedByHeuristic:
    """Tests for is_blocked_by_heuristic function."""

    # --- Content URLs that should pass through ---

    def test_github_repo_passes(self):
        blocked, reason = is_blocked_by_heuristic("https://github.com/user/repo")
        assert not blocked
        assert reason is None

    def test_docs_url_passes(self):
        blocked, reason = is_blocked_by_heuristic("https://docs.python.org/3/library/re.html")
        assert not blocked
        assert reason is None

    def test_blog_url_passes(self):
        blocked, reason = is_blocked_by_heuristic("https://example.com/blog/great-article")
        assert not blocked
        assert reason is None

    def test_arxiv_url_passes(self):
        blocked, reason = is_blocked_by_heuristic("https://arxiv.org/abs/2301.00001")
        assert not blocked
        assert reason is None

    def test_medium_article_passes(self):
        blocked, reason = is_blocked_by_heuristic(
            "https://medium.com/@user/some-article-abc123"
        )
        assert not blocked
        assert reason is None

    def test_twitter_tweet_passes(self):
        """Tweet URLs (with status path) should NOT be blocked."""
        blocked, reason = is_blocked_by_heuristic(
            "https://twitter.com/user/status/1234567890"
        )
        assert not blocked
        assert reason is None

    def test_x_tweet_passes(self):
        blocked, reason = is_blocked_by_heuristic(
            "https://x.com/user/status/1234567890"
        )
        assert not blocked
        assert reason is None

    # --- Marketing URLs that should be blocked ---

    def test_gumroad_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://gumroad.com/product")
        assert blocked
        assert "gumroad.com" in reason

    def test_patreon_join_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://patreon.com/join/creator")
        assert blocked

    def test_ko_fi_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://ko-fi.com/creator")
        assert blocked

    def test_buymeacoffee_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://buymeacoffee.com/creator")
        assert blocked

    def test_bit_ly_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://bit.ly/abc123")
        assert blocked

    def test_amzn_to_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://amzn.to/abc123")
        assert blocked

    def test_linktree_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://linktr.ee/creator")
        assert blocked

    # --- Affiliate/tracking URL patterns ---

    def test_utm_params_blocked(self):
        blocked, reason = is_blocked_by_heuristic(
            "https://example.com/page?utm_source=youtube"
        )
        assert blocked
        assert "utm_" in reason

    def test_affiliate_param_blocked(self):
        blocked, reason = is_blocked_by_heuristic(
            "https://example.com/page?affiliate=abc"
        )
        assert blocked

    def test_ref_param_blocked(self):
        blocked, reason = is_blocked_by_heuristic(
            "https://example.com/page?ref=youtube"
        )
        assert blocked

    def test_checkout_path_blocked(self):
        blocked, reason = is_blocked_by_heuristic(
            "https://example.com/checkout/step1"
        )
        assert blocked

    # --- Social media profiles ---

    def test_twitter_profile_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://twitter.com/username")
        assert blocked
        assert "Social media profile" in reason

    def test_x_profile_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://x.com/username")
        assert blocked

    def test_instagram_profile_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://instagram.com/username")
        assert blocked

    def test_tiktok_profile_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://tiktok.com/@username")
        assert blocked

    def test_youtube_channel_profile_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://youtube.com/@channelname")
        assert blocked

    def test_linkedin_profile_blocked(self):
        blocked, reason = is_blocked_by_heuristic("https://linkedin.com/in/username")
        assert blocked


class TestApplyHeuristicFilter:
    """Tests for apply_heuristic_filter function."""

    def test_empty_input(self):
        result = apply_heuristic_filter([])
        assert result["blocked"] == []
        assert result["remaining"] == []

    def test_all_content_urls(self):
        urls = [
            "https://github.com/user/repo",
            "https://docs.python.org/3/library/re.html",
            "https://arxiv.org/abs/2301.00001",
        ]
        result = apply_heuristic_filter(urls)
        assert len(result["blocked"]) == 0
        assert len(result["remaining"]) == 3

    def test_all_blocked_urls(self):
        urls = [
            "https://gumroad.com/product",
            "https://bit.ly/abc123",
            "https://twitter.com/username",
        ]
        result = apply_heuristic_filter(urls)
        assert len(result["blocked"]) == 3
        assert len(result["remaining"]) == 0

    def test_mixed_urls(self):
        urls = [
            "https://github.com/user/repo",
            "https://gumroad.com/product",
            "https://docs.python.org/3/library/re.html",
            "https://bit.ly/abc123",
        ]
        result = apply_heuristic_filter(urls)
        assert len(result["blocked"]) == 2
        assert len(result["remaining"]) == 2
        assert result["remaining"] == [
            "https://github.com/user/repo",
            "https://docs.python.org/3/library/re.html",
        ]

    def test_blocked_includes_reasons(self):
        urls = ["https://gumroad.com/product"]
        result = apply_heuristic_filter(urls)
        assert len(result["blocked"]) == 1
        url, reason = result["blocked"][0]
        assert url == "https://gumroad.com/product"
        assert "gumroad.com" in reason

    def test_single_url_passes(self):
        result = apply_heuristic_filter(["https://example.com/article"])
        assert len(result["remaining"]) == 1
        assert len(result["blocked"]) == 0

    def test_single_url_blocked(self):
        result = apply_heuristic_filter(["https://ko-fi.com/creator"])
        assert len(result["remaining"]) == 0
        assert len(result["blocked"]) == 1
