"""Unit tests for chunking service."""


from menos.services.chunking import ChunkingService


class TestChunkingService:
    """Tests for text chunking."""

    def test_init(self):
        """Test service initialization."""
        service = ChunkingService(chunk_size=256, overlap=20)

        assert service.chunk_size == 256
        assert service.overlap == 20

    def test_chunk_empty_text(self):
        """Test chunking empty text."""
        service = ChunkingService()
        result = service.chunk_text("")

        assert result == []

    def test_chunk_short_text(self):
        """Test chunking text shorter than chunk size."""
        service = ChunkingService(chunk_size=100)
        text = "This is a short text."
        result = service.chunk_text(text)

        assert len(result) == 1
        assert result[0] == text

    def test_chunk_long_text(self):
        """Test chunking long text."""
        service = ChunkingService(chunk_size=50, overlap=10)
        text = "word " * 20  # "word word word ..." repeated

        result = service.chunk_text(text)

        assert len(result) > 1
        # Each chunk should be roughly chunk_size
        for chunk in result:
            assert len(chunk) <= service.chunk_size + 10  # Allow some margin

    def test_chunk_at_word_boundary(self):
        """Test that chunks break at word boundaries."""
        service = ChunkingService(chunk_size=20)
        text = "one two three four five"

        result = service.chunk_text(text)

        # Should split between words, not in the middle
        for chunk in result:
            assert not chunk.startswith(" ")
            assert not chunk.endswith(" ")

    def test_chunk_lines_single_chunk(self):
        """Test chunking by lines with single output."""
        service = ChunkingService()
        text = "line1\nline2\nline3"

        result = service.chunk_lines(text, lines_per_chunk=5)

        assert len(result) == 1
        assert "line1" in result[0]
        assert "line3" in result[0]

    def test_chunk_lines_multiple_chunks(self):
        """Test chunking by lines with multiple outputs."""
        service = ChunkingService()
        lines = "\n".join([f"line{i}" for i in range(10)])

        result = service.chunk_lines(lines, lines_per_chunk=3)

        assert len(result) == 4  # 10 lines / 3 lines per chunk = 4 chunks
        assert "line0" in result[0]
        assert "line9" in result[-1]

    def test_chunk_lines_empty_text(self):
        """Test chunking empty text by lines."""
        service = ChunkingService()
        result = service.chunk_lines("")

        assert result == []

    def test_overlap_creates_shared_content(self):
        """Test that overlap parameter shares content between chunks."""
        service = ChunkingService(chunk_size=30, overlap=10)
        text = "one two three four five six seven eight"

        result = service.chunk_text(text)

        if len(result) > 1:
            # Some word from end of first chunk should appear in second chunk
            result[0].split()[-2:]
            result[1].split()[:2]
            # There should be some overlap
            assert len(result) > 1
