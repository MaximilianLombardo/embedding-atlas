# Chat-as-tab + Real Command Palette + Citation Surfacing

## Context

The first iteration shipped a ⌘K command palette whose body was a chat panel (commits `de432dd`, `85aa7af`, branch `feat/command-palette-chat`). Daisy has been using it on the v1830_clustered Forgewright dataset and identified two friction points:

1. **The palette tries to be two things at once.** ⌘K-style palettes are for *fast deterministic actions* (filter, recolor, switch layout); chats are for *open-ended conversation*. Mashing them into a single modal makes both feel wrong — palette feels slow because chat thinks for ~1s, chat feels cramped because palette is modal and short.
2. **Chat only exists when the modal is open.** History dies on Escape. You can't lasso a region, ask, then lasso elsewhere and ask again with shared context.

Forgewright's demo arc (from `ideas/forgewright/spec.md`) is *50% exploration + 50% agent execution*. Splitting the AI surface matches that arc directly:

- **Palette = exploration accelerator** (Demo Part 1) — recolor by tool, filter by mesh, switch layout, jump to cluster
- **Chat = agent surface** (Demo Part 2) — describe goal, agent answers with citations and (eventually) executes primitives

Demo for next week. Hackathon is over; this is product polish.

### Iteration source & branching

The v1 palette ships on local `main` (commits `de432dd`, `85aa7af`) — `main` is 2 commits ahead of `origin/main` and the same as `origin/feat/command-palette-chat`. v2 work happens on a fresh branch:

- **Branch**: `feat/chat-tab-palette-v2`, cut from current `main`.
- **Plan persistence**: copy this plan to the repo at `ideas/chat-tab-palette-v2.md` (creating the `ideas/` dir if needed) as the very first commit on the branch, and update it as workstreams complete. Treat the in-repo copy as the source of truth during execution; this `~/.claude/plans/` copy is the planning-mode scratch.
- **Parallelization**: Workstream C (citation system-prompt, backend-only) is independent of A/B (frontend). Run it in a worktree-isolated agent in parallel with the frontend work to compress the timeline.

## Goal

1. **Chat lives as a tab next to the existing Instances table** in the list layout. Same physical region, switch via tab strip. Persistent across the session — history doesn't reset when the user clicks elsewhere.
2. **The palette executes real synchronous actions** against the viewer's existing state (color, filter, layout, dark mode, navigation). No more chat in the palette body.
3. **Chat answers cite paper sources** as DOI/arxiv/pmid markdown links — citation provenance is the Forgewright differentiator. Detection is lenient (any of `doi`, `paper_id`, `arxiv_id`, `pmid`, `url`, `title`, …) for the prototype; harden once validated end-to-end.

## Architecture

### Why list-layout-tabs (not a sidebar)

The list layout already has three named sections (`ListLayout.svelte:3-33`): `embedding`, `table`, `chart`. The "table" section renders any chart with `spec.type === "instances"`. Adding a tab strip *inside the existing table section* gives the user exactly the [Table | Chat] toggle they described, with zero impact on the embedding view above. Dashboard layout doesn't have a fixed bottom region — chat is **list-only** in v1; in dashboard mode the chat tab is simply absent (no fallback hint — the user said they don't drive dashboard layout, so spending time on a discovery affordance there isn't worth it for the demo).

### Why a Command registry (not 18 MCP tools)

The 18 tools registered at `model_context/model_context.ts:34-326` are for *external* agents driving the viewer. For an in-process palette, we just call the same Svelte state setters directly. A tiny `Command` registry (label + run callback) is ~30 lines and avoids the MCP round-trip.

## Workstream A — Chat tab next to the table

### Files

- **NEW** `packages/viewer/src/widgets/ChatPanel.svelte` — wraps the existing `ChatView` with a small header bar containing: (a) a row-count badge ("247 rows selected" / "All rows"), (b) a "Clear chat" button that resets `chatTurns` to `[]`. No close affordance — switching tabs is the close. No predicate text in the header (refine later).
- **MODIFY** `packages/viewer/src/layouts/list/ListLayout.svelte` — replace the table section's contents with a tabbed container when `chatEndpoint != null`. Tab state lives in `ListLayoutState.tableTab: "table" | "chat"` (default `"table"`).
- **MODIFY** `packages/viewer/src/layouts/list/types.ts` — add `tableTab` to `ListLayoutState`.
- **NEW** `packages/viewer/src/layouts/list/TableTabBar.svelte` — small two-tab toggle, styled to match `widgets/SegmentedControl.svelte`.
- **MODIFY** `packages/viewer/src/EmbeddingAtlas.svelte` — pass `chatEndpoint` and the chat-context object (predicate, table, text_column) into the layout context so `ListLayout` can wire ChatView. State of `turns` (chat history) lifts up to `EmbeddingAtlas` so it survives layout changes.
- **MODIFY** `packages/viewer/src/widgets/ChatView.svelte` — accept `turns` as a `$bindable` prop instead of owning local state, so history persists. Auto-focus textarea on mount stays.

### Shared chat state

ChatView currently owns its `turns` state. We lift it to `EmbeddingAtlas.svelte`:

```svelte
let chatTurns = $state<Turn[]>([]);
```

Pass it via context (or prop drill into ListLayout → ChatPanel → ChatView). On layout switch (list ↔ dashboard) the array stays alive. On full-page reload it resets — that's fine for v1; persistence is future work.

### Tab UI

```
┌─ Instances section ───────────────┐
│ [Table] [Chat]    rows: 247       │
├───────────────────────────────────┤
│  (currently active panel)         │
│                                   │
└───────────────────────────────────┘
```

Tabs are visually small (matches existing toolbar). Row count is the same `FilteredCount` already used in the toolbar.

The tab strip lives at the top of the table section in `ListLayout.svelte` (the section currently rendered at lines 141–153 that maps `sections.table` → `chartView`). When `tableTab === "chat"`, the entire `chartView` render of the Instances chart is replaced by `ChatPanel`. The Instances component itself (with its inner Table/Card SegmentedControl shown in the inspector dump) is untouched — we just swap whether it's rendered.

Width: the chat panel inherits the table section's width naturally. The right-sidebar `Resizer` (`ListLayout.svelte:157–166` with `panelWidth`) already controls the table's available width, so dragging the right edge resizes the chat panel the same way it resizes the table today.

### Empty-selection behavior

When the user has no selection (predicate is `null`), the chat tab still allows asking. Questions answered against the full dataset. The header reads "All rows" rather than nudging the user to select. (Refining the chat UX itself — better empty state, keyboard shortcuts, message-level provenance — is deferred.)

### What happens to ⌘K

⌘K still opens the palette but the palette body is now the command list (Workstream B), not chat. **No new keybinding for chat** — the tab is a click affordance. If keyboard access is needed later, ⌘\\ is a clean choice (no browser conflict).

## Workstream B — Real palette commands

### Files

- **NEW** `packages/viewer/src/commands/builtin.ts` — exports a `buildCommands(args)` function that returns `Command[]` based on current viewer state. Pure factory.
- **MODIFY** `packages/viewer/src/widgets/CommandPalette.svelte` — accept `commands: Command[]` prop, render them via cmdk-sv `<Command.Item>`. Body snippet is gone.
- **MODIFY** `packages/viewer/src/EmbeddingAtlas.svelte` — call `buildCommands` with current state (columns, layout, color scheme, crossFilter, charts, embedding chart id), pass to palette.

### Command shape

```ts
interface Command {
  id: string;
  label: string;
  group?: "View" | "Filter" | "Color" | "Chat" | "Export";
  hint?: string;             // shortcut-style right-side text
  run: () => void | Promise<void>;
}
```

### v1 commands

| Group | Label | Action |
|---|---|---|
| View | Switch to dashboard layout | `layout = "dashboard"` |
| View | Switch to list layout | `layout = "list"` |
| View | Toggle dark mode | flip `$userColorScheme` |
| View | Show/hide chat tab | `chatTab = chatTab === "chat" ? "table" : "chat"` |
| Filter | Clear all filters | `resetFilter()` (already at `EmbeddingAtlas.svelte:217-223`) |
| Color | Color embedding by `<column>` × N | mutate the embedding chart spec: `charts[embId].data.category = column` (per explorer report — `Embedding.svelte:286` is the existing inline call site). Filter columns to **2 ≤ distinct values ≤ 50** so the palette stays useful on wide schemas; numeric columns are excluded. Distinct counts come from a one-time DuckDB introspection at viewer init (cached). |
| Export | Export selection as JSON / CSV / Parquet | call `onExportSelection(currentPredicate(), format)` (already exists) |

The Color group expands per non-numeric column. cmdk's substring filter handles "color domain" → "Color embedding by domain" naturally.

**Skipped for v1, mentioned only:** filter-by-value commands (need a 3-step flow column→op→value) and add-chart commands (require a column picker). Those land in Workstream B-2 if there's time.

### Recolor mechanics

Embedding chart's color column is at `charts[id].data.category` (per explorer at `Embedding.svelte:71` and `:286`). The palette command does:

```ts
const embId = Object.entries(charts).find(([_, s]) => s.type === "embedding")?.[0];
if (embId) {
  charts = { ...charts, [embId]: { ...charts[embId], data: { ...charts[embId].data, category: column } } };
}
```

This triggers Svelte reactivity through the existing `onChartsChange` plumbing in `EmbeddingAtlas.svelte`.

## Workstream C — Citation surfacing

### File

- **MODIFY** `packages/backend/embedding_atlas/chat.py` — extend `_build_system_prompt` to detect citation-shaped columns and instruct the model.

### Citation detection

In `_build_system_prompt`, after the sample is built, detect citation columns leniently — any of `{doi, paper_id, arxiv_id, pmid, pmcid, url, title, authors, year}` is enough to flip into "citation mode":

```python
CITATION_KEYS = {"doi", "paper_id", "arxiv_id", "pmid", "pmcid", "url", "title", "authors", "year"}
citation_cols = {k for k in (sample[0].keys() if sample else []) if k.lower() in CITATION_KEYS}
if citation_cols:
    # Tell the model what it has and how to cite. Specific instruction depends on
    # which columns are present — DOI gets priority, then arxiv_id, then url, then title-only.
    ...
```

The instruction text branches on what's available:
- If `doi` present → `[Title](https://doi.org/{doi})`
- Else if `arxiv_id` → `[Title](https://arxiv.org/abs/{arxiv_id})`
- Else if `pmid` → `[Title](https://pubmed.ncbi.nlm.nih.gov/{pmid}/)`
- Else if `url` → `[Title]({url})`
- Else (title only) → bold-quote the title

ChatView already renders markdown via `marked` + `DOMPurify`, so the links render and click through.

**Hardening (post-prototype TODO, file as follow-up):** the lenient detection is a placeholder. Once the new design is validated end-to-end, revisit:
- A configurable `citation_columns` list in the metadata so non-paper datasets don't get accidentally citation-shaped (e.g. a dataset with a `title` column that means something else).
- Per-row citation rendering — surface DOIs as inline pill chips in ChatView rather than markdown links, with hover preview of authors/year.
- A "Sources" footer that aggregates citations across a response so users get a quick scan-list.

**Skipped for v1:** the per-row pills, sources footer, and metadata config above. System-prompt-only is the prototype.

## Critical files

| Action | Path |
|---|---|
| NEW | `packages/viewer/src/widgets/ChatPanel.svelte` |
| NEW | `packages/viewer/src/layouts/list/TableTabBar.svelte` |
| NEW | `packages/viewer/src/commands/builtin.ts` |
| MODIFY | `packages/viewer/src/EmbeddingAtlas.svelte` (chat state lift, command-list build, palette refactor) |
| MODIFY | `packages/viewer/src/widgets/CommandPalette.svelte` (accept `commands` prop, drop chat body) |
| MODIFY | `packages/viewer/src/widgets/ChatView.svelte` (`turns` becomes `$bindable`) |
| MODIFY | `packages/viewer/src/layouts/list/ListLayout.svelte` (tabbed table section) |
| MODIFY | `packages/viewer/src/layouts/list/types.ts` (add `tableTab` field) |
| MODIFY | `packages/backend/embedding_atlas/chat.py` (citation system-prompt) |

## Build sequence

0. **Branch + plan in repo.** Cut `feat/chat-tab-palette-v2` from `main`. Create `ideas/chat-tab-palette-v2.md` (mirror of this file). Commit. Update the in-repo plan as each step below completes (mark step as ✅ + one-line notes on anything that surprised us).
1. **Lift chat state to `EmbeddingAtlas.svelte`** — ChatView gets `bind:turns`, smoke-test by opening palette twice (today's path) and confirming history persists.
2. **Add tabbed table section in ListLayout** — feature-flag with `chatEndpoint != null`. Render existing `Instances` chart in the Table tab; render `ChatPanel` in the Chat tab.
3. **Refactor CommandPalette** — accept `commands` prop, render command list; drop the body snippet. Wire 4 simple commands (toggle dark, toggle layout, clear filter, toggle chat tab) in `EmbeddingAtlas.svelte`.
4. **Add color-by commands** — generate one per categorical column with 2 ≤ distinct ≤ 50 (via DuckDB introspection cached at init).
5. **Citation system-prompt** — chat.py edit, no rebuild needed (backend-only change).
6. **Polish pass** — first-tab focus, empty-state copy, dashboard-mode chat-tab hidden behavior.

### Parallelization

Step 5 (citation system-prompt, backend-only Python edit) is independent of every frontend step. Run it in a parallel worktree-isolated agent alongside steps 1–2 to compress the timeline:

- Main session does steps 0 → 1 → 2 → 3 → 4 → 6 sequentially.
- A worktree-isolated agent (`isolation: "worktree"`) runs step 5 in parallel, branched off the same `feat/chat-tab-palette-v2` base. When it finishes, merge its commit into the working branch.

Steps 3 and 4 are *also* parallelizable (palette refactor + command list construction touch the same files but different sections), but the gain is small and the merge risk isn't worth it — keep those sequential in the main session.

## Verification

- All work happens on `feat/chat-tab-palette-v2`.
- `npm run check` and prettier pass on every step (run from repo root).
- Manual against the v1830 dataset at `/Users/mlombardo/Documents/dev/hackathon-2026/data/snapshots/v1830_clustered/atlas.parquet` (path observed in the inspector dump). Start the dev server with `--chat`, open the viewer in the browser:
  - Open list layout. Table section shows `[Table] [Chat]` tabs. Default = Table. Click Chat — chat panel renders, header shows row-count badge ("All rows" if no selection) + Clear chat button.
  - Lasso a region in embedding view. Chat header badge updates ("247 rows selected"). Send "summarize this cluster". Response includes DOI markdown links that resolve to real papers.
  - Send a follow-up. Click Table tab, lasso a different region, click Chat — original conversation is still there (history persisted across tab switches).
  - Switch layout to Dashboard via toolbar. Chat tab hidden (no fallback hint — user is unlikely to discover this path). Switch back to List — chat tab returns with history intact.
  - ⌘K opens palette. Type "color" — see "Color embedding by domain", "Color embedding by primary_corpus", etc. (only categorical cols with ≤50 distinct values). Hit enter — embedding recolors. Palette closes.
  - ⌘K → "dark" → toggle. ⌘K → "clear" → filter reset. ⌘K → "chat" → tab toggles between table and chat.
  - With no chat endpoint configured, the Chat tab is absent (table is the whole bottom section as today).

## Out of scope

- Tabbed bottom region in dashboard layout (chat hidden in dashboard for v1; no fallback hint).
- Chat history persisted across full-page reloads.
- MCP tool bridge from direct chat path (still planned but separate work item).
- Filter-by-value and add-chart palette commands (planned as Workstream B-2 if time).
- Citations footer / aggregated sources block / inline citation pills (system-prompt-only for v1).
- Hardening of citation column detection — configurable allowlist in metadata, etc. — filed as a follow-up after the prototype is validated end-to-end.
- Forgewright primitive tools as agent capabilities (separate work item, lands when Stage 4-5 artifacts are ready).
- Chat UX refinements (better empty state, message-level provenance, keyboard shortcuts inside the panel).

## Progress log

Update as each step completes — mark ✅ and add one-line notes on anything that surprised us.

- [x] **Step 0** — branch `feat/chat-tab-palette-v2` cut from `main`; this plan committed to the repo.
- [x] **Step 1** — lift chat `turns` state to `EmbeddingAtlas.svelte`. *(commit `ca16474`)* `ChatTurn`/`ChatToolCall` types moved to `chat_client.ts` for sharing.
- [x] **Step 2** — tabbed table section in `ListLayout`. *(commit `a786615`)* Used a Svelte context (`utils/chat_context.ts`) to share endpoint + dynamic predicate getter + lifted turns state — cleaner than prop-drilling through generic `LayoutProps`. ChatPanel header runs its own mosaic client for the row-count badge so it tracks the Selection without extra plumbing.
- [ ] **Step 3** — `CommandPalette` accepts `commands[]`; 4 simple commands wired.
- [ ] **Step 4** — color-by commands (categorical cols, ≤50 distinct).
- [x] **Step 5** — citation system-prompt in `chat.py` *(parallel worktree agent, commit `1f5321e`)*. Detection in `_build_system_prompt`; new `_citation_instruction` helper picks link template by priority. 8 new tests in `packages/backend/tests/test_chat.py`; full `pytest` green (151 passed).
- [ ] **Step 6** — polish + verification.
