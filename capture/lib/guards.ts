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
  // The platform vendor's own name, appearing legitimately in footers/
  // branding (e.g. "Copyright Kode Digital Sdn Bhd") -- this is not a
  // customer/prospect name, so it belongs on the allowlist permanently.
  "Kode Digital Sdn Bhd",
];

// Matches a run of capitalized words immediately followed by a common
// legal-entity suffix, e.g. "Bright Star Trading Sdn Bhd", "Acme Pte Ltd".
// Word-joining whitespace is restricted to spaces/tabs (not \s, which
// includes newlines) -- innerText renders each UI label/field on its own
// line, and allowing newlines let the match sweep across unrelated
// adjacent lines (a user's name, a "Company" field label, ...) into what
// looked like one long fake entity name. Real entity names are one line.
const ENTITY_NAME_PATTERN =
  /\b([A-Z][A-Za-z0-9&'.-]*(?:[ \t]+[A-Z][A-Za-z0-9&'.-]*){0,5}[ \t]+(?:Sdn\.?\s?Bhd\.?|Bhd\.?|Pte\.?\s?Ltd\.?|Ltd\.?|Inc\.?|LLC))\b/g;

// The name-matching regex is greedy about capitalized words, so generic
// capitalized boilerplate immediately before a real name (page furniture,
// not part of any entity name) gets swept into the match -- e.g.
// "Copyright Kode Digital Sdn Bhd". Strip known leading boilerplate
// words before comparing against the allowlist, rather than allowlisting
// every noisy variant a match could produce.
const LEADING_BOILERPLATE = /^(Copyright|All Rights Reserved|Powered By|Presented By)\s+/i;

function stripLeadingBoilerplate(name: string): string {
  return name.replace(LEADING_BOILERPLATE, "").trim();
}

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
  const visibleText = await page.evaluate(() => document.body.innerText);

  const found = [...visibleText.matchAll(ENTITY_NAME_PATTERN)].map((m) => stripLeadingBoilerplate(m[1].trim()));
  const uniqueFound = [...new Set(found)];

  const normalizedAllowlist = new Set(allowlist.map((n) => n.toLowerCase().trim()));
  const violations = uniqueFound.filter((name) => !normalizedAllowlist.has(name.toLowerCase().trim()));

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
