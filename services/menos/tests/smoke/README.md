# Smoke Tests

Smoke tests validate the live API against a running server without mocks. They test end-to-end functionality in realistic conditions.

## Setup

### Prerequisites

1. **Running API server** - Start the API on the target URL
2. **SSH key for authentication** - Used to sign HTTP requests

### Configuration

Smoke tests read from environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SMOKE_TEST_URL` | `http://localhost:8000` | Base URL of live API |
| `SMOKE_TEST_KEY_FILE` | `~/.ssh/id_ed25519` | Path to Ed25519 SSH private key |

## Running Tests

### Run all smoke tests

```bash
# Uses defaults (localhost:8000)
uv run pytest tests/smoke/ -v

# Against specific server
SMOKE_TEST_URL=https://api.example.com uv run pytest tests/smoke/ -v

# With custom key file
SMOKE_TEST_KEY_FILE=/path/to/key.pem uv run pytest tests/smoke/ -v
```

### Run only smoke marker

```bash
uv run pytest tests/smoke/ -m smoke -v
```

### Skip if key file missing

Tests automatically skip if SSH key is not found:

```
tests/smoke/test_health.py::test_health_endpoint SKIPPED (Smoke test SSH key not found...)
```

## Writing Smoke Tests

### Basic Pattern

```python
import pytest

@pytest.mark.smoke
def test_api_feature(smoke_http_client, smoke_authed_headers):
    """Test a live API feature."""
    path = "/api/endpoint"
    headers = smoke_authed_headers("GET", path, host="localhost")

    response = smoke_http_client.get(path, headers=headers)
    assert response.status_code == 200
    assert response.json()["key"] == "expected_value"
```

### Available Fixtures

#### `smoke_base_url`
The base URL for the live API (session scope).

```python
def test_something(smoke_base_url):
    assert smoke_base_url == "http://localhost:8000"
```

#### `smoke_http_client`
HTTP client with extended timeout, already configured with base URL (session scope).

```python
def test_api(smoke_http_client):
    response = smoke_http_client.get("/health")
    assert response.status_code == 200
```

#### `smoke_authed_headers`
Factory fixture to generate RFC 9421 signed request headers (session scope).

Signature is automatically computed for the method/path/body.

```python
def test_auth(smoke_authed_headers):
    # For GET request
    headers = smoke_authed_headers("GET", "/api/resource", host="localhost")

    # For POST with body
    body = b'{"key": "value"}'
    headers = smoke_authed_headers("POST", "/api/resource", body=body, host="localhost")
```

#### `smoke_request_signer`
The underlying RequestSigner instance, in case you need direct access (session scope).

```python
def test_custom_signing(smoke_request_signer):
    headers = smoke_request_signer.sign_request("GET", "/path", host="localhost")
```

## Typical Scenarios

### Health Check
```python
@pytest.mark.smoke
def test_api_healthy(smoke_http_client, smoke_authed_headers):
    headers = smoke_authed_headers("GET", "/health")
    response = smoke_http_client.get("/health", headers=headers)
    assert response.status_code == 200
```

### Query with Authentication
```python
@pytest.mark.smoke
def test_search_content(smoke_http_client, smoke_authed_headers):
    path = "/api/content?q=python"
    headers = smoke_authed_headers("GET", path)
    response = smoke_http_client.get(path, headers=headers)
    assert response.status_code == 200
    assert "results" in response.json()
```

### POST with Body
```python
@pytest.mark.smoke
def test_create_content(smoke_http_client, smoke_authed_headers):
    import json

    body = json.dumps({"title": "Test", "url": "https://example.com"}).encode()
    path = "/api/content"
    headers = smoke_authed_headers("POST", path, body=body)
    headers["content-type"] = "application/json"

    response = smoke_http_client.post(path, content=body, headers=headers)
    assert response.status_code == 201
```

## Troubleshooting

### SSH Key Not Found
```
SKIPPED: Smoke test SSH key not found at /home/user/.ssh/id_ed25519
```

**Solution:** Create SSH key or set `SMOKE_TEST_KEY_FILE`:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
# OR
SMOKE_TEST_KEY_FILE=/path/to/key uv run pytest tests/smoke/
```

### Invalid SSH Key Format
```
SKIPPED: Invalid SSH key format: Only ed25519 keys are supported
```

**Solution:** Only Ed25519 keys are supported. Generate a new key:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
```

### Connection Refused
```
httpx.ConnectError: Failed to establish a new connection
```

**Solution:** Ensure API is running on the configured URL:
```bash
# Check default
curl http://localhost:8000/health

# Or start API
python -m menos.main
```

### Authentication Failures
```
AssertionError: 401 != 200
```

**Solution:** Verify the SSH public key is authorized:
1. Ensure `~/.ssh/id_ed25519.pub` is in API's `authorized_keys`
2. Check `SSH_PUBLIC_KEYS_PATH` configuration on server
3. Verify key format is OpenSSH

## CI/CD Integration

For continuous integration, set environment variables in CI/CD pipeline:

### GitHub Actions
```yaml
- name: Run smoke tests
  env:
    SMOKE_TEST_URL: ${{ secrets.API_URL }}
    SMOKE_TEST_KEY_FILE: /tmp/api-key
  run: |
    echo "${{ secrets.API_SSH_KEY }}" > /tmp/api-key
    chmod 600 /tmp/api-key
    uv run pytest tests/smoke/ -v
```

### GitLab CI
```yaml
smoke_tests:
  script:
    - echo "$API_SSH_KEY" > /tmp/api-key
    - chmod 600 /tmp/api-key
    - SMOKE_TEST_URL=$API_URL SMOKE_TEST_KEY_FILE=/tmp/api-key uv run pytest tests/smoke/ -v
  variables:
    SMOKE_TEST_URL: $API_URL
```
