<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Mounts a live, interactive chart inside a chat-bubble tool result. Driven
  by `render_chart_in_chat`: the model emits a `{type: "chart", spec}` content
  block, ChatView matches it and renders one of these per block.

  The chart shares the main app's ChartContext (coordinator, table, columns,
  filter, …), so it's automatically cross-filter aware — when the user
  brushes the embedding (or any other chart wired to `$filter`), the inline
  chart updates accordingly. Per design D1 in the inline-charts spec, this
  is the intended behavior.

  The chart's UI state (brush ranges, dropdowns, etc.) is held *locally* in
  this component and is not propagated anywhere — inline charts are
  ephemeral by design. Spec is fixed by the model and `onSpecChange` is a
  no-op so user clicks on inline-edit affordances (if any) don't mutate the
  conversation history.
-->
<script lang="ts">
  import ChartView from "../charts/ChartView.svelte";

  import type { ChartContext } from "../charts/chart.js";
  import { IconCheck, IconPlus } from "../assets/icons.js";

  interface Props {
    /** The chart specification, validated server-side by `render_chart_in_chat`. */
    spec: any;

    /**
     * The chart context. MUST be the SAME ChartContext instance the rest of
     * the app uses — passing a fresh one would create a chart that doesn't
     * share the cross-filter, the coordinator query cache, etc.
     */
    context: ChartContext;

    /** Frame width. Defaults to 400px; the chart fills the inner area. */
    width?: number;

    /** Frame height. Defaults to 280px. */
    height?: number;

    /**
     * Called when the user clicks "Add to panel". Receives the chart spec
     * (same shape `add_chart` accepts). When undefined, the button is hidden.
     */
    onSaveChart?: (spec: any) => void;
  }

  let { spec, context, width = 400, height = 280, onSaveChart }: Props = $props();

  // Local state for the chart's interactive UI (e.g. histogram brush).
  // Not persisted anywhere — inline charts are ephemeral. Each instance gets
  // its own bag.
  let chartState = $state<any>({});

  // Once the user has saved this chart to the side panel, flip the button
  // into a "Saved" affordance so they can't add it twice from the same bubble.
  let saved = $state(false);

  function handleSave() {
    if (!onSaveChart || saved) return;
    onSaveChart(spec);
    saved = true;
  }
</script>

<div class="inline-chart-frame" style:width="{width}px">
  <div class="inline-chart-body" style:height="{height}px">
    <ChartView
      {spec}
      {context}
      width="container"
      height="container"
      mode="view"
      state={chartState}
      onStateChange={(patch, mode) => {
        // Local-only state. Brush selections etc. live here and never escape
        // the chat bubble — they DO still drive the cross-filter via the
        // shared `context.filter` selection because the chart's layers
        // typically declare `as: "$filter"` on their selections.
        if (mode === "replace") {
          chartState = patch ?? {};
        } else {
          chartState = { ...chartState, ...(patch ?? {}) };
        }
      }}
      onSpecChange={() => {
        // Spec is fixed by the model; ignore in-chart edit affordances.
      }}
    />
  </div>
  {#if onSaveChart}
    <button
      type="button"
      class="inline-chart-save-btn"
      class:saved
      title={saved ? "Saved to panel" : "Add this chart to the side panel"}
      onclick={handleSave}
      disabled={saved}
    >
      {#if saved}
        <IconCheck />
        <span>Saved</span>
      {:else}
        <IconPlus />
        <span>Add to panel</span>
      {/if}
    </button>
  {/if}
</div>

<style>
  .inline-chart-frame {
    position: relative;
    max-width: 100%;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    border-radius: 0.375rem; /* rounded-md */
    background: rgb(255 255 255);
    margin: 0.25rem 0;
    overflow: hidden;
  }
  :global(.dark) .inline-chart-frame {
    border-color: rgb(51 65 85); /* slate-700 */
    background: rgb(2 6 23); /* slate-950 */
  }
  .inline-chart-body {
    width: 100%;
  }
  .inline-chart-save-btn {
    position: absolute;
    top: 0.375rem;
    right: 0.375rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: rgb(248 250 252); /* slate-50 */
    color: rgb(51 65 85); /* slate-700 */
    font-size: 0.7rem;
    line-height: 1.1;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
    opacity: 0.85;
  }
  .inline-chart-save-btn:hover:not(:disabled) {
    opacity: 1;
    background: rgb(226 232 240); /* slate-200 */
    border-color: rgb(148 163 184); /* slate-400 */
  }
  .inline-chart-save-btn.saved {
    cursor: default;
    color: rgb(22 101 52); /* green-800 */
    border-color: rgb(187 247 208); /* green-200 */
    background: rgb(240 253 244); /* green-50 */
  }
  :global(.dark) .inline-chart-save-btn {
    border-color: rgb(51 65 85); /* slate-700 */
    background: rgb(30 41 59); /* slate-800 */
    color: rgb(203 213 225); /* slate-300 */
  }
  :global(.dark) .inline-chart-save-btn:hover:not(:disabled) {
    background: rgb(51 65 85); /* slate-700 */
    border-color: rgb(100 116 139); /* slate-500 */
  }
  :global(.dark) .inline-chart-save-btn.saved {
    color: rgb(187 247 208); /* green-200 */
    border-color: rgb(22 101 52); /* green-800 */
    background: rgba(22, 101, 52, 0.15);
  }
</style>
