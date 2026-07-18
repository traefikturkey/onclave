"""Unit tests for normalization utilities."""


from menos.services.normalization import (
    count_mentions,
    find_near_duplicates,
    is_word_boundary_match,
    normalize_name,
)


class TestNormalizeName:
    """Tests for normalize_name function."""

    def test_lowercase(self):
        """Test lowercase conversion."""
        assert normalize_name("LangChain") == "langchain"
        assert normalize_name("OPENAI") == "openai"

    def test_remove_spaces(self):
        """Test space removal."""
        assert normalize_name("Machine Learning") == "machinelearning"
        assert normalize_name("deep learning") == "deeplearning"

    def test_remove_hyphens(self):
        """Test hyphen removal."""
        assert normalize_name("machine-learning") == "machinelearning"
        assert normalize_name("state-of-the-art") == "stateoftheart"

    def test_remove_underscores(self):
        """Test underscore removal."""
        assert normalize_name("lang_chain") == "langchain"
        assert normalize_name("my_project_name") == "myprojectname"

    def test_combined_normalization(self):
        """Test combined normalization."""
        assert normalize_name("My-Project_Name") == "myprojectname"
        assert normalize_name("FAST API") == "fastapi"

    def test_already_normalized(self):
        """Test already normalized names."""
        assert normalize_name("langchain") == "langchain"
        assert normalize_name("pytorch") == "pytorch"


class TestIsWordBoundaryMatch:
    """Tests for is_word_boundary_match function."""

    def test_exact_match(self):
        """Test exact word match."""
        assert is_word_boundary_match("python", "I love Python programming")
        assert is_word_boundary_match("Python", "I love Python programming")

    def test_partial_match_rejected(self):
        """Test that partial matches are rejected."""
        assert not is_word_boundary_match("graph", "graphql is great")
        assert not is_word_boundary_match("fast", "fastapi is cool")

    def test_case_insensitive(self):
        """Test case insensitive matching."""
        assert is_word_boundary_match("PYTHON", "python is great")
        assert is_word_boundary_match("python", "PYTHON IS GREAT")

    def test_at_start_and_end(self):
        """Test matching at start and end of text."""
        assert is_word_boundary_match("hello", "hello world")
        assert is_word_boundary_match("world", "hello world")

    def test_with_punctuation(self):
        """Test matching with punctuation."""
        assert is_word_boundary_match("python", "Learn Python, it's great!")
        assert is_word_boundary_match("python", "Python: the best language")


class TestCountMentions:
    """Tests for count_mentions function."""

    def test_single_mention(self):
        """Test counting single mention."""
        assert count_mentions("Python", "I love Python") == 1

    def test_multiple_mentions(self):
        """Test counting multiple mentions."""
        text = "Python is great. Learn Python today. Python forever!"
        assert count_mentions("Python", text) == 3

    def test_no_mentions(self):
        """Test counting zero mentions."""
        assert count_mentions("Java", "I love Python") == 0

    def test_case_insensitive(self):
        """Test case insensitive counting."""
        text = "python PYTHON Python"
        assert count_mentions("python", text) == 3


class TestFindNearDuplicates:
    """Tests for find_near_duplicates function."""

    def test_empty_list(self):
        """Test with empty list."""
        result = find_near_duplicates([], lambda x: x, max_distance=1)
        assert result == []

    def test_no_duplicates(self):
        """Test with no duplicates."""
        items = ["apple", "banana", "cherry"]
        result = find_near_duplicates(items, lambda x: x, max_distance=1)
        assert result == []

    def test_exact_duplicates(self):
        """Test with exact duplicates (distance 0)."""
        items = ["langchain", "langchain", "pytorch"]
        result = find_near_duplicates(items, lambda x: x, max_distance=0)
        assert len(result) == 1
        assert set(result[0]) == {"langchain"}

    def test_near_duplicates(self):
        """Test with near duplicates (distance 1)."""
        items = ["langchain", "langchains", "pytorch"]
        result = find_near_duplicates(items, lambda x: x, max_distance=1)
        assert len(result) == 1
        assert "langchain" in result[0]
        assert "langchains" in result[0]

    def test_with_custom_extractor(self):
        """Test with custom name extractor."""

        class Item:
            def __init__(self, name):
                self.name = name

        items = [Item("langchain"), Item("langchains"), Item("pytorch")]
        result = find_near_duplicates(items, lambda x: x.name, max_distance=1)
        assert len(result) == 1
        assert result[0][0].name == "langchain"
        assert result[0][1].name == "langchains"

    def test_distance_threshold(self):
        """Test that distance threshold is respected."""
        items = ["hello", "hallo", "hullo"]  # Each differs by 1 from others
        result_1 = find_near_duplicates(items, lambda x: x, max_distance=1)
        result_2 = find_near_duplicates(items, lambda x: x, max_distance=2)

        # With distance 1, we might get pairs
        # With distance 2, we should get all three in one group
        assert len(result_2) >= len(result_1)
