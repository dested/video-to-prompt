# video-to-prompt

Distill a narrated screen recording into an **agent-ready prompt package**: deduped keyframes,
3×3 contact sheets, a timed transcript, and a `report.md` written for an LLM to read — evidence
first, everything on one timeline, every path relative so the folder moves as one unit.

Feed it the clips your OS screen recorder (or MediaRecorder) produced; hand the resulting folder
to a coding agent. The agent reads the contact sheets to follow the whole recording at a fraction
of the tokens, opens individual stills only where the narration points, and gets the spoken words
with honest caveats about how much to trust them.

**Browser-only.** The pipeline decodes through `<video>`, canvas and `OfflineAudioContext` —
there is no Node path. It is battle-tested on the platforms that fight back (iOS Safari's
reluctant decoders, MediaRecorder webm files with no duration in the container, Android pickers
that hand over files with no MIME type).

## Install

Not on npm yet. Until then:

```sh
bun add github:dested/video-to-prompt
```

## Quick start

```ts
import { distill } from 'video-to-prompt'

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
plug in — a hosted API, an on-device model, anything. `encodeWav` wraps the samples in the one
container every speech API accepts.

```ts
import { distill, encodeWav, type Transcriber } from 'video-to-prompt'

const whisperViaMyServer: Transcriber = {
  id: 'groq', // 'whisper' | 'groq' are named in the report; any other string prints as-is
  run: async (audio, { signal }) => {
    const res = await fetch('/api/transcribe', { method: 'POST', body: encodeWav(audio), signal })
    if (!res.ok) return null // null = ship without words, never fail the run
    return await res.json() // [{ t: msFromStart, d?: spokenMs, text }, …]
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

## The output package

```
report.md            the whole walkthrough in order, on one timeline — built for LLM reading
MANIFEST.txt         plain-text listing + transcripts, for tools that don't render markdown
rec-01/
  walkthrough.mp4    the raw clip, named for the container it actually arrived in
  frames/NN-mmss.jpg deduped keyframes (64×64-cell signature dedup, length-scaled budget)
  grids/grid_NN.jpg  3×3 contact sheets of consecutive keyframes
  transcript.txt     the words alone, with timing windows
  recording.json     machine-readable: frame times, transcript windows, events
rec-02/ …            one folder per clip, laid end to end on one clock
```

Why contact sheets? A model reading nine consecutive frames side by side in one image follows
motion and progression far better than the same frames seen one at a time — at roughly an eighth
of the tokens. The report leads with them and inlines full stills only where the narration is
pointing at something.

## Pieces, exported individually

`distill()` is the front door; each stage is public for callers that need one alone.

| Export | Does |
| --- | --- |
| `probeClip(file)` | duration / dimensions / has-video / poster still, without committing to anything |
| `extractFrames(file, durationMs)` | seek-step keyframe extraction: dedup + beat frames + uniform thin to a length-scaled budget |
| `makeGrids(frames)` | 3×3 contact sheets, batched to match the report's frame→sheet map |
| `decodeMono(file)` / `encodeWav(samples)` | narration → 16 kHz mono Float32 → 16-bit PCM WAV |
| `buildReport` / `buildManifestTxt` / `buildRecordingJson` / `buildTranscriptTxt` | the format's writers |
| `partSpans` / `linePos` / `framePos` / `totalMs` | the unified timeline every position comes from |
| `containerFor` / `contentTypeFor` / `slugify` / `mmss` … | naming and formatting the file set depends on |

## Constraints worth knowing

- **Memory order is load-bearing.** Audio is decoded and released before a single frame is
  extracted; overlapping the two is what kills a phone tab. `distill` handles this — keep the
  discipline if you compose the stages yourself.
- **Keyframes are best-effort.** A decoder that refuses to seek-step (iOS, long clips) costs the
  walkthrough its stills, never the walkthrough: video, transcript and report still ship.
- **Candidate cadence is 1 s**, not the 500 ms a live recorder samples at — a seek-step pays a
  full decode per candidate, and on iOS that is the entire cost of the run.
- **Timings are sacred.** The polish hook may only rewrite text; a response with a different line
  count is discarded. Frame `t` values survive thinning, so transcript citations stay valid.

## Status

Extracted from [Handback](https://handback.dev)'s phone/upload pipeline (itself a port of its
recorder extension's live pipeline). npm publish is planned; the API may still move until then.
