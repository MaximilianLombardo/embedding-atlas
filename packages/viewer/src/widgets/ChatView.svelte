<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { marked } from "marked";
  import { tick } from "svelte";

  import InlineChartView from "./InlineChartView.svelte";
  import Spinner from "./Spinner.svelte";
  import { sanitizeHTML } from "../utils/sanitize.js";
  import { summarizeToolCall } from "../utils/tool_summary.js";

  import type { ChartContext, RowID } from "../charts/chart.js";
  import {
    refinePrompt,
    streamChat,
    type ChatCitation,
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
    /**
     * The main app's ChartContext. Threaded through so inline charts
     * emitted by `render_chart_in_chat` mount with the same coordinator,
     * table, columns, filter, etc. as the rest of the app — that's what
     * makes inline charts cross-filter aware. When undefined, chart
     * blocks fall back to a textual placeholder.
     */
    chartContext?: ChartContext;
    /**
     * Called when the user clicks "Add to panel" on an inline chart.
     * Receives the chart spec emitted by the model. When undefined, the
     * button is hidden on inline charts.
     */
    onSaveChart?: (spec: any) => void;
  }

  let {
    endpoint,
    context,
    initialPrompt = null,
    turns = $bindable([]),
    onPillClick,
    chartContext,
    onSaveChart,
  }: Props = $props();

  let pending = $state(false);
  // Aborts the in-flight stream when the user clicks Stop (A1). Held in
  // state so the Stop button can appear/disappear with `pending`.
  let controller: AbortController | null = $state(null);
  // True when the last stream was halted by the user (A1). Lets the Retry
  // affordance (A5) appear after a Stop, not only after an error.
  let stopped = $state(false);
  // True when the scroller is pinned to (or near) the bottom. Drives the
  // smart-autoscroll behaviour (A3): we only follow new output while the
  // user is already at the bottom, so reading earlier output isn't yanked.
  let atBottom = $state(true);
  // svelte-ignore state_referenced_locally
  let draft = $state(initialPrompt ?? "");
  let scroller: HTMLDivElement | undefined;

  // ── Optional prompt refinement (Tier-2) ──────────────────────────────────
  // A user-toggleable "refine" wand in the composer. When ON, pressing send
  // first rewrites the rough prompt into a well-specified one using EA context
  // (via the backend refine path), then shows it editable for accept / tweak /
  // revert / send before the accepted version is sent. State persists in
  // localStorage so the preference survives reloads.
  const REFINE_PREF_KEY = "embedding-atlas.chat.refine-enabled";
  // svelte-ignore state_referenced_locally
  let refineEnabled = $state(readRefinePref());
  // True while the refine request is in flight (between send-click and preview).
  let refining = $state(false);
  // When set, the editable refined-prompt preview is shown instead of sending
  // immediately. Holds both the rewritten text (editable) and the original so
  // "revert" can restore it.
  let refinePreview: { original: string; refined: string } | null = $state(null);

  /** Derive the refine endpoint from the chat endpoint (`…/chat` →
   *  `…/chat/refine`). Returns null when chat isn't configured. */
  let refineEndpoint = $derived(endpoint ? endpoint.replace(/\/chat$/, "/chat/refine") : null);

  function readRefinePref(): boolean {
    try {
      return localStorage.getItem(REFINE_PREF_KEY) === "1";
    } catch {
      return false;
    }
  }

  function toggleRefine() {
    refineEnabled = !refineEnabled;
    try {
      localStorage.setItem(REFINE_PREF_KEY, refineEnabled ? "1" : "0");
    } catch {
      // Private mode / storage disabled — toggle still works for the session.
    }
  }

  function renderMarkdown(text: string): string {
    const raw = marked.parse(text, { async: false }) as string;
    // Route through the shared sanitizer so the http/https/mailto URL-scheme
    // allowlist applies here too (neutralizes javascript:/data: links and
    // data-exfil image URLs that a model reply could contain).
    const clean = sanitizeHTML(raw);
    // Inject a copy button into each code block (A6). Done *after* sanitize,
    // but the injected markup is a fixed trusted constant containing no model
    // or user content, so it cannot reintroduce unsanitized HTML. A delegated
    // click handler on the prose container (`onProseClick`) performs the copy.
    return clean.replaceAll(
      "<pre>",
      '<pre><button class="copy-code-btn" type="button" aria-label="Copy code" title="Copy code">Copy</button>',
    );
  }

  /** Write text to the clipboard, swallowing failures (denied permission,
   *  insecure context). A6. */
  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.error("Copy failed", e);
      return false;
    }
  }

  // Index of the assistant turn whose "copy message" button was just
  // clicked, for a brief "Copied" confirmation. Cleared on a timer.
  let copiedIdx: number | null = $state(null);
  async function copyMessage(i: number, text: string) {
    if (await copyText(text)) {
      copiedIdx = i;
      setTimeout(() => {
        if (copiedIdx === i) copiedIdx = null;
      }, 1200);
    }
  }

  /**
   * Delegated handler for the per-code-block copy buttons injected by
   * `renderMarkdown` (A6). Copies the block's <code> text (not the button
   * label) and flashes a transient "Copied".
   */
  async function onProseClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement | null)?.closest?.(".copy-code-btn") as HTMLElement | null;
    if (!btn) return;
    const pre = btn.closest("pre");
    const code = pre?.querySelector("code")?.textContent ?? "";
    if (await copyText(code)) {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    }
  }

  /**
   * Svelte action that delegates clicks on the prose container to
   * `onProseClick` (A6). Attaching the listener via an action rather than an
   * inline `onclick` keeps the real interactive elements (the injected copy
   * buttons) as the accessible targets, so the static container isn't flagged
   * for missing keyboard handlers.
   */
  function copyCodeDelegate(node: HTMLElement) {
    node.addEventListener("click", onProseClick);
    return {
      destroy() {
        node.removeEventListener("click", onProseClick);
      },
    };
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

  /**
   * Chart-spec blocks from a tool_result content list. Each is rendered
   * via <InlineChartView /> so the assistant can answer with a live,
   * interactive chart instead of a screenshot.
   */
  function chartBlocks(blocks: ChatContentBlock[] | undefined): Array<{ spec: any }> {
    if (!blocks) return [];
    const out: Array<{ spec: any }> = [];
    for (const b of blocks) {
      if (b.type === "chart" && (b as any).spec != null) {
        out.push({ spec: (b as any).spec });
      }
    }
    return out;
  }

  /**
   * Collect every chart spec emitted by tools in this assistant turn.
   * Lifted to the turn level so charts render in the chat flow itself
   * (alongside the assistant's prose) rather than nested inside the
   * collapsed `<details>` for each tool call — that nesting hid the
   * chart by default and gave it zero dimensions when collapsed, which
   * prevents the Mosaic runtime from laying out marks.
   */
  function collectChartSpecs(tools: ChatToolCall[]): Array<{ spec: any }> {
    const out: Array<{ spec: any }> = [];
    for (const tool of tools) {
      for (const cb of chartBlocks(tool.resultBlocks)) {
        out.push(cb);
      }
    }
    return out;
  }

  /**
   * Collect every image emitted by tools in this assistant turn — parallel
   * to `collectChartSpecs` (A4). Screenshots from `get_full_screenshot` and
   * friends otherwise render only inside the collapsed `<details>` tool
   * strip, so they're invisible by default. Lifting them to the turn level
   * surfaces them in the conversation flow alongside the assistant's prose.
   * Each entry keeps the originating tool name for the image `alt`.
   */
  function collectImages(tools: ChatToolCall[]): Array<{ media_type: string; data: string; toolName: string }> {
    const out: Array<{ media_type: string; data: string; toolName: string }> = [];
    for (const tool of tools) {
      for (const img of imageBlocks(tool.resultBlocks)) {
        out.push({ ...img, toolName: tool.name });
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

  /**
   * Track whether the viewport is parked at the bottom (A3). A small
   * threshold (40px) treats "almost at the bottom" as at-bottom so a
   * trailing line of padding doesn't flip the state and strand the
   * "Jump to latest" button while the user is effectively following.
   */
  function onScroll() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  }

  /** Anthropic-style message list from a set of turns. Drops empty
   *  assistant turns (a failed/aborted attempt that produced no text). */
  function messagesFrom(history: ChatTurn[]): ChatMessage[] {
    return history
      .filter((t) => t.role === "user" || t.text.length > 0)
      .map((t) => ({ role: t.role, content: t.text }));
  }

  /**
   * Entry point for the send button / Enter key. When the refine toggle is ON
   * and a refine endpoint is available, route the rough prompt through the
   * backend refine path first and surface an editable preview; otherwise send
   * immediately. Graceful: if refine fails or returns no change, fall through
   * to sending the original prompt.
   */
  async function onSend() {
    if (!endpoint || pending || refining) return;
    const prompt = draft.trim();
    if (!prompt) return;
    // A preview is open — Enter/Send accepts the currently-edited refined text.
    if (refinePreview) {
      acceptRefine();
      return;
    }
    if (refineEnabled && refineEndpoint) {
      await beginRefine(prompt);
      return;
    }
    await send();
  }

  /** Call the refine endpoint and open the editable preview. On failure or a
   *  no-op rewrite, fall back to sending the original prompt directly. */
  async function beginRefine(prompt: string) {
    refining = true;
    try {
      const result = await refinePrompt(refineEndpoint!, { prompt, context });
      if (result.refined_applied && result.refined.trim() && result.refined.trim() !== prompt) {
        refinePreview = { original: prompt, refined: result.refined.trim() };
        await tick();
        refineInputEl?.focus();
        return;
      }
    } catch {
      // refinePrompt already swallows network errors, but guard anyway.
    } finally {
      refining = false;
    }
    // No usable rewrite — just send what the user typed.
    await send();
  }

  /** Accept the (possibly user-edited) refined prompt and send it. */
  function acceptRefine() {
    if (!refinePreview) return;
    const text = refinePreview.refined.trim();
    refinePreview = null;
    if (!text) return;
    draft = text;
    void send();
  }

  /** Restore the refined preview text to the original rough prompt. */
  function revertRefine() {
    if (!refinePreview) return;
    refinePreview = { ...refinePreview, refined: refinePreview.original };
    refineInputEl?.focus();
  }

  /** Discard the preview without sending; restore the draft so the user can
   *  edit and retry. */
  function cancelRefine() {
    if (!refinePreview) return;
    draft = refinePreview.original;
    refinePreview = null;
  }

  async function send() {
    if (!endpoint) return;
    const prompt = draft.trim();
    if (!prompt || pending) return;
    draft = "";

    // Build the message list from the *previous* turns (this user prompt is
    // included separately so we don't depend on the not-yet-persisted state).
    const messages: ChatMessage[] = [...messagesFrom(turns), { role: "user", content: prompt }];

    turns = [...turns, { role: "user", text: prompt, tools: [] }, { role: "assistant", text: "", tools: [] }];
    const assistantIdx = turns.length - 1;
    // Pin the stream's write target to THIS tab's array. `turns` re-resolves
    // through `bind:turns={chatTurns[activeTab.id]}`, which follows the active
    // tab — so without capturing it here, switching tabs mid-stream would route
    // the remaining deltas into whatever tab is active. The captured proxy stays
    // bound to the originating tab and still persists/renders reactively.
    const target = turns;
    // The user's own message always pulls the viewport to the bottom.
    atBottom = true;
    await scrollToBottom();
    await runStream(messages, assistantIdx, target);
  }

  /**
   * Stream one assistant response into `turns[assistantIdx]`. Factored out
   * of `send()` so Retry (A5) can re-run it against an existing turn. Owns
   * the AbortController (A1): a clean Stop keeps whatever streamed so far
   * without decorating it as an error.
   */
  async function runStream(messages: ChatMessage[], assistantIdx: number, target: ChatTurn[]) {
    if (!endpoint) return;
    const ctrl = new AbortController();
    controller = ctrl;
    pending = true;
    stopped = false;
    // Clear any prior error state — matters when retrying an errored turn.
    const start = target[assistantIdx];
    if (start) {
      start.isError = false;
      start.errorMessage = undefined;
    }

    try {
      for await (const event of streamChat(endpoint, { messages, context }, ctrl.signal)) {
        // Mutate the captured `target` (this tab's array), NOT the live `turns`
        // prop — `turns` follows the active tab, so a mid-stream tab switch would
        // otherwise write the rest of this reply into the wrong tab.
        applyEvent(target, assistantIdx, event);
        // Follow the stream only while the user is parked at the bottom (A3).
        if (atBottom) await scrollToBottom();
      }
    } catch (err) {
      // A clean Stop (A1) surfaces as an AbortError: keep the partial
      // response, no error strip.
      if (err instanceof DOMException && err.name === "AbortError") {
        // intentional no-op
      } else {
        const turn = target[assistantIdx];
        if (turn) {
          turn.isError = true;
          turn.errorMessage = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      pending = false;
      controller = null;
    }
  }

  /** Abort the in-flight stream (A1). */
  function stop() {
    stopped = true;
    controller?.abort();
  }

  /**
   * Retry the last assistant turn (A5). Resets the turn in place (drops its
   * partial text / tools / error / usage) and re-streams from the prior
   * history. Offered when the last turn errored or was stopped.
   */
  async function retry() {
    if (pending) return;
    const assistantIdx = turns.length - 1;
    const turn = turns[assistantIdx];
    if (!turn || turn.role !== "assistant") return;
    // History up to (not including) this assistant turn — ends at the user
    // prompt that produced it.
    const messages = messagesFrom(turns.slice(0, assistantIdx));
    turn.text = "";
    turn.tools = [];
    turn.isError = false;
    turn.errorMessage = undefined;
    turn.usage = undefined;
    // Pin the write target to this tab's array (see `send`).
    const target = turns;
    atBottom = true;
    await scrollToBottom();
    await runStream(messages, assistantIdx, target);
  }

  /** Whether to offer Retry on the last (assistant) turn. */
  let canRetry = $derived.by(() => {
    if (pending) return false;
    const last = turns[turns.length - 1];
    return last?.role === "assistant" && (last.isError === true || stopped);
  });

  function applyEvent(target: ChatTurn[], turnIndex: number, event: ChatEvent) {
    const turn = target[turnIndex];
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
        // Distinct error state (A5) instead of italic text buried in the
        // bubble — rendered as a red strip with Retry.
        turn.isError = true;
        turn.errorMessage = event.message;
        break;
      case "done":
        // Terminal event carries token accounting (A6); echo/legacy
        // backends may omit it.
        if (event.usage) turn.usage = event.usage;
        break;
      case "context":
        break;
    }
  }

  /**
   * Split a tool-summary string (from `tool_summary.ts`) into alternating
   * plain / inline-code segments on its backtick fences. The summary embeds
   * model/user-derived fragments (SQL, predicates, column names) in
   * `` `backticks` ``; rendering them as Svelte-templated <code> spans (rather
   * than {@html}) keeps those fragments inert — no HTML injection — while still
   * giving them the monospace styling the rest of the chat uses.
   */
  function summarySegments(summary: string): Array<{ code: boolean; text: string }> {
    return summary.split("`").map((text, i) => ({ code: i % 2 === 1, text }));
  }

  /**
   * Aggregate citations across every tool call in this assistant turn,
   * de-duplicated, preserving first-seen order. Used to render a single
   * "Sources:" pill row at the end of the turn rather than one per tool.
   */
  function collectCitedRows(tools: ChatToolCall[]): ChatCitation[] {
    const out: ChatCitation[] = [];
    const seen = new Set<string>();
    for (const tool of tools) {
      if (!tool.citedRows) continue;
      for (const c of tool.citedRows) {
        // RowID is `any` in the codebase; stringify for dedup so we
        // handle numeric and string IDs uniformly without surprises.
        const key = String(c.id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
    return out;
  }

  /** Short label for a pill: prefer the human-readable label, falling
   * back to a truncated stringified id when no label is available. */
  function pillLabel(c: ChatCitation): string {
    if (c.label) return c.label.length > 40 ? c.label.slice(0, 39) + "…" : c.label;
    const s = String(c.id);
    return s.length > 10 ? s.slice(0, 10) + "…" : s;
  }

  /** Tooltip text — full label + id, or just id when no label. */
  function pillTitle(c: ChatCitation): string {
    if (c.label) return `${c.label}\n(row ${c.id})`;
    return `row ${c.id}`;
  }

  function onTextareaKeydown(e: KeyboardEvent) {
    // cmdk's Command.Root listens at the document level and intercepts Enter
    // to "select" a command item. Stop propagation so the textarea owns Enter
    // when the user is composing a chat message.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  /** Keydown handler for the refined-prompt preview editor: Enter accepts +
   *  sends, Escape cancels back to the draft, Shift+Enter inserts a newline. */
  function onRefineKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      acceptRefine();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRefine();
    }
  }

  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let refineInputEl: HTMLTextAreaElement | undefined = $state();

  // Pull focus from cmdk's autofocused filter input down to the chat textarea
  // once the endpoint is known.
  $effect(() => {
    if (endpoint && textareaEl) {
      textareaEl.focus();
    }
  });
</script>

<div class="flex flex-col h-full min-h-0">
  <div class="relative flex-1 min-h-0">
    <div bind:this={scroller} onscroll={onScroll} class="absolute inset-0 overflow-y-auto px-4 py-3 space-y-4 text-sm">
      {#if turns.length === 0}
        <div class="text-slate-500 dark:text-slate-400">
          Ask Claude about the rows you have selected — or about the whole dataset if nothing is selected. The agent has
          access to <code>run_sql_query</code> and the rest of the viewer's tool surface, plus a small sample of the rows
          in scope up front.
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
                <!-- Tool-call step card (Tier-1). The summary describes the
                   *viewer effect* (via tool_summary.ts), not the raw MCP
                   payload. Collapsed by default for successful calls; an
                   errored call defaults open (`open={tool.isError}`) so the
                   failure detail is visible without a click. The raw input
                   JSON + result still live in the drawer below. -->
                {@const pendingTool = tool.result === undefined}
                {@const summary = summarizeToolCall({ name: tool.name, input: tool.input, result: tool.result })}
                <details
                  class="chat-tool-card rounded-md border text-xs"
                  class:border-slate-300={!tool.isError}
                  class:dark:border-slate-700={!tool.isError}
                  class:border-red-400={tool.isError}
                  open={tool.isError}
                >
                  <summary class="px-2 py-1 cursor-pointer select-none text-slate-600 dark:text-slate-300">
                    {#if pendingTool}
                      <span class="chat-tool-status chat-tool-status-running" aria-label="Running" title="Running"
                      ></span>
                    {:else if tool.isError}
                      <span class="chat-tool-status chat-tool-status-error" aria-hidden="true">⚠</span>
                    {:else}
                      <span class="chat-tool-status chat-tool-status-done" aria-hidden="true">✓</span>
                    {/if}
                    <span class="chat-tool-summary"
                      >{#each summarySegments(summary) as seg, si (si)}{#if seg.code}<code>{seg.text}</code
                          >{:else}{seg.text}{/if}{/each}</span
                    >
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
                        {@const charts = chartBlocks(tool.resultBlocks)}
                        {#if text}
                          <pre
                            class="whitespace-pre-wrap break-words font-mono text-slate-700 dark:text-slate-300">{text}</pre>
                        {/if}
                        {#if charts.length > 0}
                          <div class="text-slate-500 dark:text-slate-400 italic">
                            [{charts.length} chart{charts.length === 1 ? "" : "s"} rendered below]
                          </div>
                        {/if}
                        {#if images.length > 0}
                          <!-- Images are lifted to the turn level (A4) and shown
                             in the conversation flow below; just note them here. -->
                          <div class="text-slate-500 dark:text-slate-400 italic">
                            [{images.length} image{images.length === 1 ? "" : "s"} shown below]
                          </div>
                        {/if}
                        {#if !text && images.length === 0 && charts.length === 0}
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
              {#each collectChartSpecs(turn.tools) as cb, idx (idx)}
                {#if chartContext}
                  <InlineChartView spec={cb.spec} context={chartContext} onSaveChart={onSaveChart} />
                {:else}
                  <pre
                    class="whitespace-pre-wrap break-words font-mono text-xs text-slate-500 dark:text-slate-400">[chart spec emitted, but no chart context available to render it]</pre>
                {/if}
              {/each}
              {#each collectImages(turn.tools) as img, idx (idx)}
                <!-- Screenshot lifted to the turn flow (A4). Click converts the
                   base64 data URL to a blob URL before opening — browsers block
                   direct navigation to data: URLs in new tabs (phishing
                   mitigation); blob: URLs are allowed. -->
                <button
                  type="button"
                  class="block p-0 border-0 bg-transparent cursor-zoom-in"
                  title="Open image in new tab"
                  onclick={() => openImageInNewTab(img.media_type, img.data)}
                >
                  <img
                    src={`data:${img.media_type};base64,${img.data}`}
                    alt={`Screenshot from ${img.toolName}`}
                    class="chat-turn-image rounded border border-slate-200 dark:border-slate-700"
                  />
                </button>
              {/each}
              {#if turn.text}
                <div class="group relative">
                  <!-- Delegated click handler powers the per-code-block copy
                     buttons injected by renderMarkdown (A6). -->
                  <div class="prose prose-sm dark:prose-invert max-w-none" use:copyCodeDelegate>
                    {@html renderMarkdown(turn.text)}
                  </div>
                  <button
                    type="button"
                    class="chat-copy-msg opacity-0 group-hover:opacity-100"
                    title="Copy message"
                    onclick={() => copyMessage(i, turn.text)}
                  >
                    {copiedIdx === i ? "Copied" : "Copy"}
                  </button>
                </div>
              {/if}
              {#if turn.isError}
                <div class="chat-error-strip">
                  <span aria-hidden="true">⚠</span>
                  <span>{turn.errorMessage ?? "Something went wrong."}</span>
                </div>
              {/if}
              {#if turn.usage}
                <div
                  class="text-[0.7rem] text-slate-400 dark:text-slate-500 select-none"
                  title="Token usage for this turn"
                >
                  {turn.usage.input_tokens.toLocaleString()} in · {turn.usage.output_tokens.toLocaleString()} out
                </div>
              {/if}
              {#if collectCitedRows(turn.tools).length > 0}
                <div class="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <span class="select-none">Sources:</span>
                  {#each collectCitedRows(turn.tools) as citation, idx (idx)}
                    <button
                      type="button"
                      class="chat-source-pill"
                      title={pillTitle(citation)}
                      onclick={() => onPillClick?.(citation.id)}
                      disabled={!onPillClick}
                    >
                      {pillLabel(citation)}
                    </button>
                  {/each}
                </div>
              {/if}
              {#if canRetry && i === turns.length - 1}
                <div>
                  <button type="button" class="chat-retry-btn" onclick={retry} title="Re-run this response">
                    ↻ Retry
                  </button>
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
    {#if !atBottom && pending}
      <button
        type="button"
        class="chat-jump-btn"
        title="Jump to latest"
        onclick={() => {
          atBottom = true;
          scrollToBottom();
        }}
      >
        ↓ Jump to latest
      </button>
    {/if}
  </div>

  <div class="border-t border-slate-200 dark:border-slate-700 p-2">
    {#if !endpoint}
      <div class="text-xs text-slate-500 dark:text-slate-400 px-2 py-1">
        Chat backend not configured. Pass <code>chatEndpoint</code> to <code>EmbeddingAtlas</code>
        or run the dev server with <code>--chat</code>.
      </div>
    {:else if refinePreview}
      <!-- Editable refined-prompt preview (Tier-2): the rewritten prompt is
         shown before send so the user can accept / tweak / revert / cancel. -->
      <div class="chat-refine-preview">
        <div class="chat-refine-label">
          <span aria-hidden="true">✨</span>
          <span>Refined prompt — edit, then send (Esc to cancel)</span>
        </div>
        <textarea
          bind:this={refineInputEl}
          bind:value={refinePreview.refined}
          onkeydown={onRefineKeydown}
          rows="3"
          class="chat-refine-textarea"
        ></textarea>
        <div class="chat-refine-actions">
          <button
            type="button"
            class="chat-refine-btn chat-refine-send"
            onclick={acceptRefine}
            title="Send the refined prompt"
          >
            Send refined
          </button>
          <button
            type="button"
            class="chat-refine-btn"
            onclick={revertRefine}
            disabled={refinePreview.refined === refinePreview.original}
            title="Restore the original wording"
          >
            Revert
          </button>
          <button type="button" class="chat-refine-btn" onclick={cancelRefine} title="Discard and edit the original">
            Cancel
          </button>
        </div>
      </div>
    {:else}
      <textarea
        bind:this={textareaEl}
        bind:value={draft}
        onkeydown={onTextareaKeydown}
        placeholder="Ask Claude about the rows in scope… (Enter to send, Shift+Enter for newline)"
        rows="2"
        disabled={pending || refining}
        class="w-full resize-none bg-transparent outline-none px-2 py-1 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-50"
      ></textarea>
      <div class="flex items-center justify-between px-1 pt-1">
        <!-- Refine toggle (wand). When ON, send first rewrites the prompt with
           EA context and shows an editable preview. Hidden when the backend
           advertises no refine endpoint. -->
        {#if refineEndpoint}
          <button
            type="button"
            class="chat-refine-toggle"
            class:active={refineEnabled}
            aria-pressed={refineEnabled}
            onclick={toggleRefine}
            disabled={pending || refining}
            title={refineEnabled
              ? "Refine prompt before sending: ON — click to turn off"
              : "Refine prompt before sending: OFF — click to turn on"}
          >
            <span aria-hidden="true">✨</span>
            <span>Refine</span>
          </button>
        {:else}
          <span></span>
        {/if}
        {#if refining}
          <span class="chat-refine-status">Refining…</span>
        {:else if pending}
          <button type="button" class="chat-stop-btn" onclick={stop} title="Stop generating"> ◼ Stop </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Tool-call step card status indicator. A small leading glyph/dot shows
     running → done → error; the summary text (from tool_summary.ts) sits
     beside it. Kept inline so the card header stays one line. */
  .chat-tool-status {
    display: inline-block;
    width: 1em;
    text-align: center;
    margin-right: 0.15rem;
  }
  .chat-tool-status-done {
    color: rgb(22 163 74); /* green-600 */
  }
  .chat-tool-status-error {
    color: rgb(220 38 38); /* red-600 */
  }
  /* Running: a small pulsing dot rendered via the empty span's box. */
  .chat-tool-status-running {
    width: 0.5em;
    height: 0.5em;
    border-radius: 9999px;
    background: rgb(100 116 139); /* slate-500 */
    vertical-align: middle;
    animation: chat-tool-pulse 1s ease-in-out infinite;
  }
  @keyframes chat-tool-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat-tool-status-running {
      animation: none;
    }
  }
  .chat-tool-summary {
    color: rgb(51 65 85); /* slate-700 */
  }
  :global(.dark) .chat-tool-summary {
    color: rgb(203 213 225); /* slate-300 */
  }
  /* Inline `code` spans the summary uses for SQL / predicate fragments. */
  .chat-tool-summary code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
  }

  /* Cap the turn-level screenshot (A4) at a sane size; the button wrapping
     the image opens the full-resolution data URL in a new tab on click
     (simpler than a lightbox). */
  .chat-turn-image {
    display: block;
    max-width: 400px;
    max-height: 300px;
    width: auto;
    height: auto;
    margin: 0.25rem 0;
    object-fit: contain;
    cursor: zoom-in;
  }

  /* Hover-revealed "Copy message" button on assistant bubbles (A6). */
  .chat-copy-msg {
    position: absolute;
    top: 0;
    right: 0;
    padding: 0.0625rem 0.4rem;
    border-radius: 0.375rem;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: rgb(248 250 252); /* slate-50 */
    color: rgb(71 85 105); /* slate-600 */
    font-size: 0.7rem;
    line-height: 1.2;
    cursor: pointer;
    transition: opacity 120ms ease;
  }
  .chat-copy-msg:hover {
    background: rgb(226 232 240); /* slate-200 */
  }
  :global(.dark) .chat-copy-msg {
    border-color: rgb(51 65 85); /* slate-700 */
    background: rgb(30 41 59); /* slate-800 */
    color: rgb(203 213 225); /* slate-300 */
  }

  /* Per-code-block copy button injected by renderMarkdown (A6). Global
     because the <pre>/<button> live inside {@html}-rendered prose. */
  :global(.prose pre) {
    position: relative;
  }
  :global(.copy-code-btn) {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    padding: 0.0625rem 0.4rem;
    border-radius: 0.375rem;
    border: 1px solid rgb(71 85 105); /* slate-600 */
    background: rgb(30 41 59); /* slate-800 */
    color: rgb(226 232 240); /* slate-200 */
    font-size: 0.65rem;
    line-height: 1.2;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  :global(.prose pre:hover .copy-code-btn),
  :global(.copy-code-btn:focus-visible) {
    opacity: 1;
  }

  /* Error strip on a failed assistant turn (A5). */
  .chat-error-strip {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid rgb(248 113 113); /* red-400 */
    border-radius: 0.375rem;
    background: rgb(254 242 242); /* red-50 */
    color: rgb(153 27 27); /* red-800 */
    font-size: 0.8rem;
    line-height: 1.3;
  }
  :global(.dark) .chat-error-strip {
    background: rgb(69 10 10 / 0.4); /* red-950-ish */
    color: rgb(252 165 165); /* red-300 */
  }

  /* Retry button under an errored/stopped turn (A5). */
  .chat-retry-btn {
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: transparent;
    color: rgb(71 85 105); /* slate-600 */
    font-size: 0.75rem;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }
  .chat-retry-btn:hover {
    background: rgb(241 245 249); /* slate-100 */
    border-color: rgb(148 163 184); /* slate-400 */
  }
  :global(.dark) .chat-retry-btn {
    border-color: rgb(51 65 85); /* slate-700 */
    color: rgb(203 213 225); /* slate-300 */
  }
  :global(.dark) .chat-retry-btn:hover {
    background: rgb(30 41 59); /* slate-800 */
  }

  /* Floating "Jump to latest" button (A3). */
  .chat-jump-btn {
    position: absolute;
    bottom: 0.75rem;
    right: 0.75rem;
    padding: 0.25rem 0.6rem;
    border-radius: 9999px;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: rgb(255 255 255);
    color: rgb(51 65 85); /* slate-700 */
    font-size: 0.72rem;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
    cursor: pointer;
  }
  .chat-jump-btn:hover {
    background: rgb(241 245 249); /* slate-100 */
  }
  :global(.dark) .chat-jump-btn {
    border-color: rgb(51 65 85); /* slate-700 */
    background: rgb(15 23 42); /* slate-900 */
    color: rgb(203 213 225); /* slate-300 */
  }

  /* Stop button while streaming (A1). */
  .chat-stop-btn {
    padding: 0.125rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: transparent;
    color: rgb(71 85 105); /* slate-600 */
    font-size: 0.75rem;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }
  .chat-stop-btn:hover {
    background: rgb(254 242 242); /* red-50 */
    border-color: rgb(248 113 113); /* red-400 */
    color: rgb(153 27 27); /* red-800 */
  }
  :global(.dark) .chat-stop-btn {
    border-color: rgb(51 65 85); /* slate-700 */
    color: rgb(203 213 225); /* slate-300 */
  }
  :global(.dark) .chat-stop-btn:hover {
    background: rgb(69 10 10 / 0.4);
    border-color: rgb(248 113 113);
    color: rgb(252 165 165);
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
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
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

  /* Refine wand toggle in the composer (Tier-2). Active = filled accent. */
  .chat-refine-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: transparent;
    color: rgb(71 85 105); /* slate-600 */
    font-size: 0.72rem;
    line-height: 1.2;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }
  .chat-refine-toggle:hover:not(:disabled) {
    background: rgb(241 245 249); /* slate-100 */
    border-color: rgb(148 163 184); /* slate-400 */
  }
  .chat-refine-toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .chat-refine-toggle.active {
    border-color: rgb(124 58 237); /* violet-600 */
    background: rgb(124 58 237); /* violet-600 */
    color: rgb(255 255 255);
  }
  :global(.dark) .chat-refine-toggle {
    border-color: rgb(51 65 85); /* slate-700 */
    color: rgb(203 213 225); /* slate-300 */
  }
  :global(.dark) .chat-refine-toggle:hover:not(:disabled) {
    background: rgb(30 41 59); /* slate-800 */
  }
  :global(.dark) .chat-refine-toggle.active {
    border-color: rgb(139 92 246); /* violet-500 */
    background: rgb(139 92 246);
    color: rgb(255 255 255);
  }

  /* "Refining…" status text shown while the rewrite is in flight. */
  .chat-refine-status {
    font-size: 0.72rem;
    color: rgb(124 58 237); /* violet-600 */
  }
  :global(.dark) .chat-refine-status {
    color: rgb(167 139 250); /* violet-400 */
  }

  /* Editable refined-prompt preview block. */
  .chat-refine-preview {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.4rem;
    border-radius: 0.5rem;
    border: 1px solid rgb(196 181 253); /* violet-300 */
    background: rgb(245 243 255); /* violet-50 */
  }
  :global(.dark) .chat-refine-preview {
    border-color: rgb(91 33 182); /* violet-800 */
    background: rgb(46 16 101 / 0.35); /* violet-950-ish */
  }
  .chat-refine-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.7rem;
    color: rgb(109 40 217); /* violet-700 */
  }
  :global(.dark) .chat-refine-label {
    color: rgb(196 181 253); /* violet-300 */
  }
  .chat-refine-textarea {
    width: 100%;
    resize: none;
    border-radius: 0.375rem;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: rgb(255 255 255);
    padding: 0.4rem 0.5rem;
    font-size: 0.8rem;
    line-height: 1.35;
    color: rgb(30 41 59); /* slate-800 */
    outline: none;
  }
  .chat-refine-textarea:focus {
    border-color: rgb(139 92 246); /* violet-500 */
  }
  :global(.dark) .chat-refine-textarea {
    border-color: rgb(51 65 85); /* slate-700 */
    background: rgb(15 23 42); /* slate-900 */
    color: rgb(226 232 240); /* slate-200 */
  }
  .chat-refine-actions {
    display: flex;
    gap: 0.4rem;
  }
  .chat-refine-btn {
    padding: 0.125rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    background: transparent;
    color: rgb(71 85 105); /* slate-600 */
    font-size: 0.75rem;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }
  .chat-refine-btn:hover:not(:disabled) {
    background: rgb(241 245 249); /* slate-100 */
    border-color: rgb(148 163 184); /* slate-400 */
  }
  .chat-refine-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .chat-refine-send {
    border-color: rgb(124 58 237); /* violet-600 */
    background: rgb(124 58 237); /* violet-600 */
    color: rgb(255 255 255);
  }
  .chat-refine-send:hover:not(:disabled) {
    background: rgb(109 40 217); /* violet-700 */
    border-color: rgb(109 40 217);
  }
  :global(.dark) .chat-refine-btn {
    border-color: rgb(51 65 85); /* slate-700 */
    color: rgb(203 213 225); /* slate-300 */
  }
  :global(.dark) .chat-refine-btn:hover:not(:disabled) {
    background: rgb(30 41 59); /* slate-800 */
  }
  :global(.dark) .chat-refine-send {
    border-color: rgb(139 92 246); /* violet-500 */
    background: rgb(139 92 246);
    color: rgb(255 255 255);
  }
  :global(.dark) .chat-refine-send:hover:not(:disabled) {
    background: rgb(124 58 237); /* violet-600 */
  }
</style>
