// Quick smoke: load the preview, surface console errors, screenshot.
import { chromium } from "playwright";

const OUT = process.env.OUT_DIR ?? "preview/out";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
  if (msg.text().startsWith("[preview]")) console.log(msg.text());
});
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://127.0.0.1:14251/preview/agent.html");
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/smoke.png` });
console.log("body text sample:", (await page.textContent("body"))?.slice(0, 300));
console.log("errors:", errors.length ? errors.slice(0, 8) : "none");
await browser.close();
process.exit(0);
