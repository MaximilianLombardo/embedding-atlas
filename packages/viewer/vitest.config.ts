// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { defineConfig } from "vitest/config";

// Node environment so unit tests for pure helpers (latent-ops, retrieve-result
// shaping, vision-tools bbox crop math) run without dragging in the Svelte/Vite
// app pipeline. Tests live both co-located under src/ and under test/.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{js,ts}", "test/**/*.test.{js,ts}"],
    exclude: ["node_modules/**/*", "e2e/**/*"],
  },
});
