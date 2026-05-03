# Issue: Dedicated MCP tools for view filtering (`apply_filter` / `clear_filter`)

> Draft GitHub issue. Publish via `gh issue create --title "..." --body-file ideas/issue-mcp-filter-tools.md` when ready (strip this header line first).

## Summary

Add two MCP tools — `apply_filter(name, predicate)` and `clear_filter()` — that wrap the two-step "edit predicates chart spec → activate via state" pattern with a single, intent-named call. Improves LLM tool-call reliability and matches the design conventions in `ideas/mcp-llm-readiness.md`.

## Background

The viewer already has a fully-functional view-wide filtering mechanism via the **predicates chart** (`packages/viewer/src/charts/basic/Predicates.svelte`). When `chartStates.<predicates-chart-id>.selection` contains predicate strings, those clauses get pushed to the Mosaic crossfilter, filtering every linked chart and the Instances table.

Today an MCP client (chat or external agent) can drive this — but only by:

1. Calling `list_charts` to find the predicates chart id (usually `"2"`)
2. Calling `set_chart_spec` to add a named item to `spec.items`
3. Calling `set_chart_state` to mark that predicate as active in `state.selection`

That's three round-trips and forces the model to discover the chart-id-by-type pattern. The chat-bridge system prompt now instructs models on the pattern (commit landed alongside this issue draft), but **per the LLM-readiness design doc, task-specific tools are strictly better than chained generic ones** — the model is more reliable when the tool name matches user intent.

## Proposed solution

### `apply_filter`

```yaml
name: apply_filter
description: |
  Apply a SQL WHERE predicate as a named filter on the whole view. All
  charts and the Instances table will filter to rows matching this
  predicate. Multiple filters are OR-joined.
  Example: { name: "ESM2 papers", predicate: "list_contains(tools_used, 'ESM2')" }
inputSchema:
  type: object
  properties:
    name:
      type: string
      description: Short human-readable label shown in the predicates panel.
    predicate:
      type: string
      description: SQL WHERE expression (e.g., "year > 2023" or "domain = 'antibody'").
  required: [name, predicate]
  additionalProperties: false
```

Implementation:
- Find the first chart with `type: "predicates"` in `delegate.charts`. If none, create one (or error — see open question below).
- Add `{ name, predicate }` to `spec.items` (deduplicating on `predicate` to avoid stacking duplicates).
- Add `predicate` to `state.selection`.
- Both updates go through `mergeUpdates` for safety with the merge-semantics fix.
- Validate the predicate by running a `COUNT(*) WHERE <predicate>` query first — return `{ error: "Invalid predicate", details }` if it fails before mutating state.

### `clear_filter`

```yaml
name: clear_filter
description: |
  Remove all active view-wide filters. Charts and the Instances table
  return to showing the whole dataset. Does not delete the saved
  predicate items, only deactivates them.
inputSchema:
  type: object
  properties:
    name:
      type: string
      description: |
        Optional. If given, only clear the filter with that name. Otherwise
        clear all active filters.
  additionalProperties: false
```

Implementation:
- Find predicates chart.
- If `name` provided, find the item with that name and remove its predicate from `state.selection`.
- Otherwise set `state.selection = []`.

## Acceptance criteria

- A chat user can say *"filter to ESM2 papers"* and the model calls `apply_filter` exactly once. Verified by inspecting the SSE event stream.
- *"Clear all filters"* triggers a single `clear_filter()` call.
- *"Filter to 2024 papers and antibody domain"* results in either two `apply_filter` calls or a single one with a compound predicate; both work and the view filters correctly.
- The predicates chart UI shows the model-applied filter as a labeled checkbox (so users can toggle / inspect / remove it manually).
- Predicates failing SQL validation return a clear error to the model with details about the failure (no silent crash).
- Existing tests pass; new unit tests in `packages/backend/tests/` cover the bridge translation of `apply_filter` / `clear_filter` calls.
- The chat system prompt's `filter_hint` is replaced with a one-line "Use `apply_filter` to filter the view" — much shorter, since the tool name carries the intent.

## Out of scope

- AND-composition of multiple filters (the predicates chart joins by OR; AND requires building a single predicate string with `AND` operators).
- A dedicated UI for showing model-applied filters distinctly from user-applied filters in the predicates panel.
- Saving/loading filter sets as named groups.
- Filter-by-row-id selection (use the embedding chart's `brush` state instead).

## Open questions

1. **What if no predicates chart exists?** Options: (a) auto-create one via `add_chart`, (b) return an error ("no predicates chart found — add one with add_chart first"). Auto-creation is friendlier; error is more conservative.
2. **Should the model be able to add filters that AND-compose?** Today's predicates chart only OR-joins selections. To get AND, the model has to construct a single compound predicate. Document this limitation in the tool description.
3. **Should `apply_filter` also clear other active filters by default**, or stack? Stacking matches the predicates panel's behavior (multiple checkboxes can be active). Clearing matches a simpler "show me X" mental model. Lean toward stacking + a `replace: bool` parameter for users who want the simpler semantics.

## Effort estimate

- Tool implementations: ~50 lines in `model_context.ts` (mostly the predicate-validation step).
- Tests: ~50 lines.
- Description tightening across `set_chart_spec` and `set_chart_state` to mention the new tool when the user means "filter": ~10 lines.
- System prompt simplification: ~10 lines.
- **Total: ~2-3 hours including review and verification with the v1830 dataset.**

## Related

- `ideas/mcp-llm-readiness.md` (the design philosophy)
- `ideas/chat-mcp-bridge.md` (the bridge work that surfaced this need)
- `packages/viewer/src/charts/basic/Predicates.svelte` (existing implementation)
