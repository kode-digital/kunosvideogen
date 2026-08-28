# Kunos video pipeline

Automated video production for Kunos, a Malaysian SaaS ops platform for hardware stores, retail and warehousing. Combines real recorded UI footage with AI B-roll and AI narration.

**Full spec is in `SPEC.md`. Read it before starting new work.**

## Hard rules

**Real UI for real claims.** When narration describes a product feature, the visual is real recorded Kunos UI. AI video models never depict the Kunos interface — only atmosphere, B-roll and transitions.

**Fixtures change data, never structure.** API response interception controls displayed values so captures are reproducible. It must never fake a UI element or a feature that does not exist. If a feature is missing, the script changes.

**Product accuracy outranks polish.** A good-looking video showing functionality that does not exist is a failure, not a trade-off.

**Two clocks, kept separate.** Capture (slow, runs on product change) and generation (fast, runs per video) are separate pipelines sharing a shot library. Never make video generation open a browser or call a video model.

**No credentials in chat.** Secrets live in local `.env` only. Never ask for or echo passwords, API keys or `.env` contents.

## Stack — settled, do not substitute

Node + TypeScript. Playwright for capture. Xvfb + ffmpeg `x11grab` for recording. ffmpeg for assembly. Claude API for planning and vision QA. ElevenLabs for narration and word timestamps. Higgsfield for B-roll.

## Do not add

OpenAI, Whisper, Remotion, n8n/Make/Zapier, HeyGen, Synthesia, Descript, Runway, Kling, Pika, or CapCut in the automated path. Each was considered and rejected — reasons are in `SPEC.md` section 3. If you think one is now warranted, say so and explain why rather than adding it.

## Working style

Build one vertical slice end to end before widening. Current target is the `kunos_ai_quote` shot (`SPEC.md` section 10).

Capture-time assertions are the primary QA. Assert in Playwright before the frame is recorded rather than analysing rendered video.

Orchestration is npm scripts run by hand. No queue, no database, no web dashboard until past roughly five videos a month.
