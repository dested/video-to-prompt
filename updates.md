# Updates

## 2026-10-15 — 1.1.2: line pointer weighs time on screen; change notes explained
Found by Handback's brief eval: a line's → frame now prefers what was up for most of the line over a
frame that arrived as it ended (the confirm dialog); the report says what "changed top-right" means.
Touched: src/report.ts, test/unit/report.test.ts, package.json, plans/2026-10-15-fresh-eyes-evaluation.md

## 2026-10-15 — 1.1.1: honest format-1 sheets, transcriber echoes
Found on a real Handback walkthrough: format 1 sheets no longer promised magenta outlines (or change
boxes in recording.json); a line repeating the one before within 5 s (Whisper's chunk echo) is said once.
Touched: src/report.ts, test/unit/report.test.ts, package.json

## 2026-10-15 — 1.1.0: recording.json reader, cuts, captions, evidenceAt

For Handback's server-side brief: `readRecordingJson` (formats 1+2, extension shape), report `cuts`
(✂ in the timeline) and `captions` (`shows:`), `evidenceAt`, `rankFrames` cuts; recording.json adds
`polished`, `tlMs`, event `tMs`. 44 unit tests (round trip exact).
Touched: src/read.ts, src/report.ts, src/types.ts, src/index.ts, test/unit/report.test.ts, README.md, package.json

## 2026-10-15 — fresh-eyes evaluation → v2 ("make it incredible")

Rebuilt extraction (WebCodecs/mediabunny + seek fallback, 250 ms, luma signature + pure Selector),
readable sheets with change boxes, report v2, format video-to-prompt/2; 36 unit tests + fixture eval
(9/9 states vs v1 6/9). Renamed to @dested/video-to-prompt 1.0.0 (unpublished). Per plans/2026-10-15-fresh-eyes-evaluation.md.
Touched: src/* (new decode, signature, select, cancel), test/, README.md, package.json, tsconfig*.json, kit docs

## 2026-08-25 — speaker labels + frame quality (mirrored from Handback)

`TranscriptSegment.speaker` (1-based rank after talk-time normalization, set by the consumer's
transcribe client — this library doesn't transcribe), render-time S1:/S2: prefixes in
report.md/transcript.txt when ≥2 voices (text never mutated; polish still sees raw words),
`speaker` in recording.json, multi-voice caveat line. JPEG_QUALITY 0.9→0.8 (frames dominate
upload size). Mirrors handback decisions.md 2026-08-25; typecheck green.

## 2026-08-06 — add prepare script for git installs

Git installs (npm/bun from github:dested/video-to-prompt) got no dist because
only prepublishOnly built; `prepare` now runs the build on install. Lets
consumers (bx) drop their self-healing in-place builds eventually.
Touched: package.json, updates.md

## 2026-08-06 — extract video-to-prompt from Handback

Ported the distill pipeline out of handback/src/lib/capture into a standalone public library:
upload/auth/pending stripped, Transcriber/Polisher plug points added, report wording moved to
ReportOptions. Typecheck + build green; repo created at dested/video-to-prompt.
Touched: everything (initial commit)
