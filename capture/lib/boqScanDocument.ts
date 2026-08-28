// capture/lib/boqScanDocument.ts
//
// Generates the synthetic "site visit document" fed into the real BOQ-scan
// OCR feature (Modules/CRM/App/Services/SiteVisitDocumentOcrService.php,
// Google Cloud Vision-backed) for capture/specs/boq_scan_to_quote.spec.ts.
//
// This is an *input document* to a real, working product feature, not a
// fake UI element -- CLAUDE.md's "fixtures change data, never structure"
// rule is about the Kunos UI itself, which this never touches. Google
// Vision genuinely OCRs this image; nothing about the extraction is
// scripted or faked. Using a rendered document instead of a photographed
// paper one keeps the shot reproducible (SPEC.md's whole point) and keeps
// the reserved-namespace naming (SPEC.md §6.3: customer "Aurora Hardware
// Sdn Bhd", SKUs prefixed "VD-") baked into the source document itself,
// rather than relying on someone to have a matching paper printout on
// hand.
//
// Rendered once via a throwaway headless page (no Xvfb needed -- this
// never appears on camera) and cached to disk; regenerated automatically
// if the cached file goes missing.

import { ensureRenderedDocument } from "./syntheticDocument.ts";

const DOCUMENT_HTML = `
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Arial, Helvetica, sans-serif; width: 1000px; padding: 40px; background: white; color: #111; }
  h1 { font-size: 22px; margin-bottom: 0; }
  .sub { color: #555; margin-top: 4px; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #333; padding: 8px 10px; font-size: 15px; text-align: left; }
  th { background: #eee; }
  .meta { margin-bottom: 16px; font-size: 14px; }
</style></head>
<body>
  <h1>Site Visit — Bill of Quantities (Draft)</h1>
  <div class="sub">Aurora Hardware Sdn Bhd — Warehouse Racking Project</div>
  <div class="meta">Site: Prai Industrial Estate, Penang &nbsp;|&nbsp; Visited by: A. Rahman &nbsp;|&nbsp; Date: 20 Aug 2026</div>
  <table>
    <tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit</th></tr>
    <tr><td>VD-RK-2400</td><td>Heavy Duty Racking Frame 2400mm</td><td>12</td><td>unit</td></tr>
    <tr><td>VD-RK-BEAM</td><td>Racking Beam 900mm</td><td>48</td><td>unit</td></tr>
    <tr><td>VD-RK-DECK</td><td>Steel Shelf Deck Panel</td><td>36</td><td>unit</td></tr>
    <tr><td>VD-SF-BOLT</td><td>Safety Anchor Bolt Set</td><td>60</td><td>set</td></tr>
    <tr><td>VD-LB-A4</td><td>Barcode Label Roll A4</td><td>10</td><td>roll</td></tr>
  </table>
</body></html>
`;

/**
 * SKUs that must appear on the rendered document -- used by the capture
 * spec's outcome assertions (SPEC.md §6.6: assert on outcome, not exact
 * OCR text, since extraction is non-deterministic).
 */
export const EXPECTED_LINE_ITEM_SKUS = ["VD-RK-2400", "VD-RK-BEAM", "VD-RK-DECK", "VD-SF-BOLT", "VD-LB-A4"] as const;

const DEFAULT_PATH = "capture/assets/boq_scan_site_document.png";

/** Render (or reuse a cached render of) the synthetic site-visit document. Returns its path. */
export async function ensureBoqScanDocument(outPath = DEFAULT_PATH): Promise<string> {
  return ensureRenderedDocument(DOCUMENT_HTML, outPath);
}

// Allow a one-off `tsx capture/lib/boqScanDocument.ts` to regenerate it directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureBoqScanDocument().then((p) => console.log(`Wrote ${p}`));
}
