// capture/lib/cursor.ts
//
// Eased cursor movement and human-paced typing, per SPEC.md §6.2.
//
// Playwright's page.mouse.move() teleports the cursor between positions,
// which looks broken on recorded video -- there's no in-between motion for
// the camera to actually capture. This interpolates every movement over a
// number of steps with an ease-in-out curve, and adds a short settle pause
// before clicking so the click doesn't look like it's still traveling.

import type { Page } from "playwright";

export interface MoveOptions {
  /** Number of interpolation steps. More steps = smoother motion, slower to execute. */
  steps?: number;
  /** Delay between each step, in ms. Total move duration is roughly steps * stepDelayMs. */
  stepDelayMs?: number;
  /** Pause after arriving, before any click, so the cursor visibly "settles". */
  settleMs?: number;
}

const DEFAULTS: Required<MoveOptions> = {
  steps: 25,
  stepDelayMs: 12,
  settleMs: 150,
};

// Standard ease-in-out cubic. Slow start, fast middle, slow finish -- reads
// as deliberate human movement rather than a robotic linear pan.
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

let lastKnownPosition = { x: 0, y: 0 };

/** Move the mouse from wherever it last was to (x, y) with eased interpolation. */
export async function moveTo(page: Page, x: number, y: number, opts: MoveOptions = {}): Promise<void> {
  const { steps, stepDelayMs } = { ...DEFAULTS, ...opts };
  const from = lastKnownPosition;

  for (let i = 1; i <= steps; i++) {
    const t = easeInOutCubic(i / steps);
    const stepX = from.x + (x - from.x) * t;
    const stepY = from.y + (y - from.y) * t;
    await page.mouse.move(stepX, stepY);
    if (i < steps) await page.waitForTimeout(stepDelayMs);
  }

  lastKnownPosition = { x, y };
}

/** Move to the center of an element's bounding box. Throws if the element has no box (not visible/attached). */
export async function moveToElement(page: Page, selector: string, opts: MoveOptions = {}): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`moveToElement: no bounding box for selector "${selector}" -- is it visible?`);
  await moveTo(page, box.x + box.width / 2, box.y + box.height / 2, opts);
}

/**
 * Move to an element and click it, with a settle pause in between so the
 * click doesn't visibly happen mid-travel.
 */
export async function moveAndClick(page: Page, selector: string, opts: MoveOptions = {}): Promise<void> {
  const { settleMs } = { ...DEFAULTS, ...opts };
  await moveToElement(page, selector, opts);
  await page.waitForTimeout(settleMs);
  await page.mouse.click(lastKnownPosition.x, lastKnownPosition.y);
}

export interface TypeOptions {
  /** Per-character delay in ms. Real-ish typing, not fill()'s instant paste. */
  delayMs?: number;
  /** Random jitter added to delayMs per character, so it doesn't look metronomic. */
  jitterMs?: number;
}

const TYPE_DEFAULTS: Required<TypeOptions> = { delayMs: 65, jitterMs: 40 };

/**
 * Type into the currently-focused element with a per-character delay, for
 * shots where the typing itself is on screen and needs to look human.
 * Click/focus the target field first -- this does not do that for you.
 */
export async function typeHumanlike(page: Page, text: string, opts: TypeOptions = {}): Promise<void> {
  const { delayMs, jitterMs } = { ...TYPE_DEFAULTS, ...opts };
  for (const char of text) {
    await page.keyboard.type(char);
    const jitter = Math.random() * jitterMs;
    await page.waitForTimeout(delayMs + jitter);
  }
}
