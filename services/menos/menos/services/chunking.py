"""Text chunking service for content splitting."""


class ChunkingService:
    """Service for splitting content into chunks."""

    def __init__(self, chunk_size: int = 1024, overlap: int = 150):
        """Initialize chunking service.

        Args:
            chunk_size: Target size for each chunk in characters
            overlap: Number of overlapping characters between chunks
        """
        self.chunk_size = chunk_size
        self.overlap = overlap

    def _find_chunk_end(self, text: str, start: int) -> int:
        """Find the end index for a chunk, snapping to a word boundary."""
        end = min(start + self.chunk_size, len(text))
        if end < len(text):
            last_space = text.rfind(" ", start, end)
            if last_space > start:
                end = last_space
        return end

    def _next_start(self, start: int, end: int) -> int:
        """Compute the next start index with overlap, ensuring forward progress."""
        new_start = end - self.overlap
        return new_start if new_start > start else start + 1

    def chunk_text(self, text: str) -> list[str]:
        """Split text into overlapping chunks."""
        if not text:
            return []
        if len(text) <= self.chunk_size:
            return [text]

        chunks = []
        start = 0
        while start < len(text):
            end = self._find_chunk_end(text, start)
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            if end >= len(text):
                break
            start = self._next_start(start, end)
        return chunks

    def chunk_lines(self, text: str, lines_per_chunk: int = 20) -> list[str]:
        """Split text into chunks by line count.

        Args:
            text: Text to chunk
            lines_per_chunk: Number of lines per chunk

        Returns:
            List of text chunks
        """
        lines = text.split("\n")
        chunks = []

        for i in range(0, len(lines), lines_per_chunk):
            chunk_lines = lines[i : i + lines_per_chunk]
            chunk = "\n".join(chunk_lines).strip()
            if chunk:
                chunks.append(chunk)

        return chunks
