import { defineConfig } from "vite";

export default defineConfig({
  root: "src/admin/page",
  build: {
    outDir: "../../../dist/admin",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
