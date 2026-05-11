<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Vertical icon strip on the left edge of the atlas. Hosts the
  chrome's atlas-level controls in semantically-distinct sections,
  each backed by the appropriate bits-ui primitive so the click
  semantics are encoded in the component type, not in custom
  bookkeeping:

  - kind="radio":    ToggleGroup type="single" — pick one option
                     (deselect not allowed; clicking active is a no-op).
                     aria-checked / role="radio" via bits-ui.
  - kind="toggles":  one Toggle.Root per button — independent on/off.
                     aria-pressed on each.
  - kind="momentary": plain <button> — no held state; click fires once.
                     The parent decides what visual to render
                     (typically: icon swap, e.g. Sun↔Moon for theme;
                     or a single action like opening the settings modal).

  Each kind gets its own Tailwind treatment so the user can predict
  click behavior from the visual:

  ┌──┐
  │⊞ │  RADIO — solid bg, no left-edge accent
  │⊟ │
  ├──┤
  │👁│  TOGGLES — full-opacity icon (on) vs ring/outlined icon (off);
  │👁│           no bg accent
  │👁│
  ├──┤  ← `mt-auto` on the divider preceding the first pinned section
  │☀ │  MOMENTARY (pinned) — never any active fill or accent; just hover.
  ├──┤
  │⚙ │
  └──┘

  Bottom-pinning: any section can set `pinnedToBottom: true`. The
  divider before the first such section gets `mt-auto`, pushing it
  AND every section after it to the bottom edge. This lets the host
  put multiple controls in the bottom group (e.g. theme + settings)
  without the strip needing to know how many.

  The strip is presentational — it has no atlas-state knowledge of
  its own. The host (EmbeddingAtlas.svelte) supplies the section
  data + handlers via the `sections` prop. Note: the previous
  kind="tabs" section was removed when the inline settings panel
  was replaced by a modal — the strip no longer has any concept of
  panel-tab navigation; the settings gear is a single momentary
  button that opens the modal, and tab navigation lives inside the
  modal itself.
-->
<script lang="ts">
  import type { Component } from "svelte";

  import { Toggle, ToggleGroup } from "bits-ui";

  type SectionKind = "radio" | "toggles" | "momentary";

  interface StripButton {
    /** Required for "radio" sections — identifies this button as a
     * ToggleGroup.Item value. Ignored for "toggles" / "momentary". */
    value?: string;
    icon: Component<{ class?: string }>;
    title: string;
    /** Visual active state. For radio: matches the section's
     * currently-selected value. For toggles: feature is on. For
     * momentary: usually false (no held state). */
    active?: boolean;
    onClick: () => void;
  }

  interface StripSection {
    key: string;
    kind: SectionKind;
    buttons: StripButton[];
    /**
     * If true, this section (and every section after it) is pushed
     * to the bottom of the strip. Achieved by applying `mt-auto` to
     * the divider preceding the FIRST pinned section. Sections with
     * no pinned flag stack from the top as usual.
     */
    pinnedToBottom?: boolean;
  }

  interface Props {
    sections: StripSection[];
  }

  let { sections }: Props = $props();

  // Index of the first bottom-pinned section. Defaults to a sentinel
  // (>= sections.length) when no section is pinned — the `mt-auto`
  // class then never applies and all sections stack from the top.
  let firstPinnedIndex = $derived.by(() => {
    const i = sections.findIndex((s) => s.pinnedToBottom === true);
    return i === -1 ? sections.length : i;
  });
</script>

<div
  role="toolbar"
  aria-orientation="vertical"
  class="w-12 flex-none flex flex-col bg-slate-100 dark:bg-slate-800 border-r border-slate-300 dark:border-slate-600"
>
  {#each sections as section, i (section.key)}
    {#if i > 0}
      <hr
        class="border-0 border-t border-slate-200 dark:border-slate-700 my-1"
        class:mt-auto={i === firstPinnedIndex}
      />
    {/if}

    {#if section.kind === "radio"}
      {@const activeValue = section.buttons.find((b) => b.active)?.value ?? ""}
      <ToggleGroup.Root
        type="single"
        orientation="vertical"
        value={activeValue}
        onValueChange={(v) => {
          // bits-ui in single mode emits the new value on select and
          // an empty string on deselect. Radio semantics don't allow
          // deselect, so an empty string is a no-op here.
          if (v === "") return;
          const b = section.buttons.find((x) => x.value === v);
          b?.onClick();
        }}
        class="flex flex-col"
      >
        {#each section.buttons as button (button.value ?? button.title)}
          {@const Icon = button.icon}
          {@const isActive = button.active === true}
          <ToggleGroup.Item
            value={button.value ?? ""}
            title={button.title}
            aria-label={button.title}
            class="h-12 w-12 flex flex-col items-center justify-center transition focus-visible:outline-2 outline-blue-600 -outline-offset-1 {isActive
              ? 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-100'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
          >
            <Icon class="w-5 h-5" />
          </ToggleGroup.Item>
        {/each}
      </ToggleGroup.Root>
    {:else if section.kind === "toggles"}
      <div class="flex flex-col">
        {#each section.buttons as button, j (j)}
          {@const Icon = button.icon}
          {@const isOn = button.active === true}
          <Toggle.Root
            pressed={isOn}
            onPressedChange={() => button.onClick()}
            title={button.title}
            aria-label={button.title}
            class="h-12 w-12 flex flex-col items-center justify-center transition focus-visible:outline-2 outline-blue-600 -outline-offset-1 {isOn
              ? 'text-slate-700 dark:text-slate-100'
              : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
          >
            <Icon class="w-5 h-5" />
          </Toggle.Root>
        {/each}
      </div>
    {:else}
      <!-- momentary -->
      <div class="flex flex-col">
        {#each section.buttons as button, j (j)}
          {@const Icon = button.icon}
          <button
            type="button"
            onclick={button.onClick}
            title={button.title}
            aria-label={button.title}
            class="h-12 w-12 flex flex-col items-center justify-center transition focus-visible:outline-2 outline-blue-600 -outline-offset-1 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <Icon class="w-5 h-5" />
          </button>
        {/each}
      </div>
    {/if}
  {/each}
</div>
