<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { deepEquals, interactionHandler } from "@embedding-atlas/utils";
  import { makeClient, type Coordinator, type Selection, type SelectionClause } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";

  import InlineSelect from "../../widgets/InlineSelect.svelte";
  import Container from "../common/Container.svelte";
  import CountPlotBar from "./CountPlotBar.svelte";

  import type { ChartViewProps } from "../chart.js";
  import { resolveChartTheme } from "../common/theme.js";
  import type { SQLField } from "../spec/spec.js";
  import type { CountPlotSpec, CountPlotState } from "./types.js";

  const OTHER_VALUE = "(other)";
  const NULL_VALUE = "(null)";

  let {
    context,
    width,
    height,
    spec,
    state: chartState,
    onStateChange,
    onSpecChange,
  }: ChartViewProps<CountPlotSpec, CountPlotState> = $props();

  // svelte-ignore state_referenced_locally
  let { coordinator, colorScheme, theme: themeConfig } = context;

  let theme = $derived(resolveChartTheme($colorScheme, $themeConfig));

  let { selection } = $derived(chartState);
  let { limit = 10, labels = "#/#", order = "total-descending" } = $derived(spec);
  let dataField = $derived(spec.data.field);
  let isListData = $derived(spec.data.isList ?? false);
  let showTotalBars = $derived(labels == "#/#");

  interface Item {
    value: string;
    count: number;
    countSelected: number;
    special?: "null" | "other";
  }

  interface ChartData {
    items: Item[];
    sumSelected: number;
    sumTotal: number;
  }

  // Split into two reactive sources:
  //   - unfilteredData: from a no-selection client; cached for the lifetime
  //     of (coordinator, table, field, order, limit). Recomputes only on
  //     spec change, never on brush/filter change.
  //   - filteredData: from a filter-subscribed client; recomputes on every
  //     committed cross-filter change. Uses WHERE predicate instead of
  //     SUM((predicate)::INT), so DuckDB can skip-scan non-matching rows.
  // chartData is $derived by joining them by value. See
  // ideas/issue-09-brush-perf-plan.md and #9.
  let unfilteredData = $state.raw<{ items: Item[]; sumTotal: number } | undefined>(undefined);
  let filteredData = $state.raw<
    { itemsByValue: Map<string, number>; sumSelected: number; isFiltered: boolean } | undefined
  >(undefined);
  let chartData = $derived.by<ChartData | undefined>(() => {
    if (unfilteredData == null) return undefined;
    let mapped = unfilteredData.items.map<Item>((item) => ({
      value: item.value,
      count: item.count,
      // When no filter is active, sub-bar mirrors the total bar.
      countSelected: filteredData?.isFiltered ? (filteredData.itemsByValue.get(item.value) ?? 0) : item.count,
      special: item.special,
    }));
    return {
      items: mapped,
      sumTotal: unfilteredData.sumTotal,
      sumSelected: filteredData?.isFiltered ? filteredData.sumSelected : unfilteredData.sumTotal,
    };
  });
  let chartWidth = $state.raw(400);
  let categoryWidth = $derived(spec.categoryWidth ?? 150);
  const labelWidth = 120;

  let maxCount = $derived(
    chartData?.items
      .filter((x) => x.special == null)
      .reduce((a, b) => Math.max(a, showTotalBars ? b.count : b.countSelected), 0) ?? 0,
  );

  // Shallow Map equality on string→number entries. Used by the skip-no-op
  // gate in the filtered client; deepEquals can't introspect Map contents.
  function mapsShallowEqual(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (let [k, v] of a) {
      if (b.get(k) !== v) return false;
    }
    return true;
  }

  function fieldExpr(field: SQLField): SQL.ExprNode {
    if (typeof field == "string") {
      return SQL.column(field);
    } else {
      return SQL.sql`${field.sql}`;
    }
  }

  function filterExprToExpr(filter: SQL.FilterExpr | undefined | null): SQL.ExprNode {
    if (filter == null) {
      return SQL.literal(true);
    } else if (filter instanceof Array) {
      if (filter.length == 0) {
        return SQL.literal(true);
      } else {
        return SQL.and(...filter.map(filterExprToExpr));
      }
    } else {
      if (typeof filter == "string") {
        return SQL.sql`${filter}`;
      } else if (typeof filter == "boolean") {
        return SQL.literal(filter);
      } else {
        return filter;
      }
    }
  }

  function orderExpression(order: CountPlotSpec["order"], totalCol: string = "count"): SQL.ExprNode {
    if (order instanceof Array) {
      // Here we just check if the value is in the given list,
      // post-processing code will sort them.
      let literals = order.map((x) => SQL.literal(x));
      return SQL.desc(SQL.isIn("value", literals));
    }
    switch (order ?? "total-descending") {
      case "alphabetical":
        return SQL.asc("value");
      case "selected-ascending":
        return SQL.asc("countSelected");
      case "selected-descending":
        return SQL.desc("countSelected");
      case "total-ascending":
        return SQL.asc(totalCol);
      case "total-descending":
      default:
        return SQL.desc(totalCol);
    }
  }

  // Build the SQL query for the unfiltered (cached) client.
  function unfilteredQuery(table: string, field: SQLField, isListData: boolean, limit: number) {
    if (!isListData) {
      let expr = SQL.cast(fieldExpr(field), "TEXT");
      return SQL.Query.from(table)
        .select({
          value: expr,
          count: SQL.count(),
          total: SQL.sql`(${SQL.Query.from(table).select({ count: SQL.count() })})`,
        })
        .groupby(expr)
        .orderby(SQL.isNotNull(expr), orderExpression(order), SQL.asc("value"))
        .limit(limit + 1);
    }
    let intermediateTable = "__count_plot_intermediate__";
    return SQL.Query.with({
      [intermediateTable]: SQL.Query.from(table).select({
        value: SQL.sql`UNNEST(${fieldExpr(field)})::TEXT`,
      }),
    })
      .from(intermediateTable)
      .select({
        value: "value",
        count: SQL.count(),
        total: SQL.sql`(${SQL.Query.from(intermediateTable).select({ count: SQL.count() })})`,
      })
      .groupby("value")
      .orderby(SQL.isNotNull("value"), orderExpression(order), SQL.asc("value"))
      .limit(limit + 1);
  }

  // Build the SQL query for the filtered (live) client. Uses WHERE predicate
  // so DuckDB can skip-scan rows that don't match the cross-filter.
  function filteredQuery(
    table: string,
    field: SQLField,
    isListData: boolean,
    limit: number,
    predicate: SQL.FilterExpr | undefined,
  ) {
    if (!isListData) {
      let expr = SQL.cast(fieldExpr(field), "TEXT");
      let totalSubquery = SQL.Query.from(table).select({ count: SQL.count() });
      if (predicate != null) totalSubquery = totalSubquery.where(predicate);
      let q = SQL.Query.from(table).select({
        value: expr,
        countSelected: SQL.count(),
        totalSelected: SQL.sql`(${totalSubquery})`,
      });
      if (predicate != null) q = q.where(predicate);
      return q
        .groupby(expr)
        .orderby(SQL.isNotNull(expr), orderExpression(order, "countSelected"), SQL.asc("value"))
        .limit(limit + 1);
    }
    let intermediateTable = "__count_plot_intermediate__";
    let intermediate = SQL.Query.from(table).select({
      value: SQL.sql`UNNEST(${fieldExpr(field)})::TEXT`,
    });
    if (predicate != null) intermediate = intermediate.where(predicate);
    return SQL.Query.with({ [intermediateTable]: intermediate })
      .from(intermediateTable)
      .select({
        value: "value",
        countSelected: SQL.count(),
        totalSelected: SQL.sql`(${SQL.Query.from(intermediateTable).select({ count: SQL.count() })})`,
      })
      .groupby("value")
      .orderby(SQL.isNotNull("value"), orderExpression(order, "countSelected"), SQL.asc("value"))
      .limit(limit + 1);
  }

  // Process raw rows into the per-item Item list with NULL bucket and
  // (other) rollup. Shared by both clients; counts are picked off the
  // appropriate column name via `pluck`.
  function rowsToItems(
    rows: any[],
    pluck: (row: any) => number,
    grand: number,
    limit: number,
  ): { items: Item[]; sum: number } {
    if (rows.length == 0) return { items: [], sum: 0 };
    let items: Item[] = [];
    for (let row of rows) {
      if (row.value != null && items.length < limit) {
        items.push({ value: row.value, count: pluck(row) ?? 0, countSelected: 0 });
      }
    }
    if (order instanceof Array) {
      let sortKey = (item: Item) => {
        let idx = order.indexOf(item.value);
        return idx < 0 ? Infinity : idx;
      };
      items.sort((a, b) => sortKey(a) - sortKey(b));
    }
    for (let row of rows) {
      if (row.value == null) {
        items.push({ value: NULL_VALUE, count: pluck(row) ?? 0, countSelected: 0, special: "null" });
      }
    }
    let sumVisible = items.reduce((a, b) => a + b.count, 0);
    if (sumVisible < grand) {
      items.push({ value: OTHER_VALUE, count: grand - sumVisible, countSelected: 0, special: "other" });
    }
    return { items, sum: grand };
  }

  function initializeClient(
    coordinator: Coordinator,
    table: string,
    field: SQLField,
    filter: Selection,
    order: CountPlotSpec["order"],
    limit: number,
    isListData: boolean,
  ) {
    if (order instanceof Array) {
      limit = Math.max(limit, order.length);
    }

    // Client A — unfiltered totals. No selection: never re-fires on brush.
    let unfilteredClient = makeClient({
      coordinator: coordinator,
      query: () => unfilteredQuery(table, field, isListData, limit),
      queryResult: (result: any) => {
        let rows: { value: string | null; count: number; total: number }[] = result.toArray();
        let next: { items: Item[]; sumTotal: number };
        if (rows.length == 0) {
          next = { items: [], sumTotal: 0 };
        } else {
          let total = rows[0].total ?? 0;
          let { items } = rowsToItems(rows, (r) => r.count, total, limit);
          next = { items, sumTotal: total };
        }
        // Skip-no-op gate (issue #11): if the new data is structurally equal
        // to the current value, don't reassign $state.raw. This avoids
        // re-running chartData $derived.by and the keyed {#each} update path,
        // which is the long-task source on deselect when the cleared filter
        // produces visually identical output.
        // See ideas/issue-11-deselect-render-plan.md (Fix A).
        if (deepEquals(unfilteredData, next)) return;
        unfilteredData = next;
      },
    });

    // Client B — filtered subcounts. Subscribes to filter Selection.
    //
    // When the cross-filter has no clauses (e.g., on cold start), we short-
    // circuit the query: chartData's $derived already falls back to the
    // unfiltered counts when filteredData?.isFiltered is false, so running a
    // WHERE-true scan here would be pure waste. Returns a tiny no-op query
    // and emits a sentinel filteredData = null on the result.
    let filteredClient = makeClient({
      coordinator: coordinator,
      selection: filter,
      query: (predicate) => {
        if (predicate == null) {
          // No filter: produce zero rows fast. Result handler clears filteredData.
          return SQL.Query.select({ value: SQL.literal(null), countSelected: SQL.literal(0), totalSelected: SQL.literal(0) }).where(SQL.literal(false));
        }
        return filteredQuery(table, field, isListData, limit, predicate);
      },
      queryResult: (result: any) => {
        let rows: { value: string | null; countSelected: number; totalSelected: number }[] = result.toArray();
        let isFiltered = filter.clauses.length > 0;
        if (!isFiltered) {
          // Skip-no-op gate (issue #11): if filteredData is already cleared,
          // don't reassign — this is the deselect hot path.
          if (filteredData === undefined) return;
          filteredData = undefined;
          return;
        }
        let totalSelected = rows[0]?.totalSelected ?? 0;
        let itemsByValue = new Map<string, number>();
        let nullCount = 0;
        for (let row of rows) {
          if (row.value == null) {
            nullCount = row.countSelected ?? 0;
          } else {
            itemsByValue.set(row.value, row.countSelected ?? 0);
          }
        }
        if (nullCount > 0) itemsByValue.set(NULL_VALUE, nullCount);
        // (other) bucket: filtered total minus visible sum (computed below at join time).
        let visibleSum = 0;
        for (let v of itemsByValue.values()) visibleSum += v;
        if (visibleSum < totalSelected) {
          itemsByValue.set(OTHER_VALUE, totalSelected - visibleSum);
        }
        let next = { itemsByValue, sumSelected: totalSelected, isFiltered };
        // Skip-no-op gate (issue #11): compare against the current filteredData.
        // deepEquals walks Map entries via Object.keys (Maps have no enumerable
        // own keys), so we hand-compare itemsByValue contents explicitly.
        if (
          filteredData !== undefined &&
          filteredData.isFiltered === next.isFiltered &&
          filteredData.sumSelected === next.sumSelected &&
          mapsShallowEqual(filteredData.itemsByValue, next.itemsByValue)
        ) {
          return;
        }
        filteredData = next;
      },
    });

    function makePredicate(selection: string[]): SQL.ExprNode {
      if (selection.length == 0) {
        return SQL.literal(true);
      }
      if (!isListData) {
        // Normal mode, field values are texts
        let expr = SQL.cast(fieldExpr(field), "TEXT");
        return SQL.or(
          ...selection.map((sel) => {
            if (sel == NULL_VALUE) {
              return SQL.isNull(expr);
            } else if (sel == OTHER_VALUE) {
              let literals =
                chartData?.items.filter((x) => x.special == undefined).map((v) => SQL.literal(v.value)) ?? [];
              return SQL.not(SQL.isIn(expr, literals));
            } else {
              return SQL.isNotDistinct(expr, SQL.literal(sel));
            }
          }),
        );
      } else {
        // List mode, field values are lists
        let expr = fieldExpr(field);
        let r = SQL.or(
          ...selection.map((sel) => {
            if (sel == NULL_VALUE) {
              return SQL.listContains(expr, SQL.sql`NULL`);
            } else if (sel == OTHER_VALUE) {
              // List contains something not in the list of known values
              let literals =
                chartData?.items.filter((x) => x.special == undefined).map((v) => SQL.literal(v.value)) ?? [];
              return SQL.sql`len(list_filter(${expr}, x -> x NOT IN (${literals.join(",")}))) > 0`;
            } else {
              return SQL.listContains(expr, SQL.literal(sel));
            }
          }),
        );
        return r;
      }
    }

    let source = {
      reset: () => {
        onStateChange({ selection: undefined });
      },
    };

    // Sync selection with brush
    $effect.pre(() => {
      let clause: SelectionClause = {
        source: source,
        clients: new Set([filteredClient]),
        ...(selection != null && selection.length > 0
          ? { value: selection, predicate: makePredicate(selection) }
          : { value: null, predicate: null }),
      };
      filter.update(clause);
    });

    return () => {
      unfilteredClient.destroy();
      filteredClient.destroy();
      unfilteredData = undefined;
      filteredData = undefined;
      filter.update({
        source: source,
        clients: new Set([filteredClient]),
        value: null,
        predicate: null,
      });
    };
  }

  $effect.pre(() => {
    return initializeClient(coordinator, context.table, dataField, context.filter, order, limit, isListData);
  });

  function toggleSelection(value: string, shift: boolean) {
    if (selection == undefined || selection.length == 0) {
      onStateChange({ selection: [value] });
    } else {
      let exists = selection.findIndex((x) => x == value) >= 0;
      if (shift) {
        if (exists) {
          onStateChange({ selection: selection.filter((x) => x != value) });
        } else {
          onStateChange({ selection: [...selection, value] });
        }
      } else {
        if (exists) {
          onStateChange({ selection: undefined });
        } else {
          onStateChange({ selection: [value] });
        }
      }
    }
  }

  function formatPercentage(x: number, total: number) {
    if (total == 0) {
      return "-%";
    } else {
      return ((x / total) * 100).toFixed(1) + "%";
    }
  }

  function formatItem(
    item: Item,
    chartData: ChartData,
    labels: CountPlotSpec["labels"],
    hasSelection: boolean,
  ): { label: string; title: string } {
    let label: string;
    let title: string[];

    switch (labels ?? "#/#") {
      case "#":
        label = hasSelection ? item.countSelected.toLocaleString() : item.count.toLocaleString();
        break;
      case "%":
        label = hasSelection
          ? formatPercentage(item.countSelected, chartData.sumSelected)
          : formatPercentage(item.count, chartData.sumTotal);
        break;
      case "#/#":
        label = hasSelection
          ? item.countSelected.toLocaleString() + " / " + item.count.toLocaleString()
          : item.count.toLocaleString();
        break;
      default:
        label = "";
    }

    if (!isListData) {
      title = hasSelection
        ? [
            `${item.countSelected.toLocaleString()} / ${item.count.toLocaleString()} (${formatPercentage(item.countSelected, item.count)})`,
            `${formatPercentage(item.countSelected, chartData.sumSelected)} of selection`,
          ]
        : [`${item.count.toLocaleString()}`, `${formatPercentage(item.count, chartData.sumTotal)} of all rows`];
    } else {
      title = hasSelection
        ? [
            `${item.countSelected.toLocaleString()} / ${item.count.toLocaleString()} (${formatPercentage(item.countSelected, item.count)})`,
            `${formatPercentage(item.countSelected, chartData.sumSelected)} of selection`,
            `(Occurrences in the list values)`,
          ]
        : [
            `${item.count.toLocaleString()}`,
            `${formatPercentage(item.count, chartData.sumTotal)} of all occurrences`,
            `(Occurrences in the list values)`,
          ];
    }

    return { label: label, title: title.join("\n") };
  }
</script>

<Container width={width} height={height} scrollY={true}>
  <div class="flex flex-col relative text-sm w-full select-none" bind:clientWidth={chartWidth}>
    {#if chartData}
      {@const firstSpecialIndex = chartData.items.findIndex((x) => x.special != undefined)}
      {#each chartData.items as bar, i}
        {@const selected =
          selection == undefined || selection.length == 0 || selection.findIndex((x) => x == bar.value) >= 0}
        {@const hasSelection = !chartData.items.every((x) => x.count == x.countSelected)}
        {@const formatted = formatItem(bar, chartData, labels, hasSelection)}
        {#if i == firstSpecialIndex}
          <hr class="mt-1 mb-1 border-slate-300 dark:border-slate-500 border-dashed" />
        {/if}
        <button
          class="text-left items-center flex py-0.5"
          onclick={(e) => toggleSelection(bar.value, e.shiftKey)}
          title={bar.value}
        >
          <div class="flex-none overflow-hidden whitespace-nowrap text-ellipsis pr-1" style:width="{categoryWidth}px">
            <span class:text-gray-400={!selected} class:dark:text-gray-400={!selected}>{bar.value}</span>
          </div>
          <CountPlotBar
            selected={selected}
            bars={selected
              ? [
                  ...(showTotalBars ? [{ value: bar.count, color: theme.markColorFade }] : []),
                  { value: bar.countSelected, color: theme.markColor },
                ]
              : [
                  ...(showTotalBars ? [{ value: bar.count, color: theme.markColorGrayFade }] : []),
                  { value: bar.countSelected, color: theme.markColorGray },
                ]}
            maxValue={maxCount}
            width={chartWidth - categoryWidth - labelWidth}
            label={formatted.label}
            title={formatted.title}
          />
        </button>
      {/each}

      <div
        class="absolute top-0 bottom-0 cursor-col-resize"
        style:left="{categoryWidth - 3}px"
        style:width="6px"
        use:interactionHandler={{
          drag: (e1) => {
            let initial = categoryWidth;
            return {
              move: (e2) => {
                let dx = e2.clientX - e1.clientX;
                onSpecChange({ categoryWidth: Math.max(20, Math.min(chartWidth - labelWidth, initial + dx)) });
              },
            };
          },
        }}
      ></div>

      <div class="flex mt-0.5">
        <div class="flex-1 flex gap-2 mr-2 overflow-hidden">
          {#if limit != 10 || chartData.items.findIndex((x) => x.special == "other") >= 0}
            <button
              class="py-0.5 text-left text-slate-400 dark:text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 whitespace-nowrap text-ellipsis overflow-hidden"
              onclick={() => {
                let newLimit = limit < 50 ? 100 : 10;
                onSpecChange({ limit: newLimit });
                if (newLimit < limit) {
                  onStateChange({ selection: undefined });
                }
              }}
            >
              {#if limit < 50}
                ↓ Up to 100 values
              {:else}
                ↑ Up to 10 values
              {/if}
            </button>
          {/if}
          {#if isListData}
            <div
              class="flex-1 py-0.5 text-slate-400 dark:text-slate-500 whitespace-nowrap text-ellipsis overflow-hidden"
            >
              (Occurrences in lists)
            </div>
          {/if}
        </div>

        <div class="flex gap-1">
          {#if typeof order == "string"}
            <InlineSelect
              options={[
                { value: "total-descending", label: "↓ Total" },
                { value: "selected-descending", label: "↓ Selected" },
                { value: "total-ascending", label: "↑ Total" },
                { value: "selected-ascending", label: "↑ Selected" },
                { value: "alphabetical", label: "↓ A-Z" },
              ]}
              title="Sort order"
              value={order ?? "total-descending"}
              onChange={(v) => onSpecChange({ order: v })}
            />
          {/if}
          <InlineSelect
            options={[
              { value: "%", label: "%" },
              { value: "#", label: "#" },
              { value: "#/#", label: "#/#" },
            ]}
            title={`#/#: count in selection / total count\n#: count in selection\n%: percentage in selection`}
            value={labels ?? "#/#"}
            onChange={(v) => onSpecChange({ labels: v })}
          />
        </div>
      </div>
    {/if}
  </div>
</Container>
