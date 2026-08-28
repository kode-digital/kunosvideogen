// capture/lib/syntheticDocument.ts
//
// Shared renderer for the synthetic paper documents fed into Kunos's real
// OCR features during capture (BOQ scan, supplier document upload). These
// are input documents to a real, working product feature, not fake UI --
// CLAUDE.md's "fixtures change data, never structure" rule is about the
// Kunos UI itself, which rendering a document image never touches. Google
// Vision genuinely OCRs whatever image is fed in.
//
// Rendered once via a throwaway headless page (no Xvfb needed -- this
// never appears on camera) and cached to disk; regenerated automatically
// if the cached file goes missing.

import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { launchHeadlessSetupBrowser } from "./browser.ts";

/** Render `html` to a PNG at `outPath`, reusing a cached file if one already exists. */
export async function ensureRenderedDocument(html: string, outPath: string): Promise<string> {
  if (await exists(outPath)) return outPath;

  await mkdir(dirname(outPath), { recursive: true });
  const browser = await launchHeadlessSetupBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 900 } });
    await page.setContent(html);
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await browser.close();
  }
  return outPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
