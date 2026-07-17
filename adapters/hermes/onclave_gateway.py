"""Small Hermes-facing HTTP adapter for the Onclave gateway.

The adapter deliberately speaks only the public gateway API. It does not import
RabbitMQ clients or expose broker credentials to Hermes.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class OnclaveGatewayError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class OnclaveGatewayConfig:
    base_url: str
    session_token: str
    agent_id: str

    @classmethod
    def from_environment(cls) -> "OnclaveGatewayConfig":
        values = {
            "base_url": os.environ.get("ONCLAVE_GATEWAY_URL", ""),
            "session_token": os.environ.get("ONCLAVE_SESSION_TOKEN", ""),
            "agent_id": os.environ.get("ONCLAVE_AGENT_ID", ""),
        }
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise ValueError(f"missing Onclave environment values: {', '.join(missing)}")
        return cls(**values)


class OnclaveGatewayClient:
    def __init__(
        self,
        config: OnclaveGatewayConfig,
        request_fn: Callable[[Request], Any] | None = None,
    ) -> None:
        self.config = config
        self._request_fn = request_fn or urlopen

    def submit_task(self, task: dict[str, Any]) -> dict[str, Any]:
        return self._json_request("POST", "/v1/commands", task, expected=(200, 202))

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._json_request("GET", f"/v1/tasks/{task_id}", None, expected=(200,))

    def acknowledge(self, task_id: str) -> None:
        self._empty_request("POST", f"/v1/tasks/{task_id}/ack")

    def start(self, task_id: str) -> None:
        self._empty_request("POST", f"/v1/tasks/{task_id}/start")

    def progress(self, task_id: str, progress: int, note: str = "") -> None:
        self._empty_request("POST", f"/v1/tasks/{task_id}/progress", {"progress": progress, "note": note})

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        self._empty_request("POST", f"/v1/tasks/{task_id}/complete", {"result": result})

    def cancel(self, task_id: str) -> None:
        self._empty_request("POST", f"/v1/tasks/{task_id}/cancel")

    def _json_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        expected: tuple[int, ...],
    ) -> dict[str, Any]:
        response = self._request(method, path, payload)
        if response.status not in expected:
            raise OnclaveGatewayError(response.status, response.body.decode("utf-8", "replace"))
        value = json.loads(response.body.decode("utf-8"))
        if not isinstance(value, dict):
            raise OnclaveGatewayError(response.status, "gateway response must be an object")
        return value

    def _empty_request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> None:
        response = self._request(method, path, payload)
        if response.status not in (200, 202, 204):
            raise OnclaveGatewayError(response.status, response.body.decode("utf-8", "replace"))

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.config.base_url.rstrip('/')}{path}",
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.config.session_token}",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            raw = self._request_fn(request)
            return _Response(getattr(raw, "status", 200), raw.read())
        except HTTPError as error:
            return _Response(error.code, error.read())


@dataclass(frozen=True)
class _Response:
    status: int
    body: bytes
