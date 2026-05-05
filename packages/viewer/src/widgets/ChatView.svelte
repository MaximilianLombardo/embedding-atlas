<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { tick } from "svelte";

  import Spinner from "./Spinner.svelte";

  import type { RowID } from "../charts/chart.js";
  import {
    streamChat,
    type ChatContentBlock,
    type ChatContext,
    type ChatEvent,
    type ChatMessage,
    type ChatToolCall,
    type ChatTurn,
  } from "../utils/chat_client.js";

  interface Props {
    endpoint: string | null;
    context: ChatContext;
    initialPrompt?: string | null;
    /** History; bind from parent so it survives modal/tab close. */
    turns?: ChatTurn[];
    /**
     * Optional click handler for citation pills. When set, citation
     * pills are wired up; click writes the row ID to the chart's
     * highlight Writable upstream so the embedding pans + table scrolls
     * to that row. Pills are rendered regardless, but click is a no-op
     * when this is unset.
     */
    onPillClick?: (rowId: RowID) => void;
  }

  let {
    endpoint,
    context,
    initialPrompt = null,
    turns = $bindable([]),
    onPillClick,
  }: Props = $props();

  let pending = $state(false);
  // svelte-ignore state_referenced_locally
  let draft = $state(initialPrompt ?? "");
  let scroller: HTMLDivElement | undefined;

  function renderMarkdown(text: string): string {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }

  /** Image blocks pulled from a tool_result content list. */
  function imageBlocks(blocks: ChatContentBlock[] | undefined) {
    if (!blocks) return [] as Array<{ media_type: string; data: string }>;
    const out: Array<{ media_type: string; data: string }> = [];
    for (const b of blocks) {
      if (b.type === "image" && (b as any).source?.type === "base64") {
        const src = (b as any).source as { media_type: string; data: string };
        out.push({ media_type: src.media_type, data: src.data });
      }
    }
    return out;
  }

  /** Concatenated text blocks from a tool_result content list. */
  function textFromBlocks(blocks: ChatContentBlock[] | undefined): string {
    if (!blocks) return "";
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text || "")
      .join("\n")
      .trim();
  }

  /**
   * Open a base64-encoded image in a new tab via a blob URL.
   *
   * Direct navigation to `data:` URLs in a new tab is blocked by Chrome,
   * Safari, and Firefox as a phishing mitigation. `blob:` URLs are not
   * blocked, so we materialize the bytes into a Blob and open that.
   * The blob URL is auto-revoked after 60s — long enough for the user to
   * view, short enough to avoid leaking memory across many uses.
   */
  function openImageInNewTab(mediaType: string, base64Data: string) {
    try {
      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mediaType });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      console.error("Failed to open image", e);
    }
  }

  async function scrollToBottom() {
    await tick();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  async function send() {
    if (!endpoint) return;
    const prompt = draft.trim();
    if (!prompt || pending) return;
    draft = "";

    // Build the message list from the *previous* turns (this user prompt is
    // included separately so we don't depend on the not-yet-persisted state).
    const messages: ChatMessage[] = [
      ...turns.filter((t) => t.role === "user" || t.text.length > 0).map((t) => ({ role: t.role, content: t.text })),
      { role: "user", content: prompt },
    ];

    turns = [...turns, { role: "user", text: prompt, tools: [] }, { role: "assistant", text: "", tools: [] }];
    const assistantIdx = turns.length - 1;
    pending = true;
    await scrollToBottom();

    try {
      for await (const event of streamChat(endpoint, { messages, context })) {
        // Mutate the *proxied* turn fetched by index — Svelte 5's $state
        // wraps array entries in deep proxies, so the original object
        // reference we constructed above is detached from reactivity.
        applyEvent(assistantIdx, event);
        await scrollToBottom();
      }
    } catch (err) {
      turns[assistantIdx].text += `\n\n_Error: ${err instanceof Error ? err.message : String(err)}_`;
    } finally {
      pending = false;
    }
  }

  function applyEvent(turnIndex: number, event: ChatEvent) {
    const turn = turns[turnIndex];
    if (!turn) return;
    switch (event.type) {
      case "delta":
        turn.text += event.text;
        break;
      case "tool_use":
        turn.tools.push({ id: event.id, name: event.name, input: event.input });
        break;
      case "tool_result": {
        const match = turn.tools.find((t) => t.id === event.id);
        if (match) {
          match.result = event.content;
          // Structured blocks only arrive when the tool returned non-text
          // content (typically a screenshot). Older sessions / text-only
          // results leave this undefined and fall back to `result`.
          if (event.content_blocks) {
            match.resultBlocks = event.content_blocks;
          }
          if (event.cited_rows) {
            match.citedRows = event.cited_rows;
          }
          match.isError = event.is_error;
        }
        break;
      }
      case "error":
        turn.text += `\n\n_Error: ${event.message}_`;
        break;
      case "context":
      case "done":
        break;
    }
  }

  /**
   * Aggregate citations across every tool call in this assistant turn,
   * de-duplicated, preserving first-seen order. Used to render a single
   * "Sources:" pill row at the end of the turn rather than one per tool.
   */
  function collectCitedRows(tools: ChatToolCall[]): RowID[] {
    const out: RowID[] = [];
    const seen = new Set<string>();
    for (const tool of tools) {
      if (!tool.citedRows) continue;
      for (const id of tool.citedRows) {
        // RowID is `any` in the codebase; stringify for dedup so we
        // handle numeric and string IDs uniformly without surprises.
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
      }
    }
    return out;
  }

  function pillLabel(id: RowID): string {
    const s = String(id);
    return s.length > 10 ? s.slice(0, 10) + "…" : s;
  }

  function onTextareaKeydown(e: KeyboardEvent) {
    // cmdk's Command.Root listens at the document level and intercepts Enter
    // to "select" a command item. Stop propagation so the textarea owns Enter
    // when the user is composing a chat message.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  let textareaEl: HTMLTextAreaElement | undefined = $state();

  // Pull focus from cmdk's autofocused filter input down to the chat textarea
  // once the endpoint is known.
  $effect(() => {
    if (endpoint && textareaEl) {
      textareaEl.focus();
    }
  });
</script>

<div class="flex flex-col h-full min-h-0">
  <div bind:this={scroller} class="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4 text-sm">
    {#if turns.length === 0}
      <div class="text-slate-500 dark:text-slate-400">
        Ask Claude about the rows you have selected — or about the whole dataset if nothing is selected. The agent has
        access to <code>run_sql_query</code> and the rest of the viewer's tool surface, plus a small sample of the rows in
        scope up front.
      </div>
    {/if}
    {#each turns as turn, i (i)}
      <div class="space-y-2">
        {#if turn.role === "user"}
          <div class="flex justify-end">
            <div class="rounded-lg px-3 py-2 max-w-[80%] bg-blue-600 text-white whitespace-pre-wrap">
              {turn.text}
            </div>
          </div>
        {:else}
          <div class="flex flex-col gap-2">
            {#each turn.tools as tool (tool.id)}
              <details
                class="rounded-md border text-xs"
                class:border-slate-300={!tool.isError}
                class:dark:border-slate-700={!tool.isError}
                class:border-red-400={tool.isError}
              >
                <summary class="px-2 py-1 cursor-pointer select-none text-slate-600 dark:text-slate-300">
                  {tool.isError ? "⚠" : "⚙"} <span class="font-mono">{tool.name}</span>
                  {#if tool.result === undefined}
                    <span class="text-slate-400">…</span>
                  {/if}
                </summary>
                <div class="px-2 py-1 border-t border-slate-200 dark:border-slate-700 space-y-1">
                  <pre
                    class="whitespace-pre-wrap break-words font-mono text-slate-500 dark:text-slate-400">{JSON.stringify(
                      tool.input,
                      null,
                      2,
                    )}</pre>
                  {#if tool.result !== undefined}
                    {#if tool.resultBlocks}
                      {@const text = textFromBlocks(tool.resultBlocks)}
                      {@const images = imageBlocks(tool.resultBlocks)}
                      {#if text}
                        <pre
                          class="whitespace-pre-wrap break-words font-mono text-slate-700 dark:text-slate-300">{text}</pre>
                      {/if}
                      {#each images as img, idx (idx)}
                        <!-- Click handler converts the base64 data URL to a blob URL
                             before opening — modern browsers (Chrome, Safari, Firefox)
                             block direct navigation to data: URLs in new tabs as a
                             phishing mitigation. blob: URLs are allowed. -->
                        <button
                          type="button"
                          class="block p-0 border-0 bg-transparent cursor-zoom-in"
                          title="Open image in new tab"
                          onclick={() => openImageInNewTab(img.media_type, img.data)}
                        >
                          <img
                            src={`data:${img.media_type};base64,${img.data}`}
                            alt={`Tool result from ${tool.name}`}
                            class="chat-tool-image rounded border border-slate-200 dark:border-slate-700"
                          />
                        </button>
                      {/each}
                      {#if !text && images.length === 0}
                        <pre
                          class="whitespace-pre-wrap break-words font-mono text-slate-500 dark:text-slate-400">[no displayable content]</pre>
                      {/if}
                    {:else}
                      <pre
                        class="whitespace-pre-wrap break-words font-mono text-slate-700 dark:text-slate-300">{tool.result}</pre>
                    {/if}
                  {/if}
                </div>
              </details>
            {/each}
            {#if turn.text}
              <div class="prose prose-sm dark:prose-invert max-w-none">
                {@html renderMarkdown(turn.text)}
              </div>
            {/if}
            {#if collectCitedRows(turn.tools).length > 0}
              <div class="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span class="select-none">Sources:</span>
                {#each collectCitedRows(turn.tools) as rowId, idx (idx)}
                  <button
                    type="button"
                    class="chat-source-pill font-mono"
                    title={String(rowId)}
                    onclick={() => onPillClick?.(rowId)}
                    disabled={!onPillClick}
                  >
                    {pillLabel(rowId)}
                  </button>
                {/each}
              </div>
            {/if}
            {#if pending && i === turns.length - 1 && turn.text === "" && turn.tools.length === 0}
              <Spinner status="Thinking…" />
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="border-t border-slate-200 dark:border-slate-700 p-2">
    {#if !endpoint}
      <div class="text-xs text-slate-500 dark:text-slate-400 px-2 py-1">
        Chat backend not configured. Pass <code>chatEndpoint</code> to <code>EmbeddingAtlas</code>
        or run the dev server with <code>--chat</code>.
      </div>
    {:else}
      <textarea
        bind:this={textareaEl}
        bind:value={draft}
        onkeydown={onTextareaKeydown}
        placeholder="Ask Claude about the rows in scope… (Enter to send, Shift+Enter for newline)"
        rows="2"
        disabled={pending}
        class="w-full resize-none bg-transparent outline-none px-2 py-1 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-50"
      ></textarea>
    {/if}
  </div>
</div>

<style>
  /* Cap the inline screenshot at a sane size in the tool-result strip; the
     anchor wrapping the image opens the full-resolution data URL in a new
     tab on click (simpler than a lightbox; matches issue #3 acceptance). */
  .chat-tool-image {
    display: block;
    max-width: 400px;
    max-height: 300px;
    width: auto;
    height: auto;
    margin: 0.25rem 0;
    object-fit: contain;
    cursor: zoom-in;
  }

  /* Citation pills — small clickable badges in the "Sources:" footer.
     Click handler upstream writes to the chart's highlight Writable,
     which animates the embedding view to the point and scrolls the
     Instances table to the row. */
  .chat-source-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.4rem;
    border-radius: 9999px;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: rgb(248 250 252); /* slate-50 */
    color: rgb(51 65 85); /* slate-700 */
    font-size: 0.7rem;
    line-height: 1.1;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .chat-source-pill:hover:not(:disabled) {
    background: rgb(226 232 240); /* slate-200 */
    border-color: rgb(148 163 184); /* slate-400 */
  }
  .chat-source-pill:disabled {
    cursor: default;
    opacity: 0.7;
  }
  :global(.dark) .chat-source-pill {
    border-color: rgb(51 65 85); /* slate-700 */
    background: rgb(30 41 59); /* slate-800 */
    color: rgb(203 213 225); /* slate-300 */
  }
  :global(.dark) .chat-source-pill:hover:not(:disabled) {
    background: rgb(51 65 85); /* slate-700 */
    border-color: rgb(100 116 139); /* slate-500 */
  }
</style>
