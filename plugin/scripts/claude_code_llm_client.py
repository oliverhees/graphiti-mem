"""
ClaudeCodeLLMClient
===================
A Graphiti LLMClient that proxies all LLM calls through the `claude` CLI
(Claude Code SDK), using Claude Code's existing authentication.

This means graphiti-mem requires ZERO additional API keys for LLM extraction —
it reuses the Claude Code session the user is already running.

Usage:
    from claude_code_llm_client import ClaudeCodeLLMClient
    client = ClaudeCodeLLMClient()
"""

import asyncio
import json
import logging
import shutil
import subprocess
from typing import Any

from pydantic import BaseModel
from graphiti_core.llm_client.client import LLMClient, LLMConfig, ModelSize, Message
from graphiti_core.cross_encoder.client import CrossEncoderClient

logger = logging.getLogger(__name__)

# Timeout for claude CLI calls (seconds)
_CLI_TIMEOUT = 60

# System prompt that instructs Claude to return JSON matching the response model
_SYSTEM_PROMPT = (
    "You are a precise data extraction assistant. "
    "When given a JSON schema, respond ONLY with valid JSON matching that schema. "
    "Do not include explanations, markdown, or any text outside the JSON object."
)


def _find_claude_cli() -> str:
    """Locate the claude binary."""
    path = shutil.which("claude")
    if path:
        return path
    # Common fallback locations
    for candidate in [
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ]:
        if shutil.which(candidate):
            return candidate
    raise RuntimeError(
        "claude CLI not found in PATH. "
        "graphiti-mem requires Claude Code to be installed. "
        "Install from: https://claude.ai/download"
    )


def _messages_to_prompt(messages: list[Message]) -> str:
    """Convert a list of graphiti Message objects to a single prompt string."""
    parts = []
    for msg in messages:
        role = getattr(msg, "role", "user")
        content = getattr(msg, "content", str(msg))
        if role == "system":
            parts.append(f"[SYSTEM]\n{content}")
        elif role == "assistant":
            parts.append(f"[ASSISTANT]\n{content}")
        else:
            parts.append(content)
    return "\n\n".join(parts)


def _build_prompt_with_schema(messages: list[Message], response_model: type[BaseModel] | None) -> str:
    """Build the full prompt, optionally including the JSON schema."""
    base = _messages_to_prompt(messages)
    if response_model is None:
        return base

    try:
        schema = json.dumps(response_model.model_json_schema(), indent=2)
        return (
            f"{base}\n\n"
            f"Respond ONLY with a JSON object matching this schema:\n"
            f"```json\n{schema}\n```"
        )
    except Exception:
        return base


async def _run_claude_cli(prompt: str, system: str = _SYSTEM_PROMPT) -> str:
    """Run the claude CLI and return its stdout."""
    claude_path = _find_claude_cli()

    cmd = [
        claude_path,
        "--print",                           # non-interactive / one-shot mode
        "--output-format", "text",           # plain text output
        "--append-system-prompt", system,    # inject JSON extraction instructions
        prompt,
    ]

    loop = asyncio.get_event_loop()

    def _run() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_CLI_TIMEOUT,
        )

    try:
        result = await loop.run_in_executor(None, _run)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"claude CLI timed out after {_CLI_TIMEOUT}s")

    if result.returncode != 0:
        stderr = result.stderr.strip()
        raise RuntimeError(
            f"claude CLI exited with code {result.returncode}: {stderr}"
        )

    return result.stdout.strip()


def _extract_json(text: str) -> dict[str, Any]:
    """Extract a JSON object from the claude CLI response."""
    # Strip markdown code fences if present
    cleaned = text.strip()
    for fence in ["```json", "```"]:
        if cleaned.startswith(fence):
            cleaned = cleaned[len(fence):]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Try to find first {...} block
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1:
            try:
                return json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError:
                pass
        # Return as plain text wrapped in dict if all else fails
        logger.warning("Could not parse JSON from claude CLI response, wrapping as text")
        return {"content": cleaned}


class NullCrossEncoder(CrossEncoderClient):
    """No-op cross-encoder — returns passages with uniform scores.

    Avoids the OpenAI dependency that Graphiti's default reranker requires.
    Search results are returned in their original embedding-similarity order.
    """

    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        return [(p, 1.0) for p in passages]


class ClaudeCodeLLMClient(LLMClient):
    """
    Graphiti LLMClient that uses the `claude` CLI for all LLM calls.

    Requires no API key — uses Claude Code's existing authentication.
    Works transparently as a drop-in replacement for AnthropicClient.
    """

    def __init__(self, config: LLMConfig | None = None) -> None:
        super().__init__(config=config or LLMConfig())
        # Verify claude is available at startup
        _find_claude_cli()
        logger.info("ClaudeCodeLLMClient initialized — using `claude` CLI for LLM calls")

    async def _generate_response(
        self,
        messages: list[Message],
        response_model: type[BaseModel] | None = None,
        max_tokens: int = 8192,
        model_size: ModelSize = ModelSize.medium,
    ) -> dict[str, Any]:
        """Generate a response by calling the claude CLI."""
        prompt = _build_prompt_with_schema(messages, response_model)

        logger.debug(
            "Calling claude CLI (model_size=%s, has_schema=%s, prompt_len=%d)",
            model_size,
            response_model is not None,
            len(prompt),
        )

        try:
            raw_output = await _run_claude_cli(prompt)
        except Exception as exc:
            logger.error("claude CLI call failed: %s", exc)
            raise

        if response_model is not None:
            return _extract_json(raw_output)

        return {"content": raw_output}
