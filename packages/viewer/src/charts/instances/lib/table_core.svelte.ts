// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Svelte 5 runes wrapper around @tanstack/table-core.
//
// table-core is a framework-agnostic state machine: you build a Table once
// with `createTable(options)`, hold the state externally, and push state
// updates back via `setState`/`setOptions`. The React adapter does this by
// rebuilding `options` on every render and calling `table.setOptions(prev)`;
// we do the same shape with $effect.
//
// Why we built this rather than using @tanstack/svelte-table:
// - The published adapter targets Svelte 3/4. v9 (Svelte-5-aware) is alpha.
// - The adapter is ~150 lines of subscribe-store glue that's trivial to
//   replace with $state + $effect, and replacing it sidesteps any churn
//   when v9 stabilizes on a different API shape than we'd have committed
//   to. Having ownership of this wrapper also keeps the table↔runes seam
//   visible inside the project.
//
// The wrapper is intentionally tiny — it exposes the unchanged Table<T>
// instance back to callers. Anything table-core can do, callers can do
// directly on the returned table; we only own the state plumbing.

import {
  createTable,
  getCoreRowModel,
  type RowData,
  type Table,
  type TableOptions,
  type TableOptionsResolved,
  type TableState,
  type Updater,
} from "@tanstack/table-core";

/**
 * Caller-supplied options. We inject `state`, `onStateChange`,
 * `getCoreRowModel`, and `renderFallbackValue` ourselves.
 */
export type SvelteTableOptions<T extends RowData> = Omit<
  TableOptions<T>,
  "state" | "onStateChange" | "getCoreRowModel" | "renderFallbackValue"
> & {
  /**
   * Optional partial state to merge with table-core's internal state.
   * Use this to *control* a slice (e.g. provide `sorting` from outside).
   * Unspecified slices remain managed by the table.
   */
  state?: Partial<TableState>;
};

/**
 * Build a TanStack table-core `Table` whose mutable state lives in a Svelte 5
 * `$state` rune. Returned table is reactive: any rune-tracked read inside
 * `getOptionsFn()` becomes a dependency that re-runs `setOptions` on the
 * shared instance.
 *
 * Rules for callers:
 * - Call once during component setup. The returned table is stable for the
 *   life of the component; never re-call to "reset" — use `table.reset()`.
 * - `getOptionsFn` is invoked inside an `$effect`, so reads of `$state` /
 *   `$derived` inside it are auto-tracked and trigger option updates.
 * - To control a state slice externally, return it under `state`. The
 *   internal rune merges your slice with table-managed state on each push.
 * - User-driven state changes (sort click, drag-resize) call our injected
 *   `onStateChange`, which writes to the rune. The next `$effect` tick
 *   pushes that state back to the table; callers that need to react
 *   externally should read `table.getState()` from inside their own runes.
 */
export function createSvelteTable<T extends RowData>(getOptionsFn: () => SvelteTableOptions<T>): Table<T> {
  // Internal rune: full TableState owned by the table-core instance.
  // We seed it from the caller's `initialState` + `state` slice, then let
  // table-core fill in the rest on first `setOptions` push.
  const seed = getOptionsFn();
  let internalState = $state<TableState>({
    ...((seed.initialState ?? {}) as TableState),
    ...((seed.state ?? {}) as TableState),
  });

  // Build the resolved options TanStack expects. `state` is the merge of
  // the rune (table-managed slices) over the caller-supplied slice
  // (controlled slices). The caller's slice wins because that's the whole
  // point of supplying it.
  function buildResolved(latest: SvelteTableOptions<T>): TableOptionsResolved<T> {
    const callerState = latest.state ?? {};
    return {
      ...latest,
      state: { ...internalState, ...callerState } as TableState,
      onStateChange: (updater: Updater<TableState>) => {
        // table-core hands us either a new state or a function. Resolve
        // against the rune snapshot so we don't accidentally mutate a
        // proxy.
        const snap = $state.snapshot(internalState) as TableState;
        const next = typeof updater === "function" ? (updater as (prev: TableState) => TableState)(snap) : updater;
        internalState = next;
      },
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
    } as TableOptionsResolved<T>;
  }

  const table = createTable<T>(buildResolved(seed));

  // Reactivity: whenever any rune-tracked read inside getOptionsFn changes,
  // re-resolve options and push them via setOptions. table-core caches
  // assume stable instance identity, so we never call createTable again.
  $effect(() => {
    const latest = getOptionsFn();
    table.setOptions(() => buildResolved(latest));
  });

  return table;
}
