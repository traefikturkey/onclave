"""RFC 9421 HTTP Message Signature verification."""

import hashlib
import re
from base64 import b64decode
from datetime import UTC, datetime

from cryptography.exceptions import InvalidSignature
from fastapi import HTTPException, Request

from menos.auth.keys import KeyStore


class SignatureVerifier:
    """Verifies HTTP Message Signatures per RFC 9421."""

    # Signature validity window (seconds)
    MAX_AGE = 300  # 5 minutes

    def __init__(self, key_store: KeyStore):
        self.key_store = key_store

    async def verify_request(self, request: Request) -> str:
        """Verify request signature, return key_id if valid."""
        sig_input = request.headers.get("signature-input")
        signature = request.headers.get("signature")

        if not sig_input or not signature:
            raise HTTPException(401, "Missing signature headers")

        params = self._parse_signature_input(sig_input)
        key_id = self._validate_params(params)
        self._check_timestamp(params.get("created"))

        public_key = self.key_store.get_key(key_id)
        if not public_key:
            raise HTTPException(401, f"Unknown key: {key_id}")

        covered_components = params.get("components", [])
        signature_base = await self._build_signature_base(request, covered_components, sig_input)
        sig_bytes = self._extract_signature(signature)

        try:
            public_key.verify(sig_bytes, signature_base.encode())
        except InvalidSignature:
            raise HTTPException(401, "Invalid signature")

        return key_id

    def _validate_params(self, params: dict) -> str:
        """Validate signature parameters and return key_id."""
        key_id = params.get("keyid")
        if not key_id:
            raise HTTPException(401, "Missing keyid in signature-input")
        alg = params.get("alg", "ed25519")
        if alg != "ed25519":
            raise HTTPException(401, f"Unsupported algorithm: {alg}")
        return key_id

    def _check_timestamp(self, created: str | None) -> None:
        """Raise 401 if the created timestamp is outside the validity window."""
        if not created:
            return
        created_time = datetime.fromtimestamp(int(created), tz=UTC)
        age = (datetime.now(UTC) - created_time).total_seconds()
        if abs(age) > self.MAX_AGE:
            raise HTTPException(401, "Signature expired or from future")

    def _parse_signature_input(self, sig_input: str) -> dict:
        """Parse signature-input header."""
        # Format: sig1=("@method" "@path" ...);keyid="...";created=...;alg="ed25519"
        result = {"components": []}

        # Extract label and value
        match = re.match(r"^(\w+)=\(([^)]*)\);?(.*)$", sig_input)
        if not match:
            raise HTTPException(400, "Invalid signature-input format")

        label, components_str, params_str = match.groups()

        # Parse components
        for comp in re.findall(r'"([^"]+)"', components_str):
            result["components"].append(comp)

        # Parse parameters
        for param_match in re.finditer(r'(\w+)=(?:"([^"]+)"|(\d+))', params_str):
            key = param_match.group(1)
            value = param_match.group(2) or param_match.group(3)
            result[key] = value

        return result

    async def _build_signature_base(
        self, request: Request, components: list[str], sig_input: str
    ) -> str:
        """Build the signature base string per RFC 9421."""
        lines = [await self._resolve_component(request, c) for c in components]
        sig_params = sig_input.split("=", 1)[1] if "=" in sig_input else sig_input
        lines.append(f'"@signature-params": {sig_params}')
        return "\n".join(lines)

    async def _resolve_component(self, request: Request, component: str) -> str:
        """Resolve a single signature component to its header line."""
        if component == "@method":
            return f'"@method": {request.method}'
        if component == "@path":
            path = request.url.path
            if request.url.query:
                path = f"{path}?{request.url.query}"
            return f'"@path": {path}'
        if component == "@authority":
            return f'"@authority": {request.headers.get("host", "")}'
        if component == "@target-uri":
            return f'"@target-uri": {str(request.url)}'
        if component == "content-digest":
            body = await request.body()
            digest = hashlib.sha256(body).digest()
            digest_b64 = __import__("base64").b64encode(digest).decode()
            return f'"content-digest": sha-256=:{digest_b64}:'
        # Regular header
        value = request.headers.get(component, "")
        return f'"{component}": {value}'

    def _extract_signature(self, signature_header: str) -> bytes:
        """Extract signature bytes from header."""
        # Format: sig1=:base64data:
        match = re.match(r"^\w+=:([A-Za-z0-9+/=]+):", signature_header)
        if not match:
            raise HTTPException(400, "Invalid signature format")
        return b64decode(match.group(1))


async def verify_signature(request: Request, key_store: KeyStore) -> str:
    """Verify request signature, return key_id."""
    verifier = SignatureVerifier(key_store)
    return await verifier.verify_request(request)
