"""Unit tests for client request signing."""

import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from menos.client.signer import RequestSigner


class TestRequestSigner:
    """Tests for RequestSigner."""

    def test_from_private_key(self, ed25519_keypair):
        """Should create signer from private key."""
        private_key, _ = ed25519_keypair
        signer = RequestSigner.from_private_key(private_key)

        assert signer.key_id.startswith("SHA256:")
        assert len(signer.key_id) == 7 + 16  # "SHA256:" + 16 hex chars

    def test_from_file(self, private_key_file):
        """Should load signer from key file."""
        signer = RequestSigner.from_file(private_key_file)

        assert signer.key_id.startswith("SHA256:")
        assert signer.private_key is not None

    def test_sign_get_request(self, request_signer):
        """Should sign GET request."""
        headers = request_signer.sign_request("GET", "/api/test", host="example.com")

        assert "signature-input" in headers
        assert "signature" in headers
        assert "content-digest" not in headers

        sig_input = headers["signature-input"]
        assert '"@method"' in sig_input
        assert '"@path"' in sig_input
        assert '"@authority"' in sig_input
        assert f'keyid="{request_signer.key_id}"' in sig_input
        assert 'alg="ed25519"' in sig_input
        assert "created=" in sig_input

    def test_sign_post_request_with_body(self, request_signer):
        """Should include content-digest for POST with body."""
        body = b'{"test": "data"}'
        headers = request_signer.sign_request(
            "POST", "/api/test", body=body, host="example.com"
        )

        assert "content-digest" in headers
        assert headers["content-digest"].startswith("sha-256=:")

        sig_input = headers["signature-input"]
        assert '"content-digest"' in sig_input

    def test_signature_format(self, request_signer):
        """Should produce valid signature format."""
        headers = request_signer.sign_request("GET", "/test")

        sig = headers["signature"]
        assert sig.startswith("sig1=:")
        assert sig.endswith(":")

    def test_created_timestamp(self, request_signer):
        """Should include recent created timestamp."""
        before = int(time.time())
        headers = request_signer.sign_request("GET", "/test")
        after = int(time.time())

        sig_input = headers["signature-input"]
        # Extract created value
        import re
        match = re.search(r"created=(\d+)", sig_input)
        assert match
        created = int(match.group(1))
        assert before <= created <= after

    def test_consistent_key_id(self, ed25519_keypair):
        """Should produce consistent key_id for same key."""
        private_key, _ = ed25519_keypair

        signer1 = RequestSigner.from_private_key(private_key)
        signer2 = RequestSigner.from_private_key(private_key)

        assert signer1.key_id == signer2.key_id

    def test_different_keys_different_ids(self):
        """Should produce different key_ids for different keys."""
        key1 = Ed25519PrivateKey.generate()
        key2 = Ed25519PrivateKey.generate()

        signer1 = RequestSigner.from_private_key(key1)
        signer2 = RequestSigner.from_private_key(key2)

        assert signer1.key_id != signer2.key_id
