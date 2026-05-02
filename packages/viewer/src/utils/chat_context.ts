// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { ChatContext, ChatTurn } from "./chat_client.js";

export const CHAT_CONTEXT_KEY = Symbol("embedding-atlas:chat");

/**
 * Lifted chat state shared across the viewer (palette, list-layout tab).
 * Use property getters so consumers re-evaluate on access and capture
 * the latest predicate, endpoint, etc.
 */
export interface ChatProvider {
  readonly endpoint: string | null;
  readonly context: ChatContext;
  /** Wrap the lifted $state so children can `bind:` the array. */
  readonly state: { turns: ChatTurn[] };
}
