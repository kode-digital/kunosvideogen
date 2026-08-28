// capture/lib/kunosSession.ts
//
// Shared "log into the real demo" helper, used by every capture spec.
// Factored out of capture/specs/boq_scan_to_quote.spec.ts once a second
// spec needed the exact same login-with-retry logic (SPEC.md §7: demo
// credentials; this file's retry loop rides out the intermittent
// transient 500s on /login documented in SPEC.md's Status section).

import type { Page } from "playwright";

export const BASE_URL = requireEnv("KUNOS_DEMO_URL");
const EMAIL = requireEnv("KUNOS_DEMO_EMAIL");
const PASSWORD = requireEnv("KUNOS_DEMO_PASSWORD");

/**
 * Reserved-namespace fixture customer, per SPEC.md §6.3 and
 * guards.ts's PII_ALLOWLIST. Reused as the "supplier" name too on
 * documents fed into the Inventory OCR flow, rather than reserving a
 * second entity name.
 */
export const RESERVED_COMPANY_NAME = "Aurora Hardware Sdn Bhd";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example / SPEC.md §7)`);
  return value;
}

export function url(path: string): string {
  return new URL(path, BASE_URL).toString();
}

/** Log into the real demo, tolerating the tenant's intermittent transient 500s. */
export async function loginOn(page: Page): Promise<void> {
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

const RESERVED_PIPELINE_ID = "4"; // "Standard Sales Pipeline (Default)"
const RESERVED_STAGE_ID = "14"; // "Qualification"

/** Find the reserved-namespace company's id, if it already exists. */
export async function findReservedCompanyId(page: Page): Promise<string | null> {
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

/** Create the reserved-namespace company. Returns its id. */
export async function createReservedCompany(page: Page): Promise<string> {
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

/** Find the reserved-namespace company, creating it if it doesn't exist yet. */
export async function findOrCreateReservedCompany(page: Page): Promise<string> {
  return (await findReservedCompanyId(page)) ?? (await createReservedCompany(page));
}

/** Create a Deal for the reserved company, with BOQ support enabled. Returns its id. */
export async function createReservedDeal(page: Page, companyId: string, title: string): Promise<string> {
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
