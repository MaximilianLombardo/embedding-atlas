# Direct-Mode MCP Bridge for Chat

## Context

The just-completed v2 work (`feat/chat-tab-palette-v2`, 11 commits, fully implemented) shipped chat as a tab + a real palette + citation surfacing. Two chat modes coexist on that branch:

- `direct` (default) — Anthropic Messages API streaming, ~2s first token, full conversation history forwarded, but **only one tool**: a local `run_sql_query` against the server's DuckDB connection.
- `agent` — Claude Agent SDK via `query()` one-shot helper, ~10–15s first turn, **no history** (helper only forwards the last user message), **all 19 viewer MCP tools**.

User wants snappiness + persistence + full MCP control simultaneously. After ruling out the Anthropic native MCP connector (option C — requires Anthropic's servers to reach `/mcp`, which doesn't fit a localhost dev product, and the eventual web-app deployment doesn't change this for the better), the right path is a server-side bridge: keep direct mode's transport, add the 19-tool surface by routing tool calls through the existing `/mcp` HTTP proxy from inside the FastAPI process.

Eventual target is an org web app, but we're scoping local-first. Nothing in this plan precludes deploy; deployment-readiness concerns (multi-user `/mcp` routing, auth, rate limits, cost attribution) are listed as a separate follow-up.

## Goal

A single chat path that:

1. **Streams** tokens from the Anthropic Messages API (~2s first token, like today's direct mode).
2. **Persists** conversation history across turns (already true for direct mode — `messages` is forwarded).
3. **Drives the viewer** through all 19 MCP tools when `--mcp` is enabled, by routing tool calls server-side through the existing `/mcp` proxy → WebSocket → viewer.

Without `--mcp`, behavior is unchanged (local `run_sql_query` only). With `--mcp`, the chat picks up the full tool surface automatically — no new flags.

## Architecture

### Wire protocol confirmed via exploration

The viewer's MCP server is *not* `@modelcontextprotocol/sdk` — it's a custom JSON-RPC 2.0 implementation (`packages/viewer/src/app/mcp_server.ts`) with a thin WebSocket envelope: `{id: <uuid>, request: <jsonrpc>}` → `{id: <uuid>, response: <jsonrpc>}`. Methods: `initialize`, `tools/list`, `tools/call`. Tool results are content arrays with text or image blocks. Schemas are JSON Schema 7 — direct translation to Anthropic. **A ~150-line Python JSON-RPC client suffices; no `mcp` package needed.**

### Tool flow

```
ChatView ──HTTP/SSE── /data/chat ──── _direct_stream(mcp_bridge=…)
                                              │
                                              ▼ tools = bridge.list_tools()
                                   Anthropic Messages API streaming
                                              │
                                              ▼ tool_use blocks
                                       _dispatch_tool(use, bridge)
                                              │
                                              ▼ JSON-RPC tools/call
                                       McpBridgeClient.call_tool
                                              │
                                              ▼ python function call (loopback, not HTTP)
                                     server.dispatch_mcp_request(body)
                                              │
                                              ▼ WebSocketHandler.send_request (envelope)
                                  ────WebSocket──── viewer MCP server (mcp_server.ts)
                                              │
                                              ▼ content list (text or image)
                                     Anthropic tool_result content block
```

### Critical files

| Action | Path | Purpose |
|---|---|---|
| NEW | `packages/backend/embedding_atlas/mcp_bridge.py` | `McpBridgeClient` (initialize / list_tools / call_tool) + schema/content translation helpers |
| MODIFY | `packages/backend/embedding_atlas/server.py` | Extract `dispatch_mcp_request(body)` as a Python-callable function shared by `/mcp` HTTP route + bridge; construct bridge in `make_server` when chat + mcp both enabled; pass to chat handler |
| MODIFY | `packages/backend/embedding_atlas/chat.py` | `_direct_stream` accepts optional `mcp_bridge`; refactor inline tool dispatch into `_dispatch_tool(use, bridge, duckdb_connection)`; merge bridge tools into `tools=` arg; pass image content blocks back to Anthropic; bump `MAX_TOOL_ITERATIONS` 5 → 10 |
| NEW | `packages/backend/tests/test_mcp_bridge.py` | Schema translation, dispatch fan-out, image content, lazy initialization |

### Existing code to reuse (do not reimplement)

- `WebSocketHandler.send_request(body)` (`server.py:279`) — already wraps a JSON-RPC body in the envelope, awaits the matching response. The bridge calls this directly.
- `_truncate(content, TOOL_RESULT_TRUNCATE)` (`chat.py:99`) — for size-capping text tool results before SSE.
- `_run_sql_tool` (`chat.py:244`) — keep as-is for the no-`--mcp` fallback.
- The 19 tool registrations in `packages/viewer/src/model_context/model_context.ts` are the source of truth — *do not duplicate* tool schemas in Python.

### Architectural decisions (recorded so future-you knows the why)

1. **Loopback by Python function call, not HTTP.** The bridge calls `dispatch_mcp_request(body)` directly inside the FastAPI process — no port-binding, no extra latency hop, no auth surface to harden. The HTTP `/mcp` route just becomes one of two callers of the same shared function.

2. **Lazy bridge initialization.** The viewer's WebSocket may not be connected at server startup (user opens browser later). Bridge calls `initialize` + `tools/list` on the *first* chat request that needs them; caches the result; the `WebSocket disconnected` 503 from `WebSocketHandler` invalidates the cache so the next request re-initializes.

3. **Bridge supersedes local `run_sql_query` when both available.** The 19-tool list includes `run_sql_query`. When the bridge is up, prefer the bridge version (one mental model for the user). Drop the Python-side definition in that path. Without `--mcp`, fall back to local.

4. **Image tool results: model sees them, UI shows placeholder.** Anthropic accepts image content blocks in tool_result. The model can therefore "see" `get_chart_screenshot` output and reason about it. The chat UI in v1 just displays "*[image returned]*"; inline image rendering in `ChatView.svelte` is deferred to the polish pass after end-to-end works.

5. **Concurrent tool calls in one turn use `asyncio.gather`.** Anthropic can emit multiple `tool_use` blocks in one assistant message. Today's `_direct_stream` serializes; switching to gather is a small parallelization win at no risk.

6. **Forward-compatible `user_context: dict | None = None`.** Bridge methods take this parameter unused-locally but in-place. When deployment introduces multi-user routing, the call site doesn't have to be refactored — just the dispatcher beneath.

## Out of scope (explicit deferrals)

These are real and will need to happen, but not in this branch:

- **Multi-user `/mcp` routing.** Today's `last_handler: dict[str, WebSocketHandler | None]` (`server.py:316`) tracks one connected viewer at a time. Fine for single-user dev; broken for org deployment. Will be addressed in the deployment-readiness workstream.
- **Per-user auth on `/mcp` and `/data/chat`.** Defer until the deploy story is live.
- **Rate limiting + cost attribution.** Same.
- **Reconnection / session lifetime hardening.** Same.
- **Frontend rendering of image tool_result content.** Placeholder text only for v1; inline image rendering after the bridge is proven end-to-end.
- **Deprecating agent mode.** Keep it as an escape hatch for now (it's the only path to Claude Code's hooks/subagents). Remove or rename in a later cleanup.
- **Filter-by-value + add-chart palette commands** (carryover from v2 plan B-2).
- **Inline citation pills + sources footer** (carryover from v2 plan).

A new doc `ideas/chat-mcp-bridge-deploy.md` will be created during step 8 below to capture the deployment-readiness items with acceptance criteria.

## Build sequence

0. **Push current state to origin.** `feat/chat-tab-palette-v2` is 11 commits ahead of `origin/main` and unpushed. Push it (`git push -u origin feat/chat-tab-palette-v2`) so the v2 work is durable before stacking new work on top.
1. **Cut branch + plan in repo.** `feat/chat-mcp-bridge` from `feat/chat-tab-palette-v2`. Mirror this plan to `ideas/chat-mcp-bridge.md` with a progress log. Commit.
2. **Refactor `server.py`.** Extract `dispatch_mcp_request(body) -> dict` as a closure inside `make_mcp_proxy` (or hoist `make_mcp_proxy` to return both the route and the dispatcher). The `/mcp` HTTP route uses it; the bridge will too. No behavior change yet — verify by running existing setup.
3. **Build `mcp_bridge.py`.** `McpBridgeClient` class:
   - `__init__(dispatch: Callable[[dict], Awaitable[dict]])`
   - `async initialize() -> None`
   - `async list_tools() -> list[Tool]` (returns Anthropic-format tool defs)
   - `async call_tool(name, input, user_context=None) -> ToolResult` (returns content list, image-aware)
   - Translation helpers: `_mcp_tool_to_anthropic`, `_mcp_content_to_anthropic_tool_result`
   - Cache tool list; invalidate on `WebSocket disconnected` errors
   - Initialize is lazy: first method call triggers it
4. **Refactor `_direct_stream`.** Accept `mcp_bridge`. Build `tools` list = bridge tools when present, else `[_sql_tool_definition(...)]`. Extract inline tool dispatch into `_dispatch_tool(use, bridge, duckdb_connection)`. Wire image content blocks. Bump `MAX_TOOL_ITERATIONS` to 10. Use `asyncio.gather` for concurrent tool calls in one turn.
5. **Wire in `make_server`.** When `chat and mcp`: build `McpBridgeClient(dispatch=dispatch_mcp_request)`. Pass into the chat handler. When `chat and not mcp`: pass `None`. Connect via the existing `chat_connection` plumbing.
6. **Tests.** `tests/test_mcp_bridge.py` with mocked dispatcher: schema translation correctness, content translation (text + image), lazy init, error path (503 when WebSocket disconnects), tool-list caching + invalidation.
7. **Manual verification.** Restart server with `--chat --mcp`. Walk the verification checklist below.
8. **Documentation.** Update progress log in `ideas/chat-mcp-bridge.md`. Create `ideas/chat-mcp-bridge-deploy.md` with the deferred deploy items.

## Verification

- All work happens on `feat/chat-mcp-bridge`.
- `npm run check` clean across workspaces (no frontend change is expected — sanity check only).
- `pytest` clean: existing 151 + new bridge tests, none skipped without reason.
- `prettier -c` and `uvx ruff format --check` clean.
- Manual against the v1830 dataset (already running):
  - Restart: `cd packages/backend && uv run --env-file .env --extra chat embedding-atlas .../atlas.parquet --vector embedding --text text --chat --mcp`
  - Open chat tab, send: *"Recolor the embedding by `domain`."* → embedding view recolors. Tool used: `set_chart_spec`.
  - Send: *"Take a screenshot of the current view."* → model returns a description grounded in the image. Chat UI shows `[image returned]` placeholder.
  - Send: *"Add a histogram of `year`."* → chart panel grows a new histogram. Tool: `add_chart`.
  - Send: *"Switch to dashboard layout."* → layout switches. Tool: `set_layout_type`.
  - Multi-turn check: *"Now go back to list and recolor by `primary_corpus`."* → both happen, history persists. Conversation memory works.
  - Without `--mcp`: only `run_sql_query` available, today's behavior preserved (regression check).

## Critical risks (and how to detect them early)

- **`tools/list` schema mismatch.** Mitigation: step 3 includes a printed schema-translation diff for one or two tools; eyeball before wiring.
- **WebSocket dropped mid-tool-call.** Mitigation: 30s timeout already in `WebSocketHandler.send_request`; bridge surfaces `is_error: true` to the model with a clear message.
- **Image size > Anthropic's input limit (~5MB per image, ~20 images).** Mitigation: cap and downsample on bridge side if `len(b64) > 5MB`; v1 just truncates with an error result.
- **Loop bound exhaustion.** Bumping `MAX_TOOL_ITERATIONS` to 10 should cover compound asks; if a real workflow needs more, add a budget guard rather than removing the cap.

## Progress log

Update as each step completes — mark ✅ and add one-line notes on anything that surprised us.

- [x] **Step 0** — `feat/chat-tab-palette-v2` pushed to origin.
- [x] **Step 1** — branch `feat/chat-mcp-bridge` cut from v2; this plan committed in-repo.
- [x] **Step 2** — extract `dispatch_mcp_request` in `server.py` *(commit `bd13a84`)*. `make_mcp_proxy` now returns the dispatcher; `/mcp` HTTP route is just one of two callers.
- [x] **Step 3** — build `mcp_bridge.py` with translation helpers + lazy init + cache *(commit `481ab7b`)*. ~210 lines including docstrings; no third-party MCP package needed.
- [x] **Step 4** — refactor `_direct_stream` to consume the bridge *(commit `80d955e`)*. Image content passed to Anthropic as content blocks (model "sees" screenshots); SSE keeps a string for the chat UI's existing renderer with `[image returned]` placeholder. `MAX_TOOL_ITERATIONS` 5 → 10. Concurrent tool calls fan out via `asyncio.gather`.
- [x] **Step 5** — wire bridge into `make_server` (gated on `chat && mcp`) *(commit `1db83a4`)*. With just `--chat`, today's behavior is preserved (local `run_sql_query` only).
- [x] **Step 6** — `tests/test_mcp_bridge.py` with mocked dispatcher *(commit `06f477c`)*. 15 new tests; backend pytest 166 passed / 21 skipped (was 151 / 21).
- [ ] **Step 7** — manual verification against the v1830 dataset (recolor / screenshot / histogram / layout / multi-turn). *In progress — server restarted on port 5056, awaiting user-driven validation.*
- [x] **Step 8** — deploy-readiness doc *(`ideas/chat-mcp-bridge-deploy.md`)* listing the 7 items that need to land before this is safe for multi-user org deployment.
