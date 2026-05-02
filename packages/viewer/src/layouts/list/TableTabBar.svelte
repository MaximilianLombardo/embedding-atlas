<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import type { TableTab } from "./types.js";

  interface Props {
    value: TableTab;
    onChange: (tab: TableTab) => void;
  }

  let { value, onChange }: Props = $props();

  const options: { value: TableTab; label: string }[] = [
    { value: "table", label: "Table" },
    { value: "chat", label: "Chat" },
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
