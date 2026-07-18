import json
import unittest
from urllib.request import Request

from onclave_gateway import OnclaveGatewayClient, OnclaveGatewayConfig, OnclaveGatewayError


class FakeResponse:
    def __init__(self, status: int, payload: object) -> None:
        self.status = status
        self._body = json.dumps(payload).encode("utf-8") if payload is not None else b""

    def read(self) -> bytes:
        return self._body


class HermesAdapterTests(unittest.TestCase):
    def test_submits_and_completes_with_gateway_bearer_auth(self) -> None:
        requests: list[Request] = []
        responses = iter([
            FakeResponse(202, {"taskId": "task-1", "state": "accepted"}),
            FakeResponse(204, None),
        ])

        def request(request: Request) -> FakeResponse:
            requests.append(request)
            return next(responses)

        client = OnclaveGatewayClient(
            OnclaveGatewayConfig("https://gateway.example", "session-token", "agent-hermes"),
            request,
        )
        task = client.submit_task({"taskId": "task-1", "targetAgentId": "agent-pi"})
        client.complete("task-1", {"ok": True})

        self.assertEqual(task["state"], "accepted")
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer session-token")
        self.assertEqual(requests[0].full_url, "https://gateway.example/v1/commands")
        self.assertEqual(requests[1].full_url, "https://gateway.example/v1/tasks/task-1/complete")

    def test_surfaces_gateway_errors(self) -> None:
        client = OnclaveGatewayClient(
            OnclaveGatewayConfig("https://gateway.example", "session-token", "agent-hermes"),
            lambda _request: FakeResponse(403, {"error": "forbidden"}),
        )

        with self.assertRaises(OnclaveGatewayError) as context:
            client.get_task("task-1")
        self.assertEqual(context.exception.status, 403)

    def test_reports_failed_task_with_gateway_bearer_auth(self) -> None:
        requests: list[Request] = []

        def request(request: Request) -> FakeResponse:
            requests.append(request)
            return FakeResponse(204, None)

        client = OnclaveGatewayClient(
            OnclaveGatewayConfig("https://gateway.example", "session-token", "agent-hermes"),
            request,
        )
        client.fail("task-1", {"error": "tool failed"})

        self.assertEqual(requests[0].full_url, "https://gateway.example/v1/tasks/task-1/fail")
        self.assertEqual(json.loads(requests[0].data.decode("utf-8")), {"result": {"error": "tool failed"}})


if __name__ == "__main__":
    unittest.main()
