"""Tests for the retrieval evaluation script."""

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

SCRIPT_PATH = Path(__file__).parents[2] / "scripts" / "eval_retrieval.py"
SPEC = importlib.util.spec_from_file_location("eval_retrieval", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
EVAL_RETRIEVAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVAL_RETRIEVAL)


class _Response:
    def raise_for_status(self):
        return None

    def json(self):
        return {"results": []}


class _Client:
    def __init__(self):
        self.post = MagicMock(return_value=_Response())

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False


def test_signed_post_uses_selected_base_url(monkeypatch):
    """The selected endpoint controls both the request URL and signed host."""
    signer = MagicMock()
    signer.sign_request.return_value = {}
    client = _Client()
    monkeypatch.setattr(EVAL_RETRIEVAL.httpx, "Client", lambda **_kwargs: client)

    body, _latency = EVAL_RETRIEVAL._signed_post(
        signer,
        "/api/v1/search",
        {"query": "test"},
        "https://menos.apps.example.net/",
    )

    assert body == {"results": []}
    signer.sign_request.assert_called_once()
    assert signer.sign_request.call_args.args[2] == "menos.apps.example.net"
    client.post.assert_called_once()
    assert client.post.call_args.args[0] == "https://menos.apps.example.net/api/v1/search"
