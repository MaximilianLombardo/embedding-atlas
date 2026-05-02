// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Streams Server-Sent Events from the Embedding Atlas chat backend.
// Mirrors the event schema produced by `packages/backend/embedding_atlas/chat.py`.

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

export type ChatEvent =
  | { type: "context"; row_count: number | null; predicate: string | null; sample_size: number }
  | { type: "delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "done"; reason?: string }
  | { type: "error"; message: string };

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
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
