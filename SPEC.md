# BUILD SPEC — Kunos automated video production system

## 0. How to use this document

You are picking up a system that has already been designed. The architecture below is settled and was arrived at by working through several failed approaches. Do not redesign it from scratch and do not re-run the discovery conversation.

Your job is to **write working code**, file by file, in the order given in section 10.

Before you write any capture code, ask the questions in section 9. Everything else you can start on immediately.

If you think part of this spec is wrong, say so explicitly and explain why. Do not silently substitute a different approach.

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

### 6.6 Kunos AI shot — special handling

The Kunos AI quotation flow works fully end-to-end today (client lookup, stock check, quote generation, confirmed by the product owner). Two complications:

- **Non-deterministic output.** Assert on the outcome (a quote exists, the client is correct, quantity is 5) rather than exact wording. Implement best-of-3: run up to three times, keep the take where assertions pass and the response reads cleanest.
- **Real latency.** Time the flow ten times and take the median before any narration is locked. Streaming token output films well, so do not hide it. If the real time is longer than the script implies, either show it sped up with a visible label or rewrite the line.

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

**V1 slice — the `kunos_ai_quote` shot only:**

1. `knowledge/pages.json` and `fixtures/` for the screens involved
2. `capture/lib/recorder.ts` — prove Xvfb + ffmpeg capture produces a clean 1080p30 MP4
3. `capture/lib/cursor.ts` and `markers.ts`
4. `capture/lib/guards.ts`
5. `capture/specs/kunos_ai_quote.spec.ts` — produces MP4 + sidecar
6. `generate/voice.ts` — two narration lines with timestamps
7. `generate/timeline.ts` — merge into a cut list
8. `generate/assemble.ts` — render 16:9 and 9:16
9. One Higgsfield B-roll clip, added manually to the library
10. `generate/plan.ts` and `qa.ts` last

Orchestration for V1 is npm scripts run by hand: `npm run capture`, `npm run generate -- --brief briefs/ai-quote.md`. No queue, no database, no web dashboard. Add BullMQ and Redis only past roughly five videos a month.

---

## 11. Definition of done for V1

Delete everything in `out/`, re-run the capture job and the generate job, and get a functionally identical video without touching anything by hand. Both aspect ratios render. Text is readable in the 9:16 crop. The narration beat lands on the moment the quotation appears.

If that holds, the same structure generalises to every other module. If it does not, widening the system will only multiply the problem.
