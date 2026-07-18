import asyncio

from src.host.lifecycle import LifecycleReporter


class FakeClient:
    def __init__(self):
        self.calls = []

    def lifecycle(self, task_id, state, payload=None):
        self.calls.append((task_id, state, payload))


def test_lifecycle_reporter_maps_terminal_states():
    client = FakeClient()
    reporter = LifecycleReporter(client)
    reporter.ack("task-1")
    reporter.started("task-1")
    reporter.progress("task-1", 50, "working")
    reporter.completed("task-1", {"ok": True})
    reporter.failed("task-2", "failed")
    reporter.cancelled("task-3")
    assert [call[1] for call in client.calls] == ["ack", "started", "progress", "completed", "failed", "cancelled"]
