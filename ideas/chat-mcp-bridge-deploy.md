# Chat MCP Bridge — Deployment-Readiness Checklist

The `feat/chat-mcp-bridge` branch ships the in-process MCP bridge for direct chat mode. It works correctly for a single user against a single viewer instance — i.e., the local development shape and the hackathon demos. **Before this is safe to deploy as a multi-user web app for the org, the items below need to land.**

## 1. Multi-user `/mcp` routing

**Problem.** `make_mcp_proxy` (`packages/backend/embedding_atlas/server.py:316`) keeps a single `last_handler: dict[str, WebSocketHandler | None]`. When user B opens the viewer, the proxy *closes* user A's WebSocket and routes everything (HTTP `/mcp` + chat bridge calls) to B. Two concurrent users fight over the same handler slot.

**Fix sketch.**
- Replace `last_handler` with a `dict[session_id, WebSocketHandler]` keyed by an opaque session ID.
- Each viewer page gets a session ID at connection time (cookie, header, or URL param) and includes it on its WebSocket connect.
- `dispatch_mcp_request(body, *, session_id)` looks up the handler for that session.
- The chat backend already passes `user_context` through `McpBridgeClient.call_tool`. Wire `session_id` into `user_context`, then through `dispatch_mcp_request`.

**Acceptance.** Two browser tabs from two different users can both have working chat tabs, and a `set_chart_spec` invoked by user A only affects A's viewer.

## 2. Per-user authentication

**Problem.** `/mcp`, `/data/chat`, and the WebSocket are all unauthenticated.

**Fix sketch.**
- Reverse-proxy in front of FastAPI handles TLS + auth (org SSO).
- Pass authenticated identity through to the FastAPI app (header or cookie); FastAPI middleware extracts `user_id`.
- `user_id` becomes part of the per-request `user_context` and is logged.

**Acceptance.** Unauthenticated requests are rejected at the proxy. Authenticated requests carry a verifiable user identity through to the chat handler.

## 3. Cost attribution + rate limiting

**Problem.** Anthropic API usage is billed to the server's API key with no per-user breakdown. A single misbehaving session can rack up cost.

**Fix sketch.**
- Per-request token-usage is already captured in the `done` SSE event (`usage` field). Persist it keyed by `user_id`.
- Add a per-user rate limiter (e.g., requests-per-minute, tokens-per-day) at the chat handler boundary. Refuse with HTTP 429 when exceeded.
- Surface usage to the user via a small status indicator in the chat panel header.

**Acceptance.** A daily report can show per-user token usage. A user exceeding their limit sees a clear refusal rather than a silent 500.

## 4. Reconnection / session lifetime

**Problem.** The viewer's WebSocket can drop (network blip, laptop sleep, idle timeout) mid-conversation. The bridge surfaces that as `is_error: true` and the user's session is broken until they refresh.

**Fix sketch.**
- The viewer-side WebSocket already supports auto-reconnect to `/data/mcp_websocket` (verify in `mcp_server.ts`); confirm the session ID is preserved across reconnects.
- The bridge already invalidates its tool cache on disconnect; it'll re-fetch `tools/list` on the next request after reconnect.
- For long-running tool calls (screenshots over slow networks), bump `WebSocketHandler.send_request`'s 30s timeout to ~60s.

**Acceptance.** Killing the viewer's WebSocket and immediately reconnecting it lets the chat continue without a page reload.

## 5. User-visible model switcher

**Problem.** Chat model is fixed at server-launch time via `--chat-model` (default `claude-opus-4-7`). Users can't trade off cost vs. reliability themselves — power users might want Haiku for fast iteration; demos might want Opus for tool-call fidelity. Today the only knob is the CLI flag.

**Fix sketch.**
- Add a small dropdown in the chat panel header next to the row-count badge: "Model: Opus 4.7 ▼". Options: Opus 4.7, Sonnet 4.6, Haiku 4.5.
- Persist the choice in `chatState` so it survives tab switches.
- The chat backend already accepts `model` per request (the SSE `context` event echoes it), so frontend just needs to thread the choice through `streamChat`'s body.
- Server-side, validate the model name against an allowlist before passing to Anthropic (avoid arbitrary header injection).

**Acceptance.** A user can switch models mid-session, see token usage roughly halve when they pick a smaller model, and the chosen model survives a tab switch.

## 6. Frontend rendering of image tool results

**Problem.** Image tool results (`get_chart_screenshot`, `get_full_screenshot`) are sent to Anthropic so the model "sees" them, but the chat panel only shows `[image returned]` — users can't see what the model is reasoning about.

**Fix sketch.**
- Extend the `tool_result` SSE event to include an optional `images: [{mime_type, data_b64}]` field.
- `ChatView.svelte` renders an `<img src="data:{mime};base64,{data}" />` per image inside the existing tool_result `<details>` panel.
- Reuse the existing image content shape from the bridge — only the SSE serialization side needs work.

**Acceptance.** Asking for a screenshot in chat shows the screenshot inline.

## 7. Deprecate `agent` mode

**Problem.** Two chat modes coexist; `agent` is now strictly worse on the dimensions users care about (latency, persistence). Keeping it costs maintenance and tooling complexity.

**Fix sketch.**
- After the bridge has been used in production for some real user time, mark `--chat-mode agent` as deprecated in CLI help.
- Remove `_agent_stream` and the `claude-agent-sdk` `[chat]` extra dependency in a follow-up release.

**Acceptance.** `--chat-mode agent` is gone; only the bridge-backed direct path exists.

## 8. Observability

**Problem.** When something goes wrong in the chat → bridge → MCP → viewer chain, debugging requires tailing server logs and `console.log`-ing the viewer.

**Fix sketch.**
- Structured logging at each hop with a `request_id` (chat turn) + `user_id` + `tool_name`.
- Surface a `/data/health` endpoint that reports MCP WebSocket connection state, model availability, and recent error counts.
- For the chat panel itself, a developer-mode toggle that shows the raw SSE event stream.

**Acceptance.** A user reporting "chat broke" can be triaged by reading one log query.

## Sequencing recommendation

Items 1 and 2 are gating: don't deploy without them. Items 3 and 4 are necessary for sustained operation but not for a first internal pilot. Items 5–8 are quality-of-life and can land in any order after the first deployed pilot.
