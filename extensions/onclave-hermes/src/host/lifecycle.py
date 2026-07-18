from __future__ import annotations


class LifecycleReporter:
    def __init__(self, client):
        self.client = client

    def ack(self, task_id: str) -> None:
        self.client.lifecycle(task_id, "ack")

    def started(self, task_id: str) -> None:
        self.client.lifecycle(task_id, "started")

    def progress(self, task_id: str, progress: int, note: str = "") -> None:
        progress = max(0, min(100, int(progress)))
        self.client.lifecycle(task_id, "progress", {"progress": progress, "note": note})

    def completed(self, task_id: str, result: dict) -> None:
        self.client.lifecycle(task_id, "completed", result)

    def failed(self, task_id: str, error: str) -> None:
        self.client.lifecycle(task_id, "failed", {"error": error})

    def cancelled(self, task_id: str) -> None:
        self.client.lifecycle(task_id, "cancelled")
