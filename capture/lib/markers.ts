// capture/lib/markers.ts
//
// Event + bbox + dead-zone emission, per SPEC.md §5.1 and §6.5.
//
// A capture spec calls record() at each significant step (bubble opened,
// form submitted, result visible, ...) and startDeadZone()/endDeadZone()
// around waits where nothing visibly changes (spinners, processing). The
// tracker turns those into the "markers" and "dead_zones" arrays of the
// shot sidecar JSON (SPEC.md §5.1) -- generate/timeline.ts reads that
// sidecar later to build the cut list. This file only tracks; it does not
// write the sidecar file itself (see writeSidecar in this file for that
// last step, called once at the end of a capture spec).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Locator } from "playwright";

export interface Marker {
  /** Seconds since recording start -- must line up with the video's own timeline. */
  t: number;
  event: string;
  /** [x, y, width, height] in viewport pixels, from boundingBox() at the moment of the event. */
  bbox?: [number, number, number, number];
}

export type DeadZone = [start: number, end: number];

export interface ShotSidecar {
  shot_id: string;
  ui_version: string;
  captured_at: string;
  viewport: [number, number];
  fps: number;
  duration: number;
  fixtures: Record<string, string>;
  markers: Marker[];
  dead_zones: DeadZone[];
  assertions: Array<{ type: string; value?: string; passed: boolean }>;
}

export class MarkerTracker {
  private readonly recordingStartedAt: number;
  private readonly markers: Marker[] = [];
  private readonly deadZones: DeadZone[] = [];
  private openDeadZoneStart: number | null = null;

  constructor(recordingStartedAt: number) {
    this.recordingStartedAt = recordingStartedAt;
  }

  /** Seconds elapsed since the recording started, for aligning with the video. */
  private elapsed(): number {
    return (Date.now() - this.recordingStartedAt) / 1000;
  }

  /**
   * Record an event at the current moment. Pass a Locator to capture its
   * bounding box at this instant (e.g. right after acting on it) --
   * SPEC.md §5.1 notes this comes "free" from boundingBox() at the moment
   * you act on the element, so call this immediately after the action,
   * not before.
   */
  async record(event: string, locator?: Locator): Promise<Marker> {
    const t = this.elapsed();
    let bbox: [number, number, number, number] | undefined;
    if (locator) {
      const box = await locator.boundingBox();
      if (box) bbox = [box.x, box.y, box.width, box.height];
    }
    const marker: Marker = bbox ? { t, event, bbox } : { t, event };
    this.markers.push(marker);
    return marker;
  }

  /** Mark the start of a dead zone (loading spinner, AI/processing wait, ...). */
  startDeadZone(): void {
    if (this.openDeadZoneStart !== null) {
      throw new Error("startDeadZone() called while a dead zone is already open -- call endDeadZone() first");
    }
    this.openDeadZoneStart = this.elapsed();
  }

  /** Mark the end of the current dead zone. */
  endDeadZone(): void {
    if (this.openDeadZoneStart === null) {
      throw new Error("endDeadZone() called with no open dead zone -- call startDeadZone() first");
    }
    this.deadZones.push([this.openDeadZoneStart, this.elapsed()]);
    this.openDeadZoneStart = null;
  }

  /**
   * Run fn() as a dead zone: starts, awaits fn, ends -- for the common
   * case of "wrap this wait/processing step".
   */
  async deadZone<T>(fn: () => Promise<T>): Promise<T> {
    this.startDeadZone();
    try {
      return await fn();
    } finally {
      this.endDeadZone();
    }
  }

  getMarkers(): Marker[] {
    return [...this.markers];
  }

  getDeadZones(): DeadZone[] {
    return [...this.deadZones];
  }
}

export interface SidecarMeta {
  shot_id: string;
  ui_version: string;
  viewport: [number, number];
  fps: number;
  duration: number;
  fixtures: Record<string, string>;
  assertions: Array<{ type: string; value?: string; passed: boolean }>;
}

/** Assemble and write the full shot sidecar JSON next to the recorded MP4. */
export async function writeSidecar(outPath: string, tracker: MarkerTracker, meta: SidecarMeta): Promise<void> {
  const sidecar: ShotSidecar = {
    shot_id: meta.shot_id,
    ui_version: meta.ui_version,
    captured_at: new Date().toISOString(),
    viewport: meta.viewport,
    fps: meta.fps,
    duration: meta.duration,
    fixtures: meta.fixtures,
    markers: tracker.getMarkers(),
    dead_zones: tracker.getDeadZones(),
    assertions: meta.assertions,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");
}
