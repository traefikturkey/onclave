import asyncio
import json

from src.gateway.session import GatewaySession


class FakeSocket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.messages)
        except StopIteration:
            raise StopAsyncIteration

    async def send(self, value):
        self.sent.append(json.loads(value))


def test_session_requires_ready_and_dispatches_delivery():
    socket = FakeSocket([
        json.dumps({"type": "session.ready", "agentId": "agent-hermes"}),
        json.dumps({"type": "command.delivery", "messageId": "message-1", "taskId": "task-1", "payload": {"instruction": "test"}}),
    ])
    deliveries = []
    session = GatewaySession("https://gateway.example", "agent-hermes", "token", connect_fn=lambda *_args, **_kwargs: socket)

    async def connect(_url, **_kwargs):
        return socket

    async def run():
        session.connect_fn = connect
        await session.run_once(deliveries.append)

    asyncio.run(run())
    assert deliveries[0]["taskId"] == "task-1"
    assert session.ready is False
    assert session.connected is False


def test_session_ignores_malformed_messages_and_closes():
    socket = FakeSocket(["not-json", json.dumps({"type": "session.ready", "agentId": "agent-hermes"})])

    async def connect(_url, **_kwargs):
        return socket

    async def run():
        session = GatewaySession("https://gateway.example", "agent-hermes", "token", connect_fn=connect)
        await session.run_once(lambda _message: None)
        return session

    session = asyncio.run(run())
    assert session.ready is False
    assert session.connected is False
    assert socket.closed is True
