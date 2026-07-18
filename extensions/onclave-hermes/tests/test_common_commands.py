import json

import schemas
import tools
from src.gateway.session import GatewaySession


def test_common_schema_includes_await_and_canonical_send_fields():
    assert schemas.AWAIT["name"] == "onclave_await"
    assert "expires_at" in schemas.SEND["parameters"]["properties"]
    assert "instruction" in schemas.SEND["parameters"]["properties"]


def test_task_and_delivery_normalization_uses_contract_names():
    task = tools._normalize_task({
        "taskId": "task-1",
        "state": "completed",
        "createdAt": "created",
        "updatedAt": "updated",
        "messageId": "message-1",
        "correlationId": "corr-1",
    })
    delivery = tools._normalize_delivery({
        "messageId": "message-1",
        "taskId": "task-1",
        "correlationId": "corr-1",
        "sourceAgentId": "agent-a",
        "targetAgentId": "agent-b",
        "messageType": "task.assign",
        "payload": {"instruction": "test"},
    })
    assert task["task_id"] == "task-1"
    assert task["created_at"] == "created"
    assert task["message_id"] == "message-1"
    assert delivery == {
        "message_id": "message-1",
        "task_id": "task-1",
        "correlation_id": "corr-1",
        "source_agent_id": "agent-a",
        "target_agent_id": "agent-b",
        "message_type": "task.assign",
        "payload": {"instruction": "test"},
    }


def test_status_reports_contract_fields_without_network(monkeypatch):
    monkeypatch.setenv("ONCLAVE_GATEWAY_URL", "https://gateway.example")
    monkeypatch.setenv("ONCLAVE_AGENT_ID", "agent-hermes")
    monkeypatch.setenv("ONCLAVE_PRIVATE_KEY", "a" * 64)
    value = json.loads(tools.status({}))
    assert value["configured"] is True
    assert value["authenticated"] is False
    assert value["connected"] is False
    assert value["gateway_url"] == "https://gateway.example"
    assert "token" not in json.dumps(value).lower()


def test_session_url_supports_subscription_replay_filters():
    session = GatewaySession("https://gateway.example/prefix", "agent-hermes", "token")
    assert session.websocket_url(subscription_id="sub-1", task_id="task-1") == (
        "wss://gateway.example/prefix/v1/agents/agent-hermes/session?subscriptionId=sub-1&taskId=task-1"
    )


def test_await_returns_normalized_terminal_task(monkeypatch):
    class FakeClient:
        token = "token"

        def get_task(self, _task_id):
            return {"taskId": "task-1", "state": "completed", "result": {"ok": True}}

    class FakeController:
        client = FakeClient()

    monkeypatch.setattr(tools, "_get_controller", lambda: FakeController())
    value = json.loads(tools.await_task({"task_id": "task-1", "timeout_ms": 1}))
    assert value["task_id"] == "task-1"
    assert value["state"] == "completed"
    assert value["result"] == {"ok": True}
