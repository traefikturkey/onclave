# UI Layer Roadmap

Specification for a potential web interface layer for menos, enabling chat-based interaction with the content vault.

---

## Vision

A self-hosted chat interface for querying menos content with:
- Conversation history persistence
- Project-based organization
- Semantic search over ingested content
- Multiple model access via API

---

## Implementation Phases

### Phase 1: Conversation History (MVP)

**Goal**: Persist conversations with search and management.

**Features**:
- Persist conversations to backend storage
- Auto-generate conversation titles (LLM summary of first message)
- Left sidebar with conversation list
- Search conversations (title + content)
- New chat button
- Delete/rename conversations

**Technical Considerations**:
- Storage: SQLite or JSON files for simplicity
- Auto-naming: Use cheap/fast model (Haiku) to summarize first user message
- Search: Simple text search initially, vector search later

### Phase 2: Projects

**Goal**: Group conversations and context by project.

**Features**:
- Group conversations into projects
- Per-project custom instructions (override global)
- Per-project file uploads (accessible to all project chats)
- Per-project memory (RAG scoped to project conversations)
- Project settings editable from chat interface

**Technical Considerations**:
- Project file storage in MinIO
- Context optimization: Only load relevant project context
- Lazy load files on mention

### Phase 3: Canvas

**Goal**: Sidebar for document/code editing alongside chat.

**Features**:
- Right sidebar for document/code editing
- Direct editing without copy/paste
- Code-specific shortcuts: review, add logs, add comments, fix bugs, port language
- Writing shortcuts: adjust length, reading level, polish

### Phase 4: Writing Styles

**Goal**: Configurable response styles.

**Features**:
- Style dropdown in chat header (Concise, Detailed, Formal, Technical, Creative)
- Style injection into system prompt
- Custom style text input option
- Persist style per conversation

### Phase 5: Global Memory

**Goal**: Auto-extract and apply learned preferences.

**Features**:
- Auto-extract preferences/facts from conversations
- Inject relevant memories into system prompt
- Memory management UI (view/edit/delete)
- Per-conversation "don't remember" toggle

### Phase 6: Web Search Integration

**Goal**: Real-time web search in responses.

**Features**:
- Web search via existing MCP servers
- Inline citation formatting in responses
- Source verification and linking

### Phase 7: Code Execution Sandbox

**Goal**: Run code snippets safely.

**Features**:
- Docker-based Python sandbox with security limits
- Output capture: stdout, stderr, matplotlib plots, files
- Artifact-style results panel in frontend
- Security: no network, no host filesystem, timeout enforcement

### Phase 8: Image Generation

**Goal**: Generate images from prompts.

**Features**:
- API integration (DALL-E or Stability AI)
- Image library sidebar
- Cost tracking per generation

---

## Technical Architecture

### Backend

```
┌─────────────────────────────────────────┐
│            menos API (FastAPI)          │
├─────────────────────────────────────────┤
│  /api/v1/chat/*      - Conversations    │
│  /api/v1/projects/*  - Project mgmt     │
│  /api/v1/content/*   - Content vault    │
│  /api/v1/search      - Semantic search  │
│  /api/v1/youtube/*   - Video ingestion  │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│           Storage Layer                 │
├─────────────────────────────────────────┤
│  SurrealDB    - Content + conversations │
│  MinIO        - File storage            │
│  Ollama       - Embeddings + summaries  │
└─────────────────────────────────────────┘
```

### Frontend

- WebSocket-based real-time streaming
- Model selector (multiple providers)
- RAG toggle for content search
- Responsive sidebar layout

---

## Storage Options (Phase 1)

| Option | Pros | Cons |
|--------|------|------|
| JSON files | Simple, git-friendly backup | No query capability |
| SQLite | Simple, full-text search | Single file, no concurrent writes |
| SurrealDB | Already have it, full features | Might be overkill for conversations |

**Recommendation**: Use SurrealDB since menos already depends on it.

### Conversation Schema

```surql
DEFINE TABLE conversation SCHEMAFULL;
DEFINE FIELD id ON conversation TYPE string;
DEFINE FIELD title ON conversation TYPE string;
DEFINE FIELD project_id ON conversation TYPE option<record<project>>;
DEFINE FIELD created_at ON conversation TYPE datetime;
DEFINE FIELD updated_at ON conversation TYPE datetime;
DEFINE FIELD style ON conversation TYPE option<string>;
DEFINE FIELD model ON conversation TYPE string;

DEFINE TABLE message SCHEMAFULL;
DEFINE FIELD id ON message TYPE string;
DEFINE FIELD conversation_id ON message TYPE record<conversation>;
DEFINE FIELD role ON message TYPE string;  -- "user", "assistant", "system"
DEFINE FIELD content ON message TYPE string;
DEFINE FIELD created_at ON message TYPE datetime;
DEFINE FIELD metadata ON message TYPE option<object>;

DEFINE INDEX message_conv_idx ON message FIELDS conversation_id;
```

---

## Context Optimization

### Conversation History Loading

- Load last N messages (configurable, default 20)
- Summarize older messages if needed
- Include system prompt + project instructions

### Project Context Loading

- Lazy load files on mention
- Summarize large files before inclusion
- Track which files have been referenced

---

## Integration with menos Core

### Content Search in Chat

```python
# When user asks about content
@router.post("/chat/message")
async def send_message(request: ChatRequest):
    # Check if query relates to content
    if should_search_content(request.message):
        # Search menos content vault
        results = await search_service.semantic_search(
            query=request.message,
            limit=5
        )
        # Include in context
        context = format_search_results(results)
        system_prompt = f"{base_prompt}\n\nRelevant content:\n{context}"

    # Generate response
    response = await llm_service.chat(
        messages=request.messages,
        system_prompt=system_prompt
    )
    return response
```

### RAG Toggle

- When enabled: Always search content vault
- When disabled: Pure chat without content context
- Per-conversation setting

---

## Open Questions

1. **How much conversation history to load in context?** (last N messages + system prompt?)
2. **Project file storage location?** (MinIO bucket per project?)
3. **Memory extraction strategy?** (explicit save vs auto-extract)

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| - | Start with Phase 1 | Get persistent history working first |
| - | Use SurrealDB for storage | Already in stack, full-featured |
| - | Memory = auto-extract | More seamless than explicit save |
| - | Code sandbox = Docker | More powerful than browser-based |

---

## Priority Notes

This UI layer is **lower priority** than:
1. Core content ingestion (Phase 4 - complete)
2. Agentic search capabilities (Phase 5 - planned)

The UI provides a nice interaction layer but the API-first approach means menos is useful without it via CLI or direct API calls.
