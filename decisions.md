# Decisions

## 2026-08-06 — Extracted from Handback as a standalone library

**Why:** the distill pipeline (video → keyframes/sheets/transcript/report) is wanted in other
projects, and Handback already maintains two copies (extension live pipeline + `src/lib/capture/`
port). A third copy would be absurd; a package is the exit.
**Rejected:** monorepo package inside handback (repo is private; the library should be public),
moving Handback onto the package immediately (its copy stays until a quiet moment — the phone
pipeline just stabilized and re-testing it on-device is the expensive part).

## 2026-08-06 — Browser-only, zero runtime dependencies

**Why:** the pipeline is built on `<video>` seek-stepping, canvas, and `OfflineAudioContext`,
and its hard-won behavior is exactly about real browser decoders (iOS wake-ups, webm Infinity
duration). A Node path would be a second implementation (ffmpeg/WebCodecs), not a port.
**Rejected:** ffmpeg-wasm fallback (huge, and no consumer needs it yet), WebCodecs (Safari
coverage still the constraint).

## 2026-08-06 — Transcription and polish are plug points, not features

**Why:** speech-to-text and LLM cleanup require keys and infrastructure the library must not
own. `Transcriber`/`Polisher` interfaces keep the library dependency- and network-free; the
consumer brings Groq/Whisper/whatever. `encodeWav` is exported so a hosted transcriber costs the
consumer three lines.
**Rejected:** shipping a Groq client (keys in a browser lib), baking in on-device Whisper (a
worker + model download is an app concern).

## 2026-08-06 — Report wording is parameterized (`ReportOptions`), format is not

**Why:** the emitted file set is a frozen contract with external readers (Handback viewer,
push CLI, MCP brief), but strings like "Recorded with the Handback Recorder" and "pull with the
`get_walkthrough` MCP tool" are product voice. Options `url/urlHint/source/pathsHint/polishedBy`
carry the voice; defaults describe a bare folder.
**Rejected:** hardcoding neutral strings only (Handback couldn't keep its wording), a template
system (five strings don't need one).

## 2026-08-06 — strict TS, but no `noUncheckedIndexedAccess`

**Why:** faithful port of code whose hot loops index `Uint8ClampedArray` signatures per pixel
cell; the flag would force non-null assertions or bounds noise through exactly the code that must
stay byte-identical in behavior to Handback's copy. Matches the source repo's compiler settings.
**Rejected:** enabling the flag and littering `!` (worse than the disease).

## 2026-08-06 — npm name deferred; MIT license

**Why:** publish isn't today's job; whether `video-to-prompt` is free on npm gets checked at
publish time (fallback: `@dested/video-to-prompt`). MIT because the repo is public and the code
is a utility, not a moat.

## 2026-10-15 — Format v2, and this library becomes Handback's only pipeline

**Why:** the fresh-eyes evaluation (plans/2026-10-15-fresh-eyes-evaluation.md) found Handback runs
its own drifted copies, so nothing improved here reached the product that matters most; and the
v1 contact sheets (1440 px, 480 px tiles) are unreadable to Opus 5.5. Sal: Handback web + extension
import this package and delete their copies; the format is versioned (`video-to-prompt/2`) so
sheets, change boxes and report.md can change while every reader keeps working.
**Rejected:** hand-mirroring three ways forever; additive-only v1 (keeps the illegible sheets).

## 2026-10-15 — WebCodecs via mediabunny, seek-stepping as fallback (supersedes 2026-08-06 browser-only/zero-deps)

**Why:** seek-stepping pays a decode per candidate, which forced the 1 s cadence that misses
toasts and error flashes; sequential WebCodecs decode makes ~250 ms affordable and demuxes audio
without loading the whole file into one ArrayBuffer. mediabunny (already in Handback) is the one
runtime dependency, dynamic-imported so the package still imports cleanly under SSR. Seek-stepping
stays for decoders that refuse (older iOS).
**Rejected:** hand-rolled demuxers (that is mediabunny), ffmpeg-wasm (size), seek-step only.

## 2026-10-15 — Ship on npm as @dested/video-to-prompt

**Why:** `github:` + `prepare` made every consumer build tsc on install; coterie vendored dist to
dodge Vercel's limit and bx builds in place. Sal chose the scoped name.
**Rejected:** bare `video-to-prompt`, GitHub release tarballs.

## 2026-10-15 — Keyframes chosen by a pure Selector over 160-column luma signatures

**Why:** v1 deduped on a 64×64 RGB grid against the previous candidate, then thinned uniformly:
small changes vanished (one digit, a toast) and thinning dropped evidence at random. v2 measures
against kept frames, requires a _major_ change (a 12-cell region or 40 cells), waits for the
screen to settle, keeps snap-backs as `transient`, gives every narration line a frame, and spends
the budget on novelty. A decaying busy-cell heat mask (dilated 3×1 per event) silences clocks,
spinners and live captions. Pure and DOM-free so it is unit-tested and replayable from dumps
(`test/browser/sigdump.ts` + `tune.ts`), and a live recorder can share it.
**Rejected:** mediabunny `samplesAtTimestamps` (null for 137/144 times on cue-less webm; a
sequential sink is used instead); summing neighbour heat (killed the toast and tooltip); an
`ignore` region option for recorder chrome (deferred until Handback passes its own geometry).

## 2026-10-15 — Report v2: evidence first, the transcriber names itself

**Why:** v1 opened with a 25-line blockquote of reading instructions before any evidence. v2 is
one intro paragraph, then "Start here" (3–6 frames: complaint lines' best frames, the final
state, then by worth; nearby errors named), sheets, and a timeline with one described line per
frame. The hard-coded groq/whisper display mapping is gone: `Transcriber.label` says who wrote
the words, so a new engine never needs a library release.
**Rejected:** keeping the preamble for weaker models (Opus 5.5 is the target), inlining stills
in the report (the agent opens frames by path; sheets are the overview).

## 2026-10-15 — `noUncheckedIndexedAccess` on (supersedes 2026-08-06)

**Why:** the port-fidelity reason is gone: signature, selection, decode and audio were
rewritten. `?? 0` on typed-array reads costs nothing measurable, and Sal's global rules prefer
the flag.

## 2026-10-15 — Relative imports carry `.js`

**Why:** the npm package must load under bare Node ESM, not only bundlers (the 2026-08-06
gotcha said revisit before publish). mediabunny stays a dynamic import so importing the package
never touches it.

## 2026-10-15 — A reader for recording.json; hosts rebuild report.md from the files

**Why:** Handback serves agents a report frozen at upload: format 1 for most walkthroughs, stale
after a re-transcribe or a reviewer's cut. `readRecordingJson` (pure, zod-free, tolerant of
formats 1 and 2 and of the extension's shape) lets a server run `buildReport` over the stored
files on every pull. `RecordingMeta.format` stops a format 1 take claiming "most of the screen
changed". `ReportOptions.cuts`/`captions` and `evidenceAt` are generic host hooks (a reviewer's
removed stretches, a vision model's captions, evidence for a summary's pinned moment), so the
host never forks the report. `recording.json` gained `polished`, `tlMs` and event `tMs` so the
round trip is exact; all additive, still format 2.
**Rejected:** a reader in each host (three drifting copies again), zod in the library (a second
runtime dep for one parser), bumping to format 3 (nothing was removed or renamed).

## 2026-10-22 — No frame cap: a page model decides, not a budget

**Why:** Sal's bar for Handback is 30 to 60 minute takes with nothing lost, whatever it costs.
The 600-frame cap thinned qg (28 min reading one doc) into 600 near-identical frames, a third of
them repeats. A second, finer signature grid (`scroll.ts`) places scrolled views on a page, so a
frame is kept for rows nobody has seen yet or for what changed in place, and a passage come back
to costs nothing (`seen`). Small changes become `detail` close-ups of the last full frame.
**Rejected:** a smarter budget (any cap drops something on a long enough take), tuning the
budget per minute (still a cap), masking the recorder panel as chronic change (crop it instead:
`ClipInput.crop`).

## 2026-10-22 — Video is found per block, over 20 seconds

**Why:** a Meet call (six webcams filling the screen) made 2145 frames: webcam change is too
sparse per cell for the heat mask, and a still wall in a tile changes whenever an arm sweeps
past. An 8×8-cell block that changed in 10% of the last 80 steps is video; it and its neighbours
are left out while anything near changed in the last 10 s. What must not vote was found on real
takes: large steps, the second around a scroll, one or two pointer blobs, wide strips (a line
selected, a row lit by hover). Each was a qg regression first.
Each keyframe remembers its own video blocks, so a call come back to from another window
matches its old frame instead of making new ones, and a window switch wipes the video history of
what it repainted, so the window that replaced the call is never masked by it.
Video gone still stays left out unless it now differs from the keyframe by a new picture's worth
(40 cells): a face that settled a few cells from where it sat made a frame per narration line
(toothio 227 → 175).
**Rejected:** a 4 s window at 50% (webcams change on 10 to 40% of steps), masking only while a
block itself changes (a face holding still for a second then made a frame), lookahead (the
Selector is online; a scroll takes back the votes just before it instead), one global video map
for the take (the terminal shares the call's blocks).

## 2026-10-22 — The test harness compares against the old output, side by side

**Why:** audits measure rows lost and repeats, but not whether Sal likes what comes out, and
they mean nothing on video (every sample of a webcam call is "unseen"). `test/compare/build.ts`
writes a static page per take: source video, old frame and new frame at the same moment, a
timeline, a per-minute grid. zod is a devDependency for its parser only.
**Rejected:** a published artifact (corpus takes carry other people's faces and private docs;
the pages stay on disk).
