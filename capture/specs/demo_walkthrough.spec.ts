// capture/specs/demo_walkthrough.spec.ts
//
// Screen-recording-only footage for the "Kunos for Hardware, Retail &
// Warehousing" sales demo script, per the user's request 2026-08-28. No
// voiceover is recorded -- the user records that separately and edits
// these clips into their VO track themselves.
//
// This is NOT the V1 shot-library slice (that's boq_scan_to_quote.spec.ts,
// SPEC.md §10). It's a separate, client-requested capture covering four
// sections of the sales script, run via `npm run capture:demo` rather
// than the default `npm run capture`.
//
// ============================================================================
// SCRIPT ACCURACY: verified live against the real demo 2026-08-28 before
// writing this file. Per CLAUDE.md ("product accuracy outranks polish",
// "if a feature is missing, the script changes") and the user's own
// decision (asked, they chose "cut it, film only what's verified real"),
// several script sections/claims are SKIPPED here because no matching
// real screen exists. Full evidence for each is in SPEC.md's Status
// section and knowledge/pages.json; summary:
//
//   - CRM customer "birthday" and "tier" fields: no such fields exist
//     anywhere in the Company/Contact data model. The only "birthday" in
//     the whole app is an HR *staff* birthday reminder
//     (/dashboard/staff/birthday/{id}), unrelated to customers.
//   - CRM stock-check on quotation creation: the quotation create/detail
//     pages have zero mention of stock/inventory levels. No such
//     integration exists.
//   - The entire "Logistics" section: /kenderaan/* is an internal staff
//     vehicle-BOOKING workflow ("Official applications... government
//     business only", passenger cars/buses like a "Proton X70"), not a
//     delivery-management system. No driver trip-count reports, no
//     delivery-capacity planning, no route optimization of any kind, no
//     Google Maps integration anywhere in the codebase.
//   - The entire "Finance" section: no single real screen matches "snap
//     a photo/upload a PDF, Kunos pulls out the data, staff tags it,
//     submits" for invoices-to-accounting. The two closest real
//     features are structurally different: Cashbook Integration Engine
//     is a CSV *bulk import* + auto-classification tool (not photo OCR),
//     and Document Centre's OCR is for keyword/tag search over a
//     document library (not structured invoice-field extraction into a
//     ledger). Neither matches the script, and the named integrations
//     (SQL Account, AutoCount) appear nowhere in the codebase.
//   - The Kunos AI finale (AI drafts a quote from one sentence): the AI
//     assistant is real but scoped to exactly three HR actions (leave,
//     travel claims, staff leave lookups). It cannot look up a client,
//     check stock, or draft a quote.
//
// What IS filmed here, all confirmed live 2026-08-28:
//   1. Login -> Inventory Dashboard (real stock value / low-stock /
//      out-of-stock widgets -- this is what the script's "Dashboard"
//      beat actually describes, not the generic post-login /dashboard).
//   2. Inventory: manual item creation (barcode field, category,
//      Item Name) + the real Supplier Documents OCR flow (upload a
//      delivery order, Google Vision extracts it for review) --
//      structurally the same real feature the script describes, just
//      correctly attributed to Inventory rather than "Finance".
//   3. CRM: viewing the reserved company record and creating a real
//      quotation from a deal (no birthday/tier/stock-check).
//   4. HR: submitting a real leave application (no GPS check-in claim).
// ============================================================================

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { startRecording } from "../lib/recorder.ts";
import { launchCaptureBrowser, launchHeadlessSetupBrowser } from "../lib/browser.ts";
import { moveAndClick, moveToElement, typeHumanlike } from "../lib/cursor.ts";
import { assertPiiAllowlist } from "../lib/guards.ts";
import { MarkerTracker, writeSidecar } from "../lib/markers.ts";
import { ensureSupplierDeliveryDocument } from "../lib/supplierDeliveryDocument.ts";
import { loginOn, url, findOrCreateReservedCompany, createReservedDeal, RESERVED_COMPANY_NAME } from "../lib/kunosSession.ts";

const SIZE: [number, number] = [1920, 1080];
const FPS = 30;
const EXTRACTION_POLL_TIMEOUT_MS = 90_000; // real OCR + queued-job latency, seen to vary well beyond 45s under capture's CPU load
const EXTRACTION_POLL_INTERVAL_MS = 4_000;

interface SectionResult {
  id: string;
  scriptSection: string;
  outPath: string;
  duration: number;
  passed: boolean;
  tracker: MarkerTracker;
  assertions: Array<{ type: string; value?: string; passed: boolean }>;
  note?: string;
}

async function recordSection(
  id: string,
  scriptSection: string,
  run: (page: Page, tracker: MarkerTracker) => Promise<{ assertions: Array<{ type: string; value?: string; passed: boolean }> }>,
): Promise<SectionResult> {
  const outPath = join("out", "capture", "demo_walkthrough", `${id}.mp4`);
  const recording = await startRecording({ outPath, size: SIZE, fps: FPS });
  const tracker = new MarkerTracker(recording.startedAt);
  let browser: Browser | undefined;

  const SECTION_ATTEMPTS = 2; // this tenant is a known-flaky staging environment (SPEC.md) -- one retry rides out a slow/reloaded page
  let lastError: unknown;

  try {
    browser = await launchCaptureBrowser({ display: recording.display, size: SIZE });

    for (let attempt = 1; attempt <= SECTION_ATTEMPTS; attempt++) {
      const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });
      try {
        const { assertions } = await run(page, tracker);
        const passed = assertions.every((a) => a.passed);
        if (!passed) {
          console.error(`[${id}] capture-time assertions failed: ${JSON.stringify(assertions)}`);
        }
        return { id, scriptSection, outPath, duration: (Date.now() - recording.startedAt) / 1000, passed, tracker, assertions };
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${id}] attempt ${attempt}/${SECTION_ATTEMPTS} failed: ${message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return {
      id,
      scriptSection,
      outPath,
      duration: (Date.now() - recording.startedAt) / 1000,
      passed: false,
      tracker,
      assertions: [],
      note: message,
    };
  } finally {
    await browser?.close().catch(() => {});
    await recording.stop();
  }
}

// ---------------------------------------------------------------------------
// Section 1: Login & Dashboard
// ---------------------------------------------------------------------------

async function section1_loginAndDashboard(page: Page, tracker: MarkerTracker) {
  await loginOn(page);
  await tracker.record("logged_in_on_dashboard");
  await page.waitForTimeout(1_500);

  // The script's "stock value / low stock / out-of-stock" dashboard is the
  // Inventory Dashboard, not the generic post-login staff dashboard.
  await page.goto(url("/inventory"), { waitUntil: "load" });
  const statTiles = page.getByText("TOTAL STOCK VALUE", { exact: false });
  await statTiles.waitFor({ state: "visible", timeout: 10_000 });
  await tracker.record("inventory_dashboard_visible", statTiles);
  await page.waitForTimeout(4_000); // hold for VO room

  const guardOk = await guardSafely(page);
  return { assertions: [{ type: "pii_allowlist", passed: guardOk }] };
}

// ---------------------------------------------------------------------------
// Section 2: Inventory (item creation + supplier document OCR)
// ---------------------------------------------------------------------------

async function section2_inventory(page: Page, tracker: MarkerTracker) {
  const assertions: Array<{ type: string; value?: string; passed: boolean }> = [];
  const documentPath = await ensureSupplierDeliveryDocument();

  await loginOn(page);

  // -- Manual item creation (no camera in this environment for the real
  // barcode SCANNER button -- see file header; the barcode field itself
  // is real and filmable). Barcode is unique per run so the search-and-
  // open step below finds exactly this item even if the spec has been
  // run before. --
  const barcode = `VD-DEMO-${Date.now()}`;
  await page.goto(url("/inventory/items/create"), { waitUntil: "load" });
  await moveToElement(page, 'input[name="name"]').catch(() => {});
  await page.locator('input[name="name"]').click();
  await typeHumanlike(page, "Aurora Hardware Demo Widget");
  await page.locator('input[name="barcode"]').fill(barcode);
  await tracker.record("item_form_filled");

  await clickAndWaitForNavigation(page, 'button:text-is("Save")');
  await page.waitForTimeout(1_000);
  await failOnVisibleFormErrors(page, "item creation");

  // Creating an item redirects to the *list* view (/inventory/items),
  // which shows every item's Primary Supplier column as plain visible
  // text -- other real suppliers, a genuine guard violation (confirmed
  // live 2026-08-28, not a false positive like the <select> issue
  // above). Search for our own item and open its single-record detail
  // page instead of filming the shared list.
  let itemHref: string | null = null;
  for (let attempt = 0; attempt < 3 && !itemHref; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1_500);
    await page.goto(url(`/inventory/items?search=${encodeURIComponent(barcode)}`), { waitUntil: "load" });
    itemHref = await page.evaluate(
      () => document.querySelector<HTMLAnchorElement>('a[href*="/inventory/items/show/"]')?.href ?? null,
    );
  }
  if (!itemHref) throw new Error(`Could not find the created item (barcode ${barcode}) in the search results after 3 attempts`);
  await page.goto(itemHref, { waitUntil: "load" });
  await tracker.record("item_created");
  assertions.push({ type: "pii_allowlist", passed: await guardSafely(page) });

  // -- Supplier document OCR: upload a delivery order, wait for
  // extraction, land on the resulting document's own review page (never
  // the unfiltered list -- that shows other real suppliers' names). --
  await page.goto(url("/inventory/supplier-documents/create"), { waitUntil: "load" });
  await moveToElement(page, 'input[name="document"]').catch(() => {});
  await page.locator('input[name="document"]').setInputFiles(documentPath);
  await page.waitForTimeout(300);
  await tracker.record("document_selected");

  // forceEnableAndClick() kept as a safety net (see its doc comment) --
  // the actual root cause of this button seeming stuck was a tenant-wide
  // duplicate-file check rejecting a re-upload of the same bytes, fixed
  // by making ensureSupplierDeliveryDocument() render a fresh file every
  // call rather than reusing a cached one.
  await forceEnableAndClick(page, 'button:text-is("Upload & Extract")');
  await failOnVisibleFormErrors(page, "supplier document upload");

  const extraction = await tracker.deadZone(() =>
    waitForUrlMatching(page, /\/supplier-documents\/\d+\/review/, EXTRACTION_POLL_TIMEOUT_MS, EXTRACTION_POLL_INTERVAL_MS),
  );
  assertions.push({ type: "supplier_document_extracted", passed: extraction });
  if (!extraction) console.log(`[inventory] extraction poll timed out, url still ${page.url()}`);
  if (extraction) {
    await tracker.record("supplier_document_review_visible");
    assertions.push({ type: "pii_allowlist", passed: await guardSafely(page) });
  }

  return { assertions };
}

// ---------------------------------------------------------------------------
// Section 3: CRM (view company, create a quotation)
// ---------------------------------------------------------------------------

async function section3_crm(page: Page, tracker: MarkerTracker) {
  const assertions: Array<{ type: string; value?: string; passed: boolean }> = [];

  await loginOn(page);

  const { companyId, dealId } = await getOrCreateDemoWalkthroughDeal(page);

  // Direct to the single reserved company record -- never the unfiltered
  // /crm/companies index, which shows other real prospects' names.
  await page.goto(url(`/crm/companies/${companyId}`), { waitUntil: "load" });
  await tracker.record("company_viewed");
  assertions.push({ type: "pii_allowlist", passed: await guardSafely(page) });

  await page.goto(url("/crm/quotations/create"), { waitUntil: "load" });
  await page.locator('select[name="deal_id"]').selectOption(dealId);
  await page.waitForTimeout(300);
  const today = new Date();
  const validUntil = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  await page.locator('input[name="quotation_date"]').fill(isoDate(today));
  await page.locator('input[name="valid_until"]').fill(isoDate(validUntil));
  await tracker.record("quotation_form_filled");

  await clickAndWaitForNavigation(page, 'button:text-is("Save Draft")');
  await page.waitForTimeout(1_000);
  await failOnVisibleFormErrors(page, "quotation creation");
  await tracker.record("quotation_created");
  assertions.push({ type: "pii_allowlist", passed: await guardSafely(page) });

  // Best-effort: show the "Add Item" affordance. Not fatal if this
  // specific interaction doesn't behave as expected -- the quotation
  // itself is the confirmed-real part of this section.
  await page
    .getByRole("button", { name: "Add Item", exact: true })
    .first()
    .click({ timeout: 5_000 })
    .then(() => tracker.record("add_item_opened"))
    .catch(() => console.error("[crm] 'Add Item' interaction did not complete -- quotation itself still recorded"));
  await page.waitForTimeout(1_500);

  return { assertions };
}

// ---------------------------------------------------------------------------
// Section 4: HR (leave application)
// ---------------------------------------------------------------------------

async function section4_hr(page: Page, tracker: MarkerTracker) {
  await loginOn(page);

  await page.goto(url("/leave/applied-list"), { waitUntil: "load" });
  await moveToElement(page, 'a:text-is("New Application")').catch(() => {});
  await page.goto(url("/leave/create"), { waitUntil: "load" });
  await tracker.record("leave_form_opened");

  await page.locator('select[name="jenis-cuti"]').selectOption({ label: "Annual Leave" });

  // The date field is a flatpickr *range* picker even for a single day --
  // it stays open, blocking the rest of the form, until a range is
  // completed. Clicking the same day twice selects a one-day "range" and
  // closes it (confirmed live 2026-08-28).
  //
  // Hardcoded rather than computed from "today": the form requires >=7
  // days' notice and rejects public holidays/weekends (both confirmed
  // live), and "September 14, 2026" is a specific date already verified
  // to satisfy both against this tenant's real leave calendar. A
  // date-math version would need to also fetch and check the holiday
  // list this form itself loads (see the console log noting
  // "Initial Public Holidays" on page load) -- worth doing if this spec
  // is still in use well past that date.
  const LEAVE_DAY_ARIA_LABEL = "September 14, 2026";
  await page.locator('input[name="tarikh-cuti"]').click();
  const dayCell = page.locator(`.flatpickr-day[aria-label="${LEAVE_DAY_ARIA_LABEL}"]`);
  await dayCell.click();
  await dayCell.click();
  await tracker.record("leave_date_selected");

  // Duration Type is one of this app's "bos-select-custom" widgets --
  // selectOption() on the underlying native <select> doesn't update the
  // component's own state, which failed real-submission validation
  // (confirmed live 2026-08-28: "bos-select--error" on this exact
  // field). Drive the real custom dropdown UI instead.
  await selectCustomOption(page, page.getByRole("button", { name: "Select Duration Type", exact: true }), "Full Day");

  await page.locator('textarea[name="sebab"]').click();
  await typeHumanlike(page, "Personal errands.");
  await tracker.record("leave_form_filled");

  // See forceEnableAndClick()'s doc comment.
  const leaveNavPromise = page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null);
  await forceEnableAndClick(page, 'button:text-is("Submit")');
  await leaveNavPromise;
  await page.waitForTimeout(1_500);
  await failOnVisibleFormErrors(page, "leave application submission");
  await tracker.record("leave_submitted");

  // Only ever shows the logged-in staff member's own applications -- no
  // other-person PII risk here, but check anyway for consistency.
  const guardOk = await guardSafely(page);
  return { assertions: [{ type: "pii_allowlist", passed: guardOk }] };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * moveAndClick() a submit button that's expected to trigger a navigation,
 * arming the navigation wait *before* clicking rather than after.
 *
 * These forms don't navigate synchronously on click -- there's an async
 * pre-processing step (validation/fetch) before the real redirect
 * happens, confirmed live 2026-08-28 (immediately after the click,
 * page.url() was still the create page; the record existed moments
 * later). waitForLoadState() called *after* the click can resolve
 * immediately against the pre-click page (no navigation in flight yet)
 * instead of waiting for the one that hasn't started, which then races
 * page.evaluate() calls against the real navigation when it does happen.
 * Arming waitForNavigation() first avoids the race regardless of the
 * delay.
 */
async function clickAndWaitForNavigation(page: Page, selector: string): Promise<void> {
  const navPromise = page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null);
  await moveAndClick(page, selector);
  await navPromise;
}

/**
 * Click a submit button that this app leaves natively `disabled` until
 * some client-side readiness check flips it -- confirmed live
 * 2026-08-28 on two unrelated forms (Supplier Documents' "Upload &
 * Extract", HR's "Submit") to sometimes never flip within any
 * reasonable wait *specifically* under headed/Xvfb automation, despite
 * headless runs against the identical filled-in form enabling it
 * quickly and the real submission succeeding once clicked. The button
 * itself, not the data, is what's unreliable here: this clears the
 * `disabled` attribute directly before clicking, then relies on
 * failOnVisibleFormErrors() (call it right after) to catch a genuine
 * validation problem the same way a real click would have surfaced one.
 */
async function forceEnableAndClick(page: Page, selector: string): Promise<void> {
  await moveToElement(page, selector).catch(() => {});
  await page.locator(selector).evaluate((el) => {
    (el as HTMLButtonElement).disabled = false;
  });
  await page.locator(selector).click();
}

async function failOnVisibleFormErrors(page: Page, context: string): Promise<void> {
  const errors = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".is-invalid, .invalid-feedback, .bos-select--error"))
      .map((el) => el.textContent?.trim())
      .filter((t): t is string => Boolean(t)),
  );
  if (errors.length > 0) {
    throw new Error(`${context}: form reported validation errors: ${JSON.stringify(errors)}`);
  }
}

async function guardSafely(page: Page): Promise<boolean> {
  try {
    await assertPiiAllowlist(page);
    return true;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Drive one of this app's "bos-select-custom" dropdowns via its real UI
 * (click the trigger, click the option) rather than the hidden native
 * <select> underneath it. Needed because at least one of these widgets
 * (HR's Duration Type) keeps its own JS state that Playwright's
 * selectOption() on the native element doesn't update, which the real
 * form validation then rejects (confirmed live 2026-08-28).
 */
async function selectCustomOption(page: Page, trigger: Locator, optionText: string): Promise<void> {
  await trigger.click();
  const menuId = await trigger.getAttribute("aria-controls");
  if (!menuId) throw new Error(`selectCustomOption: trigger has no aria-controls (looking for "${optionText}")`);
  await page.locator(`#${menuId}`).getByText(optionText, { exact: true }).click();
}

/**
 * Poll until the page's URL matches `pattern`, or timeout.
 *
 * Deliberately not "wait until the URL differs from X" -- confirmed live
 * 2026-08-28, when extraction finished fast (dedup fixed, no longer
 * blocked on a stale duplicate), the navigation to .../review had
 * already happened by the time this function was even called, so
 * "differs from whatever page.url() is *now*" was already true-turned-
 * false: capturing "now" as the baseline after the target state was
 * already reached made the poll wait for a *second* change that was
 * never coming. Matching an explicit target pattern has no such
 * ordering dependency.
 */
async function waitForUrlMatching(page: Page, pattern: RegExp, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(page.url())) return true;
    await page.waitForTimeout(intervalMs);
  }
  return pattern.test(page.url());
}

/**
 * A single, clean reserved Deal for this walkthrough (not one of the
 * "(attempt N)" deals left over from boq_scan_to_quote.spec.ts runs).
 * Headless, not filmed -- reused across sections via a fresh lookup each
 * time rather than passed state, since each section gets its own browser.
 */
async function getOrCreateDemoWalkthroughDeal(page: Page): Promise<{ companyId: string; dealId: string }> {
  const companyId = await findOrCreateReservedCompany(page);
  const existingLabel = "Aurora Hardware — Warehouse Racking Project";

  await page.goto(url("/crm/quotations/create"), { waitUntil: "load" });
  const existingDealId = await page.evaluate((label) => {
    const opt = Array.from(document.querySelectorAll<HTMLOptionElement>('select[name="deal_id"] option')).find((o) =>
      o.textContent?.includes(label),
    );
    return opt?.value ?? null;
  }, existingLabel);
  if (existingDealId) return { companyId, dealId: existingDealId };

  const dealId = await createReservedDeal(page, companyId, existingLabel);
  return { companyId, dealId };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(join("out", "capture", "demo_walkthrough"), { recursive: true });

  const sections: Array<[string, string, Parameters<typeof recordSection>[2]]> = [
    ["01_login_dashboard", "00:00-01:00 Introduction & Industry Pain Points / Login & Dashboard", section1_loginAndDashboard],
    ["02_inventory", "01:45-03:15 Inventory Module", section2_inventory],
    ["03_crm", "04:30-06:00 CRM & Sales", section3_crm],
    ["04_hr", "06:00-07:15 HR & Staff Management", section4_hr],
  ];

  const results: SectionResult[] = [];
  for (const [id, scriptSection, run] of sections) {
    console.log(`\n=== Recording ${id}: ${scriptSection} ===`);
    results.push(await recordSection(id, scriptSection, run));
  }

  const finalDir = join("library", "ui", "demo_walkthrough");
  await mkdir(finalDir, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const manifest: Array<Record<string, unknown>> = [];

  for (const result of results) {
    if (!result.passed) {
      console.error(`\n${result.id}: NOT saved to ${finalDir} (assertions failed or errored: ${result.note ?? "see log above"})`);
      continue;
    }
    const finalVideoName = `${dateStamp}_${result.id}.mp4`;
    const finalSidecarName = `${dateStamp}_${result.id}.json`;
    await rename(result.outPath, join(finalDir, finalVideoName));
    // The sidecar's markers give real per-beat timestamps within this
    // clip -- useful for lining up voiceover precisely, even though this
    // isn't a full shot-library entry (no dead_zones/best-of-3 here).
    await writeSidecar(join(finalDir, finalSidecarName), result.tracker, {
      shot_id: result.id,
      ui_version: "kunos-demo-live",
      viewport: SIZE,
      fps: FPS,
      duration: result.duration,
      fixtures: { customer: RESERVED_COMPANY_NAME },
      assertions: result.assertions,
    });
    manifest.push({
      file: finalVideoName,
      sidecar: finalSidecarName,
      script_section: result.scriptSection,
      duration_seconds: Math.round(result.duration * 10) / 10,
    });
    console.log(`\n${result.id}: wrote ${join(finalDir, finalVideoName)} (${result.duration.toFixed(1)}s)`);
  }

  await writeFile(join(finalDir, `${dateStamp}_manifest.json`), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`\nWrote manifest: ${join(finalDir, `${dateStamp}_manifest.json`)}`);

  if (manifest.length < results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
