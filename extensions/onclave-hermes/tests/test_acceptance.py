import os
from pathlib import Path

import pytest

from src.config import GatewayConfig


def test_config_accepts_existing_session_token_without_private_key(monkeypatch):
    monkeypatch.setenv("ONCLAVE_GATEWAY_URL", "https://gateway.example")
    monkeypatch.setenv("ONCLAVE_AGENT_ID", "agent-hermes")
    monkeypatch.delenv("ONCLAVE_PRIVATE_KEY", raising=False)
    monkeypatch.setenv("ONCLAVE_SESSION_TOKEN", "session-token")
    config = GatewayConfig.from_environment()
    assert config.private_key_hex == ""


def test_acceptance_script_is_present():
    assert Path(__file__).parents[1].joinpath("scripts/gateway_acceptance.py").exists()
