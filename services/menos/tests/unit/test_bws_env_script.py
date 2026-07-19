"""Tests for the stack-specific Bitwarden environment renderer."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

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


def test_env_provider_loads_plain_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / "onclave.env"
    env_file.write_text(
        "RABBITMQ_DEFAULT_USER=onclave\nRABBITMQ_DEFAULT_PASS='0123456789abcdef'\n",
        encoding="utf-8",
    )
    args = SimpleNamespace(provider="env", env_file=str(env_file))

    assert MODULE.load_secrets(args, "") == {
        "RABBITMQ_DEFAULT_USER": "onclave",
        "RABBITMQ_DEFAULT_PASS": "0123456789abcdef",
    }


def test_bws_provider_loads_project_values(monkeypatch) -> None:
    payload = [{"key": "RABBITMQ_DEFAULT_USER", "value": "onclave"}]
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload))

    monkeypatch.setenv("BITWARDEN_ACCESS_KEY", "test-access-token")
    monkeypatch.setattr(MODULE.subprocess, "run", fake_run)
    args = SimpleNamespace(
        provider="bws",
        access_token=None,
        api_server=None,
    )

    assert MODULE.load_secrets(args, "project-id") == {"RABBITMQ_DEFAULT_USER": "onclave"}
    assert captured["command"] == [
        "bws",
        "secret",
        "list",
        "project-id",
        "--output",
        "json",
    ]


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
