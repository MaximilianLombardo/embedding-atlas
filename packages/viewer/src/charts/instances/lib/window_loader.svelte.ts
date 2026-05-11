// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Sliding-window data loader backed by Mosaic.
//
// The virtualized table renders against a *virtual length* equal to
// `totalCount`, but only holds `WINDOW_SIZE` rows in memory at any time.
// As the user scrolls, the window slides: when the visible range drifts
// past the cushion, we re-anchor the window around the new range and fire
// a fresh windowed query through Mosaic. Throttling keeps fling-scrolls
// from issuing a query per frame.
//
// Two Mosaic clients sit underneath:
//   - countClient — refreshed when filter/sort/columns change. Drives totalCount.
//   - dataClient  — windowed SELECT…LIMIT…OFFSET. Re-fires when offset shifts.
//
// Both clients subscribe to `context.filter` so cross-filter changes
// auto-trigger queries (the coordinator handles that). Manual slides
// (driven by scroll position) call `dataClient.requestQuery()` which the
// coordinator runs as a fresh query.
//
// Why a queue of pending offsets:
//   When the user flick-scrolls, multiple slide queries can be in flight.
//   We need to drop stale results so the table doesn't briefly show
//   window N+2 then revert to N+1. The queue captures `windowOffset` at
//   query-build time; on result, we pop and only commit if the popped
//   offset still matches the current intended offset. Combined with the
//   ~100ms throttle on slides, the queue depth stays at 1 in practice.

import { makeClient, type Coordinator, type Selection } from "@uwdata/mosaic-core";
import * as SQL from "@uwdata/mosaic-sql";

import type { ColumnStyle } from "../../../renderers/types.js";
import type { RowID } from "../../chart.js";
import { instancesQuery } from "../query.js";
import type { SortOrder } from "../types.js";

// Window-size and overscan defaults are tuned for "stays populated
// during flick-scroll" rather than "smallest possible memory
// footprint." A 2000-row window covers roughly 20× a typical viewport
// at 32px row height, so a single Mosaic query lands enough data
// that even a fast fling rarely exits it. The 1000-row overscan
// triggers the next slide well before the rendered edge reaches the
// unloaded area, so by the time the user catches up the new window
// has typically landed and skeleton rows stay rare.
//
// Memory cost is small — 2000 row objects of ~50 typed columns =
// O(2MB) in JS. Query cost is dominated by Mosaic round-trip
// overhead, not the row count, so 2000 isn't measurably slower than
// 1000. Beyond ~3000 the per-query latency starts to bite (you wait
// longer for each window swap), so this is roughly the sweet spot.
// Throttle at 100ms is the leading-edge fire delay; it's the
// "first slide" that matters most during a fling, and that one
// happens immediately.
export const DEFAULT_WINDOW_SIZE = 2000;
export const DEFAULT_OVERSCAN = 1000;
const SLIDE_THROTTLE_MS = 100;

export type WindowRow = "loading" | Record<string, any>;

export interface WindowLoaderOptions {
  coordinator: Coordinator;
  filter: Selection;
  table: string;
  idColumn: string;
  /** Optional custom SQL with $table / $predicate templating. If set, no __id__ column. */
  query?: string;
  /** Allowlist of columns. Hidden ones are filtered separately via columnStyles. */
  columns?: string[];
  columnStyles: Record<string, ColumnStyle>;
  sort?: SortOrder;
  /** Sliding window size. Defaults to DEFAULT_WINDOW_SIZE. */
  windowSize?: number;
  /** Overscan rows kept loaded outside the visible range. Defaults to DEFAULT_OVERSCAN. */
  overscan?: number;
  /**
   * Called when totalCount changes (e.g. filter changes).
   * Use it to reset virtualizer scroll position.
   */
  onTotalCountChange?: (newCount: number, oldCount: number) => void;
  /**
   * Called when prepare finishes — gives the caller the discovered columns
   * and a sample-row-derived defaultColumnWidths map. Mirrors the existing
   * Instances.prepare contract.
   */
  onPrepared?: (info: { columns: string[]; defaultColumnWidths: Record<string, number> }) => void;
}

function widthForContent(content: any): number {
  const len = String(content ?? "").length;
  return Math.min(600, Math.max(80, len * 8 + 40));
}

export class WindowLoader {
  // Reactive surface — readers track these.
  totalCount = $state<number>(0);
  columns = $state<string[]>([]);
  /**
   * Index of the first row in the in-memory window. Intentionally NOT
   * a `$state` rune: the *only* reader is `rowAt`, which is called
   * during virtualizer-driven render, and that already re-runs when
   * `windowRows` changes (the value that lands AFTER a slide). Making
   * this reactive caused an effect-update loop because `ensureRange`
   * reads + writes it from inside the same Svelte effect.
   */
  windowOffset = 0;
  /**
   * Offset that `windowRows` actually corresponds to. Updated when a
   * query result lands; lags `windowOffset` while a slide is in
   * flight. `rowAt` reads this so that during a slide the user sees
   * the closest available data (correctly indexed) instead of
   * skeletons. Without this split, flick-scrolling would blank out
   * the table because every "stale" result was being dropped.
   */
  windowDataOffset = $state<number>(0);
  /** Rows in the current window, indexed by (absoluteIndex - windowDataOffset). */
  windowRows = $state<Record<string, any>[]>([]);
  /** True while a slide query is in flight (used for skeleton-row decisions). */
  loading = $state<boolean>(false);

  readonly windowSize: number;
  readonly overscan: number;

  private readonly opts: WindowLoaderOptions;
  private readonly isOriginalTable: boolean;
  private readonly orderByExprs: ReturnType<typeof SQL.asc>[];
  private columnNames: string[] = [];
  private dataClient: ReturnType<typeof makeClient> | null = null;
  private countClient: ReturnType<typeof makeClient> | null = null;
  private slideTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSlideOffset: number | null = null;
  private pendingResultOffsets: number[] = [];
  private lastAppliedPredicate: SQL.FilterExpr | undefined = undefined;
  private destroyed = false;

  // Cached row offsets for ids the host has pre-warmed via
  // `precomputeOffsets(ids)`. Lets the search dropdown's
  // click-to-reveal feel synchronous — no ROW_NUMBER roundtrip per
  // click. Invalidated by `clearOffsetCache()` when the filter
  // changes (brush, header filter, search funnel toggle, etc.).
  private offsetCache: Map<RowID, number> = new Map();
  // Bumped on every cache invalidation. In-flight precompute
  // queries capture the generation at kickoff and discard their
  // results if the generation has moved on — protects against an
  // older precompute landing AFTER a newer one and overwriting
  // fresh values with stale ones.
  private offsetCacheGen: number = 0;

  constructor(options: WindowLoaderOptions) {
    this.opts = options;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.overscan = options.overscan ?? DEFAULT_OVERSCAN;
    this.isOriginalTable = options.query == undefined;
    this.orderByExprs = (options.sort ?? []).map((s: SortOrder[number]) => {
      const col = SQL.column(s.column);
      return s.direction === "descending" ? SQL.desc(col) : SQL.asc(col);
    });
    this.connect();
  }

  private baseQuery(predicate?: SQL.FilterExpr | null): SQL.SelectQuery {
    return instancesQuery({ query: this.opts.query, table: this.opts.table, predicate: predicate });
  }

  private buildWindowQuery(predicate: SQL.FilterExpr | undefined, offset: number) {
    const selectMap: Record<string, any> = {};
    if (this.isOriginalTable) {
      selectMap.__id__ = SQL.column(this.opts.idColumn);
    }
    for (const col of this.columnNames) {
      selectMap[col] = SQL.column(col);
    }
    return SQL.Query.from(this.baseQuery(predicate))
      .select(selectMap)
      .orderby(this.orderByExprs)
      .limit(this.windowSize)
      .offset(offset);
  }

  private connect() {
    const self = this;
    this.countClient = makeClient({
      coordinator: this.opts.coordinator,
      selection: this.opts.filter,
      query: (predicate) => SQL.Query.from(self.baseQuery(predicate)).select({ count: SQL.count() }),
      queryResult: (result: any) => {
        const newCount = result.get(0).count as number;
        const oldCount = self.totalCount;
        self.totalCount = newCount;
        if (newCount !== oldCount) {
          self.opts.onTotalCountChange?.(newCount, oldCount);
        }
      },
    });

    this.dataClient = makeClient({
      coordinator: this.opts.coordinator,
      selection: this.opts.filter,
      prepare: async () => {
        const desc = await self.opts.coordinator.query(SQL.Query.describe(self.baseQuery()));
        let names: string[] = (desc.toArray() as any[]).map((x) => x.column_name);
        if (self.opts.columns) {
          const allowed = new Set(self.opts.columns);
          names = names.filter((x) => allowed.has(x));
        }
        names = names.filter((col) => self.opts.columnStyles[col]?.display !== "hidden");
        self.columnNames = names;
        self.columns = names;

        // Sample 10 rows for default column widths — same heuristic as the
        // pre-rebuild Instances.prepare. Cheap; only fires once per
        // clientsParams change.
        const sampleSelect: Record<string, any> = {};
        if (self.isOriginalTable) sampleSelect.__id__ = SQL.column(self.opts.idColumn);
        for (const col of names) sampleSelect[col] = SQL.column(col);
        const widthQuery = SQL.Query.from(self.baseQuery()).select(sampleSelect).limit(10).offset(0);
        const widthResult = await self.opts.coordinator.query(widthQuery);
        const sample = (widthResult as any).toArray();
        const defaults: Record<string, number> = {};
        for (const col of names) {
          let m = widthForContent(col);
          for (const row of sample) m = Math.max(m, widthForContent((row as any)[col]));
          defaults[col] = m;
        }
        self.opts.onPrepared?.({ columns: names, defaultColumnWidths: defaults });
      },
      query: (predicate) => {
        // Capture the offset this query was built for. queryResult
        // pairs each result with its query via FIFO ordering and
        // commits — even results that no longer match the latest
        // slide intent are committed against their original offset,
        // so rowAt has *something* to render during a fling. The
        // last result to land wins by virtue of FIFO order.
        const offsetForThisQuery = self.windowOffset;
        self.pendingResultOffsets.push(offsetForThisQuery);
        self.lastAppliedPredicate = predicate ?? undefined;
        self.loading = true;
        return self.buildWindowQuery(predicate ?? undefined, offsetForThisQuery);
      },
      queryResult: (result: any) => {
        const queryOffset = self.pendingResultOffsets.shift();
        if (self.pendingResultOffsets.length === 0) self.loading = false;
        if (queryOffset == null) return;
        // Always commit. windowDataOffset records which absolute
        // offset this data corresponds to; rowAt indexes off that.
        // If a fresher query is still in flight, its result will
        // land next and overwrite. In the meantime, the user sees
        // correctly-indexed rows from a slightly older window
        // instead of skeletons.
        self.windowDataOffset = queryOffset;
        self.windowRows = (result as any).toArray();
      },
      queryError: (err: any) => {
        self.pendingResultOffsets.shift();
        if (self.pendingResultOffsets.length === 0) self.loading = false;
        // eslint-disable-next-line no-console
        console.error("WindowLoader query failed", err);
      },
    });
  }

  /**
   * Tell the loader the visible range. If it lies near or past the window
   * edges, re-anchor the window and fire a slide query (throttled).
   */
  ensureRange(start: number, end: number): void {
    if (this.destroyed) return;
    if (this.totalCount === 0) return;
    const winStart = this.windowOffset;
    const winEnd = winStart + this.windowSize;
    const needSlide = start < winStart + this.overscan || end > winEnd - this.overscan;
    if (!needSlide) return;
    const center = Math.floor((start + end) / 2);
    let newOffset = center - Math.floor(this.windowSize / 2);
    newOffset = Math.max(0, Math.min(this.totalCount - this.windowSize, newOffset));
    if (newOffset === winStart) return;
    this.scheduleSlide(newOffset);
  }

  private scheduleSlide(targetOffset: number): void {
    this.pendingSlideOffset = targetOffset;
    if (this.slideTimer != null) return;
    // Leading-edge: fire immediately, then debounce subsequent intents
    // until the timer expires. This gives a snappy first slide on flick
    // and drops the intermediate intents.
    this.flushSlide();
    this.slideTimer = setTimeout(() => {
      this.slideTimer = null;
      // Trailing edge: if the intent moved during the throttle, fire again
      // to land on the final position.
      if (this.pendingSlideOffset != null && this.pendingSlideOffset !== this.windowOffset) {
        this.flushSlide();
      }
    }, SLIDE_THROTTLE_MS);
  }

  private flushSlide(): void {
    if (this.pendingSlideOffset == null) return;
    const target = this.pendingSlideOffset;
    this.pendingSlideOffset = null;
    if (target === this.windowOffset) return;
    this.windowOffset = target;
    this.dataClient?.requestQuery();
  }

  /**
   * Read a row by absolute index. Returns the row object if it sits in the
   * current in-memory window, "loading" if outside (skeleton row), or
   * undefined if the index is out of range.
   */
  rowAt(absoluteIndex: number): WindowRow | undefined {
    if (absoluteIndex < 0 || absoluteIndex >= this.totalCount) return undefined;
    // Index off windowDataOffset (where the data actually came from),
    // not windowOffset (where the slide intent points). During a
    // fling, the two diverge: this lets us render the previously
    // loaded window in-place while the new query is still flying.
    const local = absoluteIndex - this.windowDataOffset;
    if (local < 0 || local >= this.windowRows.length) return "loading";
    return this.windowRows[local];
  }

  /**
   * Resolve a row id to its absolute offset under the current sort + filter,
   * via ROW_NUMBER. Returns undefined if the id is no longer in the
   * filtered set or in custom-query mode. Cache hits are synchronous.
   */
  async offsetForId(id: RowID): Promise<number | undefined> {
    if (!this.isOriginalTable) return undefined;
    const cached = this.offsetCache.get(id);
    if (cached != null) return cached;
    const idOffset = SQL.Query.from(this.baseQuery(this.livePredicate())).select({
      id: SQL.column(this.opts.idColumn),
      offset: this.orderByExprs.length > 0 ? SQL.row_number().orderby(...this.orderByExprs) : SQL.row_number(),
    });
    const q = SQL.Query.from(idOffset)
      .select({ offset: SQL.column("offset") })
      .where(SQL.eq(SQL.column("id"), SQL.literal(id)));
    const res = await this.opts.coordinator.query(q);
    return (res as any).get(0)?.offset;
  }

  /**
   * Pre-warm the offset cache for a batch of ids. Used by the search
   * dropdown so clicking a result is synchronous — no ROW_NUMBER
   * roundtrip at click time. Fire-and-forget; concurrent calls are
   * safe (results populate the same cache).
   *
   * Already-cached ids are skipped. Generation counter discards
   * in-flight results if the cache is invalidated mid-query
   * (e.g. user brushes another chart while precompute is running).
   */
  async precomputeOffsets(ids: RowID[]): Promise<void> {
    if (!this.isOriginalTable || ids.length === 0) return;
    const need = ids.filter((id) => !this.offsetCache.has(id));
    if (need.length === 0) return;
    const gen = this.offsetCacheGen;
    const idOffset = SQL.Query.from(this.baseQuery(this.livePredicate())).select({
      id: SQL.column(this.opts.idColumn),
      offset: this.orderByExprs.length > 0 ? SQL.row_number().orderby(...this.orderByExprs) : SQL.row_number(),
    });
    const q = SQL.Query.from(idOffset)
      .select({ id: SQL.column("id"), offset: SQL.column("offset") })
      .where(SQL.isIn(SQL.column("id"), need.map((id) => SQL.literal(id) as any)));
    let res: any;
    try {
      res = await this.opts.coordinator.query(q);
    } catch {
      return;
    }
    if (this.destroyed || gen !== this.offsetCacheGen) return;
    const arr = (res as any).toArray?.() ?? [];
    for (const row of arr) {
      if (row?.id != null && typeof row.offset === "number") {
        this.offsetCache.set(row.id, row.offset);
      }
    }
  }

  /** Clear the offset cache and invalidate any in-flight precompute. */
  clearOffsetCache(): void {
    this.offsetCache.clear();
    this.offsetCacheGen++;
  }

  /**
   * Predicate as-of-now from the live filter. Used by offsetForId
   * and precomputeOffsets — `lastAppliedPredicate` lags by one async
   * cycle when the search-filter clause publishes, so callers racing
   * the publication would otherwise capture the wrong predicate.
   */
  private livePredicate(): SQL.FilterExpr | undefined {
    const p = this.opts.filter.predicate(null);
    return (p ?? undefined) as SQL.FilterExpr | undefined;
  }

  /**
   * Reset to offset 0 (e.g. after sort or filter change). Caller should
   * also tell the virtualizer to scroll-to-top.
   */
  resetToTop(): void {
    if (this.windowOffset !== 0) {
      this.windowOffset = 0;
      this.dataClient?.requestQuery();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.slideTimer != null) {
      clearTimeout(this.slideTimer);
      this.slideTimer = null;
    }
    this.dataClient?.destroy();
    this.countClient?.destroy();
    this.dataClient = null;
    this.countClient = null;
  }
}
