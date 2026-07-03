// Playwright walkthrough RECORDER template: drives a Vite/Tauri-preview FE with
// deliberate pauses, records video, and converts to an embeddable GIF via ffmpeg.
// Copy into the target project's scripts/, adjust BASE/PAGE/TOUR, then:
//   pnpm dev
//   node scripts/<name>.mjs [outDir]
// Output: <outDir>/walkthrough.webm + walkthrough.gif
//
// Requires: pnpm add -D playwright && pnpm exec playwright install chromium; ffmpeg on PATH.

import { chromium } from "playwright";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const BASE = "http://127.0.0.1:1421";
const PAGE = "/app-preview.html"; // fake-IPC preview entry, or "/" for a plain web app
const outDir = process.argv[2] ?? "screenshots";
const SIZE = { width: 1180, height: 780 };
const TRIM = "1.3"; // seconds of blank page-load to skip so the GIF poster is real UI
const FPS = 12;
const WIDTH = 1000; // GIF width; drop this (and FPS) if the file is too big

// Each stop: an action to perform, then how long to hold so it's readable.
const TOUR = [
  {
    holdMs: 1800,
    action: async (page) => {
      // await page.evaluate(() => window.__APP_PREVIEW__?.openSettings());
      // await page.getByRole("button", { name: "MCP servers", exact: true }).click();
    },
  },
];

const ff = (args) =>
  new Promise((res, rej) => {
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    p.on("error", rej);
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`))));
  });

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: outDir, size: SIZE },
  });
  const page = await context.newPage();

  await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#root")?.children.length > 0,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1500);

  for (const stop of TOUR) {
    if (stop.action) await stop.action(page);
    await page.waitForTimeout(stop.holdMs ?? 1500);
  }

  await context.close(); // finalizes the .webm
  await browser.close();

  const webms = (await readdir(outDir)).filter((f) => f.endsWith(".webm"));
  const webm = join(outDir, "walkthrough.webm");
  if (webms.length) await rename(join(outDir, webms[0]), webm);

  const gif = join(outDir, "walkthrough.gif");
  const pal = join(outDir, "_pal.png");
  const vf = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
  await ff(["-y", "-ss", TRIM, "-i", webm, "-vf", `${vf},palettegen`, pal]);
  await ff(["-y", "-ss", TRIM, "-i", webm, "-i", pal, "-lavfi", `${vf} [x]; [x][1:v] paletteuse`, gif]);
  await rm(pal, { force: true });
  console.log(`${webm}\n${gif}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
