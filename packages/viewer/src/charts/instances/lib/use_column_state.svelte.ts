// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Persistence for combined column state — visibility, order, pinning —
// under a single localStorage key per dataset table. Companion to
// `use_column_widths.svelte.ts` which keeps widths separately for
// backward compat with v1.
//
// Same cleanup-on-read pattern: when we load, we drop entries for
// columns that no longer exist in the current schema and write the
// pruned shape back. Stale entries can't accumulate across schema
// changes; unchanged columns keep their state.

const STORAGE_PREFIX = "embedding-atlas:cols:";

export interface StoredColumnState {
  /** Map of column name → visibility (true = visible). Missing keys default to visible. */
  visibility: Record<string, boolean>;
  /** Ordered column names; columns not in this list fall through to schema order. */
  order: string[];
  /** Pinned columns (left side only for v1). */
  pinning: { left: string[] };
}

const EMPTY_STATE: StoredColumnState = {
  visibility: {},
  order: [],
  pinning: { left: [] },
};

/**
 * Read stored column state for a table, intersect with the current
 * schema (drops references to columns that no longer exist), and
 * write the pruned shape back. Returns the surviving entries.
 *
 * Safe to call before mount and in environments where localStorage is
 * disabled or throws.
 */
export function loadStoredColumnState(tableName: string, columns: string[]): StoredColumnState {
  if (typeof localStorage === "undefined") return { ...EMPTY_STATE };
  if (!tableName) return { ...EMPTY_STATE };
  const key = STORAGE_PREFIX + tableName;
  let raw: unknown;
  try {
    const text = localStorage.getItem(key);
    if (!text) return { ...EMPTY_STATE };
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY_STATE };
  }
  if (typeof raw !== "object" || raw == null) return { ...EMPTY_STATE };
  const stored = raw as Partial<StoredColumnState>;
  const colSet = new Set(columns);

  const visibility: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(stored.visibility ?? {})) {
    if (colSet.has(k) && typeof v === "boolean") visibility[k] = v;
  }

  const order: string[] = Array.isArray(stored.order)
    ? stored.order.filter((c): c is string => typeof c === "string" && colSet.has(c))
    : [];

  const left: string[] = Array.isArray(stored.pinning?.left)
    ? stored.pinning!.left.filter((c): c is string => typeof c === "string" && colSet.has(c))
    : [];

  const pruned: StoredColumnState = { visibility, order, pinning: { left } };

  // Cleanup-on-read: write back only when something changed (cheap
  // string-equality check via JSON).
  try {
    const before = JSON.stringify(stored);
    const after = JSON.stringify(pruned);
    if (before !== after) localStorage.setItem(key, after);
  } catch {
    /* ignore quota / disabled */
  }
  return pruned;
}

/** Persist the full column state shape. Failures are swallowed. */
export function saveStoredColumnState(tableName: string, state: StoredColumnState): void {
  if (typeof localStorage === "undefined") return;
  if (!tableName) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + tableName, JSON.stringify(state));
  } catch {
    /* ignore quota / disabled */
  }
}
