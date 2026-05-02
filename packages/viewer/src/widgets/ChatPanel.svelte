<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { Coordinator, makeClient, type Selection } from "@uwdata/mosaic-core";
  import { Query, sql } from "@uwdata/mosaic-sql";
  import { getContext } from "svelte";

  import ChatView from "./ChatView.svelte";

  import { CHAT_CONTEXT_KEY, type ChatProvider } from "../utils/chat_context.js";

  interface Props {
    coordinator: Coordinator;
    table: string;
    filter: Selection;
  }

  let { coordinator, table, filter }: Props = $props();

  const chat = getContext<ChatProvider>(CHAT_CONTEXT_KEY);

  let totalCount: number | null = $state(null);
  let count: number | null = $state(null);

  $effect(() => {
    totalCount = null;
    count = null;
    let client = makeClient({
      coordinator: coordinator,
      selection: filter,
      prepare: async () => {
        let result = await coordinator.query(Query.from(table).select({ count: sql`COUNT(*)::INT` }));
        totalCount = result.get(0).count;
      },
      query: (predicate) =>
        Query.from(table)
          .select({ count: sql`COUNT(*)::INT` })
          .where(predicate),
      queryResult: (result: any) => {
        count = result.getChild("count").get(0);
      },
    });
    return () => {
      client.destroy();
    };
  });

  let badge = $derived.by(() => {
    if (count == null) return "…";
    if (totalCount != null && count === totalCount) return "All rows";
    return `${count.toLocaleString()} selected`;
  });

  function clearChat() {
    chat.state.turns = [];
  }
</script>

<div
  class="w-full h-full flex flex-col overflow-hidden rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
>
  <div
    class="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-700 gap-4 flex-none"
  >
    <div class="text-xs text-slate-500 dark:text-slate-400 select-none">{badge}</div>
    <button
      class="text-xs px-2 py-1 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
      disabled={chat.state.turns.length === 0}
      onclick={clearChat}
      title="Clear chat history"
    >
      Clear chat
    </button>
  </div>
  <div class="flex-1 min-h-0">
    <ChatView endpoint={chat.endpoint} context={chat.context} bind:turns={chat.state.turns} />
  </div>
</div>
