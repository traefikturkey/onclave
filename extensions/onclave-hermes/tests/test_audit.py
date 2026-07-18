import json

from src.audit import AuditLog


def test_audit_redacts_sensitive_values(tmp_path):
    path = tmp_path / "audit.jsonl"
    audit = AuditLog(path)
    audit.write("authenticated", {"agentId": "agent-hermes", "token": "secret-token", "payload": "private"})
    text = path.read_text()
    assert "secret-token" not in text
    assert "private" not in text
    assert "[REDACTED]" in text
