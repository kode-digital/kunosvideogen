// capture/lib/recorder.ts
//
// Screen recorder for the slow (capture) lane. Per SPEC.md §6.1:
// Playwright's built-in video recording is not usable for marketing
// footage (variable framerate WebM, no cursor). Instead we launch headed
// Chrome inside a virtual X display (Xvfb) and capture that display with
// ffmpeg's x11grab, which gives a fixed-framerate MP4 with the real cursor
// visible.
//
// Two clocks note (CLAUDE.md): this file is part of the *capture* lane
// only. It never gets imported by anything under generate/.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";

export interface RecorderOptions {
  /** Absolute or relative path to write the MP4 to. Parent dirs are created. */
  outPath: string;
  /** Virtual display size, e.g. [1920, 1080]. Must match the browser viewport. */
  size?: [number, number];
  /** Frames per second to capture at. SPEC.md default is 30. */
  fps?: number;
  /** X display number to use, e.g. 99 -> ":99". Pick something unlikely to collide. */
  display?: number;
  /** libx264 preset. SPEC.md default is "slow" (quality over encode speed — this is offline capture, not live). */
  preset?: "ultrafast" | "fast" | "medium" | "slow";
  /** Constant rate factor. Lower = higher quality/bitrate. SPEC.md default 18. */
  crf?: number;
}

export interface RecordingHandle {
  /** The X display string a browser should be pointed at, e.g. ":99". */
  display: string;
  /** Wall-clock time recording actually started (Date.now()), for aligning marker timestamps. */
  startedAt: number;
  /**
   * Stop Xvfb + ffmpeg cleanly and wait for the MP4 to be finalized.
   * Safe to call once. Resolves once the output file is flushed to disk.
   */
  stop(): Promise<{ outPath: string; startedAt: number; stoppedAt: number }>;
}

const DEFAULTS = {
  size: [1920, 1080] as [number, number],
  fps: 30,
  display: 99,
  preset: "slow" as const,
  crf: 18,
};

/**
 * Start an Xvfb virtual display and an ffmpeg x11grab capture pointed at it.
 * Returns a handle exposing the display string (for launching Playwright
 * against) and a stop() function. Nothing about Kunos, fixtures, or
 * Playwright lives in this file — it only knows how to record a display.
 */
export async function startRecording(opts: RecorderOptions): Promise<RecordingHandle> {
  const size = opts.size ?? DEFAULTS.size;
  const fps = opts.fps ?? DEFAULTS.fps;
  const displayNum = opts.display ?? DEFAULTS.display;
  const preset = opts.preset ?? DEFAULTS.preset;
  const crf = opts.crf ?? DEFAULTS.crf;
  const display = `:${displayNum}`;
  const [width, height] = size;

  await mkdir(dirname(opts.outPath), { recursive: true });

  const xvfb = spawn(
    "Xvfb",
    [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  await waitForXDisplay(xvfb, display);

  const ffmpegArgs = [
    "-y",
    "-f", "x11grab",
    "-framerate", String(fps),
    "-draw_mouse", "1",
    "-video_size", `${width}x${height}`,
    "-i", display,
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    opts.outPath,
  ];
  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"] });

  // ffmpeg needs a beat to open the X11 grab source before the caller
  // starts driving the browser, otherwise the first second or two of
  // real action is lost before frames are being written.
  await waitForFfmpegReady(ffmpeg);

  const startedAt = Date.now();
  let stopped = false;

  async function stop() {
    if (stopped) {
      throw new Error("recorder.stop() called twice");
    }
    stopped = true;

    // Ask ffmpeg to finish the container cleanly (moov atom etc.) rather
    // than SIGKILL, which can leave an unplayable/truncated MP4.
    ffmpeg.stdin.write("q");
    const ffmpegExit = once(ffmpeg, "exit");
    await Promise.race([ffmpegExit, timeout(10_000, "ffmpeg did not exit after quit signal")]);

    xvfb.kill("SIGTERM");
    await Promise.race([once(xvfb, "exit"), timeout(5_000, "Xvfb did not exit")]).catch(() => {
      // Xvfb sometimes needs a harder nudge; don't fail the whole capture over this.
      xvfb.kill("SIGKILL");
    });

    return { outPath: opts.outPath, startedAt, stoppedAt: Date.now() };
  }

  return { display, startedAt, stop };
}

function waitForXDisplay(xvfb: ChildProcessWithoutNullStreams, display: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Xvfb on ${display} did not start in time`)), 5_000);
    xvfb.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    xvfb.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited early with code ${code}`));
    });
    // Xvfb doesn't announce readiness on stdout; a short settle delay is
    // the pragmatic approach ffmpeg/Playwright tooling generally uses.
    setTimeout(() => {
      clearTimeout(timer);
      xvfb.removeAllListeners("exit");
      xvfb.removeAllListeners("error");
      resolve();
    }, 300);
  });
}

function waitForFfmpegReady(ffmpeg: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ffmpeg did not start capturing in time")), 5_000);
    let seenFrame = false;
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      if (!seenFrame && /frame=/.test(text)) {
        seenFrame = true;
        clearTimeout(timer);
        ffmpeg.stderr.off("data", onStderr);
        resolve();
      }
    };
    ffmpeg.stderr.on("data", onStderr);
    ffmpeg.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ffmpeg.once("exit", (code) => {
      if (!seenFrame) {
        clearTimeout(timer);
        reject(new Error(`ffmpeg exited before capturing any frames (code ${code})`));
      }
    });
  });
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
