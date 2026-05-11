<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script module lang="ts">
  export type Section = "embedding" | "table" | "chart";

  export function findSection(spec: any, id: string, placements?: Record<string, Section>): Section | undefined {
    if (placements?.[id] != undefined) {
      return placements[id];
    }

    switch (spec.type) {
      case "embedding":
        return "embedding";
      case "instances":
        return "table";
      default:
        return "chart";
    }
  }

  export function getSections(charts: Record<string, any>, layoutState: ListLayoutState): Record<Section, string[]> {
    let r: Record<Section, string[]> = {
      embedding: [],
      table: [],
      chart: [],
    };
    for (let id in charts) {
      let section = findSection(charts[id], id, layoutState.placements);
      if (section != undefined) {
        r[section].push(id);
      }
    }
    return r;
  }
</script>

<script lang="ts">
  import { deepMemo } from "@embedding-atlas/utils";
  import { getContext } from "svelte";
  import { flip } from "svelte/animate";
  import { slide } from "svelte/transition";

  import ChatPanel from "../../widgets/ChatPanel.svelte";
  import ListChartPanel from "./ListChartPanel.svelte";
  import Resizer from "./Resizer.svelte";
  import TableTabBar from "./TableTabBar.svelte";

  import { CHAT_CONTEXT_KEY, type ChatProvider } from "../../utils/chat_context.js";
  import { findUnusedId } from "../../utils/identifier.js";
  import { reorder } from "../../utils/sort.js";
  import type { LayoutProps } from "../layout.js";
  import type { ListLayoutState, TableTab } from "./types.js";

  let {
    context,
    charts,
    chartView,
    state: layoutState,
    onStateChange,
    onChartsChange,
    onChartStatesChange,
  }: LayoutProps<ListLayoutState> = $props();

  // svelte-ignore state_referenced_locally
  let { colorScheme } = context;

  let containerWidth = $state(100);
  let containerHeight = $state(100);

  let tableHeight = $state(300);
  let panelWidth = $state(400);
  let panelContainerWidth = $state(400);

  let sections = $derived.by(deepMemo(() => getSections(charts, layoutState)));

  let isMobileLayout = $derived(containerWidth < 500);

  let hasEmbedding = $derived(sections.embedding.length > 0 && (layoutState.showEmbedding ?? true));
  let hasTable = $derived(sections.table.length > 0 && (layoutState.showTable ?? true));
  let hasChart = $derived(layoutState.showCharts ?? true);

  // Chat tab is gated on a configured chat backend. Without one, the table
  // section behaves exactly like before (no tab strip, table fills the slot).
  const chat = getContext<ChatProvider | undefined>(CHAT_CONTEXT_KEY);
  let chatAvailable = $derived(chat != null && chat.endpoint != null);
  let tableTab: TableTab = $derived(layoutState.tableTab ?? "table");
  function setTableTab(tab: TableTab) {
    onStateChange({ tableTab: tab });
  }

  function chartWidth(total: number, desiredWidth: number) {
    const gap = 7;
    let nApprox = Math.round((total + gap) / (desiredWidth + gap));
    let minDiff: number | undefined = undefined;
    let minWidth: number | undefined = undefined;
    for (let n = Math.max(1, nApprox - 1); n <= Math.max(1, nApprox + 1); n++) {
      let preciseWidth = (total - gap * (n - 1)) / n;
      let diff = Math.abs(preciseWidth - desiredWidth);
      if (minDiff == undefined || diff < minDiff) {
        minDiff = diff;
        minWidth = preciseWidth;
      }
    }
    return Math.floor((minWidth ?? 400) * 2) / 2; // Round to multiple of 0.5
  }

  let chartsOrder = $derived.by(deepMemo(() => reorder(sections.chart, layoutState.chartsOrder)));

  function reorderCharts(id: string, shift: number) {
    let newOrder = [...chartsOrder];
    let index = newOrder.indexOf(id);
    if (index == -1) {
      return;
    }
    let targetIndex = index + shift;
    if (targetIndex < 0 || targetIndex >= newOrder.length) {
      return;
    }
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    onStateChange({ chartsOrder: newOrder });
  }

  function removeChart(id: string) {
    onChartsChange({ [id]: undefined });
    onChartStatesChange({ [id]: undefined });
  }

  /**
   * Promote an inline chart from the chat to a persistent side-panel chart.
   * Triggered by the "Add to panel" button on each InlineChartView. Mirrors
   * the +Add button behavior: allocate an unused id, slot the spec in, and
   * push it to the front of the chartsOrder so the user sees it right away.
   */
  function saveInlineChartToPanel(spec: any) {
    let id = findUnusedId(charts);
    onChartsChange({ [id]: spec });
    onStateChange({ chartsOrder: [id, ...chartsOrder.filter((x) => x != id)] });
  }
</script>

<div class="w-full h-full flex flex-row" bind:clientWidth={containerWidth} bind:clientHeight={containerHeight}>
  {#if !isMobileLayout}
    <!-- Desktop layout -->
    <!-- Left side: embedding / table. Both panes are kept mounted
         across show/hide (Mosaic + WebGL on the embedding side, and
         @tanstack/table-core + virtualizer + Mosaic clients on the
         table side, both pay a ~250 ms setup cost on first appearance
         — re-mounting on every toggle showed up as a dropped frame
         at the start of the slide-in). The outer `{#if hasEmbedding
         || hasTable}` gate only short-circuits the case where the
         user has hidden BOTH panes; in that case the entire left
         column collapses and the chart panel fills the page.

         Within the left column, each pane uses a two-layer wrapper
         to animate its show/hide:

           outer → animates height between 0 and the pane's intended
                   size, overflow:hidden so content beyond is clipped
           inner → fixed at the pane's intended size so ResizeObserver
                   inside the embedding canvas / virtualizer doesn't
                   fire mid-animation (only paint, no re-measure)

         When BOTH panes are visible the intended sizes are
         embedding = containerHeight − tableHeight − 8 (resizer)
         table     = tableHeight (user-controlled via resizer)

         When only one pane is visible, that pane's intended size is
         containerHeight (it fills the column).

         As the user toggles one pane while the other stays visible,
         both intended-sizes update simultaneously, so both panes'
         outer heights animate in lockstep — the hidden pane shrinks
         to 0 over 300 ms while the visible pane grows to fill its
         freed space, with no end-of-transition snap. -->
    {#if hasEmbedding || hasTable}
      <div class="flex-1 flex flex-col overflow-hidden">
        {#if sections.embedding.length > 0}
          {@const embH = hasTable ? Math.max(0, containerHeight - tableHeight - 8) : containerHeight}
          <div
            class="overflow-hidden flex-none"
            style:height="{hasEmbedding ? embH : 0}px"
            style:transition="height 300ms ease-in-out"
          >
            <div class="flex flex-row gap-2 overflow-hidden" style:height="{embH}px">
              {#each sections.embedding as id (id)}
                <div class="flex-1 overflow-hidden rounded-md">
                  {@render chartView({ id: id, width: "container", height: "container" })}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        <!-- Resizer wrapper: always mounted; height collapses to 0
             when either pane is hidden so the 8 px drag handle fades
             in/out alongside the pane animations rather than
             popping. The Resizer component itself stays at h-2 so
             its hit area is preserved when fully visible. -->
        <div
          class="flex-none overflow-hidden"
          style:height="{hasEmbedding && hasTable ? 8 : 0}px"
          style:transition="height 300ms ease-in-out"
        >
          <Resizer
            class="h-2 w-full"
            axis="y"
            min={100}
            max={containerHeight - 100}
            scaler={-1}
            value={tableHeight}
            onChange={(v) => (tableHeight = v)}
          />
        </div>
        {#if sections.table.length > 0}
          {@const tblH = hasEmbedding ? tableHeight : containerHeight}
          <div
            class="overflow-hidden flex-none"
            style:height="{hasTable ? tblH : 0}px"
            style:transition="height 300ms ease-in-out"
          >
            <div
              class="flex flex-col gap-1 overflow-hidden min-h-0"
              style:height="{tblH}px"
            >
              {#if chatAvailable}
                <div class="flex-none flex items-center gap-2 px-1">
                  <TableTabBar value={tableTab} onChange={setTableTab} />
                </div>
              {/if}
              {#if chatAvailable && tableTab === "chat" && chat != null}
                <div class="flex-1 overflow-hidden rounded-md min-h-0">
                  <ChatPanel
                    coordinator={context.coordinator}
                    table={context.table}
                    filter={context.filter}
                    highlight={context.highlight}
                    chartContext={context}
                    onSaveChart={saveInlineChartToPanel}
                  />
                </div>
              {:else}
                <div class="flex flex-row gap-2 overflow-hidden flex-1 min-h-0">
                  {#each sections.table as id (id)}
                    <div class="flex-1 overflow-hidden rounded-md">
                      {@render chartView({ id: id, width: "container", height: "container" })}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}
    {#if (hasEmbedding || hasTable) && hasChart}
      <Resizer
        class="w-2 flex-none"
        axis="x"
        min={100}
        max={containerWidth - 100}
        scaler={-1}
        value={panelWidth}
        onChange={(v) => (panelWidth = v)}
      />
    {/if}
    <!-- Right side: charts -->
    {#if hasChart}
      <div
        class="h-full overflow-x-hidden overflow-y-scroll"
        style:width="{hasEmbedding || hasTable ? panelWidth : containerWidth}px"
        transition:slide={{ axis: "x" }}
      >
        <div class="flex flex-row flex-wrap gap-2" bind:clientWidth={panelContainerWidth}>
          <button
            class="bg-white dark:bg-black rounded-md flex flex-col justify-center items-center gap-2 p-2 w-full text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 select-none"
            onclick={() => {
              let id = findUnusedId(charts);
              onChartsChange({ [id]: { type: "builder", title: "New" } });
              onStateChange({ chartsOrder: [id, ...chartsOrder.filter((x) => x != id)] });
            }}
          >
            + Add
          </button>
          {#each chartsOrder as id, index (id)}
            {@const spec = charts[id]}
            {@const isVisible = layoutState.chartVisibility?.[id] ?? true}
            <div
              class="bg-white dark:bg-black rounded-md flex flex-col group"
              style:width="{chartWidth(panelContainerWidth, 500)}px"
              animate:flip={{ duration: 300 }}
              out:slide
            >
              <ListChartPanel
                id={id}
                spec={spec}
                onIsVisibleChange={(v) => {
                  onStateChange({ chartVisibility: { [id]: v } });
                }}
                isVisible={isVisible}
                colorScheme={$colorScheme}
                chartView={chartView}
                onRemove={removeChart.bind(null, id)}
                onUp={index > 0 ? reorderCharts.bind(null, id, -1) : undefined}
                onDown={index + 1 < chartsOrder.length ? reorderCharts.bind(null, id, 1) : undefined}
                onSpecChange={(spec) => {
                  onChartsChange({ [id]: undefined });
                  onChartStatesChange({ [id]: undefined });
                  onChartsChange({ [id]: spec });
                }}
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {:else}
    <!-- Mobile layout -->
    <div class="w-full h-full overflow-y-scroll flex flex-col gap-2">
      {#each sections.embedding.concat(chartsOrder, sections.table) as id, index (id)}
        {@const isVisible = layoutState.chartVisibility?.[id] ?? true}
        {@const indexInCharts = chartsOrder.indexOf(id)}
        <div class="bg-white dark:bg-black rounded-md flex flex-col group" animate:flip={{ duration: 300 }} out:slide>
          <ListChartPanel
            id={id}
            spec={charts[id]}
            onIsVisibleChange={(v) => {
              onStateChange({ chartVisibility: { [id]: v } });
            }}
            isVisible={isVisible}
            colorScheme={$colorScheme}
            chartView={chartView}
            onRemove={removeChart.bind(null, id)}
            onUp={indexInCharts > 0 ? reorderCharts.bind(null, id, -1) : undefined}
            onDown={indexInCharts != -1 && indexInCharts + 1 < chartsOrder.length
              ? reorderCharts.bind(null, id, 1)
              : undefined}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>
