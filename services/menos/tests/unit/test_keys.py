"""Unit tests for key management."""

import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from menos.auth.keys import KeyStore


class TestKeyStore:
    """Tests for KeyStore."""

    def test_load_authorized_keys_file(self, ed25519_keypair):
        """Should load keys from authorized_keys format."""
        _, public_key = ed25519_keypair
        public_ssh = public_key.public_bytes(
            encoding=Encoding.OpenSSH,
            format=PublicFormat.OpenSSH,
        ).decode()

        with tempfile.TemporaryDirectory() as tmpdir:
            keys_path = Path(tmpdir)
            auth_keys = keys_path / "authorized_keys"
            auth_keys.write_text(f"{public_ssh} user@host\n")

            store = KeyStore(keys_path)

            assert len(store.list_key_ids()) == 1
            key_id = store.list_key_ids()[0]
            assert key_id.startswith("SHA256:")
            assert store.get_key(key_id) is not None

    def test_load_pub_files(self, ed25519_keypair):
        """Should load keys from .pub files."""
        _, public_key = ed25519_keypair
        public_ssh = public_key.public_bytes(
            encoding=Encoding.OpenSSH,
            format=PublicFormat.OpenSSH,
        ).decode()

        with tempfile.TemporaryDirectory() as tmpdir:
            keys_path = Path(tmpdir)
            pub_file = keys_path / "test.pub"
            pub_file.write_text(f"{public_ssh} test@localhost\n")

            store = KeyStore(keys_path)

            assert len(store.list_key_ids()) == 1

    def test_skip_comments_and_blanks(self, ed25519_keypair):
        """Should skip comments and blank lines."""
        _, public_key = ed25519_keypair
        public_ssh = public_key.public_bytes(
            encoding=Encoding.OpenSSH,
            format=PublicFormat.OpenSSH,
        ).decode()

        with tempfile.TemporaryDirectory() as tmpdir:
            keys_path = Path(tmpdir)
            auth_keys = keys_path / "authorized_keys"
            auth_keys.write_text(f"# Comment line\n\n{public_ssh} user@host\n\n")

            store = KeyStore(keys_path)

            assert len(store.list_key_ids()) == 1

    def test_skip_non_ed25519_keys(self):
        """Should skip RSA and other key types."""
        # RSA public key (truncated, won't parse but tests the filter)
        rsa_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB test@host"

        with tempfile.TemporaryDirectory() as tmpdir:
            keys_path = Path(tmpdir)
            auth_keys = keys_path / "authorized_keys"
            auth_keys.write_text(f"{rsa_key}\n")

            store = KeyStore(keys_path)

            assert len(store.list_key_ids()) == 0

    def test_empty_directory(self):
        """Should handle empty keys directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = KeyStore(Path(tmpdir))
            assert len(store.list_key_ids()) == 0

    def test_nonexistent_path(self):
        """Should handle nonexistent path."""
        store = KeyStore(Path("/nonexistent/path"))
        assert len(store.list_key_ids()) == 0

    def test_reload_keys(self, ed25519_keypair):
        """Should reload keys from disk."""
        _, public_key = ed25519_keypair
        public_ssh = public_key.public_bytes(
            encoding=Encoding.OpenSSH,
            format=PublicFormat.OpenSSH,
        ).decode()

        with tempfile.TemporaryDirectory() as tmpdir:
            keys_path = Path(tmpdir)
            auth_keys = keys_path / "authorized_keys"

            # Start empty
            auth_keys.write_text("")
            store = KeyStore(keys_path)
            assert len(store.list_key_ids()) == 0

            # Add key and reload
            auth_keys.write_text(f"{public_ssh} user@host\n")
            store.reload()
            assert len(store.list_key_ids()) == 1

    def test_multiple_keys(self):
        """Should load multiple keys."""
        keys = [Ed25519PrivateKey.generate() for _ in range(3)]
        public_lines = []
        for i, key in enumerate(keys):
            pub = key.public_key().public_bytes(
                encoding=Encoding.OpenSSH,
                format=PublicFormat.OpenSSH,
            ).decode()
            public_lines.append(f"{pub} user{i}@host")

        with tempfile.TemporaryDirectory() as tmpdir:
            keys_path = Path(tmpdir)
            auth_keys = keys_path / "authorized_keys"
            auth_keys.write_text("\n".join(public_lines) + "\n")

            store = KeyStore(keys_path)

            assert len(store.list_key_ids()) == 3

    def test_get_unknown_key(self, keys_dir):
        """Should return None for unknown key ID."""
        store = KeyStore(keys_dir)
        assert store.get_key("SHA256:nonexistent") is None
