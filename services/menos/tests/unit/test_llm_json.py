"""Tests for LLM JSON extraction utility."""


from menos.services.llm_json import extract_json


class TestDirectJSON:
    def test_valid_json(self):
        result = extract_json('{"tags": ["python"], "tier": "B"}')
        assert result["tags"] == ["python"]
        assert result["tier"] == "B"

    def test_empty_string(self):
        assert extract_json("") == {}

    def test_whitespace_only(self):
        assert extract_json("   \n  ") == {}

    def test_not_json(self):
        assert extract_json("This is just plain text") == {}


class TestMarkdownCodeBlocks:
    def test_json_code_block(self):
        response = '```json\n{"tags": ["python"]}\n```'
        result = extract_json(response)
        assert result["tags"] == ["python"]

    def test_plain_code_block(self):
        response = '```\n{"tags": ["python"]}\n```'
        result = extract_json(response)
        assert result["tags"] == ["python"]

    def test_json_embedded_in_text(self):
        response = 'Here is the result:\n```json\n{"tier": "A"}\n```\nDone.'
        result = extract_json(response)
        assert result["tier"] == "A"


class TestBareJSONExtraction:
    def test_json_with_surrounding_text(self):
        response = 'Here is my analysis:\n{"tags": ["python"], "tier": "B"}\nEnd.'
        result = extract_json(response)
        assert result["tags"] == ["python"]

    def test_multiline_json_with_text(self):
        response = (
            "Sure, here is the JSON:\n"
            '{\n  "tags": ["test"],\n  "tier": "C"\n}\n'
            "Hope that helps!"
        )
        result = extract_json(response)
        assert result["tags"] == ["test"]


class TestThinkBlockStripping:
    def test_think_block_before_json(self):
        response = (
            "<think>\nLet me analyze this content carefully.\n"
            "The tags should be python and fastapi.\n</think>\n"
            '{"tags": ["python", "fastapi"], "tier": "B"}'
        )
        result = extract_json(response)
        assert result["tags"] == ["python", "fastapi"]

    def test_think_block_before_code_block(self):
        response = (
            "<think>\nThinking about this...\n</think>\n"
            '```json\n{"tags": ["docker"], "tier": "A"}\n```'
        )
        result = extract_json(response)
        assert result["tags"] == ["docker"]

    def test_multiple_think_blocks(self):
        response = (
            "<think>First thought</think>\n"
            "<think>Second thought</think>\n"
            '{"tier": "C"}'
        )
        result = extract_json(response)
        assert result["tier"] == "C"

    def test_empty_think_block(self):
        response = '<think></think>{"tier": "B"}'
        result = extract_json(response)
        assert result["tier"] == "B"

    def test_no_json_after_think_block(self):
        response = "<think>Thinking...</think>\n**Tags**: python, docker"
        assert extract_json(response) == {}


class TestPureMarkdownResponse:
    def test_markdown_with_no_json(self):
        response = "**Tags**\n- python\n- fastapi\n\n**Tier**: B"
        assert extract_json(response) == {}

    def test_markdown_headers(self):
        response = "## Analysis\n\nThis content is about Python."
        assert extract_json(response) == {}
