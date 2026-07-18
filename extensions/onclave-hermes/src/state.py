from __future__ import annotations

import json
import os
from pathlib import Path
from threading import RLock
from typing import Any


class StateStore:
    """Small JSON state store containing only replay/idempotency metadata."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = RLock()
        self._data: dict[str, Any] = {
            "subscriptionId": None,
            "cursor": None,
            "processedMessageIds": [],
            "processedTaskIds": [],
        }
        self.load()

    def load(self) -> None:
        with self._lock:
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return
            except (OSError, json.JSONDecodeError):
                return
            if isinstance(value, dict):
                for key in self._data:
                    if key in value:
                        self._data[key] = value[key]

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_text(json.dumps(self._data, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, self.path)

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = value
            self.save()

    def remember_message(self, message_id: str, task_id: str) -> bool:
        with self._lock:
            messages = set(self._data.get("processedMessageIds", []))
            tasks = set(self._data.get("processedTaskIds", []))
            if message_id in messages or task_id in tasks:
                return False
            messages.add(message_id)
            tasks.add(task_id)
            self._data["processedMessageIds"] = sorted(messages)[-1000:]
            self._data["processedTaskIds"] = sorted(tasks)[-1000:]
            self.save()
            return True

    def has_message_or_task(self, message_id: str, task_id: str) -> bool:
        with self._lock:
            return message_id in set(self._data.get("processedMessageIds", [])) or task_id in set(self._data.get("processedTaskIds", []))
