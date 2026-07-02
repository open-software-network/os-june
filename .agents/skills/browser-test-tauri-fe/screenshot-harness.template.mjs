// Playwright screenshot harness TEMPLATE for a Vite/Tauri frontend.
// Copy into the target project's scripts/, adjust BASE/PAGE/STEPS, then:
//   pnpm dev                                    # serve the FE
//   node scripts/<name>.mjs [outDir]
// Exits non-zero if any step fails to render. Console/page errors are printed
// (they're where the real bugs surface) but don't fail the run by default.
//
// Requires: pnpm add -D playwright && pnpm exec playwright install chromium

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "http://127.0.0.1:1421"; // Vite dev server
const PAGE = "/app-preview.html"; // fake-IPC preview entry (or "/" for a plain web app)
const outDir = process.argv[2] ?? "screenshots";

// Each step: navigate to a surface and screenshot it.
// `action` runs in the page (clicks/eval); `ready` is proof-of-data text that
// only appears once the backend response rendered.
const STEPS = [
  {
    name: "example-surface",
    ready: "some text only present after data loads",
    action: async (page) => {
      // e.g. open a settings view via an app event, then click a nav item:
      // await page.evaluate(() => window.__APP_PREVIEW__?.openSettings());
      // await page.getByRole("button", { name: "MCP servers", exact: true }).click();
    },
  },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1180, height: 780 }, // match the app window
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}${PAGE}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#root")?.children.length > 0,
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);

  const results = [];
  for (const step of STEPS) {
    let ok = false;
    let note = "";
    try {
      if (step.action) await step.action(page);
      ok = await page
        .getByText(step.ready, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) note = `proof text "${step.ready}" not found`;
    } catch (err) {
      note = `FAILED: ${err.message}`;
    }
    await page.screenshot({ path: `${outDir}/${step.name}.png` });
    results.push({ step: step.name, ok, note });
    console.log(`${ok ? "✓" : "✗"} ${step.name}${note ? ` — ${note}` : ""}`);
  }

  await browser.close();
  console.log(`\nconsole.error (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 40)) console.log("  • " + e);
  console.log(`pageerror (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 40)) console.log("  • " + e);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nRendered ${results.length - failed.length}/${results.length}.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
