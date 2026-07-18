import json
from urllib.request import Request

from src.gateway.client import GatewayClient, GatewayError


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def read(self):
        return self._body


def test_submit_command_uses_bearer_auth_and_public_gateway_path():
    requests = []

    def request(req):
        requests.append(req)
        return FakeResponse(202, {"taskId": "task-1", "state": "accepted"})

    client = GatewayClient("https://gateway.example", "session-token", request_fn=request)
    result = client.submit_command({"messageId": "message-1", "taskId": "task-1"})

    assert result["state"] == "accepted"
    assert requests[0].full_url == "https://gateway.example/v1/commands"
    assert requests[0].get_header("Authorization") == "Bearer session-token"


def test_gateway_error_preserves_status_without_exposing_auth_header():
    client = GatewayClient(
        "https://gateway.example",
        "session-token",
        request_fn=lambda _req: FakeResponse(403, {"error": "forbidden"}),
    )

    try:
        client.get_task("task-1")
    except GatewayError as error:
        assert error.status == 403
        assert "session-token" not in str(error)
    else:
        raise AssertionError("expected GatewayError")


def test_enroll_posts_runtime_and_derived_public_key():
    requests = []

    def request(req):
        requests.append(req)
        return FakeResponse(201, None)

    client = GatewayClient("https://gateway.example", request_fn=request)
    client.enroll("agent-hermes", "hermes", "a" * 64)
    body = json.loads(requests[0].data.decode())
    assert requests[0].full_url == "https://gateway.example/v1/enroll"
    assert body["agentId"] == "agent-hermes"
    assert body["runtimeType"] == "hermes"
    assert len(body["publicKey"]) > 0
