"""Authentication endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends

from menos.auth.dependencies import AuthenticatedKeyId, get_key_store
from menos.auth.keys import KeyStore

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/keys")
async def list_keys(
    key_store: Annotated[KeyStore, Depends(get_key_store)],
):
    """List authorized key IDs (public endpoint for discovery)."""
    return {"keys": key_store.list_key_ids()}


@router.post("/keys/reload")
async def reload_keys(
    key_id: AuthenticatedKeyId,
    key_store: Annotated[KeyStore, Depends(get_key_store)],
):
    """Reload authorized keys from disk (requires auth)."""
    key_store.reload()
    return {"status": "reloaded", "keys": key_store.list_key_ids()}


@router.get("/whoami")
async def whoami(key_id: AuthenticatedKeyId):
    """Return the authenticated key ID."""
    return {"key_id": key_id}
