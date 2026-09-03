// One-off: render the BOQ source document HTML to a PNG fixture, saved
// under fixtures/documents/ for capture specs to upload during the
// boq_scan_to_quote shot. Not part of the runtime pipeline.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, "../../fixtures/documents/warehouse-racking-boq-source.html");
const outPath = join(__dirname, "../../fixtures/documents/warehouse-racking-boq-source.png");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
await page.screenshot({ path: outPath, fullPage: true });
await browser.close();
console.log("Rendered", outPath);
