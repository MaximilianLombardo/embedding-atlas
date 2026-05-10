<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Per-column header filter popover. Shows top-N distinct values
  (categorical columns only for v1) with checkboxes; selecting any
  publishes a `column IN (selected)` predicate to `context.filter`
  via a stable per-column source object so each column's filter
  composes (Mosaic Selection union) with everything else and stays
  independently revocable.

  Numeric/date columns: out of scope for v1 — we render a placeholder
  message and steer the user to the Predicates panel. Adding a
  numeric range slider here is a follow-up.
-->
<script lang="ts">
  import type { Coordinator, Selection } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";

  import PopupButton from "../../widgets/PopupButton.svelte";

  import { IconCheck, IconFilter } from "../../assets/icons.js";
  import type { ColumnDesc } from "../../utils/database.js";

  // Sentinel for SQL NULL — used in the `selected[]` array to
  // distinguish "user picked the (null) row" from "user picked the
  // string 'null'." Without this, String(null) → "null" collides with
  // a real string value of "null" and the predicate sends
  // `col IN ('null')`, which never matches actual NULL rows.
  // The `\0` null-byte makes accidental collision with real data
  // effectively impossible (it can't appear in a JS string from a
  // SQL result via the standard transports).
  const NULL_SENTINEL = "\0__NULL__\0";

  interface Props {
    column: string;
    columnDesc: ColumnDesc | undefined;
    /** Mosaic coordinator (from ChartContext). */
    coordinator: Coordinator;
    /** Dataset table name. */
    table: string;
    /** Cross-filter selection to publish predicates to. */
    filter: Selection;
    /**
     * Stable per-column source object (owned by the parent so its
     * identity persists across popover open/close). Mosaic Selection
     * uses source identity to attribute clauses; reusing the same
     * source object replaces the existing clause; `null` predicate
     * removes it.
     */
    source: object;
    /** Currently active selected values for this column (echoed back from parent). */
    selected: string[];
    /** Called whenever the user changes the selection. */
    onSelectionChange: (values: string[]) => void;
  }

  let { column, columnDesc, coordinator, table, filter, source, selected, onSelectionChange }: Props = $props();

  // svelte-ignore state_referenced_locally
  let distinctValues = $state.raw<{ value: any; count: number }[] | "loading" | "error">("loading");
  // Total distinct count fetched alongside the top-100 list. When this
  // exceeds the displayed length, we render a "showing top N of M"
  // notice so users know the list is truncated.
  let totalDistinctCount = $state.raw<number | null>(null);

  // Categorical-only for v1: jsType "string" or "list" (array). Numbers/dates
  // get a placeholder until a numeric-range follow-up.
  let jsType = $derived(columnDesc?.jsType);
  let isCategorical = $derived(jsType === "string" || jsType === "string[]");
  let active = $derived(selected.length > 0);

  // True when the displayed list is a strict subset of the column's
  // distinct values — the user might have selected something not
  // visible here, so we hint at it.
  let truncated = $derived(
    Array.isArray(distinctValues) && totalDistinctCount != null && totalDistinctCount > distinctValues.length,
  );

  // Fetch distinct values lazily when the popover opens. Cached locally
  // — if the user reopens the popover later, we keep the previously
  // fetched list rather than re-querying.
  // svelte-ignore state_referenced_locally
  let fetched = false;
  async function fetchDistinct() {
    if (fetched) return;
    if (!isCategorical) {
      distinctValues = "error";
      return;
    }
    fetched = true;
    distinctValues = "loading";
    try {
      // For list-typed columns, unnest first so each element gets its
      // own count. For string columns, group directly.
      const colExpr = jsType === "string[]" ? SQL.sql`UNNEST(${SQL.column(column)})` : SQL.column(column);
      // Two queries in parallel: top-100 distinct values by count, plus
      // the total distinct count for the truncation indicator.
      const valuesQ = SQL.Query.from(table)
        .select({ value: colExpr, count: SQL.count() })
        .groupby("value")
        .orderby(SQL.desc("count"))
        .limit(100);
      const totalQ = SQL.Query.from(table).select({
        total: SQL.sql`COUNT(DISTINCT ${colExpr})`,
      });
      const [valuesResult, totalResult]: any[] = await Promise.all([
        coordinator.query(valuesQ),
        coordinator.query(totalQ),
      ]);
      distinctValues = (valuesResult.toArray() as any[]).map((r) => ({ value: r.value, count: Number(r.count) }));
      totalDistinctCount = Number(totalResult.toArray()[0]?.total ?? distinctValues.length);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("HeaderFilterPopover query failed", e);
      distinctValues = "error";
    }
  }

  // Encode a value for the `selected` string array. Null/undefined map
  // to NULL_SENTINEL so they survive the round trip (otherwise
  // String(null) collides with a real "null" string value).
  function encode(v: any): string {
    return v == null ? NULL_SENTINEL : String(v);
  }

  function isSelected(v: any): boolean {
    return selected.includes(encode(v));
  }

  function toggle(v: any) {
    const s = encode(v);
    const next = selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s];
    publish(next);
  }

  function clearAll() {
    publish([]);
  }

  function publish(values: string[]) {
    onSelectionChange(values);
    // Build predicate. Empty selection → null predicate (removes the clause).
    if (values.length === 0) {
      filter.update({
        source,
        clients: new Set(),
        predicate: null,
        value: null,
      });
      return;
    }
    // Split the selection into a real-values list and a "user picked
    // (null)" flag. The two need different SQL: `col IN (...)` for
    // real values, `col IS NULL` for null. If both, OR them.
    const includeNull = values.includes(NULL_SENTINEL);
    const realValues = values.filter((v) => v !== NULL_SENTINEL);

    let expr: any;
    if (jsType === "string[]") {
      // For list columns: list_has_any(col, [...]) for the real values,
      // OR `col IS NULL` if the user picked (null). list_has_any is
      // null-safe (returns false on a NULL list), so we have to add the
      // NULL branch explicitly.
      const realExpr = realValues.length
        ? SQL.sql`list_has_any(${SQL.column(column)}, [${realValues.map((v) => SQL.literal(v)).join(", ")}])`
        : null;
      const nullExpr = includeNull ? SQL.sql`${SQL.column(column)} IS NULL` : null;
      expr = realExpr && nullExpr ? SQL.sql`(${realExpr}) OR (${nullExpr})` : (realExpr ?? nullExpr);
    } else {
      const realExpr = realValues.length
        ? SQL.isIn(SQL.column(column), realValues.map((v) => SQL.literal(v) as any))
        : null;
      const nullExpr = includeNull ? SQL.sql`${SQL.column(column)} IS NULL` : null;
      expr = realExpr && nullExpr ? SQL.sql`(${realExpr}) OR (${nullExpr})` : (realExpr ?? nullExpr);
    }

    filter.update({
      source,
      clients: new Set(),
      predicate: expr as any,
      value: values.join(","),
    });
  }
</script>

<PopupButton
  title={isCategorical ? `Filter ${column}` : `Filter not available for ${column}`}
  anchor="left"
>
  {#snippet button({ visible, toggle: t })}
    <button
      type="button"
      class="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition"
      class:text-blue-500={active}
      class:dark:text-blue-400={active}
      class:text-slate-300={!active}
      class:dark:text-slate-600={!active}
      title={isCategorical ? `Filter ${column}` : `Filter not available for ${column}`}
      onclick={(e) => {
        e.stopPropagation();
        if (!fetched && isCategorical) fetchDistinct();
        t();
        void visible;
      }}
    >
      <IconFilter />
    </button>
  {/snippet}
  <div class="flex flex-col gap-1 max-h-[60vh] overflow-y-auto min-w-64">
    <div class="flex items-center justify-between px-2 py-1">
      <div class="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">Filter {column}</div>
      {#if active}
        <button
          type="button"
          class="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-1"
          onclick={clearAll}
        >
          Clear
        </button>
      {/if}
    </div>
    {#if !isCategorical}
      <div class="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
        Filtering this column type isn't supported here yet — try the SQL Predicates panel for richer filters.
      </div>
    {:else if distinctValues === "loading"}
      <div class="px-2 py-2 text-xs text-slate-400 dark:text-slate-500">Loading…</div>
    {:else if distinctValues === "error"}
      <div class="px-2 py-2 text-xs text-amber-600 dark:text-amber-400">Couldn't load values for this column.</div>
    {:else}
      {#each distinctValues as { value, count } (encode(value))}
        <button
          type="button"
          class="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-left text-sm text-slate-700 dark:text-slate-200"
          onclick={() => toggle(value)}
        >
          <span
            class="inline-flex items-center justify-center w-4 h-4 rounded border flex-shrink-0"
            class:border-blue-500={isSelected(value)}
            class:bg-blue-500={isSelected(value)}
            class:dark:bg-blue-600={isSelected(value)}
            class:dark:border-blue-600={isSelected(value)}
            class:border-slate-300={!isSelected(value)}
            class:dark:border-slate-600={!isSelected(value)}
          >
            {#if isSelected(value)}
              <IconCheck class="w-3 h-3 text-white" />
            {/if}
          </span>
          <span class="truncate flex-1 min-w-0" class:italic={value == null} class:text-slate-400={value == null}>
            {value == null ? "(null)" : value}
          </span>
          <span class="text-xs text-slate-400 dark:text-slate-500 flex-shrink-0">{count.toLocaleString()}</span>
        </button>
      {/each}
      {#if truncated}
        <div
          class="px-2 py-1.5 mt-1 text-[11px] italic text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-700"
        >
          Showing top {(distinctValues as { value: any; count: number }[]).length} of
          {totalDistinctCount?.toLocaleString()} distinct values.
        </div>
      {/if}
    {/if}
  </div>
</PopupButton>
