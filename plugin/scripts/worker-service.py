"""
graphiti-mem Worker Service
===========================
FastAPI HTTP service managing Graphiti knowledge graphs with Kuzu as embedded backend.
Runs on port 37778, one graph instance per project (identified by SHA256 hash of project path).
"""

import hashlib
import logging
import os
import signal
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from graphiti_core import Graphiti
from graphiti_core.driver.kuzu_driver import KuzuDriver
from graphiti_core.llm_client import LLMConfig
from graphiti_core.embedder.voyage import VoyageAIEmbedder, VoyageAIEmbedderConfig

# ClaudeCodeLLMClient lives next to this file
import sys as _sys
import pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).parent))
from claude_code_llm_client import ClaudeCodeLLMClient

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
logger = logging.getLogger("graphiti-mem")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
WORKER_PORT = 37778
BASE_DIR = Path.home() / ".graphiti-mem"
PID_PATH = BASE_DIR / "worker.pid"
VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# Graphiti instance cache: project_id -> Graphiti
# ---------------------------------------------------------------------------
_graphiti_cache: dict[str, Graphiti] = {}
_initialized_projects: set[str] = set()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def project_id_from_path(project_path: str) -> str:
    """Derive a short project ID from the absolute project path (first 8 chars of SHA256)."""
    return hashlib.sha256(project_path.encode()).hexdigest()[:8]


def _db_path(project_id: str) -> Path:
    """Return the Kuzu database directory for a given project_id."""
    db_dir = BASE_DIR / "projects" / project_id
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir


def _build_llm_client() -> ClaudeCodeLLMClient:
    """Create the LLM client for Graphiti entity/relationship extraction.

    Uses ClaudeCodeLLMClient which proxies through the `claude` CLI —
    no ANTHROPIC_API_KEY needed, reuses Claude Code's existing authentication.
    """
    return ClaudeCodeLLMClient(config=LLMConfig())


def _build_embedder() -> VoyageAIEmbedder:
    """Create the embedder for semantic search in Graphiti.

    Uses Voyage AI embeddings (voyage-3) — Anthropic's recommended embedding
    partner for Claude-based applications.

    Set VOYAGE_API_KEY in environment.
    Free tier: 50M tokens/month. Get key at https://dash.voyageai.com/
    """
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "VOYAGE_API_KEY environment variable is required for embeddings. "
            "Get a free key at https://dash.voyageai.com/ (50M tokens/month free)"
        )
    return VoyageAIEmbedder(config=VoyageAIEmbedderConfig(api_key=api_key))


async def _get_graphiti(project_id: str) -> Graphiti:
    """Return a cached Graphiti instance for the project, creating one if needed."""
    if project_id in _graphiti_cache:
        return _graphiti_cache[project_id]

    db_dir = _db_path(project_id)
    logger.info("Creating Graphiti instance for project %s at %s", project_id, db_dir)

    kuzu_driver = KuzuDriver(db=str(db_dir))
    llm_client = _build_llm_client()
    embedder = _build_embedder()

    graphiti = Graphiti(
        graph_driver=kuzu_driver,
        llm_client=llm_client,
        embedder=embedder,
    )

    # Build indices and constraints on first access
    if project_id not in _initialized_projects:
        try:
            await graphiti.build_indices_and_constraints()
            _initialized_projects.add(project_id)
            logger.info("Indices and constraints built for project %s", project_id)
        except Exception as exc:
            logger.warning("Could not build indices for project %s: %s", project_id, exc)

    _graphiti_cache[project_id] = graphiti
    return graphiti


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class EpisodeRequest(BaseModel):
    project_id: str
    name: str
    content: str
    source: str = "tool_use"
    source_description: str = ""


class SearchRequest(BaseModel):
    project_id: str
    query: str
    num_results: int = Field(default=10, ge=1, le=100)


class FactResponse(BaseModel):
    uuid: str
    fact: str
    valid_at: str | None = None
    invalid_at: str | None = None
    source_description: str = ""


class SearchResponse(BaseModel):
    facts: list[FactResponse]


class EntityResponse(BaseModel):
    name: str
    summary: str = ""
    created_at: str | None = None


class RelationshipResponse(BaseModel):
    source: str
    target: str
    fact: str
    valid_at: str | None = None


class TimelineEpisode(BaseModel):
    name: str
    source_description: str = ""
    created_at: str | None = None
    entities: list[str] = []


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = VERSION


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Write PID file on startup, clean up on shutdown."""
    PID_PATH.parent.mkdir(parents=True, exist_ok=True)
    PID_PATH.write_text(str(os.getpid()))
    logger.info("Worker started (PID %d), listening on port %d", os.getpid(), WORKER_PORT)

    yield

    # Cleanup: close all graphiti instances
    for pid, graphiti in _graphiti_cache.items():
        try:
            await graphiti.close()
        except Exception:
            pass
    _graphiti_cache.clear()

    PID_PATH.unlink(missing_ok=True)
    logger.info("Worker shutting down, PID file removed")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="graphiti-mem Worker",
    version=VERSION,
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint."""
    return HealthResponse()


@app.post("/episodes")
async def add_episode(req: EpisodeRequest):
    """Add a new episode (observation) to the project's knowledge graph."""
    try:
        graphiti = await _get_graphiti(req.project_id)

        now = datetime.now(timezone.utc)

        await graphiti.add_episode(
            name=req.name,
            episode_body=req.content,
            source_description=req.source_description or req.source,
            reference_time=now,
        )

        logger.info(
            "Episode added for project %s: %s (%d chars)",
            req.project_id,
            req.name,
            len(req.content),
        )

        return {
            "status": "ok",
            "project_id": req.project_id,
            "name": req.name,
            "timestamp": now.isoformat(),
        }

    except Exception as exc:
        logger.error("Failed to add episode: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest):
    """Search the knowledge graph for relevant facts."""
    try:
        graphiti = await _get_graphiti(req.project_id)

        results = await graphiti.search(
            query=req.query,
            num_results=req.num_results,
        )

        facts = []
        for edge in results:
            facts.append(
                FactResponse(
                    uuid=str(getattr(edge, "uuid", "")),
                    fact=getattr(edge, "fact", str(edge)),
                    valid_at=_format_dt(getattr(edge, "valid_at", None)),
                    invalid_at=_format_dt(getattr(edge, "invalid_at", None)),
                    source_description=getattr(edge, "source_description", ""),
                )
            )

        return SearchResponse(facts=facts)

    except Exception as exc:
        logger.error("Search failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/entities/{project_id}")
async def list_entities(project_id: str):
    """List recent entities in the project's knowledge graph."""
    try:
        graphiti = await _get_graphiti(project_id)

        # Retrieve entities via the graph driver
        entities: list[dict[str, Any]] = []
        try:
            result = await graphiti.get_nodes()
            for node in result:
                entities.append(
                    {
                        "name": getattr(node, "name", str(node)),
                        "summary": getattr(node, "summary", ""),
                        "created_at": _format_dt(getattr(node, "created_at", None)),
                    }
                )
        except Exception as inner_exc:
            logger.warning("Could not retrieve entities: %s", inner_exc)

        return {"entities": entities}

    except Exception as exc:
        logger.error("Failed to list entities: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/relationships/{project_id}")
async def list_relationships(project_id: str):
    """List relationships (edges/facts) in the project's knowledge graph."""
    try:
        graphiti = await _get_graphiti(project_id)

        relationships: list[dict[str, Any]] = []
        try:
            result = await graphiti.get_edges()
            for edge in result:
                relationships.append(
                    {
                        "source": getattr(edge, "source_node_name", ""),
                        "target": getattr(edge, "target_node_name", ""),
                        "fact": getattr(edge, "fact", str(edge)),
                        "valid_at": _format_dt(getattr(edge, "valid_at", None)),
                    }
                )
        except Exception as inner_exc:
            logger.warning("Could not retrieve relationships: %s", inner_exc)

        return {"relationships": relationships}

    except Exception as exc:
        logger.error("Failed to list relationships: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/timeline/{project_id}")
async def timeline(project_id: str, limit: int = Query(default=20, ge=1, le=100)):
    """Return recent episodes (timeline) for the project."""
    try:
        graphiti = await _get_graphiti(project_id)

        episodes: list[dict[str, Any]] = []
        try:
            result = await graphiti.get_episodes(limit=limit)
            for ep in result:
                entities_list: list[str] = []
                # Episodes may reference entity names
                if hasattr(ep, "entity_edges"):
                    entities_list = [
                        getattr(e, "name", str(e)) for e in ep.entity_edges
                    ]
                elif hasattr(ep, "entities"):
                    entities_list = [
                        getattr(e, "name", str(e)) for e in ep.entities
                    ]

                episodes.append(
                    {
                        "name": getattr(ep, "name", ""),
                        "source_description": getattr(ep, "source_description", ""),
                        "created_at": _format_dt(getattr(ep, "created_at", None)),
                        "entities": entities_list,
                    }
                )
        except Exception as inner_exc:
            logger.warning("Could not retrieve timeline: %s", inner_exc)

        return {"episodes": episodes}

    except Exception as exc:
        logger.error("Failed to get timeline: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


class LearnRequest(BaseModel):
    project_id: str
    project_name: str
    session_summary: str          # Full text of what happened this session
    tool_count: int = 0
    compact_context: str = ""     # Non-empty when called from compact hook


class CompactRequest(BaseModel):
    project_id: str
    project_name: str
    compact_text: str             # The compacted context from Claude


@app.post("/learn")
async def extract_learnings(req: LearnRequest):
    """
    NLP learning extraction — called at session end (Stop hook) and after compact.

    Stores the session as a rich Graphiti episode. Graphiti's LLM pipeline
    automatically extracts:
      - Entities (files, functions, bugs, people, projects)
      - Relationships between entities
      - Temporal facts with timestamps
      - Contradictions → auto-invalidation of outdated facts

    This is the core of the permanent learning system.
    """
    try:
        graphiti = await _get_graphiti(req.project_id)
        now = datetime.now(timezone.utc)

        # Build structured episode content for maximum NLP extraction
        episode_parts = [
            f"Project: {req.project_name}",
            f"Session date: {now.strftime('%Y-%m-%d %H:%M UTC')}",
            f"Tools used: {req.tool_count}",
            "",
            "=== SESSION SUMMARY ===",
            req.session_summary,
        ]

        if req.compact_context:
            episode_parts += [
                "",
                "=== COMPACT CONTEXT (preserved before compression) ===",
                req.compact_context,
            ]

        episode_body = "\n".join(episode_parts)

        await graphiti.add_episode(
            name=f"Session learning — {req.project_name} — {now.strftime('%Y-%m-%d')}",
            episode_body=episode_body,
            source_description=f"Automatic NLP learning extraction for project {req.project_name}",
            reference_time=now,
        )

        logger.info(
            "Learning episode added for project %s (%d chars, %d tools)",
            req.project_id,
            len(episode_body),
            req.tool_count,
        )

        return {
            "status": "ok",
            "project_id": req.project_id,
            "episode_size": len(episode_body),
            "timestamp": now.isoformat(),
        }

    except Exception as exc:
        logger.error("Learning extraction failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/compact")
async def handle_compact(req: CompactRequest):
    """
    Called when Claude Code compacts context (SessionStart with 'compact' trigger).

    Saves the entire compacted context as a Graphiti episode BEFORE the context
    is lost — ensuring zero knowledge loss through compaction events.
    Graphiti's LLM automatically extracts entities and relationships from the
    compact text and builds/updates the temporal knowledge graph.
    """
    try:
        graphiti = await _get_graphiti(req.project_id)
        now = datetime.now(timezone.utc)

        episode_body = (
            f"Project: {req.project_name}\n"
            f"Compact date: {now.strftime('%Y-%m-%d %H:%M UTC')}\n\n"
            "=== COMPACTED CONTEXT ===\n"
            f"{req.compact_text}"
        )

        await graphiti.add_episode(
            name=f"Compact — {req.project_name} — {now.strftime('%Y-%m-%d %H:%M')}",
            episode_body=episode_body,
            source_description=f"Context compaction snapshot for project {req.project_name}",
            reference_time=now,
        )

        logger.info(
            "Compact episode saved for project %s (%d chars)",
            req.project_id,
            len(req.compact_text),
        )

        return {
            "status": "ok",
            "project_id": req.project_id,
            "compact_size": len(req.compact_text),
            "timestamp": now.isoformat(),
        }

    except Exception as exc:
        logger.error("Compact handling failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


class SessionRequest(BaseModel):
    project_id: str
    project_name: str
    action: str = "init"          # "init" or "complete"
    cwd: str = ""
    completed_at: str = ""


@app.post("/session")
async def handle_session(req: SessionRequest):
    """Track session lifecycle (init / complete). Lightweight — no graph writes."""
    logger.info(
        "Session %s for project %s (%s)",
        req.action,
        req.project_name,
        req.project_id,
    )
    return {"status": "ok", "action": req.action, "project_id": req.project_id}


@app.post("/shutdown")
async def shutdown():
    """Graceful shutdown of the worker service."""
    logger.info("Shutdown requested via API")

    # Schedule shutdown after response is sent
    import asyncio

    async def _do_shutdown():
        await asyncio.sleep(0.5)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_do_shutdown())

    return {"status": "shutting_down"}


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _format_dt(dt: Any) -> str | None:
    """Safely format a datetime-like value to ISO string."""
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.isoformat()
    if isinstance(dt, str):
        return dt
    return str(dt)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=WORKER_PORT,
        log_level="info",
        timeout_keep_alive=300,
    )
