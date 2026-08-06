import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// MV3 build: the background service worker and the popup are separate
// entries; manifest.json rides along from public/. Entry names are pinned so
// manifest.json can reference background.js without hashes.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: fileURLToPath(new URL("./src/background.ts", import.meta.url)),
        popup: fileURLToPath(new URL("./popup.html", import.meta.url)),
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts"],
    // Match the app test runner: one worker thread and no child-process pool.
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
