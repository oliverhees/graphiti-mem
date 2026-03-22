# graphiti-mem

**Temporal Knowledge Graph Memory for Claude Code**

graphiti-mem gives Claude Code a persistent, growing brain. Unlike simple RAG-based memory, it uses [Graphiti](https://github.com/getzep/graphiti) to build a **temporal knowledge graph** — tracking entities, relationships, and how facts change over time.

## Why graphiti-mem?

| Feature | claude-mem (RAG) | graphiti-mem (Knowledge Graph) |
|---------|-----------------|-------------------------------|
| Storage | SQLite + ChromaDB | Kuzu (embedded graph DB) |
| Memory type | Flat text vectors | Entities + relationships + timestamps |
| Context loss on compact | ✗ Lost | ✓ Saved as episode |
| Contradiction handling | ✗ Duplicate facts | ✓ Auto-invalidated |
| "What changed?" | ✗ No | ✓ Temporal tracking |
| Server required | Worker (Bun) | Worker (Python/FastAPI) |
| External DB server | ✗ None | ✓ None (Kuzu embedded) |

## How It Works

```
Tool Output → PostToolUse Hook → Python Worker (port 37778)
                               → Graphiti.add_episode()
                               → Kuzu Graph DB (NLP entity extraction)

Session Compact → SessionStart(compact) Hook → /compact endpoint
                → Full context saved as episode → Zero knowledge loss

Session Start → SessionStart Hook → /search + /entities + /timeline
             → Relevant context injected as system-reminder

Session End → Stop Hook → /learn endpoint
           → NLP extraction of learnings, decisions, preferences
```

Every interaction makes the graph richer. Graphiti's LLM pipeline automatically extracts:
- **Entities**: files, functions, bugs, people, projects, tools
- **Relationships**: "auth.ts USES jwt", "bug fixed IN user-service"
- **Temporal facts**: "API endpoint changed from GET to POST on 2026-03-22"
- **Contradictions**: old facts auto-invalidated when superseded

## Requirements

- Node.js >= 18
- [uv](https://docs.astral.sh/uv/) (auto-installed)
- `ANTHROPIC_API_KEY` — for NLP entity/relationship extraction
- `OPENAI_API_KEY` — for semantic embeddings (text-embedding-3-small)

## Installation

**Via Claude Code Plugin Marketplace:**
```
/plugin marketplace add oliverbenns/graphiti-mem
/plugin install graphiti-mem
```

**One-line installer:**
```bash
curl -sSf https://graphiti-mem.dev/install.sh | bash
```

## Architecture

```
graphiti-mem/
├── .claude-plugin/
│   ├── plugin.json           # Plugin manifest
│   └── marketplace.json      # Marketplace registration
├── plugin/
│   ├── hooks/hooks.json      # 6 lifecycle hooks
│   ├── scripts/
│   │   ├── worker-service.py # FastAPI + Graphiti + Kuzu (7 endpoints)
│   │   ├── worker-runner.js  # Hook bridge (Node.js → Python worker)
│   │   ├── smart-install.js  # Dependency check on setup
│   │   └── mcp-server.js     # 4 MCP tools for on-demand queries
│   └── skills/
│       └── mem-search.md     # Memory search skill
└── installer/                # Interactive CLI installer
```

## Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| Setup | Plugin install | Check/install dependencies |
| SessionStart (startup/clear) | New session | Start worker, inject context |
| SessionStart (compact) | After compaction | **Save compact context**, inject context |
| UserPromptSubmit | Every prompt | Ensure worker is alive |
| PostToolUse | After every tool | Capture observation as episode |
| Stop | Session end | Full NLP learning extraction |
| SessionEnd | Final cleanup | Log session completion |

## MCP Tools

Available directly in Claude:

- `search_memory` — semantic + keyword search across all facts
- `get_entities` — list entities for current project
- `get_relationships` — show entity relationships
- `get_timeline` — chronological activity view

## Data Storage

All data is stored locally in `~/.graphiti-mem/`:
```
~/.graphiti-mem/
├── venv/                    # Python virtual environment
├── projects/
│   ├── a1b2c3d4/           # Project by path hash
│   │   └── [Kuzu DB files]
│   └── e5f6g7h8/
├── worker.pid               # Running worker PID
└── worker.log               # Worker logs
```

Each project gets an isolated namespace — memories never cross project boundaries.

## License

MIT
