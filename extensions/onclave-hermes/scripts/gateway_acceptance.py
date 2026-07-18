from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.config import ConfigError, GatewayConfig
from src.gateway.client import GatewayClient, GatewayError
from src.gateway.session import GatewaySession
from src.gateway.subscriptions import SubscriptionManager
from src.host.commands import OnclaveController


def main() -> int:
    required = os.getenv("ONCLAVE_ACCEPTANCE_REQUIRED", "0") == "1"
    try:
        config = GatewayConfig.from_environment()
        token = os.getenv("ONCLAVE_SESSION_TOKEN", "").strip()
        client = GatewayClient(config.base_url, token=token or None, timeout=config.request_timeout)
        if not client.token:
            client.authenticate(config.agent_id, config.private_key_hex)
        health = client._request("GET", "/healthz", None)
        if health.status != 200:
            raise GatewayError(health.status, f"gateway health check returned HTTP {health.status}")
        print(f"Onclave gateway acceptance passed for agent {config.agent_id}")
        return 0
    except (ConfigError, GatewayError, OSError) as error:
        if required:
            print(f"Onclave gateway acceptance failed: {error}", file=sys.stderr)
            return 1
        print(f"Onclave gateway acceptance skipped: {error}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
