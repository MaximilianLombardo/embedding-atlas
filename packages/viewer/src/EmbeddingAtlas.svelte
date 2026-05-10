<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { debounce } from "@embedding-atlas/utils";
  import { Selection } from "@uwdata/mosaic-core";
  import { onMount, setContext } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { writable } from "svelte/store";

  import LayoutView from "./layouts/LayoutView.svelte";
  import Resizer from "./layouts/list/Resizer.svelte";
  import ColumnStylePicker from "./views/ColumnStylePicker.svelte";
  import FilteredCount from "./views/FilteredCount.svelte";
  import ActionButton from "./widgets/ActionButton.svelte";
  import AtlasIconStrip from "./widgets/AtlasIconStrip.svelte";
  import CommandPalette from "./widgets/CommandPalette.svelte";
  import Select from "./widgets/Select.svelte";
  import SettingsPanel from "./widgets/SettingsPanel.svelte";
  import Slider from "./widgets/Slider.svelte";

  import {
    IconBraces,
    IconDarkMode,
    IconDashboardLayout,
    IconDownload,
    IconEmbeddingView,
    IconExport,
    IconLightMode,
    IconListLayout,
    IconMenu,
    IconSearch,
    IconSettings,
    IconTable,
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
  // user can tune it from the Search settings tab in the panel; the
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

  let searchMode = $state<"full-text" | "vector">("full-text");

  let searchQuery = $state("");
  let searcherStatus = $state("");
  let searchResultVisible = $state(false);
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
      searchResultVisible = true;

      let predicate = currentPredicate();
      let searcherResult = await performSearch({
        searcher: searcher,
        predicate: predicate,
        query: query,
        mode: mode,
        limit: searchLimit,
        onStatus: (status) => {
          searcherStatus = status;
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

      searcherStatus = "";

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
    searchResultVisible = false;
  }

  $effect.pre(() => {
    if (searchQuery == "") {
      clearSearch();
    } else {
      debouncedSearch(searchQuery, searchMode);
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
    // ⌘B / Ctrl+B toggles the settings panel — VS Code parity.
    // When opening, lands on the user's last-active section
    // (default "global"). Browser default for ⌘B (toggle bookmarks
    // bar in Chrome / Safari) is suppressed via preventDefault.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      panelKey = panelKey !== null ? null : lastNonNullKey;
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

  // Snippets contributed by charts to the settings panel. Iteration
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

  // Source of truth for "what panel section is showing":
  //   panelKey === null     → panel closed
  //   panelKey === "global" → panel open, Global section
  //   panelKey === <key>    → panel open to that section
  //
  // `lastNonNullKey` remembers the last open section so re-opening
  // (via the gear toggle, ⌘B, or page reload) lands on the user's
  // preferred tab rather than always Global. Both persisted.
  // Legacy "embedding-atlas:settings-tab" is read once for users
  // who set it under the previous chrome version.
  const PANEL_KEY_KEY = "embedding-atlas:panel-key";
  const PANEL_LAST_KEY = "embedding-atlas:panel-last-key";
  let panelKey = $state<string | null>(null);
  let lastNonNullKey = $state<string>("global");
  $effect(() => {
    if (panelKey !== null) lastNonNullKey = panelKey;
  });
  $effect(() => {
    try {
      const v = localStorage.getItem(PANEL_KEY_KEY);
      if (v != null) panelKey = v === "" ? null : v;
      const last = localStorage.getItem(PANEL_LAST_KEY);
      if (last) {
        lastNonNullKey = last;
      } else {
        const legacy = localStorage.getItem("embedding-atlas:settings-tab");
        if (legacy) lastNonNullKey = legacy;
      }
    } catch {
      /* ignore */
    }
  });
  $effect(() => {
    try {
      localStorage.setItem(PANEL_KEY_KEY, panelKey ?? "");
      localStorage.setItem(PANEL_LAST_KEY, lastNonNullKey);
    } catch {
      /* ignore */
    }
  });
  // Width of the inline settings panel when open. Animated between
  // 0 (closed) and this value (open) by SettingsPanel itself; the
  // resizer between the panel and the main content drives drag
  // resize. Persisted to localStorage so the user's chosen width
  // survives reloads. Range 240–720 px; values outside this band
  // on read are ignored and the default kicks in instead.
  const SETTINGS_PANEL_WIDTH_KEY = "embedding-atlas:settings-panel-width";
  const SETTINGS_PANEL_WIDTH_DEFAULT = 360;
  const SETTINGS_PANEL_WIDTH_MIN = 240;
  const SETTINGS_PANEL_WIDTH_MAX = 720;
  let settingsPanelWidth = $state(SETTINGS_PANEL_WIDTH_DEFAULT);
  // Container width for the horizontal flex root, bound via
  // `bind:clientWidth`. Used to clamp the resizer's max value so
  // the panel can't squeeze the main content below ~200px.
  let containerWidth = $state(800);

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

  // Hydrate settingsPanelWidth from localStorage on mount; written back on change.
  $effect(() => {
    try {
      const v = localStorage.getItem(SETTINGS_PANEL_WIDTH_KEY);
      if (v != null) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= SETTINGS_PANEL_WIDTH_MIN && n <= SETTINGS_PANEL_WIDTH_MAX) {
          settingsPanelWidth = n;
        }
      }
    } catch {
      /* ignore */
    }
  });
  $effect(() => {
    try {
      localStorage.setItem(SETTINGS_PANEL_WIDTH_KEY, String(settingsPanelWidth));
    } catch {
      /* ignore */
    }
  });

  // Toggle a boolean field on the LIST layout's state. The strip's
  // visibility section is always visible and always active across
  // every layout, so this helper always targets list state — even
  // when the user is on dashboard. The effect lands silently and
  // appears the next time the user switches back to list.
  function toggleListField(field: string, defaultValue: boolean) {
    const current = ((layoutStates.list ?? {}) as Record<string, any>)[field] ?? defaultValue;
    layoutStates = {
      ...layoutStates,
      list: { ...(layoutStates.list ?? {}), [field]: !current },
    };
  }

  // Sections fed to AtlasIconStrip. The strip is presentational —
  // it has no atlas-state knowledge of its own — so we derive the
  // full button list (icons + active states + handlers) here and
  // hand it to the strip. See widgets/AtlasIconStrip.svelte.
  //
  // Sections (top to bottom):
  //   1. tabs (kind="tabs")    — Global, Search, chart-contributed.
  //                              Open / switch / close the panel.
  //   2. layout (kind="radio") — List / Dashboard. Switch layout.
  //   3. show-hide (kind="toggles") — Embedding / Table / Charts
  //                              visibility. Always visible AND
  //                              always active, on every layout.
  //                              State lives on the LIST layout
  //                              regardless of current layout, so
  //                              clicks on dashboard mutate list
  //                              state silently and the effect
  //                              appears on next list-switch.
  //   4. theme (kind="momentary") — Sun ↔ Moon icon swap. Hidden
  //                              when the host hard-codes
  //                              colorScheme.
  // The LAST section is pinned to the bottom via AtlasIconStrip's
  // mt-auto rule on its preceding divider.
  let stripSections = $derived.by(() => {
    // Show-hide active states always reflect LIST-LAYOUT state, so
    // the buttons read truthfully even while the user is on dashboard.
    const listState = (layoutStates.list ?? {}) as Record<string, any>;
    const showEmbedding = (listState.showEmbedding ?? true) as boolean;
    const showTable = (listState.showTable ?? true) as boolean;
    const showCharts = (listState.showCharts ?? true) as boolean;

    type StripButton = {
      value?: string;
      icon: import("svelte").Component<{ class?: string }>;
      title: string;
      active?: boolean;
      onClick: () => void;
    };
    type StripSection = {
      key: string;
      kind: "tabs" | "radio" | "toggles" | "momentary";
      buttons: StripButton[];
    };

    // Tabs section (top): one button per panel section. Click opens
    // the panel to that section; click the active tab again closes
    // it. Sourced from Global + Search + chart-contributed groups,
    // so adding a chart automatically surfaces a tab here.
    const tabsButtons: StripButton[] = [
      {
        value: "global",
        icon: IconSettings,
        title: "Global settings",
        active: panelKey === "global",
        onClick: () => (panelKey = panelKey === "global" ? null : "global"),
      },
      {
        value: "search",
        icon: IconSearch,
        title: "Search settings",
        active: panelKey === "search",
        onClick: () => (panelKey = panelKey === "search" ? null : "search"),
      },
    ];
    for (const g of chartSettingsGroups) {
      const k = g.key;
      tabsButtons.push({
        value: k,
        icon: g.icon ?? IconSettings,
        title: g.title,
        active: panelKey === k,
        onClick: () => (panelKey = panelKey === k ? null : k),
      });
    }

    const sections: StripSection[] = [
      {
        key: "tabs",
        kind: "tabs",
        buttons: tabsButtons,
      },
      {
        key: "layout",
        kind: "radio",
        buttons: [
          {
            value: "list",
            icon: IconListLayout,
            title: "List layout",
            active: layout === "list",
            onClick: () => (layout = "list"),
          },
          {
            value: "dashboard",
            icon: IconDashboardLayout,
            title: "Dashboard layout",
            active: layout === "dashboard",
            onClick: () => (layout = "dashboard"),
          },
        ],
      },
    ];

    sections.push({
      key: "show-hide",
      kind: "toggles",
      buttons: [
        {
          icon: IconEmbeddingView,
          title: "Show / hide embedding",
          active: showEmbedding,
          onClick: () => toggleListField("showEmbedding", true),
        },
        {
          icon: IconTable,
          title: "Show / hide table",
          active: showTable,
          onClick: () => toggleListField("showTable", true),
        },
        {
          icon: IconMenu,
          title: "Show / hide charts",
          active: showCharts,
          onClick: () => toggleListField("showCharts", true),
        },
      ],
    });

    if (colorSchemeProp == null) {
      sections.push({
        key: "theme",
        kind: "momentary",
        buttons: [
          {
            icon: $colorScheme === "dark" ? IconLightMode : IconDarkMode,
            title: "Toggle light / dark mode",
            onClick: () => {
              $userColorScheme = $colorScheme === "light" ? "dark" : "light";
            },
          },
        ],
      });
    }

    return sections;
  });

  // Flat list of every panel section the SettingsPanel might render.
  // Order: Global, Search, then chart-contributed sections in chart
  // insertion order. The strip's "tabs" section is derived from the
  // same source, so the strip and panel always agree on what
  // sections exist.
  let panelSections = $derived.by(() => {
    return [
      { key: "global", title: "Global", content: globalSettings },
      { key: "search", title: "Search", content: searchSettings },
      ...chartSettingsGroups.map((g) => ({ key: g.key, title: g.title, content: g.content })),
    ];
  });

  // Race-fix for panelKey persistence. On reload, panelKey hydrates
  // synchronously from localStorage but chart delegates register
  // asynchronously as charts mount. If we validate the persisted
  // panelKey before charts have registered, sections like "embed"
  // (the embedding chart's settings tab) will look unknown and we'd
  // wrongly clear the user's preference.
  //
  // Strategy: defer validation until ALL expected chart sections
  // have registered. `expectedChartIds` is the set of chart ids
  // declared in `charts` after `defaultCharts` resolves; we wait
  // for `chartDelegates.size` to reach that count, then check if
  // panelKey resolves to any known section. If not, reset to null
  // AND clear lastNonNullKey to "global" so the next gear-click
  // lands on a known-good tab.
  //
  // Runs once per session — subsequent user-initiated panel-open
  // attempts pointing at unknown sections won't trigger a reset.
  let raceFixApplied = $state(false);
  let expectedChartIds = $derived(new Set(Object.keys(charts)));
  $effect(() => {
    if (raceFixApplied) return;
    if (!initialized) return;
    if (expectedChartIds.size === 0) return;
    // Wait until every expected chart id has registered at least
    // one delegate. ChartView always registers a screenshot
    // delegate on mount, so reaching this size means every chart
    // is in the registry — including any contributed settingsTitle.
    if (chartDelegates.size < expectedChartIds.size) return;
    const panelKeyValid = panelKey === null || panelSections.some((s) => s.key === panelKey);
    const lastValid = panelSections.some((s) => s.key === lastNonNullKey);
    if (!panelKeyValid) panelKey = null;
    if (!lastValid) lastNonNullKey = "global";
    raceFixApplied = true;
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
  <!-- Horizontal flex root: icon strip + (optionally) settings
       panel + resizer + main content column. The strip absorbs
       all the controls that previously lived in the top toolbar
       (layout selector, show/hide toggles, theme, settings gear);
       there is no top toolbar anymore. -->
  <div
    class="w-full h-full flex flex-row text-slate-800 bg-slate-200 dark:text-slate-200 dark:bg-slate-800"
    bind:clientWidth={containerWidth}
  >
    <AtlasIconStrip sections={stripSections} />

    <!-- Inline settings panel. Width animates between 0 (closed)
         and `settingsPanelWidth` (open). Stays mounted across
         open/close so the contributed snippets keep their state
         (the same reason the chart-snippet pattern is preserved). -->
    <SettingsPanel
      width={panelKey !== null ? settingsPanelWidth : 0}
      onClose={() => (panelKey = null)}
      sections={panelSections}
      activeKey={panelKey ?? lastNonNullKey}
      mcpStatus={mcpStatus}
      version={EMBEDDING_ATLAS_VERSION}
    />
    <!-- Resizer is always mounted so it can fade alongside the
         panel's width transition (no enter/exit DOM thrash). When
         the panel is closed the wrapper collapses to 0 width and
         pointer-events:none disables the drag area. -->
    <div
      class="flex-none"
      style:width={panelKey !== null ? "4px" : "0px"}
      style:opacity={panelKey !== null ? 1 : 0}
      style:pointer-events={panelKey !== null ? "auto" : "none"}
      style:transition="width 220ms ease-out, opacity 220ms ease-out"
      aria-hidden={panelKey === null}
    >
      <Resizer
        class="w-full h-full bg-slate-300 dark:bg-slate-600 hover:bg-blue-500 dark:hover:bg-blue-400 transition-colors"
        axis="x"
        scaler={1}
        min={SETTINGS_PANEL_WIDTH_MIN}
        max={Math.min(SETTINGS_PANEL_WIDTH_MAX, Math.max(SETTINGS_PANEL_WIDTH_MIN, containerWidth - 200))}
        value={settingsPanelWidth}
        onChange={(v) => (settingsPanelWidth = v)}
      />
    </div>

    <!-- Main column: just content. min-w-0 so the column can
         shrink when the settings panel grows; without it children
         that ignore flex shrink (e.g. wide tables, fixed-width
         Mosaic clients) would refuse to compress and push the
         layout out past the container. -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div class="flex-1 overflow-hidden h-full m-2">
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
  </div>

  {#if initialized}
    <CommandPalette open={paletteOpen} onClose={() => (paletteOpen = false)} commands={paletteCommands}>
      {#snippet statusBar()}
        <FilteredCount coordinator={coordinator} filter={crossFilter} table={data.table} />
      {/snippet}
    </CommandPalette>
  {/if}
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
       into the SettingsPanel footer, where they stay visible
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
          value={searchMode}
          onChange={(v) => (searchMode = v)}
          options={searchModes.filter((x) => x != "neighbors").map((x) => searchModeOptions[x])}
        />
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
          Full-text matches keywords; vector matches by semantic similarity to the embedding.
        </div>
      </div>
    {/if}
  </div>
{/snippet}
