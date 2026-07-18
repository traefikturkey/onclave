from src.host.commands import IdempotencyStore


def test_message_and_task_duplicates_are_rejected():
    store = IdempotencyStore()
    assert store.accept("message-1", "task-1") is True
    assert store.accept("message-1", "task-1") is False
    assert store.accept("message-2", "task-1") is False
    assert store.accept("message-1", "task-2") is False
