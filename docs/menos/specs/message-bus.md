# Message Bus Architecture

Architecture for exposing menos to external workflow systems (N8N, automation tools) via message queues.

---

## Overview

A message-driven architecture using Celery (task queue) with RabbitMQ (message broker) to expose menos capabilities to external workflows without tight coupling.

---

## Why This Architecture

- **Workflow Integration**: Clean HTTP/AMQP boundaries for N8N and similar tools
- **Async Processing**: Fire-and-forget pattern for long-running tasks
- **Self-Hosted**: Fully local/on-premise deployment
- **Decoupled**: External systems don't need to understand menos internals
- **Reliable**: Automatic retries, dead letter queues, persistent messages

---

## Core Components

```
External Workflow (N8N)
         │
         ▼
┌─────────────────────────────────────────┐
│  HTTP (Flower API) or AMQP (RabbitMQ)   │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│              Celery Workers             │
├─────────────────────────────────────────┤
│  • youtube_queue - Video ingestion      │
│  • content_queue - Content processing   │
│  • search_queue  - Search operations    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│           menos Core Services           │
├─────────────────────────────────────────┤
│  SurrealDB │ MinIO │ Ollama │ FastAPI   │
└─────────────────────────────────────────┘
```

---

## Infrastructure Setup

### Docker Compose

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"      # AMQP
      - "15672:15672"    # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD}
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  flower:
    image: mher/flower
    command: celery --broker=amqp://admin:${RABBITMQ_PASSWORD}@rabbitmq:5672// flower
    ports:
      - "5555:5555"
    depends_on:
      - rabbitmq

volumes:
  rabbitmq_data:
  redis_data:
```

---

## Celery Task Definitions

### Task Configuration

```python
from celery import Celery

app = Celery('menos',
    broker='amqp://admin:password@localhost:5672//',
    backend='redis://localhost:6379/0'
)

app.conf.update(
    task_serializer='json',
    accept_content=['json'],
    result_serializer='json',
    timezone='UTC',
    enable_utc=True,
    task_routes={
        'tasks.ingest_youtube': {'queue': 'youtube'},
        'tasks.process_content': {'queue': 'content'},
        'tasks.semantic_search': {'queue': 'search'},
    }
)
```

### YouTube Ingestion Task

```python
@app.task(bind=True, max_retries=3)
def ingest_youtube(self, url: str, priority: bool = False):
    """Ingest YouTube video into menos"""
    try:
        from menos.services.youtube import YouTubeService
        service = YouTubeService()
        result = service.ingest_video(url)
        return {
            "status": "success",
            "content_id": result.content_id,
            "title": result.title
        }
    except Exception as exc:
        raise self.retry(exc=exc, countdown=2 ** self.request.retries)
```

### Content Processing Task

```python
@app.task
def process_content(content_id: str, operations: list[str]):
    """Process content with specified operations"""
    from menos.services.storage import SurrealDBRepository
    from menos.services.embeddings import OllamaEmbeddings

    db = SurrealDBRepository()
    embeddings = OllamaEmbeddings()

    results = {}

    if "embed" in operations:
        content = db.get_content(content_id)
        vector = embeddings.generate(content.text)
        db.update_embedding(content_id, vector)
        results["embed"] = "completed"

    if "summarize" in operations:
        content = db.get_content(content_id)
        summary = embeddings.summarize(content.text)
        db.update_summary(content_id, summary)
        results["summarize"] = "completed"

    return results
```

### Search Task

```python
@app.task
def semantic_search(query: str, limit: int = 10):
    """Perform semantic search"""
    from menos.services.search import SearchService
    service = SearchService()
    results = service.search(query, limit=limit)
    return {
        "query": query,
        "results": [r.dict() for r in results]
    }
```

---

## N8N Integration Patterns

### Pattern 1: HTTP via Flower (Simplest)

```javascript
// N8N HTTP Request Node
{
  "method": "POST",
  "url": "http://menos-flower:5555/api/task/async-apply/tasks.ingest_youtube",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "args": ["https://youtube.com/watch?v=abc123"]
  }
}
// Returns: {"task-id": "abc-123-def"}

// Poll for result
{
  "method": "GET",
  "url": "http://menos-flower:5555/api/task/result/abc-123-def"
}
```

### Pattern 2: Direct RabbitMQ (Most Efficient)

```javascript
// N8N RabbitMQ Node
{
  "mode": "publish",
  "exchange": "",
  "routingKey": "youtube",
  "message": {
    "id": "unique-task-id",
    "task": "tasks.ingest_youtube",
    "args": ["https://youtube.com/watch?v=abc123"]
  }
}
```

### Pattern 3: Webhook Callbacks

```python
@app.task
def ingest_youtube_with_callback(url: str, callback_url: str):
    """Ingest video and notify via webhook when complete"""
    result = ingest_youtube(url)

    import httpx
    httpx.post(callback_url, json=result)

    return result
```

---

## Rate Limiting (YouTube API)

### Quota Tracker

```python
import sqlite3
from datetime import datetime

class YouTubeQuotaTracker:
    """Persistent quota tracking for YouTube API"""

    DAILY_QUOTA = 10000
    PRIORITY_RESERVED = 1000

    def __init__(self, db_path: str = "quota.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS quota_usage (
                    date TEXT PRIMARY KEY,
                    units_used INTEGER DEFAULT 0
                )
            """)

    def can_proceed(self, units: int = 1, priority: bool = False) -> bool:
        """Check if we have quota available"""
        today = datetime.now().date().isoformat()

        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT units_used FROM quota_usage WHERE date = ?",
                (today,)
            ).fetchone()

            units_used = row[0] if row else 0
            available = self.DAILY_QUOTA - units_used

            if priority:
                return available >= units

            # Non-priority can't use reserved quota
            return available - self.PRIORITY_RESERVED >= units

    def consume(self, units: int = 1):
        """Record quota consumption"""
        today = datetime.now().date().isoformat()

        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO quota_usage (date, units_used)
                VALUES (?, ?)
                ON CONFLICT(date) DO UPDATE SET units_used = units_used + ?
            """, (today, units, units))
```

### Rate-Limited Task

```python
class YouTubeRateLimitedTask(Task):
    """Base task with YouTube API rate limiting"""

    def __init__(self):
        self.quota_tracker = YouTubeQuotaTracker()

    def before_start(self, task_id, args, kwargs):
        priority = kwargs.get('priority', False)

        if not self.quota_tracker.can_proceed(priority=priority):
            if priority:
                raise self.retry(countdown=3600)  # Try again in 1 hour
            else:
                raise Exception("YouTube API quota exceeded")

    def after_return(self, status, retval, task_id, args, kwargs, einfo):
        if status == "SUCCESS":
            self.quota_tracker.consume()
```

---

## Monitoring

### Flower Web UI

- Task status and history
- Worker status
- Queue lengths
- Task timing statistics

Access at: `http://localhost:5555`

### Quota Dashboard Endpoint

```python
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/quota")

@router.get("/youtube")
async def youtube_quota_status():
    tracker = YouTubeQuotaTracker()
    today_usage = tracker.get_usage_today()

    return {
        "date": datetime.now().date().isoformat(),
        "units_used": today_usage,
        "units_remaining": 10000 - today_usage,
        "priority_reserved": 1000,
        "percentage_used": (today_usage / 10000) * 100
    }
```

---

## Development Setup

### Start Infrastructure

```bash
# Start RabbitMQ, Redis, Flower
docker compose -f docker-compose.messagebus.yml up -d

# Wait for RabbitMQ
sleep 5

# Start workers with auto-reload
celery -A tasks worker -Q youtube --loglevel=info --autoreload &
celery -A tasks worker -Q content --loglevel=info --autoreload &
celery -A tasks worker -Q search --loglevel=info --autoreload &
```

### Submit Test Task

```bash
# Via curl to Flower
curl -X POST http://localhost:5555/api/task/async-apply/tasks.semantic_search \
  -H "Content-Type: application/json" \
  -d '{"args": ["machine learning"], "kwargs": {"limit": 5}}'

# Check result
curl http://localhost:5555/api/task/result/{task-id}
```

---

## Production Considerations

### Celery Configuration

```python
# celeryconfig.py
broker_connection_retry = True
broker_connection_retry_on_startup = True
worker_prefetch_multiplier = 4
worker_max_tasks_per_child = 1000  # Restart after N tasks (memory leaks)

# Result backend
result_expires = 3600  # Results expire after 1 hour
result_compression = 'gzip'

# Task time limits
task_soft_time_limit = 300  # 5 minute soft limit
task_time_limit = 600  # 10 minute hard limit

# Error handling
task_acks_late = True  # Acknowledge after completion
```

### Queue Scaling

```bash
# Scale YouTube queue (more workers for ingestion)
celery -A tasks worker -Q youtube --concurrency=4

# Scale search queue (fast queries, fewer workers)
celery -A tasks worker -Q search --concurrency=2
```

---

## Integration with menos Core

### Triggering Tasks from FastAPI

```python
from fastapi import APIRouter, BackgroundTasks
from tasks import ingest_youtube, semantic_search

router = APIRouter()

@router.post("/youtube/ingest-async")
async def ingest_youtube_async(url: str):
    """Queue YouTube ingestion for background processing"""
    task = ingest_youtube.delay(url)
    return {"task_id": task.id, "status": "queued"}

@router.get("/tasks/{task_id}")
async def get_task_status(task_id: str):
    """Check task status"""
    from celery.result import AsyncResult
    result = AsyncResult(task_id)
    return {
        "task_id": task_id,
        "status": result.status,
        "result": result.result if result.ready() else None
    }
```

---

## When to Use This

**Use message bus when:**
- Integrating with external workflow tools (N8N, Zapier)
- Long-running tasks that shouldn't block API
- Need rate limiting across multiple processes
- Want task retry/failure handling

**Don't use when:**
- Simple synchronous operations
- Real-time requirements
- Direct API access is sufficient

---

## References

- [Celery Documentation](https://docs.celeryq.dev/)
- [RabbitMQ Tutorials](https://www.rabbitmq.com/tutorials)
- [Flower Monitoring](https://flower.readthedocs.io/)
- `knowledge/specs/ui-roadmap.md` - Web interface that might use these patterns
