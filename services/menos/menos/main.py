"""Menos API - Centralized content vault with semantic search."""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from surrealdb import Surreal

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
from menos.services.di import get_llm_pricing_service, get_surreal_repo
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


def run_migrations() -> None:
    """Run database migrations on startup."""
    settings = get_settings()
    migrations_dir = Path(__file__).parent.parent / "migrations"

    if not migrations_dir.exists():
        logger.warning(f"Migrations directory not found: {migrations_dir}")
        return

    try:
        db = Surreal(settings.surrealdb_url)
        db.signin({"username": settings.surrealdb_user, "password": settings.surrealdb_password})
        db.use(settings.surrealdb_namespace, settings.surrealdb_database)

        migrator = MigrationService(db, migrations_dir)
        status = migrator.status()

        if not status["pending"]:
            logger.info("Database migrations: all up to date")
            return

        logger.info(f"Running {len(status['pending'])} pending migration(s)...")
        applied = migrator.migrate()
        logger.info(f"Applied migrations: {', '.join(applied)}")

    except Exception as e:
        logger.error(f"Migration failed: {e} - app continuing without migration")


def _run_purge() -> None:
    """Purge expired pipeline job records on startup."""
    settings = get_settings()
    try:
        surreal_url = settings.surrealdb_url.replace("ws://", "http://").replace(
            "wss://", "https://"
        )
        db = Surreal(surreal_url)
        db.signin(
            {
                "username": settings.surrealdb_user,
                "password": settings.surrealdb_password,
            }
        )
        db.use(settings.surrealdb_namespace, settings.surrealdb_database)

        compact_result = db.query(
            "DELETE FROM pipeline_job WHERE data_tier = 'compact' "
            "AND finished_at != NONE AND finished_at < time::now() - 180d "
            "RETURN BEFORE"
        )
        full_result = db.query(
            "DELETE FROM pipeline_job WHERE data_tier = 'full' "
            "AND finished_at != NONE AND finished_at < time::now() - 60d "
            "RETURN BEFORE"
        )

        def _parse(result):
            if not result or not isinstance(result, list) or len(result) == 0:
                return []
            first = result[0]
            if isinstance(first, dict) and "result" in first:
                return first["result"] or []
            return result

        compact_count = len(_parse(compact_result))
        full_count = len(_parse(full_result))
        total = compact_count + full_count
        if total > 0:
            logger.info(
                "Purged %d expired pipeline jobs (compact=%d, full=%d)",
                total,
                compact_count,
                full_count,
            )
        else:
            logger.info("Pipeline job purge: no expired records")
    except Exception as e:
        logger.error("Pipeline job purge failed: %s - app continuing", e)


async def _log_version_drift() -> None:
    """Log startup version drift report without blocking app startup on errors."""
    settings = get_settings()
    try:
        repo = await get_surreal_repo()
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
    _run_purge()
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
