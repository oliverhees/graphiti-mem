# graphiti-mem

Temporal knowledge graph memory plugin for Claude Code. Uses [Graphiti](https://github.com/getzep/graphiti) for temporal knowledge graph operations and [Kuzu](https://kuzudb.com/) as the embedded graph database backend.

## Architecture

```
Claude Code ──hooks──> worker-runner.js ──HTTP──> Python Worker (Graphiti + Kuzu)
                                                       │
                                                       ├── Graphiti (temporal knowledge graph engine)
                                                       └── Kuzu (embedded graph database, no server needed)
```

### Components

- **`plugin/hooks/hooks.json`** — Claude Code hook definitions that trigger at session lifecycle events
- **`scripts/smart-install.js`** — Dependency installer (Node + Python deps), runs on setup and session start
- **`scripts/worker-runner.js`** — Node.js process manager that starts/communicates with the Python worker
- **`worker/`** — Python worker using Graphiti + Kuzu for graph operations
- **`plugin/skills/`** — Claude Code skills for memory search and retrieval

### Data Flow

1. **Session Start** — Worker process starts, loads existing graph from Kuzu, injects relevant context into Claude's session
2. **User Prompt** — Session metadata initialized (timestamp, project context)
3. **Post Tool Use** — Observations captured: file edits, commands run, decisions made are stored as temporal facts
4. **Stop** — Session summarized: key entities, relationships, and decisions extracted and persisted
5. **Session End** — Worker gracefully shuts down, graph state persisted to disk

### Hook Lifecycle

```
Setup          → smart-install.js (install deps)
SessionStart   → smart-install.js → worker start → inject context
UserPrompt     → session-init (metadata)
PostToolUse(*) → observation (capture facts)
Stop           → summarize (extract & persist knowledge)
SessionEnd     → session-complete (cleanup)
```

## Local Development

```bash
# Install dependencies
cd /path/to/graphiti-mem
npm install           # Node dependencies
uv sync               # Python dependencies (worker/)

# Run the worker standalone for testing
cd worker
uv run python -m graphiti_mem.server --port 37778

# Test hooks manually
CLAUDE_PLUGIN_ROOT=$(pwd) node scripts/worker-runner.js start
CLAUDE_PLUGIN_ROOT=$(pwd) node scripts/worker-runner.js hook context
CLAUDE_PLUGIN_ROOT=$(pwd) node scripts/worker-runner.js hook summarize
```

### Port

The Python worker listens on port **37778** by default. Set `GRAPHITI_MEM_PORT` env var to override.

### Graph Storage

Kuzu stores the graph database locally at `~/.graphiti-mem/kuzu_db/`. This directory is created automatically on first run. The graph persists across sessions — that's the whole point.

## Key Design Decisions

- **Kuzu over Neo4j** — Embedded database, zero infrastructure, works offline, fast for single-user workloads
- **Graphiti for temporal modeling** — Time-aware entity and relationship tracking, not just a static graph
- **Node.js worker-runner** — Manages Python process lifecycle, provides HTTP bridge for hooks
- **Hook-based architecture** — Passive observation, no user intervention needed for memory capture
