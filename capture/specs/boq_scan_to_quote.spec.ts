// capture/specs/boq_scan_to_quote.spec.ts
//
// V1 capture shot, per SPEC.md Status section and section 6.6.
//
// Flow: log in -> create a deal for the reserved-namespace customer ->
// create a BOQ under it -> upload a site-visit document -> OCR extracts
// line items (dead zone) -> review/import the extracted rows -> convert
// the BOQ into a quotation. Every step runs against the real Kunos demo
// UI -- no fixture/mocked data, no invented UI. Reserved namespace per
// SPEC.md section 6.3: customer "Aurora Hardware Sdn Bhd", SKUs
// prefixed "VD-".

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startRecording } from "../lib/recorder.ts";
import { launchCaptureBrowser } from "../lib/browser.ts";
import { moveAndClick, moveToElement, typeHumanlike } from "../lib/cursor.ts";
import { MarkerTracker, writeSidecar } from "../lib/markers.ts";
import { assertPiiAllowlist } from "../lib/guards.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE: [number, number] = [1920, 1080];
const FPS = 30;
const SHOT_ID = "boq_scan_to_quote";
const OUT_DIR = `library/ui/${SHOT_ID}`;
const RUN_STAMP = new Date().toISOString().slice(0, 10);
const DEMO_URL = process.env.KUNOS_DEMO_URL!;
const CUSTOMER_NAME = "Aurora Hardware Sdn Bhd";
const SOURCE_DOCUMENT = join(__dirname, "../../fixtures/documents/warehouse-racking-boq-source.png");

// Generic submit-button selectors are not reliable in this app: the
// persistent header has its own type="submit" buttons (a notifications
// panel: "Mark all as read", per-notification items), and the shared
// "im-btn-primary" CTA styling class is reused by unrelated elements
// elsewhere on the page too -- both sit earlier in the DOM than a given
// page's real form button, so a bare `button[type="submit"]` or
// `button.im-btn-primary` selector's .first() silently grabs the wrong
// element (confirmed by hand: the click "succeeds" with no error, but
// nothing is submitted). Scoping to the specific `<form>` that contains
// the field we just filled, and matching the button's exact visible
// text, is what actually reaches the real button every time.
function submitButtonIn(formHasField: string, buttonText: string): string {
  return `form:has(${formHasField}) button:has-text("${buttonText}")`;
}

async function main() {
  if (!process.env.KUNOS_DEMO_URL || !process.env.KUNOS_DEMO_EMAIL || !process.env.KUNOS_DEMO_PASSWORD) {
    throw new Error("KUNOS_DEMO_URL, KUNOS_DEMO_EMAIL, KUNOS_DEMO_PASSWORD must be set in the environment.");
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = `${OUT_DIR}/${RUN_STAMP}.mp4`;

  console.log("Starting recorder...");
  const recording = await startRecording({ outPath, size: SIZE, fps: FPS });
  const tracker = new MarkerTracker(recording.startedAt);

  const assertions: Array<{ type: string; value?: string; passed: boolean }> = [];
  let dealTitle = "";
  let quotationUrl = "";

  try {
    const browser = await launchCaptureBrowser({ display: recording.display, size: SIZE });
    try {
      const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });

      // --- Login ---
      await page.goto(`${DEMO_URL}/login`, { waitUntil: "load" });
      await moveAndClick(page, 'input[type="email"]');
      await typeHumanlike(page, process.env.KUNOS_DEMO_EMAIL!);
      await moveAndClick(page, 'input[type="password"]');
      await typeHumanlike(page, process.env.KUNOS_DEMO_PASSWORD!);
      await tracker.record("login_form_filled");
      await moveAndClick(page, 'button[type="submit"], button:has-text("Sign In")');
      await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
      await page.waitForLoadState("load");
      await tracker.record("dashboard_loaded");
      assertions.push({ type: "url_contains", value: "/dashboard", passed: page.url().includes("/dashboard") });
      await assertPiiAllowlist(page);

      // --- Create a deal for the reserved-namespace customer ---
      dealTitle = `VD Warehouse Racking BOQ ${Date.now()}`;
      await page.goto(`${DEMO_URL}/crm/deals/create`, { waitUntil: "load" });
      await page.locator('select[name="company_id"]').selectOption({ label: CUSTOMER_NAME });
      await moveAndClick(page, 'input[name="title"]');
      await typeHumanlike(page, dealTitle);
      // Pipeline/stage: let the page's own JS populate stage options for
      // whichever pipeline is already selected by default, then just pick
      // the first real (non-placeholder) stage option rather than assuming
      // a specific one exists.
      const stageSelect = page.locator('select[name="stage_id"]');
      await page.waitForTimeout(500); // let dependent-select JS settle
      const stageOptions = await stageSelect.locator("option").all();
      if (stageOptions.length > 1) {
        const firstRealValue = await stageOptions[1].getAttribute("value");
        if (firstRealValue) await stageSelect.selectOption(firstRealValue);
      }
      // BOQ is a per-deal feature toggle, off by default -- creating a
      // BOQ against a deal without this checked fails server-side with a
      // "BOQ is not enabled for this Deal" modal error, not a form
      // validation error (took real debugging to find, since the POST
      // itself returns a normal-looking 302).
      await page.locator('input[name="boq_enabled"]').check();
      await tracker.record("deal_form_filled");
      await moveAndClick(page, submitButtonIn('input[name="title"]', "Save Deal"));
      try {
        await page.waitForURL(/\/crm\/deals\/\d+/, { timeout: 15_000 });
      } catch {
        const errorText = await page.locator(".invalid-feedback, .error, [role='alert']").allInnerTexts();
        throw new Error(
          `Deal form did not navigate away from /crm/deals/create -- likely a validation failure. ` +
            `Visible errors: ${JSON.stringify(errorText)}`,
        );
      }
      await page.waitForLoadState("load");
      await tracker.record("deal_created", page.locator("h1, h2").first());
      assertions.push({ type: "text_visible", value: dealTitle, passed: (await page.locator("body").innerText()).includes(dealTitle) });
      await assertPiiAllowlist(page);

      const dealUrl = page.url();
      const dealId = dealUrl.match(/deals\/(\d+)/)?.[1];
      if (!dealId) throw new Error(`Could not extract deal id from URL: ${dealUrl}`);

      // --- Create a BOQ under the company + deal ---
      await page.goto(`${DEMO_URL}/crm/boqs/create`, { waitUntil: "load" });
      await page.locator('select[name="company_id"]').selectOption({ label: CUSTOMER_NAME });
      await page.waitForTimeout(500);
      const opportunitySelect = page.locator('select[name="opportunity_id"]');
      const matchingOption = await opportunitySelect
        .locator("option", { hasText: dealTitle })
        .first()
        .getAttribute("value")
        .catch(() => null);
      await opportunitySelect.selectOption(matchingOption ?? dealId);
      const boqTitle = `Warehouse Racking BOQ ${Date.now()}`;
      await moveAndClick(page, 'input[name="title"]');
      await typeHumanlike(page, boqTitle);
      await tracker.record("boq_form_filled");
      await moveAndClick(page, submitButtonIn('input[name="title"]', "Save Draft"));

      // The BOQ form does not redirect to the new BOQ's own page (it
      // redirects to the deal page), so find the BOQ by searching the
      // index for our unique title rather than trusting the post-submit
      // URL. This also naturally confirms the save actually happened,
      // since a search with 0 results means the button click above
      // hit the wrong element or the form silently failed.
      await page.waitForLoadState("load");
      await page.goto(`${DEMO_URL}/crm/boqs?search=${encodeURIComponent(boqTitle)}`, { waitUntil: "load" });
      const boqHref = await page
        .locator("table tbody tr")
        .filter({ hasText: boqTitle })
        .first()
        .locator('a[href*="/crm/boqs/"]')
        .first()
        .getAttribute("href")
        .catch(() => null);
      if (!boqHref) throw new Error(`Could not find the created BOQ ("${boqTitle}") in the index after saving.`);
      await page.goto(boqHref, { waitUntil: "load" });
      await tracker.record("boq_created");
      await assertPiiAllowlist(page);

      const boqUrl = page.url();
      const boqId = boqUrl.match(/boqs\/(\d+)/)?.[1];
      if (!boqId) throw new Error(`Could not extract BOQ id from URL: ${boqUrl}`);

      // --- Upload the site-visit document for OCR scanning ---
      // This page has three separate hidden file inputs (take photo /
      // upload image / upload PDF), each wired to its own 'change'
      // listener that enables the (initially disabled) submit button --
      // #boqScanUploadImageInput is the one matching our PNG fixture.
      await page.goto(`${DEMO_URL}/crm/boqs/${boqId}/scan`, { waitUntil: "load" });
      await tracker.record("scan_upload_page_opened");
      await page.locator("#boqScanUploadImageInput").setInputFiles(SOURCE_DOCUMENT);
      await tracker.record("document_selected");
      await moveAndClick(page, "#boqScanSubmit");

      // OCR processing is the real dead zone -- nothing visibly changes
      // until it completes and redirects to the review page.
      await tracker.deadZone(async () => {
        await page.waitForURL(/\/scans\/\d+\/review/, { timeout: 60_000 });
      });
      await tracker.record("ocr_review_page_loaded");
      await assertPiiAllowlist(page);

      const rowCount = await page.locator("table tbody tr").count();
      assertions.push({ type: "ocr_rows_extracted", value: String(rowCount), passed: rowCount > 0 });

      // --- Import the reviewed rows into the BOQ ---
      // This button is JS-driven (an AJAX POST, not a real form submit)
      // that navigates via window.location.href on success.
      await moveAndClick(page, "#boqScanImportBtn");
      await page.waitForURL(/\/crm\/boqs\/\d+$/, { timeout: 20_000 });
      await tracker.record("rows_imported");
      await assertPiiAllowlist(page);

      // --- Convert the BOQ into a quotation ---
      // The button has no id, just shared "im-btn-primary" styling with
      // no distinguishing text guaranteed unique on this page -- but it's
      // the only button inside a <form action=".../quotation">, so scope
      // to that instead of trusting the button alone.
      await page.goto(`${DEMO_URL}/crm/boqs/${boqId}`, { waitUntil: "load" });
      await moveAndClick(page, 'form[action*="/quotation"] button');
      await page.waitForURL(/\/crm\/quotations\/\d+/, { timeout: 20_000 });
      await tracker.record("quotation_created", page.locator("h1, h2").first());
      quotationUrl = page.url();
      assertions.push({ type: "url_contains", value: "/quotations/", passed: quotationUrl.includes("/quotations/") });
      await assertPiiAllowlist(page);

      await page.waitForTimeout(1500);
    } finally {
      await browser.close();
    }
  } finally {
    const result = await recording.stop();
    await writeSidecar(`${OUT_DIR}/${RUN_STAMP}.json`, tracker, {
      shot_id: SHOT_ID,
      ui_version: `kunos-${RUN_STAMP}`,
      viewport: SIZE,
      fps: FPS,
      duration: (result.stoppedAt - result.startedAt) / 1000,
      fixtures: { customer: CUSTOMER_NAME, deal_title: dealTitle, sku_prefix: "VD-" },
      assertions,
    });
    console.log(`Done. ${result.outPath}`);
    console.log(`Quotation URL: ${quotationUrl || "(not reached)"}`);
    console.log("Assertions:", JSON.stringify(assertions, null, 2));
  }
}

main().catch((err) => {
  console.error("CAPTURE FAILED:", err);
  process.exit(1);
});
