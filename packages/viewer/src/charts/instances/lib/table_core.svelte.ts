// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Svelte 5 runes wrapper around @tanstack/table-core.
//
// table-core is a *fully controlled* state machine: `table.getState()`
// returns whatever `options.state` is at the moment of the call. There
// is no hidden internal store. The framework adapter is therefore
// responsible for holding the state, seeding it from
// `table.initialState` on first mount, and pushing updates back through
// `setOptions` whenever `onStateChange` fires.
//
// Why we built this rather than using @tanstack/svelte-table:
// - The published adapter targets Svelte 3/4. v9 (Svelte-5-aware) is
//   alpha and may yet shift its API shape.
// - The adapter is ~150 lines of subscribe-store glue that's trivial to
//   replace with `$state` + `$effect`. Owning the wrapper also keeps the
//   table↔runes seam visible inside the project.
//
// Pattern (mirrors the React adapter `useReactTable`):
//   1. Build the table once with resolved options. State is held in a
//      `$state` rune; `onStateChange` writes to the rune.
//   2. Seed the rune from `table.initialState` so every feature's
//      default slice (columnPinning, columnVisibility, etc.) is
//      present — table-core reads these directly off `state` and
//      crashes if any are missing.
//   3. Inside an `$effect`, call `table.setOptions(...)` with a fresh
//      resolved object on every state or option change. This is what
//      makes `table.options.state` stay in sync with the rune;
//      reassignment of the rune doesn't propagate by reference, so the
//      effect's re-run is what republishes it.
//
// Imperative slice setters (`table.setSorting(...)`, etc.) work because
// they internally call `onStateChange`, which writes the rune.

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
 *
 * Pass `initialState` to seed slices on first mount.
 */
export type SvelteTableOptions<T extends RowData> = Omit<
  TableOptions<T>,
  "state" | "onStateChange" | "getCoreRowModel" | "renderFallbackValue"
>;

/**
 * Build a TanStack table-core `Table` whose state lives in a Svelte 5
 * `$state` rune. The returned `table` is reactive: reads of
 * `getRowModel`, `getHeaderGroups`, `getState`, etc. inside `$derived` /
 * `$effect` re-fire when state changes — the `$effect` below pushes the
 * latest state into `table.options.state` on every change, and Svelte
 * tracks the rune read inside `buildResolved`.
 *
 * Rules for callers:
 * - Call once during component setup. The returned `table` is stable
 *   for the life of the component; never re-call to "reset" — use
 *   `table.reset()`.
 * - `getOptionsFn` is invoked inside an `$effect`, so reads of `$state`
 *   / `$derived` inside it are auto-tracked and trigger option updates.
 */
export function createSvelteTable<T extends RowData>(getOptionsFn: () => SvelteTableOptions<T>): Table<T> {
  // The full TableState. Seeded below from table.initialState — until
  // then it's empty, so the very first state we hand to createTable is
  // whatever table.initialState ends up being (table-core merges its
  // own initialState in regardless of what we pass).
  let stateRune = $state<TableState>({} as TableState);

  function buildResolved(latest: SvelteTableOptions<T>): TableOptionsResolved<T> {
    // $state.snapshot strips the rune proxy. table-core stashes
    // `options.state` and reads slices off it; passing the proxy
    // directly works at runtime but obscures the data shape and would
    // mean `table.options.state` is "live" through the proxy on
    // *separate* reads — feeding plain snapshots avoids that
    // ambiguity.
    return {
      ...latest,
      state: $state.snapshot(stateRune) as TableState,
      onStateChange: (updater: Updater<TableState>) => {
        const snap = $state.snapshot(stateRune) as TableState;
        const next = typeof updater === "function" ? (updater as (prev: TableState) => TableState)(snap) : updater;
        stateRune = next;
      },
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
    } as TableOptionsResolved<T>;
  }

  const table = createTable<T>(buildResolved(getOptionsFn()));

  // Seed the rune from `table.initialState` (which table-core
  // assembled by composing every feature's getInitialState) and
  // synchronously republish into options.state. Without the
  // synchronous setOptions, the very first template render reads
  // `options.state` while the rune-driven $effect below has yet to
  // fire — so getHeaderGroups would read state.columnPinning.left
  // off the empty `{}` we initially handed to createTable, and crash.
  stateRune = { ...table.initialState };
  table.setOptions((prev) => ({ ...prev, state: $state.snapshot(stateRune) as TableState }));

  // Reactivity: on every state change OR option change, push fresh
  // options into the table. table-core caches assume stable instance
  // identity, so we never call createTable again — only setOptions.
  $effect(() => {
    const latest = getOptionsFn();
    table.setOptions((prev) => ({ ...prev, ...buildResolved(latest) }));
  });

  return table;
}
