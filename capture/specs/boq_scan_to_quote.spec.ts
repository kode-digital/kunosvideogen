// capture/specs/boq_scan_to_quote.spec.ts
//
// V1 target shot (SPEC.md §10, §6.6): a real site-visit document is
// uploaded to a BOQ, Google Vision OCR extracts line items, the reviewer
// confirms them, and the confirmed BOQ becomes a CRM quotation.
//
// This is an interaction flow, not a read-only screen (SPEC.md §6.3): we
// do NOT intercept API responses here. Instead we create real records
// under the reserved namespace (customer "Aurora Hardware Sdn Bhd", SKUs
// prefixed "VD-") and film only those, per §6.3 and guards.ts.
//
// Two phases per attempt:
//   1. Setup (headless, not recorded) -- log in, create a fresh reserved
//      Company/Deal/BOQ so the scan starts from a clean, editable BOQ.
//      This never appears on camera; it's plumbing.
//   2. Capture (headed, recorded via Xvfb + ffmpeg) -- log in again on
//      camera, navigate to the BOQ's scan page, upload the reserved site
//      document, start the OCR scan, and (once reachable -- see the
//      BLOCKED comment below) review + confirm the extracted quotation.
//
// SPEC.md §6.6 calls for best-of-3: run up to three attempts and keep the
// one whose assertions pass. Assertions run at capture time (CLAUDE.md:
// "primary QA"), not against the rendered video.
//
// ============================================================================
// BLOCKED (found 2026-08-28, live against the real demo): the app's own
// "Resume Review" link after starting a scan points to
//   GET /crm/boqs/{boq}/scans/{scan}/review
// which returns Laravel's default 404 with NO route registered at all --
// confirmed two ways:
//   - 17 consecutive polls over 105s all returned a clean
//     NotFoundHttpException 404 (not a transient 500), so this isn't the
//     server's general flakiness (also observed directly today on
//     /login and /crm/boqs/{id}, both intermittent 500s from what look
//     like missing/stale compiled Blade views on some backend instances).
//   - GET on the sibling resource route /crm/boqs/{boq}/scans/{scan}
//     (no /review suffix) returns 405 with `Allow: PUT, DELETE` -- i.e.
//     that route exists for update/discard, but no GET/show route is
//     registered for an individual scan at all.
// This means the OCR step (upload -> "Start Scanning") works end-to-end
// and creates a real CrmSiteVisitDocument, but the very next screen the
// UI links to -- reviewing the extracted line items -- is unreachable in
// the current deployment. Per CLAUDE.md ("product accuracy outranks
// polish", "if a feature is missing, the script changes"), the
// review-and-confirm half of this spec is written up to the point of
// verifying the review page loads, and stops there with a clear
// assertion failure rather than fabricating selectors for a screen this
// review never actually saw render. Once the route is fixed, extend
// runReviewAndConvertToQuotation() below with the real review-page
// selectors and the confirm/import -> quotation navigation.
// ============================================================================

import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { startRecording } from "../lib/recorder.ts";
import { launchCaptureBrowser, launchHeadlessSetupBrowser } from "../lib/browser.ts";
import { moveAndClick, moveToElement } from "../lib/cursor.ts";
import { assertPiiAllowlist, PII_ALLOWLIST } from "../lib/guards.ts";
import { MarkerTracker, writeSidecar } from "../lib/markers.ts";
import { ensureBoqScanDocument } from "../lib/boqScanDocument.ts";

const SHOT_ID = "boq_scan_to_quote";
const SIZE: [number, number] = [1920, 1080];
const FPS = 30;
const MAX_ATTEMPTS = 3; // SPEC.md §6.6 best-of-3, for non-deterministic OCR output
const REVIEW_POLL_TIMEOUT_MS = 45_000;
const REVIEW_POLL_INTERVAL_MS = 5_000;

const BASE_URL = requireEnv("KUNOS_DEMO_URL");
const EMAIL = requireEnv("KUNOS_DEMO_EMAIL");
const PASSWORD = requireEnv("KUNOS_DEMO_PASSWORD");

// Reserved-namespace fixture, per SPEC.md §6.3 and guards.ts's PII_ALLOWLIST.
const RESERVED_COMPANY_NAME = "Aurora Hardware Sdn Bhd";
const RESERVED_PIPELINE_ID = "4"; // "Standard Sales Pipeline (Default)"
const RESERVED_STAGE_ID = "14"; // "Qualification"

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example / SPEC.md §7)`);
  return value;
}

function url(path: string): string {
  return new URL(path, BASE_URL).toString();
}

// ---------------------------------------------------------------------------
// Phase 1: reserved-namespace setup (headless, not filmed)
// ---------------------------------------------------------------------------

interface ReservedBoq {
  companyId: string;
  dealId: string;
  boqId: string;
}

async function loginOn(page: Page): Promise<void> {
  // The demo has shown intermittent transient 500s on /login today (see the
  // BLOCKED note above) -- a handful of retries rides those out without
  // masking a real, persistent failure.
  let lastStatus: number | string = "no attempt";
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await page.goto(url("/login"), { waitUntil: "load", timeout: 20_000 }).catch(() => null);
    lastStatus = resp ? resp.status() : "network error";
    if (resp?.status() === 200 && (await page.locator('input[name="email"]').count())) {
      lastStatus = 200;
      break;
    }
    if (attempt < 3) await page.waitForTimeout(2_000);
  }
  if (lastStatus !== 200) {
    throw new Error(`Login page did not load cleanly after retries (last status: ${lastStatus})`);
  }

  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null),
    page.locator('button[type="submit"]').click(),
  ]);
  if (!/\/dashboard/.test(page.url())) {
    throw new Error(`Login did not land on /dashboard (ended up at ${page.url()}) -- check KUNOS_DEMO_EMAIL/PASSWORD`);
  }
}

async function findReservedCompanyId(page: Page): Promise<string | null> {
  await page.goto(url(`/crm/companies?search=${encodeURIComponent(RESERVED_COMPANY_NAME)}`), { waitUntil: "load" });
  const href = await page.evaluate((name) => {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/crm/companies/']")).find(
      (a) => a.textContent?.trim().toLowerCase() === name.toLowerCase(),
    );
    return link?.getAttribute("href") ?? null;
  }, RESERVED_COMPANY_NAME);
  const match = href?.match(/companies\/(\d+)/);
  return match ? match[1] : null;
}

async function createReservedCompany(page: Page): Promise<string> {
  await page.goto(url("/crm/companies/create"), { waitUntil: "load" });
  await page.locator('input[name="name"]').fill(RESERVED_COMPANY_NAME);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const match = page.url().match(/companies\/(\d+)/);
  if (!match) throw new Error(`Company creation did not redirect to a company detail page (ended up at ${page.url()})`);
  return match[1];
}

async function createReservedDeal(page: Page, companyId: string, title: string): Promise<string> {
  await page.goto(url("/crm/deals/create"), { waitUntil: "load" });
  await page.locator('select[name="company_id"]').selectOption(companyId);
  await page.locator('input[name="title"]').fill(title);
  await page.locator('select[name="pipeline_id"]').selectOption(RESERVED_PIPELINE_ID);
  await page.locator('select[name="stage_id"]').selectOption(RESERVED_STAGE_ID);
  const boqEnabled = page.locator("#dealBoqEnabledInput");
  if (!(await boqEnabled.isChecked())) await boqEnabled.check();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null),
    page.getByRole("button", { name: "Save Deal", exact: true }).click(),
  ]);
  const match = page.url().match(/deals\/(\d+)/);
  if (!match) throw new Error(`Deal creation did not redirect to a deal detail page (ended up at ${page.url()})`);
  return match[1];
}

async function createReservedBoq(page: Page, companyId: string, dealId: string, title: string): Promise<string> {
  await page.goto(url("/crm/boqs/create"), { waitUntil: "load" });
  await page.locator('select[name="company_id"]').selectOption(companyId);
  // The opportunity dropdown is filtered client-side once a company is
  // chosen -- give it a beat before selecting the deal we just made.
  await page.waitForTimeout(500);
  await page.locator('select[name="opportunity_id"]').selectOption(dealId);
  await page.locator('input[name="title"]').fill(title);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null),
    page.getByRole("button", { name: "Save Draft", exact: true }).click(),
  ]);
  const match = page.url().match(/boqs\/(\d+)/);
  if (!match) throw new Error(`BOQ creation did not redirect to a BOQ detail page (ended up at ${page.url()})`);
  return match[1];
}

/**
 * Reserved-namespace setup for one attempt. A fresh Deal + BOQ per attempt
 * (rather than reusing one across best-of-3 retries) because starting a
 * scan puts the BOQ into an "unfinished scan" state that would hide the
 * upload panel behind a resume/discard prompt on a retry.
 */
async function setupReservedRecords(attempt: number): Promise<ReservedBoq> {
  const browser = await launchHeadlessSetupBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });
    await loginOn(page);

    const companyId = (await findReservedCompanyId(page)) ?? (await createReservedCompany(page));

    const label = `Aurora Hardware — Warehouse Racking BOQ (attempt ${attempt})`;
    const dealId = await createReservedDeal(page, companyId, label);
    const boqId = await createReservedBoq(page, companyId, dealId, label);

    return { companyId, dealId, boqId };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 2: filmed capture
// ---------------------------------------------------------------------------

interface CaptureResult {
  outPath: string;
  duration: number;
  assertions: Array<{ type: string; value?: string; passed: boolean }>;
  tracker: MarkerTracker;
}

async function runOneAttempt(attempt: number, tmpOutPath: string): Promise<CaptureResult> {
  const reserved = await setupReservedRecords(attempt);
  const documentPath = await ensureBoqScanDocument();

  const recording = await startRecording({ outPath: tmpOutPath, size: SIZE, fps: FPS });
  const tracker = new MarkerTracker(recording.startedAt);
  const assertions: Array<{ type: string; value?: string; passed: boolean }> = [];
  let browser: Browser | undefined;

  try {
    browser = await launchCaptureBrowser({ display: recording.display, size: SIZE });
    const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });

    // -- Log in (filmed, but not eased/humanlike -- credentials on screen
    // aren't the narrative moment; the timeline builder can cut in after
    // this per SPEC.md §6.7). --
    await loginOn(page);
    await tracker.record("logged_in");

    // -- Navigate to the reserved BOQ's scan page. --
    await page.goto(url(`/crm/boqs/${reserved.boqId}/scan`), { waitUntil: "load" });
    const scanPanel = page.locator("#boqScanUploadPanel");
    await scanPanel.waitFor({ state: "visible", timeout: 10_000 });
    await tracker.record("scan_page_opened", scanPanel);

    const guardResult = await assertPiiAllowlistSafely(page);
    assertions.push({ type: "pii_allowlist", passed: guardResult });

    const companyVisible = await page.getByText(RESERVED_COMPANY_NAME, { exact: false }).first().isVisible();
    assertions.push({ type: "text_visible", value: RESERVED_COMPANY_NAME, passed: companyVisible });

    // -- Upload the reserved site document. The visible "Upload Image"
    // button drives a native OS file dialog via input.click(), which we
    // don't want on camera -- set the file on its (hidden) input directly
    // instead, after moving the cursor there for visual continuity. --
    const uploadButton = page.locator("#boqScanUploadImageBtn");
    await moveToElement(page, "#boqScanUploadImageBtn");
    await page.locator("#boqScanUploadImageInput").setInputFiles(documentPath);
    await page.waitForTimeout(300); // let the filename chip render
    await tracker.record("document_selected", uploadButton);

    // -- Start the OCR scan. --
    await moveAndClick(page, "#boqScanSubmit");
    await tracker.record("scan_started");

    // -- The real work happens server-side (Google Vision OCR + a queued
    // job). This is exactly the "real processing latency" dead zone
    // SPEC.md §6.6 calls for: nothing visibly changes here. --
    const review = await tracker.deadZone(() => pollForReviewPage(page, reserved.boqId));
    assertions.push({ type: "review_page_reachable", passed: review.reachable });

    if (!review.reachable) {
      throw new Error(
        `BOQ scan review page never became reachable within ${REVIEW_POLL_TIMEOUT_MS}ms ` +
          `(last status: ${review.lastStatus} at ${review.lastUrl}). This matches a real, ` +
          "reproducible product bug found 2026-08-28 -- see the BLOCKED comment at the top " +
          "of this file and knowledge/claims.json. Not a scripting issue: the app's own " +
          "\"Resume Review\" link points at a URL with no GET route registered.",
      );
    }

    await tracker.record("review_visible");

    // ---------------------------------------------------------------------
    // BLOCKED: see file header. Once GET .../scans/{scan}/review actually
    // renders, this is where to add:
    //   - assertions that the extracted line items match
    //     EXPECTED_LINE_ITEM_SKUS (by outcome, not exact OCR text --
    //     SPEC.md §6.6)
    //   - the eased-cursor "confirm" / "import to quotation" action
    //   - a marker + assertion on the resulting quotation screen
    //     (QuotationController@fromBoq)
    // ---------------------------------------------------------------------

    const allPassed = assertions.every((a) => a.passed);
    if (!allPassed) {
      throw new Error(`One or more capture-time assertions failed: ${JSON.stringify(assertions)}`);
    }

    return { outPath: tmpOutPath, duration: (Date.now() - recording.startedAt) / 1000, assertions, tracker };
  } finally {
    await browser?.close().catch(() => {});
    await recording.stop();
  }
}

async function assertPiiAllowlistSafely(page: Page): Promise<boolean> {
  try {
    await assertPiiAllowlist(page);
    return true;
  } catch (err) {
    // Log the violating names, not just pass/fail -- guards.ts's own
    // error message already lists them, but swallowing it here (so one
    // failed guard doesn't crash the whole attempt before other
    // assertions run) would otherwise hide the "which name?" question.
    console.error(err instanceof Error ? err.message : err);
    return false;
  }
}

async function pollForReviewPage(
  page: Page,
  boqId: string,
): Promise<{ reachable: boolean; lastStatus: number | string; lastUrl: string }> {
  const deadline = Date.now() + REVIEW_POLL_TIMEOUT_MS;
  let lastStatus: number | string = "no attempt";
  let lastUrl = "";

  while (Date.now() < deadline) {
    // Re-open the scan page each poll and follow its own "Resume Review"
    // link, rather than guessing the review URL ourselves -- if the app
    // ever changes the URL shape, this still finds the real one.
    await page.goto(url(`/crm/boqs/${boqId}/scan`), { waitUntil: "load" }).catch(() => null);
    const reviewHref = await page.evaluate(
      () => document.querySelector<HTMLAnchorElement>('a[href*="/review"]')?.href ?? null,
    );
    if (reviewHref) {
      const resp = await page.goto(reviewHref, { waitUntil: "load" }).catch(() => null);
      lastStatus = resp ? resp.status() : "network error";
      lastUrl = page.url();
      if (resp?.status() === 200) return { reachable: true, lastStatus, lastUrl };
    }
    await page.waitForTimeout(REVIEW_POLL_INTERVAL_MS);
  }
  return { reachable: false, lastStatus, lastUrl };
}

// ---------------------------------------------------------------------------
// Best-of-3 runner + sidecar (SPEC.md §5.1, §6.6)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dateStamp = new Date().toISOString().slice(0, 10);
  const finalOutDir = join("library", "ui", SHOT_ID);
  const finalVideoPath = join(finalOutDir, `${dateStamp}.mp4`);
  const finalSidecarPath = join(finalOutDir, `${dateStamp}.json`);

  let winningResult: CaptureResult | null = null;
  let winningAttempt = -1;
  const failures: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmpOutPath = join("out", "capture", SHOT_ID, `attempt-${attempt}.mp4`);
    console.log(`\n=== ${SHOT_ID}: attempt ${attempt}/${MAX_ATTEMPTS} ===`);
    try {
      const result = await runOneAttempt(attempt, tmpOutPath);
      winningResult = result;
      winningAttempt = attempt;
      console.log(`Attempt ${attempt} passed all capture-time assertions.`);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Attempt ${attempt} failed: ${message}`);
      failures.push(`attempt ${attempt}: ${message}`);
    }
  }

  if (!winningResult) {
    console.error(
      `\nAll ${MAX_ATTEMPTS} attempts failed capture-time assertions -- no shot recorded to ${finalOutDir}.\n` +
        "Per SPEC.md/CLAUDE.md, a shot that doesn't pass its own assertions is not published as a " +
        "usable take. Raw attempt recordings are left under out/capture/ for debugging.\n\n" +
        failures.join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(finalOutDir, { recursive: true });
  await rename(winningResult.outPath, finalVideoPath);
  await writeSidecar(finalSidecarPath, winningResult.tracker, {
    shot_id: SHOT_ID,
    ui_version: "kunos-demo-live", // no build/version endpoint exposed; see knowledge/pages.json
    viewport: SIZE,
    fps: FPS,
    duration: winningResult.duration,
    fixtures: { customer: PII_ALLOWLIST[0] },
    assertions: winningResult.assertions,
  });

  // Clean up the other attempts' raw recordings, if any ran before the winner.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt === winningAttempt) continue;
    await rm(join("out", "capture", SHOT_ID, `attempt-${attempt}.mp4`), { force: true });
  }

  console.log(`\nWrote ${finalVideoPath} and ${finalSidecarPath} (attempt ${winningAttempt}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
