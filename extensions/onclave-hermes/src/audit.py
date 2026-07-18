from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SENSITIVE_KEY_PARTS = ("token", "secret", "password", "private", "signature", "authorization", "credential", "payload", "enrollment")


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: "[REDACTED]" if any(part in key.lower() for part in SENSITIVE_KEY_PARTS) else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str) and (value.startswith("Bearer ") or "BEGIN PRIVATE KEY" in value):
        return "[REDACTED]"
    return value


class AuditLog:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def write(self, event: str, metadata: dict[str, Any] | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "metadata": redact(metadata or {}),
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
