<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { debounce } from "@embedding-atlas/utils";
  import { Selection } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";
  import { onMount, setContext } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { writable } from "svelte/store";
  import { scale } from "svelte/transition";

  import LayoutOptionsView from "./layouts/LayoutOptionsView.svelte";
  import LayoutView from "./layouts/LayoutView.svelte";
  import ColumnStylePicker from "./views/ColumnStylePicker.svelte";
  import FilteredCount from "./views/FilteredCount.svelte";
  import SearchResultList from "./views/SearchResultList.svelte";
  import ActionButton from "./widgets/ActionButton.svelte";
  import Button from "./widgets/Button.svelte";
  import CommandPalette from "./widgets/CommandPalette.svelte";
  import Input from "./widgets/Input.svelte";
  import SegmentedControl from "./widgets/SegmentedControl.svelte";
  import Select from "./widgets/Select.svelte";
  import SettingsDrawer from "./widgets/SettingsDrawer.svelte";
  import Slider from "./widgets/Slider.svelte";
  import Spinner from "./widgets/Spinner.svelte";

  import {
    IconBraces,
    IconDarkMode,
    IconDashboardLayout,
    IconDownload,
    IconExport,
    IconLightMode,
    IconListLayout,
    IconSearch,
    IconSettings,
  } from "./assets/icons.js";

  import type { EmbeddingAtlasProps, EmbeddingAtlasState } from "./api.js";
  import { ChartContextCache, type ChartContext, type ChartDelegate, type RowID } from "./charts/chart.js";
  import { type ChartThemeConfig } from "./charts/common/theme.js";
  import { defaultCharts } from "./charts/default_charts.js";
  import { buildCommands } from "./commands/builtin.js";
  import { EMBEDDING_ATLAS_VERSION } from "./constants.js";
  import { type TableTab } from "./layouts/list/types.js";
  import { provideModelContext } from "./model_context/model_context.js";
  import { type ColumnStyle } from "./renderers/types.js";
  import { performSearch, querySearchResultItems, resolveSearcher, type SearchResultItem } from "./search/search.js";
  import { type ChatTurn } from "./utils/chat_client.js";
  import { CHAT_CONTEXT_KEY, type ChatProvider } from "./utils/chat_context.js";
  import { makeColorSchemeStore } from "./utils/color_scheme.js";
  import { columnDescriptions, distinctCounts, predicateToString, type ColumnDesc } from "./utils/database.js";
  import { latestAsync } from "./utils/latest_async.js";

  // Maximum number of results the searcher returns. Reactive so the
  // user can tune it from the Search settings tab in the drawer; the
  // searcher's `limit` is read at query-time. Persisted to
  // localStorage so the choice survives reloads.
  const SEARCH_LIMIT_KEY = "embedding-atlas:search-limit";
  const SEARCH_LIMIT_DEFAULT = 500;
  let searchLimit = $state(SEARCH_LIMIT_DEFAULT);

  let {
    coordinator,
    data,
    initialState,
    searcher: specifiedSearcher,
    defaultChartsConfig,
    embeddingViewConfig = null,
    embeddingViewLabels = null,
    chartTheme,
    colorScheme: colorSchemeProp,
    onExportApplication,
    onExportSelection,
    onStateChange,
    modelContext,
    chatEndpoint,
    cache,
  }: EmbeddingAtlasProps = $props();

  const { colorScheme, userColorScheme } = makeColorSchemeStore();

  $effect.pre(() => {
    $userColorScheme = colorSchemeProp;
  });

  let container: HTMLDivElement;

  let initialized = $state(false);

  let exportFormat: "json" | "jsonl" | "csv" | "parquet" = $state("parquet");

  const crossFilter = Selection.crossfilter();

  function currentPredicate(): string | null {
    return predicateToString(crossFilter.predicate(null));
  }

  let columns: ColumnDesc[] = $state.raw([]);
  // Distinct counts for non-numeric columns; populated lazily after first
  // paint so the Color group of palette commands can grow in.
  let columnDistinctCounts = $state.raw<Record<string, number>>({});

  // Column styles
  let columnStyles = $state.raw<Record<string, ColumnStyle>>({});
  let resolvedColumnStyles = writable<Record<string, ColumnStyle>>({});
  $effect.pre(() => {
    let resolved = resolveColumnStyles(columns, columnStyles);
    resolvedColumnStyles.set(resolved);
  });

  function resolveColumnStyles(
    columns: ColumnDesc[],
    styles: Record<string, ColumnStyle>,
  ): Record<string, ColumnStyle> {
    let result: Record<string, ColumnStyle> = {};
    for (let column of columns) {
      result[column.name] = {
        display: data.text == column.name ? "full" : "badge",
        ...(styles[column.name] ?? {}),
      };
    }
    return result;
  }

  // Search

  // Use a default searcher FullTextSearcher when searcher is not specified
  // svelte-ignore state_referenced_locally
  let searcher = resolveSearcher({
    coordinator,
    table: data.table,
    idColumn: data.id,
    textColumn: data.text,
    neighborsColumn: data.neighbors,
    searcher: specifiedSearcher,
  });

  let searchModes = [
    ...(searcher.fullTextSearch != null ? ["full-text"] : []),
    ...(searcher.vectorSearch != null ? ["vector"] : []),
    ...(searcher.nearestNeighbors != null ? ["neighbors"] : []),
  ];

  const searchModeOptions: Record<string, { value: string; label: string }> = {
    "full-text": { value: "full-text", label: "Full Text" },
    vector: { value: "vector", label: "Vector" },
    neighbors: { value: "neighbors", label: "Neighbors" },
  };

  // Search state lives in writable stores rather than `$state` so it
  // can be passed through `chartContext` to the EmbeddingSearchBar
  // (which is mounted inside `Embedding.svelte`, on the other side
  // of LayoutView). Stores are the canonical Svelte way to share
  // mutable state across component boundaries.
  let searchModeStore = writable<"full-text" | "vector">("full-text");
  let searchQueryStore = writable("");
  let searcherStatusStore = writable("");
  let searchResultVisibleStore = writable(false);
  // New: filter-table-to-results toggle. Persisted to localStorage so
  // the user's preference within the dataset survives reloads.
  const SEARCH_FILTER_KEY = "embedding-atlas:search-filter";
  let searchFilterEnabledStore = writable(false);
  let searchResultStore = writable<{
    query: any;
    mode: string;
    ids: RowID[];
    label: string;
    highlight: string;
    items: SearchResultItem[];
  } | null>(null);

  const doSearch = latestAsync(
    async (query: any, mode: string) => {
      searchResultVisibleStore.set(true);

      let predicate = currentPredicate();
      let searcherResult = await performSearch({
        searcher: searcher,
        predicate: predicate,
        query: query,
        mode: mode,
        limit: searchLimit,
        onStatus: (status) => {
          searcherStatusStore.set(status);
        },
      });

      // Apply predicate in case the searcher does not handle predicate.
      // And convert the search result ids to tuples.
      let result = await querySearchResultItems(
        coordinator,
        data.table,
        { id: data.id, x: data.projection?.x, y: data.projection?.y, text: data.text },
        Object.fromEntries(columns.map((c) => [c.name, c.name])),
        predicate,
        searcherResult,
      );

      let label = query.toString().trim();
      let highlight = query.toString().trim();

      if (mode == "neighbors") {
        label = "Neighbors of #" + query.toString();
        highlight = "";
      }

      searcherStatusStore.set("");

      return {
        query: query,
        mode: mode,
        ids: result.map((x) => x.id),
        label: label,
        highlight: highlight,
        items: result,
      };
    },
    (result) => {
      searchResultStore.set(result);
    },
  );

  const debouncedSearch = debounce(doSearch, 500);

  function clearSearch() {
    searchResultStore.set(null);
    searchResultVisibleStore.set(false);
  }

  $effect.pre(() => {
    if ($searchQueryStore == "") {
      clearSearch();
    } else {
      debouncedSearch($searchQueryStore, $searchModeStore);
    }
  });

  // Search-as-crossfilter publication. When the user opts into
  // filtering via the search bar's funnel toggle AND there's a
  // non-empty query AND the searcher has returned at least one
  // result, publish a `column IN (ids)` predicate to the global
  // cross-filter under a stable per-search source identity. The
  // predicates panel automatically displays this clause as a chip
  // (just like header filters appear there); clearing the chip
  // independently clears the filter.
  //
  // Source identity pattern mirrors HeaderFilterPopover.svelte —
  // a stable object so subsequent updates with the same source
  // replace the existing clause; updating with a `null` predicate
  // releases it.
  const searchFilterSource = { __searchFilter: true } as const;
  $effect(() => {
    const enabled = $searchFilterEnabledStore;
    const query = $searchQueryStore;
    const result = $searchResultStore;
    const ids = result?.ids ?? [];
    const shouldFilter = enabled && query !== "" && ids.length > 0;
    if (shouldFilter) {
      const predicate = SQL.isIn(
        SQL.column(data.id),
        ids.map((id) => SQL.literal(id) as any),
      );
      crossFilter.update({
        source: searchFilterSource,
        clients: new Set(),
        predicate: predicate as any,
        value: query,
      });
    } else {
      crossFilter.update({
        source: searchFilterSource,
        clients: new Set(),
        predicate: null,
        value: null,
      });
    }
  });

  // Filter

  function resetFilter() {
    for (let item of crossFilter.clauses) {
      let source = item.source;
      source?.reset?.();
      crossFilter.update({ ...item, value: null, predicate: null });
    }
  }

  function loadState(state: EmbeddingAtlasState) {
    charts = state.charts ?? {};
    chartStates = state.chartStates ?? {};
    layout = state.layout ?? "list";
    layoutStates = state.layoutStates ?? {};
    columnStyles = state.columnStyles ?? {};
  }

  function getCurrentState(): EmbeddingAtlasState {
    return {
      version: EMBEDDING_ATLAS_VERSION,
      timestamp: new Date().getTime() / 1000,
      charts: charts,
      chartStates: chartStates,
      layout: layout,
      layoutStates: layoutStates,
      columnStyles: columnStyles,
      predicate: currentPredicate(),
    };
  }

  // Emit onStateChange event.
  $effect(() => {
    if (!initialized) {
      return;
    }
    onStateChange?.(getCurrentState());
  });

  onMount(async () => {
    columns = (await columnDescriptions(coordinator, data.table)).filter((x) => !x.name.startsWith("__"));
    chartContext.columns = columns;

    if (initialState) {
      loadState(initialState);
    }
    if (Object.keys(charts).length == 0) {
      let newCharts = await defaultCharts({
        coordinator,
        table: data.table,
        id: data.id,
        projection: data.projection
          ? {
              ...data.projection,
              text: data.text ?? undefined,
              image: data.image ?? undefined,
              importance: data.importance ?? undefined,
            }
          : undefined,
        config: defaultChartsConfig ?? undefined,
      });
      charts = Object.fromEntries(newCharts.map((spec, i) => [`${i + 1}`, spec]));
    }

    initialized = true;

    // Compute distinct counts for non-numeric columns in the background so
    // we can decide which columns belong in the Color group of the palette.
    // Single batched SQL pass — much cheaper than N parallel queries on
    // large datasets. Errors fall back to an empty map; missing entries
    // just hide the corresponding palette row.
    void (async () => {
      try {
        const targets = columns.filter((c) => c.jsType === "string").map((c) => c.name);
        columnDistinctCounts = await distinctCounts(coordinator, data.table, targets);
      } catch {
        columnDistinctCounts = {};
      }
    })();
  });

  let paletteOpen = $state(false);
  let chatState = $state<{ turns: ChatTurn[] }>({ turns: [] });

  const chatProvider: ChatProvider = {
    get endpoint() {
      return chatEndpoint ?? null;
    },
    get context() {
      return {
        predicate: currentPredicate(),
        table: data.table,
        id_column: data.id,
        text_column: data.text ?? null,
      };
    },
    state: chatState,
  };
  setContext(CHAT_CONTEXT_KEY, chatProvider);

  function onWindowKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      paletteOpen = !paletteOpen;
      e.preventDefault();
      return;
    }
    if (e.key == "Escape") {
      if (paletteOpen) {
        paletteOpen = false;
        e.preventDefault();
        return;
      }
      resetFilter();
      e.preventDefault();
      try {
        let active: any = document.activeElement;
        active?.blur?.();
      } catch (e) {}
    }
  }

  // svelte-ignore state_referenced_locally
  let chartThemeStore = writable<ChartThemeConfig | undefined>(chartTheme ?? undefined);

  $effect.pre(() => {
    chartThemeStore.set(chartTheme ?? undefined);
  });

  // svelte-ignore state_referenced_locally
  let chartContext: ChartContext = {
    coordinator: coordinator,
    filter: crossFilter,
    table: data.table,
    id: data.id,
    columns: [],
    colorScheme: colorScheme,
    theme: chartThemeStore,
    columnStyles: resolvedColumnStyles,
    cache: new ChartContextCache(),
    persistentCache: cache ?? { get: async () => null, set: async (key, value) => {} },
    searchModes: searchModes,
    search: doSearch,
    searchResult: searchResultStore,
    searchQuery: searchQueryStore,
    searchMode: searchModeStore,
    searchResultVisible: searchResultVisibleStore,
    searchFilterEnabled: searchFilterEnabledStore,
    searcherStatus: searcherStatusStore,
    highlight: writable(null),
    embeddingViewConfig: embeddingViewConfig,
    embeddingViewLabels: embeddingViewLabels,
  };

  let charts = $state.raw<Record<string, any>>({});
  let chartStates = $state.raw<Record<string, any>>({});
  let layout = $state.raw<string>("list");
  let layoutStates = $state.raw<Record<string, any>>({});

  let tableTab = $derived((layoutStates.list?.tableTab ?? "table") as TableTab);

  function setTableTab(tab: TableTab) {
    layoutStates = { ...layoutStates, list: { ...(layoutStates.list ?? {}), tableTab: tab } };
  }

  let colorCandidates = $derived(
    columns
      .filter((c) => c.jsType === "string")
      .map((c) => c.name)
      .filter((name) => {
        const n = columnDistinctCounts[name];
        return n != null && n >= 2 && n <= 50;
      }),
  );

  function colorEmbeddingBy(column: string) {
    const embId = Object.entries(charts).find(([, spec]: [string, any]) => spec?.type === "embedding")?.[0];
    if (!embId) return;
    const current = charts[embId];
    charts = {
      ...charts,
      [embId]: { ...current, data: { ...(current?.data ?? {}), category: column } },
    };
  }

  let paletteCommands = $derived(
    buildCommands({
      layout,
      setLayout: (l) => (layout = l),
      isDark: $colorScheme === "dark",
      toggleDarkMode: () => ($userColorScheme = $colorScheme === "light" ? "dark" : "light"),
      resetFilter,
      chatAvailable: chatProvider.endpoint != null,
      tableTab,
      setTableTab,
      colorCandidates,
      colorBy: colorEmbeddingBy,
    }),
  );

  // SvelteMap so add/delete on the inner Sets propagates reactivity
  // to `chartSettingsGroups` below. The outer type is still a plain
  // Map<…> since `provideModelContext` consumes it that way (SvelteMap
  // extends Map, so the contract is preserved for the model-context
  // path which doesn't need reactivity).
  let chartDelegates = new SvelteMap<string, Set<ChartDelegate>>();

  function registerChartDelegate(id: string, delegate: ChartDelegate): () => void {
    let set = chartDelegates.get(id);
    if (!set) {
      // Wrap the inner Set in a SvelteSet so Set.add/delete notifies
      // readers of `chartSettingsGroups`. Without this the derived
      // would only re-run when the outer Map changes (i.e. on first
      // delegate per id), missing later registrations on the same id.
      set = new SvelteSet<ChartDelegate>();
      chartDelegates.set(id, set);
    }
    set.add(delegate);
    return () => {
      chartDelegates.get(id)?.delete(delegate);
    };
  }

  // Snippets contributed by charts to the settings drawer. Iteration
  // order follows chart insertion order in `chartDelegates`, which
  // mirrors layout order. `key` is the chart id (stable per chart),
  // suitable for a persistent active-tab token in localStorage.
  let chartSettingsGroups = $derived.by(() => {
    const groups: {
      key: string;
      title: string;
      icon?: import("svelte").Component<{ class?: string }>;
      content: import("svelte").Snippet;
    }[] = [];
    for (const [id, set] of chartDelegates) {
      for (const d of set) {
        if (d.settingsContent) {
          groups.push({
            key: id,
            title: d.settingsTitle ?? "Settings",
            icon: d.settingsIcon,
            content: d.settingsContent,
          });
          break; // One settings tab per chart id; first delegate wins.
        }
      }
    }
    return groups;
  });

  // Drawer open/closed (UI-only, not persisted across reloads — a
  // user closes it when they're done) plus active tab key (persisted
  // so power users land on their preferred tab on next load).
  let drawerOpen = $state(false);
  const ACTIVE_TAB_KEY = "embedding-atlas:settings-tab";
  let activeSettingsKey = $state<string>("global");
  // Hydrate from localStorage on mount; written back on change.
  $effect(() => {
    try {
      const v = localStorage.getItem(ACTIVE_TAB_KEY);
      if (v) activeSettingsKey = v;
    } catch {
      // ignore (e.g. SSR or storage disabled)
    }
  });
  $effect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, activeSettingsKey);
    } catch {
      /* ignore */
    }
  });

  // Hydrate searchLimit from localStorage on mount; written back on change.
  $effect(() => {
    try {
      const v = localStorage.getItem(SEARCH_LIMIT_KEY);
      if (v != null) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 50 && n <= 2000) searchLimit = n;
      }
    } catch {
      /* ignore */
    }
  });
  $effect(() => {
    try {
      localStorage.setItem(SEARCH_LIMIT_KEY, String(searchLimit));
    } catch {
      /* ignore */
    }
  });

  // Hydrate searchFilterEnabled from localStorage; subscribe to write back.
  try {
    const v = localStorage.getItem(SEARCH_FILTER_KEY);
    if (v != null) searchFilterEnabledStore.set(v === "true");
  } catch {
    /* ignore */
  }
  searchFilterEnabledStore.subscribe((v) => {
    try {
      localStorage.setItem(SEARCH_FILTER_KEY, v ? "true" : "false");
    } catch {
      /* ignore */
    }
  });

  let mcpStatus = $state.raw<string | undefined>(undefined);

  onMount(() => {
    if (modelContext) {
      provideModelContext(modelContext, {
        context: chartContext,
        set charts(x) {
          charts = x;
        },
        get charts() {
          return charts;
        },
        set chartStates(x) {
          chartStates = x;
        },
        get chartStates() {
          return chartStates;
        },
        set layout(x) {
          layout = x;
        },
        get layout() {
          return layout;
        },
        set layoutStates(x) {
          layoutStates = x;
        },
        get layoutStates() {
          return layoutStates;
        },
        get chartDelegates() {
          return chartDelegates;
        },
        get container() {
          return container;
        },
        get columnStyles() {
          return columnStyles;
        },
        set columnStyles(x) {
          columnStyles = x;
        },
      });

      $effect(() => {
        let subs = modelContext.connectionStatus?.subscribe((value) => {
          mcpStatus = value;
        });
        return () => {
          subs?.();
        };
      });
    }
  });

  async function onCopyState() {
    let text = JSON.stringify(getCurrentState());
    await navigator.clipboard.writeText(text);
  }
</script>

<div
  class="embedding-atlas-root"
  class:dark={$colorScheme == "dark"}
  style:width="100%"
  style:height="100%"
  style:position="relative"
  style:color-scheme={$colorScheme}
  bind:this={container}
>
  <div
    class="w-full h-full flex flex-col text-slate-800 bg-slate-200 dark:text-slate-200 dark:bg-slate-800"
  >
    <!-- Toolbar -->
    <div class="m-2 flex flex-row items-center gap-2 flex-wrap">
      {#if initialized}
        <!-- Left side -->
        <div class="flex flex-row flex-1 justify-between min-w-[180px]">
          {#if $searchModeStore.length > 0}
            <div class="relative w-full">
              <Input
                type="search"
                placeholder="Search..."
                className="w-full max-w-[400px] "
                bind:value={$searchQueryStore}
              />
              {#if searchModes.filter((x) => x != "neighbors").length > 1}
                <Select
                  options={searchModes.filter((x) => x != "neighbors").map((x) => searchModeOptions[x])}
                  value={$searchModeStore}
                  onChange={(v) => searchModeStore.set(v)}
                />
              {/if}

              {#if $searchResultVisibleStore}
                <div
                  class="absolute w-96 left-0 top-[32px] rounded-md right-0 z-20 border border-slate-300 dark:border-slate-600 overflow-hidden resize shadow-lg bg-white/75 dark:bg-slate-800/75 backdrop-blur-sm"
                  style:height="48em"
                >
                  {#if $searchResultStore != null}
                    {@const searchResult = $searchResultStore}
                    {#key searchResult}
                      <SearchResultList
                        items={searchResult.items}
                        label={searchResult.label}
                        highlight={searchResult.highlight}
                        limit={searchLimit}
                        onClick={async (item) => {
                          chartContext.highlight.set(item.id);
                        }}
                        onClose={clearSearch}
                        columnStyles={$resolvedColumnStyles}
                      />
                    {/key}
                  {:else if $searcherStatusStore != null}
                    <div class="p-2">
                      <Spinner status={$searcherStatusStore} />
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {:else}
            <div class="text-slate-500 dark:text-slate-400">Embedding Atlas</div>
          {/if}
        </div>
        <!-- Filter status (count + clear) and Export Selection both
             moved out of the top toolbar:
               - FilteredCount + clear-X live in the embedding pane's
                 bottom-right overlay (`charts/embedding/Embedding.svelte`).
               - Export Selection lives in the Global → Export tab of
                 the settings popover above. -->
        <div class="flex flex-none flex-row gap-2">
          <div class="grid grid-cols-1 grid-rows-1 justify-items-end items-center">
            {#key layout}
              <div transition:scale class="col-start-1 row-start-1">
                <LayoutOptionsView
                  context={chartContext}
                  charts={charts}
                  chartStates={chartStates}
                  layout={layout}
                  layoutStates={layoutStates}
                  onChartsChange={(v) => (charts = v)}
                  onChartStatesChange={(v) => (chartStates = v)}
                  onLayoutStatesChange={(v) => (layoutStates = v)}
                />
              </div>
            {/key}
          </div>
          <SegmentedControl
            value={layout}
            onChange={(v) => (layout = v)}
            options={[
              { value: "list", icon: IconListLayout, title: "List layout" },
              { value: "dashboard", icon: IconDashboardLayout, title: "Dashboard layout" },
            ]}
          />
          {#if colorSchemeProp == null}
            <Button
              icon={$colorScheme == "dark" ? IconLightMode : IconDarkMode}
              title="Toggle light / dark mode"
              onClick={() => {
                $userColorScheme = $colorScheme == "light" ? "dark" : "light";
              }}
            />
          {/if}
          <Button
            icon={IconSettings}
            title="Settings"
            onClick={() => (drawerOpen = !drawerOpen)}
          />
        </div>
      {/if}
    </div>
    <!-- Main Content -->
    <div class="flex-1 overflow-hidden h-full ml-2 mr-2 mb-2">
      {#if initialized}
        <LayoutView
          context={chartContext}
          layout={layout}
          layoutStates={layoutStates}
          charts={charts}
          chartStates={chartStates}
          onChartsChange={(v) => (charts = v)}
          onChartStatesChange={(v) => (chartStates = v)}
          onLayoutStatesChange={(v) => (layoutStates = v)}
          registerChartDelegate={registerChartDelegate}
        />
      {/if}
    </div>
  </div>

  {#if initialized}
    <CommandPalette open={paletteOpen} onClose={() => (paletteOpen = false)} commands={paletteCommands}>
      {#snippet statusBar()}
        <FilteredCount coordinator={coordinator} filter={crossFilter} table={data.table} />
      {/snippet}
    </CommandPalette>
  {/if}

  <!-- Settings drawer: overlays the right edge of the atlas. Stays
       mounted across open/close so registered chart snippets keep
       their internal state; visibility is animated by transform on
       the wrapper, see SettingsDrawer.svelte. -->
  <SettingsDrawer
    open={drawerOpen}
    onClose={() => (drawerOpen = false)}
    globalContent={globalSettings}
    pageGroups={[{ key: "search", title: "Search", icon: IconSearch, content: searchSettings }]}
    chartGroups={chartSettingsGroups}
    activeKey={activeSettingsKey}
    onActiveKeyChange={(k) => (activeSettingsKey = k)}
    mcpStatus={mcpStatus}
    version={EMBEDDING_ATLAS_VERSION}
  />
</div>
<svelte:window onkeydown={onWindowKeydown} />

{#snippet globalSettings()}
  {#if columns.length > 0}
    <h4 class="text-slate-500 dark:text-slate-400 select-none">Column Styles</h4>
    <ColumnStylePicker
      columns={columns}
      styles={$resolvedColumnStyles}
      onStylesChange={(value) => {
        columnStyles = value;
      }}
    />
  {/if}
  <h4 class="text-slate-500 dark:text-slate-400 select-none">Export</h4>
  <div class="flex flex-col gap-2">
    <ActionButton
      icon={IconBraces}
      label="Copy State"
      title="Copy the current Embedding Atlas state as JSON to clipboard."
      class="w-48"
      onClick={onCopyState}
    />
    {#if onExportApplication}
      <ActionButton
        icon={IconDownload}
        label="Export Application"
        title="Download a self-contained static web application"
        class="w-48"
        onClick={onExportApplication}
      />
    {/if}
    {#if onExportSelection}
      <!-- Export selection: same controls that previously lived in the
           top-toolbar pill — the action button + format picker. The
           current cross-filter predicate is computed at click time. -->
      <div class="flex flex-row gap-2">
        <ActionButton
          icon={IconExport}
          label="Export Selection"
          title="Export rows matching the active filter"
          class="w-48"
          onClick={() => onExportSelection!(currentPredicate(), exportFormat)}
        />
        <Select
          label="Format"
          value={exportFormat}
          onChange={(v) => (exportFormat = v)}
          options={[
            { value: "parquet", label: "Parquet" },
            { value: "jsonl", label: "JSONL" },
            { value: "json", label: "JSON" },
            { value: "csv", label: "CSV" },
          ]}
        />
      </div>
    {/if}
  </div>
  <!-- MCP status and version moved out of the Global tab body and
       into the SettingsDrawer footer, where they stay visible
       regardless of which tab is selected. -->
{/snippet}

{#snippet searchSettings()}
  <div class="flex flex-col gap-4">
    <div>
      <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide">
        MAX RESULTS
      </div>
      <div class="flex items-center gap-3">
        <Slider bind:value={searchLimit} min={50} max={2000} step={50} width={220} />
        <span class="text-sm font-mono text-slate-700 dark:text-slate-200 tabular-nums w-12 text-right">
          {searchLimit}
        </span>
      </div>
      <div class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
        Cap on the number of results the searcher returns. The dropdown shows the top 20; the rest land
        in the table when the filter toggle is on.
      </div>
    </div>
    {#if searchModes.length > 1}
      <div>
        <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide">
          MODE
        </div>
        <Select
          value={$searchModeStore}
          onChange={(v) => searchModeStore.set(v)}
          options={searchModes.filter((x) => x != "neighbors").map((x) => searchModeOptions[x])}
        />
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
          Full-text matches keywords; vector matches by semantic similarity to the embedding.
        </div>
      </div>
    {/if}
  </div>
{/snippet}
