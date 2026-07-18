"""Helpers for pipeline version parsing and drift detection."""


def parse_version_tuple(version: str | None) -> tuple[int, int, int] | None:
    """Parse semantic version string into (major, minor, patch)."""
    if not version:
        return None

    normalized = version.strip()
    if not normalized or normalized.lower() == "unknown":
        return None

    parts = normalized.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None

    return int(parts[0]), int(parts[1]), int(parts[2])


def has_version_drift(old_version: str | None, current_version: str | None) -> bool:
    """Return True when major or minor versions differ."""
    old_parsed = parse_version_tuple(old_version)
    current_parsed = parse_version_tuple(current_version)
    if old_parsed is None or current_parsed is None:
        return False

    old_major, old_minor, _ = old_parsed
    current_major, current_minor, _ = current_parsed
    return (old_major, old_minor) != (current_major, current_minor)
