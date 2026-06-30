// Records a watchable walkthrough of the Hermes admin surfaces by driving the
// dev-only admin-preview.html (fake-IPC harness) with deliberate pauses, then
// converts the Playwright .webm to an embeddable .gif via ffmpeg.
//
//   pnpm dev                                         # serve the FE on :1421
//   node scripts/admin-preview-walkthrough.mjs [outDir]
//
// Output: <outDir>/admin-walkthrough.webm + admin-walkthrough.gif

import { chromium } from "playwright";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const BASE = "http://127.0.0.1:1421";
const outDir = process.argv[2] ?? "screenshots/admin";
const SIZE = { width: 1180, height: 780 };
const pause = (page, ms) => page.waitForTimeout(ms);

const TOUR = [
  { label: "MCP servers", ready: "filesystem" },
  { label: "Skills hub", ready: "Data science" },
  { label: "Toolsets", ready: "Web search and fetch" },
  { label: "Installed skills", ready: "Multi-source research" },
];

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
  });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: outDir, size: SIZE },
  });
  const page = await context.newPage();

  await page.goto(`${BASE}/admin-preview.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#root")?.children.length > 0,
    { timeout: 15000 },
  );
  await pause(page, 1500); // linger on the home shell

  // Open Settings (retry: the listener registers in a mount effect).
  const general = page.getByRole("button", { name: "General", exact: true });
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.__ADMIN_PREVIEW__?.openSettings());
    if (await general.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) break;
  }
  await pause(page, 1200);

  for (const stop of TOUR) {
    await page.getByRole("button", { name: stop.label, exact: true }).click();
    await page
      .getByText(stop.ready, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .catch(() => {});
    await pause(page, 1800); // hold so the surface is readable in the video
  }

  // A small interaction so the tour shows the UI is live, not static.
  await page.getByRole("button", { name: "Skills hub", exact: true }).click();
  await pause(page, 800);
  const official = page.getByText("Official", { exact: false }).first();
  if (await official.isVisible().catch(() => false)) {
    await official.click().catch(() => {});
    await pause(page, 1500);
  }

  await context.close(); // finalizes the .webm
  await browser.close();

  // Playwright names videos with a random hash; rename to a stable name.
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".webm"));
  const webm = join(outDir, "admin-walkthrough.webm");
  if (files.length) await rename(join(outDir, files[0]), webm);

  // webm -> gif (two-pass palette for quality; scaled + 12fps to keep size
  // sane). Trim the blank pre-mount lead-in so the GIF's poster frame is real UI.
  const gif = join(outDir, "admin-walkthrough.gif");
  const palette = join(outDir, "_palette.png");
  const TRIM = "1.3"; // seconds of blank page-load to skip
  const vf = "fps=12,scale=1000:-1:flags=lanczos";
  await ffmpeg(["-y", "-ss", TRIM, "-i", webm, "-vf", `${vf},palettegen`, palette]);
  await ffmpeg(["-y", "-ss", TRIM, "-i", webm, "-i", palette, "-lavfi", `${vf} [x]; [x][1:v] paletteuse`, gif]);
  await rm(palette, { force: true });

  console.log(`walkthrough: ${webm}\n             ${gif}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
