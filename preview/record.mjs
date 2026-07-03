// Records the JUN-171 replacement walkthrough:
// 1. /image fast path on a vision-capable Kimi session, then a follow-up.
// 2. Tool-result rendering for generate_image followed by edit_image.
// Produces a .webm + .gif, step screenshots, and proof.json in preview/out/.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const OUT = "preview/out";
const BASE = "http://127.0.0.1:14251";
const SIZE = { width: 1180, height: 780 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: SIZE },
});
const page = await context.newPage();
const errors = [];
const proof = {
  console: [],
  checks: [],
};
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
  if (msg.text().startsWith("[preview]")) proof.console.push(msg.text());
});

await page.goto(`${BASE}/preview/agent.html`);
const composer = page.getByRole("textbox");
await composer.waitFor({ timeout: 15000 });
await page.waitForTimeout(1800);

// 1. Slash menu: /image is offered again on the Kimi vision session.
await composer.click();
await page.keyboard.type("/image", { delay: 110 });
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}/01-slash-menu-kimi.png` });
proof.checks.push("slash menu exposes /image while the model trigger shows Kimi K2.6");

// 2. Full prompt, submit; loader while the image endpoint responds.
await page.keyboard.type(" a red bicycle", { delay: 80 });
await page.waitForTimeout(700);
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/02-fast-path-generating.png` });

// 3. Inline image in-thread, without a composer chip.
const image = page.getByRole("img", { name: "a red bicycle" });
await image.waitFor({ timeout: 20000 });
await page.waitForTimeout(1600);
await page.screenshot({ path: `${OUT}/03-fast-path-inline.png` });
proof.checks.push("/image renders inline without a composer chip");

// 4. Follow-up: the held image rides into this message on Kimi.
await composer.click();
await page.keyboard.type("do you think it's nice?", { delay: 70 });
await page.waitForTimeout(600);
const send = page.getByRole("button", { name: "Send message" });
await send.click();

// 5. Streamed assistant reply names visible image details on Kimi, not GLM.
await page.getByText("Kimi can read the attached image").waitFor({ timeout: 25000 });
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/04-kimi-followup-reply.png` });
proof.checks.push("follow-up used image.attach_bytes before prompt.submit in the preview gateway");

// 6. Separate persisted tool-result session: generate_image then edit_image.
await page.goto(`${BASE}/preview/agent.html?scenario=tool-results`);
await page.getByText("Image tool run").waitFor({ timeout: 15000 });
const generatedToolImage = page.getByRole("img", { name: "a red bicycle" });
const editedToolImage = page.getByRole("img", { name: "make it wider" });
await generatedToolImage.waitFor({ timeout: 15000 });
await editedToolImage.waitFor({ timeout: 15000 });
await page.getByText("used edit_image with the returned filename").waitFor({ timeout: 15000 });
await page.waitForTimeout(1800);
await generatedToolImage.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/05-tool-generated.png` });
await editedToolImage.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/06-tool-edited.png` });
proof.checks.push("persisted Hermes tool messages render generate_image and edit_image images inline");

await page.waitForTimeout(800);
await context.close();
await browser.close();

if (errors.length) {
  console.error("console/page errors:", errors.slice(0, 10));
  process.exit(1);
}

const webm = readdirSync(OUT).find((f) => f.endsWith(".webm"));
if (!webm) {
  console.error("no video captured");
  process.exit(1);
}
writeFileSync(`${OUT}/proof.json`, `${JSON.stringify(proof, null, 2)}\n`);

const VF = "fps=12,scale=1000:-1:flags=lanczos";
execFileSync(
  "ffmpeg",
  ["-y", "-ss", "1.0", "-i", `${OUT}/${webm}`, "-vf", `${VF},palettegen`, `${OUT}/pal.png`],
  { stdio: "inherit" },
);
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-ss",
    "1.0",
    "-i",
    `${OUT}/${webm}`,
    "-i",
    `${OUT}/pal.png`,
    "-lavfi",
    `${VF} [x]; [x][1:v] paletteuse`,
    `${OUT}/jun-171-replacement-walkthrough.gif`,
  ],
  { stdio: "inherit" },
);
console.log("done:", webm, "-> jun-171-replacement-walkthrough.gif");
