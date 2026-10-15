# video-to-prompt — CliffNotes

> Living map of the project. Read this before any coding session.
> Last updated: 2026-10-15. Why → `decisions.md` · log → `updates.md`.

## What this is

A browser-only TypeScript library that distills already-recorded, narrated screen recordings
into an agent-ready prompt package: keyframes chosen for evidence, contact sheets with what
changed outlined, a timed transcript (via a pluggable speech engine), and a
`report.md`/`MANIFEST.txt` pair written for a model (Opus 5.5) to read. Format
`video-to-prompt/2`. Extracted 2026-08-06 from Handback's `src/lib/capture/`; v2 (2026-10-15)
is meant to become Handback's only pipeline (see Status).

Public repo **github.com/dested/video-to-prompt**; npm name **`@dested/video-to-prompt`**
(1.1.1 prepared, not yet published: needs Sal's `npm login`). Until then consumers install the
git tag (`github:dested/video-to-prompt#v1.1.1`): each `vX.Y.Z` tag is a release-only commit off
main with `dist/` force-added, because bun won't run `prepare` for git deps.

## Quick Reference

- **Type-check:** `bun run typecheck` (src, then `test/tsconfig.json` over tests + harness). Must pass
- **Unit tests:** `bun run test` (`bun test test/unit`): signature, Selector scenarios, report goldens
  (snapshots in `test/unit/__snapshots__/`; refresh with `--update-snapshots`, then READ the diff)
- **Build:** `bun run build` → `dist/` (ESM + d.ts via tsc, `.js` imports, loads under bare Node)
- **Fixture eval:** `bun test/browser/fixtures.ts` (needs ffmpeg) once, then
  `bun test/browser/eval.ts [--ref HEAD --label v1] [--ref '' --label v2]`: headless Chromium,
  states caught vs ground truth, noise frames, wall time. Outputs in `test/.runs/<label>/`
- **Rule tuning without a browser:** `bun test/browser/sigdump.ts …` dumps signature streams to
  `test/.runs/sig/`; `bun test/browser/tune.ts <file.sig> --truth … --narration …` replays Selector
- **Format:** `bun run prettier` (no semicolons, single quotes, width 100, matches Handback)

## Stack

TypeScript (strict + `noUncheckedIndexedAccess`) · one runtime dep, **mediabunny** (`^1.61.0`,
always dynamic-imported) · browser APIs (WebCodecs, `<video>`, canvas, `OfflineAudioContext`,
`createImageBitmap`). No DOM at module scope, so it imports cleanly under SSR. devDeps:
typescript, @types/bun, playwright-core (eval harness), prettier, rimraf.

## Directory structure

```
src/
  index.ts       Public surface, the only file consumers import from
  distill.ts     THE orchestrator: clips in → file set out; Transcriber (id + label)/Polisher plug
                 points; options sheetWidth, frameEngine, includeVideo
  types.ts       FORMAT = 'video-to-prompt/2' + the recording shapes (Recording, RecordingMeta,
                 RecordingFrame with change/held/transient, FrameBox, TranscriptSegment, Session…)
  probe.ts       Container-first probe via mediabunny (duration, size, poster via WebCodecs);
                 falls back to the <video> path (webm Infinity hack)
  decode.ts      openFrameSource: WebCodecs sequential sink (latest frame ≤ each time) or seek-
                 stepping; withFallback switches mid-stream if WebCodecs throws
  signature.ts   160-column luma grid (rows by aspect), diffSignatures → changed/regions/box
  select.ts      Selector: PURE keyframe rule (major change, settle, transient, dedup, narration
                 anchors, beat, final frame, budget, busy-cell heat mask). No DOM
  frames.ts      extractFrames: candidates (250 ms webcodecs / 1 s seek) → signature → Selector;
                 only keepers become JPEGs. candidateTimes, frameBudget (40/min, [150,600])
  grids.ts       Contact sheets: 2000 px default, 3 cols (5 portrait), labels, magenta change boxes
  audio.ts       decodeMono via mediabunny AudioSampleSink, 30 s resample chunks, AAC priming trim,
                 decodeAudioData fallback; encodeWav (16-bit PCM)
  report.ts      The format's writers: report.md (Start here / sheets / Timeline), MANIFEST.txt,
                 transcript.txt, recording.json; rankFrames, evidenceAt, whereOnScreen;
                 ReportOptions voice + host hooks (cuts ✂, captions `shows:`)
  read.ts        readRecordingJson: recording.json (format 1 or 2, extension shape) → Recording,
                 so a server/CLI can rebuild report.md. Pure, zod-free, tolerant
  media.ts       Offscreen <video> plumbing: readyVideo/seekTo/toJpeg, iOS wake-ups, signals
  cancel.ts      CancelledError, throwIfAborted, isCancelled, abortable
  timeline.ts    The unified axis: partSpans laid end to end, linePos/framePos (tl override)
  container.ts   videoFile name + contentType from the arriving MIME; contentTypeFor(path)
  format.ts      pad2/recDirName/mmss/mmssFile/dateTime/hhmm (filename-grade, frozen)
  slug.ts        slugify
test/
  tsconfig.json  Typechecks tests + harness + src (allowImportingTsExtensions, bun types)
  unit/          bun tests: helpers.ts (synthetic signatures, replay), signature/select/report tests
  browser/       Playwright harness: fixtures.ts (builds the Ledgerly fixture + truth/narration),
                 harness-core.ts/run.ts (distill in headless Chromium), eval.ts, sigdump.ts, tune.ts
  .fixtures/ .runs/   generated, gitignored
plans/           dated working docs (fresh-eyes evaluation)
dist/            build output (gitignored)
```

## Key types & flow

`distill(clips, opts)` per clip: probe (`poster: false`) → decodeMono → `transcriber.run()` →
`polish()` → extractFrames (narration windows passed in) → makeGrids → per-take files; then
report.md + MANIFEST.txt over the whole set. Returns `DistillOutput`. No network of its own.

Inside extractFrames: `openFrameSource` yields frames at `candidateTimes`; each is drawn small,
read to a `Signature`, pushed into `Selector`, which answers `hold`/`keep`/`drop`/`refetch`
actions over two slots (`pending`, `anchor`). The extractor holds at most a couple of full-size
frames and encodes only keepers.

## Gotchas & hard rules

- **The recording shapes and the emitted file set are a FORMAT.** Readers exist outside this repo
  (Handback viewer, `cli/push.ts`, MCP brief formatter, extension, bx). Format 2 only _adds_
  fields; keep it that way or bump the format. Paths `rec-NN/frames/NN-mmss.jpg`,
  `grids/grid_NN.jpg` are contract.
- **Handback still carries its own drifted copy** until the migration lands. Don't fix bugs there
  by hand; move it onto this package.
- **Audio before frames, always.** `distill` releases the audio spike before extracting a frame.
- **Keyframes are best-effort.** Both engines failing degrades the take to zero frames;
  video/transcript/report still ship. The rollback is the whole stage.
- **Grid batching must match report.ts's `sheetOf`**: nine per sheet, meta order.
- **The polish hook edits words, never timings.** Same line count back or it's discarded.
- **Selector changes go through the evals.** Run `bun run test` and the fixture eval (9/9 states,
  10 frames, 0 noise is the bar); replay the real dump with `tune.ts` (11 frames). Synthetic
  fixtures must not be periodic (a stripe pattern repeats and reads as A-B-A).
- **mediabunny's `samplesAtTimestamps` returns null on cue-less MediaRecorder webm.** decode.ts
  uses a sequential `samples(from)` sink on purpose.
- **Never import mediabunny statically.** It is dynamic-imported in decode/probe/audio so the
  package imports under SSR and bare Node.
- **Relative imports carry `.js`**: needed for bare-Node ESM consumers.
- **Report snapshot tests pin `process.env.TZ = 'UTC'`**: dateTime/hhmm are local-time.
- **Nothing touches the DOM at module scope.** Handback's server imports the package for
  `readRecordingJson`/`buildReport`; keep the index importable under Bun/Node.
- **recording.json round-trips.** `buildRecordingJson` → `readRecordingJson` → `buildReport` must
  equal the in-memory report (unit-tested). A new field the report reads needs writing too.

## Status

- **Done (2026-08-06)**: extracted from Handback; pluggable transcribe/polish; ReportOptions.
- **Done (2026-10-15)**: v2. WebCodecs engine via mediabunny with seek fallback,
  250 ms cadence, signature + Selector, readable 2000 px sheets with change boxes, report v2
  (Start here, errors beside frames, log/speech wording), container-first probe, chunked audio,
  cancellation, 36 unit tests, fixture eval harness, README, package renamed. Fixture 9/9 states
  (v1 6/9); real clip 2.6 s (v1 33.3 s); 5-min sparse-keyframe webm 22 s (v1 358 s).
  Review page: https://claude.ai/artifact/NbTveyzKvZNgdSqka4Z1nG
- **Done (2026-10-15)**: v2 committed (`1a1930c`), tag `v1.0.0`; 1.1.0 adds the recording.json
  reader and host hooks for Handback's server-side brief.
- **In progress**: the Handback migration (MCP brief, web capture, extension), per
  `W:\code\handback\plans\2026-10-15-video-to-prompt-v2-and-brief.md`.
- **Waiting on Sal**: `npm login` + publish; bx (`narration: 'log'`, drop `wording.ts`) and
  coterie (npm package instead of vendored dist).
- **Open**: recorder chrome (Handback's side panel, floating bar) still causes noise frames on
  real clips; an `ignore`-regions option waits for Handback to pass its own geometry.
