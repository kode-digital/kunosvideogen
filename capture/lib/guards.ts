// capture/lib/guards.ts
//
// PII allowlist guard, per SPEC.md §6.4:
// "Assert that every customer or company name visible in the DOM is on an
// approved allowlist. Fail the shot otherwise. This is the only thing
// standing between a shared demo tenant and publishing a real prospect's
// name on YouTube."
//
// The demo tenant's data is shared and changes between runs (SPEC.md §6.3)
// -- someone may have typed a real prospect's name into a form during a
// live sales call. This guard is capture-time, not post-hoc: it must run
// and pass BEFORE a frame showing the page is considered usable, per
// CLAUDE.md's "capture-time assertions are the primary QA" rule.
//
// Scope and honesty about its limits: there is no reliable way to detect
// "any arbitrary real company/person name" in free text. What this can
// do reliably is pattern-match the legal-entity suffixes company names
// in this market actually use (Sdn Bhd, Bhd, Pte Ltd, Ltd, Inc, LLC) and
// verify every match is on the allowlist. That catches the realistic
// failure mode (a real prospect's company name visible on a fixture-free
// screen) without pretending to be a general PII scanner.

import type { Page } from "playwright";

/**
 * Approved test/demo entity names, safe to appear in captured footage.
 * SPEC.md §6.3: interaction-flow shots create records under a reserved
 * namespace -- customer "Aurora Hardware Sdn Bhd", SKUs prefixed "VD-".
 * Add to this list only for names deliberately created as reserved test
 * fixtures, never to "fix" a guard failure by allowlisting whatever real
 * name happened to show up.
 */
export const PII_ALLOWLIST: readonly string[] = [
  "Aurora Hardware Sdn Bhd",
  // The platform vendor's own name, not a customer/prospect -- appears in
  // the "© Copyright Kode Digital Sdn Bhd ..." footer on every single
  // page (confirmed live 2026-08-28). It's persistent branding, not a
  // shared-tenant data leak, so it belongs on the allowlist rather than
  // failing every capture.
  "Kode Digital Sdn Bhd",
];

// Matches a run of capitalized words immediately followed by a common
// legal-entity suffix, e.g. "Bright Star Trading Sdn Bhd", "Acme Pte Ltd".
// Word separators are horizontal whitespace only ([ \t], never \n) --
// document.body.innerText inserts real newlines at block-element/heading
// boundaries, and an earlier version of this pattern used \s (which
// matches newlines too), so it happily glued unrelated headings and
// labels together into a single fake "entity name" (confirmed live
// 2026-08-28: "BOQ-2026-0018\n\nSCANNING INTO\n\nBOQ-2026-0018\n\nAurora
// Hardware Sdn Bhd" matched as one violation). A real entity name is
// always one contiguous inline run of text, never spread across
// separate blocks, so restricting to same-line whitespace is strictly
// more correct, not just a narrower net.
const ENTITY_NAME_PATTERN =
  /\b([A-Z][A-Za-z0-9&'.-]*(?:[ \t]+[A-Z][A-Za-z0-9&'.-]*){0,5}[ \t]+(?:Sdn\.?[ \t]?Bhd\.?|Bhd\.?|Pte\.?[ \t]?Ltd\.?|Ltd\.?|Inc\.?|LLC))\b/g;

export interface GuardResult {
  passed: boolean;
  /** Entity-like names found in the DOM that are not on the allowlist. */
  violations: string[];
  /** All entity-like names found, allowlisted or not -- useful for debugging/logging. */
  found: string[];
}

/**
 * Scan the page's currently-visible text for company-entity-suffixed
 * names and check each against PII_ALLOWLIST. Returns a result rather
 * than throwing, so callers can log details before failing the shot.
 */
export async function checkPiiAllowlist(page: Page, allowlist: readonly string[] = PII_ALLOWLIST): Promise<GuardResult> {
  const visibleText = await page.evaluate(() => {
    // Chrome/Firefox's innerText for a <select> returns the text of ALL
    // its <option>s, not just the one currently shown -- confirmed live
    // 2026-08-28 on this app's custom-styled dropdowns (Company/Deal/
    // Supplier pickers), which keep a real, in-flow <select> around for
    // accessibility/native-control behavior even though only a separate
    // ".bos-select-custom-trigger" element shows the selected value on
    // screen. Left as-is, every dropdown populated from shared-tenant
    // data (other real companies) would fail this guard regardless of
    // which option is actually selected/visible. Hiding <select>s for
    // this computation excludes that never-actually-seen option list
    // while still catching a real violation if the *visible* trigger
    // text itself shows a non-allowlisted name.
    const selects = Array.from(document.querySelectorAll("select"));
    const previousDisplay = selects.map((el) => el.style.display);
    selects.forEach((el) => {
      el.style.display = "none";
    });
    const text = document.body.innerText;
    selects.forEach((el, i) => {
      el.style.display = previousDisplay[i];
    });
    return text;
  });

  const found = [...visibleText.matchAll(ENTITY_NAME_PATTERN)].map((m) => m[1].trim());
  const uniqueFound = [...new Set(found)];

  const normalizedAllowlist = allowlist.map((n) => n.toLowerCase().trim());
  const violations = uniqueFound.filter((name) => {
    const normalized = name.toLowerCase().trim();
    // Exact match, or the allowlisted name as a trailing suffix -- the
    // pattern above greedily includes up to 5 preceding capitalized
    // words, so a real allowlisted name can pick up an unrelated leading
    // word from surrounding text. Confirmed live 2026-08-28 in two
    // different forms: "© Copyright Kode Digital Sdn Bhd" (a space
    // before the real name) and a "Company" field label rendered with
    // *no* space directly before its value, "CompanyAurora Hardware Sdn
    // Bhd" (a label+value pair that's visually separated by CSS, not an
    // actual space or line-break character in the text). A plain
    // suffix match covers both. The remaining false-negative risk --
    // some unrelated word that happens to end in the exact same letters
    // as an allowlisted name with zero separator -- is far less likely
    // in practice than a real label/heading landing directly next to it,
    // which is the actual failure mode this guard has hit twice now.
    return !normalizedAllowlist.some((allowed) => normalized.endsWith(allowed));
  });

  return { passed: violations.length === 0, violations, found: uniqueFound };
}

/**
 * Same as checkPiiAllowlist, but throws on failure. This is what capture
 * specs should call before recording/keeping a frame -- SPEC.md §6.5:
 * "apply fixtures, log in, navigate, run the guard, perform actions...".
 */
export async function assertPiiAllowlist(page: Page, allowlist: readonly string[] = PII_ALLOWLIST): Promise<void> {
  const result = await checkPiiAllowlist(page, allowlist);
  if (!result.passed) {
    throw new Error(
      `PII allowlist guard failed on ${page.url()}: found non-allowlisted entity name(s) visible: ` +
        result.violations.map((v) => `"${v}"`).join(", ") +
        ". This screen must not be captured -- either the fixture/reserved-namespace data isn't applied, " +
        "or a real prospect's name is visible in the shared demo tenant.",
    );
  }
}
