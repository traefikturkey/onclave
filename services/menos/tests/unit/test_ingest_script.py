"""Unit tests for ingest_videos script."""

from unittest.mock import MagicMock, patch

from scripts.ingest_videos import extract_url


class TestExtractUrl:
    """Tests for extract_url."""

    def test_extracts_standard_youtube_url(self):
        """Test extracting a standard YouTube watch URL."""
        line = "https://www.youtube.com/watch?v=abc123def45"
        assert extract_url(line) == line

    def test_short_url_returns_none(self):
        """youtu.be does not contain 'youtube' so the regex won't match."""
        line = "https://youtu.be/abc123def45"
        assert extract_url(line) is None

    def test_extracts_url_with_surrounding_text(self):
        """Test extracting URL from text with surrounding content."""
        line = "Check out https://www.youtube.com/watch?v=abc text"
        assert extract_url(line) == "https://www.youtube.com/watch?v=abc"

    def test_returns_none_for_no_url(self):
        """Test that a line with no URL returns None."""
        assert extract_url("just some text") is None

    def test_returns_none_for_non_youtube_url(self):
        """Test that non-YouTube URLs return None."""
        assert extract_url("https://example.com/video") is None


class TestMain:
    """Tests for main function."""

    @patch("scripts.ingest_videos.httpx.Client")
    @patch("scripts.ingest_videos.Path")
    @patch("scripts.ingest_videos.RequestSigner.from_file")
    def test_reads_videos_file_and_ingests(
        self,
        mock_signer_from_file,
        mock_path_cls,
        mock_httpx_client_cls,
    ):
        """Test happy path: reads file, posts URL to /ingest."""
        mock_signer = MagicMock()
        mock_signer.sign_request.return_value = {
            "signature-input": "sig1=test",
            "signature": "sig1=:abc:",
        }
        mock_signer_from_file.return_value = mock_signer

        video_url = "https://www.youtube.com/watch?v=vid123"
        mock_videos_file = MagicMock()
        mock_videos_file.read_text.return_value = video_url
        # Path(__file__).parent.parent.parent / "data" / "youtube-videos.txt"
        mock_path_instance = MagicMock()
        mock_path_instance.parent.parent.parent.__truediv__.return_value = MagicMock(
            __truediv__=MagicMock(return_value=mock_videos_file)
        )
        mock_path_cls.return_value = mock_path_instance

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "content_id": "content-vid123",
            "content_type": "youtube",
            "title": "YouTube: vid123",
            "job_id": "job-123",
        }
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.return_value = mock_response
        mock_httpx_client_cls.return_value = mock_client

        from scripts.ingest_videos import main

        main()

        mock_client.post.assert_called_once()
        post_call = mock_client.post.call_args
        assert post_call[0][0] == "/api/v1/ingest"
        # Verify the body contains the URL, not a transcript
        import json

        body = json.loads(post_call.kwargs["content"])
        assert body["url"] == video_url
        assert body == {"url": video_url}

    @patch("scripts.ingest_videos.httpx.Client")
    @patch("scripts.ingest_videos.Path")
    @patch("scripts.ingest_videos.RequestSigner.from_file")
    def test_handles_api_error(
        self,
        mock_signer_from_file,
        mock_path_cls,
        mock_httpx_client_cls,
        capsys,
    ):
        """Test that non-200 API response is handled gracefully."""
        mock_signer = MagicMock()
        mock_signer.sign_request.return_value = {
            "signature-input": "sig1=test",
            "signature": "sig1=:abc:",
        }
        mock_signer_from_file.return_value = mock_signer

        video_url = "https://www.youtube.com/watch?v=vid_err"
        mock_videos_file = MagicMock()
        mock_videos_file.read_text.return_value = video_url
        mock_path_instance = MagicMock()
        mock_path_instance.parent.parent.parent.__truediv__.return_value = MagicMock(
            __truediv__=MagicMock(return_value=mock_videos_file)
        )
        mock_path_cls.return_value = mock_path_instance

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.post.return_value = mock_response
        mock_httpx_client_cls.return_value = mock_client

        from scripts.ingest_videos import main

        main()

        captured = capsys.readouterr()
        assert "ERROR 500" in captured.out

    @patch("scripts.ingest_videos.httpx.Client")
    @patch("scripts.ingest_videos.Path")
    @patch("scripts.ingest_videos.RequestSigner.from_file")
    def test_handles_exception(
        self,
        mock_signer_from_file,
        mock_path_cls,
        mock_httpx_client_cls,
        capsys,
    ):
        """Test that exceptions are caught and printed."""
        mock_signer = MagicMock()
        mock_signer.sign_request.side_effect = Exception("Sign error")
        mock_signer_from_file.return_value = mock_signer

        video_url = "https://www.youtube.com/watch?v=vid_exc"
        mock_videos_file = MagicMock()
        mock_videos_file.read_text.return_value = video_url
        mock_path_instance = MagicMock()
        mock_path_instance.parent.parent.parent.__truediv__.return_value = MagicMock(
            __truediv__=MagicMock(return_value=mock_videos_file)
        )
        mock_path_cls.return_value = mock_path_instance

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_client_cls.return_value = mock_client

        from scripts.ingest_videos import main

        main()

        captured = capsys.readouterr()
        assert "EXCEPTION" in captured.out
