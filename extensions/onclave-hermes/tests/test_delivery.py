from src.host.commands import OnclaveController


class FakeClient:
    def __init__(self):
        self.calls = []

    def lifecycle(self, task_id, state, payload=None):
        self.calls.append((task_id, state, payload))


def test_controller_reports_started_before_handler_and_completed_after_acceptance():
    client = FakeClient()
    config = type("Config", (), {"agent_id": "agent-hermes"})()
    controller = OnclaveController(config, client)
    result = controller.accept_delivery(
        {"messageId": "message-1", "taskId": "task-1"},
        lambda _message: {"ok": True},
    )
    assert result["accepted"] is True
    assert [state for _, state, _ in client.calls] == ["ack", "started", "completed"]


def test_controller_reports_failure_when_handler_raises():
    client = FakeClient()
    config = type("Config", (), {"agent_id": "agent-hermes"})()
    controller = OnclaveController(config, client)
    try:
        controller.accept_delivery({"messageId": "message-1", "taskId": "task-1"}, lambda _message: 1 / 0)
    except ZeroDivisionError:
        pass
    else:
        raise AssertionError("expected handler exception")
    assert client.calls[-1][1] == "failed"
