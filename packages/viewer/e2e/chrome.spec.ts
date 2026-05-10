// Copyright (c) 2025 Apple Inc. Licensed under MIT License.
//
// Chrome smoke tests for the icon strip + settings panel state model.
// Exercises every observable affordance the user touches: each tab
// button, each layout button, each visibility toggle, the theme button,
// the ⌘B shortcut, and persistence across reload.

import { test, expect } from "@playwright/test";

// Selector helpers — strip elements all carry aria-label, so we
// locate by accessible name to keep the tests robust against class
// changes. bits-ui exposes ToggleGroup.Item as role="radio" (single
// mode) and Toggle.Root as role="button"; pick the matching role per
// section kind.
const tabGlobal = (page: import("@playwright/test").Page) =>
  page.getByRole("radio", { name: "Global settings" });
const tabSearch = (page: import("@playwright/test").Page) =>
  page.getByRole("radio", { name: "Search settings" });
const layoutList = (page: import("@playwright/test").Page) =>
  page.getByRole("radio", { name: "List layout" });
const layoutDashboard = (page: import("@playwright/test").Page) =>
  page.getByRole("radio", { name: "Dashboard layout" });
const visEmbedding = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Show / hide embedding" });
const visTable = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Show / hide table" });
const visCharts = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Show / hide charts" });

const panelHeader = (page: import("@playwright/test").Page) =>
  page.getByRole("heading", { level: 2 }).filter({ hasText: /Settings/ });

test.beforeEach(async ({ page }) => {
  // Use the /test route for the dev server — it provides a
  // synthetic dataset via TestDataSource, so the atlas mounts
  // without requiring a separate backend service. The "/" route
  // expects a backend at localhost:5055 which isn't part of the
  // chrome smoke test surface.
  await page.goto("/#/test");
  // Wait for atlas chrome to mount — strip buttons appear when the
  // root component has rendered. We don't wait on the embedding /
  // table content here because those depend on dataset load.
  await expect(tabGlobal(page)).toBeVisible({ timeout: 30000 });
  // Reset persisted chrome state so each test starts from defaults.
  await page.evaluate(() => {
    localStorage.removeItem("embedding-atlas:panel-key");
    localStorage.removeItem("embedding-atlas:panel-last-key");
    localStorage.removeItem("embedding-atlas:settings-tab"); // legacy
  });
  await page.reload();
  await expect(tabGlobal(page)).toBeVisible({ timeout: 30000 });
});

test("panel opens to Global on click, closes on second click", async ({ page }) => {
  // Initially closed: tab is not selected.
  await expect(tabGlobal(page)).not.toBeChecked();

  await tabGlobal(page).click();
  await expect(tabGlobal(page)).toBeChecked();
  await expect(panelHeader(page)).toContainText("Settings — Global");

  await tabGlobal(page).click();
  await expect(tabGlobal(page)).not.toBeChecked();
});

test("clicking different tab while panel is open switches sections", async ({ page }) => {
  await tabGlobal(page).click();
  await expect(panelHeader(page)).toContainText("Settings — Global");

  await tabSearch(page).click();
  await expect(panelHeader(page)).toContainText("Settings — Search");
  await expect(tabGlobal(page)).not.toBeChecked();
  await expect(tabSearch(page)).toBeChecked();
});

test("layout switch keeps strip identical (no buttons hide on dashboard)", async ({ page }) => {
  // Capture which buttons are visible on list layout.
  await expect(layoutList(page)).toBeChecked();
  await expect(visEmbedding(page)).toBeVisible();
  await expect(visTable(page)).toBeVisible();
  await expect(visCharts(page)).toBeVisible();

  await layoutDashboard(page).click();
  await expect(layoutDashboard(page)).toBeChecked();

  // Same buttons MUST still be visible. No dim, no hide.
  await expect(visEmbedding(page)).toBeVisible();
  await expect(visTable(page)).toBeVisible();
  await expect(visCharts(page)).toBeVisible();
  // And clickable — Toggle.Root primitive has no `disabled` attr.
  await expect(visEmbedding(page)).toBeEnabled();
});

test("show/hide click on dashboard mutates list state silently", async ({ page }) => {
  // Switch to dashboard, then toggle the table visibility off.
  await layoutDashboard(page).click();
  await expect(visTable(page)).toHaveAttribute("aria-pressed", "true");
  await visTable(page).click();
  await expect(visTable(page)).toHaveAttribute("aria-pressed", "false");

  // Switch back to list — table should now be hidden (state was
  // recorded silently on dashboard).
  await layoutList(page).click();
  await expect(visTable(page)).toHaveAttribute("aria-pressed", "false");
});

test("⌘B / Ctrl+B toggles the panel", async ({ page }) => {
  await expect(tabGlobal(page)).not.toBeChecked();
  // Use Meta on macOS, Control elsewhere — Playwright's keyboard
  // module accepts the platform-agnostic 'ControlOrMeta' modifier.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(panelHeader(page)).toBeVisible();
  await expect(tabGlobal(page)).toBeChecked();
  await page.keyboard.press("ControlOrMeta+b");
  // Panel content stays mounted (width 0); aria-checked on Global
  // flips back to false.
  await expect(tabGlobal(page)).not.toBeChecked();
});

test("persistence: panel state survives reload", async ({ page }) => {
  await tabSearch(page).click();
  await expect(panelHeader(page)).toContainText("Settings — Search");

  await page.reload();
  await expect(tabSearch(page)).toBeVisible({ timeout: 30000 });
  // Persisted: panel reopens to Search.
  await expect(tabSearch(page)).toBeChecked();
  await expect(panelHeader(page)).toContainText("Settings — Search");
});
