# Nested Agent Deadlock: Critical Lesson

**Status**: CRITICAL - Must inform any agentic architecture in menos Phase 5

## TL;DR

**DO NOT call agents-with-tools from within another agent's tool.** This causes event loop deadlocks in Pydantic AI (and likely other async agent frameworks).

## The Problem

### What Causes the Deadlock

When you call an agent that has its own tools from within another agent's tool function, you create nested event loops that deadlock:

```python
# THIS WILL DEADLOCK
@coordinator.tool
def call_youtube_agent(url: str) -> str:
    # youtube_agent has @agent.tool decorators
    result = youtube_agent.run_sync(f"Tag this: {url}")
    return result.output  # Never returns, hangs forever
```

### Why It Happens

1. **Outer agent** (coordinator) calls a tool (`call_youtube_agent`)
2. **Outer event loop** waits for the tool to complete
3. **Inside the tool**, you invoke an inner agent (`youtube_agent.run_sync()`)
4. **Inner agent** decides it needs to call its own tool (`get_transcript`)
5. **Inner agent** tries to execute the tool, which needs an event loop
6. **Deadlock**:
   - Outer event loop is blocked waiting for the tool to return
   - Inner agent is blocked waiting for its tool to execute
   - Inner tool can't execute because the event loop is already occupied
   - Nobody can proceed

### Call Stack When Deadlock Occurs

```
User Request
  └─> Coordinator Agent
      └─> @coordinator.tool call_subagent()
          [Event loop WAITING for tool to complete]
          └─> sub_agent.run_sync()
              └─> Sub-agent decides to call @agent.tool
                  [Tries to use event loop but it's BLOCKED]
                  └─> DEADLOCK
```

## Solutions

### Solution 1: Direct Function Calls (Simplest)

Import and call the underlying functions directly, then create a tool-less agent just for LLM reasoning:

```python
# Import functions, NOT agents
from content_processor.tools import get_transcript, get_metadata
from content_processor.prompts import TAGGING_SYSTEM_PROMPT


async def process_content(ctx: RunContext, content_type: str, url: str):
    if content_type == "youtube":
        # Call functions directly
        metadata = get_metadata(url)
        transcript = get_transcript(url)[:5000]

        # Create tool-less agent just for LLM reasoning
        reasoning_agent = Agent(
            model=model,
            system_prompt=TAGGING_SYSTEM_PROMPT,
            # NO TOOLS - just reasoning
        )

        result = await reasoning_agent.run(
            f"Analyze this video and generate tags:\n{metadata}\n{transcript}",
            usage=ctx.usage,
        )

        return {"tags": parse_tags(result.output)}
```

**Pros**:
- Works immediately (proven pattern)
- No deadlock risk
- Straightforward implementation

**Cons**:
- Hardcoded per content type
- Loses modularity
- Manual coordination of tool calls

### Solution 2: Tool-less Sub-Agents (Best Architecture)

Move ALL tools to the coordinator level. Sub-agents become pure reasoning modules with no tools:

```python
# Coordinator has ALL the tools
@coordinator.tool
async def fetch_content_data(url: str) -> Dict[str, Any]:
    """Fetch content data - coordinator controls all data fetching"""
    metadata = get_metadata(url)
    transcript = get_transcript(url)
    return {"url": url, "title": metadata["title"], "transcript": transcript}


@coordinator.tool
async def reason_about_content(data: Dict[str, Any]) -> Dict[str, Any]:
    """Use content reasoner - tool-less agent, just LLM reasoning"""

    # Call tool-less sub-agent (NO deadlock risk)
    result = await content_reasoner.run(
        f"Analyze this content and generate tags:\n{data}",
        usage=ctx.usage,
    )

    return {"tags": parse_tags(result.output)}


# Sub-agents have NO tools - pure reasoning
content_reasoner = Agent(
    model="anthropic:claude-3-5-haiku",
    system_prompt=CONTENT_TAGGING_PROMPT,
    # NO @agent.tool decorators
)
```

**Workflow**:
1. Coordinator fetches data with its own tools
2. Coordinator stores data (in memory, database, etc.)
3. Coordinator calls tool-less sub-agent for specialized reasoning
4. Sub-agent returns result (no tools to call, no deadlock)

**Pros**:
- No deadlock risk
- Clean separation: coordinator controls data, sub-agents provide reasoning
- Scalable architecture
- Can still have multiple specialized "agents"
- Testable: can test reasoning independently

**Cons**:
- Requires designing agents with this constraint in mind
- Coordinator has more responsibility

### Solution 3: Message Queue / Task System (Overkill for Most Cases)

Run sub-agents in separate processes with their own event loops, communicate via message queues.

**Don't use this** unless you have a genuine need for distributed processing. It's massive architectural overhead.

## Architectural Principles

### Rule 1: No Nested Agent-with-Tools Calls

**Never** call an agent that has `@agent.tool` decorators from within another agent's tool.

```python
# BAD
@outer_agent.tool
def my_tool():
    result = inner_agent_with_tools.run_sync(...)  # DEADLOCK
    return result.data

# GOOD
@outer_agent.tool
def my_tool():
    result = inner_agent_no_tools.run_sync(...)  # Safe
    return result.data
```

### Rule 2: Separation of Data and Reasoning

**Good architecture**: Separate data fetching from reasoning.

- **Coordinator**: Controls all data fetching (has data tools)
- **Sub-agents**: Pure reasoning modules (no data tools)

```python
# Clean separation
@coordinator.tool
def fetch_data(source: str) -> dict:
    """Coordinator fetches data"""
    return fetch_impl(source)


@coordinator.tool
def analyze_data(data: dict) -> str:
    """Coordinator delegates reasoning to tool-less agent"""
    return analyzer_agent.run_sync(data)  # analyzer_agent has NO tools


# Tool-less reasoning agent
analyzer_agent = Agent(
    model='anthropic:claude-3-5-haiku',
    system_prompt="Analyze this data...",
    # NO TOOLS
)
```

### Rule 3: Use Direct Functions When Needed

If you need to call existing agents' functionality, import their underlying functions:

```python
# Import functions, not agents
from content_services import get_transcript, get_metadata, fetch_webpage

# Call directly
transcript = get_transcript(url)
webpage = fetch_webpage(url)
```

## Why Async Doesn't Help

Some might think using `async`/`await` differently would solve this. It doesn't.

**The problem is structural**, not about how you call the functions:

```python
# Still deadlocks
@coordinator.tool
async def my_tool():
    result = await inner_agent_with_tools.run(...)  # DEADLOCK
    return result.output

# Still deadlocks
@coordinator.tool
def my_tool():
    result = inner_agent_with_tools.run_sync(...)  # DEADLOCK
    return result.output
```

**The only solution**: Don't call agents-with-tools from within another agent's tool.

## Application to menos Phase 5

When designing the agentic search capability for menos:

1. **Content fetching** (YouTube API, SurrealDB queries, MinIO retrieval) should be coordinator-level tools
2. **Reasoning agents** (summarization, tagging, recommendation logic) should be tool-less
3. **The coordinator** orchestrates: fetch data → store in working memory → invoke reasoning → return results

This aligns with the Recursive Language Model (RLM) pattern validated academically - see `knowledge/research/recursive-language-models.md`.

## Recommendations

### For New Projects (like menos Phase 5)

**Use Solution 2 (Tool-less Sub-Agents)**:
- Clean architecture
- Scalable to many sub-agents
- No deadlock risk
- Clear separation of concerns

### For Quick Prototypes

**Use Solution 1 (Direct Calls)**:
- Fast to implement
- Works with existing code
- Proven pattern

### For Production

**Use Solution 2** with additional hardening:
- Error handling
- Retry logic
- Observability
- Rate limiting

## References

- [Pydantic AI Documentation](https://ai.pydantic.dev/)
- [Anthropic: Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Recursive Language Models paper (arXiv 2512.24601) - validates this architectural pattern

---

**Status**: Validated through implementation testing
**Applicability**: Universal for async agent frameworks
