# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

"""Server-side MCP client that bridges Anthropic chat to the viewer's tool surface.

The viewer's MCP server is a custom JSON-RPC 2.0 implementation over WebSocket
(`packages/viewer/src/app/mcp_server.ts`). This bridge speaks that protocol
through the existing `/mcp` dispatcher (`server.dispatch_mcp_request`) so the
chat backend can expose all 19 viewer MCP tools to the Anthropic Messages API
without spawning a Claude CLI subprocess.

Lazy initialization: the viewer WebSocket may not be connected when the server
starts. The bridge defers `initialize` and `tools/list` until the first chat
request that needs them, and re-runs them if the WebSocket disconnects.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Anthropic accepts ~5MB per image input; be conservative.
MAX_IMAGE_BYTES = 4 * 1024 * 1024

Dispatcher = Callable[[dict], Awaitable[dict]]


class McpBridgeClient:
    """Async JSON-RPC client for the viewer's MCP server, callable in-process."""

    def __init__(self, dispatch: Dispatcher) -> None:
        self._dispatch = dispatch
        self._next_rpc_id = 1
        self._initialized = False
        self._tools: list[dict[str, Any]] | None = None
        self._lock = asyncio.Lock()

    async def list_tools(self) -> list[dict[str, Any]]:
        """Return the viewer's tools translated to Anthropic format.

        Raises `BridgeUnavailable` when the viewer WebSocket isn't connected.
        Callers (chat backend) typically fall back to local-only tools.
        """
        if self._tools is not None:
            return self._tools
        await self._ensure_initialized()
        async with self._lock:
            if self._tools is not None:
                return self._tools
            try:
                result = await self._rpc("tools/list", {})
            except _Disconnected as exc:
                self._invalidate_locked()
                raise BridgeUnavailable("MCP viewer not connected") from exc
            mcp_tools = result.get("tools") or []
            self._tools = [_mcp_tool_to_anthropic(t) for t in mcp_tools]
            return self._tools

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        user_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Invoke an MCP tool and return Anthropic-format tool_result content.

        Returns a dict shaped like
            ``{"content": <str | list[content_block]>, "is_error": bool}``
        where ``content_block`` is ``{"type": "text", "text"}`` or
        ``{"type": "image", "source": {"type": "base64", "media_type", "data"}}``.

        Disconnection during a tool call is converted into an `is_error` result
        so the model can surface the failure naturally instead of crashing the
        chat turn.
        """
        del user_context  # Reserved for future per-user routing in deployment.
        try:
            await self._ensure_initialized()
            result = await self._rpc(
                "tools/call", {"name": name, "arguments": arguments}
            )
        except _Disconnected:
            self._invalidate()
            return {
                "content": "Viewer disconnected. Reload the viewer and try again.",
                "is_error": True,
            }
        except RuntimeError as exc:
            return {"content": str(exc), "is_error": True}
        is_error = bool(result.get("isError"))
        content_blocks = result.get("content") or []
        return {
            "content": _mcp_content_to_anthropic_tool_result(content_blocks),
            "is_error": is_error,
        }

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        async with self._lock:
            if self._initialized:
                return
            await self._rpc(
                "initialize",
                {"clientInfo": {"name": "embedding-atlas-chat-bridge"}},
            )
            self._initialized = True

    def _invalidate(self) -> None:
        self._initialized = False
        self._tools = None

    def _invalidate_locked(self) -> None:
        # Caller holds self._lock.
        self._invalidate()

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        rpc_id = self._next_rpc_id
        self._next_rpc_id += 1
        body = {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}
        try:
            response = await self._dispatch(body)
        except HTTPException as exc:
            if exc.status_code == 503:
                raise _Disconnected() from exc
            raise
        if not isinstance(response, dict):
            raise RuntimeError(f"MCP {method}: malformed response (not a dict)")
        if "error" in response:
            err = response["error"]
            msg = err.get("message", "unknown") if isinstance(err, dict) else str(err)
            raise RuntimeError(f"MCP {method} error: {msg}")
        return response.get("result") or {}


class BridgeUnavailable(Exception):
    """Raised by `list_tools` when the viewer WebSocket isn't connected."""


class _Disconnected(Exception):
    """Internal: the viewer WebSocket isn't connected on this RPC."""


def _mcp_tool_to_anthropic(tool: dict[str, Any]) -> dict[str, Any]:
    """One MCP tool definition → one Anthropic tool definition.

    Both speak JSON Schema 7; the only structural difference is MCP's
    `inputSchema` vs Anthropic's `input_schema` field name.
    """
    schema = tool.get("inputSchema") or {"type": "object"}
    return {
        "name": tool["name"],
        "description": tool.get("description") or "",
        "input_schema": schema,
    }


def _mcp_content_to_anthropic_tool_result(
    blocks: list[dict[str, Any]],
) -> list[dict[str, Any]] | str:
    """MCP tool result content → Anthropic tool_result content.

    Strings are simpler than content lists, so we collapse text-only results
    into a single string. Anything containing image (or other non-text) blocks
    becomes a list so the model can actually see screenshot output.
    """
    out: list[dict[str, Any]] = []
    has_non_text = False
    for block in blocks:
        kind = block.get("type")
        if kind == "text":
            out.append({"type": "text", "text": block.get("text") or ""})
        elif kind == "image":
            data = block.get("data") or ""
            mime = block.get("mimeType") or "image/png"
            if len(data) > MAX_IMAGE_BYTES:
                logger.warning(
                    "MCP image %dKB exceeds cap %dKB; dropping payload",
                    len(data) // 1024,
                    MAX_IMAGE_BYTES // 1024,
                )
                out.append(
                    {
                        "type": "text",
                        "text": f"[image dropped: {len(data) // 1024}KB exceeds cap]",
                    }
                )
            else:
                out.append(
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": mime, "data": data},
                    }
                )
                has_non_text = True
        elif kind == "resource":
            resource = block.get("resource") or {}
            uri = resource.get("uri") or "<unknown>"
            out.append({"type": "text", "text": f"[resource: {uri}]"})
        else:
            out.append({"type": "text", "text": f"[unsupported MCP block: {kind}]"})
    if not has_non_text:
        return "".join(b["text"] for b in out if b["type"] == "text")
    return out
