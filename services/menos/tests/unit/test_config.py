"""Unit tests for application configuration."""

import re

import pytest
from pydantic import ValidationError

from menos.config import Settings


class TestRequiredCredentialConfig:
    """Tests for required storage credentials."""

    @pytest.mark.parametrize(
        "key",
        ["SURREALDB_PASSWORD", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
    )
    def test_missing_storage_credential_is_rejected(self, monkeypatch, key):
        """Storage credentials must not fall back to development values."""
        monkeypatch.delenv(key)

        with pytest.raises(ValidationError):
            Settings(_env_file=None)


class TestUnifiedPipelineConfig:
    """Tests for unified pipeline configuration defaults."""

    def test_unified_pipeline_enabled_default(self):
        """unified_pipeline_enabled defaults to True."""
        s = Settings()
        assert s.unified_pipeline_enabled is True

    def test_unified_pipeline_provider_default(self):
        """unified_pipeline_provider defaults to 'openrouter'."""
        s = Settings()
        assert s.unified_pipeline_provider == "openrouter"

    def test_unified_pipeline_max_concurrency_default(self):
        """unified_pipeline_max_concurrency defaults to 4."""
        s = Settings()
        assert s.unified_pipeline_max_concurrency == 4

    def test_unified_pipeline_model_default(self):
        """unified_pipeline_model defaults to empty string."""
        s = Settings()
        assert s.unified_pipeline_model == ""


class TestAppVersion:
    """Tests for app_version property."""

    def test_app_version_returns_semver(self):
        """app_version should return a valid semver string from pyproject.toml."""
        s = Settings()
        version = s.app_version
        assert re.match(r"\d+\.\d+\.\d+", version)

    def test_app_version_not_unknown(self):
        """app_version should not be 'unknown' when pyproject.toml exists."""
        s = Settings()
        assert s.app_version != "unknown"
