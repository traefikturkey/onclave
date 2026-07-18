from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..state import StateStore


class SubscriptionManager:
    def __init__(self, client, state_path: str | Path, agent_id: str | None = None):
        self.client = client
        self.state = StateStore(state_path)
        self.agent_id = agent_id

    @property
    def subscription_id(self) -> str | None:
        return self.state.get("subscriptionId")

    @property
    def cursor(self) -> int | None:
        value = self.state.get("cursor")
        return value if isinstance(value, int) else None

    def ensure(self, pattern: str, correlation_id: str | None = None, task_id: str | None = None, expires_at: str | None = None) -> dict[str, Any]:
        if self.agent_id and not (pattern == self.agent_id or pattern.endswith(f".{self.agent_id}")):
            raise ValueError("subscription pattern must remain scoped to the authenticated agent")
        if self.subscription_id:
            try:
                self.client.renew_subscription(self.subscription_id)
                return self.client.subscription(self.subscription_id)
            except Exception:
                self.state.set("subscriptionId", None)
        value = self.client.create_subscription(pattern=pattern, correlation_id=correlation_id, task_id=task_id, expires_at=expires_at)
        subscription_id = value.get("subscriptionId")
        if not isinstance(subscription_id, str) or not subscription_id:
            raise ValueError("gateway subscription response did not contain subscriptionId")
        self.state.set("subscriptionId", subscription_id)
        if isinstance(value.get("cursor"), int):
            self.state.set("cursor", value["cursor"])
        return value

    def renew(self) -> dict[str, Any]:
        if not self.subscription_id:
            raise ValueError("no active Onclave subscription")
        return self.client.renew_subscription(self.subscription_id)

    def accept_event(self, event: dict[str, Any], handler=None) -> bool:
        sequence = event.get("sequence", event.get("cursor"))
        if not isinstance(sequence, int):
            if handler is not None:
                handler(event)
            return True
        current = self.cursor
        if current is not None and sequence <= current:
            return False
        if handler is not None:
            handler(event)
        subscription_id = self.subscription_id
        if subscription_id:
            self.client.advance_cursor(subscription_id, sequence)
        self.state.set("cursor", sequence)
        self.state.set("lastAcceptedAt", datetime.now(timezone.utc).isoformat())
        return True

    def delete(self) -> None:
        if self.subscription_id:
            self.client.delete_subscription(self.subscription_id)
            self.state.set("subscriptionId", None)
