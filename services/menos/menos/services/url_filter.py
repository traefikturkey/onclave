"""Heuristic URL classification for YouTube video descriptions.

Classifies URLs found in video descriptions as content or marketing/spam
using rule-based heuristics (blocked domains, URL patterns, social profiles).
"""

import re

# Domains associated with monetization, affiliate programs, or link aggregators
BLOCKED_DOMAINS = [
    # Checkout/payment
    "gumroad.com",
    "patreon.com/join",
    "ko-fi.com",
    "buymeacoffee.com",
    "circle.so/checkout",
    "memberful.com",
    "teachable.com",
    # Affiliate/tracking
    "bit.ly",
    "tinyurl.com",
    "amzn.to",
    "amazon.com/dp",
    "shareasale.com",
    "linksynergy.com",
    # Link aggregators
    "linktree",
    "beacons.ai",
    "linktr.ee",
    "bio.link",
    "hoo.be",
    "carrd.co",
]

# URL path/query patterns that indicate marketing or tracking
BLOCKED_URL_PATTERNS = [
    r"checkout",
    r"buy",
    r"order",
    r"cart",
    r"payment",
    r"subscribe",
    r"join",
    r"membership",
    r"\?ref=",
    r"\?affiliate=",
    r"\?utm_",
    r"amzn\.to",
]

# Social media profile URLs (not individual posts/content)
SOCIAL_PROFILE_PATTERNS = [
    r"twitter\.com/[^/]+$",
    r"x\.com/[^/]+$",
    r"instagram\.com/[^/]+/?$",
    r"tiktok\.com/@[^/]+$",
    r"facebook\.com/[^/]+$",
    r"linkedin\.com/in/[^/]+$",
    r"youtube\.com/@[^/]+$",
    r"youtube\.com/c/[^/]+$",
]


def is_blocked_by_heuristic(url: str) -> tuple[bool, str | None]:
    """Check if a URL should be blocked by heuristic rules.

    Returns:
        Tuple of (is_blocked, reason). reason is None if not blocked.
    """
    url_lower = url.lower()

    # Check blocked domains
    for domain in BLOCKED_DOMAINS:
        if domain in url_lower:
            return True, f"Blocked domain: {domain}"

    # Check blocked URL patterns
    for pattern in BLOCKED_URL_PATTERNS:
        if re.search(pattern, url_lower):
            return True, f"Blocked pattern: {pattern}"

    # Check social profile patterns
    for pattern in SOCIAL_PROFILE_PATTERNS:
        if re.search(pattern, url_lower):
            return True, "Social media profile (not content)"

    return False, None


def apply_heuristic_filter(urls: list[str]) -> dict:
    """Apply heuristic filtering to a list of URLs.

    Returns:
        Dict with:
            - blocked: list of (url, reason) tuples for blocked URLs
            - remaining: list of URLs that passed the heuristic filter
    """
    blocked = []
    remaining = []

    for url in urls:
        is_blocked, reason = is_blocked_by_heuristic(url)
        if is_blocked:
            blocked.append((url, reason))
        else:
            remaining.append(url)

    return {
        "blocked": blocked,
        "remaining": remaining,
    }
