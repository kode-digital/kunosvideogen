// capture/lib/supplierDeliveryDocument.ts
//
// Synthetic supplier delivery-order document fed into the real Supplier
// Documents OCR feature (Modules/Inventory -- "Upload, extract, review and
// match supplier invoices, delivery orders and credit notes", confirmed
// live 2026-08-28) for the Inventory section of the demo walkthrough.
//
// Same rationale as capture/lib/boqScanDocument.ts: this is an input
// document to a real OCR feature, not fake UI. Uses the reserved
// "Aurora Hardware Sdn Bhd" name as the supplier here too, rather than
// inventing a second reserved entity -- one name to keep on
// guards.ts's PII_ALLOWLIST is simpler than two, and the guard doesn't
// distinguish "customer" from "supplier".
//
// Unlike boqScanDocument.ts, this one is deliberately NOT cached/reused
// across runs: confirmed live 2026-08-28, Supplier Documents has its own
// tenant-wide duplicate-file check (by content, not by DO number alone --
// re-rendering with just a different DO number wasn't enough on its own
// to confirm, so the DO number *and* a fresh render each call are both
// used) that rejected a second upload of the same bytes with "This exact
// file has already been uploaded (document #N)". Each call renders a
// fresh file with a unique DO number to a unique path.

import { join } from "node:path";
import { ensureRenderedDocument } from "./syntheticDocument.ts";

function documentHtml(doNumber: string): string {
  return `
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Arial, Helvetica, sans-serif; width: 1000px; padding: 40px; background: white; color: #111; }
  h1 { font-size: 20px; margin-bottom: 0; }
  .sub { color: #555; margin-top: 4px; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #333; padding: 8px 10px; font-size: 15px; text-align: left; }
  th { background: #eee; }
  .meta { margin-bottom: 16px; font-size: 14px; }
  .totals { margin-top: 16px; text-align: right; font-size: 15px; }
</style></head>
<body>
  <h1>Delivery Order</h1>
  <div class="sub">Aurora Hardware Sdn Bhd — Supplier</div>
  <div class="meta">DO No: ${doNumber} &nbsp;|&nbsp; Date: 25 Aug 2026 &nbsp;|&nbsp; Deliver To: Warehouse 2, Prai</div>
  <table>
    <tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit Price (RM)</th></tr>
    <tr><td>VD-A4-80</td><td>A4 Copy Paper 80gsm (Ream)</td><td>50</td><td>12.50</td></tr>
    <tr><td>VD-STPL-01</td><td>Heavy Duty Stapler</td><td>10</td><td>18.00</td></tr>
    <tr><td>VD-FLD-A4</td><td>Manila Folder A4</td><td>200</td><td>0.60</td></tr>
  </table>
  <div class="totals">Total: RM 925.00</div>
</body></html>
`;
}

/** SKUs on the rendered delivery order -- for outcome assertions, not exact-text matching. */
export const EXPECTED_LINE_ITEM_SKUS = ["VD-A4-80", "VD-STPL-01", "VD-FLD-A4"] as const;

/** Render a fresh, uniquely-numbered delivery-order document. Returns its path. */
export async function ensureSupplierDeliveryDocument(): Promise<string> {
  const doNumber = `DO-${Date.now()}`;
  const outPath = join("out", "capture", "assets", `supplier_delivery_order_${Date.now()}.png`);
  return ensureRenderedDocument(documentHtml(doNumber), outPath);
}

// Allow a one-off `tsx capture/lib/supplierDeliveryDocument.ts` to render one directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSupplierDeliveryDocument().then((p) => console.log(`Wrote ${p}`));
}
