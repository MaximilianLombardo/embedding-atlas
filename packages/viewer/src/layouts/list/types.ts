// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

export type Section = "embedding" | "table" | "chart";

export type TableTab = "table" | "chat";

export interface ListLayoutState {
  showTable?: boolean;
  showEmbedding?: boolean;
  showCharts?: boolean;

  chartsOrder?: string[];
  chartVisibility?: Record<string, boolean>;

  placements?: Record<string, Section>;

  tableTab?: TableTab;
}
