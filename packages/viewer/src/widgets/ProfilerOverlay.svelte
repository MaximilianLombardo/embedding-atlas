<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { onMount } from "svelte";

  import { subscribeToProfilerStats } from "../utils/profiling.js";

  const SAMPLE_WINDOW = 120;
  const DISPLAY_HZ = 4;

  let fps = $state(0);
  let p95Ms = $state(0);
  let slowQueries = $state(0);
  let lastSlowMs = $state(0);

  onMount(() => {
    let last = performance.now();
    let lastDisplay = last;
    const samples: number[] = [];
    let raf = 0;

    function tick(now: number) {
      const dt = now - last;
      last = now;
      samples.push(dt);
      if (samples.length > SAMPLE_WINDOW) samples.shift();
      if (now - lastDisplay > 1000 / DISPLAY_HZ) {
        lastDisplay = now;
        const sum = samples.reduce((a, b) => a + b, 0);
        fps = Math.round((1000 * samples.length) / sum);
        const sorted = [...samples].sort((a, b) => a - b);
        p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    const unsub = subscribeToProfilerStats((s) => {
      slowQueries = s.slowQueryCount;
      lastSlowMs = s.lastSlowQueryMs;
    });

    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  });
</script>

<div
  class="fixed top-2 right-2 z-[9999] bg-black/75 text-white text-[11px] px-2 py-1 rounded font-mono pointer-events-none select-none tabular-nums"
>
  <span class:text-red-400={fps < 50}>{fps} fps</span>
  · <span class:text-amber-300={p95Ms > 20}>{p95Ms.toFixed(1)}ms p95</span>
  · <span class:text-amber-300={slowQueries > 0}
    >{slowQueries} slow Q{#if lastSlowMs > 0}
      ({lastSlowMs.toFixed(0)}ms)
    {/if}</span
  >
</div>
