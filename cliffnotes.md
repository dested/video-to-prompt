# video-to-prompt — CliffNotes

> Living map of the project. Read this before any coding session.
> Last updated: 2026-08-06. Why → `decisions.md` · log → `updates.md`.

## What this is

A browser-only TypeScript library that distills already-recorded, narrated screen recordings
into an agent-ready prompt package: deduped keyframes, 3×3 contact sheets, a timed transcript
(via a pluggable speech engine), and a `report.md`/`MANIFEST.txt` pair written for LLM
consumption. Extracted 2026-08-06 from Handback's `src/lib/capture/` (which stays in place for
now and must be kept in sync — see Gotchas).

Public repo: **github.com/dested/video-to-prompt**. npm publish planned, not done — the name may
end up scoped (`@dested/video-to-prompt`) if the bare one is taken; decide at publish time.

## Quick Reference

- **Type-check:** `bun run typecheck` (tsc --noEmit) — must pass before any task is done
- **Build:** `bun run build` → `dist/` (ESM + d.ts via tsc)
- **No dev server, no tests yet** — it's a library; consumers exercise it (Handback `/phone` and
  `/upload` run the same code today)
- **Format:** `bun run prettier` (no semicolons, single quotes, width 100 — matches Handback)

## Stack

TypeScript (strict) · zero runtime dependencies · browser APIs only (`<video>`, canvas,
`OfflineAudioContext`, `createImageBitmap`). No DOM at module scope, so it imports cleanly under
SSR. devDeps: typescript, prettier, rimraf.

## Directory structure

```
src/
  index.ts       Public surface — the only file consumers import from
  distill.ts     THE orchestrator: clips in → file set out; Transcriber/Polisher plug points
  types.ts       Vocabulary: stages/progress/ClipInput/OutputFile + the FROZEN recording shapes
                 (Recording, RecordingMeta, RecordingFrame, TranscriptSegment, PageEvent, Session)
  probe.ts       What a picked file is: duration (webm Infinity hack), has-video, poster still
  media.ts       Offscreen <video> plumbing: hiddenVideo/readyVideo/seekTo/toJpeg, iOS wake-ups
  frames.ts      Keyframe extraction: 1s seek-step candidates, 64×64 signature dedup, beat
                 frames, uniform thin to frameBudget (40/min, clamp [150,600])
  grids.ts       3×3 contact sheets, nine per image in frame order (must match report.ts's map)
  audio.ts       decodeMono (16 kHz mono Float32, silence detection) + encodeWav (16-bit PCM)
  report.ts      The format's writers: report.md, MANIFEST.txt, transcript.txt, recording.json;
                 ReportOptions carries all product wording (url/source/pathsHint/polishedBy)
  timeline.ts    The unified axis: partSpans laid end to end, linePos/framePos (tl override)
  container.ts   videoFile name + contentType from the arriving MIME; contentTypeFor(path)
  format.ts      pad2/recDirName/mmss/mmssFile/dateTime/hhmm — filename-grade, frozen
  slug.ts        slugify — deterministic identity from a title
dist/            build output (gitignored)
```

## Key types & flow

`distill(clips: ClipInput[], opts)` per clip: probe → decodeMono → `opts.transcriber.run()` →
`opts.polish()` → extractFrames → makeGrids → per-take files (transcript.txt, recording.json,
video) — then report.md + MANIFEST.txt over the whole set. Returns `DistillOutput`
`{ session, takes, files, report, manifest, counts… }`. No upload, no storage, no network of its
own — transcription/polish only happen through the hooks the caller supplies.

## Gotchas & hard rules

- **The recording shapes and the emitted file set are a FORMAT, not internals.** Readers exist
  outside this repo (Handback's viewer, its `cli/push.ts` re-push, its MCP brief formatter, the
  recorder extension). Changing `recording.json` fields, path layouts (`rec-NN/frames/NN-mmss.jpg`,
  `grids/grid_NN.jpg`), or report structure is a format change — flag it, version it, don't drift it.
- **Handback still carries its own copy** (`handback/src/lib/capture/`, and the extension's live
  pipeline it was ported from). Until Handback consumes this package, any pipeline change here
  must be mirrored there and vice versa. That's the whole reason this repo exists — to end that
  duplication — so upstreaming Handback onto the package is the standing next step.
- **Audio before frames, always.** Decoding audio holds hundreds of MB; so do 600 JPEG blobs.
  `distill` takes the audio spike and releases it before extracting a single frame — keep that
  order in any new orchestration.
- **Keyframes are best-effort, and they're the only stage that is.** A decoder that won't
  seek-step (iOS) degrades the take to zero frames; video/transcript/report still ship. The
  rollback is the whole stage at once — half a frame set with no sheets leaves report.md citing
  files nobody wrote.
- **Grid batching must match report.ts's `sheetOf`** — nine per sheet, meta order. Change one,
  change both.
- **The polish hook edits words, never timings.** Same line count back or it's discarded;
  `t`/`d`/`tl` never cross the boundary.
- **Frame `t` survives thinning; `index`/`file` renumber.** Transcript citations point at times,
  so they stay valid — don't "fix" the renumbering.
- **1 s candidate floor is deliberate** (vs a live recorder's 500 ms): a seek-step pays a real
  decode per candidate and the MANIFEST says "1s candidates". Change the cadence, change the
  MANIFEST line.
- **No `noUncheckedIndexedAccess`** — deliberate (decisions.md): the hot loops index typed arrays
  and the code is a faithful port; strict mode only, matching the source repo.
- **Emitted ESM has extensionless relative imports** (moduleResolution: Bundler) — fine for
  bundler consumers, not for bare-Node ESM. Revisit before npm publish if Node support matters.
- **tRPC/JSON rule doesn't apply here, but SSR does:** nothing touches the DOM at module scope.
  Keep it that way or every SSR consumer breaks at import.

## Status

- **Done (2026-08-06)** — extracted from Handback: full pipeline ported (probe, media, frames,
  grids, audio, timeline, report, container, format, slug), upload/auth/pending stripped,
  transcribe/polish made pluggable (`Transcriber`/`Polisher`), report wording parameterized
  (`ReportOptions`), typecheck + build green, repo public at dested/video-to-prompt.
- **Not built** — npm publish (name check, maybe scope), tests (the format writers are pure and
  very testable — start there), a tiny demo page, Node/WebCodecs path, Handback consuming this
  package instead of its copy.
