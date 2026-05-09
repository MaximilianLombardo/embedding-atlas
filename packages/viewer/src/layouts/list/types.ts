// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

export type Section = "embedding" | "table" | "chart";

export type TableTab = "table" | "chat";

export interface ListLayoutState {
  showTable?: boolean;
  showEmbedding?: boolean;
  showCharts?: boolean;
  /**
   * Visibility of the left-side settings panel. When true, the panel
   * occupies layout space (width animated by `settingsPanelWidth`);
   * when false / undefined, it collapses to 0 and only the icon strip
   * remains visible. Toggled by the strip's gear button.
   */
  showSettings?: boolean;

  chartsOrder?: string[];
  chartVisibility?: Record<string, boolean>;

  placements?: Record<string, Section>;

  tableTab?: TableTab;
}
