// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { ChatContext } from "./chat_client.js";

export const CHAT_CONTEXT_KEY = Symbol("embedding-atlas:chat");

/**
 * Shared chat resources broadcast via Svelte context. Conversation
 * history (`turns: ChatTurn[]`) used to live here on a singleton
 * provider, but with multi-chat support each chat tab owns its own
 * turns array — `ListLayout` keeps them in a local map keyed by tab
 * id and threads the active tab's array into `ChatPanel` as a
 * bindable prop. The provider is now stateless across tabs.
 */
export interface ChatProvider {
  readonly endpoint: string | null;
  readonly context: ChatContext;
}
