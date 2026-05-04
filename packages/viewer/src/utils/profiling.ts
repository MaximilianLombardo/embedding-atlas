// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Lightweight in-app profiling kit. Enable with `?profile=1` in the URL.
// Zero overhead when disabled — call sites short-circuit on the flag.

import type { Coordinator } from "@uwdata/mosaic-core";

const SLOW_QUERY_THRESHOLD_MS = 50;

let enabled: boolean | null = null;

export function isProfilingEnabled(): boolean {
  if (enabled !== null) return enabled;
  if (typeof window === "undefined") {
    enabled = false;
  } else {
    const params = new URLSearchParams(window.location.search);
    enabled = params.get("profile") === "1";
  }
  return enabled;
}

interface ProfilerStats {
  slowQueryCount: number;
  lastSlowQueryMs: number;
}

const stats: ProfilerStats = {
  slowQueryCount: 0,
  lastSlowQueryMs: 0,
};

const subscribers = new Set<(s: ProfilerStats) => void>();

function notify() {
  for (const cb of subscribers) cb(stats);
}

export function subscribeToProfilerStats(cb: (s: ProfilerStats) => void): () => void {
  subscribers.add(cb);
  cb(stats);
  return () => {
    subscribers.delete(cb);
  };
}

export function installSlowQueryLogger(coordinator: Coordinator, thresholdMs: number = SLOW_QUERY_THRESHOLD_MS) {
  if (!isProfilingEnabled()) return;
  const original = coordinator.query.bind(coordinator);
  (coordinator as any).query = async function (query: unknown, ...rest: unknown[]) {
    const start = performance.now();
    let sqlPreview: string;
    try {
      sqlPreview = String(query);
    } catch {
      sqlPreview = "<unstringifiable>";
    }
    try {
      const result = await (original as any)(query, ...rest);
      const elapsed = performance.now() - start;
      if (elapsed > thresholdMs) {
        stats.slowQueryCount += 1;
        stats.lastSlowQueryMs = elapsed;
        notify();
        console.warn(`[profile] slow query ${elapsed.toFixed(0)}ms`, sqlPreview.slice(0, 240));
      }
      return result;
    } catch (e) {
      const elapsed = performance.now() - start;
      console.error(`[profile] failed query ${elapsed.toFixed(0)}ms`, sqlPreview.slice(0, 240), e);
      throw e;
    }
  };
}
