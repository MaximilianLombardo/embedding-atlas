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
         across show/hide so the expensive setup work (Mosaic + WebGL
         on the embedding side; table-core + virtualizer + filter
         popovers on the table side) is paid once on first appearance,
         not on every toggle.

         Both panes use explicit px heights so CSS transitions have
         interpolatable endpoints in every direction (browsers don't
         animate from `auto`/flex-determined to a fixed value). The
         heights are computed so they always sum to containerHeight:

           hasEmbedding + hasTable:   emb = cH − tH − 8, table = tH
           hasEmbedding only:         emb = cH, table = 0
           hasTable only:             emb = 0, table = cH

         Inner wrappers use `h-full` so the chart content follows the
         outer's currently-animated height every frame, instead of
         snapping to a new "stable size" the moment the OTHER pane's
         visibility flips. The previous "fixed inner height" was
         supposed to keep the embedding canvas / table virtualizer
         from re-measuring during a transition, but because that
         fixed value depended on `hasEmbedding` / `hasTable`, any
         cross-pane toggle made the inner SNAP at frame 0 — that's
         what produced the jitter the user reported on
         hide-embedding-while-table-visible and hide-table-while-
         embedding-visible. Letting the inner track the animated
         outer trades a tiny per-frame re-render (cheap: WebGL
         viewport change + virtualizer range recompute) for visually
         smooth motion that matches the chart-panel/embedding
         interaction the user pointed at as the target. -->
    {#if hasEmbedding || hasTable}
      <div class="flex-1 flex flex-col overflow-hidden">
        {#if sections.embedding.length > 0}
          {@const embH = hasTable ? Math.max(0, containerHeight - tableHeight - 8) : containerHeight}
          <div
            class="overflow-hidden flex-none"
            style:height="{hasEmbedding ? embH : 0}px"
            style:transition="height 300ms ease-in-out"
          >
            <div class="flex flex-row gap-2 overflow-hidden h-full">
              {#each sections.embedding as id (id)}
                <div class="flex-1 overflow-hidden rounded-md">
                  {@render chartView({ id: id, width: "container", height: "container" })}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        <!-- Resizer: always mounted; height collapses to 0 when
             either pane is hidden so the 8 px drag handle fades
             alongside the pane animations rather than popping. -->
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
          <!-- Table wrapper. The inner is intentionally PINNED to
               containerHeight (not h-full of the animated outer) so the
               @tanstack/svelte-virtual ResizeObserver sees a stable
               scroll-element height through every transition. Without
               this, every animation frame would invalidate the
               virtualizer's visible range and mount one fresh row's
               worth of cells (~40 ContentRenderers × ~18 frames ≈ 720
               renders during a 300 ms animation), which the user can
               see as table-content jitter while the outer is growing
               or shrinking.

               Cost: when embedding is also visible the inner extends
               below the outer's clipped bottom — the virtualizer
               renders a few rows that aren't on screen. Cheap (they're
               static once mounted), and the user-visible scroll
               behavior is identical: wheel events on the visible
               portion still drive scrollEl's scrollTop the same way.

               Doesn't apply to the embedding's inner: the WebGL
               scatter NEEDS to render at its visible size (otherwise
               the bottom of the plot is cropped), so the embedding's
               inner stays at h-full and pays a per-frame WebGL
               viewport change — which is cheap O(1) vs the
               virtualizer's per-frame row-mount. -->
          <div
            class="overflow-hidden flex-none"
            style:height="{hasTable ? tblH : 0}px"
            style:transition="height 300ms ease-in-out"
          >
            <div
              class="flex flex-col gap-1 overflow-hidden min-h-0"
              style:height="{containerHeight}px"
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
