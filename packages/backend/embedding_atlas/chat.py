# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

"""Selection-aware chat backend for the Embedding Atlas viewer.

Streams Server-Sent Events to the frontend command palette. Falls back to a
plain echo response when ``claude-agent-sdk`` or ``ANTHROPIC_API_KEY`` is
unavailable, so the wire shape can be exercised end-to-end without an LLM.
"""

import json
import os
import re
from typing import Any, AsyncIterator

import duckdb


SAMPLE_ROW_LIMIT = 10
TEXT_PREVIEW_CHARS = 240


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


def _looks_safe_predicate(predicate: str | None) -> bool:
    if predicate is None:
        return True
    # Predicates come from the viewer's Mosaic crossfilter — they are SQL
    # WHERE-clause fragments. We only inline them into a SELECT we already
    # control. A semicolon would let a malicious caller append a second
    # statement, so reject anything that contains one.
    return ";" not in predicate


def _sample_rows(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    predicate: str | None,
    limit: int = SAMPLE_ROW_LIMIT,
) -> list[dict[str, Any]]:
    if not _looks_safe_predicate(predicate):
        return []
    where = f"WHERE {predicate}" if predicate else ""
    try:
        result = connection.execute(
            f"SELECT * FROM {table} {where} LIMIT {limit}"
        ).fetchdf()
    except Exception:
        return []
    return json.loads(result.to_json(orient="records"))


def _row_count(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    predicate: str | None,
) -> int | None:
    if not _looks_safe_predicate(predicate):
        return None
    where = f"WHERE {predicate}" if predicate else ""
    try:
        (count,) = connection.execute(
            f"SELECT COUNT(*) FROM {table} {where}"
        ).fetchone()
        return int(count)
    except Exception:
        return None


def _truncate(value: Any, limit: int = TEXT_PREVIEW_CHARS) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…"
    return value


def _build_system_prompt(
    predicate: str | None,
    table: str,
    text_column: str | None,
    row_count: int | None,
    sample: list[dict[str, Any]],
) -> str:
    selection_clause = (
        f"WHERE {predicate}" if predicate else "the user has not made a selection"
    )
    count_clause = (
        f"{row_count} rows match the current selection."
        if row_count is not None
        else "Row count unknown."
    )
    text_hint = (
        f"The primary text column is `{text_column}`."
        if text_column
        else "There is no designated text column."
    )
    truncated_sample = [
        {k: _truncate(v) for k, v in row.items()} for row in sample[:SAMPLE_ROW_LIMIT]
    ]
    return (
        "You are an analyst embedded in the Apple Embedding Atlas viewer. "
        "The user is exploring a dataset and has lassoed a region of the "
        "embedding space. Answer their questions by referring to the selection "
        "and, when useful, by calling the `run_sql_query` tool against the "
        f"`{table}` table.\n\n"
        f"Current selection: {selection_clause}.\n"
        f"{count_clause}\n"
        f"{text_hint}\n\n"
        f"Sample rows from the current selection (truncated): "
        f"{json.dumps(truncated_sample)}"
    )


async def _echo_stream(
    messages: list[dict[str, Any]],
    system_prompt: str,
) -> AsyncIterator[bytes]:
    """A stand-in stream used when the Claude Agent SDK is not configured.

    Emits a single delta echoing the latest user message, then a done event.
    Useful for verifying the SSE wiring without an LLM.
    """
    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        "(no user message)",
    )
    yield _sse(
        "delta",
        {
            "text": (
                "Chat backend is not configured (no claude-agent-sdk / "
                "ANTHROPIC_API_KEY). Echo: "
                + (last_user if isinstance(last_user, str) else json.dumps(last_user))
            ),
        },
    )
    yield _sse("done", {"reason": "echo"})


async def _agent_stream(
    messages: list[dict[str, Any]],
    system_prompt: str,
    *,
    mcp_url: str | None,
) -> AsyncIterator[bytes]:
    """Real Claude Agent SDK loop. Lazily imported."""
    from claude_agent_sdk import (  # type: ignore[import-not-found]
        AssistantMessage,
        ClaudeAgentOptions,
        ResultMessage,
        TextBlock,
        ToolResultBlock,
        ToolUseBlock,
        query,
    )

    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    if not isinstance(last_user, str):
        last_user = json.dumps(last_user)

    options_kwargs: dict[str, Any] = {"system_prompt": system_prompt}
    if mcp_url:
        options_kwargs["mcp_servers"] = {
            "embedding-atlas": {"type": "http", "url": mcp_url},
        }
        options_kwargs["allowed_tools"] = ["mcp__embedding-atlas"]

    try:
        async for message in query(
            prompt=last_user,
            options=ClaudeAgentOptions(**options_kwargs),
        ):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text:
                        yield _sse("delta", {"text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        yield _sse(
                            "tool_use",
                            {
                                "id": block.id,
                                "name": block.name,
                                "input": block.input,
                            },
                        )
                    elif isinstance(block, ToolResultBlock):
                        content = block.content
                        if isinstance(content, list):
                            content = "".join(
                                c.get("text", "") if isinstance(c, dict) else str(c)
                                for c in content
                            )
                        yield _sse(
                            "tool_result",
                            {
                                "id": block.tool_use_id,
                                "content": _truncate(content, 1200),
                                "is_error": bool(block.is_error),
                            },
                        )
            elif isinstance(message, ResultMessage):
                yield _sse(
                    "done",
                    {
                        "reason": "stop",
                        "usage": getattr(message, "usage", None),
                    },
                )
                return
    except Exception as exc:  # surface SDK-level failures to the UI
        yield _sse("error", {"message": str(exc)})
        return

    yield _sse("done", {"reason": "stop"})


def _agent_sdk_available() -> bool:
    # The Claude Agent SDK reads `ANTHROPIC_API_KEY`. Accept the shorter
    # `ANTHROPIC_KEY` alias (used by some adjacent projects) and re-export it
    # so the SDK subprocess sees the canonical name.
    if not os.environ.get("ANTHROPIC_API_KEY"):
        alias = os.environ.get("ANTHROPIC_KEY")
        if not alias:
            return False
        os.environ["ANTHROPIC_API_KEY"] = alias
    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError:
        return False
    return True


async def stream_chat(
    body: dict[str, Any],
    *,
    duckdb_connection: duckdb.DuckDBPyConnection | None,
    table: str,
    mcp_url: str | None,
) -> AsyncIterator[bytes]:
    """Drive a chat turn and yield SSE-encoded events."""
    messages = body.get("messages") or []
    context = body.get("context") or {}
    predicate = context.get("predicate")
    text_column = context.get("text_column")

    sample: list[dict[str, Any]] = []
    row_count: int | None = None
    if duckdb_connection is not None:
        sample = _sample_rows(duckdb_connection, table, predicate)
        row_count = _row_count(duckdb_connection, table, predicate)

    system_prompt = _build_system_prompt(
        predicate=predicate,
        table=table,
        text_column=text_column,
        row_count=row_count,
        sample=sample,
    )

    yield _sse(
        "context",
        {"row_count": row_count, "predicate": predicate, "sample_size": len(sample)},
    )

    if _agent_sdk_available():
        async for chunk in _agent_stream(messages, system_prompt, mcp_url=mcp_url):
            yield chunk
    else:
        async for chunk in _echo_stream(messages, system_prompt):
            yield chunk


# Predicates from the frontend look like: x = 1 AND y = 'foo'
# We sanitize them in _looks_safe_predicate, but expose the regex used to
# detect SQL injection attempts for unit tests.
_PREDICATE_INJECTION = re.compile(r";")
