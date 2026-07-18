import json
from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_manifest_declares_hermes_runtime_and_safe_entrypoint():
    manifest = json.loads((ROOT / "onclave.extension.json").read_text())
    assert manifest["runtime"] == "hermes"
    assert manifest["protocolVersion"] == "v1"
    assert manifest["gateway"]["requiredCapabilities"] == ["message.send", "message.receive"]
    entrypoint = (ROOT / manifest["entrypoint"]).resolve()
    assert ROOT.resolve() in entrypoint.parents


def test_plugin_manifest_exposes_only_supported_tools():
    text = (ROOT / "plugin.yaml").read_text()
    assert "onclave_status" in text
    assert "onclave_send" in text
    assert "onclave_await" in text
    assert "ONCLAVE_AGENT_ID" in text
    assert "session_token" not in text
    assert "rabbitmq" not in text.lower()
