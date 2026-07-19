"""Tests for the stack-specific Bitwarden environment renderer."""

import importlib.util
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[4] / "scripts" / "onclave-bws-env.py"
SPEC = importlib.util.spec_from_file_location("onclave_bws_env", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def menos_values() -> dict[str, str]:
    return {
        "SURREALDB_PASSWORD": "0123456789abcdef",
        "S3_ACCESS_KEY": "minioadmin",
        "S3_SECRET_KEY": "0123456789abcdef",
        "SEARXNG_SECRET": "0123456789abcdef",
        "WEBSHARE_PROXY_USERNAME": "proxy-user",
        "WEBSHARE_PROXY_PASSWORD": "0123456789abcdef",
        "YOUTUBE_API_KEY": "0123456789abcdef",
        "OPENROUTER_API_KEY": "0123456789abcdef",
        "ANTHROPIC_API_KEY": "0123456789abcdef",
    }


def test_menos_stack_validates_required_secrets() -> None:
    config = MODULE.STACKS["menos"]

    assert MODULE.validate(menos_values(), config["required"]) == []


@pytest.mark.parametrize("key", ["SURREALDB_PASSWORD", "YOUTUBE_API_KEY"])
def test_menos_stack_rejects_missing_required_secret(key: str) -> None:
    config = MODULE.STACKS["menos"]
    values = menos_values()
    del values[key]

    assert MODULE.validate(values, config["required"]) == [f"{key}: missing or empty"]


def test_menos_render_includes_defaults_and_legacy_minio_aliases() -> None:
    config = MODULE.STACKS["menos"]
    rendered = MODULE.render(
        menos_values(),
        config["required"],
        config["optional"],
        config["defaults"],
        config["aliases"],
    )

    assert "S3_ACCESS_KEY=minioadmin" in rendered
    assert "MINIO_ACCESS_KEY=minioadmin" in rendered
    assert "S3_BUCKET=menos" in rendered
    assert "MINIO_BUCKET=menos" in rendered
    assert "RABBITMQ_DEFAULT_PASS" not in rendered
