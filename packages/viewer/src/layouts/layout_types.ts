// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { Component } from "svelte";

import DashboardLayout from "./dashboard/DashboardLayout.svelte";
import ListLayout from "./list/ListLayout.svelte";

import type { LayoutProps } from "./layout.js";

export type LayoutComponentClass = Component<LayoutProps<any>, {}, "">;

export const layoutTypes: Record<string, LayoutComponentClass> = {
  list: ListLayout,
  dashboard: DashboardLayout,
};

export function findLayoutComponent(type: string): LayoutComponentClass {
  return layoutTypes[type] ?? layoutTypes.list;
}
