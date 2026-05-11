// Copyright (c) 2025 Apple Inc. Licensed under MIT License.
//
// Chrome smoke tests for the icon strip + settings modal state model.
// Exercises every observable affordance the user touches: the strip's
// layout / show-hide / theme / settings buttons, the settings modal's
// tab navigation, every dismissal vector (ESC / click-outside / X /
// keyboard toggle), and persistence across reload.

import { test, expect } from "@playwright/test";

// Selector helpers — strip elements all carry aria-label, so we
// locate by accessible name to keep the tests robust against class
// changes. bits-ui exposes:
//   - ToggleGroup.Item as role="radio" with aria-checked (radio kind)
//   - Toggle.Root as role="button" with aria-pressed (toggles kind)
//   - Momentary buttons as plain role="button"
//   - Dialog.Title as <h2> with the dialog's accessible name
//   - Tabs.Trigger as role="tab" with aria-selected
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
const settingsGear = (page: import("@playwright/test").Page) =>
  // Title includes "(⌘B)" hint — match by prefix to stay resilient.
  page.getByRole("button", { name: /^Settings/ });

const modal = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog");
const modalTitle = (page: import("@playwright/test").Page) =>
  page.getByRole("heading", { level: 2, name: "Settings" });
const tabIn = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("tab", { name });

test.beforeEach(async ({ page }) => {
  // Use the /test route for the dev server — it provides a synthetic
  // dataset via TestDataSource, so the atlas mounts without requiring
  // a separate backend service. The "/" route expects a backend at
  // localhost:5055 which isn't part of the chrome smoke test surface.
  await page.goto("/#/test");
  // Wait for atlas chrome to mount — the layout-list radio button is
  // a reliable mount signal (it's always present, doesn't depend on
  // chart registration order).
  await expect(layoutList(page)).toBeVisible({ timeout: 30000 });
  // Reset persisted chrome state so each test starts from defaults.
  await page.evaluate(() => {
    localStorage.removeItem("embedding-atlas:settings-active-tab");
    // Legacy keys from the prior inline-panel chrome.
    localStorage.removeItem("embedding-atlas:panel-key");
    localStorage.removeItem("embedding-atlas:panel-last-key");
    localStorage.removeItem("embedding-atlas:settings-tab");
  });
  await page.reload();
  await expect(layoutList(page)).toBeVisible({ timeout: 30000 });
});

test("settings gear opens modal; closing X dismisses it", async ({ page }) => {
  // Modal absent at start.
  await expect(modal(page)).toHaveCount(0);

  await settingsGear(page).click();
  // Modal mounts with the dialog title visible.
  await expect(modal(page)).toBeVisible();
  await expect(modalTitle(page)).toBeVisible();
  // Default tab is Global (the first section).
  await expect(tabIn(page, "Global")).toHaveAttribute("aria-selected", "true");

  // X button dismisses.
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(modal(page)).toHaveCount(0);
});

test("ESC dismisses modal", async ({ page }) => {
  await settingsGear(page).click();
  await expect(modal(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);
});

test("click outside (backdrop) dismisses modal", async ({ page }) => {
  await settingsGear(page).click();
  await expect(modal(page)).toBeVisible();
  // Click far outside the modal (top-left of viewport) — backdrop
  // covers the rest of the page, click goes through bits-ui's
  // dismissible-layer.
  await page.mouse.click(5, 5);
  await expect(modal(page)).toHaveCount(0);
});

test("tab switching inside the modal swaps the active section", async ({ page }) => {
  await settingsGear(page).click();
  await expect(tabIn(page, "Global")).toHaveAttribute("aria-selected", "true");

  await tabIn(page, "Search").click();
  await expect(tabIn(page, "Global")).toHaveAttribute("aria-selected", "false");
  await expect(tabIn(page, "Search")).toHaveAttribute("aria-selected", "true");
});

test("layout switch keeps strip identical (no buttons hide on dashboard)", async ({ page }) => {
  await expect(layoutList(page)).toBeChecked();
  await expect(visEmbedding(page)).toBeVisible();
  await expect(visTable(page)).toBeVisible();
  await expect(visCharts(page)).toBeVisible();
  await expect(settingsGear(page)).toBeVisible();

  await layoutDashboard(page).click();
  await expect(layoutDashboard(page)).toBeChecked();

  // Same buttons MUST still be visible. No dim, no hide.
  await expect(visEmbedding(page)).toBeVisible();
  await expect(visTable(page)).toBeVisible();
  await expect(visCharts(page)).toBeVisible();
  await expect(settingsGear(page)).toBeVisible();
  // And clickable — Toggle.Root primitive has no `disabled` attr.
  await expect(visEmbedding(page)).toBeEnabled();
});

test("show/hide click on dashboard mutates list state silently", async ({ page }) => {
  await layoutDashboard(page).click();
  await expect(visTable(page)).toHaveAttribute("aria-pressed", "true");
  await visTable(page).click();
  await expect(visTable(page)).toHaveAttribute("aria-pressed", "false");

  // Switch back to list — table should now be hidden (state was
  // recorded silently on dashboard).
  await layoutList(page).click();
  await expect(visTable(page)).toHaveAttribute("aria-pressed", "false");
});

test("⌘B toggles the settings modal", async ({ page }) => {
  await expect(modal(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(modal(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(modal(page)).toHaveCount(0);
});

test("⌘, also toggles the settings modal", async ({ page }) => {
  await expect(modal(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(modal(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(modal(page)).toHaveCount(0);
});

test("persistence: modal reopens closed but with last-active tab", async ({ page }) => {
  // Open modal, switch to Search, close.
  await settingsGear(page).click();
  await tabIn(page, "Search").click();
  await expect(tabIn(page, "Search")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);

  // Reload — modal stays closed (intentional: ephemeral focus
  // experience, not persisted), but reopening lands on Search.
  await page.reload();
  await expect(layoutList(page)).toBeVisible({ timeout: 30000 });
  await expect(modal(page)).toHaveCount(0);
  await settingsGear(page).click();
  await expect(tabIn(page, "Search")).toHaveAttribute("aria-selected", "true");
});
