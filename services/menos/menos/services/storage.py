"""S3-compatible object storage and PostgreSQL metadata repository."""

# ruff: noqa: E501

import re
from datetime import UTC, datetime, timedelta
from itertools import combinations
from typing import Any, BinaryIO
from uuid import uuid4

from minio import Minio
from minio.error import S3Error
from psycopg.types.json import Jsonb

from menos.models import (
    ChunkModel,
    ContentEntityEdge,
    ContentMetadata,
    EntityModel,
    EntityType,
    JobStatus,
    LinkModel,
    PipelineJob,
    RelatedContent,
)
from menos.services.database import PostgresDatabase
from menos.services.normalization import normalize_name
from menos.services.version_utils import has_version_drift, parse_version_tuple

_TIER_ORDER = ["S", "A", "B", "C", "D"]
JobTiming = tuple[datetime | None, datetime | None]
JobErrors = tuple[str | None, str | None, str | None]
_CONTENT_COLUMNS = (
    "id, content_type, title, description, mime_type, file_size, file_path, author, "
    "tags, tier, metadata, created_at, updated_at"
)
_ENTITY_COLUMNS = (
    "id, entity_type, name, normalized_name, description, hierarchy, metadata, "
    "created_at, updated_at, source"
)


def _compute_valid_tiers(tier_min: str | None) -> list[str]:
    if tier_min is None:
        return []
    normalized = tier_min.strip().upper()
    if normalized not in _TIER_ORDER:
        return []
    return _TIER_ORDER[: _TIER_ORDER.index(normalized) + 1]


def _new_id() -> str:
    return uuid4().hex


def _vector_literal(values: list[float]) -> str:
    if len(values) != 1024:
        raise ValueError(f"embedding must contain exactly 1024 values, got {len(values)}")
    return "[" + ",".join(format(float(value), ".17g") for value in values) + "]"


class S3Storage:
    def __init__(self, client: Minio, bucket: str):
        self.client = client
        self.bucket = bucket

    async def upload(self, file_path: str, data: BinaryIO, content_type: str) -> int:
        try:
            data.seek(0, 2)
            file_size = data.tell()
            data.seek(0)
            self.client.put_object(
                self.bucket, file_path, data, file_size, content_type=content_type
            )
            return file_size
        except S3Error as error:
            raise RuntimeError(f"S3 upload failed: {error}") from error

    async def download(self, file_path: str) -> bytes:
        try:
            response = self.client.get_object(self.bucket, file_path)
            return response.read()
        except S3Error as error:
            raise RuntimeError(f"S3 download failed: {error}") from error

    async def delete(self, file_path: str) -> None:
        try:
            self.client.remove_object(self.bucket, file_path)
        except S3Error as error:
            raise RuntimeError(f"S3 delete failed: {error}") from error


MinIOStorage = S3Storage


class PostgresRepository:
    """Explicit PostgreSQL repository for all Menos metadata operations."""

    def __init__(self, database: PostgresDatabase):
        self._database = database

    async def connect(self) -> None:
        self._database.open()
        self._database.check()

    def close(self) -> None:
        self._database.close()

    async def create_content(self, metadata: ContentMetadata) -> ContentMetadata:
        now = datetime.now(UTC)
        metadata.id = metadata.id or _new_id()
        metadata.created_at = metadata.created_at or now
        metadata.updated_at = now
        row = self._database.fetch_one(
            f"""INSERT INTO content ({_CONTENT_COLUMNS})
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING {_CONTENT_COLUMNS}""",
            (
                metadata.id,
                metadata.content_type,
                metadata.title,
                metadata.description,
                metadata.mime_type,
                metadata.file_size,
                metadata.file_path,
                metadata.author,
                metadata.tags,
                metadata.tier,
                Jsonb(metadata.metadata),
                metadata.created_at,
                metadata.updated_at,
            ),
        )
        return self._parse_content(row or {})

    async def get_content(self, content_id: str) -> ContentMetadata | None:
        row = self._database.fetch_one(
            f"SELECT {_CONTENT_COLUMNS} FROM content WHERE id = %s", (content_id,)
        )
        return self._parse_content(row) if row else None

    async def list_content(
        self,
        offset: int = 0,
        limit: int = 50,
        content_type: str | None = None,
        tags: list[str] | None = None,
        exclude_tags: list[str] | None = None,
        order_by: str | None = None,
    ) -> tuple[list[ContentMetadata], int]:
        self._validate_pagination(limit, offset, "content")
        where, params = self._content_filters(content_type, tags, exclude_tags)
        ordering = self._content_order(order_by)
        count = self._database.fetch_one(f"SELECT count(*) AS count FROM content{where}", params)
        rows = self._database.fetch_all(
            f"SELECT {_CONTENT_COLUMNS} FROM content{where} ORDER BY {ordering} LIMIT %s OFFSET %s",
            (*params, limit, offset),
        )
        return [self._parse_content(row) for row in rows], int((count or {}).get("count", 0))

    @staticmethod
    def _validate_pagination(limit: int, offset: int, resource: str) -> None:
        if limit < 1 or limit > 1000 or offset < 0:
            raise ValueError(f"invalid {resource} pagination")

    @classmethod
    def _content_filters(
        cls,
        content_type: str | None,
        tags: list[str] | None,
        exclude_tags: list[str] | None,
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        for clause, value in (
            ("content_type = %s", content_type),
            ("tags && %s", tags),
            ("NOT tags && %s", cls._effective_exclude_tags(tags, exclude_tags)),
        ):
            if value:
                clauses.append(clause)
                params.append(value)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return where, params

    @staticmethod
    def _content_order(order_by: str | None) -> str:
        orders = {
            None: "created_at DESC, id ASC",
            "created_at DESC": "created_at DESC, id ASC",
            "created_at ASC": "created_at ASC, id ASC",
            "updated_at DESC": "updated_at DESC, id ASC",
            "title ASC": "title ASC NULLS LAST, id ASC",
        }
        if order_by not in orders:
            raise ValueError("unsupported order_by")
        return orders[order_by]

    @staticmethod
    def _effective_exclude_tags(
        tags: list[str] | None, exclude_tags: list[str] | None
    ) -> list[str]:
        effective = ["test"] if exclude_tags is None else exclude_tags
        return [tag for tag in effective if not tags or tag not in tags]

    async def get_content_stats(self) -> dict:
        status_rows = self._database.fetch_all(
            "SELECT coalesce(processing_status, 'none') AS status, count(*) AS count FROM content GROUP BY 1"
        )
        type_rows = self._database.fetch_all(
            "SELECT content_type, count(*) AS count FROM content GROUP BY content_type"
        )
        return {
            "total": sum(int(row["count"]) for row in status_rows),
            "by_status": {row["status"]: int(row["count"]) for row in status_rows},
            "by_content_type": {row["content_type"]: int(row["count"]) for row in type_rows},
        }

    async def get_version_drift_report(self, current_version: str) -> dict:
        rows = self._database.fetch_all(
            "SELECT pipeline_version, count(*) AS count FROM content WHERE processing_status = 'completed' GROUP BY pipeline_version"
        )
        stale: list[dict[str, str | int]] = []
        unknown = 0
        total = 0
        for row in rows:
            count = int(row["count"])
            total += count
            version = row.get("pipeline_version")
            if parse_version_tuple(version) is None:
                unknown += count
            elif has_version_drift(version, current_version):
                stale.append({"version": str(version), "count": count})
        stale.sort(key=lambda item: (-int(item["count"]), str(item["version"])))
        return {
            "current_version": current_version,
            "stale_content": stale,
            "total_stale": sum(int(item["count"]) for item in stale),
            "unknown_version_count": unknown,
            "total_content": total,
        }

    async def update_content(self, content_id: str, metadata: ContentMetadata) -> ContentMetadata:
        metadata.updated_at = datetime.now(UTC)
        row = self._database.fetch_one(
            f"""UPDATE content SET content_type=%s,title=%s,description=%s,mime_type=%s,
            file_size=%s,file_path=%s,author=%s,tags=%s,tier=%s,metadata=%s,updated_at=%s
            WHERE id=%s RETURNING {_CONTENT_COLUMNS}""",
            (
                metadata.content_type,
                metadata.title,
                metadata.description,
                metadata.mime_type,
                metadata.file_size,
                metadata.file_path,
                metadata.author,
                metadata.tags,
                metadata.tier,
                Jsonb(metadata.metadata),
                metadata.updated_at,
                content_id,
            ),
        )
        if not row:
            raise RuntimeError(f"Failed to update content {content_id}")
        return self._parse_content(row)

    async def update_content_fields(self, content_id: str, **fields: Any) -> ContentMetadata | None:
        allowed = {"title", "tags", "metadata", "description", "tier"}
        selected = {key: value for key, value in fields.items() if key in allowed}
        if not selected:
            return await self.get_content(content_id)
        assignments: list[str] = []
        params: list[Any] = []
        for key, value in selected.items():
            assignments.append(f"{key} = %s")
            params.append(Jsonb(value) if key == "metadata" else value)
        params.append(content_id)
        row = self._database.fetch_one(
            f"UPDATE content SET {', '.join(assignments)}, updated_at=now() WHERE id=%s RETURNING {_CONTENT_COLUMNS}",
            params,
        )
        return self._parse_content(row) if row else None

    async def delete_content(self, content_id: str) -> None:
        self._database.execute("DELETE FROM content WHERE id = %s", (content_id,))

    async def create_chunk(self, chunk: ChunkModel) -> ChunkModel:
        chunk.id = chunk.id or _new_id()
        chunk.created_at = chunk.created_at or datetime.now(UTC)
        row = self._database.fetch_one(
            """INSERT INTO chunk (id,content_id,text,chunk_index,embedding,created_at)
            VALUES (%s,%s,%s,%s,%s::vector,%s)
            RETURNING id,content_id,text,chunk_index,embedding::text AS embedding,created_at""",
            (
                chunk.id,
                chunk.content_id,
                chunk.text,
                chunk.chunk_index,
                _vector_literal(chunk.embedding) if chunk.embedding is not None else None,
                chunk.created_at,
            ),
        )
        return self._parse_chunk(row or {})

    async def get_chunks(self, content_id: str) -> list[ChunkModel]:
        rows = self._database.fetch_all(
            "SELECT id,content_id,text,chunk_index,embedding::text AS embedding,created_at FROM chunk WHERE content_id=%s ORDER BY chunk_index",
            (content_id,),
        )
        return [self._parse_chunk(row) for row in rows]

    async def get_chunk_counts(self, content_ids: list[str]) -> dict[str, int]:
        if not content_ids:
            return {}
        rows = self._database.fetch_all(
            "SELECT content_id,count(*) AS count FROM chunk WHERE content_id = ANY(%s) GROUP BY content_id",
            (content_ids,),
        )
        return {row["content_id"]: int(row["count"]) for row in rows}

    async def delete_chunks(self, content_id: str) -> None:
        self._database.execute("DELETE FROM chunk WHERE content_id=%s", (content_id,))

    async def vector_search(
        self,
        embedding: list[float],
        *,
        limit: int,
        **search_filters: Any,
    ) -> list[dict]:
        if limit < 1 or limit > 1000:
            raise ValueError("invalid search limit")
        options = self._vector_search_options(search_filters)
        content_type = options["content_type"]
        tags = options["tags"]
        exclude_tags = options["exclude_tags"]
        valid_tiers = options["valid_tiers"]
        minimum_score = options["minimum_score"]
        clauses = ["ch.embedding IS NOT NULL"]
        params: list[Any] = [_vector_literal(embedding)]
        if content_type:
            clauses.append("c.content_type=%s")
            params.append(content_type)
        if tags:
            clauses.append("c.tags && %s")
            params.append(tags)
        if exclude_tags:
            clauses.append("NOT c.tags && %s")
            params.append(exclude_tags)
        if valid_tiers:
            clauses.append("c.tier = ANY(%s)")
            params.append(valid_tiers)
        score = "1 - (ch.embedding <=> %s::vector)"
        if minimum_score is not None:
            clauses.append(f"{score} > %s")
            params.extend([_vector_literal(embedding), minimum_score])
        params.append(limit)
        return self._database.fetch_all(
            f"""SELECT ch.text,ch.content_id,c.title,c.content_type,{score} AS score
            FROM chunk ch JOIN content c ON c.id=ch.content_id
            WHERE {" AND ".join(clauses)} ORDER BY score DESC,ch.id ASC LIMIT %s""",
            params,
        )

    @staticmethod
    def _vector_search_options(search_filters: dict[str, Any]) -> dict[str, Any]:
        defaults = {
            "content_type": None,
            "tags": None,
            "exclude_tags": None,
            "valid_tiers": None,
            "minimum_score": None,
        }
        unexpected = set(search_filters) - set(defaults)
        if unexpected:
            name = sorted(unexpected)[0]
            raise TypeError(f"unexpected vector search filter: {name}")
        return defaults | search_filters

    async def lexical_search(self, query: str, *, limit: int = 50) -> list[dict]:
        if limit < 1 or limit > 1000:
            raise ValueError("invalid search limit")
        return self._database.fetch_all(
            """SELECT ch.text,ch.content_id,c.title,c.content_type,
            ts_rank_cd(ch.search_document,websearch_to_tsquery('english',%s)) AS score
            FROM chunk ch JOIN content c ON c.id=ch.content_id
            WHERE ch.search_document @@ websearch_to_tsquery('english',%s)
            ORDER BY score DESC,ch.id ASC LIMIT %s""",
            (query, query, limit),
        )

    async def fetch_content_metadata(self, content_ids: list[str]) -> dict[str, dict]:
        if not content_ids:
            return {}
        rows = self._database.fetch_all(
            "SELECT id,title,content_type FROM content WHERE id = ANY(%s)", (content_ids,)
        )
        return {
            row["id"]: {"title": row["title"], "content_type": row["content_type"]} for row in rows
        }

    async def filter_content_ids_by_entities(
        self,
        content_ids: list[str],
        entity_ids: list[str] | None = None,
        entity_types: list[str] | None = None,
        topics: list[str] | None = None,
    ) -> set[str]:
        matching = self._filter_by_entity_ids(set(content_ids), entity_ids)
        matching = self._filter_by_entity_types(matching, entity_types)
        return self._filter_by_topics(matching, topics)

    def _filter_by_entity_ids(self, matching: set[str], entity_ids: list[str] | None) -> set[str]:
        for entity_id in entity_ids or []:
            rows = self._database.fetch_all(
                "SELECT content_id FROM content_entity WHERE entity_id=%s AND content_id=ANY(%s)",
                (entity_id, list(matching)),
            )
            matching &= {row["content_id"] for row in rows}
        return matching

    def _filter_by_entity_types(
        self, matching: set[str], entity_types: list[str] | None
    ) -> set[str]:
        if not entity_types or not matching:
            return matching
        rows = self._database.fetch_all(
            """SELECT DISTINCT ce.content_id FROM content_entity ce JOIN entity e ON e.id=ce.entity_id
            WHERE ce.content_id=ANY(%s) AND e.entity_type=ANY(%s)""",
            (list(matching), entity_types),
        )
        return matching & {row["content_id"] for row in rows}

    def _filter_by_topics(self, matching: set[str], topics: list[str] | None) -> set[str]:
        for topic in topics or []:
            hierarchy = [part.strip() for part in topic.split(">")]
            rows = self._database.fetch_all(
                """SELECT DISTINCT ce.content_id FROM content_entity ce JOIN entity e ON e.id=ce.entity_id
                WHERE ce.content_id=ANY(%s) AND e.entity_type='topic' AND e.hierarchy @> %s""",
                (list(matching), hierarchy),
            )
            matching &= {row["content_id"] for row in rows}
        return matching

    async def list_tags_with_counts(self) -> list[dict[str, str | int]]:
        rows = self._database.fetch_all(
            "SELECT tag AS name,count(*) AS count FROM content CROSS JOIN LATERAL unnest(tags) tag GROUP BY tag ORDER BY count DESC,tag ASC"
        )
        return rows

    async def get_tag_cooccurrence(
        self, min_count: int = 3, limit: int = 20
    ) -> dict[str, list[str]]:
        rows = self._database.fetch_all(
            "SELECT tags FROM content WHERE processing_status='completed'"
        )
        counts: dict[tuple[str, str], int] = {}
        for row in rows:
            for pair in combinations(sorted(set(row.get("tags") or [])), 2):
                counts[pair] = counts.get(pair, 0) + 1
        output: dict[str, list[tuple[str, int]]] = {}
        for (left, right), count in counts.items():
            if count >= min_count:
                output.setdefault(left, []).append((right, count))
                output.setdefault(right, []).append((left, count))
        return {
            tag: [name for name, _ in sorted(values, key=lambda item: (-item[1], item[0]))[:limit]]
            for tag, values in sorted(output.items())
        }

    async def get_tier_distribution(self) -> dict[str, int]:
        rows = self._database.fetch_all(
            "SELECT tier,count(*) AS count FROM content WHERE processing_status='completed' "
            "AND tier IS NOT NULL GROUP BY tier"
        )
        return {str(row["tier"]).upper(): int(row["count"]) for row in rows}

    async def get_tag_aliases(self, limit: int = 50) -> dict[str, str]:
        rows = self._database.fetch_all(
            "SELECT variant,canonical FROM tag_alias "
            "ORDER BY usage_count DESC,updated_at DESC,variant,canonical LIMIT %s",
            (limit,),
        )
        return {row["variant"]: row["canonical"] for row in rows}

    async def record_tag_alias(self, variant: str, canonical: str) -> None:
        self._database.execute(
            """INSERT INTO tag_alias(id,variant,canonical,usage_count) VALUES(%s,%s,%s,1)
            ON CONFLICT(variant,canonical) DO UPDATE SET usage_count=tag_alias.usage_count+1,updated_at=now()""",
            (_new_id(), variant, canonical),
        )

    async def find_content_by_title(self, title: str) -> ContentMetadata | None:
        row = self._database.fetch_one(
            f"SELECT {_CONTENT_COLUMNS} FROM content WHERE title=%s ORDER BY id LIMIT 1", (title,)
        )
        return self._parse_content(row) if row else None

    async def find_content_by_resource_key(self, resource_key: str) -> ContentMetadata | None:
        row = self._database.fetch_one(
            f"SELECT {_CONTENT_COLUMNS} FROM content WHERE metadata->>'resource_key'=%s ORDER BY id LIMIT 1",
            (resource_key,),
        )
        return self._parse_content(row) if row else None

    async def find_content_by_video_id(self, video_id: str) -> ContentMetadata | None:
        row = self._database.fetch_one(
            f"SELECT {_CONTENT_COLUMNS} FROM content WHERE metadata->>'video_id'=%s ORDER BY id LIMIT 1",
            (video_id,),
        )
        return self._parse_content(row) if row else None

    async def find_content_by_parent_id(
        self, parent_content_id: str, content_type: str | None = None
    ) -> list[ContentMetadata]:
        params: list[Any] = [parent_content_id]
        type_clause = ""
        if content_type:
            type_clause = " AND content_type=%s"
            params.append(content_type)
        rows = self._database.fetch_all(
            f"SELECT {_CONTENT_COLUMNS} FROM content "
            f"WHERE metadata->>'parent_content_id'=%s{type_clause} "
            "ORDER BY created_at DESC,id",
            params,
        )
        return [self._parse_content(row) for row in rows]

    async def create_link(self, link: LinkModel) -> LinkModel:
        link.id = link.id or _new_id()
        link.created_at = link.created_at or datetime.now(UTC)
        row = self._database.fetch_one(
            """INSERT INTO link(id,source,target,link_text,link_type,created_at)
            VALUES(%s,%s,%s,%s,%s,%s) RETURNING *""",
            (link.id, link.source, link.target, link.link_text, link.link_type, link.created_at),
        )
        return self._parse_link(row or {})

    async def delete_links_by_source(self, source: str) -> None:
        self._database.execute("DELETE FROM link WHERE source=%s", (source,))

    async def get_links_by_source(self, source: str) -> list[LinkModel]:
        return [
            self._parse_link(row)
            for row in self._database.fetch_all(
                "SELECT * FROM link WHERE source=%s ORDER BY id", (source,)
            )
        ]

    async def get_links_by_target(self, target: str) -> list[LinkModel]:
        return [
            self._parse_link(row)
            for row in self._database.fetch_all(
                "SELECT * FROM link WHERE target=%s ORDER BY id", (target,)
            )
        ]

    async def get_graph_data(
        self,
        tags: list[str] | None = None,
        content_type: str | None = None,
        exclude_tags: list[str] | None = None,
        limit: int = 500,
    ) -> tuple[list[ContentMetadata], list[LinkModel]]:
        if limit < 1 or limit > 1000:
            raise ValueError("invalid graph limit")
        where, params = self._content_filters(content_type, tags, exclude_tags)
        rows = self._database.fetch_all(
            f"SELECT {_CONTENT_COLUMNS} FROM content{where} ORDER BY created_at DESC,id LIMIT %s",
            (*params, limit),
        )
        nodes = [self._parse_content(row) for row in rows]
        ids = [node.id for node in nodes if node.id]
        return nodes, self._graph_edges(ids)

    def _graph_edges(self, ids: list[str]) -> list[LinkModel]:
        if not ids:
            return []
        rows = self._database.fetch_all(
            "SELECT * FROM link WHERE source=ANY(%s) OR target=ANY(%s) ORDER BY id",
            (ids, ids),
        )
        return [
            self._parse_link(row)
            for row in rows
            if row["source"] in ids and (row.get("target") is None or row["target"] in ids)
        ]

    async def get_neighborhood(
        self, content_id: str, depth: int = 1
    ) -> tuple[list[ContentMetadata], list[LinkModel]]:
        if depth < 1 or depth > 3:
            raise ValueError("depth must be between 1 and 3")
        center = await self.get_content(content_id)
        if center is None:
            return [], []
        rows = self._database.fetch_all(
            """WITH RECURSIVE neighborhood(id,level) AS (
            SELECT %s::text,0 UNION SELECT CASE WHEN l.source=n.id THEN l.target ELSE l.source END,n.level+1
            FROM neighborhood n JOIN link l ON l.source=n.id OR l.target=n.id
            WHERE n.level < %s AND CASE WHEN l.source=n.id THEN l.target ELSE l.source END IS NOT NULL)
            SELECT DISTINCT c.* FROM neighborhood n JOIN content c ON c.id=n.id""",
            (content_id, depth),
        )
        nodes = [self._parse_content(row) for row in rows]
        ids = [node.id for node in nodes if node.id]
        return nodes, self._neighborhood_links(ids)

    def _neighborhood_links(self, ids: list[str]) -> list[LinkModel]:
        if not ids:
            return []
        rows = self._database.fetch_all(
            "SELECT * FROM link WHERE source=ANY(%s) AND target=ANY(%s) ORDER BY id",
            (ids, ids),
        )
        return [self._parse_link(row) for row in rows]

    async def get_related_content(
        self, content_id: str, limit: int = 10, window: str = "12m"
    ) -> list[RelatedContent]:
        if window != "0" and not re.fullmatch(r"\d+[mwd]", window):
            raise ValueError("window must be '0' or match ^\\d+[mwd]$")
        params: list[Any] = [content_id]
        recency = ""
        if window != "0":
            amount = int(window[:-1])
            days = amount * {"m": 30, "w": 7, "d": 1}[window[-1]]
            recency = " AND other.created_at >= %s"
            params.append(datetime.now(UTC) - timedelta(days=days))
        params.append(limit)
        rows = self._database.fetch_all(
            """SELECT other.id AS content_id,other.title,other.content_type,
            count(*) AS shared_entity_count,array_agg(DISTINCT e.name ORDER BY e.name) AS shared_entities
            FROM content_entity mine JOIN content_entity theirs
              ON theirs.entity_id=mine.entity_id AND theirs.content_id<>mine.content_id
            JOIN content other ON other.id=theirs.content_id JOIN entity e ON e.id=mine.entity_id
            WHERE mine.content_id=%s"""
            + recency
            + """ GROUP BY other.id,other.title,other.content_type,other.created_at
            HAVING count(*) >= 2
            ORDER BY shared_entity_count DESC,other.created_at DESC,other.id LIMIT %s""",
            params,
        )
        return [RelatedContent(**row) for row in rows]

    async def create_entity(self, entity: EntityModel) -> EntityModel:
        entity.id = entity.id or _new_id()
        now = datetime.now(UTC)
        entity.created_at = entity.created_at or now
        entity.updated_at = now
        row = self._database.fetch_one(
            """INSERT INTO entity(id,entity_type,name,normalized_name,description,hierarchy,metadata,created_at,updated_at,source)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (
                entity.id,
                entity.entity_type.value,
                entity.name,
                entity.normalized_name,
                entity.description,
                entity.hierarchy,
                Jsonb(entity.metadata),
                entity.created_at,
                entity.updated_at,
                entity.source.value,
            ),
        )
        return self._parse_entity(row or {})

    async def get_entity(self, entity_id: str) -> EntityModel | None:
        row = self._database.fetch_one(
            f"SELECT {_ENTITY_COLUMNS} FROM entity WHERE id=%s", (entity_id,)
        )
        return self._parse_entity(row) if row else None

    async def find_entity_by_normalized_name(
        self, normalized_name: str, entity_type: EntityType | None = None
    ) -> EntityModel | None:
        if entity_type:
            row = self._database.fetch_one(
                f"SELECT {_ENTITY_COLUMNS} FROM entity WHERE normalized_name=%s AND entity_type=%s ORDER BY id LIMIT 1",
                (normalized_name, entity_type.value),
            )
        else:
            row = self._database.fetch_one(
                f"SELECT {_ENTITY_COLUMNS} FROM entity WHERE normalized_name=%s ORDER BY id LIMIT 1",
                (normalized_name,),
            )
        return self._parse_entity(row) if row else None

    async def find_entity_by_alias(self, alias: str) -> EntityModel | None:
        row = self._database.fetch_one(
            f"SELECT {_ENTITY_COLUMNS} FROM entity WHERE metadata->'aliases' ? %s ORDER BY id LIMIT 1",
            (alias,),
        )
        return self._parse_entity(row) if row else None

    async def update_entity(self, entity_id: str, updates: dict) -> EntityModel | None:
        current = await self.get_entity(entity_id)
        if current is None:
            return None
        data = current.model_dump()
        data.update(updates)
        entity = EntityModel(**data)
        row = self._database.fetch_one(
            f"""UPDATE entity SET entity_type=%s,name=%s,normalized_name=%s,description=%s,hierarchy=%s,
            metadata=%s,updated_at=now(),source=%s WHERE id=%s RETURNING {_ENTITY_COLUMNS}""",
            (
                entity.entity_type.value,
                entity.name,
                entity.normalized_name,
                entity.description,
                entity.hierarchy,
                Jsonb(entity.metadata),
                entity.source.value,
                entity_id,
            ),
        )
        return self._parse_entity(row) if row else None

    async def delete_entity(self, entity_id: str) -> None:
        self._database.execute("DELETE FROM entity WHERE id=%s", (entity_id,))

    async def list_entities(
        self, entity_type: EntityType | None = None, limit: int = 50, offset: int = 0
    ) -> tuple[list[EntityModel], int]:
        if limit < 1 or limit > 1000 or offset < 0:
            raise ValueError("invalid entity pagination")
        where = " WHERE entity_type=%s" if entity_type else ""
        params: tuple[Any, ...] = (entity_type.value,) if entity_type else ()
        total = self._database.fetch_one(f"SELECT count(*) AS count FROM entity{where}", params)
        rows = self._database.fetch_all(
            f"SELECT {_ENTITY_COLUMNS} FROM entity{where} ORDER BY name,id LIMIT %s OFFSET %s",
            (*params, limit, offset),
        )
        return [self._parse_entity(row) for row in rows], int((total or {}).get("count", 0))

    async def list_all_entities(self) -> list[EntityModel]:
        return [
            self._parse_entity(row)
            for row in self._database.fetch_all(
                f"SELECT {_ENTITY_COLUMNS} FROM entity ORDER BY name,id"
            )
        ]

    async def create_content_entity_edge(self, edge: ContentEntityEdge) -> ContentEntityEdge:
        edge.id = edge.id or _new_id()
        edge.created_at = edge.created_at or datetime.now(UTC)
        row = self._database.fetch_one(
            """INSERT INTO content_entity(id,content_id,entity_id,edge_type,confidence,mention_count,source,created_at)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (
                edge.id,
                edge.content_id,
                edge.entity_id,
                edge.edge_type.value,
                edge.confidence,
                edge.mention_count,
                edge.source.value,
                edge.created_at,
            ),
        )
        return self._parse_content_entity_edge(row or {})

    async def get_entities_for_content(
        self, content_id: str
    ) -> list[tuple[EntityModel, ContentEntityEdge]]:
        rows = self._database.fetch_all(
            """SELECT ce.*,to_jsonb(e.*)-'search_document' AS entity FROM content_entity ce
            JOIN entity e ON e.id=ce.entity_id WHERE ce.content_id=%s ORDER BY ce.created_at,ce.id""",
            (content_id,),
        )
        return [
            (
                self._parse_entity(row["entity"]),
                self._parse_content_entity_edge(
                    {key: value for key, value in row.items() if key != "entity"}
                ),
            )
            for row in rows
        ]

    async def get_content_for_entity(
        self, entity_id: str, limit: int = 50, offset: int = 0
    ) -> list[tuple[ContentMetadata, ContentEntityEdge]]:
        rows = self._database.fetch_all(
            """SELECT ce.*,to_jsonb(c.*)-'search_document' AS content FROM content_entity ce
            JOIN content c ON c.id=ce.content_id WHERE ce.entity_id=%s
            ORDER BY ce.created_at,ce.id LIMIT %s OFFSET %s""",
            (entity_id, limit, offset),
        )
        return [
            (
                self._parse_content(row["content"]),
                self._parse_content_entity_edge(
                    {key: value for key, value in row.items() if key != "content"}
                ),
            )
            for row in rows
        ]

    async def delete_content_entity_edges(self, content_id: str) -> None:
        self._database.execute("DELETE FROM content_entity WHERE content_id=%s", (content_id,))

    async def find_or_create_entity(
        self, name: str, entity_type: EntityType, **kwargs
    ) -> tuple[EntityModel, bool]:
        normalized = normalize_name(name)
        existing = await self.find_entity_by_normalized_name(normalized, entity_type)
        if existing:
            return existing, False
        entity = EntityModel(
            entity_type=entity_type, name=name, normalized_name=normalized, **kwargs
        )
        return await self.create_entity(entity), True

    async def get_topic_hierarchy(self) -> list[EntityModel]:
        rows = self._database.fetch_all(
            f"SELECT {_ENTITY_COLUMNS} FROM entity WHERE entity_type='topic' ORDER BY hierarchy,name,id"
        )
        return [self._parse_entity(row) for row in rows]

    async def update_content_processing_status(
        self, content_id: str, status: str, pipeline_version: str | None = None
    ) -> None:
        self._database.execute(
            "UPDATE content SET processing_status=%s,pipeline_version=coalesce(%s,pipeline_version),updated_at=now() WHERE id=%s",
            (status, pipeline_version, content_id),
        )

    async def update_content_processing_result(
        self, content_id: str, result_dict: dict, pipeline_version: str
    ) -> None:
        self._database.execute(
            """UPDATE content SET metadata=jsonb_set(metadata,'{unified_result}',%s),
            processing_status='completed',processed_at=now(),pipeline_version=%s,updated_at=now()
            WHERE id=%s""",
            (Jsonb(result_dict), pipeline_version, content_id),
        )

    async def find_potential_duplicates(self, max_distance: int = 1) -> list[list[EntityModel]]:
        from menos.services.normalization import find_near_duplicates

        entities = await self.list_all_entities()
        return find_near_duplicates(entities, lambda entity: entity.normalized_name, max_distance)

    def get_content_processing_status(self, content_id: str) -> str | None:
        row = self._database.fetch_one(
            "SELECT processing_status FROM content WHERE id=%s", (content_id,)
        )
        return row.get("processing_status") if row else None

    def get_pipeline_result(self, content_id: str) -> dict | None:
        row = self._database.fetch_one(
            "SELECT processing_status, metadata->'unified_result' AS unified_result "
            "FROM content WHERE id=%s",
            (content_id,),
        )
        if not row or row.get("processing_status") != "completed":
            return None
        result = row.get("unified_result")
        return result if isinstance(result, dict) else None

    def create_pipeline_job(self, job: PipelineJob) -> dict:
        return (
            self._database.fetch_one(
                """INSERT INTO pipeline_job(id,resource_key,content_id,status,pipeline_version,data_tier,
            error_code,error_message,error_stage,metadata,created_at,started_at,finished_at)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (
                    job.id,
                    job.resource_key,
                    job.content_id,
                    job.status.value,
                    job.pipeline_version,
                    job.data_tier.value,
                    job.error_code,
                    job.error_message,
                    job.error_stage,
                    Jsonb(job.metadata),
                    job.created_at,
                    job.started_at,
                    job.finished_at,
                ),
            )
            or job.model_dump()
        )

    def get_pipeline_job(self, job_id: str) -> dict | None:
        return self._database.fetch_one("SELECT * FROM pipeline_job WHERE id=%s", (job_id,))

    def find_active_pipeline_job(self, resource_key: str) -> dict | None:
        return self._database.fetch_one(
            "SELECT * FROM pipeline_job WHERE resource_key=%s AND status=ANY(%s) "
            "ORDER BY created_at DESC,id LIMIT 1",
            (resource_key, ["pending", "processing"]),
        )

    def update_pipeline_job(
        self,
        job_id: str,
        status: JobStatus,
        timing: JobTiming,
        errors: JobErrors,
    ) -> dict | None:
        started_at, finished_at = timing
        error_code, error_message, error_stage = errors
        return self._database.fetch_one(
            """UPDATE pipeline_job SET status=%s,started_at=coalesce(%s,started_at),
            finished_at=coalesce(%s,finished_at),error_code=coalesce(%s,error_code),
            error_message=coalesce(%s,error_message),error_stage=coalesce(%s,error_stage)
            WHERE id=%s RETURNING *""",
            (
                status.value,
                started_at,
                finished_at,
                error_code,
                error_message,
                error_stage,
                job_id,
            ),
        )

    def list_pipeline_jobs(
        self,
        content_id: str | None,
        status: JobStatus | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict], int]:
        where, params = self._pipeline_job_filters(content_id, status)
        total = self._database.fetch_one(
            f"SELECT count(*) AS count FROM pipeline_job{where}", params
        )
        rows = self._database.fetch_all(
            f"SELECT * FROM pipeline_job{where} ORDER BY created_at DESC,id LIMIT %s OFFSET %s",
            (*params, limit, offset),
        )
        return rows, int((total or {}).get("count", 0))

    @staticmethod
    def _pipeline_job_filters(
        content_id: str | None, status: JobStatus | None
    ) -> tuple[str, list[str]]:
        clauses: list[str] = []
        params: list[str] = []
        for clause, value in (
            ("content_id=%s", content_id),
            ("status=%s", status.value if status else None),
        ):
            if value is not None:
                clauses.append(clause)
                params.append(value)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return where, params

    def purge_expired_jobs(self) -> dict[str, int]:
        compact = self._database.execute(
            "DELETE FROM pipeline_job WHERE data_tier='compact' AND finished_at < now()-interval '180 days'"
        )
        full = self._database.execute(
            "DELETE FROM pipeline_job WHERE data_tier='full' AND finished_at < now()-interval '60 days'"
        )
        return {"compact": compact, "full": full}

    def record_llm_usage(self, usage: dict) -> None:
        payload = dict(usage)
        payload.pop("created_at", None)
        self._database.execute(
            """INSERT INTO llm_usage(id,provider,model,input_tokens,output_tokens,input_price_per_million,
            output_price_per_million,estimated_cost,context,duration_ms,pricing_snapshot_refreshed_at)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                _new_id(),
                payload["provider"],
                payload["model"],
                payload["input_tokens"],
                payload["output_tokens"],
                payload["input_price_per_million"],
                payload["output_price_per_million"],
                payload["estimated_cost"],
                payload["context"],
                payload["duration_ms"],
                payload.get("pricing_snapshot_refreshed_at"),
            ),
        )

    def get_pricing_snapshot(self, snapshot_id: str) -> dict | None:
        return self._database.fetch_one(
            "SELECT id,pricing,refreshed_at,source FROM llm_pricing_snapshot WHERE id=%s",
            (snapshot_id,),
        )

    def upsert_pricing_snapshot(
        self, snapshot_id: str, pricing: dict, refreshed_at: datetime, source: str
    ) -> None:
        self._database.execute(
            """INSERT INTO llm_pricing_snapshot(id,pricing,refreshed_at,source) VALUES(%s,%s,%s,%s)
            ON CONFLICT(id) DO UPDATE SET pricing=excluded.pricing,refreshed_at=excluded.refreshed_at,source=excluded.source""",
            (snapshot_id, Jsonb(pricing), refreshed_at, source),
        )

    @staticmethod
    def _usage_filters(
        start: datetime | None,
        end: datetime | None,
        provider: str | None,
        model: str | None,
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        for clause, value in (
            ("created_at >= %s", start),
            ("created_at <= %s", end),
            ("provider = %s", provider),
            ("model = %s", model),
        ):
            if value is not None:
                clauses.append(clause)
                params.append(value)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return where, params

    def usage_totals(
        self,
        start: datetime | None,
        end: datetime | None,
        provider: str | None = None,
        model: str | None = None,
    ) -> dict:
        where, params = self._usage_filters(start, end, provider, model)
        statement = (
            "SELECT count(*) AS total_calls,"
            "coalesce(sum(input_tokens),0) AS total_input_tokens,"
            "coalesce(sum(output_tokens),0) AS total_output_tokens,"
            "coalesce(sum(estimated_cost),0) AS estimated_total_cost "
            f"FROM llm_usage{where}"
        )
        return self._database.fetch_one(statement, params) or {}

    def usage_breakdown(
        self,
        start: datetime | None,
        end: datetime | None,
        provider: str | None = None,
        model: str | None = None,
    ) -> list[dict]:
        where, params = self._usage_filters(start, end, provider, model)
        statement = (
            "SELECT provider,model,count(*) AS calls,"
            "sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,"
            "sum(estimated_cost) AS estimated_cost "
            f"FROM llm_usage{where} GROUP BY provider,model "
            "ORDER BY estimated_cost DESC,provider,model"
        )
        return self._database.fetch_all(statement, params)

    @staticmethod
    def _parse_content(row: dict) -> ContentMetadata:
        allowed = ContentMetadata.model_fields
        return ContentMetadata(**{key: value for key, value in row.items() if key in allowed})

    @staticmethod
    def _parse_chunk(row: dict) -> ChunkModel:
        data = dict(row)
        embedding = data.get("embedding")
        if isinstance(embedding, str):
            data["embedding"] = [
                float(value) for value in embedding.strip("[]").split(",") if value
            ]
        return ChunkModel(**data)

    @staticmethod
    def _parse_link(row: dict) -> LinkModel:
        return LinkModel(**row)

    @staticmethod
    def _parse_entity(row: dict) -> EntityModel:
        return EntityModel(**row)

    @staticmethod
    def _parse_content_entity_edge(row: dict) -> ContentEntityEdge:
        return ContentEntityEdge(**row)


# Transitional type alias for unchanged dependency annotations.
SurrealDBRepository = PostgresRepository
