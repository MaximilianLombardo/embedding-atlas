// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { defineConfig } from "vitest/config";

// Scoped to the `test/` directory and the node environment so unit tests for
// pure helpers (e.g. the vision-tools bbox crop math) run without dragging in
// the Svelte/Vite app pipeline.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 1000,
    include: ["test/**/*.test.{js,ts}"],
    exclude: ["node_modules/**/*"],
  },
});
