# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

"""Selection-aware chat backend for the Embedding Atlas viewer.

Two implementations live behind a single SSE event schema:

  - "direct" (default): calls the Anthropic Messages API directly with token
    streaming and a single built-in `run_sql_query` tool against the local
    DuckDB connection. Fast (~2s first-token latency) and cheap.

  - "agent": delegates to the Python Claude Agent SDK, which shells out to
    the `claude` CLI and inherits Claude Code's full MCP tool surface
    (chart/layout CRUD, screenshots, etc). Slower first turn (~10–15s) but
    can drive the whole UI.

Both paths fall back to a deterministic echo stream when neither
`anthropic` nor `claude-agent-sdk` is installed (or when no API key is
present), so the wire shape can be exercised end-to-end without any LLM.
"""

import json
import os
from typing import Any, AsyncIterator, Literal

import duckdb


SAMPLE_ROW_LIMIT = 10
TEXT_PREVIEW_CHARS = 240
MAX_TOOL_ITERATIONS = 5
TOOL_RESULT_TRUNCATE = 8000
# Drop array columns longer than this from the sample. Embedding columns
# (e.g. 1024-dim vectors) blow up the system prompt past the model's context
# window if included raw, and they aren't useful for an LLM to read anyway.
SAMPLE_ARRAY_CUTOFF = 16

CITATION_KEYS = {
    "doi",
    "paper_id",
    "arxiv_id",
    "pmid",
    "pmcid",
    "url",
    "title",
    "authors",
    "year",
}


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


def _summarize_for_prompt(value: Any) -> Any:
    """Make an arbitrary cell value safe to dump into the system prompt.

    Truncates long strings, summarizes long arrays (the typical case is a
    1024-d embedding vector that would otherwise blow the context window),
    and recurses into nested dicts/lists.
    """
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, list):
        if len(value) > SAMPLE_ARRAY_CUTOFF:
            preview = [_summarize_for_prompt(v) for v in value[:3]]
            return f"<array len={len(value)} preview={preview}>"
        return [_summarize_for_prompt(v) for v in value]
    if isinstance(value, dict):
        return {k: _summarize_for_prompt(v) for k, v in value.items()}
    return value


def _resolve_api_key() -> str | None:
    # The Anthropic SDK looks for ANTHROPIC_API_KEY. Accept the shorter
    # ANTHROPIC_KEY alias (used by adjacent projects) and re-export it.
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    alias = os.environ.get("ANTHROPIC_KEY")
    if alias:
        os.environ["ANTHROPIC_API_KEY"] = alias
        return alias
    return None


def _citation_instruction(citation_cols: set[str]) -> str:
    if "doi" in citation_cols:
        link_template = "[Title](https://doi.org/{doi})"
        column_hint = "the `doi` column"
    elif "arxiv_id" in citation_cols:
        link_template = "[Title](https://arxiv.org/abs/{arxiv_id})"
        column_hint = "the `arxiv_id` column"
    elif "pmid" in citation_cols:
        link_template = "[Title](https://pubmed.ncbi.nlm.nih.gov/{pmid}/)"
        column_hint = "the `pmid` column"
    elif "url" in citation_cols:
        link_template = "[Title]({url})"
        column_hint = "the `url` column"
    else:
        link_template = '**"Title"**'
        column_hint = "the `title` column (no stable identifier is available)"
    available = ", ".join(sorted(f"`{c}`" for c in citation_cols))
    return (
        "This dataset is scholarly/paper-shaped — the available citation "
        f"columns are: {available}. When you make a paper-grounded claim, "
        "cite at least one specific paper from the sample (or from a SQL "
        "query) that supports it. Use this exact link template, drawing the "
        f"identifier from {column_hint}: {link_template}. Skip citations on "
        "purely conversational replies (e.g. 'what columns do you have?')."
    )


def _build_system_prompt(
    predicate: str | None,
    table: str,
    text_column: str | None,
    row_count: int | None,
    sample: list[dict[str, Any]],
    has_sql_tool: bool,
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
        {k: _summarize_for_prompt(v) for k, v in row.items()}
        for row in sample[:SAMPLE_ROW_LIMIT]
    ]
    tool_hint = (
        "If the user asks about something the sample doesn't cover, call the "
        "`run_sql_query` tool to inspect more rows. Always scope queries to the "
        "selection by including the WHERE predicate (or by adding "
        "`WHERE <predicate>` if the user has selected something). Keep result "
        "sets small."
        if has_sql_tool
        else ""
    )
    columns = sample[0].keys() if sample else []
    citation_cols = {c.lower() for c in columns if c.lower() in CITATION_KEYS}
    citation_hint = _citation_instruction(citation_cols) if citation_cols else ""
    return (
        "You are an analyst embedded in the Apple Embedding Atlas viewer. "
        "The user is exploring a dataset and may have lassoed a region of the "
        "embedding space. Be concise; favor concrete claims grounded in the "
        "rows you can see.\n\n"
        f"Current selection: {selection_clause}.\n"
        f"{count_clause}\n"
        f"{text_hint}\n\n"
        f"Sample rows from the current selection (truncated): "
        f"{json.dumps(truncated_sample)}\n\n"
        f"{tool_hint}"
        + (f"\n\n{citation_hint}" if citation_hint else "")
    )


# ─── direct Messages API path ──────────────────────────────────────────────


def _sql_tool_definition(table: str, predicate: str | None) -> dict[str, Any]:
    pred_hint = f" The user's current WHERE predicate is `{predicate}`." if predicate else ""
    return {
        "name": "run_sql_query",
        "description": (
            f"Run a read-only SELECT query against the `{table}` DuckDB table "
            "and return rows as JSON. Use this when the sample in the system "
            "prompt is insufficient. Only SELECT statements are accepted; "
            "writes and DDL are blocked. Keep result sets under 100 rows by "
            "using LIMIT or aggregations."
            + pred_hint
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "A single SELECT statement, no trailing semicolon.",
                }
            },
            "required": ["sql"],
        },
    }


def _run_sql_tool(
    connection: duckdb.DuckDBPyConnection,
    sql: str,
    *,
    row_cap: int = 100,
) -> tuple[str, bool]:
    """Execute a guarded SELECT and return (json_text, is_error)."""
    stripped = sql.strip().rstrip(";").lstrip()
    lowered = stripped.lower()
    if not lowered.startswith(("select", "with")):
        return ("Only SELECT/WITH queries are allowed.", True)
    if ";" in stripped:
        return ("Multiple statements are not allowed.", True)
    try:
        df = connection.execute(stripped).fetchdf()
    except Exception as exc:
        return (f"DuckDB error: {exc}", True)
    if len(df) > row_cap:
        df = df.head(row_cap)
        truncated = True
    else:
        truncated = False
    payload = {
        "rows": json.loads(df.to_json(orient="records")),
        "row_count": int(len(df)),
        "truncated": truncated,
    }
    return (json.dumps(payload, default=str), False)


async def _direct_stream(
    messages: list[dict[str, Any]],
    system_prompt: str,
    *,
    model: str,
    duckdb_connection: duckdb.DuckDBPyConnection | None,
    table: str,
    predicate: str | None,
) -> AsyncIterator[bytes]:
    """Anthropic Messages API path with streaming + run_sql_query tool loop."""
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic()
    tools: list[dict[str, Any]] = []
    if duckdb_connection is not None:
        tools.append(_sql_tool_definition(table, predicate))

    history: list[dict[str, Any]] = [
        {"role": m["role"], "content": m["content"]} for m in messages
    ]

    for _ in range(MAX_TOOL_ITERATIONS):
        # Each turn: stream the assistant response. If it ends with a tool
        # use, run the tool locally and loop. Otherwise, finish.
        async with client.messages.stream(
            model=model,
            max_tokens=2048,
            system=system_prompt,
            tools=tools or None,
            messages=history,
        ) as stream:
            assistant_blocks: list[dict[str, Any]] = []
            current_text = ""
            current_tool_use: dict[str, Any] | None = None
            current_tool_input_buf = ""

            async for event in stream:
                kind = getattr(event, "type", None)
                if kind == "content_block_start":
                    block = event.content_block
                    if block.type == "tool_use":
                        current_tool_use = {
                            "type": "tool_use",
                            "id": block.id,
                            "name": block.name,
                            "input": {},
                        }
                        current_tool_input_buf = ""
                    elif block.type == "text":
                        current_text = ""
                elif kind == "content_block_delta":
                    delta = event.delta
                    delta_type = getattr(delta, "type", None)
                    if delta_type == "text_delta":
                        text = delta.text
                        current_text += text
                        yield _sse("delta", {"text": text})
                    elif delta_type == "input_json_delta":
                        current_tool_input_buf += delta.partial_json
                elif kind == "content_block_stop":
                    if current_tool_use is not None:
                        try:
                            current_tool_use["input"] = (
                                json.loads(current_tool_input_buf)
                                if current_tool_input_buf
                                else {}
                            )
                        except json.JSONDecodeError:
                            current_tool_use["input"] = {"_raw": current_tool_input_buf}
                        assistant_blocks.append(current_tool_use)
                        yield _sse(
                            "tool_use",
                            {
                                "id": current_tool_use["id"],
                                "name": current_tool_use["name"],
                                "input": current_tool_use["input"],
                            },
                        )
                        current_tool_use = None
                    elif current_text:
                        assistant_blocks.append({"type": "text", "text": current_text})
                        current_text = ""
                elif kind == "message_stop":
                    pass

            final = await stream.get_final_message()
            stop_reason = final.stop_reason
            usage = {
                "input_tokens": getattr(final.usage, "input_tokens", 0),
                "output_tokens": getattr(final.usage, "output_tokens", 0),
            }

        # Decide whether to loop
        history.append({"role": "assistant", "content": assistant_blocks})

        tool_uses = [b for b in assistant_blocks if b.get("type") == "tool_use"]
        if not tool_uses or stop_reason != "tool_use":
            yield _sse("done", {"reason": stop_reason or "stop", "usage": usage})
            return

        # Execute tools and emit tool_result events
        tool_results_msg: list[dict[str, Any]] = []
        for use in tool_uses:
            if use["name"] == "run_sql_query" and duckdb_connection is not None:
                sql = use["input"].get("sql", "")
                content, is_error = _run_sql_tool(duckdb_connection, sql)
                trimmed = _truncate(content, TOOL_RESULT_TRUNCATE)
                yield _sse(
                    "tool_result",
                    {"id": use["id"], "content": trimmed, "is_error": is_error},
                )
                tool_results_msg.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": use["id"],
                        "content": trimmed,
                        "is_error": is_error,
                    }
                )
            else:
                msg = f"Tool `{use['name']}` is not available in direct chat mode."
                yield _sse(
                    "tool_result",
                    {"id": use["id"], "content": msg, "is_error": True},
                )
                tool_results_msg.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": use["id"],
                        "content": msg,
                        "is_error": True,
                    }
                )
        history.append({"role": "user", "content": tool_results_msg})

    yield _sse(
        "error",
        {"message": f"Reached max tool iterations ({MAX_TOOL_ITERATIONS})"},
    )


# ─── Claude Agent SDK path (full MCP, slower) ──────────────────────────────


async def _agent_stream(
    messages: list[dict[str, Any]],
    system_prompt: str,
    *,
    mcp_url: str | None,
) -> AsyncIterator[bytes]:
    from claude_agent_sdk import (
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
                            {"id": block.id, "name": block.name, "input": block.input},
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
                                "content": _truncate(content, TOOL_RESULT_TRUNCATE),
                                "is_error": bool(block.is_error),
                            },
                        )
            elif isinstance(message, ResultMessage):
                yield _sse(
                    "done",
                    {"reason": "stop", "usage": getattr(message, "usage", None)},
                )
                return
    except Exception as exc:
        yield _sse("error", {"message": str(exc)})
        return

    yield _sse("done", {"reason": "stop"})


# ─── echo path (no SDK / no key) ───────────────────────────────────────────


async def _echo_stream(
    messages: list[dict[str, Any]],
) -> AsyncIterator[bytes]:
    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        "(no user message)",
    )
    yield _sse(
        "delta",
        {
            "text": (
                "Chat backend is not configured (no anthropic SDK / "
                "ANTHROPIC_API_KEY). Echo: "
                + (last_user if isinstance(last_user, str) else json.dumps(last_user))
            ),
        },
    )
    yield _sse("done", {"reason": "echo"})


# ─── dispatch ─────────────────────────────────────────────────────────────


def _direct_available() -> bool:
    if not _resolve_api_key():
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


def _agent_available() -> bool:
    if not _resolve_api_key():
        return False
    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError:
        return False
    return True


ChatMode = Literal["direct", "agent"]
DEFAULT_CHAT_MODEL = "claude-haiku-4-5"


async def stream_chat(
    body: dict[str, Any],
    *,
    duckdb_connection: duckdb.DuckDBPyConnection | None,
    table: str,
    mcp_url: str | None,
    mode: ChatMode = "direct",
    model: str = DEFAULT_CHAT_MODEL,
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

    has_sql_tool = mode == "direct" and duckdb_connection is not None

    system_prompt = _build_system_prompt(
        predicate=predicate,
        table=table,
        text_column=text_column,
        row_count=row_count,
        sample=sample,
        has_sql_tool=has_sql_tool,
    )

    yield _sse(
        "context",
        {
            "row_count": row_count,
            "predicate": predicate,
            "sample_size": len(sample),
            "mode": mode,
            "model": model,
        },
    )

    if mode == "direct" and _direct_available():
        async for chunk in _direct_stream(
            messages,
            system_prompt,
            model=model,
            duckdb_connection=duckdb_connection,
            table=table,
            predicate=predicate,
        ):
            yield chunk
    elif mode == "agent" and _agent_available():
        async for chunk in _agent_stream(messages, system_prompt, mcp_url=mcp_url):
            yield chunk
    else:
        async for chunk in _echo_stream(messages):
            yield chunk
