<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Glass-translucent search bar that lives in the upper-left corner of
  the embedding canvas. Replaces the previous top-toolbar search input.

  Visual:
    ┌─[Search...                ⓕ]─┐    ← input + right-aligned filter toggle
    └─────────────────────────────────┘
    ┌─────────────────────────────────┐
    │ N results · top 20 shown        │  ← dropdown header
    │                                 │
    │ result card 1                   │
    │ result card 2                   │  ← top-20 ranked, click to fly-to
    │ ...                             │
    │ ··· N-20 more in table ↓        │
    │                                 │
    │ ● Filtering table to N results  │  ← footer (only when filter on)
    └─────────────────────────────────┘

  This component is presentational. State (`searchQuery`,
  `searchFilterEnabled`, the result store) lives in
  `EmbeddingAtlas.svelte`; this component receives bindings and emits
  user actions through callbacks. Result clicks fire
  `onResultClick(item)` which the host wires into
  `chartContext.highlight.set(id)` — same contract the previous
  top-toolbar search bar used.

  The filter toggle is *intent only* — it flips `searchFilterEnabled`
  but doesn't itself publish a `crossFilter` clause. The host owns
  that effect (so the clause publication can compose with the rest
  of the cross-filter machinery and be cleared symmetrically when
  the query empties out). See `EmbeddingAtlas.svelte`'s
  filter-as-crossfilter effect.
-->
<script lang="ts">
  import Mark from "mark.js";
  import type { Readable } from "svelte/store";

  import { IconClose, IconFilter, IconSearch } from "../assets/icons.js";
  import type { SearchResultItem } from "../search/search.js";

  /** A subset of the search result store shape this component cares about. */
  interface SearchResult {
    query: any;
    label: string;
    highlight: string;
    items: SearchResultItem[];
  }

  interface Props {
    /** Two-way bound — typing in the input updates this. */
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    /** Two-way bound — toggle button updates this. */
    searchFilterEnabled: boolean;
    onSearchFilterEnabledChange: (value: boolean) => void;
    /** Result store from the host. Null until the first query lands. */
    searchResult: Readable<SearchResult | null>;
    /** Status text from the searcher (e.g. "Loading model…"). */
    searcherStatus?: string;
    /** Whether the dropdown should be shown. False = collapsed. */
    visible: boolean;
    /** Click on a result row. Host wires this to highlight + animateToPoint. */
    onResultClick?: (item: SearchResultItem) => void;
    /** Clear button on the input — host clears its own state. */
    onClear?: () => void;
  }

  let {
    searchQuery,
    onSearchQueryChange,
    searchFilterEnabled,
    onSearchFilterEnabledChange,
    searchResult,
    searcherStatus = "",
    visible,
    onResultClick,
    onClear,
  }: Props = $props();

  // Top-20 of the ranked results — preview cap. The remainder lands
  // in the table when the filter toggle is on; that's where the user
  // browses the long tail.
  const PREVIEW_LIMIT = 20;

  let result = $derived($searchResult);
  let allItems = $derived(result?.items ?? []);
  let previewItems = $derived(allItems.slice(0, PREVIEW_LIMIT));
  let overflowCount = $derived(Math.max(0, allItems.length - PREVIEW_LIMIT));
  // Show dropdown when the host says it should be visible AND there's
  // either content or a status to display.
  let dropdownVisible = $derived(visible && (allItems.length > 0 || searcherStatus !== ""));

  // The filter clause is "live" when the toggle is on AND there's a
  // non-empty query AND results have landed. The host owns the
  // actual cross-filter publication; here we just render the footer
  // accordingly.
  let filterActive = $derived(
    searchFilterEnabled && searchQuery.trim() !== "" && allItems.length > 0,
  );

  /**
   * Pull a sensible "title" out of a result item. Most useful field
   * is the configured `text` column (the embedding's data.text), if
   * any. Fall back to the first string-shaped field. Last resort:
   * the id itself.
   */
  function titleOf(item: SearchResultItem): string {
    if (item.text != null && String(item.text).length > 0) return String(item.text);
    for (const [k, v] of Object.entries(item.fields ?? {})) {
      if (k === "__id__") continue;
      if (typeof v === "string" && v.length > 0) return v;
    }
    return String(item.id);
  }

  /**
   * mark.js highlighting on the title — wraps occurrences of the
   * search query in <mark> tags. Same pattern as SearchResultList.
   * Implemented as a Svelte action so it re-runs when the highlight
   * argument changes.
   */
  function applyHighlight(node: HTMLElement, highlight: string) {
    function run(h: string) {
      const m = new Mark(node);
      m.unmark({
        done: () => {
          if (h) m.mark(h);
        },
      });
    }
    run(highlight);
    return {
      update(h: string) {
        run(h);
      },
    };
  }
</script>

<div class="absolute top-0 left-0 z-10 m-2 flex flex-col gap-1 pointer-events-auto">
  <!-- Input + filter toggle (always visible) -->
  <div
    class="flex items-center gap-1 h-8 px-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm shadow-sm w-72"
  >
    <IconSearch class="w-4 h-4 flex-none text-slate-400 dark:text-slate-500" />
    <input
      type="search"
      placeholder="Search..."
      value={searchQuery}
      oninput={(e) => onSearchQueryChange((e.target as HTMLInputElement).value)}
      class="flex-1 min-w-0 bg-transparent outline-none text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
    />
    {#if searchQuery !== ""}
      <button
        type="button"
        onclick={() => onClear?.()}
        title="Clear"
        class="flex-none p-0.5 rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
      >
        <IconClose class="w-3.5 h-3.5" />
      </button>
    {/if}
    <button
      type="button"
      onclick={() => onSearchFilterEnabledChange(!searchFilterEnabled)}
      title={searchFilterEnabled ? "Disable filter — show all rows in the table" : "Filter table to search results"}
      class="flex-none p-1 rounded transition focus-visible:outline-2 outline-blue-600 -outline-offset-1"
      class:bg-blue-500={searchFilterEnabled}
      class:text-white={searchFilterEnabled}
      class:hover:bg-blue-600={searchFilterEnabled}
      class:text-slate-400={!searchFilterEnabled}
      class:dark:text-slate-500={!searchFilterEnabled}
      class:hover:text-slate-700={!searchFilterEnabled}
      class:dark:hover:text-slate-200={!searchFilterEnabled}
    >
      <IconFilter class="w-3.5 h-3.5" />
    </button>
  </div>

  <!-- Dropdown -->
  {#if dropdownVisible}
    <div
      class="w-72 max-h-[60vh] flex flex-col rounded-md border border-slate-300 dark:border-slate-600 bg-white/85 dark:bg-slate-900/85 backdrop-blur-sm shadow-md overflow-hidden"
    >
      <!-- Header strip -->
      {#if searcherStatus !== "" && allItems.length === 0}
        <div class="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">
          {searcherStatus}
        </div>
      {:else if allItems.length > 0}
        <div
          class="px-3 py-1.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400 tracking-wide border-b border-slate-200 dark:border-slate-700"
        >
          {allItems.length} {allItems.length === 1 ? "result" : "results"}
          {#if overflowCount > 0}· top {PREVIEW_LIMIT} shown{/if}
        </div>
      {/if}

      <!-- Result cards -->
      <div class="flex-1 overflow-y-auto py-1">
        {#each previewItems as item (item.id)}
          <button
            type="button"
            onclick={() => onResultClick?.(item)}
            class="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 transition group"
          >
            <div class="flex items-baseline gap-2">
              <div
                class="flex-1 min-w-0 text-sm text-slate-900 dark:text-slate-100 truncate"
                use:applyHighlight={result?.highlight ?? ""}
              >
                {titleOf(item)}
              </div>
              {#if item.distance != null}
                <div class="flex-none text-[10px] font-mono tabular-nums text-slate-400 dark:text-slate-500">
                  {item.distance.toFixed(2)}
                </div>
              {/if}
            </div>
          </button>
        {/each}

        {#if overflowCount > 0}
          <div
            class="px-3 py-1.5 text-[10px] italic text-slate-400 dark:text-slate-500 text-center"
          >
            ··· {overflowCount} more {overflowCount === 1 ? "result" : "results"} in table ↓
          </div>
        {/if}
      </div>

      <!-- Filter-active footer -->
      {#if filterActive}
        <div
          class="flex-none px-3 py-1.5 flex items-center gap-1.5 border-t border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30"
        >
          <div class="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
          <span class="text-[11px] font-medium text-blue-700 dark:text-blue-300">
            Filtering table to {allItems.length} {allItems.length === 1 ? "result" : "results"}
          </span>
        </div>
      {/if}
    </div>
  {/if}
</div>
