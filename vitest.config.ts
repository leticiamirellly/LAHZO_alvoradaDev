import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/api/vitest.config.ts",
      "apps/worker/vitest.config.ts",
      "apps/admin/vitest.config.ts",
      "packages/db/vitest.config.ts",
      "packages/twilio/vitest.config.ts"
    ]
  }
});
