// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Streams Server-Sent Events from the Embedding Atlas chat backend.
// Mirrors the event schema produced by `packages/backend/embedding_atlas/chat.py`.

import type { RowID } from "../charts/chart.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContext {
  predicate: string | null;
  table?: string;
  id_column?: string;
  text_column?: string | null;
  row_count?: number | null;
}

/**
 * Anthropic-format tool_result content block. Mirrors the subset the backend
 * forwards in the SSE `tool_result.content_blocks` field. Only `text` and
 * `image` are handled by the chat UI today; unknown kinds are tolerated for
 * forward-compat with future backend additions.
 */
export type ChatContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | { type: string; [key: string]: unknown };

export type ChatEvent =
  | { type: "context"; row_count: number | null; predicate: string | null; sample_size: number }
  | { type: "delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      content: string;
      // Present when the tool returned structured (non-string) content —
      // typically a screenshot. Absent for legacy text-only results.
      content_blocks?: ChatContentBlock[];
      is_error: boolean;
      // Citation entries extracted from a SQL-style tool result. Each entry
      // pairs a row id (the dataset's id_column value) with an optional
      // human-readable label drawn from the row (title/name/text/etc.).
      // Absent for tool results that don't include the id column.
      cited_rows?: ChatCitation[];
    }
  | { type: "done"; reason?: string }
  | { type: "error"; message: string };

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  /**
   * Structured Anthropic content blocks when the tool returned mixed
   * text/image content. Absent for text-only results — consumers should
   * fall back to `result` in that case.
   */
  resultBlocks?: ChatContentBlock[];
  isError?: boolean;
  /**
   * Citation entries extracted from a SQL-shaped tool result whose rows
   * carry the dataset's id column. Each entry has a row id plus an
   * optional human-readable label (title/name/text/etc.) used for the
   * pill text. Used to render citation pills at the end of the assistant
   * turn.
   */
  citedRows?: ChatCitation[];
}

/** A single citation pill. */
export interface ChatCitation {
  id: RowID;
  label?: string | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  tools: ChatToolCall[];
}

interface SSERecord {
  event: string;
  data: string;
}

async function* parseSSE(response: Response): AsyncIterable<SSERecord> {
  if (!response.body) {
    throw new Error("Response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      yield { event, data: dataLines.join("\n") };
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export async function* streamChat(
  endpoint: string,
  request: { messages: ChatMessage[]; context: ChatContext },
  signal?: AbortSignal,
): AsyncIterable<ChatEvent> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: signal,
  });
  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}`);
  }
  for await (const record of parseSSE(response)) {
    if (!record.data) continue;
    let payload: any;
    try {
      payload = JSON.parse(record.data);
    } catch {
      continue;
    }
    yield { type: record.event, ...payload } as ChatEvent;
    if (record.event === "done" || record.event === "error") {
      return;
    }
  }
}
