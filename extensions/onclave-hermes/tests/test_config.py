import pytest

from src.config import ConfigError, GatewayConfig


def test_config_requires_gateway_url_agent_and_private_key(monkeypatch):
    monkeypatch.delenv("ONCLAVE_GATEWAY_URL", raising=False)
    monkeypatch.delenv("ONCLAVE_AGENT_ID", raising=False)
    monkeypatch.delenv("ONCLAVE_PRIVATE_KEY", raising=False)

    with pytest.raises(ConfigError, match="ONCLAVE_GATEWAY_URL"):
        GatewayConfig.from_environment()


def test_config_rejects_non_tls_gateway(monkeypatch):
    monkeypatch.setenv("ONCLAVE_GATEWAY_URL", "http://gateway.example")
    monkeypatch.setenv("ONCLAVE_AGENT_ID", "agent-hermes")
    monkeypatch.setenv("ONCLAVE_PRIVATE_KEY", "a" * 64)

    with pytest.raises(ConfigError, match="HTTPS"):
        GatewayConfig.from_environment()


def test_config_does_not_make_network_calls(monkeypatch):
    monkeypatch.setenv("ONCLAVE_GATEWAY_URL", "https://gateway.example")
    monkeypatch.setenv("ONCLAVE_AGENT_ID", "agent-hermes")
    monkeypatch.setenv("ONCLAVE_PRIVATE_KEY", "a" * 64)

    config = GatewayConfig.from_environment()
    assert config.base_url == "https://gateway.example"
    assert config.agent_id == "agent-hermes"
    assert config.private_key_hex == "a" * 64
