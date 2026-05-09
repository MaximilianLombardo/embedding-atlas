<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Left-edge vertical icon strip that hosts atlas-level toolbar buttons
  (layout selector, show/hide toggles, theme toggle, settings drawer
  toggle). Counterpart to the right-side charts panel.

  Layout:
    ┌──┐
    │⊞ │  ← top section(s): stacked from the top
    │⊟ │
    ├──┤
    │◐ │  ← divider rule (slate-200 / slate-700)
    │◯ │
    ├──┤
    │⚙ │  ← LAST section: pinned to the bottom via mt-auto
    └──┘

  Notable behaviors:
  - Presentational shell only. The host (EmbeddingAtlas.svelte) wires
    state by passing `sections` with concrete handlers; the strip has
    no atlas-state knowledge of its own.
  - Each button mirrors the active-tab visual from SettingsDrawer.svelte:
    blue left-border accent, white / slate-900 fill when active, slate
    icon color otherwise. Width is fixed at 48px (`w-12`), buttons are
    48×48px with no labels — icons only.
  - The LAST section is pinned to the bottom via `mt-auto` on its
    wrapper, so settings/theme controls hug the floor regardless of
    how many sections sit above.
  - Surface / border tokens match the rest of the atlas's chrome
    (`slate-100 / slate-800`, `slate-300 / slate-600`) — see
    `Button.svelte` and `SettingsDrawer.svelte` for canonical
    references.
-->
<script lang="ts">
  import type { Component } from "svelte";

  interface StripButton {
    /** Svelte icon component, e.g. IconListLayout. Same shape as ChartDelegate.settingsIcon — a `Component<{ class?: string }>`. */
    icon: Component<{ class?: string }>;
    /** Hover tooltip; also used as a11y label. */
    title: string;
    /** Highlighted state (filled bg + blue left-border accent). */
    active?: boolean;
    /** Click handler. */
    onClick: () => void;
  }

  interface StripSection {
    /** Stable key for {#each}. */
    key: string;
    buttons: StripButton[];
  }

  interface Props {
    sections: StripSection[];
  }

  let { sections }: Props = $props();

  let lastIndex = $derived(sections.length - 1);
</script>

<div
  class="w-12 flex-none flex flex-col bg-slate-100 dark:bg-slate-800 border-r border-slate-300 dark:border-slate-600"
>
  {#each sections as section, i (section.key)}
    {#if i > 0}
      <hr
        class="border-0 border-t border-slate-200 dark:border-slate-700 my-1"
        class:mt-auto={i === lastIndex}
      />
    {/if}
    <div class="flex flex-col">
      {#each section.buttons as button, j (j)}
        {@const Icon = button.icon}
        {@const isActive = button.active === true}
        <button
          type="button"
          onclick={button.onClick}
          title={button.title}
          aria-label={button.title}
          class="h-12 w-12 flex flex-col items-center justify-center transition border-l-[3px] focus-visible:outline-2 outline-blue-600 -outline-offset-1"
          class:bg-white={isActive}
          class:dark:bg-slate-900={isActive}
          class:border-blue-500={isActive}
          class:border-transparent={!isActive}
          class:text-blue-600={isActive}
          class:dark:text-blue-400={isActive}
          class:text-slate-500={!isActive}
          class:dark:text-slate-400={!isActive}
          class:hover:text-slate-700={!isActive}
          class:dark:hover:text-slate-200={!isActive}
        >
          <Icon class="w-5 h-5" />
        </button>
      {/each}
    </div>
  {/each}
</div>
