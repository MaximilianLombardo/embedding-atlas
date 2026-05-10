<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { type Snippet } from "svelte";

  import ToggleButton from "./ToggleButton.svelte";

  import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";

  interface Props {
    title?: string;
    label?: string | null;
    icon?: any | null;
    /**
     * Which edge of the trigger button the popover aligns with.
     * "left" → bottom-start (popover's left edge under button's left).
     * "right" → bottom-end (popover's right edge under button's right).
     */
    anchor?: "left" | "right";
    button?: Snippet<[{ visible: boolean; toggle: () => void }]>;
    children?: Snippet;
  }

  let { title = "", label = null, icon = null, anchor = "right", children, button }: Props = $props();

  let visible: boolean = $state(false);

  function toggle() {
    visible = !visible;
  }
  let container: HTMLDivElement;

  function onKeyDown(e: KeyboardEvent) {
    if (visible && e.key == "Escape") {
      visible = false;
      e.stopPropagation();
    }
  }

  let popoverElement: HTMLElement;

  $effect(() => {
    if (visible) {
      $effect(() => {
        popoverElement.showPopover();

        function updatePosition() {
          computePosition(container, popoverElement, {
            placement: anchor === "left" ? "bottom-start" : "bottom-end",
            middleware: [
              offset(3),
              // Flip to top when there isn't enough room below.
              flip(),
              // Push back into the viewport horizontally if shoved off-edge.
              shift({ padding: 8 }),
              // Clamp max-height/width to whatever room is left after
              // flip+shift, so very tall lists scroll inside the popover
              // and very wide content wraps instead of overflowing the
              // page. 8px padding on each side keeps a breathing edge.
              size({
                padding: 8,
                apply({ availableHeight, availableWidth, elements }) {
                  Object.assign(elements.floating.style, {
                    maxHeight: `${Math.max(120, availableHeight - 8)}px`,
                    maxWidth: `${Math.max(160, availableWidth - 8)}px`,
                  });
                },
              }),
            ],
          }).then(({ x, y }) => {
            popoverElement.style.left = x + "px";
            popoverElement.style.top = y + "px";
          });
        }
        return autoUpdate(container, popoverElement, updatePosition);
      });
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative" bind:this={container} onkeydown={onKeyDown}>
  {#if button}
    {@render button({ visible, toggle })}
  {:else}
    <ToggleButton icon={icon} title={title} label={label} bind:checked={visible} />
  {/if}
  <div
    bind:this={popoverElement}
    class="absolute px-3 py-3 rounded-md z-20 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 shadow-lg overflow-auto"
    style:width="max-content"
    popover
    ontoggle={(e) => {
      if (e.newState == "closed") {
        visible = false;
      }
    }}
  >
    {@render children?.()}
  </div>
</div>

<svelte:window />
