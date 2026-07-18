import json


STATUS = {
    "name": "onclave_status",
    "description": "Validate Onclave configuration and report whether this Hermes plugin is configured. Does not make a network call.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}
SEND = {
    "name": "onclave_send",
    "description": "Submit a non-destructive task instruction to an enrolled Onclave agent.",
    "parameters": {
        "type": "object",
        "properties": {
            "target_agent_id": {"type": "string", "description": "Target enrolled Onclave agent ID"},
            "instruction": {"type": "string", "description": "Task instruction"},
            "task_id": {"type": "string", "description": "Optional stable idempotency task ID"},
            "correlation_id": {"type": "string", "description": "Optional workflow correlation ID"},
        },
        "required": ["target_agent_id", "instruction"],
        "additionalProperties": False,
    },
}
TASK = {
    "name": "onclave_task",
    "description": "Read the current public Onclave task state by task ID.",
    "parameters": {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False},
}
INBOX = {
    "name": "onclave_inbox",
    "description": "Read inbound Onclave command and event deliveries accepted by the background WSS session.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}
COMPLETE = {
    "name": "onclave_complete",
    "description": "Report completion for an inbound Onclave task after Hermes has handled it.",
    "parameters": {"type": "object", "properties": {"task_id": {"type": "string"}, "result": {"type": "object"}}, "required": ["task_id"], "additionalProperties": False},
}
FAIL = {
    "name": "onclave_fail",
    "description": "Report failure for an inbound Onclave task after Hermes handling fails.",
    "parameters": {"type": "object", "properties": {"task_id": {"type": "string"}, "error": {"type": "string"}}, "required": ["task_id", "error"], "additionalProperties": False},
}
CANCEL = {
    "name": "onclave_cancel",
    "description": "Cancel an Onclave task owned by this agent when gateway policy permits it.",
    "parameters": {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False},
}
SUBSCRIBE = {
    "name": "onclave_subscribe",
    "description": "Create or reuse an agent-scoped durable Onclave event subscription.",
    "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"], "additionalProperties": False},
}
DISCONNECT = {
    "name": "onclave_disconnect",
    "description": "Stop the Onclave WebSocket session and release local timers.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}


def as_json(value):
    return json.dumps(value, separators=(",", ":"), default=str)
