<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { debounce } from "@embedding-atlas/utils";
  import { Selection } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";
  import { onMount, setContext } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { get, writable } from "svelte/store";

  import DetailDrawer from "./charts/instances/DetailDrawer.svelte";
  import LayoutView from "./layouts/LayoutView.svelte";
  import ColumnStylePicker from "./views/ColumnStylePicker.svelte";
  import FilteredCount from "./views/FilteredCount.svelte";
  import ActionButton from "./widgets/ActionButton.svelte";
  import AtlasIconStrip from "./widgets/AtlasIconStrip.svelte";
  import CommandPalette from "./widgets/CommandPalette.svelte";
  import Select from "./widgets/Select.svelte";
  import SettingsModal from "./widgets/SettingsModal.svelte";
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
  import { type PanelTab } from "./layouts/list/types.js";
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

  // `bind:this` updates this on mount; the settings modal's portal
  // target reads it, so it needs to be reactive ($state.raw is fine —
  // we only care about reference identity, not nested reactivity).
  let container = $state.raw<HTMLDivElement | undefined>(undefined);

  let initialized = $state(false);

  let exportFormat: "json" | "jsonl" | "csv" | "parquet" = $state("parquet");

  const crossFilter = Selection.crossfilter();

  // Dedicated single-clause selection that holds ONLY the search
  // filter chip (when the funnel is on). Publishing here instead of
  // to `crossFilter` keeps the search clause out of the global
  // cross-filter state, so charts subscribed to `crossFilter`
  // directly (CountPlot, Predicates, FilteredCount) don't refire
  // on every keystroke or toggle.
  const searchSelection = Selection.single();

  // `crossfilter({ include: [...] })` relays clauses from both
  // upstream selections into this one. Subscribers (table +
  // embedding) get the union of brushes + search clause, with the
  // cross-mode self-skip logic still applied via `clause.clients`.
  const narrowedFilter = Selection.crossfilter({
    include: [crossFilter, searchSelection],
  });

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

  // Hybrid is listed first when available so it becomes the default
  // pick of the Select component (we also explicitly initialize
  // searchModeStore to "hybrid" below when present).
  let searchModes = [
    ...(searcher.hybridSearch != null ? ["hybrid"] : []),
    ...(searcher.fullTextSearch != null ? ["full-text"] : []),
    ...(searcher.vectorSearch != null ? ["vector"] : []),
    ...(searcher.nearestNeighbors != null ? ["neighbors"] : []),
  ];

  const searchModeOptions: Record<string, { value: string; label: string }> = {
    hybrid: { value: "hybrid", label: "Hybrid" },
    "full-text": { value: "full-text", label: "Full Text" },
    vector: { value: "vector", label: "Vector" },
    neighbors: { value: "neighbors", label: "Neighbors" },
  };

  // Search state lives in writable stores rather than `$state` so it
  // can be passed through `chartContext` to the EmbeddingSearchBar
  // (which is mounted inside `Embedding.svelte`, on the other side
  // of LayoutView). Stores are the canonical Svelte way to share
  // mutable state across component boundaries.
  // Default mode is hybrid when available (lexical + semantic in one
  // ranked list), else fall back to full-text.
  let searchModeStore = writable<"hybrid" | "full-text" | "vector">(
    searcher.hybridSearch != null ? "hybrid" : "full-text",
  );
  let searchQueryStore = writable("");
  let searcherStatusStore = writable("");
  let searchResultVisibleStore = writable(false);
  // New: filter-table-to-results toggle. Persisted to localStorage so
  // the user's preference within the dataset survives reloads.
  const SEARCH_FILTER_KEY = "embedding-atlas:search-filter";
  let searchFilterEnabledStore = writable(false);
  // Pending state for the funnel button's spinner. Goes true when we
  // publish a search clause, clears after a short fixed window so the
  // bar doesn't show a frozen spinner if Mosaic finishes faster than
  // the cascade is visible to the user. Tied to a timer that's reset
  // whenever a new publication happens.
  let searchFilterPendingStore = writable(false);
  let searchFilterPendingTimer: ReturnType<typeof setTimeout> | null = null;
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
      // Race guard for the trailing debounce timer: text-input mode
      // is debounced 500ms, so if the user types then clears,
      // clearSearch() runs on the empty-input branch but the trailing
      // timer still fires with stale args — re-showing the dropdown.
      // The guard skips that stale fire. Neighbors mode bypasses
      // debounce (tooltip button → direct call) and its query is a
      // row id, not the text-input value, so the guard would
      // incorrectly block legitimate neighbor lookups.
      if (mode !== "neighbors" && get(searchQueryStore).trim() === "") return null;
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

  // Search-filter publication. When the user opts into filtering via
  // the search bar's funnel toggle AND there's a non-empty query AND
  // the searcher has returned at least one result, publish a
  // `column IN (ids)` predicate to `searchSelection`. Because
  // `narrowedFilter` includes (relays from) `searchSelection`, the
  // clause flows to subscribers of `narrowedFilter` (table +
  // embedding) but NOT to subscribers of `crossFilter` directly
  // (CountPlot, Predicates, FilteredCount) — reducing the
  // cross-filter cascade from N clients to 2.
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
      searchSelection.update({
        source: searchFilterSource,
        clients: new Set(),
        predicate: predicate as any,
        value: query,
      });
    } else {
      searchSelection.update({
        source: searchFilterSource,
        clients: new Set(),
        predicate: null,
        value: null,
      });
    }
    // Spinner pulse on the funnel button. Mosaic doesn't expose a
    // "cascade settled" event from here, so we use a fixed window
    // sized to the observed latency (~420ms for the full cascade).
    // Clear any in-flight timer first so back-to-back publications
    // (e.g. typing) don't clear the spinner prematurely.
    if (searchFilterPendingTimer != null) clearTimeout(searchFilterPendingTimer);
    searchFilterPendingStore.set(true);
    searchFilterPendingTimer = setTimeout(() => {
      searchFilterPendingStore.set(false);
      searchFilterPendingTimer = null;
    }, 400);
  });

  // Filter

  function resetFilter() {
    for (let item of crossFilter.clauses) {
      let source = item.source;
      source?.reset?.();
      crossFilter.update({ ...item, value: null, predicate: null });
    }
    // Also clear the search clause so a "reset all filters" gesture
    // covers it. Flipping the funnel off (instead of clearing the
    // clause here) would leave the user's funnel preference toggled
    // off — undesirable for a transient reset.
    searchSelection.update({
      source: searchFilterSource,
      clients: new Set(),
      predicate: null,
      value: null,
    });
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

    // Proactively warm up the searcher's heavy resources (hybrid-mode
    // embedder model) so the user's first search query doesn't pay
    // the ~22MB model download + WebGPU init latency on a cold start.
    // Fire-and-forget; if it fails, hybrid will just lazy-load on
    // first query as before.
    void searcher.warmup?.().catch(() => {});
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
    // ⌘B / Ctrl+B and ⌘, / Ctrl+, both toggle the settings modal.
    // ⌘B is kept for VS Code muscle-memory; ⌘, is the OS-standard
    // "open preferences" shortcut. When opening, the modal lands on
    // the user's last-active tab (persisted as `activeTab`). Browser
    // defaults for ⌘B (toggle bookmarks bar) and ⌘, (none in most
    // browsers) are suppressed via preventDefault.
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "b" || e.key === ",")) {
      settingsOpen = !settingsOpen;
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

  // Detail-drawer state. Lifted out of `Instances.svelte` so that
  // the embedding tooltip can write into it via the "Open detail"
  // action. The drawer is rendered once at the top of this component;
  // both the table's row double-click and the embedding's tooltip
  // button feed it through `chartContext.detailRow`.
  let detailRowStore = writable<Record<string, any> | null>(null);
  let detailRowValue = $state<Record<string, any> | null>(null);
  detailRowStore.subscribe((v) => (detailRowValue = v));

  // Table-reveal channel. The drawer's "Show in table" button calls
  // `revealRow(id)` which: forces list layout + showTable, bumps a
  // nonce-tagged ticket here, and closes the drawer. Instances
  // subscribes to the ticket and runs animateToPoint when nonce
  // changes — nonce-based so re-revealing the same row still fires.
  let revealTicketStore = writable<{ id: RowID; nonce: number } | null>(null);
  let revealNonce = 0;
  function revealRow(id: RowID) {
    if (id == null) return;
    if (layout !== "list") layout = "list";
    const listState = (layoutStates.list ?? {}) as Record<string, any>;
    if (listState.showTable === false) {
      layoutStates = { ...layoutStates, list: { ...listState, showTable: true } };
    }
    // Highlight the row so the user has a visual anchor for where the
    // scroll landed. Without this the scroll happens silently and
    // looks like the button "didn't work" — particularly when the
    // drawer is still open over part of the table.
    chartContext.highlight.set([id]);
    revealNonce += 1;
    revealTicketStore.set({ id, nonce: revealNonce });
    // Intentionally NOT closing the drawer here: the panel only covers
    // the right portion of the viewport, the table is still visible
    // to the left, and keeping the drawer open lets the user see both
    // the row's highlight AND its detail until they explicitly dismiss.
  }

  // svelte-ignore state_referenced_locally
  let chartContext: ChartContext = {
    coordinator: coordinator,
    filter: crossFilter,
    narrowedFilter: narrowedFilter,
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
    clearSearch: () => {
      // Drop both the query AND the result so the embedding overlay
      // (orange points + lines) clears too. Setting query to "" alone
      // only works for typed-text search — Neighbors mode opens the
      // dropdown with an empty query, so we need to null the result
      // directly here.
      searchQueryStore.set("");
      searchResultStore.set(null);
      searchResultVisibleStore.set(false);
    },
    searchResult: searchResultStore,
    searchQuery: searchQueryStore,
    searchMode: searchModeStore,
    searchResultVisible: searchResultVisibleStore,
    searchFilterEnabled: searchFilterEnabledStore,
    searchFilterPending: searchFilterPendingStore,
    searcherStatus: searcherStatusStore,
    highlight: writable(null),
    detailRow: detailRowStore,
    revealRow: revealRow,
    revealTicket: revealTicketStore,
    embeddingViewConfig: embeddingViewConfig,
    embeddingViewLabels: embeddingViewLabels,
  };

  let charts = $state.raw<Record<string, any>>({});
  let chartStates = $state.raw<Record<string, any>>({});
  let layout = $state.raw<string>("list");
  let layoutStates = $state.raw<Record<string, any>>({});

  let panelTab = $derived((layoutStates.list?.panelTab ?? "charts") as PanelTab);

  function setPanelTab(tab: PanelTab) {
    layoutStates = { ...layoutStates, list: { ...(layoutStates.list ?? {}), panelTab: tab } };
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
      panelTab,
      setPanelTab,
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

  // Settings modal state.
  //   settingsOpen — whether the modal is currently mounted/visible.
  //                  Intentionally NOT persisted: a modal is an
  //                  ephemeral "focus experience" — closing the app
  //                  and reopening should not reopen the modal. This
  //                  matches macOS preferences behavior.
  //   activeTab    — which tab the modal lands on. Persisted so the
  //                  user returns to the section they last used.
  //                  Defaults to "global". Legacy keys are read once
  //                  for users who set them under the previous
  //                  chrome version (right-edge drawer / inline
  //                  panel).
  const SETTINGS_TAB_KEY = "embedding-atlas:settings-active-tab";
  let settingsOpen = $state(false);
  let activeTab = $state<string>("global");
  $effect(() => {
    try {
      const v = localStorage.getItem(SETTINGS_TAB_KEY);
      if (v) {
        activeTab = v;
      } else {
        const legacy =
          localStorage.getItem("embedding-atlas:panel-last-key") ??
          localStorage.getItem("embedding-atlas:settings-tab");
        if (legacy) activeTab = legacy;
      }
    } catch {
      /* ignore */
    }
  });
  $effect(() => {
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, activeTab);
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
  //   1. layout    (kind="radio")     — List / Dashboard. Switch layout.
  //   2. show-hide (kind="toggles")   — Embedding / Table / Charts
  //                                     visibility. Always visible AND
  //                                     always active, on every layout.
  //                                     State lives on the LIST layout
  //                                     regardless of current layout, so
  //                                     clicks on dashboard mutate list
  //                                     state silently and the effect
  //                                     appears on next list-switch.
  //   3. theme    (kind="momentary")  — pinnedToBottom. Sun ↔ Moon icon
  //                                     swap. Hidden when the host
  //                                     hard-codes colorScheme.
  //   4. settings (kind="momentary")  — pinnedToBottom. Gear icon, opens
  //                                     the settings modal. Section
  //                                     navigation (Global / Search /
  //                                     chart-contributed) lives inside
  //                                     the modal as a vertical tab
  //                                     strip rather than in the icon
  //                                     strip.
  // The first section flagged `pinnedToBottom` (theme when colorScheme
  // is auto, otherwise settings) plus everything after it gets pushed
  // to the bottom edge by AtlasIconStrip's `mt-auto` rule. Theme +
  // settings together feel like a single "lower-left corner" group.
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
      kind: "radio" | "toggles" | "momentary";
      buttons: StripButton[];
      pinnedToBottom?: boolean;
    };

    const sections: StripSection[] = [
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
      {
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
      },
    ];

    // Bottom-pinned group: theme (if auto) then settings. Order
    // matters — theme goes first so settings ends up at the very
    // bottom corner (the user reads from top to bottom, and the
    // gear is the more frequently-clicked "destination" of the two).
    if (colorSchemeProp == null) {
      sections.push({
        key: "theme",
        kind: "momentary",
        pinnedToBottom: true,
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

    sections.push({
      key: "settings",
      kind: "momentary",
      pinnedToBottom: true,
      buttons: [
        {
          icon: IconSettings,
          title: "Settings (⌘B)",
          onClick: () => (settingsOpen = true),
        },
      ],
    });

    return sections;
  });

  // Flat list of every panel section the SettingsModal renders as a
  // vertical tab. Order: Global, Search, then chart-contributed
  // sections in chart insertion order. Each section provides its own
  // icon for the modal's sidebar; chart-contributed sections inherit
  // the icon from their ChartDelegate.settingsIcon registration.
  let panelSections = $derived.by(() => {
    return [
      { key: "global", title: "Global", icon: IconSettings, content: globalSettings },
      { key: "search", title: "Search", icon: IconSearch, content: searchSettings },
      ...chartSettingsGroups.map((g) => ({ key: g.key, title: g.title, icon: g.icon, content: g.content })),
    ];
  });

  // The persisted activeTab may point at a chart-contributed section
  // (e.g. "embed") whose chart hasn't registered yet on first paint,
  // or that doesn't exist in this session at all. The modal handles
  // both cases by falling back to its first section (Global) when
  // `activeTab` doesn't match any registered section — see the
  // `resolvedKey` derivation in SettingsModal.svelte. The activeTab
  // value itself is left alone so that once the relevant chart
  // registers (mid-session) the modal swaps to the user's intended
  // section.

  // Hydrate searchFilterEnabled from localStorage; subscribe to write
  // back. searchFilterEnabledStore is declared near the top of this
  // module (alongside the other search stores) and exposed via
  // chartContext so the EmbeddingSearchBar in Embedding.svelte can
  // read + flip it.
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
          // Non-null assert: provideModelContext runs in onMount, which
          // fires after the bind:this has set `container` to the
          // mounted div. The optional type is only there to satisfy
          // svelte-check before mount.
          return container!;
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
  <!-- Horizontal flex root: icon strip + main content column. The
       strip absorbs all the controls that previously lived in the
       top toolbar (layout selector, show/hide toggles, theme,
       settings gear); there is no top toolbar anymore. The settings
       UI is a modal overlay (see SettingsModal below) rather than
       an inline panel, so the row layout is just strip + main. -->
  <div
    class="w-full h-full flex flex-row text-slate-800 bg-slate-200 dark:text-slate-200 dark:bg-slate-800"
  >
    <AtlasIconStrip sections={stripSections} />

    <!-- Main column: just content. min-w-0 so the column can shrink
         when needed; without it children that ignore flex shrink
         (wide tables, fixed-width Mosaic clients) would refuse to
         compress and push the layout out past the container. -->
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

  <!-- Settings modal. Open/close is fully controlled by `settingsOpen`;
       bits-ui's Dialog handles focus trap, ESC, click-outside, and
       portals the content out of the flex row above. Active tab is
       persisted via `activeTab`. Portal target is the atlas root so
       the modal lives inside the `.dark` class scope — Tailwind dark
       variants are ancestor-based and would otherwise be skipped if
       the modal portaled to document.body. -->
  <SettingsModal
    open={settingsOpen}
    onOpenChange={(v) => (settingsOpen = v)}
    sections={panelSections}
    activeKey={activeTab}
    onActiveKeyChange={(v) => (activeTab = v)}
    mcpStatus={mcpStatus}
    version={EMBEDDING_ATLAS_VERSION}
    portalTo={container}
  />

  {#if initialized}
    <CommandPalette open={paletteOpen} onClose={() => (paletteOpen = false)} commands={paletteCommands}>
      {#snippet statusBar()}
        <FilteredCount coordinator={coordinator} filter={crossFilter} table={data.table} />
      {/snippet}
    </CommandPalette>
  {/if}
</div>

<DetailDrawer
  row={detailRowValue}
  idColumn={data.id}
  columns={columns.map((c) => c.name)}
  columnStyles={$resolvedColumnStyles}
  onClose={() => detailRowStore.set(null)}
  onShowInTable={(id) => revealRow(id)}
/>

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
          value={$searchModeStore}
          onChange={(v) => searchModeStore.set(v)}
          options={searchModes.filter((x) => x != "neighbors").map((x) => searchModeOptions[x])}
        />
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
          Hybrid combines keyword + semantic matching in one ranked list. Full-text matches keywords
          only; vector matches by semantic similarity to the embedding.
        </div>
      </div>
    {/if}
  </div>
{/snippet}
