<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { untrack } from "svelte";
  import { get } from "svelte/store";

  import { screenshot } from "../utils/screenshot.js";
  import type { ChartViewProps } from "./chart.js";
  import { findChartComponent } from "./chart_types.js";

  let props: Omit<ChartViewProps, "width" | "height"> & {
    width?: number | "container";
    height?: number | "container";
  } = $props();
  let ComponentClass = $derived(findChartComponent(props.spec));

  let clientWidth = $state(100);
  let clientHeight = $state(100);
  let container: HTMLDivElement;

  function logError(node: HTMLElement, props: { spec: any; error: any }) {
    console.trace("Error happened in chart with spec", props.spec, props.error);
  }

  // Register the screenshot delegate once on mount. The screenshot
  // callback closes over `container` and reads `colorScheme` lazily at
  // invocation time, so re-registering on every prop change is wasted
  // work — and `props.registerDelegate` itself receives a fresh inline
  // arrow each frame from `LayoutView.svelte`'s chartView snippet, so
  // tracking it would cause this effect to re-fire on every animation
  // frame during layout transitions (chart show/hide etc.). `untrack`
  // breaks that cascade.
  $effect(() => {
    return untrack(() =>
      props.registerDelegate?.({
        screenshot: async (options) => {
          let colorScheme = get(props.context.colorScheme);
          return await screenshot(container, {
            ...options,
            backgroundColor: colorScheme == "dark" ? "#000000" : "#ffffff",
          });
        },
      }),
    );
  });
</script>

<div
  style:width={props.width == "container" ? "100%" : props.width != undefined ? `${props.width}px` : "fit-content"}
  style:height={props.height == "container" ? "100%" : props.height != undefined ? `${props.height}px` : "fit-content"}
  bind:clientWidth={clientWidth}
  bind:clientHeight={clientHeight}
  bind:this={container}
>
  <svelte:boundary>
    <ComponentClass
      {...props}
      width={props.width == "container" ? clientWidth : props.width}
      height={props.height == "container" ? clientHeight : props.height}
    />
    {#snippet failed(error, reset)}
      <button onclick={reset} use:logError={{ spec: props.spec, error: error }}>
        An occured with this chart. Click to retry.
      </button>
    {/snippet}
  </svelte:boundary>
</div>
