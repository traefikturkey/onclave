"""FastAPI authentication dependencies."""

from typing import Annotated

from fastapi import Depends, Request

from menos.auth.keys import KeyStore
from menos.auth.signature import verify_signature
from menos.config import settings

# Global key store instance
_key_store: KeyStore | None = None


def get_key_store() -> KeyStore:
    """Get or create key store singleton."""
    global _key_store
    if _key_store is None:
        _key_store = KeyStore(settings.ssh_public_keys_path)
    return _key_store


async def require_auth(
    request: Request,
    key_store: Annotated[KeyStore, Depends(get_key_store)],
) -> str:
    """Dependency that requires valid HTTP signature auth.

    Returns the authenticated key_id.
    """
    return await verify_signature(request, key_store)


# Type alias for authenticated routes
AuthenticatedKeyId = Annotated[str, Depends(require_auth)]
