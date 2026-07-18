"""Storage services for S3-compatible storage and SurrealDB."""

import re
from datetime import UTC, datetime
from typing import BinaryIO

from minio import Minio
from minio.error import S3Error
from surrealdb import RecordID, Surreal

from menos.models import (
    ChunkModel,
    ContentEntityEdge,
    ContentMetadata,
    EntityModel,
    EntityType,
    LinkModel,
    RelatedContent,
)
from menos.services.normalization import normalize_name
from menos.services.version_utils import has_version_drift, parse_version_tuple

_TIER_ORDER = ["S", "A", "B", "C", "D"]


def _compute_valid_tiers(tier_min: str | None) -> list[str]:
    """Return tiers that are equal or better than tier_min.

    Returns an empty list when tier_min is None or invalid.
    """
    if tier_min is None:
        return []

    normalized = tier_min.strip().upper()
    if normalized not in _TIER_ORDER:
        return []

    return _TIER_ORDER[: _TIER_ORDER.index(normalized) + 1]


class S3Storage:
    """S3-compatible client wrapper for file storage."""

    def __init__(self, client: Minio, bucket: str):
        """Initialize S3 storage.

        Args:
            client: Minio SDK client instance
            bucket: Bucket name for storing files
        """
        self.client = client
        self.bucket = bucket

    async def upload(self, file_path: str, data: BinaryIO, content_type: str) -> int:
        """Upload file to S3-compatible storage.

        Args:
            file_path: Path where to store file
            data: File data stream
            content_type: MIME type of file

        Returns:
            File size in bytes

        Raises:
            S3Error: If upload fails
        """
        try:
            data.seek(0, 2)  # Seek to end
            file_size = data.tell()
            data.seek(0)  # Reset to start

            self.client.put_object(
                self.bucket,
                file_path,
                data,
                file_size,
                content_type=content_type,
            )
            return file_size
        except S3Error as e:
            raise RuntimeError(f"S3 upload failed: {e}") from e

    async def download(self, file_path: str) -> bytes:
        """Download file from S3-compatible storage.

        Args:
            file_path: Path to file

        Returns:
            File contents as bytes

        Raises:
            S3Error: If download fails
        """
        try:
            response = self.client.get_object(self.bucket, file_path)
            return response.read()
        except S3Error as e:
            raise RuntimeError(f"S3 download failed: {e}") from e

    async def delete(self, file_path: str) -> None:
        """Delete file from S3-compatible storage.

        Args:
            file_path: Path to file

        Raises:
            S3Error: If deletion fails
        """
        try:
            self.client.remove_object(self.bucket, file_path)
        except S3Error as e:
            raise RuntimeError(f"S3 delete failed: {e}") from e


# Backwards-compatible alias for routers not yet updated
MinIOStorage = S3Storage


class SurrealDBRepository:
    """SurrealDB client wrapper for metadata storage."""

    def __init__(
        self,
        db: Surreal,
        namespace: str,
        database: str,
        username: str = "root",
        password: str = "root",
    ):
        """Initialize SurrealDB repository.

        Args:
            db: Surreal database connection
            namespace: Database namespace
            database: Database name
            username: Database username
            password: Database password
        """
        self.db = db
        self.namespace = namespace
        self.database = database
        self.username = username
        self.password = password

    async def connect(self) -> None:
        """Connect to database, authenticate, and select namespace/database."""
        # Authenticate with credentials
        self.db.signin({"username": self.username, "password": self.password})
        # Select namespace and database
        self.db.use(self.namespace, self.database)

    def _parse_query_result(self, result: list) -> list[dict]:
        """Parse SurrealDB query result handling v2 format variations.

        Args:
            result: Raw query result from SurrealDB

        Returns:
            List of record dictionaries
        """
        if not result or not isinstance(result, list) or len(result) == 0:
            return []
        first = result[0]
        if isinstance(first, dict) and "result" in first:
            return first["result"] or []
        return result

    async def create_content(self, metadata: ContentMetadata) -> ContentMetadata:
        """Create content metadata record.

        Args:
            metadata: Content metadata

        Returns:
            Created metadata with ID

        Raises:
            Exception: If creation fails
        """
        now = datetime.now(UTC)
        metadata.created_at = now
        metadata.updated_at = now

        result = self.db.create("content", metadata.model_dump(exclude_none=True))
        if result:
            record = result[0] if isinstance(result, list) else result
            metadata.id = self._stringify_record_id(record["id"])
        return metadata

    async def get_content(self, content_id: str) -> ContentMetadata | None:
        """Get content metadata by ID.

        Args:
            content_id: Content ID

        Returns:
            Content metadata or None if not found
        """
        result = self.db.select(f"content:{content_id}")
        if result:
            return self._parse_content(result[0])
        return None

    @staticmethod
    def _build_content_filters(
        content_type: str | None,
        tags: list[str] | None,
        exclude_tags: list[str],
    ) -> tuple[list[str], dict]:
        """Build WHERE clauses and params for content filters."""
        clauses: list[str] = []
        params: dict = {}
        if content_type:
            clauses.append("content_type = $content_type")
            params["content_type"] = content_type
        if tags:
            clauses.append("tags CONTAINSANY $tags")
            params["tags"] = tags
        if exclude_tags:
            clauses.append("tags CONTAINSNONE $exclude_tags")
            params["exclude_tags"] = exclude_tags
        return clauses, params

    async def list_content(
        self,
        offset: int = 0,
        limit: int = 50,
        content_type: str | None = None,
        tags: list[str] | None = None,
        exclude_tags: list[str] | None = None,
        order_by: str | None = None,
    ) -> tuple[list[ContentMetadata], int]:
        """List content metadata."""
        effective_exclude = self._effective_exclude_tags(tags, exclude_tags)
        clauses, filter_params = self._build_content_filters(content_type, tags, effective_exclude)
        params: dict = {"limit": limit, "offset": offset, **filter_params}
        where_clause = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        order_clause = f" ORDER BY {order_by}" if order_by else ""
        result = self.db.query(
            f"SELECT * FROM content{where_clause}{order_clause} LIMIT $limit START $offset",
            params,
        )
        raw_items = self._parse_query_result(result)
        items = [self._parse_content(item) for item in raw_items]
        return items, len(items)

    @staticmethod
    def _effective_exclude_tags(
        tags: list[str] | None, exclude_tags: list[str] | None
    ) -> list[str]:
        """Compute effective exclude_tags, removing any tags that are explicitly included."""
        effective = ["test"] if exclude_tags is None else exclude_tags
        if tags and effective:
            effective = [t for t in effective if t not in tags]
        return effective

    async def get_content_stats(self) -> dict:
        """Get aggregate content statistics."""
        status_result = self.db.query(
            "SELECT count() AS count, metadata.processing_status AS status "
            "FROM content GROUP BY status"
        )
        status_rows = self._parse_query_result(status_result)

        type_result = self.db.query(
            "SELECT count() AS count, content_type FROM content GROUP BY content_type"
        )
        type_rows = self._parse_query_result(type_result)

        total = sum(r.get("count", 0) for r in status_rows)
        by_status = {(r.get("status") or "none"): r.get("count", 0) for r in status_rows}
        by_content_type = {r.get("content_type", "unknown"): r.get("count", 0) for r in type_rows}

        return {
            "total": total,
            "by_status": by_status,
            "by_content_type": by_content_type,
        }

    async def get_version_drift_report(self, current_version: str) -> dict:
        """Get report of completed content with version drift."""
        grouped_result = self.db.query(
            "SELECT pipeline_version, count() AS cnt "
            "FROM content WHERE processing_status = 'completed' GROUP BY pipeline_version"
        )
        grouped_rows = self._parse_query_result(grouped_result)

        total_result = self.db.query(
            "SELECT count() AS count FROM content WHERE processing_status = 'completed' GROUP ALL"
        )
        total_rows = self._parse_query_result(total_result)

        stale_content: list[dict[str, str | int]] = []
        total_stale = 0
        unknown_version_count = 0

        for row in grouped_rows:
            version = row.get("pipeline_version")
            count_raw = row.get("cnt", 0)
            try:
                count = int(count_raw)
            except (TypeError, ValueError):
                count = 0

            if parse_version_tuple(version) is None:
                unknown_version_count += count
                continue

            if has_version_drift(version, current_version):
                stale_content.append({"version": str(version), "count": count})
                total_stale += count

        stale_content.sort(key=lambda item: (-int(item["count"]), str(item["version"])))

        total_content = 0
        if total_rows:
            try:
                total_content = int(total_rows[0].get("count", 0))
            except (TypeError, ValueError):
                total_content = 0

        return {
            "current_version": current_version,
            "stale_content": stale_content,
            "total_stale": total_stale,
            "unknown_version_count": unknown_version_count,
            "total_content": total_content,
        }

    async def update_content(self, content_id: str, metadata: ContentMetadata) -> ContentMetadata:
        """Update content metadata.

        Args:
            content_id: Content ID
            metadata: Updated metadata

        Returns:
            Updated metadata

        Raises:
            Exception: If update fails
        """
        metadata.updated_at = datetime.now(UTC)
        result = self.db.update(f"content:{content_id}", metadata.model_dump(exclude_none=True))
        if result:
            return self._parse_content(result[0])
        raise RuntimeError(f"Failed to update content {content_id}")

    async def delete_content(self, content_id: str) -> None:
        """Delete content metadata.

        Args:
            content_id: Content ID
        """
        self.db.delete(f"content:{content_id}")

    async def create_chunk(self, chunk: ChunkModel) -> ChunkModel:
        """Create content chunk.

        Args:
            chunk: Chunk data

        Returns:
            Created chunk with ID
        """
        chunk.created_at = datetime.now(UTC)
        result = self.db.create("chunk", chunk.model_dump(exclude_none=True))
        if result:
            record = result[0] if isinstance(result, list) else result
            chunk.id = self._stringify_record_id(record["id"])
        return chunk

    async def get_chunks(self, content_id: str) -> list[ChunkModel]:
        """Get all chunks for content.

        Args:
            content_id: Content ID

        Returns:
            List of chunks
        """
        result = self.db.query(
            "SELECT * FROM chunk WHERE content_id = $content_id",
            {"content_id": content_id},
        )
        raw_items = self._parse_query_result(result)
        return [self._parse_chunk(item) for item in raw_items]

    async def get_chunk_counts(self, content_ids: list[str]) -> dict[str, int]:
        """Get chunk counts for multiple content IDs in a single query.

        Args:
            content_ids: List of content IDs

        Returns:
            Dict mapping content_id to chunk count
        """
        if not content_ids:
            return {}
        result = self.db.query(
            "SELECT content_id, count() AS cnt"
            " FROM chunk WHERE content_id INSIDE $ids"
            " GROUP BY content_id",
            {"ids": content_ids},
        )
        raw = self._parse_query_result(result)
        return {row["content_id"]: row.get("cnt", 0) for row in raw if "content_id" in row}

    async def delete_chunks(self, content_id: str) -> None:
        """Delete all chunks for content.

        Args:
            content_id: Content ID
        """
        self.db.query(
            "DELETE (SELECT id FROM chunk WHERE content_id = $content_id)",
            {"content_id": content_id},
        )

    async def list_tags_with_counts(self) -> list[dict[str, str | int]]:
        """Get all tags with their counts, sorted by count descending then alphabetically.

        Returns:
            List of dicts with 'name' and 'count' keys, sorted by count (desc) then name (asc)
        """
        result = self.db.query(
            "SELECT tags FROM content WHERE tags != NONE AND array::len(tags) > 0"
        )
        raw_items = self._parse_query_result(result)

        # Count occurrences of each tag across all content
        tag_counts: dict[str, int] = {}
        for item in raw_items:
            tags = item.get("tags", [])
            if isinstance(tags, list):
                for tag in tags:
                    if isinstance(tag, str):
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1

        # Sort by count descending, then by name ascending
        sorted_tags = sorted(tag_counts.items(), key=lambda x: (-x[1], x[0]))

        return [{"name": name, "count": count} for name, count in sorted_tags]

    @staticmethod
    def _count_tag_pairs(raw_items: list[dict]) -> dict[tuple[str, str], int]:
        """Count co-occurring tag pairs across content items."""
        pair_counts: dict[tuple[str, str], int] = {}
        for item in raw_items:
            tags = item.get("tags", [])
            if not isinstance(tags, list):
                continue
            unique = sorted({t for t in tags if isinstance(t, str) and t})
            for i, left in enumerate(unique):
                for right in unique[i + 1 :]:
                    pair_counts[(left, right)] = pair_counts.get((left, right), 0) + 1
        return pair_counts

    @staticmethod
    def _group_by_tag(
        pair_counts: dict[tuple[str, str], int], min_count: int
    ) -> dict[str, list[tuple[str, int]]]:
        """Group pair counts by each tag, filtering below min_count."""
        by_tag: dict[str, list[tuple[str, int]]] = {}
        for (left, right), count in pair_counts.items():
            if count >= min_count:
                by_tag.setdefault(left, []).append((right, count))
                by_tag.setdefault(right, []).append((left, count))
        return by_tag

    async def get_tag_cooccurrence(
        self,
        min_count: int = 3,
        limit: int = 20,
    ) -> dict[str, list[str]]:
        """Get frequently co-occurring tags from completed content."""
        result = self.db.query(
            "SELECT tags FROM content "
            "WHERE processing_status = 'completed' AND tags != NONE AND array::len(tags) > 1"
        )
        raw_items = self._parse_query_result(result)
        if not raw_items:
            return {}

        pair_counts = self._count_tag_pairs(raw_items)
        if not pair_counts:
            return {}

        by_tag = self._group_by_tag(pair_counts, min_count)
        if not by_tag:
            return {}

        output: dict[str, list[str]] = {}
        for tag in sorted(by_tag):
            related = sorted(by_tag[tag], key=lambda item: (-item[1], item[0]))
            related_tags = [t for t, _ in related[:limit]]
            if related_tags:
                output[tag] = related_tags
        return output

    async def get_tier_distribution(self) -> dict[str, int]:
        """Get tier distribution for completed content."""
        result = self.db.query(
            "SELECT tier, count() AS count FROM content "
            "WHERE processing_status = 'completed' AND tier != NONE GROUP BY tier"
        )
        rows = self._parse_query_result(result)
        if not rows:
            return {}

        distribution: dict[str, int] = {}
        for row in rows:
            tier = row.get("tier")
            if not isinstance(tier, str) or not tier:
                continue
            try:
                distribution[tier.upper()] = int(row.get("count", 0) or 0)
            except (TypeError, ValueError):
                continue
        return distribution

    async def get_tag_aliases(self, limit: int = 50) -> dict[str, str]:
        """Get most common variant->canonical tag mappings."""
        result = self.db.query(
            "SELECT variant, canonical, usage_count, updated_at FROM tag_alias "
            "ORDER BY usage_count DESC, updated_at DESC LIMIT $limit",
            {"limit": limit},
        )
        rows = self._parse_query_result(result)
        if not rows:
            return {}

        aliases: dict[str, str] = {}
        for row in rows:
            variant = row.get("variant")
            canonical = row.get("canonical")
            if isinstance(variant, str) and isinstance(canonical, str) and variant and canonical:
                aliases[variant] = canonical
        return aliases

    async def record_tag_alias(self, variant: str, canonical: str) -> None:
        """Upsert alias mapping and increment usage count."""
        if not variant or not canonical:
            return

        result = self.db.query(
            "SELECT id, usage_count FROM tag_alias WHERE variant = $variant "
            "AND canonical = $canonical LIMIT 1",
            {"variant": variant, "canonical": canonical},
        )
        rows = self._parse_query_result(result)

        if rows:
            alias_id = rows[0].get("id")
            if alias_id is None:
                return
            try:
                existing_count = int(rows[0].get("usage_count", 0) or 0)
            except (TypeError, ValueError):
                existing_count = 0
            self.db.update(
                alias_id,
                {
                    "variant": variant,
                    "canonical": canonical,
                    "usage_count": existing_count + 1,
                    "updated_at": datetime.now(UTC),
                },
            )
            return

        self.db.create(
            "tag_alias",
            {
                "variant": variant,
                "canonical": canonical,
                "usage_count": 1,
                "updated_at": datetime.now(UTC),
            },
        )

    async def find_content_by_title(self, title: str) -> ContentMetadata | None:
        """Find content by exact title match.

        Args:
            title: Content title to search for

        Returns:
            Content metadata or None if not found
        """
        result = self.db.query(
            "SELECT * FROM content WHERE title = $title LIMIT 1",
            {"title": title},
        )
        raw_items = self._parse_query_result(result)

        if raw_items:
            return self._parse_content(raw_items[0])
        return None

    async def find_content_by_resource_key(self, resource_key: str) -> ContentMetadata | None:
        """Find content by metadata.resource_key."""
        result = self.db.query(
            "SELECT * FROM content WHERE metadata.resource_key = $resource_key LIMIT 1",
            {"resource_key": resource_key},
        )
        raw_items = self._parse_query_result(result)
        if raw_items:
            return self._parse_content(raw_items[0])
        return None

    async def find_content_by_video_id(self, video_id: str) -> ContentMetadata | None:
        """Find YouTube content by video_id.

        Fallback when resource_key lookup misses old records.
        """
        result = self.db.query(
            "SELECT * FROM content "
            "WHERE metadata.video_id = $video_id AND content_type = 'youtube' "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            {"video_id": video_id},
        )
        raw = self._parse_query_result(result)
        if not raw:
            return None
        return self._parse_content(raw[0])

    async def find_content_by_parent_id(
        self, parent_content_id: str, content_type: str | None = None
    ) -> list[ContentMetadata]:
        """Find content records linked to a parent content ID via metadata.

        Args:
            parent_content_id: Parent content ID to filter by
            content_type: Optional filter by content type

        Returns:
            List of content metadata ordered by created_at DESC
        """
        query = "SELECT * FROM content WHERE metadata.parent_content_id = $parent_id"
        params: dict = {"parent_id": parent_content_id}
        if content_type:
            query += " AND content_type = $content_type"
            params["content_type"] = content_type
        query += " ORDER BY created_at DESC"
        result = self.db.query(query, params)
        rows = self._parse_query_result(result)
        return [self._parse_content(row) for row in rows]

    async def create_link(self, link: LinkModel) -> LinkModel:
        """Create link between content items.

        Args:
            link: Link data

        Returns:
            Created link with ID
        """
        link.created_at = datetime.now(UTC)
        link_data = link.model_dump(exclude_none=True)

        # Convert IDs to record references
        link_data["source"] = RecordID("content", link_data["source"])
        if link_data.get("target"):
            link_data["target"] = RecordID("content", link_data["target"])

        result = self.db.create("link", link_data)
        if result:
            record = result[0] if isinstance(result, list) else result
            link.id = self._stringify_record_id(record["id"])
        return link

    async def delete_links_by_source(self, content_id: str) -> None:
        """Delete all links originating from a content item.

        Args:
            content_id: Source content ID
        """
        self.db.query(
            "DELETE (SELECT id FROM link WHERE source = $source)",
            {"source": RecordID("content", content_id)},
        )

    async def get_links_by_source(self, content_id: str) -> list[LinkModel]:
        """Get all links originating from a content item.

        Args:
            content_id: Source content ID

        Returns:
            List of links
        """
        result = self.db.query(
            "SELECT * FROM link WHERE source = $source",
            {"source": RecordID("content", content_id)},
        )
        raw_items = self._parse_query_result(result)

        return [self._parse_link(item) for item in raw_items]

    async def get_links_by_target(self, content_id: str) -> list[LinkModel]:
        """Get all links pointing to a content item (backlinks).

        Args:
            content_id: Target content ID

        Returns:
            List of links
        """
        result = self.db.query(
            "SELECT * FROM link WHERE target = $target",
            {"target": RecordID("content", content_id)},
        )
        raw_items = self._parse_query_result(result)
        return [self._parse_link(item) for item in raw_items]

    async def get_graph_data(
        self,
        tags: list[str] | None = None,
        content_type: str | None = None,
        exclude_tags: list[str] | None = None,
        limit: int = 500,
    ) -> tuple[list[ContentMetadata], list[LinkModel]]:
        """Get graph data for visualization.

        Args:
            tags: Optional filter by tags (can have any specified tag)
            content_type: Optional filter by content type
            exclude_tags: Optional tags to exclude (defaults to ["test"] if None)
            limit: Maximum number of nodes to return

        Returns:
            Tuple of (nodes, edges) where nodes are ContentMetadata and edges are LinkModel
        """
        effective_exclude = ["test"] if exclude_tags is None else exclude_tags
        clauses, filter_params = self._build_content_filters(content_type, tags, effective_exclude)
        params: dict = {"limit": limit, **filter_params}
        where_clause = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        content_result = self.db.query(
            f"SELECT * FROM content{where_clause} LIMIT $limit",
            params,
        )
        nodes, node_ids = self._collect_graph_nodes(self._parse_query_result(content_result))
        edges = self._collect_graph_edges(node_ids)
        return nodes, edges

    def _collect_graph_nodes(self, raw_items: list[dict]) -> tuple[list[ContentMetadata], set[str]]:
        """Parse raw content rows into graph nodes, returning (nodes, node_ids)."""
        nodes: list[ContentMetadata] = []
        node_ids: set[str] = set()
        for item in raw_items:
            node = self._parse_content(item)
            if node.id:
                nodes.append(node)
                node_ids.add(node.id)
        return nodes, node_ids

    def _collect_graph_edges(self, node_ids: set[str]) -> list[LinkModel]:
        """Fetch links whose source or target is in node_ids, filtered to within-set links."""
        if not node_ids:
            return []
        node_refs = [RecordID("content", nid) for nid in node_ids]
        link_result = self.db.query(
            "SELECT * FROM link WHERE source IN $ids OR target IN $ids",
            {"ids": node_refs},
        )
        edges: list[LinkModel] = []
        for item in self._parse_query_result(link_result):
            if "source" not in item:
                continue
            link = self._parse_link(item)
            if link.source in node_ids and (link.target is None or link.target in node_ids):
                edges.append(link)
        return edges

    async def get_neighborhood(
        self,
        content_id: str,
        depth: int = 1,
    ) -> tuple[list[ContentMetadata], list[LinkModel]]:
        """Get local neighborhood graph around a content item.

        Args:
            content_id: Center node ID
            depth: Number of hops to traverse (1-3)

        Returns:
            Tuple of (nodes, edges) in the neighborhood
        """
        # First check if center node exists
        center_node = await self.get_content(content_id)
        if not center_node:
            return [], []

        visited_nodes: dict[str, ContentMetadata] = {content_id: center_node}
        all_edges: dict[str, LinkModel] = {}
        current_layer = {content_id}

        for _ in range(depth):
            next_layer: set[str] = set()
            for node_id in current_layer:
                await self._expand_neighborhood_node(node_id, visited_nodes, all_edges, next_layer)
            current_layer = next_layer
            if not current_layer:
                break

        return list(visited_nodes.values()), list(all_edges.values())

    async def _expand_neighborhood_node(
        self,
        node_id: str,
        visited_nodes: dict[str, ContentMetadata],
        all_edges: dict[str, LinkModel],
        next_layer: set[str],
    ) -> None:
        """Expand one node's outgoing and incoming links into visited sets."""
        for link in await self.get_links_by_source(node_id):
            all_edges[link.id or ""] = link
            await self._visit_neighbor(link.target, visited_nodes, next_layer)

        for link in await self.get_links_by_target(node_id):
            all_edges[link.id or ""] = link
            await self._visit_neighbor(link.source, visited_nodes, next_layer)

    async def _visit_neighbor(
        self,
        neighbor_id: str | None,
        visited_nodes: dict[str, ContentMetadata],
        next_layer: set[str],
    ) -> None:
        """Fetch and register a neighbor node if not already visited."""
        if neighbor_id and neighbor_id not in visited_nodes:
            node = await self.get_content(neighbor_id)
            if node:
                visited_nodes[neighbor_id] = node
                next_layer.add(neighbor_id)

    async def get_related_content(
        self,
        content_id: str,
        limit: int = 10,
        window: str = "12m",
    ) -> list[RelatedContent]:
        """Find content related through shared entities.

        Args:
            content_id: Source content to find relations for
            limit: Maximum number of related items to return
            window: Recency filter (`0` for all, otherwise `^\\d+[mwd]$`)

        Returns:
            List of related content sorted by ranking rules
        """
        if window != "0" and not re.match(r"^\d+[mwd]$", window):
            raise ValueError("window must be '0' or match ^\\d+[mwd]$")

        recency_clause = ""
        if window != "0":
            recency_clause = f"AND content_id.created_at >= time::now() - {window}"

        query = f"""
            LET $source_entities = (
                SELECT entity_id
                FROM content_entity
                WHERE content_id = $source_content_id
            );

            SELECT
                content_id,
                title,
                content_type,
                shared_entity_count,
                shared_entities,
                created_at
            FROM (
                SELECT
                    content_id AS content_id,
                    content_id.title AS title,
                    content_id.content_type AS content_type,
                    count() AS shared_entity_count,
                    array::sort(array::group(entity_id.name)) AS shared_entities,
                    content_id.created_at AS created_at
                FROM content_entity
                WHERE entity_id IN $source_entities
                    AND content_id != $source_content_id
                    {recency_clause}
                GROUP BY content_id, title, content_type, created_at
            )
            WHERE shared_entity_count >= 2
            ORDER BY shared_entity_count DESC, created_at DESC, content_id ASC
            LIMIT $limit
        """

        result = self.db.query(
            query,
            {
                "source_content_id": RecordID("content", content_id),
                "limit": limit,
            },
        )
        raw_items = self._parse_query_result(result)
        related_items: list[tuple[RelatedContent, datetime]] = []
        for item in raw_items:
            entry = self._parse_related_item(item, content_id)
            if entry:
                related_items.append(entry)
        related_items.sort(
            key=lambda x: (-x[0].shared_entity_count, -x[1].timestamp(), x[0].content_id)
        )
        return [related for related, _ in related_items]

    @staticmethod
    def _parse_created_at(value) -> datetime:
        """Parse a datetime value from a SurrealDB result field."""
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                pass
        return datetime.min.replace(tzinfo=UTC)

    def _parse_related_item(
        self, item: dict, source_content_id: str
    ) -> tuple[RelatedContent, datetime] | None:
        """Parse one raw related-content row; returns None if it should be skipped."""
        parsed_id = self._stringify_record_id(item.get("content_id"))
        if parsed_id in {source_content_id, f"content:{source_content_id}"}:
            return None
        shared_entity_count = int(item.get("shared_entity_count", 0) or 0)
        if shared_entity_count < 2:
            return None
        shared_entities = item.get("shared_entities")
        if not isinstance(shared_entities, list):
            shared_entities = []
        related = RelatedContent(
            content_id=parsed_id,
            title=item.get("title") or "",
            content_type=item.get("content_type") or "",
            shared_entity_count=shared_entity_count,
            shared_entities=[str(e) for e in shared_entities],
        )
        return related, self._parse_created_at(item.get("created_at"))

    # ==================== Record Parsing Helpers ====================

    def _stringify_record_id(self, value) -> str:
        """Convert a SurrealDB RecordID to a plain string ID.

        Handles three forms returned by the surrealdb Python client:
        - RecordID with .record_id (from create methods)
        - RecordID with .id (from select/query methods)
        - Plain string fallback (split on colon)
        """
        if hasattr(value, "record_id"):
            return str(value.record_id)
        elif hasattr(value, "id"):
            return str(value.id)
        else:
            return str(value).split(":")[-1]

    def _parse_content(self, item: dict) -> ContentMetadata:
        """Parse a raw content record into ContentMetadata."""
        item_copy = dict(item)
        if "id" in item_copy:
            item_copy["id"] = self._stringify_record_id(item_copy["id"])
        return ContentMetadata(**item_copy)

    def _parse_chunk(self, item: dict) -> ChunkModel:
        """Parse a raw chunk record into ChunkModel."""
        item_copy = dict(item)
        if "id" in item_copy:
            item_copy["id"] = self._stringify_record_id(item_copy["id"])
        return ChunkModel(**item_copy)

    def _parse_link(self, item: dict) -> LinkModel:
        """Parse a raw link record into LinkModel."""
        item_copy = dict(item)
        for field in ("id", "source", "target"):
            if field in item_copy and item_copy[field] is not None:
                item_copy[field] = self._stringify_record_id(item_copy[field])
        return LinkModel(**item_copy)

    def _parse_entity(self, item: dict) -> EntityModel:
        """Parse a raw entity record into EntityModel."""
        item_copy = dict(item)
        if "id" in item_copy:
            item_copy["id"] = self._stringify_record_id(item_copy["id"])
        return EntityModel(**item_copy)

    def _parse_content_entity_edge(self, item: dict) -> ContentEntityEdge:
        """Parse a raw content_entity record into ContentEntityEdge."""
        item_copy = dict(item)
        for field in ("id", "content_id", "entity_id"):
            if field in item_copy and item_copy[field] is not None:
                item_copy[field] = self._stringify_record_id(item_copy[field])
        return ContentEntityEdge(**item_copy)

    async def create_entity(self, entity: EntityModel) -> EntityModel:
        """Create a new entity.

        Args:
            entity: Entity to create

        Returns:
            Created entity with ID
        """
        now = datetime.now(UTC)
        entity.created_at = now
        entity.updated_at = now

        # Ensure normalized_name is set
        if not entity.normalized_name:
            entity.normalized_name = normalize_name(entity.name)

        result = self.db.create("entity", entity.model_dump(exclude_none=True, mode="json"))
        if result:
            record = result[0] if isinstance(result, list) else result
            entity.id = self._stringify_record_id(record["id"])
        return entity

    async def get_entity(self, entity_id: str) -> EntityModel | None:
        """Get entity by ID.

        Args:
            entity_id: Entity ID

        Returns:
            Entity or None if not found
        """
        result = self.db.select(f"entity:{entity_id}")
        if result:
            return self._parse_entity(result[0] if isinstance(result, list) else result)
        return None

    async def find_entity_by_normalized_name(
        self,
        normalized_name: str,
        entity_type: EntityType | None = None,
    ) -> EntityModel | None:
        """Find entity by normalized name.

        Args:
            normalized_name: Normalized entity name
            entity_type: Optional filter by entity type

        Returns:
            Entity or None if not found
        """
        params: dict = {"normalized_name": normalized_name}
        query = "SELECT * FROM entity WHERE normalized_name = $normalized_name"

        if entity_type:
            query += " AND entity_type = $entity_type"
            params["entity_type"] = entity_type.value

        query += " LIMIT 1"
        result = self.db.query(query, params)
        raw_items = self._parse_query_result(result)

        if raw_items:
            return self._parse_entity(raw_items[0])
        return None

    async def find_entity_by_alias(self, alias: str) -> EntityModel | None:
        """Find entity that has this alias in metadata.aliases.

        Args:
            alias: Alias to search for

        Returns:
            Entity or None if not found
        """
        normalized_alias = normalize_name(alias)
        result = self.db.query(
            "SELECT * FROM entity WHERE metadata.aliases CONTAINS $alias LIMIT 1",
            {"alias": normalized_alias},
        )
        raw_items = self._parse_query_result(result)

        if raw_items:
            return self._parse_entity(raw_items[0])
        return None

    async def update_entity(self, entity_id: str, updates: dict) -> EntityModel | None:
        """Update entity fields.

        Args:
            entity_id: Entity ID
            updates: Dictionary of fields to update

        Returns:
            Updated entity or None if not found
        """
        updates["updated_at"] = datetime.now(UTC)
        result = self.db.update(f"entity:{entity_id}", updates)
        if result:
            record = result[0] if isinstance(result, list) else result
            return self._parse_entity(record)
        return None

    async def delete_entity(self, entity_id: str) -> None:
        """Delete entity and all its edges.

        Args:
            entity_id: Entity ID
        """
        # Delete all edges to this entity
        self.db.query(
            "DELETE (SELECT id FROM content_entity WHERE entity_id = $entity_id)",
            {"entity_id": RecordID("entity", entity_id)},
        )
        # Delete the entity
        self.db.delete(f"entity:{entity_id}")

    async def list_entities(
        self,
        entity_type: EntityType | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[EntityModel], int]:
        """List entities with optional filtering.

        Args:
            entity_type: Optional filter by entity type
            limit: Maximum number to return
            offset: Number to skip

        Returns:
            Tuple of (entities, count)
        """
        params: dict = {"limit": limit, "offset": offset}
        where_clause = ""

        if entity_type:
            where_clause = " WHERE entity_type = $entity_type"
            params["entity_type"] = entity_type.value

        result = self.db.query(
            f"SELECT * FROM entity{where_clause} ORDER BY name LIMIT $limit START $offset",
            params,
        )
        raw_items = self._parse_query_result(result)
        entities = [self._parse_entity(item) for item in raw_items]
        return entities, len(entities)

    async def list_all_entities(self) -> list[EntityModel]:
        """List all entities (for caching in keyword matcher).

        Returns:
            List of all entities
        """
        result = self.db.query("SELECT * FROM entity")
        raw_items = self._parse_query_result(result)
        return [self._parse_entity(item) for item in raw_items]

    async def create_content_entity_edge(self, edge: ContentEntityEdge) -> ContentEntityEdge:
        """Create a content-entity edge.

        Args:
            edge: Edge to create

        Returns:
            Created edge with ID
        """
        edge.created_at = datetime.now(UTC)
        edge_data = edge.model_dump(exclude_none=True, mode="json")

        # Convert IDs to record references
        edge_data["content_id"] = RecordID("content", edge_data["content_id"])
        edge_data["entity_id"] = RecordID("entity", edge_data["entity_id"])

        result = self.db.create("content_entity", edge_data)
        if result:
            record = result[0] if isinstance(result, list) else result
            edge.id = self._stringify_record_id(record["id"])
        return edge

    async def get_entities_for_content(
        self, content_id: str
    ) -> list[tuple[EntityModel, ContentEntityEdge]]:
        """Get all entities linked to a content item.

        Args:
            content_id: Content ID

        Returns:
            List of (entity, edge) tuples
        """
        result = self.db.query(
            """
            SELECT *, entity_id.* AS entity FROM content_entity
            WHERE content_id = $content_id
            """,
            {"content_id": RecordID("content", content_id)},
        )
        raw_items = self._parse_query_result(result)

        entities_with_edges = []
        for item in raw_items:
            # Extract the nested entity data
            entity_data = item.pop("entity", None)
            if entity_data:
                entity = self._parse_entity(entity_data)
                edge = self._parse_content_entity_edge(item)
                entities_with_edges.append((entity, edge))
        return entities_with_edges

    async def get_content_for_entity(
        self,
        entity_id: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[tuple[ContentMetadata, ContentEntityEdge]]:
        """Get all content linked to an entity.

        Args:
            entity_id: Entity ID
            limit: Maximum number to return
            offset: Number to skip

        Returns:
            List of (content, edge) tuples
        """
        result = self.db.query(
            """
            SELECT *, content_id.* AS content FROM content_entity
            WHERE entity_id = $entity_id
            LIMIT $limit START $offset
            """,
            {"entity_id": RecordID("entity", entity_id), "limit": limit, "offset": offset},
        )
        raw_items = self._parse_query_result(result)

        content_with_edges = []
        for item in raw_items:
            content_data = item.pop("content", None)
            if content_data:
                content = self._parse_content(content_data)
                edge = self._parse_content_entity_edge(item)
                content_with_edges.append((content, edge))
        return content_with_edges

    async def delete_content_entity_edges(self, content_id: str) -> None:
        """Delete all entity edges for a content item.

        Args:
            content_id: Content ID
        """
        self.db.query(
            "DELETE (SELECT id FROM content_entity WHERE content_id = $content_id)",
            {"content_id": RecordID("content", content_id)},
        )

    async def find_or_create_entity(
        self,
        name: str,
        entity_type: EntityType,
        **kwargs,
    ) -> tuple[EntityModel, bool]:
        """Find existing entity or create new one.

        Args:
            name: Entity name
            entity_type: Entity type
            **kwargs: Additional fields for entity creation

        Returns:
            Tuple of (entity, was_created)
        """
        normalized = normalize_name(name)

        # Try to find by normalized name
        existing = await self.find_entity_by_normalized_name(normalized, entity_type)
        if existing:
            return existing, False

        # Try to find by alias
        existing = await self.find_entity_by_alias(name)
        if existing and existing.entity_type == entity_type:
            return existing, False

        # Create new entity
        entity = EntityModel(
            entity_type=entity_type,
            name=name,
            normalized_name=normalized,
            **kwargs,
        )
        created = await self.create_entity(entity)
        return created, True

    async def get_topic_hierarchy(self) -> list[EntityModel]:
        """Get all topic entities for building hierarchy view.

        Returns:
            List of topic entities
        """
        result = self.db.query(
            "SELECT * FROM entity WHERE entity_type = 'topic' ORDER BY hierarchy, name"
        )
        raw_items = self._parse_query_result(result)
        return [self._parse_entity(item) for item in raw_items]

    # ==================== Unified Processing Methods ====================

    async def update_content_processing_status(
        self,
        content_id: str,
        status: str,
        pipeline_version: str | None = None,
    ) -> None:
        """Update unified processing status on content.

        Args:
            content_id: Content ID
            status: Status string (pending, processing, completed, failed)
            pipeline_version: Optional pipeline version
        """
        params: dict = {
            "content_id": RecordID("content", content_id),
            "status": status,
        }
        version_clause = ""
        if pipeline_version:
            version_clause = "pipeline_version = $pipeline_version,"
            params["pipeline_version"] = pipeline_version

        self.db.query(
            f"""
            UPDATE content SET
                processing_status = $status,
                processed_at = time::now(),
                {version_clause}
                updated_at = time::now()
            WHERE id = $content_id
            """,
            params,
        )

    async def update_content_processing_result(
        self,
        content_id: str,
        result_dict: dict,
        pipeline_version: str,
    ) -> None:
        """Store unified pipeline result and set completed status.

        Args:
            content_id: Content ID
            result_dict: Pipeline result data
            pipeline_version: Pipeline version string
        """
        self.db.query(
            """
            UPDATE content SET
                metadata.unified_result = $data,
                processing_status = 'completed',
                processed_at = time::now(),
                pipeline_version = $pipeline_version,
                updated_at = time::now()
            WHERE id = $content_id
            """,
            {
                "content_id": RecordID("content", content_id),
                "data": result_dict,
                "pipeline_version": pipeline_version,
            },
        )

    async def find_potential_duplicates(self, max_distance: int = 1) -> list[list[EntityModel]]:
        """Find potential duplicate entities based on normalized names.

        This loads all entities and uses Levenshtein distance for comparison.

        Args:
            max_distance: Maximum edit distance to consider as duplicate

        Returns:
            List of groups of potential duplicates
        """
        from menos.services.normalization import find_near_duplicates

        all_entities = await self.list_all_entities()
        return find_near_duplicates(
            all_entities,
            lambda e: e.normalized_name,
            max_distance,
        )
