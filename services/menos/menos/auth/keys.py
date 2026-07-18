"""SSH public key management."""

import hashlib
import re
from base64 import b64decode
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_ssh_public_key


class KeyStore:
    """Manages authorized SSH public keys."""

    def __init__(self, keys_path: Path):
        self.keys_path = keys_path
        self._keys: dict[str, Ed25519PublicKey] = {}
        self._load_keys()

    def _load_keys(self) -> None:
        """Load all authorized keys from disk."""
        if not self.keys_path.exists():
            return

        # Support both single file (authorized_keys) and directory of keys
        if self.keys_path.is_file():
            self._load_authorized_keys_file(self.keys_path)
        elif self.keys_path.is_dir():
            # Load authorized_keys if exists
            auth_keys = self.keys_path / "authorized_keys"
            if auth_keys.exists():
                self._load_authorized_keys_file(auth_keys)

            # Load individual .pub files
            for pub_file in self.keys_path.glob("*.pub"):
                self._load_key_file(pub_file)

    def _load_authorized_keys_file(self, path: Path) -> None:
        """Load keys from authorized_keys format file."""
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            self._parse_and_store_key(line)

    def _load_key_file(self, path: Path) -> None:
        """Load a single public key file."""
        content = path.read_text().strip()
        self._parse_and_store_key(content)

    def _parse_and_store_key(self, key_line: str) -> None:
        """Parse SSH public key line and store if ed25519."""
        # Format: ssh-ed25519 AAAA... comment
        match = re.match(r"^(ssh-ed25519)\s+(\S+)(?:\s+(.*))?$", key_line)
        if not match:
            return

        key_type, key_data, comment = match.groups()

        try:
            key = load_ssh_public_key(key_line.encode())
            if isinstance(key, Ed25519PublicKey):
                key_id = self._compute_key_id(key_data)
                self._keys[key_id] = key
        except Exception:
            pass  # Skip invalid keys

    def _compute_key_id(self, key_data: str) -> str:
        """Compute key ID (fingerprint) from base64 key data."""
        raw = b64decode(key_data)
        digest = hashlib.sha256(raw).hexdigest()
        return f"SHA256:{digest[:16]}"

    def get_key(self, key_id: str) -> Ed25519PublicKey | None:
        """Get public key by ID."""
        return self._keys.get(key_id)

    def list_key_ids(self) -> list[str]:
        """List all authorized key IDs."""
        return list(self._keys.keys())

    def reload(self) -> None:
        """Reload keys from disk."""
        self._keys.clear()
        self._load_keys()
