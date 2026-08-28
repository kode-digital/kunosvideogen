// capture/run.ts
//
// Capture-lane entry point for `npm run capture` (SPEC.md §10: "Orchestration
// for V1 is npm scripts run by hand"). Runs each capture spec in turn.
//
// V1 has exactly one shot. As more specs are added under capture/specs/,
// list them here rather than building a discovery/queue mechanism --
// SPEC.md is explicit that a queue/database/dashboard isn't warranted
// until well past V1 ("Add BullMQ and Redis only past roughly five videos
// a month").

import "./specs/boq_scan_to_quote.spec.ts";
