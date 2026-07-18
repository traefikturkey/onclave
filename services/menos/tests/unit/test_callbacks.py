"""Unit tests for CallbackService."""

import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from menos.models import JobStatus, PipelineJob
from menos.services.callbacks import CallbackService, _callback_event_id


@pytest.fixture
def mock_settings():
    s = MagicMock()
    s.callback_url = "https://example.com/webhook"
    s.callback_secret = "test-secret-key"
    return s


@pytest.fixture
def service(mock_settings):
    return CallbackService(mock_settings)


@pytest.fixture
def completed_job():
    return PipelineJob(
        id="job123",
        resource_key="yt:abc",
        content_id="abc",
        status=JobStatus.COMPLETED,
        pipeline_version="2.0.0",
    )


@pytest.fixture
def failed_job():
    return PipelineJob(
        id="job456",
        resource_key="yt:def",
        content_id="def",
        status=JobStatus.FAILED,
        pipeline_version="2.0.0",
        error_code="PIPELINE_NO_RESULT",
        error_message="Pipeline returned no result",
    )


class TestCallbackEventId:
    def test_deterministic(self):
        id1 = _callback_event_id("job123")
        id2 = _callback_event_id("job123")
        assert id1 == id2

    def test_different_for_different_jobs(self):
        id1 = _callback_event_id("job123")
        id2 = _callback_event_id("job456")
        assert id1 != id2


class TestHMACSigning:
    @pytest.mark.asyncio
    async def test_correct_signature(self, service, completed_job):
        captured_headers = {}
        captured_body = None

        async def mock_post(url, content=None, headers=None):
            nonlocal captured_headers, captured_body
            captured_headers = headers or {}
            captured_body = content
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            return resp

        with patch("menos.services.callbacks.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            await service.notify(completed_job, {"tier": "A"})

        assert "X-Menos-Signature" in captured_headers
        expected_sig = hmac.new(
            b"test-secret-key", captured_body.encode(), hashlib.sha256
        ).hexdigest()
        assert captured_headers["X-Menos-Signature"] == expected_sig


class TestPayloadFormat:
    @pytest.mark.asyncio
    async def test_schema_version(self, service, completed_job):
        captured_body = None

        async def mock_post(url, content=None, headers=None):
            nonlocal captured_body
            captured_body = content
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            return resp

        with patch("menos.services.callbacks.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            await service.notify(completed_job, {"tier": "A"})

        payload = json.loads(captured_body)
        assert payload["schema_version"] == "1"
        assert payload["event_id"] == _callback_event_id("job123")
        assert payload["job_id"] == "job123"
        assert payload["content_id"] == "abc"
        assert payload["status"] == "completed"
        assert payload["result"] == {"tier": "A"}

    @pytest.mark.asyncio
    async def test_failed_job_includes_error(self, service, failed_job):
        captured_body = None

        async def mock_post(url, content=None, headers=None):
            nonlocal captured_body
            captured_body = content
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            return resp

        with patch("menos.services.callbacks.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            await service.notify(failed_job)

        payload = json.loads(captured_body)
        assert payload["error_code"] == "PIPELINE_NO_RESULT"
        assert payload["error_message"] == "Pipeline returned no result"
        assert "result" not in payload


class TestRetry:
    @pytest.mark.asyncio
    async def test_retries_on_failure(self, service, completed_job):
        call_count = 0

        async def mock_post(url, content=None, headers=None):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise httpx.HTTPStatusError(
                    "500", request=MagicMock(), response=MagicMock()
                )
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            return resp

        import httpx

        with (
            patch("menos.services.callbacks.httpx.AsyncClient") as mock_client_cls,
            patch("menos.services.callbacks.asyncio.sleep", new_callable=AsyncMock),
        ):
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            await service.notify(completed_job)

        assert call_count == 3


class TestFailureIsolation:
    @pytest.mark.asyncio
    async def test_does_not_raise_on_all_retries_failed(self, service, completed_job):
        async def mock_post(url, content=None, headers=None):
            raise ConnectionError("unreachable")

        with (
            patch("menos.services.callbacks.httpx.AsyncClient") as mock_client_cls,
            patch("menos.services.callbacks.asyncio.sleep", new_callable=AsyncMock),
        ):
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            # Should not raise
            await service.notify(completed_job)

    @pytest.mark.asyncio
    async def test_no_callback_when_url_missing(self, completed_job):
        s = MagicMock()
        s.callback_url = None
        s.callback_secret = "secret"
        svc = CallbackService(s)

        # Should return immediately without doing anything
        await svc.notify(completed_job)
