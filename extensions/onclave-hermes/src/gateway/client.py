from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


class GatewayError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes


class GatewayClient:
    def __init__(self, base_url: str, token: str | None = None, request_fn: Callable[[Request], Any] | None = None, timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(self.base_url)
        if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None:
            raise ValueError("Onclave gateway URL must use HTTPS")
        self.token = token
        self.request_fn = request_fn or (lambda request: urlopen(request, timeout=timeout))

    def issue_challenge(self, agent_id: str) -> str:
        value = self._json("POST", f"/v1/agents/{quote(agent_id, safe='')}/challenge", None, expected=(200,))
        nonce = value.get("nonce")
        if not isinstance(nonce, str) or not nonce:
            raise GatewayError(200, "gateway challenge response did not contain a nonce")
        return nonce

    def enroll(self, agent_id: str, runtime_type: str, private_key_hex: str) -> None:
        try:
            key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
            public_key = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        except (ValueError, TypeError) as error:
            raise GatewayError(0, "invalid Ed25519 private key") from error
        response = self._request(
            "POST",
            "/v1/enroll",
            {
                "agentId": agent_id,
                "runtimeType": runtime_type,
                "publicKey": base64.b64encode(public_key).decode("ascii"),
            },
        )
        if response.status != 201:
            raise GatewayError(response.status, f"Onclave enrollment failed with HTTP {response.status}")

    def authenticate(self, agent_id: str, private_key_hex: str) -> str:
        nonce = self.issue_challenge(agent_id)
        try:
            key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
            signature = key.sign(base64.b64decode(nonce))
        except (ValueError, TypeError) as error:
            raise GatewayError(0, "invalid Ed25519 private key or gateway nonce") from error
        value = self._json(
            "POST",
            f"/v1/agents/{quote(agent_id, safe='')}/authenticate",
            {"signature": base64.b64encode(signature).decode("ascii")},
            expected=(200, 201),
        )
        token = value.get("sessionToken")
        if not isinstance(token, str) or not token:
            raise GatewayError(200, "gateway authentication response did not contain a session token")
        self.token = token
        return token

    def submit_command(self, command: dict[str, Any]) -> dict[str, Any]:
        return self._json("POST", "/v1/commands", command, expected=(200, 202))

    def get_task(self, task_id: str) -> dict[str, Any]:
        return self._json("GET", f"/v1/tasks/{quote(task_id, safe='')}", None, expected=(200,))

    def task_events(self, task_id: str, limit: int = 100, after: int | None = None) -> dict[str, Any]:
        if not 1 <= limit <= 500:
            raise ValueError("limit must be between 1 and 500")
        query = f"?limit={limit}" + (f"&after={after}" if after is not None else "")
        return self._json("GET", f"/v1/tasks/{quote(task_id, safe='')}/events{query}", None, expected=(200,))

    def lifecycle(self, task_id: str, state: str, payload: dict[str, Any] | None = None) -> None:
        paths = {
            "ack": "ack",
            "started": "start",
            "progress": "progress",
            "completed": "complete",
            "failed": "fail",
            "cancelled": "cancel",
        }
        if state not in paths:
            raise ValueError(f"unsupported lifecycle state: {state}")
        body = payload
        if state in {"completed", "failed"} and payload is not None:
            body = {"result": payload}
        self._empty("POST", f"/v1/tasks/{quote(task_id, safe='')}/{paths[state]}", body)

    def create_subscription(self, pattern: str, correlation_id: str | None = None, task_id: str | None = None, expires_at: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"pattern": pattern}
        for key, value in (("correlationId", correlation_id), ("taskId", task_id), ("expiresAt", expires_at)):
            if value is not None:
                body[key] = value
        return self._json("POST", "/v1/subscriptions", body, expected=(200, 201))

    def subscription(self, subscription_id: str) -> dict[str, Any]:
        return self._json("GET", f"/v1/subscriptions/{quote(subscription_id, safe='')}", None, expected=(200,))

    def renew_subscription(self, subscription_id: str) -> dict[str, Any]:
        return self._json("POST", f"/v1/subscriptions/{quote(subscription_id, safe='')}/renew", {}, expected=(200, 204))

    def advance_cursor(self, subscription_id: str, cursor: int) -> None:
        self._empty("POST", f"/v1/subscriptions/{quote(subscription_id, safe='')}/cursor", {"cursor": cursor})

    def delete_subscription(self, subscription_id: str) -> None:
        self._empty("DELETE", f"/v1/subscriptions/{quote(subscription_id, safe='')}", None)

    def _json(self, method: str, path: str, payload: dict[str, Any] | None, expected: tuple[int, ...]) -> dict[str, Any]:
        response = self._request(method, path, payload)
        if response.status not in expected:
            raise GatewayError(response.status, f"Onclave gateway request failed with HTTP {response.status}")
        try:
            value = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GatewayError(response.status, "gateway response was not valid JSON") from error
        if not isinstance(value, dict):
            raise GatewayError(response.status, "gateway response must be an object")
        return value

    def _empty(self, method: str, path: str, payload: dict[str, Any] | None) -> None:
        response = self._request(method, path, payload)
        if response.status not in (200, 202, 204):
            raise GatewayError(response.status, f"Onclave gateway request failed with HTTP {response.status}")

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Response:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=body, method=method, headers=headers)
        try:
            raw = self.request_fn(request)
            return Response(getattr(raw, "status", 200), raw.read())
        except HTTPError as error:
            return Response(error.code, error.read())
        except URLError as error:
            raise GatewayError(0, f"unable to reach Onclave gateway: {error.reason}") from error
