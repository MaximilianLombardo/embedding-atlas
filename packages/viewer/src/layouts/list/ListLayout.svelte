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
  import PanelTabBar, { type AddKind, type PanelTabInfo } from "./PanelTabBar.svelte";
  import Resizer from "./Resizer.svelte";

  import type { ChatTurn } from "../../utils/chat_client.js";
  import { CHAT_CONTEXT_KEY, type ChatProvider } from "../../utils/chat_context.js";
  import { findUnusedId } from "../../utils/identifier.js";
  import { reorder } from "../../utils/sort.js";
  import type { LayoutProps } from "../layout.js";
  import type { CanvasTab, ChatTab, ListLayoutState, Tab } from "./types.js";

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

  // True while the user is actively dragging either the embedding/table
  // resizer or the left/right (main/panel) resizer. Suppresses the
  // pane outers' `transition: height 300 ms` during drag so the panes
  // track the cursor instead of chasing a moving target.
  let isResizing = $state(false);

  let sections = $derived.by(deepMemo(() => getSections(charts, layoutState)));

  let isMobileLayout = $derived(containerWidth < 500);

  let hasEmbedding = $derived(sections.embedding.length > 0 && (layoutState.showEmbedding ?? true));
  let hasTable = $derived(sections.table.length > 0 && (layoutState.showTable ?? true));
  let hasChart = $derived(layoutState.showCharts ?? true);

  // Chat is gated on a configured chat backend. When available, the
  // tab strip seeds a default Chat tab; without one, the strip is
  // canvases-only and the `+` popover collapses to "New canvas".
  const chat = getContext<ChatProvider | undefined>(CHAT_CONTEXT_KEY);
  let chatAvailable = $derived(chat != null && chat.endpoint != null);

  // Unified tab list. Migration: if `layoutState.tabs` is missing
  // (pre-tabs state), seed a Chat tab (when available) followed by
  // a Canvas 1 that absorbs the legacy top-level chartsOrder /
  // chartVisibility so the user's prior layout survives the upgrade.
  let tabs = $derived.by(
    deepMemo((): Tab[] => {
      if (layoutState.tabs && layoutState.tabs.length > 0) return layoutState.tabs;

      const out: Tab[] = [];
      if (chatAvailable) {
        out.push({ kind: "chat", id: "chat", name: "Chat" });
      }
      out.push({
        kind: "canvas",
        id: "canvas-1",
        name: "Canvas 1",
        chartsOrder: layoutState.chartsOrder ?? [],
        chartVisibility: layoutState.chartVisibility,
      });
      return out;
    }),
  );

  // Per-chat-tab conversation history, kept LOCAL to this component
  // instead of inside `layoutState.tabs` because `layoutStates` upstream
  // is `$state.raw` — deep in-place mutations (which the streaming
  // response code performs on the turns array) wouldn't propagate
  // through a raw state object. Today's chat is in-memory only, so this
  // also preserves that invariant. A future "persist chat history" pass
  // can lift these arrays into layoutState explicitly.
  let chatTurns: Record<string, ChatTurn[]> = $state({});

  // Ensure every chat tab has an entry in `chatTurns`. Runs on tab
  // changes — covers the initial seed, every addChat, and the case
  // where persisted state lists chat tabs we haven't seen yet this
  // session (reloads).
  $effect.pre(() => {
    for (const t of tabs) {
      if (t.kind === "chat" && !(t.id in chatTurns)) {
        chatTurns[t.id] = [];
      }
    }
  });

  // Active tab. Falls back to the first tab when the persisted id no
  // longer maps to a live tab (e.g. that tab was deleted in a previous
  // session).
  let panelTab: string = $derived.by(() => {
    const saved = layoutState.panelTab;
    if (saved != null && tabs.some((t) => t.id === saved)) return saved;
    return tabs[0]?.id ?? "canvas-1";
  });

  let activeTab: Tab | undefined = $derived(tabs.find((t) => t.id === panelTab) ?? tabs[0]);
  let activeCanvas: CanvasTab | undefined = $derived(
    activeTab?.kind === "canvas" ? activeTab : undefined,
  );

  function setPanelTab(id: string) {
    onStateChange({ panelTab: id });
  }

  // --- Tab operations --------------------------------------------------

  function writeTabs(next: Tab[]) {
    onStateChange({ tabs: next });
  }

  function updateTab(id: string, updater: (t: Tab) => Tab) {
    let touched = false;
    const next = tabs.map((t) => {
      if (t.id !== id) return t;
      touched = true;
      return updater(t);
    });
    if (touched) writeTabs(next);
  }

  function updateActiveCanvas(updater: (c: CanvasTab) => CanvasTab) {
    if (activeCanvas == null) return;
    updateTab(activeCanvas.id, (t) => updater(t as CanvasTab));
  }

  /** Allocate an auto-name "Kind N" where N is one past the highest
   *  existing N for tabs of that kind matching the default pattern. */
  function nextAutoName(kind: "canvas" | "chat"): string {
    const prefix = kind === "canvas" ? "Canvas" : "Chat";
    const re = new RegExp("^" + prefix + " (\\d+)$");
    let maxN = 0;
    let countOfKind = 0;
    for (const t of tabs) {
      if (t.kind !== kind) continue;
      countOfKind++;
      const m = t.name.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      }
    }
    return `${prefix} ${Math.max(maxN + 1, countOfKind + 1)}`;
  }

  function existingTabIds(): Record<string, true> {
    const out: Record<string, true> = {};
    for (const t of tabs) out[t.id] = true;
    return out;
  }

  function addCanvas() {
    const id = findUnusedId(existingTabIds(), "canvas-");
    const name = nextAutoName("canvas");
    writeTabs([...tabs, { kind: "canvas", id, name, chartsOrder: [] }]);
    setPanelTab(id);
  }

  function addChat() {
    const id = findUnusedId(existingTabIds(), "chat-");
    const name = nextAutoName("chat");
    writeTabs([...tabs, { kind: "chat", id, name }]);
    chatTurns[id] = [];
    setPanelTab(id);
  }

  function addByKind(kind: AddKind) {
    if (kind === "chat") addChat();
    else addCanvas();
  }

  function renameTab(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    updateTab(id, (t) => ({ ...t, name: trimmed }));
  }

  function deleteTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const removed = tabs[idx];

    if (removed.kind === "canvas") {
      // Drop the canvas's chart specs from the global stores. Charts
      // belong to exactly one canvas in v1, so a canvas delete is also
      // a delete of every chart it owned.
      const chartUpdates: Record<string, undefined> = {};
      const stateUpdates: Record<string, undefined> = {};
      for (const chartId of removed.chartsOrder) {
        chartUpdates[chartId] = undefined;
        stateUpdates[chartId] = undefined;
      }
      if (removed.chartsOrder.length > 0) {
        onChartsChange(chartUpdates);
        onChartStatesChange(stateUpdates);
      }
    } else {
      // Drop the chat's turns from the local map. If a stream was in
      // flight against this array it'll continue mutating the
      // (now-orphaned) array; harmless since nothing references it.
      delete chatTurns[id];
    }

    let next = tabs.filter((t) => t.id !== id);
    // Never let the state go to zero tabs — auto-create a fresh empty
    // Canvas 1 so the `+` and chart-add affordances stay available.
    if (next.length === 0) {
      next = [{ kind: "canvas", id: "canvas-1", name: "Canvas 1", chartsOrder: [] }];
    }
    writeTabs(next);

    // If the deleted tab was active, jump to the previous one.
    if (panelTab === id) {
      const neighbor = next[Math.max(0, idx - 1)];
      setPanelTab(neighbor.id);
    }
  }

  // --- Chart operations (scoped to the active canvas tab) ---------------

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

  // Chart ids actually present on the active canvas, ordered. `reorder`
  // drops dangling ids (charts removed from the global store) and
  // appends specs that arrived without an explicit position.
  let activeChartsOrder = $derived.by(
    deepMemo(() => {
      if (activeCanvas == null) return [] as string[];
      return reorder(
        sections.chart.filter((id) => activeCanvas!.chartsOrder.includes(id)),
        activeCanvas.chartsOrder,
      );
    }),
  );

  function reorderCharts(id: string, shift: number) {
    if (activeCanvas == null) return;
    const order = activeChartsOrder;
    const index = order.indexOf(id);
    if (index < 0) return;
    const targetIndex = index + shift;
    if (targetIndex < 0 || targetIndex >= order.length) return;
    const next = [...order];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    updateActiveCanvas((c) => ({ ...c, chartsOrder: next }));
  }

  function removeChart(id: string) {
    onChartsChange({ [id]: undefined });
    onChartStatesChange({ [id]: undefined });
    updateActiveCanvas((c) => ({
      ...c,
      chartsOrder: c.chartsOrder.filter((x) => x !== id),
      chartVisibility: c.chartVisibility ? omit(c.chartVisibility, id) : c.chartVisibility,
    }));
  }

  function setChartVisibility(id: string, visible: boolean) {
    updateActiveCanvas((c) => ({
      ...c,
      chartVisibility: { ...(c.chartVisibility ?? {}), [id]: visible },
    }));
  }

  function addNewChart() {
    if (activeCanvas == null) return;
    const id = findUnusedId(charts);
    onChartsChange({ [id]: { type: "builder", title: "New" } });
    updateActiveCanvas((c) => ({
      ...c,
      chartsOrder: [id, ...c.chartsOrder.filter((x) => x !== id)],
    }));
  }

  /**
   * Promote an inline chart from the chat into a persistent canvas.
   * Triggered by "Add to panel" on InlineChartView. Routes to the
   * active canvas if one is active, else the first canvas tab. If no
   * canvas exists (unlikely — we keep at least one), auto-create one.
   */
  function saveInlineChartToPanel(spec: any) {
    const id = findUnusedId(charts);
    onChartsChange({ [id]: spec });
    let targetId = activeCanvas?.id ?? tabs.find((t) => t.kind === "canvas")?.id;
    if (targetId == null) {
      addCanvas();
      targetId = tabs[tabs.length]?.id;
      if (targetId == null) return;
    }
    updateTab(targetId, (t) => {
      if (t.kind !== "canvas") return t;
      return { ...t, chartsOrder: [id, ...t.chartsOrder.filter((x) => x !== id)] };
    });
  }

  function omit<T extends Record<string, any>>(obj: T, key: string): T {
    if (!(key in obj)) return obj;
    const { [key]: _drop, ...rest } = obj;
    return rest as T;
  }

  // --- Tab strip wiring -------------------------------------------------

  let panelTabInfos: PanelTabInfo[] = $derived.by(() => {
    return tabs.map((t) => ({
      id: t.id,
      label: t.name,
      kind: t.kind,
      renamable: true,
      removable: true,
    }));
  });
</script>

<div class="w-full h-full flex flex-row" bind:clientWidth={containerWidth} bind:clientHeight={containerHeight}>
  {#if !isMobileLayout}
    <!-- Desktop layout. Left side: embedding / table. -->
    {#if hasEmbedding || hasTable}
      <div class="flex-1 flex flex-col overflow-hidden">
        {#if sections.embedding.length > 0}
          {@const embH = hasTable ? Math.max(0, containerHeight - tableHeight - 8) : containerHeight}
          <div
            class="overflow-hidden flex-none"
            style:height="{hasEmbedding ? embH : 0}px"
            style:transition={isResizing ? "none" : "height 300ms ease-in-out"}
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
        <!-- 8 px drag handle between embedding and table. Collapses to
             0 when either pane is hidden so it fades along with the
             pane rather than popping. -->
        <div
          class="flex-none overflow-hidden"
          style:height="{hasEmbedding && hasTable ? 8 : 0}px"
          style:transition={isResizing ? "none" : "height 300ms ease-in-out"}
        >
          <Resizer
            class="h-2 w-full"
            axis="y"
            min={100}
            max={containerHeight - 100}
            scaler={-1}
            value={tableHeight}
            onChange={(v) => (tableHeight = v)}
            onDragStart={() => (isResizing = true)}
            onDragEnd={() => (isResizing = false)}
          />
        </div>
        {#if sections.table.length > 0}
          {@const tblH = hasEmbedding ? tableHeight : containerHeight}
          <!-- Inner pinned to containerHeight so the @tanstack/svelte-
               virtual ResizeObserver sees a stable scroll-element
               height through pane transitions. -->
          <div
            class="overflow-clip flex-none"
            style:height="{hasTable ? tblH : 0}px"
            style:transition={isResizing ? "none" : "height 300ms ease-in-out"}
          >
            <div class="flex flex-col gap-1 overflow-clip min-h-0" style:height="{containerHeight}px">
              <div class="flex flex-row gap-2 overflow-hidden flex-1 min-h-0">
                {#each sections.table as id (id)}
                  <div class="flex-1 overflow-hidden rounded-md">
                    {@render chartView({ id: id, width: "container", height: "container" })}
                  </div>
                {/each}
              </div>
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
        onDragStart={() => (isResizing = true)}
        onDragEnd={() => (isResizing = false)}
      />
    {/if}
    <!-- Right side: tab strip + active-tab content. Column visibility
         follows the "show charts" setting so the existing show/hide
         control expands and collapses the whole panel as before. -->
    {#if hasChart}
      <div
        class="h-full flex flex-col"
        style:width="{hasEmbedding || hasTable ? panelWidth : containerWidth}px"
        transition:slide={{ axis: "x" }}
      >
        <div class="flex-none flex items-center gap-2 px-1 py-1">
          <PanelTabBar
            tabs={panelTabInfos}
            activeId={panelTab}
            onActivate={setPanelTab}
            onAdd={addByKind}
            onRename={renameTab}
            onDelete={deleteTab}
            chatAvailable={chatAvailable}
          />
        </div>
        {#if activeTab?.kind === "chat"}
          <!-- Remount on tab switch: each chat tab's ChatPanel
               captures its own turns array reference at mount time.
               A new chat tab activates → new ChatPanel instance
               binds to that tab's `chatTurns[id]`. Inflight streams
               in unmounted chat tabs continue against their captured
               array; when the user returns, the new mount reads the
               latest state. -->
          {#key activeTab.id}
            <div class="flex-1 min-h-0 overflow-hidden rounded-md">
              <ChatPanel
                coordinator={context.coordinator}
                table={context.table}
                filter={context.filter}
                highlight={context.highlight}
                chartContext={context}
                onSaveChart={saveInlineChartToPanel}
                bind:turns={chatTurns[activeTab.id]}
              />
            </div>
          {/key}
        {:else if activeCanvas != null}
          <div class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto">
            <div class="flex flex-row flex-wrap gap-2" bind:clientWidth={panelContainerWidth}>
              <button
                class="bg-white dark:bg-black rounded-md flex flex-col justify-center items-center gap-2 p-2 w-full text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 select-none"
                onclick={addNewChart}
              >
                + Add
              </button>
              {#each activeChartsOrder as id, index (id)}
                {@const spec = charts[id]}
                {@const isVisible = activeCanvas.chartVisibility?.[id] ?? true}
                <div
                  class="bg-white dark:bg-black rounded-md flex flex-col group"
                  style:width="{chartWidth(panelContainerWidth, 500)}px"
                  animate:flip={{ duration: 300 }}
                  out:slide
                >
                  <ListChartPanel
                    id={id}
                    spec={spec}
                    onIsVisibleChange={(v) => setChartVisibility(id, v)}
                    isVisible={isVisible}
                    colorScheme={$colorScheme}
                    chartView={chartView}
                    onRemove={removeChart.bind(null, id)}
                    onUp={index > 0 ? reorderCharts.bind(null, id, -1) : undefined}
                    onDown={index + 1 < activeChartsOrder.length ? reorderCharts.bind(null, id, 1) : undefined}
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
      </div>
    {/if}
  {:else}
    <!-- Mobile layout. Canvas separation is a desktop convenience —
         mobile flattens into a single inline list pulled from the
         first canvas tab. Chat tabs are intentionally hidden on
         mobile (textarea + history on <500px is unpleasant). -->
    {@const firstCanvas = tabs.find((t) => t.kind === "canvas") as CanvasTab | undefined}
    {@const mobileCharts = firstCanvas?.chartsOrder ?? []}
    <div class="w-full h-full overflow-y-scroll flex flex-col gap-2">
      {#each sections.embedding.concat(mobileCharts, sections.table) as id, index (id)}
        {@const isVisible = firstCanvas?.chartVisibility?.[id] ?? true}
        {@const indexInCharts = mobileCharts.indexOf(id)}
        <div class="bg-white dark:bg-black rounded-md flex flex-col group" animate:flip={{ duration: 300 }} out:slide>
          <ListChartPanel
            id={id}
            spec={charts[id]}
            onIsVisibleChange={(v) => setChartVisibility(id, v)}
            isVisible={isVisible}
            colorScheme={$colorScheme}
            chartView={chartView}
            onRemove={removeChart.bind(null, id)}
            onUp={indexInCharts > 0 ? reorderCharts.bind(null, id, -1) : undefined}
            onDown={indexInCharts != -1 && indexInCharts + 1 < mobileCharts.length
              ? reorderCharts.bind(null, id, 1)
              : undefined}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>
