<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<!--
  DetailContent is the drawer's renderer. Unlike TooltipContent (curated
  preview for the embedding tooltip), this surface is persistent and
  affords structure: fields are grouped into sections by inferred role,
  type-aware rendering happens per group, and a `Show advanced` toggle
  reveals fields that were filtered out by default (embedding vector,
  projection coords, internal IDs, etc).

  Inference logic is heuristic and deliberately conservative — when a
  field doesn't clearly fit a role, it goes into the bucket that's most
  likely to be useful (metadata for short strings, content for long).
  Hosts can override per-column via ColumnStyle.group.
-->
<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import ContentRenderer from "../renderers/ContentRenderer.svelte";

  import { IconCheck, IconClose } from "../assets/icons.js";
  import { stringify } from "../renderers/renderer_utils.js";
  import { type ColumnStyle } from "../renderers/types.js";

  interface Props {
    values: Record<string, any>;
    columns?: string[];
    columnStyles: Record<string, ColumnStyle>;
  }

  let { columns, values, columnStyles }: Props = $props();

  let allKeys = $derived(columns ?? Object.keys(values));

  function labelOf(key: string): string {
    const explicit = columnStyles[key]?.label;
    if (explicit) return explicit;
    const spaced = key
      .replace(/_+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
    const lower = spaced.toLowerCase().trim();
    return lower.length === 0 ? key : lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function isHiddenByDefault(key: string): boolean {
    if (columnStyles[key]?.display === "hidden") return true;
    if (key.startsWith("__")) return true;
    if (key === "embedding") return true;
    if (/^(umap_|cluster|x_|y_)/i.test(key)) return true;
    if (key === "cluster_id" || key === "umap_x" || key === "umap_y") return true;
    // Drop *_str when a corresponding array column exists (e.g.
    // mesh_terms_str shadows mesh_terms). Keep the array; the chips
    // render better than the joined string.
    if (key.endsWith("_str")) {
      const base = key.slice(0, -4);
      if (allKeys.includes(base)) return true;
    }
    return false;
  }

  const ID_NAME_PATTERN = /^(id|doi|pmid|pmcid|isbn|issn|url|uri|link)$|_id$|_url$/i;
  const DOI_VALUE_PATTERN = /^10\.\d{4,9}\/[^\s]+$/;
  const URL_VALUE_PATTERN = /^https?:\/\/\S+$/i;
  const PUBMED_VALUE_PATTERN = /^\d{4,9}$/;

  function inferGroup(key: string, value: any): "id" | "metadata" | "tags" | "content" | "flags" | null {
    const explicit = columnStyles[key]?.group;
    if (explicit) return explicit;
    if (value == null || value === "") return null;
    if (typeof value === "boolean") return "flags";
    if (Array.isArray(value)) return value.length > 0 ? "tags" : null;
    if (ID_NAME_PATTERN.test(key)) return "id";
    if (typeof value === "string" && (DOI_VALUE_PATTERN.test(value) || URL_VALUE_PATTERN.test(value))) return "id";
    if (typeof value === "number") return "metadata";
    if (typeof value === "string") return value.length >= 120 ? "content" : "metadata";
    return "metadata";
  }

  type Group = "id" | "metadata" | "tags" | "content" | "flags";
  const GROUP_ORDER: Group[] = ["id", "metadata", "tags", "content", "flags"];
  const GROUP_LABEL: Record<Group, string> = {
    id: "Identifiers",
    metadata: "Metadata",
    tags: "Tags",
    content: "Content",
    flags: "Flags",
  };

  // Header selection — same heuristic the tooltip uses (explicit
  // display="header" > "title"/"name"/"label" > first full field).
  // Header is rendered separately and removed from any group.
  let headerKey = $derived.by(() => {
    const explicit = allKeys.find((k) => columnStyles[k]?.display === "header");
    if (explicit) return explicit;
    for (const preferred of ["title", "name", "label"]) {
      const match = allKeys.find((k) => k.toLowerCase() === preferred && !isHiddenByDefault(k));
      if (match) return match;
    }
    return allKeys.find((k) => !isHiddenByDefault(k) && typeof values[k] === "string" && values[k]?.length > 0) ?? null;
  });

  let visibleKeys = $derived(allKeys.filter((k) => !isHiddenByDefault(k) && k !== headerKey));
  let hiddenKeys = $derived(allKeys.filter((k) => isHiddenByDefault(k) && !k.startsWith("__")));

  // Partition visible keys into groups, preserving original column order
  // within each group so the user's data shape governs intra-section
  // ordering. Cross-section ordering is fixed (GROUP_ORDER).
  let grouped = $derived.by(() => {
    const buckets: Record<Group, string[]> = { id: [], metadata: [], tags: [], content: [], flags: [] };
    for (const key of visibleKeys) {
      const group = inferGroup(key, values[key]);
      if (group != null) buckets[group].push(key);
    }
    return buckets;
  });

  let showAdvanced = $state(false);

  // ---- Per-type rendering helpers ----------------------------------

  function linkForIdentifier(key: string, value: any): string | null {
    if (value == null) return null;
    const s = String(value).trim();
    if (s.length === 0) return null;
    if (URL_VALUE_PATTERN.test(s)) return s;
    if (key.toLowerCase() === "doi" || DOI_VALUE_PATTERN.test(s)) {
      // Strip a stray https://doi.org/ prefix if present so we don't
      // double-prefix when wrapping. The shape we want is canonical:
      // https://doi.org/<bare-doi>.
      const bare = s.replace(/^https?:\/\/doi\.org\//i, "");
      return `https://doi.org/${bare}`;
    }
    if (key.toLowerCase() === "pmid" && PUBMED_VALUE_PATTERN.test(s)) {
      return `https://pubmed.ncbi.nlm.nih.gov/${s}/`;
    }
    return null;
  }

  // Long-string clamp: first paragraph is auto-expanded, subsequent
  // content sections collapse with a "Show more" toggle. Stored as a
  // Set of expanded keys so each section persists independently.
  let expandedContent = $state(new SvelteSet<string>());
  const CONTENT_AUTO_EXPAND_FIRST = true;

  function isContentExpanded(key: string, index: number): boolean {
    if (expandedContent.has(key)) return true;
    return CONTENT_AUTO_EXPAND_FIRST && index === 0;
  }
  function toggleContent(key: string) {
    if (expandedContent.has(key)) expandedContent.delete(key);
    else expandedContent.add(key);
  }
</script>

<div class="flex flex-col gap-4">
  {#if headerKey != null}
    <div class="text-lg font-semibold leading-snug text-slate-900 dark:text-slate-100 break-words">
      <ContentRenderer value={values[headerKey]} style={columnStyles[headerKey]} />
    </div>
  {/if}

  {#each GROUP_ORDER as group}
    {@const keys = grouped[group]}
    {#if keys.length > 0}
      <section class="flex flex-col gap-2 pt-3 border-t border-slate-200 dark:border-slate-700 first:border-t-0 first:pt-0">
        <div class="text-[10px] font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500">
          {GROUP_LABEL[group]}
        </div>

        {#if group === "id"}
          <div class="flex flex-row gap-1.5 flex-wrap">
            {#each keys as key}
              {@const value = values[key]}
              {@const href = linkForIdentifier(key, value)}
              {#if href}
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="px-2 py-0.5 text-xs font-mono border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded transition"
                  title={`${labelOf(key)} — ${stringify(value)} (opens in new tab)`}
                >
                  <span class="text-slate-400 dark:text-slate-500 mr-1">{labelOf(key).toLowerCase()}</span>
                  {stringify(value)}
                </a>
              {:else}
                <div
                  class="px-2 py-0.5 text-xs font-mono border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 rounded"
                  title={`${labelOf(key)} — ${stringify(value)}`}
                >
                  <span class="text-slate-400 dark:text-slate-500 mr-1">{labelOf(key).toLowerCase()}</span>
                  {stringify(value)}
                </div>
              {/if}
            {/each}
          </div>
        {:else if group === "metadata"}
          <div class="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-sm">
            {#each keys as key}
              {@const value = values[key]}
              <div class="text-slate-500 dark:text-slate-400">{labelOf(key)}</div>
              <div class="text-slate-800 dark:text-slate-200 tabular-nums break-words">
                <ContentRenderer value={value} style={columnStyles[key]} />
              </div>
            {/each}
          </div>
        {:else if group === "tags"}
          <div class="flex flex-col gap-2">
            {#each keys as key}
              {@const value = values[key] as any[]}
              <div class="flex flex-col gap-1">
                <div class="text-xs text-slate-500 dark:text-slate-400">{labelOf(key)}</div>
                <div class="flex flex-row gap-1 flex-wrap">
                  {#each value as item}
                    <div
                      class="px-1.5 py-0.5 text-xs border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300 rounded"
                      title={stringify(item)}
                    >
                      {stringify(item)}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {:else if group === "content"}
          <div class="flex flex-col gap-3">
            {#each keys as key, index}
              {@const value = values[key] as string}
              {@const expanded = isContentExpanded(key, index)}
              <div class="flex flex-col gap-1">
                <div class="text-xs text-slate-500 dark:text-slate-400">{labelOf(key)}</div>
                <div
                  class="text-sm text-slate-700 dark:text-slate-300 leading-relaxed break-words whitespace-pre-line"
                  class:line-clamp-5={!expanded}
                >
                  {value}
                </div>
                {#if value.length > 240}
                  <button
                    type="button"
                    class="self-start text-xs text-blue-700 dark:text-blue-300 hover:underline"
                    onclick={() => toggleContent(key)}
                  >
                    {expanded ? "Show less" : "Show more"}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {:else if group === "flags"}
          <div class="flex flex-row gap-1.5 flex-wrap">
            {#each keys as key}
              {@const value = Boolean(values[key])}
              <div
                class="flex items-center gap-1 px-2 py-0.5 text-xs border rounded
                       {value
                  ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-400 dark:text-slate-500'}"
              >
                {#if value}
                  <IconCheck class="w-3 h-3" />
                {:else}
                  <IconClose class="w-3 h-3" />
                {/if}
                {labelOf(key)}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/each}

  {#if hiddenKeys.length > 0}
    <div class="pt-3 border-t border-slate-200 dark:border-slate-700">
      <button
        type="button"
        class="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
        onclick={() => (showAdvanced = !showAdvanced)}
      >
        {showAdvanced ? "Hide advanced" : `Show advanced (${hiddenKeys.length} hidden)`}
      </button>

      {#if showAdvanced}
        <div class="mt-2 grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-xs font-mono">
          {#each hiddenKeys as key}
            {@const value = values[key]}
            <div class="text-slate-400 dark:text-slate-500">{key}</div>
            <div class="text-slate-600 dark:text-slate-300 break-all">
              {stringify(value)}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
