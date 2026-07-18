"""Name normalization and fuzzy matching utilities for entity resolution."""

import re

from Levenshtein import distance


def normalize_name(name: str) -> str:
    """Normalize entity name for matching.

    Converts to lowercase and removes spaces, hyphens, and underscores
    to allow matching across different naming conventions.

    Args:
        name: Entity name to normalize

    Returns:
        Normalized name string

    Examples:
        >>> normalize_name("Machine Learning")
        'machinelearning'
        >>> normalize_name("machine-learning")
        'machinelearning'
        >>> normalize_name("LangChain")
        'langchain'
        >>> normalize_name("lang_chain")
        'langchain'
    """
    return name.lower().replace(" ", "").replace("-", "").replace("_", "")


def find_near_duplicates(
    entities: list,
    get_normalized_name: callable,
    max_distance: int = 1,
) -> list[list]:
    """Find entities that are likely duplicates based on Levenshtein edit distance.

    Args:
        entities: List of entity objects to check
        get_normalized_name: Function to extract normalized name from entity
        max_distance: Maximum edit distance to consider as duplicate (default 1)

    Returns:
        List of groups, where each group contains likely duplicate entities
    """
    if not entities:
        return []

    groups: list[list] = []
    used_indices: set[int] = set()

    for i, e1 in enumerate(entities):
        if i in used_indices:
            continue

        name1 = get_normalized_name(e1)
        group = [e1]

        for j, e2 in enumerate(entities[i + 1 :], start=i + 1):
            if j in used_indices:
                continue

            name2 = get_normalized_name(e2)
            if distance(name1, name2) <= max_distance:
                group.append(e2)
                used_indices.add(j)

        if len(group) > 1:
            groups.append(group)
            used_indices.add(i)

    return groups


def is_word_boundary_match(needle: str, haystack: str) -> bool:
    """Check if needle appears in haystack with word boundaries.

    Avoids partial matches like "graph" matching "graphql".

    Args:
        needle: The word to search for
        haystack: The text to search in

    Returns:
        True if needle is found as a complete word
    """
    pattern = r"\b" + re.escape(needle) + r"\b"
    return bool(re.search(pattern, haystack, re.IGNORECASE))


def count_mentions(needle: str, haystack: str) -> int:
    """Count how many times needle appears in haystack with word boundaries.

    Args:
        needle: The word to search for
        haystack: The text to search in

    Returns:
        Number of occurrences
    """
    pattern = r"\b" + re.escape(needle) + r"\b"
    return len(re.findall(pattern, haystack, re.IGNORECASE))
