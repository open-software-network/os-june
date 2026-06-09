import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_COMMIT_HASH__: JSON.stringify(gitCommitHash()),
  },
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: Boolean(process.env.TAURI_DEBUG),
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        hud: fileURLToPath(new URL("./hud.html", import.meta.url)),
        mascot: fileURLToPath(new URL("./mascot.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/test/**/*.{test,spec}.{ts,tsx,mjs}"],
    css: true,
  },
});

function gitCommitHash() {
  try {
    return (
      execSync("git rev-parse --short HEAD", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}
