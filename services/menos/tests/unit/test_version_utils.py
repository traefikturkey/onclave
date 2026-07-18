"""Unit tests for version utility helpers."""

import pytest

from menos.services.version_utils import has_version_drift, parse_version_tuple


class TestParseVersionTuple:
    """Tests for parse_version_tuple."""

    @pytest.mark.parametrize(
        ("version", "expected"),
        [
            ("0.4.2", (0, 4, 2)),
            ("10.20.30", (10, 20, 30)),
            (" 1.2.3 ", (1, 2, 3)),
            (None, None),
            ("unknown", None),
            ("UNKNOWN", None),
            ("1.2", None),
            ("1.2.3.4", None),
            ("1.two.3", None),
            ("x.y.z", None),
            ("", None),
        ],
    )
    def test_parse_version_tuple(self, version, expected):
        assert parse_version_tuple(version) == expected


class TestHasVersionDrift:
    """Tests for has_version_drift."""

    @pytest.mark.parametrize(
        ("old_version", "current_version", "expected"),
        [
            ("0.4.2", "0.4.3", False),
            ("1.2.9", "1.2.0", False),
            ("0.4.2", "0.5.0", True),
            ("0.4.2", "1.0.0", True),
            (None, "0.4.2", False),
            ("0.4.2", None, False),
            ("unknown", "0.4.2", False),
            ("0.4.2", "unknown", False),
            ("bad", "0.4.2", False),
            ("0.4.2", "bad", False),
        ],
    )
    def test_has_version_drift(self, old_version, current_version, expected):
        assert has_version_drift(old_version, current_version) is expected
