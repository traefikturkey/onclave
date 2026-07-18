"""Background task tracking for graceful shutdown."""

import asyncio

background_tasks: set[asyncio.Task] = set()
