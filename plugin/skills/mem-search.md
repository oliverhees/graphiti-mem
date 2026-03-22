---
name: mem-search
description: Search graphiti-mem temporal knowledge graph for entities, relationships, and historical facts
triggers: ["search memory", "what did we do", "find in memory", "recall", "remember"]
---

# Memory Search — graphiti-mem

Search the temporal knowledge graph for entities, relationships, and time-aware facts stored across sessions.

## Available MCP Tools

### `search_memory`

Full-text semantic search across all stored knowledge.

```
search_memory({ query: "authentication refactor decisions" })
search_memory({ query: "what database did we choose", time_range: "last_week" })
```

**Parameters:**
- `query` (string, required) — Natural language search query
- `time_range` (string, optional) — Filter by time: "today", "last_week", "last_month", or ISO date range
- `limit` (number, optional) — Max results to return (default: 10)

### `get_entities`

Retrieve specific entities (people, projects, technologies, concepts) from the graph.

```
get_entities({ type: "project" })
get_entities({ name: "ALICE" })
get_entities({ type: "technology", related_to: "authentication" })
```

**Parameters:**
- `type` (string, optional) — Entity type filter: "project", "person", "technology", "concept", "decision"
- `name` (string, optional) — Exact or partial name match
- `related_to` (string, optional) — Find entities related to this term

### `get_relationships`

Explore connections between entities in the knowledge graph.

```
get_relationships({ source: "ALICE", type: "uses" })
get_relationships({ target: "Kuzu", type: "depends_on" })
```

**Parameters:**
- `source` (string, optional) — Source entity name
- `target` (string, optional) — Target entity name
- `type` (string, optional) — Relationship type: "uses", "depends_on", "decided", "created", "modified"

### `get_timeline`

View chronological history of events, decisions, and changes.

```
get_timeline({ entity: "auth-service", range: "last_month" })
get_timeline({ type: "decision", range: "2024-01-01/2024-03-01" })
```

**Parameters:**
- `entity` (string, optional) — Filter timeline to specific entity
- `type` (string, optional) — Event type: "decision", "change", "observation", "milestone"
- `range` (string, optional) — Time range filter

## Usage Patterns

**Recall past decisions:**
> "Search memory for why we chose Kuzu over Neo4j"

**Find project context:**
> "What entities are related to the auth refactor?"

**Review timeline:**
> "Show me the timeline of changes to the API layer this month"

**Discover relationships:**
> "What technologies does the ALICE project depend on?"

## Tips

- Use natural language queries with `search_memory` for broad searches
- Use `get_entities` and `get_relationships` for structured graph traversal
- Use `get_timeline` to understand the chronological evolution of decisions
- Combine tools: first search broadly, then drill into specific entities and relationships
- Time-aware queries leverage Graphiti's temporal indexing for accurate historical recall
