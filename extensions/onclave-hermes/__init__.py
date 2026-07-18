"""Hermes plugin registration for the Onclave public gateway integration."""

try:
    from . import schemas, tools
except ImportError:  # Allows direct test loading from the repository checkout.
    import schemas
    import tools


def register(ctx):
    ctx.register_tool(name="onclave_status", toolset="onclave", schema=schemas.STATUS, handler=tools.status)
    ctx.register_tool(name="onclave_send", toolset="onclave", schema=schemas.SEND, handler=tools.send)
    ctx.register_tool(name="onclave_task", toolset="onclave", schema=schemas.TASK, handler=tools.task)
    ctx.register_tool(name="onclave_inbox", toolset="onclave", schema=schemas.INBOX, handler=tools.inbox)
    ctx.register_tool(name="onclave_complete", toolset="onclave", schema=schemas.COMPLETE, handler=tools.complete)
    ctx.register_tool(name="onclave_fail", toolset="onclave", schema=schemas.FAIL, handler=tools.fail)
    ctx.register_tool(name="onclave_cancel", toolset="onclave", schema=schemas.CANCEL, handler=tools.cancel)
    ctx.register_tool(name="onclave_subscribe", toolset="onclave", schema=schemas.SUBSCRIBE, handler=tools.subscribe)
    ctx.register_tool(name="onclave_disconnect", toolset="onclave", schema=schemas.DISCONNECT, handler=tools.disconnect)
