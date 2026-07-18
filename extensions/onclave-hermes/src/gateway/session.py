from __future__ import annotations

import asyncio
import inspect
import json
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlparse, urlunparse


class SessionError(RuntimeError):
    pass


class GatewaySession:
    def __init__(self, base_url: str, agent_id: str, token: str, connect_fn=None, heartbeat_interval: float = 20.0):
        self.base_url = base_url.rstrip("/")
        parsed = urlparse(self.base_url)
        if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None:
            raise ValueError("Onclave gateway URL must use HTTPS for WSS sessions")
        self.agent_id = agent_id
        self.token = token
        self.connect_fn = connect_fn or self._default_connect
        self.heartbeat_interval = heartbeat_interval
        self.ready = False
        self.connected = False
        self.closed = False
        self._heartbeat_ack = asyncio.Event()

    async def _default_connect(self, url: str, **kwargs):
        import websockets
        return await websockets.connect(url, **kwargs)

    def websocket_url(self, subscription_id: str | None = None, correlation_id: str | None = None, task_id: str | None = None) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path_prefix = parsed.path.rstrip("/")
        path = f"{path_prefix}/v1/agents/{quote(self.agent_id, safe='')}/session"
        query: list[tuple[str, str]] = []
        if subscription_id:
            query.append(("subscriptionId", subscription_id))
        if correlation_id:
            query.append(("correlationId", correlation_id))
        if task_id:
            query.append(("taskId", task_id))
        from urllib.parse import urlencode
        return urlunparse((scheme, parsed.netloc, path, "", urlencode(query), ""))

    async def run_once(self, on_message: Callable[[dict[str, Any]], Any | Awaitable[Any]], session_options: dict[str, str] | None = None) -> None:
        self.ready = False
        self.closed = False
        socket_or_awaitable = self.connect_fn(
            self.websocket_url(**(session_options or {})),
            additional_headers={"Authorization": f"Bearer {self.token}"},
        )
        socket = await socket_or_awaitable if inspect.isawaitable(socket_or_awaitable) else socket_or_awaitable
        heartbeat_task = asyncio.create_task(self._heartbeat(socket))
        heartbeat_error = None
        try:
            async with socket:
                async for raw in socket:
                    try:
                        message = json.loads(raw)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if not isinstance(message, dict):
                        continue
                    message_type = message.get("type")
                    if message_type == "session.ready":
                        self.ready = message.get("agentId") == self.agent_id
                        if not self.ready:
                            raise SessionError("gateway session ready message named a different agent")
                        self.connected = True
                    elif message_type == "heartbeat.ack":
                        self._heartbeat_ack.set()
                    elif message_type == "heartbeat":
                        await socket.send(json.dumps({"type": "heartbeat.ack"}))
                    elif message_type in {"command.delivery", "task.event"}:
                        if not self.ready:
                            continue
                        result = on_message(message)
                        if inspect.isawaitable(result):
                            await result
        finally:
            was_ready = self.ready
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception as error:
                heartbeat_error = error
            self.ready = False
            self.connected = False
        if heartbeat_error is not None:
            raise heartbeat_error
        if not was_ready and not self.closed:
            raise SessionError("gateway session closed before session.ready")

    async def _heartbeat(self, socket) -> None:
        while not self.closed:
            await asyncio.sleep(self.heartbeat_interval)
            self._heartbeat_ack.clear()
            await socket.send(json.dumps({"type": "heartbeat"}))
            try:
                await asyncio.wait_for(self._heartbeat_ack.wait(), timeout=self.heartbeat_interval)
            except asyncio.TimeoutError as error:
                close = getattr(socket, "close", None)
                if close is not None:
                    result = close()
                    if inspect.isawaitable(result):
                        await result
                raise SessionError("gateway heartbeat acknowledgement timed out") from error

    async def run_forever(self, on_message: Callable[[dict[str, Any]], Any | Awaitable[Any]], stop_event: asyncio.Event | None = None, options_fn: Callable[[], dict[str, str]] | None = None) -> None:
        delay = 1.0
        while not self.closed and not (stop_event and stop_event.is_set()):
            try:
                await self.run_once(on_message, options_fn() if options_fn else None)
                delay = 1.0
            except (OSError, SessionError, RuntimeError):
                if self.closed or (stop_event and stop_event.is_set()):
                    break
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    def close(self) -> None:
        self.closed = True
