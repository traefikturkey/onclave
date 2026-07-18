from __future__ import annotations

import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class GatewayConfig:
    base_url: str
    agent_id: str
    private_key_hex: str
    request_timeout: float = 15.0
    heartbeat_interval: float = 20.0
    state_path: str | None = None

    @classmethod
    def from_environment(cls) -> "GatewayConfig":
        base_url = os.getenv("ONCLAVE_GATEWAY_URL", "").strip().rstrip("/")
        agent_id = os.getenv("ONCLAVE_AGENT_ID", "").strip()
        private_key_hex = os.getenv("ONCLAVE_PRIVATE_KEY", "").strip()
        session_token = os.getenv("ONCLAVE_SESSION_TOKEN", "").strip()
        if not base_url:
            raise ConfigError("missing ONCLAVE_GATEWAY_URL")
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ConfigError("ONCLAVE_GATEWAY_URL must be an HTTPS URL")
        if parsed.username is not None or parsed.password is not None:
            raise ConfigError("ONCLAVE_GATEWAY_URL must not contain username or password information")
        if not agent_id or len(agent_id) > 256:
            raise ConfigError("ONCLAVE_AGENT_ID must be a non-empty value of at most 256 characters")
        if not session_token and not re.fullmatch(r"[0-9a-fA-F]{64}", private_key_hex):
            raise ConfigError("ONCLAVE_PRIVATE_KEY must be 32 bytes represented as hexadecimal")
        try:
            request_timeout = float(os.getenv("ONCLAVE_REQUEST_TIMEOUT", "15"))
            heartbeat_interval = float(os.getenv("ONCLAVE_HEARTBEAT_INTERVAL", "20"))
        except ValueError as error:
            raise ConfigError("Onclave timeout values must be numbers") from error
        if request_timeout <= 0 or heartbeat_interval <= 0:
            raise ConfigError("Onclave timeout values must be positive")
        return cls(
            base_url=base_url,
            agent_id=agent_id,
            private_key_hex=private_key_hex,
            request_timeout=request_timeout,
            heartbeat_interval=heartbeat_interval,
            state_path=os.getenv("ONCLAVE_STATE_PATH") or None,
        )
