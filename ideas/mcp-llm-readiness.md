# MCP API Design for LLM Consumers

## Context

The viewer's MCP server (`packages/viewer/src/model_context/model_context.ts`, `packages/viewer/src/app/mcp_server.ts`) was originally designed for *external programmatic clients*: Claude Code, scripts using the MCP SDK, automation pipelines. With the chat bridge (`feat/chat-mcp-bridge`), an in-process LLM became a first-class consumer of the same surface, and a class of design mismatches surfaced that the explicit-caller assumption had been hiding.

The friction points aren't bugs in the existing tools — they're symptoms of an API designed for a precise caller now serving an inferential one. As the product surfaces more LLM-driven workflows (chat, Forgewright primitives, agent-driven exploration), this mismatch will keep producing the same shape of surprise unless the underlying conventions evolve.

This document captures the design philosophy and lists concrete recommendations. It is **not a blocker** for the chat bridge work or any current feature — it is the rubric for evaluating MCP tool additions and tool-design changes going forward.

## The fundamental tension

Programmatic clients and LLM clients consume MCP tools with very different default behaviors:

| Aspect | Programmatic client | LLM client |
|---|---|---|
| Tool semantics | Replace is fine — caller is precise | Merge by default — caller is approximate |
| Tool descriptions | Brief, schema-implied | Detailed, intent-preserving, with examples |
| Field omission | Means "delete this field" | Means "I forgot to mention it" |
| Error responses | Machine-parsed status codes | Natural-language, actionable |
| Destructive operations | Direct, caller takes responsibility | Need confirmation / preview / dry-run |
| Tool selection | Caller knows which tool to use | Model picks based on description; vague descriptions get wrong picks |
| Schema strictness | Tight schemas catch errors early | Tight schemas frustrate; permissive + validated is better |

Designing for one client at the expense of the other is a real cost; the goal is conventions that **work well enough for both** while explicitly favoring LLM-friendliness when conflicts arise.

## Specific patterns observed (case study from the chat bridge)

These are the actual issues that surfaced during chat-bridge verification. They are emblematic, not exhaustive.

### 1. Replace-not-merge semantics in `set_*` tools

Four tools currently replace state wholesale where merge would be safer:

- `set_chart_spec` (`model_context.ts:170`)
- `set_chart_state` (`:205`)
- `set_layout_state` (`:319`)
- `set_column_style` (similar pattern, per-column)

When the LLM patches one field of a chart spec (e.g., changing `data.category`), it has to reconstruct the entire spec correctly to preserve the other fields. In practice it adds "improvements" — bigger pointSize, rewritten title, explicit nulls for absent fields — that the user never asked for. The dropdown UI in the same component uses *merge* semantics, which is why direct user interaction doesn't have this problem.

**Fix:** swap to merge semantics using the existing `mergeUpdates` helper from `@embedding-atlas/utils`. Backward-compatible for callers that already include the full spec. Setting a field to `undefined` is the explicit "delete" path (which `mergeUpdates` already supports).

### 2. Vague tool descriptions inviting "improvement"

`set_chart_spec.description` is currently `"Update the specification of a chart"`. The LLM, lacking explicit instruction otherwise, treats this as "redesign" and feels licensed to add unrequested fields. The same pattern shows up in `add_chart` (vague `spec` param), `set_layout_state` (inline schema docs the model has to parse), and others.

**Fix:** descriptions should explicitly state intent-preservation expectations and provide concrete examples per common use case. For example:

```
"Update specific fields of a chart's specification. Only fields you explicitly want
to change should be included in `spec`. Other fields will be preserved.
Example — recolor an embedding by a new column:
  { id: '1', spec: { data: { category: 'domain' } } }
Do not include fields the user did not ask about (mode, pointSize, title, etc.)."
```

### 3. Schema vagueness in `add_chart`

`add_chart` accepts `spec: { type: "object" }` with the actual chart spec schema buried in a JSON-stringified description. The LLM has to parse the description text to understand what's valid. It often guesses, and when it guesses wrong, the validation error doesn't tell it which valid example to follow.

**Fix:** consider per-chart-type tools (`add_histogram`, `add_count_plot`, `add_embedding`) with strict, narrow schemas — easier for the LLM to call correctly and for the validator to give useful errors. Keep `add_chart` for advanced cases.

### 4. Destructive tools without preview

`delete_chart` and `clear_chart_state` execute immediately. An LLM that misunderstands ("clean up the view") can wipe state with no recovery path other than the user noticing.

**Fix:** introduce a preview/confirmation pattern for destructive operations. Either:
- A two-step flow: tool returns "would delete X, Y, Z; call again with `confirm: true` to proceed"
- A bridge-level guardrail that intercepts destructive calls and surfaces them as user-confirmable actions in the chat UI
- Per-session allowlist that the user opts into when the chat starts

For deployment, this becomes more important — multi-user means a misbehaving session can damage state others depend on.

### 5. Hidden side effects of innocuous tool calls

`set_chart_spec` with a category change triggers a SQL `ALTER TABLE` on the dataset (adding `__ev_<col>_id` for the categorical mapping). The LLM has no signal that this is happening; nor does the user. Usually fine, but means substantial dataset state mutation can occur from what looks like a UI-only operation.

**Fix:** not really fixable at the tool level — but documenting it matters. Tools that have side effects beyond their stated scope should say so in their description, both for human consumers and so the LLM can warn the user when relevant.

### 6. Tool selection by inference, not by call

The LLM picks tools by reading their `description`s and matching to user intent. When two tools have overlapping purposes (e.g., `set_chart_spec` vs. a hypothetical `set_chart_field`), or when the description doesn't make the boundary clear, the LLM picks wrong. We saw this with `run_sql_query` — there are two of them in the system: a viewer-side MCP one (param: `query`) and a Python-side direct-mode fallback (param: `sql`). The model can call either depending on what's exposed, with subtly different behavior.

**Fix:** unique tool names with non-overlapping descriptions. When multiple tools could satisfy a user request, the descriptions should explicitly say when to prefer one over the other.

### 7. Validation feedback that the LLM can act on

`validate(params.spec, schemaBuiltinChartSpec)` returns errors like `[{ keyword: "additionalProperties", ... }]`. The LLM sees the JSON-Schema-encoded error and often can't translate it into "ah, I should drop the `extra_field` key." Too many validation iterations and the loop hits MAX_TOOL_ITERATIONS without progress.

**Fix:** wrap validation errors in natural-language hints + a snippet of the valid shape. `"Field 'extra_field' is not allowed. The valid shape for an embedding spec is: {...}"`.

## Recommended conventions

### For new MCP tools

When adding a new tool, before declaring it ready:

1. **Default to merge over replace** for any tool that updates existing state.
2. **Write the description for an LLM caller**: include intent-preservation language, a concrete example call, and a note about what *not* to do.
3. **Surface side effects** in the description if they extend beyond the stated scope.
4. **Provide actionable error messages** — when validation fails, tell the model what to change.
5. **For destructive operations**, build in a preview / confirm pattern unless the user has explicitly authorized direct execution.
6. **Strict schemas with permissive validation** — define the shape clearly but emit useful errors rather than rejecting outright.
7. **Unique, non-overlapping descriptions** — if two tools could satisfy the same request, say which to prefer when.

### For refactoring existing tools

The four `set_*` tools above are the immediate candidates. Other current tools that should be reviewed against this checklist:

| Tool | Concern |
|---|---|
| `add_chart` | Schema vagueness; consider per-chart-type variants |
| `delete_chart` | Destructive without preview |
| `clear_chart_state` | Destructive without preview |
| `set_chart_spec` | Replace semantics + vague description (case study above) |
| `set_chart_state` | Replace semantics |
| `set_layout_state` | Replace semantics + schema in description |
| `set_column_style` | Replace per-column |
| `set_layout_type` | Fine — atomic value, no merge needed |

The first iteration of this hardening can be just the four merge-semantics fixes; descriptions and destructive-op guardrails can land incrementally.

## Acceptance criteria for "LLM-ready"

A tool is LLM-ready when:

- **A model can call it with partial input** and get the user's intent reflected in the result — no unrequested side effects, no silent dropping of unmentioned state.
- **A model can recover from a validation error** in one or two follow-up calls, guided by the error message.
- **A model knows when to use this tool vs. a sibling tool** from the description alone.
- **Destructive operations have a recovery path** or require explicit confirmation before execution.

## Out of scope (this document)

- Specific tool descriptions — they're going to evolve per-tool; the conventions above are the rubric.
- Multi-user / auth concerns — covered in `ideas/chat-mcp-bridge-deploy.md`.
- The chat bridge itself — covered in `ideas/chat-mcp-bridge.md`.
- Implementation sequencing — pick from the candidate list above based on user-observed pain.

## Sequencing recommendation

1. **Now (this branch)**: merge semantics for the four `set_*` tools. ~15 minutes; eliminates the "LLM goes off-script" class for the most-used tools.
2. **Next branch**: tool description tightening. Per-tool, can be done incrementally as we observe model behavior.
3. **Later**: per-chart-type creation tools, destructive-op preview pattern, validation error wrapping. These are more substantial workstreams that can be sequenced based on which pain shows up first in real use.
