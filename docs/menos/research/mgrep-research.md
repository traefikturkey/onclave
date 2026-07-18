# mgrep & Self-Hosted Semantic Search Research

## Quick Summary

| Aspect | Details |
|--------|---------|
| **What** | mgrep is a CLI semantic grep tool by Mixedbread AI - natural language search for code/docs |
| **Why** | Traditional grep uses exact pattern matching; mgrep uses embeddings to understand intent |
| **Self-hostable?** | **No** - mgrep itself is cloud-dependent. But alternatives and DIY approaches exist |

---

## mgrep Architecture (What You'd Replicate)

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  CLI Client     │────▶│  Embedding      │────▶│  Vector Store   │
│  (TypeScript)   │     │  Service        │     │  (cloud/local)  │
│                 │     │  (API/Ollama)   │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                               │
        │  Query: "find auth logic"                     │
        │                                               │
        ▼                                               ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  File Watcher   │     │  Reranker       │     │  Search Results │
│  (index sync)   │     │  (optional)     │◀────│  + snippets     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Core Components

1. **Embedding Model** - Converts text/code → vectors
2. **Vector Database** - Stores and searches vectors efficiently
3. **File Indexer** - Chunks files, generates embeddings, maintains sync
4. **Reranker** (optional) - Improves result quality after initial retrieval
5. **CLI Interface** - User-facing query interface

---

## Mixedbread's Open-Source Models (Use These)

Mixedbread releases their models Apache 2.0. You can self-host these:

### Embedding Model: `mxbai-embed-large-v1`

```python
# pip install sentence-transformers

from sentence_transformers import SentenceTransformer

model = SentenceTransformer("mixedbread-ai/mxbai-embed-large-v1")

# For queries, use this prompt template:
query = "Represent this sentence for searching relevant passages: find authentication logic"
docs = ["def login(user, password):", "class AuthService:", "SELECT * FROM users"]

query_embedding = model.encode(query)
doc_embeddings = model.encode(docs)
```

| Property | Value |
|----------|-------|
| Dimensions | 1024 (can reduce via Matryoshka to 512, 256) |
| Parameters | 300M |
| MTEB Score | 64.68 (beats OpenAI text-embedding-3-large) |
| License | Apache 2.0 |
| HF Downloads | 1.4M+/month |

### Reranker: `mxbai-rerank-large-v2`

```python
# pip install transformers

from transformers import AutoModelForSequenceClassification, AutoTokenizer
import torch

tokenizer = AutoTokenizer.from_pretrained("mixedbread-ai/mxbai-rerank-large-v2")
model = AutoModelForSequenceClassification.from_pretrained("mixedbread-ai/mxbai-rerank-large-v2")

query = "find authentication logic"
docs = ["def login(user):", "import os", "class AuthHandler:"]

pairs = [[query, doc] for doc in docs]
inputs = tokenizer(pairs, padding=True, truncation=True, return_tensors="pt")

with torch.no_grad():
    scores = model(**inputs).logits.squeeze()

# Higher score = more relevant
ranked = sorted(zip(docs, scores.tolist()), key=lambda x: -x[1])
```

---

## Self-Hosted Alternatives (Ready to Use)

### 1. **osgrep** - Direct mgrep Alternative

```bash
# Clone and run
git clone https://github.com/Ryandonofrio3/osgrep
cd osgrep
# Follow setup instructions
```

- Built on mgrep's architecture
- Fully open source
- Active development

### 2. **autodev-codebase** - Local with Ollama

```bash
git clone https://github.com/anrgct/autodev-codebase
# Supports Ollama for fully local embeddings
# MCP server integration included
```

- No data leaves your machine
- Works with Claude Code via MCP
- Uses Ollama for local inference

### 3. **semantic-code-search** by Sturdy

```bash
pip install semantic-code-search

# Index your codebase
semgrep index .

# Search
semgrep search "authentication handler"
```

- Simple CLI interface
- Uses sentence-t5 model
- Fully local

---

## Build Your Own (DIY Approach)

### Minimal Stack

| Component | Recommendation | Alternative |
|-----------|----------------|-------------|
| Embedding | `mxbai-embed-large-v1` via Ollama | OpenAI `text-embedding-3-small` |
| Vector DB | Milvus Lite (embedded) | ChromaDB, Weaviate |
| Reranker | `mxbai-rerank-base-v2` | Skip for MVP |
| File Watch | `watchdog` (Python) | `chokidar` (Node) |

### Quick Implementation

```python
# semantic_grep.py
import os
from pathlib import Path
from sentence_transformers import SentenceTransformer
import chromadb

# Setup
model = SentenceTransformer("mixedbread-ai/mxbai-embed-large-v1")
client = chromadb.PersistentClient(path="./.semantic_index")
collection = client.get_or_create_collection("codebase")

def index_file(filepath: str):
    """Chunk and index a single file."""
    content = Path(filepath).read_text()
    # Simple chunking by lines (improve for production)
    chunks = [content[i:i+500] for i in range(0, len(content), 400)]

    for i, chunk in enumerate(chunks):
        chunk_id = f"{filepath}:{i}"
        embedding = model.encode(f"Represent this code: {chunk}").tolist()
        collection.upsert(
            ids=[chunk_id],
            embeddings=[embedding],
            documents=[chunk],
            metadatas=[{"file": filepath, "chunk": i}]
        )

def search(query: str, n_results: int = 5):
    """Semantic search across indexed files."""
    query_embedding = model.encode(
        f"Represent this sentence for searching relevant passages: {query}"
    ).tolist()

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=n_results
    )
    return results

# Usage
if __name__ == "__main__":
    import sys

    if sys.argv[1] == "index":
        for f in Path(".").rglob("*.py"):
            index_file(str(f))
            print(f"Indexed: {f}")
    else:
        query = " ".join(sys.argv[1:])
        for doc, meta in zip(search(query)["documents"][0],
                             search(query)["metadatas"][0]):
            print(f"\n--- {meta['file']}:{meta['chunk']} ---")
            print(doc[:200])
```

### With Ollama (Fully Local)

```python
import ollama
import chromadb

client = chromadb.PersistentClient(path="./.semantic_index")
collection = client.get_or_create_collection("codebase")

def get_embedding(text: str) -> list:
    """Use Ollama's local embedding model."""
    response = ollama.embeddings(
        model="mxbai-embed-large",  # Pull first: ollama pull mxbai-embed-large
        prompt=text
    )
    return response["embedding"]

def index_file(filepath: str):
    content = open(filepath).read()
    chunks = [content[i:i+500] for i in range(0, len(content), 400)]

    for i, chunk in enumerate(chunks):
        embedding = get_embedding(f"Represent this code: {chunk}")
        collection.upsert(
            ids=[f"{filepath}:{i}"],
            embeddings=[embedding],
            documents=[chunk],
            metadatas=[{"file": filepath}]
        )

def search(query: str, n: int = 5):
    embedding = get_embedding(
        f"Represent this sentence for searching relevant passages: {query}"
    )
    return collection.query(query_embeddings=[embedding], n_results=n)
```

```bash
# Setup Ollama
ollama pull mxbai-embed-large

# Run
python semantic_grep.py index
python semantic_grep.py "find error handling"
```

---

## Comparison: mgrep vs Self-Hosted

| Aspect | mgrep (Hosted) | Self-Hosted |
|--------|----------------|-------------|
| Setup time | 5 min | 30 min - 2 hours |
| Privacy | Data sent to Mixedbread | Full control |
| Cost | $20/mo (free tier available) | Compute only |
| Performance | 82ms average | Depends on hardware |
| Multimodal | PDFs, images, code | Code/text (images possible) |
| Maintenance | None | You manage updates |
| MCP integration | Built-in | DIY or use autodev-codebase |

---

## Recommended Path for Self-Hosting

### Option A: Quick Start (Existing Tool)
```bash
# Use autodev-codebase with Ollama
git clone https://github.com/anrgct/autodev-codebase
# Follow their setup - includes MCP server for Claude Code
```

### Option B: Build Custom (More Control)
1. **Start with ChromaDB + mxbai-embed-large** (via Ollama or sentence-transformers)
2. **Add file watcher** for automatic indexing
3. **Add reranker** for quality improvement
4. **Build CLI** around it

### Option C: Production-Grade
1. **Milvus** for vector storage (scales better)
2. **mxbai-embed-large-v1** for embeddings
3. **mxbai-rerank-large-v2** for reranking
4. **FastAPI** service wrapping it all
5. **CLI client** that calls your service

---

## Sources

### Primary
- [mgrep.dev](https://mgrep.dev/) - Official mgrep site
- [github.com/mixedbread-ai/mgrep](https://github.com/mixedbread-ai/mgrep) - mgrep CLI source (Apache 2.0)
- [mixedbread.com](https://www.mixedbread.com/) - Company, API docs, pricing

### Open-Source Models
- [mxbai-embed-large-v1](https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1) - Embedding model
- [mxbai-rerank-large-v2](https://huggingface.co/mixedbread-ai/mxbai-rerank-large-v2) - Reranker

### Self-Hosted Alternatives
- [osgrep](https://github.com/Ryandonofrio3/osgrep) - Open source mgrep alternative
- [autodev-codebase](https://github.com/anrgct/autodev-codebase) - Local with Ollama + MCP
- [semantic-code-search](https://github.com/sturdy-dev/semantic-code-search) - Simple local CLI

### Build Guides
- [OpenAI Cookbook: Code search with embeddings](https://github.com/openai/openai-cookbook/blob/main/examples/Code_search_using_embeddings.ipynb)
- [Milvus: Building Code Context](https://milvus.io/blog/build-open-source-alternative-to-cursor-with-code-context.md)
- [Retool: Embedding search for GitHub](https://retool.com/blog/how-to-build-an-embedding-search-tool-for-github)

### Community
- [HN: Semantic grep with local embeddings](https://news.ycombinator.com/item?id=45157223)
- [HN: mgrep discussion](https://news.ycombinator.com/item?id=45158845)
