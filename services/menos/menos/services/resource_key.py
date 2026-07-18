"""Canonical resource key generation and URL normalization."""

import base64
import hashlib
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "_ga",
    "_gid",
}


def _normalize_scheme_host(parsed) -> tuple[str, str, int | None]:
    """Return (scheme, host, port) with http→https and default ports removed."""
    scheme = "https" if parsed.scheme.lower() == "http" else parsed.scheme.lower()
    host = parsed.hostname or ""
    port = parsed.port if parsed.port not in (80, 443, None) else None
    return scheme, host, port


def _normalize_path(path: str) -> str:
    """Strip trailing slash except for root '/'."""
    if path != "/" and path.endswith("/"):
        return path.rstrip("/")
    return path


def _normalize_query(query_string: str) -> str:
    """Remove tracking params and sort remaining query params."""
    params = parse_qs(query_string, keep_blank_values=True)
    filtered = {k: v for k, v in params.items() if k not in TRACKING_PARAMS}
    pairs = [(k, v) for k in sorted(filtered) for v in filtered[k]]
    return urlencode(pairs)


def normalize_url(url: str) -> str:
    """Normalize a URL for consistent hashing."""
    parsed = urlparse(url)
    scheme, host, port = _normalize_scheme_host(parsed)
    netloc = f"{host}:{port}" if port else host
    path = _normalize_path(parsed.path)
    query = _normalize_query(parsed.query)
    return urlunparse((scheme, netloc, path, "", query, ""))


def generate_resource_key(content_type: str, identifier: str) -> str:
    """Generate a canonical resource key for deduplication.

    Args:
        content_type: Type of content (youtube, url, document, etc.)
        identifier: Video ID, URL, or content ID

    Returns:
        Canonical resource key string
    """
    if content_type == "youtube":
        return f"yt:{identifier}"
    elif content_type == "url":
        normalized = normalize_url(identifier)
        digest = hashlib.sha256(normalized.encode()).digest()
        hash16 = base64.urlsafe_b64encode(digest[:12]).decode().rstrip("=")
        return f"url:{hash16}"
    else:
        return f"cid:{identifier}"
