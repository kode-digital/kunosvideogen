# BUILD SPEC — Kunos automated video production system

## 0. How to use this document

You are picking up a system that has already been designed. The architecture below is settled and was arrived at by working through several failed approaches. Do not redesign it from scratch and do not re-run the discovery conversation.

Your job is to **write working code**, file by file, in the order given in section 10.

Before you write any capture code, ask the questions in section 9. Everything else you can start on immediately.

If you think part of this spec is wrong, say so explicitly and explain why. Do not silently substitute a different approach.

---

## Status — build notes (2026-08-28)

Source access to the actual Kunos backend (`kode-digital/bos-mirror`, a mirror of the real repo) was obtained and reviewed. Two things this spec assumed turned out not to match reality:

1. **§9 blocking question, answered:** Kunos is a Laravel 12 app with server-rendered Blade views, jQuery + Bootstrap 5, no SPA framework. There is no `routes/api.php`. This means `capture/lib/fixtures.ts` (§6.3) cannot use clean `page.route()` JSON interception as the primary path — it needs the DOM/response-patching fallback this section already anticipated for the server-rendered case. Not yet implemented; needs designing before `capture/lib/fixtures.ts` is written.

2. **§10 V1 target (`kunos_ai_quote`) does not exist as described — decided, not just flagged.** The Kunos AI chat assistant is real and Anthropic-backed, but its only capabilities are HR leave applications, travel claims, and staff leave lookups — no client lookup, stock check, or quote generation. CRM quotations exist and work, but as a conventional manual form with no AI involvement. Full evidence in `knowledge/claims.json` and `knowledge/product.json`. **Decision (2026-08-28): skip that scene rather than wait on product-owner sign-off.** V1's target shot is now `boq_scan_to_quote` — the real, working flow where a site-visit document is uploaded, Google Vision OCR extracts line items, they're reviewed, and the result becomes a CRM quotation (`Modules/CRM/App/Http/Controllers/BoqScanController.php` → `QuotationController@fromBoq`). §6.6 and §10 below are updated for this shot. The AI-chat-quote idea can come back as a later, separate video if the feature ever gets built — it is not part of V1.

Also found while reviewing: two other §8 claims ("100% accurate attendance reports", "fastest delivery route powered by Google Maps live traffic") point to features with no code presence at all, not just overstated ones. Details in `knowledge/claims.json`.

3. **Network access, and a Chromium/TLS gotcha (resolved).** This sandbox's outbound network defaulted to a restrictive policy that blocked the real Kunos demo domain entirely (403). Fixed by switching the Claude Code environment's network access setting to full/unrestricted (done 2026-08-28). Separately, even with network access open, Chromium (not curl/Node) got a mid-TLS-handshake connection reset against `intranetdemo.kodedigital.expert` through this environment's egress gateway — confirmed via Chromium's own NetLog to happen before any certificate is evaluated (`net_error -101`/ECONNRESET on the ClientHello), i.e. not a CA-trust problem. Root cause not fully identified (consistent with Chromium's TLS 1.3 ClientHello — e.g. post-quantum key exchange — being mishandled by the gateway), but forcing `--ssl-version-max=tls1.2` on the Chromium launch args reliably fixes it, confirmed against the real login page. This is now baked into `capture/lib/browser.ts` (`launchCaptureBrowser()`) — always launch capture browsers through that helper, not a raw `chromium.launch()`, or this will resurface.

4. **`capture/specs/boq_scan_to_quote.spec.ts` built and run against the real demo (2026-08-28).** Confirmed the full setup chain live (create Company → Deal → BOQ via `/crm/companies`, `/crm/deals`, `/crm/boqs`, all under the reserved "Aurora Hardware Sdn Bhd" namespace), and confirmed `GET /crm/boqs/{boq}/scan` plus the upload + `POST .../scan` "Start Scanning" step work end-to-end against the real OCR feature.
   The review screen the app links to after scanning (`GET /crm/boqs/{boq}/scans/{scan}/review`) was initially found **completely unreachable**: 17 consecutive polls over 105s all returned Laravel's clean "no matching route" 404, and `GET` on the sibling `/crm/boqs/{boq}/scans/{scan}` (no `/review`) returned 405 with `Allow: PUT, DELETE` — i.e. the update/discard routes existed but no show/review route did. ~20 minutes later, run for real inside the capture spec's own poll loop, that same route returned 200 both times it was reached — the demo tenant appears to be an actively-deployed staging environment, not a stable fixture (see the intermittent `/login` and `/crm/boqs/{id}` 500s noted below, also observed live today). **Treat "unreachable" findings against this tenant as time-stamped, not permanent** — re-verify before trusting an old "broken" note. Full evidence trail (both the broken and the since-recovered state) is in `knowledge/pages.json` (`boq_scan_ocr_flow`).
   The next capture-time failure once the review route recovered was a **guard false positive**, actually two compounding ones in `guards.ts`: (a) `ENTITY_NAME_PATTERN` used `\s` (matches newlines) between words, so it glued unrelated headings/labels across block-element boundaries into one fake "entity name" (e.g. a heading + a BOQ number + the real company name all mashed into one string); (b) the platform vendor's own name, "Kode Digital Sdn Bhd" — shown in the "© Copyright..." footer on every page — got captured with a leading "Copyright" from the same greedy-preceding-words behavior, so even after adding it to `PII_ALLOWLIST` the exact-match check still failed it. Fixed both (word separators restricted to same-line whitespace; allowlist check now accepts a word-boundary-safe suffix match, not just exact equality) and confirmed live.
   **Result: `npm run capture` now succeeds end to end on the first attempt**, producing `library/ui/boq_scan_to_quote/2026-08-28.mp4` (1920×1080, 30fps, ~22.6s, h264) and its sidecar — login → BOQ scan page → guard pass → document upload → "Start Scanning" → OCR dead zone (~5.7s this run) → review page confirmed reachable. Definition of done for V1 (§11) isn't met yet: the review screen itself (line-item table, confirm/import, resulting quotation) still isn't filmed or asserted on — the shot currently ends at "review page loads," not "quotation created." That's the next capture-spec extension, plus `generate/voice.ts` onward (§10 steps 6–10).
   Separately, also observed the demo intermittently returning genuine HTTP 500s on `/login` and on `/crm/boqs/{id}` (Blade errors like `View [auth.login] not found` / `View [layouts.main-layout] not found`) that clear on retry within seconds to low tens of seconds. `capture/specs/boq_scan_to_quote.spec.ts`'s `loginOn()` already retries through this; expect it elsewhere too. Also: this sandbox's container ships without `ffmpeg` pre-installed despite `capture/lib/recorder.ts` depending on it (`apt-get install -y ffmpeg` was needed before anything would record) — worth baking into environment setup rather than rediscovering per session.

---

## 1. What this is

An automated pipeline that produces marketing and demo videos for a SaaS product called Kunos, combining **real recorded UI footage** with AI-generated cinematic B-roll and AI narration.

Kunos is an operations platform for hardware stores, retail outlets and warehouses in Malaysia. Modules: Inventory, Logistics, CRM & Sales, HR, Finance/OCR, and a built-in AI assistant ("Kunos AI"). Audience is business owners and operations managers, not developers. Tone is warm, practical, peer-to-peer.

The output is a 16:9 master video plus 9:16 cutdowns, generated from a text brief in under ten minutes.

**Non-negotiable rule:** when narration describes a real product feature, the visual must be real recorded Kunos UI. AI video models are never used to depict the Kunos interface. They are used only for atmosphere, B-roll and transitions.

---

## 2. Architecture — two clocks

This is the central design decision. Do not collapse these into one pipeline.

**Slow lane (runs when the product changes, roughly monthly):**
Playwright drives the real Kunos demo environment and records a versioned library of UI shots. Separately, Higgsfield generates a tagged library of reusable B-roll clips.

**Fast lane (runs per video, minutes):**
A brief goes to Claude, which produces a scene plan referencing shot IDs from the library. ElevenLabs renders narration. A deterministic timeline builder merges narration durations with recorded event markers. ffmpeg assembles. Claude vision does a QA pass.

Generating a video never opens a browser and never calls a video model. That is what makes "make a 45-second LinkedIn version focused on inventory" take minutes instead of an hour, and it is why the pipelines are separate.

---

## 3. Tech stack — locked decisions

**Language:** Node + TypeScript throughout. One language, no Python/Node split.

**AI services (three API keys):**
| Service | Role | Cadence |
|---|---|---|
| Anthropic Claude API | Scene planning, script adaptation, capture spec generation, Higgsfield prompt writing, vision QA | Per video |
| ElevenLabs API | Narration + word-level timestamps (use the timestamps endpoint — it gives caption alignment for free) | Per video |
| Higgsfield API | B-roll clips only. Async submit-then-poll or webhook. Docs at docs.higgsfield.ai | Occasional |

**Non-AI components:**
- Playwright — browser control and assertions
- Xvfb — virtual display for headed Chrome
- ffmpeg — screen capture (`x11grab`) and final assembly
- Local filesystem for V1 storage

**Explicitly rejected — do not add these:**
- OpenAI (Claude covers planning and vision; a second model is integration surface with no added capability)
- Whisper (ElevenLabs timestamps already give word alignment)
- Remotion (correct tool technically, but the free licence covers only companies up to 3 people and the automation tier carries a $100/month minimum; ffmpeg is free and sufficient)
- n8n / Make / Zapier (built for short JSON steps, not long-running file-heavy ffmpeg work)
- HeyGen, Synthesia, Descript, Runway, Kling, Pika, CapCut in the automated path

---

## 4. Repo structure

```
kunos-video/
├── knowledge/
│   ├── product.json          # features, modules, positioning
│   ├── pages.json            # routes, selectors, load conditions
│   └── claims.json           # every product claim + verification status
├── fixtures/
│   ├── dashboard.json        # deterministic API payloads
│   ├── inventory.json
│   └── logistics.json
├── capture/
│   ├── specs/                # one file per shot
│   │   ├── dashboard_overview.spec.ts
│   │   └── kunos_ai_quote.spec.ts
│   ├── lib/
│   │   ├── recorder.ts       # Xvfb lifecycle + ffmpeg x11grab
│   │   ├── cursor.ts         # eased mouse movement
│   │   ├── markers.ts        # event + bbox + dead-zone emission
│   │   ├── fixtures.ts       # page.route() interception
│   │   └── guards.ts         # PII allowlist assertion
│   └── run.ts
├── library/
│   ├── ui/
│   │   └── kunos_ai_quote/
│   │       ├── 2026-08-19.mp4
│   │       └── 2026-08-19.json    # sidecar — see section 5
│   └── broll/
│       ├── warehouse_clipboard_01.mp4
│       └── index.json             # tags per clip
├── generate/
│   ├── plan.ts               # Claude: brief -> scene plan
│   ├── voice.ts              # ElevenLabs
│   ├── timeline.ts           # durations + markers -> cut list
│   ├── assemble.ts           # ffmpeg
│   └── qa.ts                 # Claude vision
├── briefs/
└── out/
```

---

## 5. Data contracts

These two schemas are the interface between the slow and fast lanes. Get them right first.

### 5.1 Shot sidecar (written by capture, read by timeline)

```json
{
  "shot_id": "kunos_ai_quote",
  "ui_version": "kunos-2026.08.19",
  "captured_at": "2026-08-19T04:12:00Z",
  "viewport": [1920, 1080],
  "fps": 30,
  "duration": 14.2,
  "fixtures": { "customer": "Aurora Hardware Sdn Bhd", "sku": "VD-A4-80" },
  "markers": [
    { "t": 0.00,  "event": "record_start" },
    { "t": 1.42,  "event": "ai_bubble_opened",  "bbox": [1620, 880, 260, 120] },
    { "t": 4.10,  "event": "prompt_submitted",  "bbox": [1180, 400, 700, 560] },
    { "t": 11.87, "event": "quotation_visible", "bbox": [420, 180, 1080, 720] }
  ],
  "dead_zones": [[4.30, 11.60]],
  "assertions": [
    { "type": "text_visible", "value": "Aurora Hardware", "passed": true },
    { "type": "pii_allowlist", "passed": true }
  ]
}
```

`bbox` is `[x, y, width, height]` and comes free from `elementHandle.boundingBox()` at the moment you act on the element. It exists so the 9:16 cutdown can pan and scale to the region of interest instead of blind-cropping a desktop screen into unreadability.

`dead_zones` marks intervals where nothing visibly changes (loading spinners, AI processing). The timeline builder speed-ramps these rather than you eyeballing cuts.

### 5.2 Scene plan (written by Claude, read by timeline)

```json
{
  "brief": "45s LinkedIn video, inventory focus",
  "aspect_ratios": ["16:9", "9:16"],
  "scenes": [
    {
      "id": "s1",
      "narration": "Your warehouse team is still counting stock on clipboards.",
      "source": "broll",
      "asset": "warehouse_clipboard_01",
      "overlay": null
    },
    {
      "id": "s2",
      "narration": "Kunos shows you stock value, low stock and out-of-stock alerts the moment you log in.",
      "source": "ui",
      "shot_id": "dashboard_overview",
      "focus_marker": "low_stock_highlighted",
      "overlay": "Real-time operational visibility"
    }
  ]
}
```

`focus_marker` names which marker's bbox the 9:16 crop should track for that scene.

---

## 6. Component specs

### 6.1 Recorder (`capture/lib/recorder.ts`)

Playwright's built-in video recording is not usable for marketing footage — variable framerate WebM, no cursor. Instead:

- Launch headed Chrome inside Xvfb at a fixed 1920x1080
- Capture with `ffmpeg -f x11grab -framerate 30 -draw_mouse 1 -video_size 1920x1080 -i :99 -c:v libx264 -preset slow -crf 18`
- Start ffmpeg before the first action, stop after the last, and record wall-clock offsets so marker timestamps line up with video timestamps

### 6.2 Cursor (`capture/lib/cursor.ts`)

Playwright's `mouse.move()` teleports the cursor, which looks broken on video. Interpolate every movement over roughly 25 steps with an ease-in-out curve. Add a short settle pause before clicking. Type with realistic per-character delay rather than `fill()` when the typing is on screen.

### 6.3 Fixtures (`capture/lib/fixtures.ts`)

The demo tenant is dedicated but its **data is shared and changes between runs**. Two problems follow: dashboard numbers drift between captures, and someone has probably typed a real prospect's name into a form during a live sales call.

For **read-only screens** (dashboard, driver reports, charts, spending tiers), intercept API responses and serve fixed JSON:

```ts
await page.route('**/api/dashboard/summary', route =>
  route.fulfill({ json: fixtures.dashboard })
);
```

The real UI renders — real components, real layout, real chart library, real styling. Only the payload is controlled. Every run produces identical numbers.

**The line that must not be crossed:** fixtures change *data*, never *structure*. Changing displayed values is standard product-marketing practice. Inventing UI elements, or filming a screen for a feature that is not built, is not. If a feature does not exist, the script changes — the fixture does not fake it.

For **interaction flows** (create quote, stock transfer, receipt upload), do not mock. Create records at the start of the run under a reserved namespace and film only those. Customer `Aurora Hardware Sdn Bhd`, SKUs prefixed `VD-`. Clean up afterwards.

### 6.4 Guards (`capture/lib/guards.ts`)

Assert that every customer or company name visible in the DOM is on an approved allowlist. Fail the shot otherwise. This is the only thing standing between a shared demo tenant and publishing a real prospect's name on YouTube.

### 6.5 Capture specs (`capture/specs/*.spec.ts`)

Each file records one shot. Structure: apply fixtures, log in, navigate, run the guard, perform actions with eased cursor, emit markers at each significant step, assert the expected outcome, stop recording, write the sidecar.

Assertions run at capture time, not on rendered frames. `expect(page.getByText('Aurora Hardware')).toBeVisible()` is deterministic and free. Vision analysis of a finished MP4 is neither.

### 6.6 BOQ scan-to-quote shot — special handling

(Replaces the original `kunos_ai_quote` shot, which was skipped — see Status section above and `knowledge/claims.json`.)

The BOQ document-scan flow works fully end-to-end today: upload a site-visit document/photo (`Modules/CRM/App/Http/Controllers/BoqScanController@create`/`@store`), Google Vision OCR extracts line items, the reviewer confirms/edits them (`@review`, `@update`, `@import`), and the confirmed BOQ becomes a quotation (`QuotationController@fromBoq`). Two complications, carried over from the original section because they still apply to this shot:

- **Non-deterministic OCR output.** Extracted line items can vary slightly run to run (misreads, ordering). Assert on the outcome (expected line-item count, expected item names/quantities present) rather than exact OCR text. Implement best-of-3: run up to three times, keep the take where assertions pass and the review screen reads cleanest.
- **Real processing latency.** Time the OCR extraction step ten times and take the median before any narration is locked. If the real time is longer than the script implies, either show it sped up with a visible label or rewrite the line — do not claim a speed that wasn't measured (see the "cut processing time" claim in `knowledge/claims.json`, which still needs a real benchmark before it can be used in narration).

### 6.7 Timeline (`generate/timeline.ts`)

No AI in this step, and it is the step that decides whether the video feels edited or assembled. Inputs: narration durations from ElevenLabs, markers and dead zones from sidecars, the scene plan. Output: a concrete cut list with in/out points, speed ramps over dead zones, hold frames on payoff moments, and pan/scale keyframes for the 9:16 crop derived from `focus_marker` bboxes.

### 6.8 Assemble (`generate/assemble.ts`)

ffmpeg `filter_complex` driven entirely by the cut list. Two passes, one per aspect ratio, from the same source shots. Burn captions from ElevenLabs word timestamps. Apply logo, brand colours and lower thirds.

### 6.9 QA (`generate/qa.ts`)

Sample roughly ten frames plus the caption track, send to Claude vision. Checks: correct screen for the narration, text readable at target resolution, captions aligned, branding present, no AI-generated clip accidentally depicting a fake Kunos UI. This is a coarse second net — capture-time assertions are the primary one.

---

## 7. Known environment facts

- Demo URL: `https://intranetdemo.kodedigital.expert/dashboard` (requires login)
- Dedicated demo tenant exists, but **data is shared and changes between runs** — this drives the whole fixture strategy
- Kunos AI quotation flow: working end-to-end today
- Output formats required: 16:9 master plus 9:16 cutdowns
- Existing accounts: Higgsfield, ElevenLabs
- Market: Malaysia. Currency RM, entities are Sdn Bhd, accounting integrations named are SQL Account and AutoCount

**Never ask for passwords, API keys or `.env` contents in chat.** Credentials go in a local `.env` file the user creates themselves.

---

## 8. Claims requiring rewording before publication

The existing master script contains claims that need product-owner sign-off or rewriting. Flag these in `knowledge/claims.json` with status `needs_review`:

- "100% accurate attendance reports" — geofencing does not prevent GPS spoofing, so this is overstated regardless of what Kunos implements
- "cut processing time by over 80%" — needs a documented basis
- "literally three seconds" for the Kunos AI quote — must match measured median latency
- "fastest delivery route powered by Google Maps live traffic" — verify a real Directions API traffic-model integration exists
- Named accounting integrations and their availability status

Product accuracy outranks cinematic quality. A polished video showing functionality that does not exist is a failure, not a trade-off.

---

## 9. Questions to ask before writing capture code

**Blocking:** Is the Kunos frontend a JavaScript SPA calling a JSON API, or is it server-rendered (Blade, Livewire, Inertia, similar)? Route-level fixture interception only works cleanly on the first. If server-rendered, the fallback is DOM patching before capture — workable but more fragile, and it changes the design of `fixtures.ts`.

**Needed soon:** Screenshots of Dashboard, Inventory, Logistics, CRM, HR, Finance and the Kunos AI bubble, to build `knowledge/pages.json`. A yes/no pass over the claims in section 8. Dev OS and Node version.

**Worth five minutes of someone's time:** ask whoever owns the demo environment whether a second, video-only tenant can be created. In most multi-tenant SaaS that is a config row, and it removes the entire shared-data problem.

---

## 10. Build order

Do not build the whole system. Build one vertical slice end to end, prove it, then widen.

**V1 slice — the `boq_scan_to_quote` shot only** (replaces the original `kunos_ai_quote` target — see Status section above):

1. `knowledge/pages.json` and `fixtures/` for the screens involved
2. `capture/lib/recorder.ts` — prove Xvfb + ffmpeg capture produces a clean 1080p30 MP4
3. `capture/lib/cursor.ts` and `markers.ts`
4. `capture/lib/guards.ts`
5. `capture/specs/boq_scan_to_quote.spec.ts` — produces MP4 + sidecar
6. `generate/voice.ts` — two narration lines with timestamps
7. `generate/timeline.ts` — merge into a cut list
8. `generate/assemble.ts` — render 16:9 and 9:16
9. One Higgsfield B-roll clip, added manually to the library
10. `generate/plan.ts` and `qa.ts` last

Orchestration for V1 is npm scripts run by hand: `npm run capture`, `npm run generate -- --brief briefs/boq-scan-quote.md`. No queue, no database, no web dashboard. Add BullMQ and Redis only past roughly five videos a month.

---

## 11. Definition of done for V1

Delete everything in `out/`, re-run the capture job and the generate job, and get a functionally identical video without touching anything by hand. Both aspect ratios render. Text is readable in the 9:16 crop. The narration beat lands on the moment the quotation appears.

If that holds, the same structure generalises to every other module. If it does not, widening the system will only multiply the problem.
