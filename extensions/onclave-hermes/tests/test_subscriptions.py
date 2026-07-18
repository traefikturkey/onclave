from src.gateway.subscriptions import SubscriptionManager


class FakeClient:
    def __init__(self):
        self.calls = []

    def create_subscription(self, **kwargs):
        self.calls.append(("create", kwargs))
        return {"subscriptionId": "sub-1", "cursor": 4}

    def renew_subscription(self, subscription_id):
        self.calls.append(("renew", subscription_id))
        return {"subscriptionId": subscription_id}

    def advance_cursor(self, subscription_id, cursor):
        self.calls.append(("cursor", subscription_id, cursor))


def test_subscription_manager_persists_and_advances_cursor_after_acceptance(tmp_path):
    manager = SubscriptionManager(FakeClient(), tmp_path / "state.json")
    subscription = manager.ensure("task.*.agent-hermes")
    assert subscription["subscriptionId"] == "sub-1"
    assert manager.accept_event({"sequence": 5}) is True
    assert manager.cursor == 5
    assert manager.client.calls[-1] == ("cursor", "sub-1", 5)


def test_subscription_manager_rejects_non_monotonic_cursor(tmp_path):
    manager = SubscriptionManager(FakeClient(), tmp_path / "state.json")
    manager.ensure("task.*.agent-hermes")
    assert manager.accept_event({"sequence": 5}) is True
    assert manager.accept_event({"sequence": 4}) is False


def test_subscription_manager_delivers_events_without_sequence(tmp_path):
    manager = SubscriptionManager(FakeClient(), tmp_path / "state.json")
    delivered = []
    assert manager.accept_event({"type": "task.event"}, delivered.append) is True
    assert delivered == [{"type": "task.event"}]
