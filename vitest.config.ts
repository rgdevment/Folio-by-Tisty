import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    test: {
      projects: [
        { test: { name: "core", include: ["test/*.test.ts"], exclude: ["test/*.cloud.test.ts"] } },
        {
          plugins: [
            cloudflareTest({
              main: "src/private/index.ts",
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations, FOLIO_SECRET: "09".repeat(32) } },
            }),
          ],
          test: { name: "cloud", include: ["test/*.cloud.test.ts"] },
        },
      ],
    },
  };
});
