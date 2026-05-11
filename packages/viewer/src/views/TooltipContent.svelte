<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import ContentRenderer from "../renderers/ContentRenderer.svelte";

  import { stringify } from "../renderers/renderer_utils.js";
  import { type ColumnStyle } from "../renderers/types.js";

  interface Props {
    values: Record<string, any>;
    columns?: string[];
    columnStyles: Record<string, ColumnStyle>;
    /** "preview" curates a short view (header + a few badges + truncated body
     *  + a "more fields" hint). "full" shows everything in its natural form. */
    mode?: "preview" | "full";
  }

  let { columns, values, columnStyles, mode = "full" }: Props = $props();

  // Resolve each key to one of header/full/badge/hidden. If the user marks
  // a field explicitly via ColumnStyle.display, that wins. Otherwise:
  //   - keys starting with "__" are hidden (internal plumbing)
  //   - everything else defaults to "full"
  function keyStyle(
    key: string,
    columnStyles: Record<string, ColumnStyle>,
  ): "header" | "full" | "badge" | "hidden" {
    let display = columnStyles[key]?.display;
    if (display != null) return display;
    if (key.startsWith("__")) return "hidden";
    return "full";
  }

  // Humanize a column name as a fallback label. "task_description" →
  // "Task description"; "primaryCorpus" → "Primary corpus". Anything
  // user-supplied via ColumnStyle.label takes precedence.
  function humanize(key: string): string {
    const spaced = key
      .replace(/_+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
    const lower = spaced.toLowerCase().trim();
    return lower.length === 0 ? key : lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function labelOf(key: string): string {
    return columnStyles[key]?.label ?? humanize(key);
  }

  let allKeys = $derived(columns ?? Object.keys(values));

  // Header selection: explicit `display: "header"` wins. Else: prefer a
  // column literally named "title", "name", or "label" (in that order) —
  // these are common for paper/document datasets where the most
  // meaningful surface is the title, even though it may not be the first
  // column alphabetically. Last resort: first non-hidden "full" key.
  let headerKey = $derived.by(() => {
    const explicit = allKeys.find((k) => keyStyle(k, columnStyles) === "header");
    if (explicit) return explicit;
    for (const preferred of ["title", "name", "label"]) {
      const match = allKeys.find((k) => k.toLowerCase() === preferred && keyStyle(k, columnStyles) !== "hidden");
      if (match) return match;
    }
    return allKeys.find((k) => keyStyle(k, columnStyles) === "full") ?? null;
  });

  let badgeKeys = $derived(allKeys.filter((k) => keyStyle(k, columnStyles) === "badge"));
  let bodyKeys = $derived(
    allKeys.filter((k) => keyStyle(k, columnStyles) === "full" && k !== headerKey),
  );

  // Preview mode constraints.
  const PREVIEW_BADGE_CAP = 4;
  const PREVIEW_BODY_CAP = 1;
  const PREVIEW_TEXT_CAP = 240;
  const CHIP_CAP_PREVIEW = 5;
  const CHIP_CAP_FULL = 50;

  let visibleBadges = $derived(mode === "preview" ? badgeKeys.slice(0, PREVIEW_BADGE_CAP) : badgeKeys);
  let visibleBody = $derived(mode === "preview" ? bodyKeys.slice(0, PREVIEW_BODY_CAP) : bodyKeys);
  let hiddenCount = $derived(
    mode === "preview"
      ? Math.max(0, badgeKeys.length - visibleBadges.length) + Math.max(0, bodyKeys.length - visibleBody.length)
      : 0,
  );

  function isArrayValue(v: any): boolean {
    return Array.isArray(v) && v.length > 0;
  }

  function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + "…";
  }
</script>

<div class="flex flex-col gap-2">
  {#if headerKey != null}
    <div class="text-base font-medium leading-snug text-slate-900 dark:text-slate-100 break-words">
      {#if mode === "preview" && typeof values[headerKey] === "string"}
        {truncate(values[headerKey], PREVIEW_TEXT_CAP)}
      {:else}
        <ContentRenderer value={values[headerKey]} style={columnStyles[headerKey]} />
      {/if}
    </div>
  {/if}

  {#if visibleBadges.length > 0}
    <div class="flex-none flex flex-row gap-1 flex-wrap items-start">
      {#each visibleBadges as key}
        {@const value = values[key]}
        <div
          class="px-2 flex items-center gap-2 border border-slate-200 dark:border-slate-700 bg-slate-100/25 dark:bg-slate-700/25 text-slate-700 dark:text-slate-300 rounded-md min-w-0"
        >
          <div class="text-slate-400 dark:text-slate-400 font-medium text-xs flex-shrink-0">{labelOf(key)}</div>
          <div class="text-ellipsis whitespace-nowrap overflow-hidden max-w-72 min-w-0 text-sm" title={stringify(value)}>
            <ContentRenderer value={value} />
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#each visibleBody as key}
    {@const value = values[key]}
    <div class="flex flex-col gap-0.5">
      <div class="text-slate-400 dark:text-slate-400 font-medium text-[11px] uppercase tracking-wide">
        {labelOf(key)}
      </div>
      <div class="text-sm break-words">
        {#if isArrayValue(value)}
          {@const cap = mode === "preview" ? CHIP_CAP_PREVIEW : CHIP_CAP_FULL}
          {@const overflow = Math.max(0, value.length - cap)}
          <div class="flex flex-row gap-1 flex-wrap items-start">
            {#each value.slice(0, cap) as item}
              <div
                class="px-1.5 py-0.5 text-xs border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 rounded"
                title={stringify(item)}
              >
                {stringify(item)}
              </div>
            {/each}
            {#if overflow > 0}
              <div class="px-1.5 py-0.5 text-xs text-slate-400 dark:text-slate-500" title="{overflow} more">
                +{overflow} more
              </div>
            {/if}
          </div>
        {:else if mode === "preview" && typeof value === "string"}
          <div class="text-slate-700 dark:text-slate-300">{truncate(value, PREVIEW_TEXT_CAP)}</div>
        {:else}
          <ContentRenderer value={value} style={columnStyles[key]} />
        {/if}
      </div>
    </div>
  {/each}

  {#if hiddenCount > 0}
    <div class="text-[11px] text-slate-400 dark:text-slate-500 italic">
      +{hiddenCount} more {hiddenCount === 1 ? "field" : "fields"} — open detail for the full record
    </div>
  {/if}
</div>
