"""Menos API - Centralized content vault with semantic search."""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from menos.config import get_settings
from menos.routers import (
    annotations,
    auth,
    content,
    entities,
    graph,
    health,
    ingest,
    jobs,
    search,
    usage,
    youtube,
)
from menos.services.database import PostgresDatabase
from menos.services.di import get_llm_pricing_service, get_postgres_repo
from menos.services.migrator import MigrationService
from menos.tasks import background_tasks

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

_log_handler = logging.StreamHandler()
_log_handler.setFormatter(
    logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
)
logging.getLogger("menos").setLevel(LOG_LEVEL)
logging.getLogger("menos").addHandler(_log_handler)

logger = logging.getLogger(__name__)


def _new_database() -> PostgresDatabase:
    settings = get_settings()
    return PostgresDatabase(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_database,
        user=settings.postgres_user,
        password=settings.postgres_password,
        min_size=settings.postgres_pool_min_size,
        max_size=settings.postgres_pool_max_size,
    )


def run_migrations() -> None:
    """Run PostgreSQL migrations on startup and fail closed on error."""
    database = _new_database()
    database.open()
    try:
        applied = MigrationService(database, Path(__file__).parent.parent / "migrations").migrate()
        logger.info("Applied PostgreSQL migrations: %s", ", ".join(applied) or "none")
    finally:
        database.close()


async def _run_purge() -> None:
    """Purge expired pipeline job records on startup."""
    repo = await get_postgres_repo()
    try:
        counts = repo.purge_expired_jobs()
        logger.info(
            "Purged %d expired pipeline jobs (compact=%d, full=%d)",
            counts["compact"] + counts["full"],
            counts["compact"],
            counts["full"],
        )
    finally:
        repo.close()


async def _log_version_drift() -> None:
    """Log startup version drift report without blocking app startup on errors."""
    settings = get_settings()
    try:
        repo = await get_postgres_repo()
        report = await repo.get_version_drift_report(settings.app_version)

        total_stale = int(report.get("total_stale", 0))
        current_version = str(report.get("current_version", settings.app_version))
        unknown_version_count = int(report.get("unknown_version_count", 0))

        if total_stale > 0:
            logger.info(
                "version_drift: %d stale items (current=%s, unknown_versions=%d)",
                total_stale,
                current_version,
                unknown_version_count,
            )
        else:
            logger.info(
                "version_drift: no stale content (current=%s, unknown_versions=%d)",
                current_version,
                unknown_version_count,
            )
    except Exception as e:
        logger.warning("version_drift: failed to compute report: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize services on startup."""
    run_migrations()
    await _run_purge()
    await _log_version_drift()
    pricing_service = await get_llm_pricing_service()
    await pricing_service.start_scheduler()
    try:
        yield
    finally:
        await pricing_service.stop_scheduler()
        if background_tasks:
            logger.info("Waiting for %d background task(s)...", len(background_tasks))
            _done, pending = await asyncio.wait(background_tasks, timeout=30.0)
            for t in pending:
                t.cancel()


app = FastAPI(
    title="Menos",
    description="Centralized content vault with semantic search",
    version="0.1.0",
    lifespan=lifespan,
)

# Public endpoints
app.include_router(health.router)

# Auth endpoints (mixed public/protected)
app.include_router(auth.router, prefix="/api/v1")

# Protected endpoints
app.include_router(annotations.router, prefix="/api/v1")
app.include_router(content.router, prefix="/api/v1")
app.include_router(entities.router, prefix="/api/v1")
app.include_router(graph.router, prefix="/api/v1")
app.include_router(graph.content_router, prefix="/api/v1")
app.include_router(search.router, prefix="/api/v1")
app.include_router(usage.router, prefix="/api/v1")
app.include_router(youtube.router, prefix="/api/v1")
app.include_router(ingest.router, prefix="/api/v1")
app.include_router(jobs.content_router, prefix="/api/v1")
app.include_router(jobs.jobs_router, prefix="/api/v1")
