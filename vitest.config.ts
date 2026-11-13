import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globalSetup: ["./scripts/prepare-b24-fixtures.mjs"] }
});
