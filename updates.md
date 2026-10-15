# Updates

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
