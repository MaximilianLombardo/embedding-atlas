// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Persistence for per-chat-tab conversation history — one localStorage key
// per dataset table. Companion to `use_column_state.svelte.ts` and follows
// the same defensive shape: guard a disabled/throwing localStorage, validate
// on read so malformed turns can't crash a hydrate, and swallow quota errors
// on write.

import type { ChatTurn } from "../../../utils/chat_client.js";

const STORAGE_PREFIX = "embedding-atlas:chat:";

/** Map of chat-tab id → that tab's conversation turns. */
export type StoredChatHistory = Record<string, ChatTurn[]>;

/** A turn we're willing to restore. Tool/citation/usage fields are optional
 *  and round-trip as-is; we only insist on the load-bearing shape. */
function isValidTurn(t: unknown): t is ChatTurn {
  if (typeof t !== "object" || t == null) return false;
  const turn = t as Record<string, unknown>;
  return (
    (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string" && Array.isArray(turn.tools)
  );
}

/**
 * Load stored chat history for a table: a map of tab id → turns, with
 * malformed turns and non-array entries dropped. Safe to call before mount
 * and where localStorage is disabled or throws (returns `{}`).
 */
export function loadStoredChatHistory(tableName: string): StoredChatHistory {
  if (typeof localStorage === "undefined") return {};
  if (!tableName) return {};
  let raw: unknown;
  try {
    const text = localStorage.getItem(STORAGE_PREFIX + tableName);
    if (!text) return {};
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw == null) return {};
  const out: StoredChatHistory = {};
  for (const [tabId, turns] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(turns)) continue;
    out[tabId] = turns.filter(isValidTurn);
  }
  return out;
}

/** Persist the full per-tab chat history map. Failures (quota, disabled
 *  storage) are swallowed — chat history is best-effort, never load-bearing. */
export function saveStoredChatHistory(tableName: string, history: StoredChatHistory): void {
  if (typeof localStorage === "undefined") return;
  if (!tableName) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + tableName, JSON.stringify(history));
  } catch {
    /* ignore quota / disabled */
  }
}
