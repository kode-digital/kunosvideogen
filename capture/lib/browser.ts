// capture/lib/browser.ts
//
// Shared Chromium launch helper for the capture lane. Exists mainly to
// carry one environment-specific workaround in a single place instead of
// repeating it in every capture spec.
//
// Background: in this sandbox's network environment, outbound HTTPS goes
// through an egress gateway at $HTTPS_PROXY. curl/Node work fine through
// it. Chromium does not: with TLS 1.3 enabled (the default), Chromium's
// ClientHello gets a mid-handshake connection reset from the gateway
// (net_error -101 / ECONNRESET, confirmed via chromium's own NetLog —
// this happens before any certificate is even evaluated, so it is not a
// trust/CA problem). Forcing --ssl-version-max=tls1.2 avoids whatever in
// Chromium's TLS 1.3 ClientHello the gateway chokes on, and connects
// cleanly. TLS 1.2 is still a fully secure protocol, so this is a
// compatibility workaround, not a security downgrade.
//
// If this pipeline ever runs outside this specific sandboxed environment
// (a developer's own machine, a different CI), this flag is expected to
// be harmless — TLS 1.2 is supported everywhere — so it is left
// unconditional rather than environment-sniffed.

import { chromium, type Browser } from "playwright";

const PLAYWRIGHT_CHROMIUM_PATH = "/opt/pw-browsers/chromium";

export interface LaunchCaptureBrowserOptions {
  /** X display to launch on, e.g. ":99" — from recorder.ts's startRecording(). */
  display: string;
  /** Viewport / window size. Should match the recorder's size. */
  size: [number, number];
}

export async function launchCaptureBrowser(opts: LaunchCaptureBrowserOptions): Promise<Browser> {
  const [width, height] = opts.size;
  return chromium.launch({
    headless: false,
    executablePath: PLAYWRIGHT_CHROMIUM_PATH,
    args: [
      `--window-position=0,0`,
      `--window-size=${width},${height}`,
      "--no-sandbox",
      "--ssl-version-max=tls1.2", // see file header — required in this sandbox's network environment
      ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : []),
    ],
    env: { ...process.env, DISPLAY: opts.display },
  });
}

/**
 * Headless Chromium for the *setup* half of an interaction-flow capture
 * (SPEC.md §6.3: "create records at the start of the run under a reserved
 * namespace"), not for filming. No Xvfb/display needed — this never
 * appears in the recorded video. Carries the same TLS 1.2 workaround as
 * launchCaptureBrowser() above, since it hits the same egress gateway.
 */
export async function launchHeadlessSetupBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: PLAYWRIGHT_CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--ssl-version-max=tls1.2", // see file header — required in this sandbox's network environment
      ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : []),
    ],
  });
}
