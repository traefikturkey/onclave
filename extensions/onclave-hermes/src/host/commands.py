from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

from ..gateway.client import GatewayClient
from ..state import StateStore


class IdempotencyStore:
    def __init__(self, state: StateStore | None = None):
        self.state = state
        self._messages: set[str] = set()
        self._tasks: set[str] = set()

    def accept(self, message_id: str, task_id: str) -> bool:
        if self.state is not None:
            return self.state.remember_message(message_id, task_id)
        if message_id in self._messages or task_id in self._tasks:
            return False
        self._messages.add(message_id)
        self._tasks.add(task_id)
        return True

    def seen(self, message_id: str, task_id: str) -> bool:
        if self.state is not None:
            return self.state.has_message_or_task(message_id, task_id)
        return message_id in self._messages or task_id in self._tasks

    def record(self, message_id: str, task_id: str) -> None:
        if self.state is not None:
            if not self.state.remember_message(message_id, task_id):
                raise RuntimeError("delivery was recorded concurrently")
            return
        self._messages.add(message_id)
        self._tasks.add(task_id)


class OnclaveController:
    def __init__(self, config, client: GatewayClient, state: StateStore | None = None):
        self.config = config
        self.client = client
        self.state = state
        self.idempotency = IdempotencyStore(state)
        self._lock = threading.RLock()

    def send(self, target_agent_id: str, instruction: str, task_id: str | None = None, correlation_id: str | None = None, expires_at: str | None = None) -> dict[str, Any]:
        if not target_agent_id or not instruction:
            raise ValueError("target_agent_id and instruction are required")
        now = datetime.now(timezone.utc)
        task_id = task_id or f"task-{uuid4()}"
        command = {
            "messageId": f"message-{uuid4()}",
            "taskId": task_id,
            "correlationId": correlation_id or f"correlation-{uuid4()}",
            "sourceAgentId": self.config.agent_id,
            "targetAgentId": target_agent_id,
            "type": "task.assign",
            "issuedAt": now.isoformat().replace("+00:00", "Z"),
            "expiresAt": expires_at or (now + timedelta(hours=1)).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "payload": {"instruction": instruction},
        }
        return self.client.submit_command(command)

    def accept_delivery(self, message: dict[str, Any], handler: Callable[[dict[str, Any]], Any], complete: bool = True) -> dict[str, Any]:
        message_id = message.get("messageId")
        task_id = message.get("taskId")
        if not isinstance(message_id, str) or not isinstance(task_id, str):
            raise ValueError("command delivery requires messageId and taskId")
        with self._lock:
            if self.idempotency.seen(message_id, task_id):
                return {"accepted": False, "duplicate": True, "messageId": message_id, "taskId": task_id}
            try:
                result = handler(message)
                self.idempotency.record(message_id, task_id)
                self.client.lifecycle(task_id, "ack")
                self.client.lifecycle(task_id, "started")
            except Exception as error:
                self.fail(task_id, str(error))
                raise

        if complete:
            self.complete(task_id, result if isinstance(result, dict) else {"result": result})
        return {"accepted": True, "messageId": message_id, "taskId": task_id, "result": result}

    def cancel(self, task_id: str, reason: str = "") -> None:
        if not task_id:
            raise ValueError("task_id is required")
        self.client.lifecycle(task_id, "cancelled", {"reason": reason} if reason else None)

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        self.client.lifecycle(task_id, "completed", result)

    def fail(self, task_id: str, error: str) -> None:
        self.client.lifecycle(task_id, "failed", {"error": error})

    def close(self) -> None:
        return None
