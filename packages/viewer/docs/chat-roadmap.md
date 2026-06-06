# Embedding Atlas — Chat Feature Roadmap

> Status: ideation / planning. This document is a prioritized backlog, **not** a
> commitment. It was written alongside the "chat polish pass" (items A1–A6, all
> shipped) and captures the larger ideas that pass deliberately deferred.

## Where chat sits today

The viewer's chat is **selection-aware** and acts as both a data **copilot** and
a UI **automation agent**:

- It knows the current filter predicate and row count, and can run read-only SQL
  against the dataset.
- It renders **inline live charts** (`render_chart_in_chat`) that share the
  app's Mosaic coordinator, so they cross-filter like any other chart.
- It can take screenshots and drive the viewer through a 19-tool MCP bridge
  (add charts, recolor, filter, etc.).
- Conversation history now **persists across reloads** (localStorage, per
  dataset table) and streaming responses can be **stopped, retried, and copied**
  (the A1–A6 polish pass).

The data flow is `ListLayout → ChatPanel → ChatView → streamChat → backend SSE`
(`packages/backend/embedding_atlas/chat.py`). Chat currently exists only in the
**list layout**, and the backend keeps a **single** MCP handler — both are
deliberate single-user simplifications, called out under "Deferred infra" below.

The two directions below are weighted **equally**: chat as a reasoning copilot,
and chat as an agent that drives the viewer.

---

## Copilot direction — reason about the data

### 1. Named / saved conversations with a history sidebar

- **Problem:** Conversations now survive reloads (A2), but there's no way to
  name, browse, or return to a past conversation — they're keyed only by tab id.
- **Sketch:** A history list (in the existing right-side panel or a dropdown in
  the chat header) listing stored conversations with editable titles; selecting
  one re-hydrates its turns. Builds directly on the A2 localStorage map — add a
  title + lastUpdated to each entry and a small index.
- **Effort:** Medium.
- **Lands in:** `use_chat_history.svelte.ts` (schema + index), `ChatPanel.svelte`
  (history affordance), `ListLayout.svelte` (tab/selection wiring).

### 2. Conversation export (Markdown / JSON)

- **Problem:** No way to get a conversation out of the tool for sharing or
  archival.
- **Sketch:** "Export" action in the chat header → serialize the active turns to
  Markdown (prose + code + which tools ran) or raw JSON. Reuse existing export
  helpers under `viewer/src/utils`.
- **Effort:** Small.
- **Lands in:** `ChatPanel.svelte` header + a small `chat_export.ts` util.

### 3. Schema-aware starter prompts / suggestion chips

- **Problem:** The empty state is a paragraph of prose; new users don't know
  what to ask.
- **Sketch:** On the empty conversation, render 3–5 suggestion chips generated
  from the actual columns in `ChartContext` and detected citation columns
  (`chat.py`) — e.g. "Summarize the selected rows", "What distinguishes this
  cluster?", "Plot {numeric_col} by {categorical_col}". Clicking a chip fills
  the draft.
- **Effort:** Small–Medium.
- **Lands in:** `ChatView.svelte` empty state; column metadata already on
  `context`.

### 4. One-click "Summarize selection" / "Explain this cluster"

- **Problem:** The most common copilot intents require typing them out each time.
- **Sketch:** Entry points wired from the embedding view's current selection and
  cluster labels — a button on a selection or cluster that opens chat with a
  pre-filled, context-bearing prompt.
- **Effort:** Medium (touches embedding-view ↔ chat plumbing).
- **Lands in:** embedding view selection/cluster UI → `ListLayout` → chat draft.

### 5. Streaming tool results

- **Problem:** Tool results currently arrive **all at once**; a large screenshot
  or SQL result stutters the UI when it lands.
- **Sketch:** Stream tool-result content blocks incrementally (progressive image
  decode / chunked text) so large payloads don't block the render.
- **Effort:** Medium–Large (backend SSE + frontend `applyEvent`).
- **Lands in:** `chat.py` (chunked emission), `chat_client.ts` + `ChatView.svelte`.

### 6. Truncation transparency

- **Problem:** `chat.py` silently truncates tool results at ~8 KB; the user (and
  arguably the model) can't tell that data was dropped.
- **Sketch:** Mark truncated results in the SSE payload; render a "result
  truncated" indicator with a "show more" follow-up that re-requests the full
  result.
- **Effort:** Small–Medium.
- **Lands in:** `chat.py` (truncation flag) + tool-result rendering in
  `ChatView.svelte`.

---

## Agent direction — drive the viewer

### 7. Chat in the dashboard layout

- **Problem:** Chat lives only in the list layout, so the agent can't act when
  the user is in the dashboard layout.
- **Sketch:** A persistent side drawer hosting `ChatPanel` regardless of layout,
  so the agent's MCP tools (add chart, filter, recolor) work everywhere.
- **Effort:** Medium.
- **Lands in:** dashboard layout shell + lifting `ChatPanel` to a layout-agnostic
  host.

### 8. Client-side model picker

- **Problem:** The server fixes the model via `--chat-model`; the user can't
  trade speed for capability per-conversation.
- **Sketch:** A model dropdown in the chat header; persist the choice in
  localStorage and thread it through the `/data/chat` request body. Check the
  `claude-api` skill for current model IDs before wiring defaults.
- **Effort:** Small–Medium.
- **Lands in:** `ChatPanel.svelte` header, `chat_client.ts` request shape,
  `chat.py` request handling.

### 9. "Undo last action" for agent-driven UI changes

- **Problem:** When the agent recolors, adds a chart, or filters, there's no
  one-click way to revert it.
- **Sketch:** Snapshot the relevant chart/layout state before applying an
  agent-driven mutation; expose an "Undo" affordance that restores it. Leverages
  the existing chart/layout state setters.
- **Effort:** Medium.
- **Lands in:** the MCP tool handlers + a small action-history stack.

### 10. Slash-commands / quick-actions

- **Problem:** Invoking a common MCP tool requires a full natural-language turn.
- **Sketch:** `/`-triggered command menu in the chat input to invoke common MCP
  tools directly (e.g. `/screenshot`, `/clear-filter`) without a model round-trip.
- **Effort:** Medium.
- **Lands in:** `ChatView.svelte` input + a command registry over the MCP tools.

### 11. Inline-chart "save edited version"

- **Problem:** Edits to an inline chart are ephemeral; tweaks are lost when the
  conversation scrolls away.
- **Sketch:** Let an edited inline chart promote its current (tweaked) spec to
  the panel, not just the original emitted spec. Extends the existing
  `saveInlineChartToPanel`.
- **Effort:** Small–Medium.
- **Lands in:** `InlineChartView.svelte` + the save-to-panel path.

---

## Deferred infra — out of scope for single-user

These are prerequisites for any multi-user deployment and should be a **separate
hardening epic**, not folded into single-user feature work.

- **12. Per-session WebSocket routing.** `server.py` keeps a single
  `last_handler`; two concurrent users collide on the MCP bridge.
- **13. Auth + per-user cost attribution** on `/data/chat`.
- **14. Bridge reconnection** after a WebSocket drop (today the bridge doesn't
  recover).

---

## Appendix — non-chat code-hardening backlog

Surfaced during the audit; flagged as a future **code-hardening track**, not part
of the single-user chat work:

- ~57 `any` types across the viewer.
- Several silent `catch {}` blocks that swallow errors without context.
- No ESLint config.
- Thin frontend test coverage.
- A few 1000+ line components (`EmbeddingAtlas.svelte`, `runtime.ts`) that would
  benefit from decomposition.
