<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  Modal settings dialog with a vertical tab strip on the left and the
  active section's content on the right. Replaces the previous inline
  left-side SettingsPanel; the strip's single gear button opens this.

  Layout:
    ┌──────────────────────────────────────────────┐
    │ Settings                                  ✕  │  ← header
    ├──────────┬───────────────────────────────────┤
    │ ⚙ Global │                                   │
    │ 🔍 Search│        [active section]           │  ← body
    │ 🎨 Embed │                                   │
    │          │                                   │
    ├──────────┴───────────────────────────────────┤
    │ ● MCP connected                  v0.20.0     │  ← footer
    └──────────────────────────────────────────────┘

  Built on bits-ui's Dialog (focus trap, scroll lock, ESC/click-outside,
  `role="dialog"`, `aria-modal`) and Tabs (`role="tablist"`,
  `role="tab"`, `aria-selected`, arrow-key nav between tabs). We
  control both: open state lives in the host (EmbeddingAtlas.svelte)
  as a boolean, active tab as a string persisted to localStorage.

  Sizing: `clamp(720px, 60vw, 960px) × clamp(540px, 70vh, 700px)` —
  grows with the viewport up to a cap, doesn't shrink below a usable
  minimum. Content scrolls inside the body region when a section is
  taller than the available space.
-->
<script lang="ts">
  import type { Component, Snippet } from "svelte";

  import { Dialog, Tabs } from "bits-ui";

  import { IconClose } from "../assets/icons.js";

  interface PanelSection {
    key: string;
    title: string;
    icon?: Component<{ class?: string }>;
    content: Snippet;
  }

  interface Props {
    /** Open state. Bidirectional so a backdrop click / ESC closes via Dialog's onOpenChange. */
    open: boolean;
    onOpenChange: (value: boolean) => void;
    /** Sections to render as tabs. Order is preserved. */
    sections: PanelSection[];
    /** Active tab key. Caller persists this; we just read + write through onActiveKeyChange. */
    activeKey: string;
    onActiveKeyChange: (key: string) => void;
    /** MCP connection status for the footer. */
    mcpStatus?: string;
    /** Atlas version for the footer. */
    version: string;
    /**
     * Portal target. Defaults to document.body, but the host usually
     * passes the `embedding-atlas-root` element so the modal lives
     * inside the atlas's `.dark` class scope (Tailwind dark-mode
     * variants are ancestor-based; portaling to `body` skips them).
     * Also inherits font / color-scheme / any other root-scoped CSS.
     */
    portalTo?: HTMLElement;
  }

  let {
    open,
    onOpenChange,
    sections,
    activeKey,
    onActiveKeyChange,
    mcpStatus,
    version,
    portalTo,
  }: Props = $props();

  // If the persisted activeKey no longer maps to a section (e.g. a
  // chart that registered last session isn't mounted yet this
  // session), fall back to the first available section so the body
  // never renders blank. The fallback is read-only here; the host
  // can decide whether to write it back to localStorage.
  let resolvedKey = $derived(sections.some((s) => s.key === activeKey) ? activeKey : (sections[0]?.key ?? activeKey));
  let active = $derived(sections.find((s) => s.key === resolvedKey));
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Portal to={portalTo ?? "body"}>
    <!-- Backdrop. Click → dismiss via Dialog's built-in
         interact-outside handling. backdrop-blur softens the
         underlying app, reinforcing the "focus" mode the user asked
         for. z-40 keeps the modal layer above the strip + main but
         below any host overlays that may need to be on top. -->
    <Dialog.Overlay
      class="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity"
    />
    <!-- Modal content. Fixed-positioned center; size grows with
         viewport but caps. min-w/min-h prevent the sidebar from
         collapsing on narrow windows. overflow-hidden clips the
         rounded corners; the body scrolls internally. -->
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2
             flex flex-col overflow-hidden rounded-lg shadow-2xl
             bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100
             border border-slate-300 dark:border-slate-700"
      style="width: clamp(720px, 60vw, 960px); height: clamp(540px, 70vh, 700px);"
    >
      <!-- Header -->
      <div
        class="flex-none h-12 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-700"
      >
        <Dialog.Title class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Settings
        </Dialog.Title>
        <Dialog.Close
          class="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100
                 dark:text-slate-500 dark:hover:text-slate-200 dark:hover:bg-slate-800
                 focus-visible:outline-2 outline-blue-600 -outline-offset-1 transition"
          aria-label="Close settings"
        >
          <IconClose class="w-4 h-4" />
        </Dialog.Close>
      </div>

      <!-- Body: vertical Tabs.Root. Sidebar + content area share the
           middle row. min-h-0 lets the inner scroll containers
           actually shrink — without it, an oversized content forces
           the parent flex item to grow past the modal height. -->
      <Tabs.Root
        value={resolvedKey}
        onValueChange={onActiveKeyChange}
        orientation="vertical"
        class="flex flex-1 flex-row min-h-0"
      >
        <!-- Sidebar — tab list. Fixed width, vertical, scrolls
             internally if charts contribute many sections. -->
        <Tabs.List
          class="w-44 flex-none flex flex-col gap-0.5 p-2 overflow-y-auto
                 border-r border-slate-200 dark:border-slate-700
                 bg-slate-50 dark:bg-slate-800/50"
          aria-label="Settings sections"
        >
          {#each sections as section (section.key)}
            {@const Icon = section.icon}
            {@const isActive = resolvedKey === section.key}
            <Tabs.Trigger
              value={section.key}
              class="flex items-center gap-2 px-3 py-2 rounded text-sm text-left transition
                     focus-visible:outline-2 outline-blue-600 -outline-offset-1
                     {isActive
                       ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-medium'
                       : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-700'}"
            >
              {#if Icon}
                <Icon class="w-4 h-4 flex-none" />
              {/if}
              <span class="truncate">{section.title}</span>
            </Tabs.Trigger>
          {/each}
        </Tabs.List>

        <!-- Content area. p-6 gives breathing room; overflow-y-auto
             so long sections scroll inside the modal, not pushing the
             modal off-screen. We render the resolved section's
             snippet directly rather than using Tabs.Content per
             section, because our sections come from a derived list
             and the snippets are closures over reactive values —
             swapping the rendered snippet on key change is the
             cleanest mapping. -->
        <div class="flex-1 min-w-0 overflow-y-auto p-6">
          {#if active}
            {@render active.content()}
          {/if}
        </div>
      </Tabs.Root>

      <!-- Footer: MCP status (left) + atlas version (right). Always
           visible regardless of the active tab; communicates "the
           atlas is connected" without the user having to navigate
           anywhere. Matches the inline-panel's previous footer. -->
      <div
        class="flex-none h-8 px-4 flex items-center justify-between
               border-t border-slate-200 dark:border-slate-700
               bg-slate-50 dark:bg-slate-800/50 text-xs"
      >
        <div class="flex items-center gap-1.5">
          {#if mcpStatus === "connecting"}
            <div class="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></div>
            <span class="text-slate-500 dark:text-slate-400">MCP connecting…</span>
          {:else if mcpStatus === "connected"}
            <div class="w-1.5 h-1.5 rounded-full bg-green-500"></div>
            <span class="text-slate-500 dark:text-slate-400">MCP connected</span>
          {:else if mcpStatus === "closed" || mcpStatus === "error"}
            <div class="w-1.5 h-1.5 rounded-full bg-red-500"></div>
            <span class="text-slate-500 dark:text-slate-400">MCP error</span>
          {:else}
            <div class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600"></div>
            <span class="text-slate-400 dark:text-slate-500">MCP off</span>
          {/if}
        </div>
        <span class="text-slate-400 dark:text-slate-500">v{version}</span>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
