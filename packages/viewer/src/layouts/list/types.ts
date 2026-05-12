// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

export type Section = "embedding" | "table" | "chart";

/**
 * A canvas tab — a named bucket of charts (and markdown blocks, which
 * are charts of `type: "markdown"`). Canvas membership lives in
 * `chartsOrder`; the global `charts` spec store at the EmbeddingAtlas
 * level stays flat.
 */
export interface CanvasTab {
  kind: "canvas";
  id: string;
  name: string;
  chartsOrder: string[];
  chartVisibility?: Record<string, boolean>;
}

/**
 * A chat tab — an independent conversation thread. Conversations are
 * keyed by `id` and live in a `ListLayout`-local `chatTurns` map (not
 * in this state object) so streaming in-place mutations to the turns
 * array stay reactive — `layoutStates` is `$state.raw` and would not
 * propagate deep mutations.
 */
export interface ChatTab {
  kind: "chat";
  id: string;
  name: string;
}

export type Tab = CanvasTab | ChatTab;

export interface ListLayoutState {
  showTable?: boolean;
  showEmbedding?: boolean;
  showCharts?: boolean;

  placements?: Record<string, Section>;

  /** Active right-panel tab id. Falls back to `tabs[0]?.id` at read time. */
  panelTab?: string;
  /** Ordered list of tabs. Always has at least one entry at runtime. */
  tabs?: Tab[];

  /**
   * Legacy fields from before tabs existed. Read once by `ListLayout`'s
   * migration to seed the initial `tabs[]`, then ignored. Do not consult
   * them in new code.
   */
  chartsOrder?: string[];
  chartVisibility?: Record<string, boolean>;
}
