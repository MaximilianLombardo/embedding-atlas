# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import pytest
from fastapi import HTTPException

from embedding_atlas.mcp_bridge import (
    BridgeUnavailable,
    MAX_IMAGE_BYTES,
    McpBridgeClient,
    _mcp_content_to_anthropic_tool_result,
    _mcp_content_to_sse_blocks,
    _mcp_tool_to_anthropic,
)


# ─── pure translation helpers ──────────────────────────────────────────────


def test_mcp_tool_to_anthropic_renames_input_schema():
    out = _mcp_tool_to_anthropic(
        {
            "name": "set_chart_spec",
            "description": "Update a chart.",
            "inputSchema": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        }
    )
    assert out == {
        "name": "set_chart_spec",
        "description": "Update a chart.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    }


def test_mcp_tool_to_anthropic_defaults_missing_schema():
    out = _mcp_tool_to_anthropic({"name": "noop"})
    assert out["input_schema"] == {"type": "object"}
    assert out["description"] == ""


def test_text_only_content_collapses_to_string():
    out = _mcp_content_to_anthropic_tool_result(
        [
            {"type": "text", "text": "first"},
            {"type": "text", "text": " second"},
        ]
    )
    assert out == "first second"


def test_image_content_becomes_list_with_image_block():
    out = _mcp_content_to_anthropic_tool_result(
        [
            {"type": "image", "data": "abc123", "mimeType": "image/png"},
        ]
    )
    assert out == [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "abc123"},
        }
    ]


def test_mixed_text_and_image_stays_as_list():
    out = _mcp_content_to_anthropic_tool_result(
        [
            {"type": "text", "text": "Here's a screenshot:"},
            {"type": "image", "data": "abc", "mimeType": "image/jpeg"},
        ]
    )
    assert isinstance(out, list)
    assert out[0] == {"type": "text", "text": "Here's a screenshot:"}
    assert out[1]["type"] == "image"
    assert out[1]["source"]["media_type"] == "image/jpeg"


def test_oversized_image_dropped_to_text_placeholder():
    big = "x" * (MAX_IMAGE_BYTES + 1)
    out = _mcp_content_to_anthropic_tool_result(
        [{"type": "image", "data": big, "mimeType": "image/png"}]
    )
    # No image block survived → list collapses to a text-only string.
    assert isinstance(out, str)
    assert "image dropped" in out


def test_resource_block_falls_back_to_text():
    out = _mcp_content_to_anthropic_tool_result(
        [{"type": "resource", "resource": {"uri": "file:///tmp/x.parquet"}}]
    )
    assert out == "[resource: file:///tmp/x.parquet]"


def test_unknown_block_kind_handled():
    out = _mcp_content_to_anthropic_tool_result([{"type": "future_thing"}])
    assert "unsupported MCP block" in out


def test_chart_block_substituted_with_text_for_anthropic():
    # `chart` blocks are emitted by the viewer's `render_chart_in_chat` MCP
    # tool. Anthropic's tool_result API only accepts text/image, so the
    # bridge swaps the chart for a text confirmation on the model-bound path.
    out = _mcp_content_to_anthropic_tool_result(
        [{"type": "chart", "spec": {"type": "count-plot", "data": {"field": "year"}}}]
    )
    assert isinstance(out, str)
    assert "chart rendered inline" in out


def test_chart_block_preserved_for_sse():
    # The SSE-side helper keeps the spec verbatim so the chat UI can mount
    # a live chart in the bubble.
    spec = {"type": "count-plot", "data": {"field": "year"}}
    out = _mcp_content_to_sse_blocks([{"type": "chart", "spec": spec}])
    assert out == [{"type": "chart", "spec": spec}]


def test_sse_blocks_returns_none_for_text_only():
    # Text-only results stay on the legacy `content: str` SSE codepath; the
    # bridge signals that by returning None for `sse_blocks`.
    out = _mcp_content_to_sse_blocks([{"type": "text", "text": "ok"}])
    assert out is None


def test_sse_blocks_carries_image_alongside_text():
    out = _mcp_content_to_sse_blocks(
        [
            {"type": "text", "text": "preview:"},
            {"type": "image", "data": "abc", "mimeType": "image/png"},
        ]
    )
    assert out == [
        {"type": "text", "text": "preview:"},
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "abc"},
        },
    ]


# ─── McpBridgeClient (mocked dispatcher) ───────────────────────────────────


class _FakeDispatcher:
    """Records calls and returns scripted responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def __call__(self, body):
        self.calls.append(body)
        if not self.responses:
            raise AssertionError(f"No more scripted responses; got call {body}")
        next_response = self.responses.pop(0)
        if isinstance(next_response, BaseException):
            raise next_response
        return next_response


def _ok(rpc_id, result):
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


@pytest.mark.asyncio
async def test_list_tools_initializes_then_caches():
    dispatch = _FakeDispatcher(
        [
            _ok(1, {"protocolVersion": "2024-11-05", "capabilities": {}}),
            _ok(
                2,
                {
                    "tools": [
                        {
                            "name": "run_sql_query",
                            "description": "SQL.",
                            "inputSchema": {"type": "object"},
                        }
                    ]
                },
            ),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    tools = await bridge.list_tools()
    assert len(tools) == 1
    assert tools[0]["name"] == "run_sql_query"
    # initialize, then tools/list — two RPCs.
    assert [c["method"] for c in dispatch.calls] == ["initialize", "tools/list"]
    # Second call hits the cache; no new RPC.
    again = await bridge.list_tools()
    assert again is tools
    assert len(dispatch.calls) == 2


@pytest.mark.asyncio
async def test_list_tools_disconnect_raises_bridge_unavailable_and_clears_cache():
    dispatch = _FakeDispatcher(
        [
            HTTPException(status_code=503, detail="No MCP WebSocket connected"),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    with pytest.raises(BridgeUnavailable):
        await bridge.list_tools()
    # State reset so next call retries from scratch.
    assert bridge._tools is None
    assert bridge._initialized is False


@pytest.mark.asyncio
async def test_call_tool_translates_text_result():
    dispatch = _FakeDispatcher(
        [
            _ok(1, {}),  # initialize
            _ok(
                2,
                {
                    "content": [{"type": "text", "text": '{"rows":[]}'}],
                    "isError": False,
                },
            ),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    result = await bridge.call_tool("run_sql_query", {"sql": "SELECT 1"})
    # `sse_blocks` is None for text-only results — the chat backend falls
    # back to the legacy `content: string` SSE codepath in that case.
    assert result == {
        "content": '{"rows":[]}',
        "is_error": False,
        "sse_blocks": None,
    }
    # Verify the dispatched body shape.
    call = dispatch.calls[1]
    assert call["method"] == "tools/call"
    assert call["params"] == {"name": "run_sql_query", "arguments": {"sql": "SELECT 1"}}


@pytest.mark.asyncio
async def test_call_tool_translates_image_result():
    dispatch = _FakeDispatcher(
        [
            _ok(1, {}),
            _ok(
                2,
                {
                    "content": [
                        {"type": "image", "data": "iVBOR=", "mimeType": "image/png"},
                    ],
                    "isError": False,
                },
            ),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    result = await bridge.call_tool("get_chart_screenshot", {"id": "1"})
    assert result["is_error"] is False
    content = result["content"]
    assert isinstance(content, list)
    assert content[0]["type"] == "image"
    assert content[0]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBOR=",
    }


@pytest.mark.asyncio
async def test_call_tool_translates_chart_result():
    # `render_chart_in_chat` returns a `chart` block. The bridge:
    #   - replaces it with a text placeholder on the Anthropic-facing
    #     `content` (Anthropic only accepts text/image),
    #   - preserves the spec on `sse_blocks` for the chat UI to render.
    spec = {"type": "count-plot", "data": {"field": "year"}}
    dispatch = _FakeDispatcher(
        [
            _ok(1, {}),
            _ok(
                2,
                {
                    "content": [{"type": "chart", "spec": spec}],
                    "isError": False,
                },
            ),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    result = await bridge.call_tool("render_chart_in_chat", {"spec": spec})
    assert result["is_error"] is False
    # Anthropic-side: text placeholder, no chart block leaks through.
    assert isinstance(result["content"], str)
    assert "chart rendered inline" in result["content"]
    # SSE-side: chart spec preserved for the chat UI.
    assert result["sse_blocks"] == [{"type": "chart", "spec": spec}]


@pytest.mark.asyncio
async def test_call_tool_disconnect_returns_is_error_result():
    dispatch = _FakeDispatcher(
        [
            HTTPException(status_code=503, detail="No MCP WebSocket connected"),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    result = await bridge.call_tool("list_charts", {})
    assert result["is_error"] is True
    assert "Viewer disconnected" in result["content"]
    # State invalidated — next call re-initializes.
    assert bridge._initialized is False


@pytest.mark.asyncio
async def test_call_tool_propagates_jsonrpc_error_as_text():
    dispatch = _FakeDispatcher(
        [
            _ok(1, {}),
            {
                "jsonrpc": "2.0",
                "id": 2,
                "error": {"code": -32601, "message": "method not found"},
            },
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    result = await bridge.call_tool("ghost_tool", {})
    assert result["is_error"] is True
    assert "method not found" in result["content"]


@pytest.mark.asyncio
async def test_initialize_runs_only_once_under_concurrent_callers():
    # Many list_tools callers in flight at once should still trigger only
    # one initialize + one tools/list.
    import asyncio

    dispatch = _FakeDispatcher(
        [
            _ok(1, {}),
            _ok(2, {"tools": []}),
        ]
    )
    bridge = McpBridgeClient(dispatch=dispatch)
    results = await asyncio.gather(
        bridge.list_tools(), bridge.list_tools(), bridge.list_tools()
    )
    # All three callers got the same cached list.
    assert results[0] == [] == results[1] == results[2]
    # Only initialize + tools/list — no duplicate RPCs.
    assert [c["method"] for c in dispatch.calls] == ["initialize", "tools/list"]
