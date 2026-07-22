"""Health and status endpoints."""

import os

import httpx
from fastapi import APIRouter
from minio import Minio

from menos.config import settings
from menos.services.database import PostgresDatabase

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    """Basic health check - always returns ok if service is running."""
    return {
        "status": "ok",
        "git_sha": os.environ.get("GIT_SHA", "unknown"),
        "build_date": os.environ.get("BUILD_DATE", "unknown"),
        "app_version": settings.app_version,
    }


async def check_postgres() -> str:
    """Check PostgreSQL connectivity."""
    database = PostgresDatabase(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_database,
        user=settings.postgres_user,
        password=settings.postgres_password,
        min_size=1,
        max_size=1,
    )
    try:
        database.open()
        database.check()
        return "ok"
    except Exception as error:
        return f"error: {error}"
    finally:
        database.close()


async def check_s3() -> str:
    """Check S3-compatible storage connectivity."""
    try:
        client = Minio(
            settings.s3_endpoint_url,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            secure=settings.s3_secure,
            region=settings.s3_region,
        )
        client.bucket_exists(settings.s3_bucket)
        return "ok"
    except Exception as e:
        return f"error: {e}"


async def check_ollama() -> str:
    """Check Ollama connectivity."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{settings.ollama_url}/api/tags")
            response.raise_for_status()
            return "ok"
    except Exception as e:
        return f"error: {e}"


@router.get("/ready")
async def ready():
    """Readiness check - verifies dependencies are available."""
    checks = {
        "postgres": await check_postgres(),
        "s3": await check_s3(),
        "ollama": await check_ollama(),
    }
    all_ok = all(v == "ok" for v in checks.values())
    return {
        "status": "ready" if all_ok else "degraded",
        "checks": checks,
    }
