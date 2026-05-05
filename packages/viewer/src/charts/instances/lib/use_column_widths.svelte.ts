// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Per-table column-width persistence to localStorage (design doc D4).
//
// On read: parse the stored map, intersect with the *current* column
// set, drop missing-column entries, and write the pruned map back.
// "Cleanup-on-read" keeps the store from accumulating stale entries
// across schema changes — but unchanged columns keep their widths.
//
// Rejected alternatives (recorded so future-you knows the why):
//   - Hashing the column set into the key. Forces ALL widths to reset
//     on any schema change, even if only one column was added.
//   - Name-only with no cleanup. Stale entries accumulate forever
//     across many tables.

const STORAGE_PREFIX = "embedding-atlas:widths:";

/**
 * Read stored widths for a table, intersect with the current schema,
 * and write the pruned map back. Returns the surviving entries.
 *
 * Safe to call before mount — guards against environments where
 * localStorage is missing or throws (e.g. Safari private mode quota).
 */
export function loadStoredWidths(tableName: string, columns: string[]): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  const key = STORAGE_PREFIX + tableName;
  let stored: unknown;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    stored = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof stored !== "object" || stored == null) return {};
  const colSet = new Set(columns);
  const pruned: Record<string, number> = {};
  for (const [col, val] of Object.entries(stored as Record<string, unknown>)) {
    if (colSet.has(col) && typeof val === "number" && Number.isFinite(val)) {
      pruned[col] = val;
    }
  }
  // Cleanup-on-read: only write back if we dropped something.
  if (Object.keys(pruned).length !== Object.keys(stored as object).length) {
    try {
      localStorage.setItem(key, JSON.stringify(pruned));
    } catch {
      /* localStorage full / disabled — ignore */
    }
  }
  return pruned;
}

/** Persist the current width map for a table. Failures are swallowed. */
export function saveStoredWidths(tableName: string, widths: Record<string, number>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_PREFIX + tableName, JSON.stringify(widths));
  } catch {
    /* localStorage full / disabled — ignore */
  }
}
