from __future__ import annotations

import asyncio
import json
import os
import threading
from pathlib import Path
from typing import Any

try:
    from .src.config import ConfigError, GatewayConfig
    from .src.gateway.client import GatewayClient, GatewayError
    from .src.gateway.session import GatewaySession
    from .src.gateway.subscriptions import SubscriptionManager
    from .src.host.commands import OnclaveController
    from .src.audit import AuditLog
except ImportError:  # Repository tests import this module as a top-level module.
    from src.config import ConfigError, GatewayConfig
    from src.gateway.client import GatewayClient, GatewayError
    from src.gateway.session import GatewaySession
    from src.gateway.subscriptions import SubscriptionManager
    from src.host.commands import OnclaveController
    from src.audit import AuditLog


_controller: OnclaveController | None = None
_config_error: str | None = None
_session: GatewaySession | None = None
_session_thread: threading.Thread | None = None
_inbox: list[dict[str, Any]] = []
_inbox_lock = threading.RLock()


def _state_path(config: GatewayConfig) -> Path:
    if config.state_path:
        return Path(config.state_path)
    home = Path(os.getenv("HERMES_HOME", Path.home() / ".hermes"))
    return home / "onclave-hermes" / "state.json"


def _audit(config: GatewayConfig, event: str, metadata: dict[str, Any]) -> None:
    AuditLog(_state_path(config).with_name("audit.jsonl")).write(event, {"agentId": config.agent_id, **metadata})


def _queue_delivery(message: dict[str, Any]) -> dict[str, Any]:
    with _inbox_lock:
        _inbox.append(message)
        del _inbox[:-100]
    return {"queued": True, "messageId": message.get("messageId"), "taskId": message.get("taskId")}


async def _handle_session_message(message: dict[str, Any]) -> None:
    if _controller is None:
        return
    if message.get("type") == "command.delivery":
        await asyncio.to_thread(_controller.accept_delivery, message, _queue_delivery, False)
    else:
        _queue_delivery(message)


def _start_session(controller: OnclaveController) -> None:
    global _session, _session_thread
    if _session_thread is not None and _session_thread.is_alive():
        return
    _session = GatewaySession(controller.config.base_url, controller.config.agent_id, controller.client.token or "", heartbeat_interval=controller.config.heartbeat_interval)

    session = _session

    def run() -> None:
        asyncio.run(session.run_forever(_handle_session_message))

    _session_thread = threading.Thread(target=run, name="onclave-hermes-session", daemon=True)
    _session_thread.start()


def _get_controller() -> OnclaveController:
    global _controller
    if _controller is not None:
        return _controller
    config = GatewayConfig.from_environment()
    client = GatewayClient(config.base_url, timeout=config.request_timeout)
    token = os.getenv("ONCLAVE_SESSION_TOKEN", "").strip()
    if token:
        client.token = token
    else:
        client.authenticate(config.agent_id, config.private_key_hex)
    try:
        from .src.state import StateStore
    except ImportError:
        from src.state import StateStore
    _controller = OnclaveController(config, client, StateStore(_state_path(config)))
    _start_session(_controller)
    return _controller


def status(_args: dict, **_kwargs) -> str:
    try:
        config = GatewayConfig.from_environment()
    except ConfigError as error:
        return json.dumps({"configured": False, "error": str(error)})
    return json.dumps({
        "configured": True,
        "gateway": config.base_url,
        "agent_id": config.agent_id,
        "state_path": str(_state_path(config)),
        "capabilities": ["message.send", "message.receive"],
    })


def send(args: dict, **_kwargs) -> str:
    try:
        result = _get_controller().send(
            target_agent_id=str(args.get("target_agent_id", "")),
            instruction=str(args.get("instruction", "")),
            task_id=args.get("task_id"),
            correlation_id=args.get("correlation_id"),
        )
        _audit(_get_controller().config, "command.submitted", {"targetAgentId": args.get("target_agent_id"), "taskId": result.get("taskId")})
        return json.dumps({"accepted": True, "task": result}, default=str)
    except (ConfigError, GatewayError, ValueError) as error:
        if _controller is not None:
            _audit(_controller.config, "command.submit_failed", {"error": str(error)})
        return json.dumps({"accepted": False, "error": str(error)})


def task(args: dict, **_kwargs) -> str:
    try:
        result = _get_controller().client.get_task(str(args.get("task_id", "")))
        return json.dumps(result, default=str)
    except (ConfigError, GatewayError, ValueError) as error:
        return json.dumps({"error": str(error)})


def inbox(_args: dict, **_kwargs) -> str:
    with _inbox_lock:
        return json.dumps({"messages": list(_inbox)}, default=str)


def complete(args: dict, **_kwargs) -> str:
    try:
        _get_controller().complete(str(args.get("task_id", "")), args.get("result") if isinstance(args.get("result"), dict) else {})
        return json.dumps({"completed": True, "task_id": args.get("task_id")})
    except (ConfigError, GatewayError, ValueError) as error:
        return json.dumps({"completed": False, "error": str(error)})


def fail(args: dict, **_kwargs) -> str:
    try:
        _get_controller().fail(str(args.get("task_id", "")), str(args.get("error", "task failed")))
        return json.dumps({"failed": True, "task_id": args.get("task_id")})
    except (ConfigError, GatewayError, ValueError) as error:
        return json.dumps({"failed": False, "error": str(error)})


def cancel(args: dict, **_kwargs) -> str:
    try:
        controller = _get_controller()
        controller.client.lifecycle(str(args.get("task_id", "")), "cancelled")
        return json.dumps({"cancelled": True, "task_id": args.get("task_id")})
    except (ConfigError, GatewayError, ValueError) as error:
        return json.dumps({"cancelled": False, "error": str(error)})


def subscribe(args: dict, **_kwargs) -> str:
    try:
        controller = _get_controller()
        manager = SubscriptionManager(controller.client, _state_path(controller.config), controller.config.agent_id)
        result = manager.ensure(str(args.get("pattern", "")))
        _audit(controller.config, "subscription.ready", {"subscriptionId": result.get("subscriptionId")})
        return json.dumps({"subscribed": True, "subscription": result}, default=str)
    except (ConfigError, GatewayError, ValueError) as error:
        if _controller is not None:
            _audit(_controller.config, "subscription.failed", {"error": str(error)})
        return json.dumps({"subscribed": False, "error": str(error)})


def disconnect(_args: dict, **_kwargs) -> str:
    global _controller, _session, _session_thread
    if _session is not None:
        _session.close()
    if _session_thread is not None and _session_thread.is_alive():
        _session_thread.join(timeout=2)
    _session = None
    _session_thread = None
    if _controller is not None:
        _controller.close()
        _controller = None
    return json.dumps({"disconnected": True})
