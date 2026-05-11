<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script module lang="ts">
  import { maxDensityModeCategories, type DataPoint, type ViewportState } from "@embedding-atlas/component";
  import { type Coordinator } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";

  import Overlay from "./Overlay.svelte";
  import Tooltip from "./Tooltip.svelte";

  import { type EmbeddingLegend } from "../../utils/database.js";
  import { createCustomComponentClass } from "./custom_components.js";

  async function defaultViewportScale(coordinator: Coordinator, table: string, x: string, y: string): Promise<number> {
    let { stdX, stdY } = (
      await coordinator.query(
        SQL.Query.from(table).select({
          stdX: SQL.sql`STDDEV(${SQL.column(x)})::FLOAT`,
          stdY: SQL.sql`STDDEV(${SQL.column(y)})::FLOAT`,
        }),
      )
    ).get(0);
    let scale = 1.0 / (Math.max(stdX, stdY, 1e-3) * 3);
    return scale;
  }

  const CustomTooltip = createCustomComponentClass(Tooltip);
  const CustomOverlay = createCustomComponentClass(Overlay);
</script>

<script lang="ts">
  import { EmbeddingViewMosaic } from "@embedding-atlas/component/svelte";
  import { untrack } from "svelte";
  import { cubicOut } from "svelte/easing";

  import Button from "../../widgets/Button.svelte";
  import EmbeddingSearchBar from "../../widgets/EmbeddingSearchBar.svelte";
  import Select from "../../widgets/Select.svelte";
  import Slider from "../../widgets/Slider.svelte";
  import Legend from "./Legend.svelte";

  import { IconEmbeddingSettings } from "../../assets/icons.js";
  import { writable } from "svelte/store";

  import { isolatedWritable } from "../../utils/store.js";
  import type { ChartViewProps, RowID } from "../chart.js";
  import { resolveChartTheme } from "../common/theme.js";
  import { makeCategoryColumn } from "./category_column.js";
  import type { EmbeddingSpec, EmbeddingState } from "./types.js";
  import { interpolateViewport } from "./viewport_animation.js";

  const maxCategories = Math.min(20, maxDensityModeCategories());
  const defaultMinimumDensity = 1 / 16;
  const defaultDownsampleMaxPoints = 4000000;
  const minDownsampleMaxPoints = 50000;

  let {
    context,
    width,
    height,
    spec,
    state: chartState,
    onStateChange,
    onSpecChange,
    registerDelegate,
  }: ChartViewProps<EmbeddingSpec, EmbeddingState> = $props();

  // svelte-ignore state_referenced_locally
  let { colorScheme, columnStyles, searchResult, theme: themeConfig } = context;

  let theme = $derived(resolveChartTheme($colorScheme, $themeConfig));

  // svelte-ignore state_referenced_locally
  let highlightStore = isolatedWritable(context.highlight);

  let categoryColumn = $derived(spec.data.category);

  let categoryLegend: EmbeddingLegend | null = $state.raw(null);
  let totalPointCount: number | null = $state.raw(null);

  // Query total point count for render limit slider
  $effect.pre(() => {
    context.coordinator
      .query(SQL.Query.from(context.table).select({ count: SQL.sql`COUNT(*)::INT` }))
      .then((result: any) => {
        totalPointCount = result.get(0).count;
      });
  });

  let tooltip = $state.raw<DataPoint | null>(null);
  let selection = $state.raw<DataPoint[] | null>(null);
  let overlayProps = $state.raw<{ center: DataPoint | null; points: DataPoint[] } | null>(null);

  // When the detail drawer opens, clear the hover tooltip — otherwise
  // the preview card lingers under the drawer, and the user sees both
  // surfaces once the drawer is dismissed. The drawer is the
  // committed detail surface, so the preview should yield to it.
  $effect(() => {
    const store = context.detailRow;
    if (store == null) return;
    return store.subscribe((row) => {
      if (row != null && tooltip != null) tooltip = null;
    });
  });

  // Update the category mapping and legend.
  $effect.pre(() => {
    let promise = context.cache.value(`embedding/category/${categoryColumn}`, () =>
      makeCategoryColumn(context.coordinator, context.table, categoryColumn, theme),
    );
    promise.then((v) => {
      categoryLegend = v;
      if ((categoryLegend?.legend.length ?? 0) > maxCategories) {
        onSpecChange({ mode: "points" });
      }
    });
  });

  $effect.pre(() => {
    let isOnMount = true;
    let previousValue: RowID[] | null = null;
    return highlightStore.subscribe((v) => {
      selection = v;

      // Don't animate immediately on mount.
      if (isOnMount) {
        isOnMount = false;
        previousValue = v;
        return;
      }
      // Animate when a single new point is added.
      let newIDs = v ?? [];
      let oldIDs = previousValue ?? [];
      let enteringIDs = newIDs.filter((x) => oldIDs.indexOf(x) < 0);
      if (enteringIDs.length == 1) {
        animateToPoint(enteringIDs[0]);
      }
      if (tooltip != null && newIDs.indexOf(tooltip) < 0) {
        tooltip = null;
      }
      previousValue = v;
    });
  });

  $effect.pre(() =>
    searchResult.subscribe(async (result) => {
      if (result == null || result.ids.length == 0) {
        overlayProps = null;
        return;
      }
      let centerId: RowID | null = null;
      if (result.mode == "neighbors") {
        centerId = result.query;
      }
      let r = Array.from(
        await context.coordinator.query(
          SQL.Query.from(context.table)
            .select({ identifier: SQL.column(context.id), x: SQL.column(spec.data.x), y: SQL.column(spec.data.y) })
            .where(
              SQL.isIn(
                context.id,
                result.ids.concat(centerId != null ? [centerId] : []).map((x) => SQL.literal(x)),
              ),
            ),
        ),
      ) as DataPoint[];
      overlayProps = {
        center: r.filter((p) => p.identifier === centerId)[0] ?? null,
        points: r.filter((p) => p.identifier !== centerId),
      };
    }),
  );

  async function animateToPoint(identifier: RowID): Promise<void> {
    let defaultScale = await context.cache.value(`embedding/default-viewport-scale/${spec.data.x},${spec.data.y}`, () =>
      defaultViewportScale(context.coordinator, context.table, spec.data.x, spec.data.y),
    );
    let scale = defaultScale * 2;
    // Query the x, y location.
    let result = await context.coordinator.query(
      SQL.Query.from(context.table)
        .select({
          x: SQL.column(spec.data.x),
          y: SQL.column(spec.data.y),
        })
        .where(SQL.eq(SQL.column(context.id), SQL.literal(identifier))),
    );
    let { x, y } = result.get(0) as { x: number; y: number };
    // Start animation and show tooltip.
    startViewportAnimation({ x: x, y: y, scale: scale });
    tooltip = identifier;
  }

  let currentViewportAnimation: number | null;
  let animatingViewport = $state.raw<ViewportState | null>(null);
  function startViewportAnimation(newState: ViewportState) {
    tooltip = null;
    let start = animatingViewport ?? chartState.viewport;
    if (start == null) {
      onStateChange({ viewport: newState });
      return;
    }
    animatingViewport = start;
    let duration = 800;
    let t0 = new Date().getTime();
    let callback = () => {
      let t = (new Date().getTime() - t0) / duration;
      if (t > 1) {
        t = 1;
      }
      animatingViewport = interpolateViewport(start, newState, cubicOut(t));
      if (t < 1) {
        currentViewportAnimation = requestAnimationFrame(callback);
      } else {
        onStateChange({ viewport: animatingViewport });
      }
    };
    if (currentViewportAnimation) {
      cancelAnimationFrame(currentViewportAnimation);
    }
    currentViewportAnimation = requestAnimationFrame(callback);
  }

  // Register an "Embed" tab in the page-level settings modal.
  // The snippet content is defined below; it captures spec /
  // categoryColumn / categoryLegend etc. via closure and stays in
  // sync as the user adjusts settings. `untrack` insulates the
  // registration from prop-identity churn (LayoutView's chartView
  // snippet creates a fresh `registerDelegate` arrow each frame
  // during layout transitions; we don't want to thrash the
  // registration).
  $effect(() => {
    return untrack(() => {
      if (!registerDelegate) return;
      return registerDelegate({
        // Short label — the strip tabs are 48 px wide. The icon is
        // intentionally distinct from IconEmbeddingView (which the
        // strip's show/hide-embedding toggle uses) so the two
        // embedding-related buttons are visually unambiguous.
        settingsTitle: "Embed",
        settingsIcon: IconEmbeddingSettings,
        settingsContent: embeddingSettings,
      });
    });
  });

  // Search bar plumbing: the host (EmbeddingAtlas.svelte) wires its
  // search state into `chartContext` as Writable stores. The bar
  // renders only when *all* of those are present (otherwise the
  // chart was constructed in a context without atlas-level search
  // — e.g. as an embedded component — and the bar should be
  // invisible). Local fallback stores keep the `$store` template
  // syntax happy when the host hasn't wired them.
  // svelte-ignore state_referenced_locally
  let searchQueryStore = $derived(context.searchQuery ?? writable(""));
  // svelte-ignore state_referenced_locally
  let searchFilterEnabledStore = $derived(context.searchFilterEnabled ?? writable(false));
  // svelte-ignore state_referenced_locally
  let searchResultVisibleStore = $derived(context.searchResultVisible ?? writable(false));
  // svelte-ignore state_referenced_locally
  let searcherStatusStore = $derived(context.searcherStatus ?? writable(""));
  // svelte-ignore state_referenced_locally
  let searchFilterPendingStore = $derived(context.searchFilterPending ?? writable(false));
  let hasSearch = $derived(
    context.searchQuery != null &&
      context.searchMode != null &&
      context.searchResultVisible != null &&
      context.searchFilterEnabled != null &&
      context.searcherStatus != null,
  );
</script>

<div class="relative">
  <EmbeddingViewMosaic
    width={width}
    height={height}
    coordinator={context.coordinator}
    table={context.table}
    filter={context.narrowedFilter ?? context.filter}
    rangeSelection={context.filter}
    identifier={context.id}
    x={spec.data.x}
    y={spec.data.y}
    text={spec.data.text}
    image={spec.data.image}
    importance={spec.data.importance}
    category={categoryLegend?.indexColumn}
    categoryColors={categoryLegend?.legend.map((x) => x.color) ?? [theme.embeddingColor]}
    config={{
      colorScheme: $colorScheme,
      ...context.embeddingViewConfig,
      mode: spec.mode ?? "points",
      ...(spec.minimumDensity != null ? { minimumDensity: spec.minimumDensity } : {}),
      ...(spec.pointSize != null ? { pointSize: spec.pointSize } : {}),
      downsampleMaxPoints: spec.downsampleMaxPoints ?? defaultDownsampleMaxPoints,
    }}
    labels={context.embeddingViewLabels}
    cache={context.persistentCache}
    additionalFields={Object.fromEntries(context.columns.map((c) => [c.name, c.name]))}
    customTooltip={{
      class: CustomTooltip,
      props: {
        darkMode: $colorScheme,
        columnStyles: $columnStyles,
        onNearestNeighborSearch:
          (context.searchModes ?? []).indexOf("neighbors") >= 0 ? (id: any) => context.search?.(id, "neighbors") : null,
        onOpenDetail: context.detailRow
          ? (point: DataPoint) => context.detailRow?.set((point.fields ?? null) as Record<string, any> | null)
          : null,
      },
    }}
    customOverlay={{
      class: CustomOverlay,
      props: { ...(overlayProps ?? { points: [], center: null }) },
    }}
    viewportState={animatingViewport ?? chartState.viewport}
    onViewportState={(v) => onStateChange({ viewport: v })}
    rangeSelectionValue={chartState.brush}
    onRangeSelection={(v) => onStateChange({ brush: v ?? undefined })}
    tooltip={tooltip}
    onTooltip={(v) => {
      tooltip = v;
    }}
    selection={selection}
    onSelection={(points) => {
      selection = points;
      highlightStore.set(points?.map((p) => p.identifier) ?? null);
    }}
  />
  <div class="absolute top-0 left-0 right-0 flex flex-wrap justify-between items-start pointer-events-none">
    {#if categoryLegend != null}
      <div
        class="flex-none m-2 p-2 rounded-md bg-slate-100/75 dark:bg-slate-800/75 backdrop-blur-sm pointer-events-auto order-3"
      >
        <Legend
          context={context}
          spec={{ items: categoryLegend.legend }}
          state={chartState.legend ?? {}}
          mode="view"
          onSpecChange={() => {}}
          onStateChange={(update, mode) => {
            onStateChange({ legend: update });
          }}
        />
      </div>
    {/if}
    <!-- The in-pane Color picker + Settings popup that previously
         lived here have been moved into the Embed tab of the
         page-level settings modal (registered via registerDelegate
         above). The modal is the single home for chart-scoped
         settings; the embedding canvas no longer displays controls
         overlaid on the data. -->
  </div>
  <!-- Search bar: glass-translucent input + dropdown anchored to the
       embedding canvas's top-left corner. State (query / mode /
       filter-toggle / result store / status) lives in
       EmbeddingAtlas.svelte and travels through `chartContext` as
       Writable / Readable stores. The search bar only renders if
       the host has wired the stores — otherwise the chart is being
       used in a context (e.g. an embed) without atlas-level search
       and the bar should be invisible. -->
  {#if hasSearch}
    <EmbeddingSearchBar
      searchQuery={$searchQueryStore}
      onSearchQueryChange={(v) => context.searchQuery!.set(v)}
      searchFilterEnabled={$searchFilterEnabledStore}
      onSearchFilterEnabledChange={(v) => context.searchFilterEnabled!.set(v)}
      searchFilterPending={$searchFilterPendingStore}
      searchResult={context.searchResult as any}
      searcherStatus={$searcherStatusStore}
      visible={$searchResultVisibleStore}
      onResultClick={(item) => context.highlight.set([item.id])}
      onClear={() => context.clearSearch?.()}
    />
  {/if}
</div>

{#snippet embeddingSettings()}
  <div class="flex flex-col gap-3">
    <div>
      <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide">COLOR</div>
      <Select
        class="w-full"
        value={categoryColumn}
        onChange={(v) => onSpecChange({ data: { ...spec.data, category: v } })}
        options={[
          { value: undefined, label: "--" },
          ...context.columns
            .filter((c) => c.jsType == "string" || c.jsType == "number" || c.jsType == "Date")
            .map((c) => ({ value: c.name, label: `${c.name} (${c.type})` })),
        ]}
      />
    </div>
    <div>
      <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide">
        DISPLAY MODE
      </div>
      <div class="flex gap-2 items-center">
        <Select
          value={spec.mode ?? "points"}
          onChange={(v) => onSpecChange({ mode: v })}
          disabled={categoryLegend != null && categoryLegend.legend.length > maxCategories}
          options={[
            { value: "points", label: "Points" },
            { value: "density", label: "Density" },
          ]}
        />
        {#if (spec.mode ?? "points") == "density"}
          <Slider
            bind:value={
              () => Math.log((spec.minimumDensity ?? defaultMinimumDensity) / defaultMinimumDensity),
              (v) => onSpecChange({ minimumDensity: defaultMinimumDensity * Math.exp(v) })
            }
            min={-4}
            max={4}
            step={0.05}
          />
        {/if}
      </div>
    </div>
    <div>
      <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide">
        POINT SIZE
      </div>
      <div class="flex gap-2 items-center">
        <Slider
          bind:value={() => spec.pointSize ?? 1, (v) => onSpecChange({ pointSize: v })}
          min={1}
          max={10}
          step={0.05}
        />
        <Button label="Auto" onClick={() => onSpecChange({ pointSize: undefined })} />
      </div>
    </div>
    {#if totalPointCount != null && totalPointCount > minDownsampleMaxPoints}
      {@const effectiveLimit = spec.downsampleMaxPoints ?? Math.min(defaultDownsampleMaxPoints, totalPointCount)}
      {@const isMaxed = effectiveLimit >= totalPointCount}
      <div>
        <div
          class="text-xs font-semibold text-slate-500 dark:text-slate-400 select-none mb-1.5 tracking-wide flex justify-between"
        >
          <span>MAX POINTS</span>
          <span class="font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">
            {isMaxed
              ? "All"
              : effectiveLimit >= 1000000
                ? (effectiveLimit / 1000000).toFixed(1) + "M"
                : (effectiveLimit / 1000).toFixed(0) + "K"}
            {#if !isMaxed}
              / {totalPointCount >= 1000000
                ? (totalPointCount / 1000000).toFixed(1) + "M"
                : (totalPointCount / 1000).toFixed(0) + "K"}
            {/if}
          </span>
        </div>
        <Slider
          bind:value={
            () =>
              spec.downsampleMaxPoints ??
              Math.min(defaultDownsampleMaxPoints, totalPointCount ?? defaultDownsampleMaxPoints),
            (v) => onSpecChange({ downsampleMaxPoints: v })
          }
          min={minDownsampleMaxPoints}
          max={totalPointCount}
          step={Math.max(10000, Math.floor(totalPointCount / 100 / 10000) * 10000)}
        />
      </div>
    {/if}
  </div>
{/snippet}
