// Drives the dev-only admin-preview.html (a fake-IPC harness that boots the real
// app shell in a plain browser) through each ported Hermes admin surface and
// screenshots it. Captures console / page errors so UI regressions surface.
//
//   pnpm dev                                  # serve the FE on 127.0.0.1:1421
//   node scripts/admin-preview-screenshots.mjs [outDir] [theme]
//
// Exits non-zero if a surface never rendered. Console/page errors are printed
// but don't fail the run (some are benign in the fake-IPC harness); inspect them.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "http://127.0.0.1:1421";
const outDir = process.argv[2] ?? "screenshots/admin";
const theme = process.argv[3] ?? "light";

// label: settings nav-item accessible name; ready: text that proves the
// surface loaded its data from the fake Hermes server.
const SURFACES = [
  { id: "mcp", label: "MCP servers", ready: "filesystem" },
  { id: "skills-hub", label: "Skills hub", ready: "Data science" },
  { id: "toolsets", label: "Toolsets", ready: "Web search and fetch" },
  { id: "skills", label: "Installed skills", ready: "Multi-source research" },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1180, height: 780 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const results = [];

  await page.goto(`${BASE}/admin-preview.html?theme=${theme}`, {
    waitUntil: "domcontentloaded",
  });

  // Wait for React to mount the shell.
  await page.waitForFunction(
    () => document.querySelector("#root")?.children.length > 0,
    { timeout: 15000 },
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/00-shell.png` });

  // Open Settings via the menu event the app listens for. The listener is
  // registered in a mount effect, so retry until the settings nav appears.
  const navGeneral = page.getByRole("button", { name: "General", exact: true });
  let opened = false;
  for (let i = 0; i < 8 && !opened; i++) {
    await page.evaluate(() => window.__ADMIN_PREVIEW__?.openSettings());
    opened = await navGeneral
      .waitFor({ state: "visible", timeout: 1500 })
      .then(() => true)
      .catch(() => false);
  }
  if (!opened) throw new Error("Settings nav never appeared");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/01-settings-open.png` });

  for (const surface of SURFACES) {
    // The section nav renders as a sidebar of buttons, not a tablist.
    const navItem = page.getByRole("button", {
      name: surface.label,
      exact: true,
    });
    let rendered = false;
    let note = "";
    try {
      await navItem.click();
      // Wait for the proof-of-data text the fake Hermes server returns.
      const ready = await page
        .getByText(surface.ready, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!ready) {
        note = `data text "${surface.ready}" not found`;
        await page.waitForTimeout(1000);
      }
      rendered = true;
    } catch (err) {
      note = `FAILED: ${err.message}`;
    }
    const file = `${outDir}/${surface.id}.png`;
    await page.screenshot({ path: file });
    results.push({ surface: surface.label, rendered, note, file });
    console.log(
      `${rendered ? "✓" : "✗"} ${surface.label}${note ? ` — ${note}` : ""}`,
    );
  }

  await browser.close();

  console.log("\n=== console.error (" + consoleErrors.length + ") ===");
  for (const e of consoleErrors.slice(0, 40)) console.log("  • " + e);
  console.log("\n=== pageerror (" + pageErrors.length + ") ===");
  for (const e of pageErrors.slice(0, 40)) console.log("  • " + e);

  const failed = results.filter((r) => !r.rendered);
  console.log(
    `\nRendered ${results.length - failed.length}/${results.length} surfaces.`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
