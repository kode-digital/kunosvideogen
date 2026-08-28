// capture/proof/record-kunos-login.ts
//
// Confirms the network-access fix actually works end to end against the
// real Kunos demo domain, through the full recorder + browser stack real
// capture specs will use. Does NOT log in (no credentials here — see
// CLAUDE.md "No credentials in chat" and SPEC.md §7) — it only proves the
// login page itself loads, renders, and is capturable.
//
// Throwaway scaffolding, not part of the real capture pipeline.

import { startRecording } from "../lib/recorder.ts";
import { launchCaptureBrowser } from "../lib/browser.ts";

const OUT_PATH = "out/proof/kunos-login.mp4";
const SIZE: [number, number] = [1920, 1080];
const FPS = 30;
const URL = "https://intranetdemo.kodedigital.expert/login";

async function main() {
  console.log("Starting Xvfb + ffmpeg recorder...");
  const recording = await startRecording({ outPath: OUT_PATH, size: SIZE, fps: FPS });
  console.log(`Recording on display ${recording.display} -> ${OUT_PATH}`);

  try {
    const browser = await launchCaptureBrowser({ display: recording.display, size: SIZE });
    try {
      const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });
      await page.goto(URL, { waitUntil: "load" });
      console.log(`Loaded: ${await page.title()} (${page.url()})`);
      await page.waitForTimeout(3000);
    } finally {
      await browser.close();
    }
  } finally {
    console.log("Stopping recorder...");
    const result = await recording.stop();
    console.log(`Done. ${result.outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
