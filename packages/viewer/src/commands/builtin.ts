// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { PanelTab } from "../layouts/list/types.js";

export type CommandGroup = "View" | "Filter" | "Color" | "Chat" | "Export";

export interface Command {
  id: string;
  label: string;
  group?: CommandGroup;
  /** Right-aligned shortcut-style hint, e.g. "⌘\\". */
  hint?: string;
  run: () => void | Promise<void>;
}

export interface BuildCommandsArgs {
  layout: string;
  setLayout: (layout: string) => void;
  isDark: boolean;
  toggleDarkMode: () => void;
  resetFilter: () => void;
  /** Chat is gated; commands depending on it are dropped when false. */
  chatAvailable: boolean;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  /** Categorical column names eligible for the Color group (2 ≤ distinct ≤ 50). */
  colorCandidates: string[];
  colorBy: (column: string) => void;
}

export function buildCommands(args: BuildCommandsArgs): Command[] {
  const cmds: Command[] = [];

  if (args.layout !== "dashboard") {
    cmds.push({
      id: "view.dashboard",
      label: "Switch to dashboard layout",
      group: "View",
      run: () => args.setLayout("dashboard"),
    });
  }
  if (args.layout !== "list") {
    cmds.push({
      id: "view.list",
      label: "Switch to list layout",
      group: "View",
      run: () => args.setLayout("list"),
    });
  }

  cmds.push({
    id: "view.dark",
    label: args.isDark ? "Switch to light mode" : "Switch to dark mode",
    group: "View",
    run: args.toggleDarkMode,
  });

  if (args.chatAvailable && args.layout === "list") {
    cmds.push({
      id: "view.chat-tab",
      label: args.panelTab === "chat" ? "Show charts panel" : "Show chat panel",
      group: "View",
      run: () => args.setPanelTab(args.panelTab === "chat" ? "charts" : "chat"),
    });
  }

  cmds.push({
    id: "filter.clear",
    label: "Clear all filters",
    group: "Filter",
    run: args.resetFilter,
  });

  for (const column of args.colorCandidates) {
    cmds.push({
      id: `color.${column}`,
      label: `Color embedding by ${column}`,
      group: "Color",
      run: () => args.colorBy(column),
    });
  }

  return cmds;
}

/** Stable group order for rendering. */
export const COMMAND_GROUP_ORDER: CommandGroup[] = ["View", "Filter", "Color", "Chat", "Export"];

export function groupCommands(commands: Command[]): { group: CommandGroup | "Other"; items: Command[] }[] {
  const buckets = new Map<CommandGroup | "Other", Command[]>();
  for (const c of commands) {
    const g = c.group ?? "Other";
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(c);
  }
  const ordered: { group: CommandGroup | "Other"; items: Command[] }[] = [];
  for (const g of COMMAND_GROUP_ORDER) {
    const items = buckets.get(g);
    if (items?.length) ordered.push({ group: g, items });
  }
  const other = buckets.get("Other");
  if (other?.length) ordered.push({ group: "Other", items: other });
  return ordered;
}
