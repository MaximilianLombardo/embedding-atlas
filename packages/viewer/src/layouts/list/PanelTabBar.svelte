<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import type { PanelTab } from "./types.js";

  interface Props {
    value: PanelTab;
    onChange: (tab: PanelTab) => void;
  }

  let { value, onChange }: Props = $props();

  const options: { value: PanelTab; label: string }[] = [
    { value: "chat", label: "Chat" },
    { value: "charts", label: "Charts" },
  ];
</script>

<div
  class="flex rounded-md select-none items-center overflow-hidden border border-slate-300 dark:border-slate-600 dark:text-slate-400 bg-slate-200 dark:bg-slate-800 text-xs"
>
  {#each options as opt (opt.value)}
    {@const isSelected = value === opt.value}
    <button
      class="px-2.5 py-1 h-[22px] rounded-[3.875px] focus-visible:outline-2 outline-blue-600 -outline-offset-1 {isSelected
        ? 'bg-white dark:bg-black shadow-md text-slate-800 dark:text-slate-200'
        : 'text-slate-500 dark:text-slate-500'}"
      onclick={() => onChange(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>
