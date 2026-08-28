// capture/proof/record-public-page.ts
//
// Session 2 proof: record 10 seconds of a webpage at 1080p30 and confirm
// recorder.ts produces a clean, playable MP4 with visible cursor movement.
//
// This sandbox's outbound network policy blocks essentially all public
// destinations (including, notably, the real Kunos demo domain itself —
// see SPEC.md Status section for what that means for Session 3), so this
// proof serves a local static page over plain HTTP on localhost instead
// of a public URL. That's a faithful substitute for THIS proof's purpose:
// it exercises the exact same recorder.ts + Playwright + cursor mechanics
// that real capture specs will use — only the network hop differs, and
// the network hop is not what SPEC.md §6.1/§6.2 is testing.
//
// This file is throwaway scaffolding, not part of the real capture
// pipeline — real shots live under capture/specs/.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startRecording } from "../lib/recorder.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = "out/proof/recorder-test.mp4";
const SIZE: [number, number] = [1920, 1080];
const FPS = 30;

async function serveTestPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = await readFile(join(__dirname, "test-page.html"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function main() {
  const page1 = await serveTestPage();
  console.log(`Serving local test page at ${page1.url}`);

  console.log("Starting Xvfb + ffmpeg recorder...");
  const recording = await startRecording({
    outPath: OUT_PATH,
    size: SIZE,
    fps: FPS,
  });
  console.log(`Recording on display ${recording.display} -> ${OUT_PATH}`);

  try {
    const browser = await chromium.launch({
      headless: false,
      executablePath: "/opt/pw-browsers/chromium",
      args: [`--window-position=0,0`, `--window-size=${SIZE[0]},${SIZE[1]}`, "--no-sandbox"],
      env: { ...process.env, DISPLAY: recording.display },
    });

    try {
      const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });
      await page.goto(page1.url, { waitUntil: "load" });

      // Move the mouse to the target box with eased interpolation, matching
      // the style capture/lib/cursor.ts will implement for real shots —
      // this is what proves the cursor is visible and smooth on the
      // resulting recording, not just that a page loaded.
      const box = await page.locator("#target").boundingBox();
      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;
        const steps = 40;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
          const x = 100 + (targetX - 100) * eased;
          const y = 100 + (targetY - 100) * eased;
          await page.mouse.move(x, y);
          await page.waitForTimeout(40);
        }
        await page.waitForTimeout(300);
        await page.mouse.click(targetX, targetY);
      }

      // Hold so the live clock overlay keeps ticking for the remainder of
      // ~10s total, which is an easy visual smoothness/framerate check
      // when reviewing the output.
      await page.waitForTimeout(7000);
    } finally {
      await browser.close();
    }
  } finally {
    console.log("Stopping recorder...");
    const result = await recording.stop();
    console.log(
      `Done. ${result.outPath} (recorded ${((result.stoppedAt - result.startedAt) / 1000).toFixed(1)}s wall clock)`,
    );
    await page1.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
