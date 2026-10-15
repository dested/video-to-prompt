# video-to-prompt

Distill a narrated screen recording into an **agent-ready prompt package**: the keyframes that
matter, contact sheets with what changed outlined, a timed transcript, and a `report.md` written
for a model to read. It puts evidence first and everything on one timeline, and every path is
relative, so the folder moves as one unit.

Feed it the clips your OS screen recorder (or MediaRecorder) produced; hand the resulting folder
to a coding agent. The report opens with the 3–6 frames that carry the most evidence, each paired
with the line said over it. The contact sheets cover the whole recording at a fraction of the
tokens, and the timeline puts every spoken line next to the frame that shows it.

**Browser-only.** Frames decode through WebCodecs (via [mediabunny](https://mediabunny.dev),
loaded on first use), with `<video>` seek-stepping as the fallback; audio goes through
mediabunny and `OfflineAudioContext`. There is no Node path. It handles the inputs that fight
back: iOS Safari's reluctant decoders, MediaRecorder webm with no duration and no cues, and
Android pickers that hand over files with no MIME type.

## Install

```sh
bun add @dested/video-to-prompt
```

## Quick start

```ts
import { distill } from '@dested/video-to-prompt'

// files: File[] from an <input type="file">, a share target, a drop zone…
const result = await distill(
  files.map((file) => ({ file })),
  {
    title: 'Checkout button does nothing on mobile',
    onProgress: (p) => console.log(p.stage, p.pct, p.detail),
  }
)

// result.files is the whole package: report.md, MANIFEST.txt, rec-NN/…
// result.report is the report.md text; upload / zip / hand off as you like.
```

### With transcription

The library decodes narration to 16 kHz mono Float32 and hands it to whatever speech engine you
plug in. `encodeWav` wraps the samples in the one container every speech API accepts.

```ts
import { distill, encodeWav, type Transcriber } from '@dested/video-to-prompt'

const whisperViaMyServer: Transcriber = {
  id: 'groq', // stored in recording.json
  label: 'Whisper large-v3 (Groq)', // what the report says wrote the words
  run: async (audio, { signal }) => {
    const res = await fetch('/api/transcribe', { method: 'POST', body: encodeWav(audio), signal })
    if (!res.ok) return null // null = ship without words, never fail the run
    return await res.json() // [{ t: msFromStart, d?: spokenMs, text, speaker? }, …]
    // A server that picks between engines can say which one answered:
    // return { segments, label: 'Deepgram nova-3' } (a returned label beats `label` above)
  },
}

const result = await distill(clips, {
  title,
  transcriber: whisperViaMyServer,
  // Optional cleanup pass: same number of lines back, text only, timings untouched.
  polish: async (segments) => cleanUpNouns(segments),
  report: {
    url: 'https://example.com/walkthroughs/abc123',
    source: 'the Example Recorder',
    polishedBy: 'Claude',
  },
})
```

### Options worth knowing

| Option                                                     | Default    |                                                                                                                                                 |
| ---------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `frameEngine`                                              | `'auto'`   | `'webcodecs'` or `'seek'` to force one. `auto` uses WebCodecs wherever the browser can decode the file                                          |
| `sheetWidth`                                               | `2000`     | Contact sheet width. 2000 px is Claude Code's display limit; pass 2576 for a model fed through the API                                          |
| `includeVideo`                                             | `true`     | Put each take's video in the file set. Off when the host stores the video itself                                                                |
| `keyframes`                                                | `true`     | `false` skips frames and sheets: the video is the deliverable and only the words are distilled (a person talking to camera)                     |
| `report.narration`                                         | `'speech'` | `'log'` when the lines are a tool's own action log (exact, not transcribed); every word the report uses for them changes                        |
| `report.narrationBy` / `report.intro` / `report.videoPath` |            | Who wrote the log, the opening sentence, and where a take's video lives when it isn't `rec-NN/<file>`                                           |
| `report.cuts`                                              |            | Stretches removed after recording (`{ fromMs, toMs, reason? }` on the walkthrough's clock). Left out of the report and marked ✂ in the timeline |
| `report.captions`                                          |            | One-sentence frame captions by path, written by a model. Printed as `shows:` and labelled as a model's reading                                  |

## The output package

```
report.md            the whole walkthrough in order, on one timeline. Built for a model to read
MANIFEST.txt         plain-text listing + transcripts, for tools that don't render markdown
rec-01/
  walkthrough.webm   the raw clip, named for the container it actually arrived in
  frames/NN-mmss.jpg keyframes (the mmss is time inside this take's own video)
  grids/grid_NN.jpg  contact sheets: nine consecutive keyframes, captioned, changes outlined
  transcript.txt     the words alone, with timing windows
  recording.json     machine-readable: frame times, change boxes, line windows, events
rec-02/ …            one folder per clip, laid end to end on one clock
```

`report.md` has three parts:

- **Start here.** The 3–6 frames that carry the most evidence, in time order. Every complaint
  line ("but the total is still wrong") gets its best frame first, then the final state, then
  frames by worth. Each entry says what changed and where ("changed bottom-right (small), gone
  after 0.5 s"), names a captured error when one fired within 3 s, and quotes its line.
- **Contact sheets.** Nine keyframes per image at ~660 px tiles, where UI text still reads. Each
  tile is captioned with its number and walkthrough time (and how long it lasted, if it didn't).
  A magenta outline marks the region that changed since the tile before it.
- **Timeline.** One line per frame with a description, each spoken line indented under the frame
  showing when it began, with a `→` to a better frame when one exists. Long silent runs collapse,
  and 15 s silences start a new chapter.

## How keyframes are chosen

A candidate every 250 ms (WebCodecs decodes sequentially, so cadence is nearly free) or every
1 s (seek-stepping pays a full decode per candidate). Each candidate becomes a 160-column luma
signature (160×90 at 16:9, ~12 px cells at 1080p). A pure `Selector` decides which candidates
to keep:

1. **Major changes only.** One connected region of ≥ 12 cells or ≥ 40 cells total. A cursor, a
   caret or a ticking timer stays under that. Changes are measured against the kept frames, so
   small edits that accumulate (typing a line) cross the bar on their own.
2. **Settle before keeping.** A change is kept when the screen holds still. Continuous motion
   is sampled once per 2 s, so a scroll yields its resting place, not its blur. A state that
   snaps back to the one before is kept and flagged `transient`: a toast, a tooltip, a flash of
   an error.
3. **Novel against the recent past.** A-B-A cutaways don't come back as new frames.
4. **Every narration line gets a picture.** A line whose window passes with no keyframe gets the
   candidate inside it that differs most from the last keyframe. People narrate what they're
   looking at, even a change too small for rule 1.
5. **The ending is always shown**, and a slowly drifting screen still gets a frame every 15 s.
6. **A busy-cell mask.** Cells that keep changing in small ways (a clock, a spinner, a
   recorder's own live caption) heat up and drop out of every comparison until they cool.
7. **A budget.** 40 frames per minute, clamped to 150–600; past it the least-changed frame goes,
   never the first, the last, or a narration frame.

Only the keepers are ever JPEG-encoded, and the extractor holds at most a couple of full frames
at once.

## Pieces, exported individually

`distill()` is the front door; each stage is public for callers that need one alone, and so a
live recorder can share the same signature and selection rules.

| Export                                                                           | Does                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `probeClip(file, { poster? })`                                                   | duration / dimensions / has-video / poster still, container-first                                             |
| `extractFrames(file, durationMs, { narration?, engine? })`                       | keyframes plus their JPEGs, the engine used and the cadence                                                   |
| `openFrameSource(file)`                                                          | the decoder underneath: WebCodecs with a mid-stream fallback to seeking                                       |
| `Selector` / `diffSignatures` / `signatureFromRgba`                              | the selection rule and the signature it runs on. Pure, no DOM                                                 |
| `makeGrids(frames, { width? })`                                                  | contact sheets, batched to match the report's frame→sheet map                                                 |
| `decodeMono(file)` / `encodeWav(samples)`                                        | narration → 16 kHz mono Float32 → 16-bit PCM WAV                                                              |
| `buildReport` / `buildManifestTxt` / `buildRecordingJson` / `buildTranscriptTxt` | the format's writers                                                                                          |
| `rankFrames(recordings, { cuts? })`                                              | the "start here" frames as data, for a host that hands an agent images directly                               |
| `evidenceAt(recordings, ms, { cuts? })`                                          | what one moment holds: the line said there, the frame that best shows it, an error beside it                  |
| `readRecordingJson(json)`                                                        | a take's `recording.json` back into the shapes (format 1 or 2), so a server or CLI can run the report writers |
| `partSpans` / `linePos` / `framePos` / `totalMs`                                 | the unified timeline every position comes from                                                                |
| `CancelledError` / `isCancelled`                                                 | what every stage throws on `signal` abort                                                                     |

## Format

`recording.json` and `MANIFEST.txt` carry `format: video-to-prompt/2`. Format 2 only adds
fields: frame `change` boxes, `held` and `transient`, the `narration` and `end` frame reasons,
`sampling`, `transcriberLabel`, `polished`, `tlMs` on moved frames and lines, and `tMs` on events.
It also changes what `dist` counts (cells of the 160-column luma grid). A reader of format 1 keeps
working, and `readRecordingJson` reads both: a server holding only the files can rebuild
`report.md` with `buildReport`, and a format 1 take never claims "most of the screen changed".

## Constraints worth knowing

- **Memory order is load-bearing.** Audio is decoded and released before a single frame is
  extracted; overlapping the two is what kills a phone tab. `distill` handles this; keep the
  discipline if you compose the stages yourself.
- **Keyframes are best-effort.** A decoder that refuses both engines costs the walkthrough its
  stills, never the walkthrough: video, transcript and report still ship.
- **Timings are sacred.** The polish hook may only rewrite text; a response with a different
  line count is discarded.

## Development

```sh
bun install
bun run typecheck        # src, then the tests
bun run test             # unit tests: signature, selector, report goldens
bun test/browser/fixtures.ts   # build the synthetic fixture app recording (needs ffmpeg)
bun test/browser/eval.ts       # run distill in headless Chromium over the fixtures and score it
```

The eval scores states caught against the fixture's ground truth: a toast up for 0.6 s, a single
digit changing in a total, a validation message, a modal, an 0.8 s tooltip. `sigdump.ts` and
`tune.ts` replay dumped signature streams through `Selector` in milliseconds, for tuning the
rules without a browser.
