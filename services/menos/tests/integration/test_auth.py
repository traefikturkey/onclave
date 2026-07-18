"""Integration tests for authentication."""



class TestAuthEndpoints:
    """Tests for auth endpoints."""

    def test_list_keys_public(self, client, request_signer):
        """List keys endpoint should be public."""
        response = client.get("/api/v1/auth/keys")

        assert response.status_code == 200
        data = response.json()
        assert "keys" in data
        assert request_signer.key_id in data["keys"]

    def test_whoami_requires_auth(self, client):
        """Whoami endpoint should require authentication."""
        response = client.get("/api/v1/auth/whoami")

        assert response.status_code == 401

    def test_whoami_with_valid_signature(self, authed_client, request_signer):
        """Whoami should return key_id with valid signature."""
        response = authed_client.get("/api/v1/auth/whoami")

        assert response.status_code == 200
        data = response.json()
        assert data["key_id"] == request_signer.key_id

    def test_whoami_with_invalid_signature(self, client):
        """Whoami should reject invalid signature."""
        sig_input = 'sig1=("@method" "@path");keyid="fake";alg="ed25519";created=1234567890'
        response = client.get(
            "/api/v1/auth/whoami",
            headers={
                "signature-input": sig_input,
                "signature": "sig1=:invalidbase64signature:",
            },
        )

        assert response.status_code == 401

    def test_whoami_with_unknown_key(self, client):
        """Whoami should reject unknown key_id."""
        sig_input = (
            'sig1=("@method" "@path");keyid="SHA256:unknownkey1234";'
            'alg="ed25519";created=1234567890'
        )
        response = client.get(
            "/api/v1/auth/whoami",
            headers={
                "signature-input": sig_input,
                "signature": "sig1=:dGVzdA==:",
            },
        )

        assert response.status_code == 401

    def test_reload_keys_requires_auth(self, client):
        """Reload keys should require authentication."""
        response = client.post("/api/v1/auth/keys/reload")

        assert response.status_code == 401

    def test_reload_keys_with_auth(self, authed_client):
        """Reload keys should work with valid auth."""
        response = authed_client.post("/api/v1/auth/keys/reload")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "reloaded"
        assert "keys" in data


class TestSignatureVerification:
    """Tests for signature verification edge cases."""

    def test_missing_signature_headers(self, client):
        """Should reject request without signature headers."""
        response = client.get("/api/v1/auth/whoami")

        assert response.status_code == 401
        assert "Missing signature" in response.json()["detail"]

    def test_expired_signature(self, client, request_signer):
        """Should reject expired signature."""
        import time

        # Create signature with old timestamp by manipulating the input
        headers = request_signer.sign_request("GET", "/api/v1/auth/whoami", host="testserver")

        # Modify created timestamp to be old (6 minutes ago)
        old_time = int(time.time()) - 360
        headers["signature-input"] = headers["signature-input"].replace(
            f"created={int(time.time())}", f"created={old_time}"
        )

        response = client.get("/api/v1/auth/whoami", headers=headers)

        # Signature won't match because we modified input after signing
        assert response.status_code == 401

    def test_unsupported_algorithm(self, client, request_signer):
        """Should reject unsupported algorithm."""
        headers = request_signer.sign_request("GET", "/api/v1/auth/whoami", host="testserver")
        headers["signature-input"] = headers["signature-input"].replace(
            'alg="ed25519"', 'alg="rsa-sha256"'
        )

        response = client.get("/api/v1/auth/whoami", headers=headers)

        assert response.status_code == 401


class TestProtectedEndpoints:
    """Tests for protected content endpoints."""

    def test_content_list_requires_auth(self, client):
        """Content list should require auth."""
        response = client.get("/api/v1/content")

        assert response.status_code == 401


    def test_search_requires_auth(self, client):
        """Search should require auth."""
        response = client.post("/api/v1/search", json={"query": "test"})

        assert response.status_code == 401

    def test_search_with_auth(self, authed_client):
        """Search should work with auth."""
        response = authed_client.post("/api/v1/search", json={"query": "test"})

        assert response.status_code == 200
