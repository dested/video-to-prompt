# Fresh-eyes evaluation of video-to-prompt

- **Date:** 2026-10-15
- **Status:** active
- **Type:** analysis
- **What:** what the pipeline does, how its output actually lands in front of Opus 5.5, and the ranked list of what to change

## How I evaluated

- Read all of `src/` (2,147 lines), the kit docs, and the three consumers: Handback
  (`src/lib/capture/`, `server/mcp-format.ts`, `server/mcp.ts`, `server/refine.ts`), coterie
  (`G:\code\coterietax.com\src\lib\tutorials\record-client.ts`, vendored dist) and bx
  (`src/daemon/harness/*`, `scripts/build-harness.ts`).
- Pulled one real resolved walkthrough through the Handback MCP (Coterie space, 36 s, 16 frames)
  and read the brief exactly as an agent receives it, plus its `report.md`, `grid_01.jpg` and one
  full keyframe, as Opus 5.5 sees them through Claude Code's Read.
- Built test sheets from that keyframe at 3×3 and 2×2, 2576 px wide, to measure legibility.
  Claude Code's Read displays images at most 2000 px wide; the API cap for Opus 5.5 is 2576 px /
  3.75 MP (~4,784 tokens).

## Who actually runs this code

| Consumer                                      | Uses                                                                                          | How it installs                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Handback web (`/phone`, `/upload`, `/record`) | **its own copy** in `src/lib/capture/`                                                        | n/a: not a dependency                                                                                                       |
| Handback extension                            | **its own copy** in `extension/src/lib/`                                                      | n/a                                                                                                                         |
| coterie                                       | `probeClip`, `extractFrames`, `makeGrids`, `decodeMono`/`encodeWav` (no `distill`, no report) | vendored compiled `dist/` at commit `0f57b7d`, because the `github:` dep's `prepare` build blew Vercel's 45-min limit       |
| bx                                            | `distill` + report, inside a headless-browser harness page                                    | `github:` dep plus a script that builds it in place when `dist/` is missing; regex-rewrites the report's wording afterwards |

So the library is the **fourth** copy of the pipeline, and the one Handback doesn't run. The
cliffnotes call Handback-consumes-the-package "the standing next step"; it hasn't happened, and
the copies have drifted (`distill.ts` 628 lines different, `report.ts` 157, `types.ts` 79).
**Nothing improved here reaches Handback until Handback imports it.**

## What Opus actually receives from Handback (the real brief)

1. `--- digest ---`, `--- key points ---`, metadata JSON, `--- summary ---`, then
   `--- report.md ---`, which is **Refine's `refinedBriefMd`, not this library's report.md**.
   The library-format report is only reachable as a presigned URL.
2. The human's **verbatim words appear nowhere** in the brief: digest, key points, summary and
   refined brief are four LLM paraphrases of one 36-second clip, saying the same thing four times.
3. Every image is a **~600-character presigned URL** (≈ 150–200 tokens of noise each). 2 of 16
   frames were curated; the contact sheets are listed as plain file URLs with no instruction.
   To _see_ anything the agent has to `curl` each URL to disk and `Read` it. No MCP image
   content blocks are returned.
4. The library-format `report.md` for the same walkthrough (for reference):
   - "16 of 16 keyframes are inlined below": to an agent, "inlined" means 16 paths it must open
     one by one, with no indication which 2 matter.
   - One Web Speech line stamped **0:02–0:48 on a 0:36 clip**: the line end is estimated from
     word count (380 ms/word) and never clamped to the take.
   - Title rendered as "Walkthrough — Walkthrough".

## Visual findings (the big one)

| Image                                                  | Size      | Opus 5.5 tokens (≈ w·h/750) | Legible to Opus 5.5?                                                   |
| ------------------------------------------------------ | --------- | --------------------------- | ---------------------------------------------------------------------- |
| Current `grid_01.jpg` (3×3, 480 px cells)              | 1440×876  | ~1,680                      | **No.** Not one word of UI text readable. Layout and scrolling only    |
| Full keyframe                                          | 1920×1080 | ~2,765                      | Yes, fully                                                             |
| Test 3×3 sheet, displayed at 2000 wide (~667 px cells) | 2000×1126 | ~3,000                      | Headings, banners, URL bar, labels: **yes**. Small body text: marginal |
| Test 2×2 sheet, displayed at 2000 wide (1000 px cells) | 2000×1126 | ~3,000                      | Yes, essentially fully                                                 |

The sheet sizes date from the 1568 px / ~1,600-token era. On Opus 5.5 the current sheets are
~1/15 the tokens of nine frames but carry almost no readable evidence. A 2000 px 3×3 sheet is
~1/8 the tokens of nine frames and reads. The report tells the agent to "read these first", so
today an agent that does as told sees motion and learns little.

Also visible: the frames are window captures including browser chrome and the recorder's own
side panel and floating bar. That's fine (the URL bar is evidence), but it means ~25% of every
tile is the recorder's own UI.

## Engine findings

- **Seek-stepping is the cost and the ceiling.** One `<video>` seek per 1 s candidate; on sparse
  keyframe webm each seek decodes from the previous keyframe. That's why the cadence is 1 s, and 1 s
  misses transient states (a toast, a flash of an error, a hover menu) that are often _the_ bug.
  WebCodecs sequential decode (mediabunny is already a Handback dependency) is O(1) per frame,
  makes 250 ms or denser sampling affordable, and can demux audio without reading the whole file
  into one ArrayBuffer. Keep seek-stepping as the fallback for decoders that refuse.
  (decisions.md 2026-08-06 rejected WebCodecs over Safari coverage; worth reopening, flagged.)
- **The dedup signal is blind to small changes.** 64×64 RGB cells over a 16:9 frame (each cell ≈
  30×17 px, aspect squashed), a cell counts only if a channel _mean_ moves > 25, and a frame needs
  > 8 changed cells. A digit changing in 13 px text, a checkbox, a small validation message: all
  > averaged away, recovered only by the 15 s beat if at all.
- **Thinning is uniform.** Past the budget (40/min), frames are dropped by stride, so a big change
  and a near-duplicate have equal odds. Selection should score (change size, narration window,
  novelty) and keep coverage.
- **Memory:** every kept candidate is JPEG-encoded _before_ thinning (up to 1,800 blobs on a long
  busy clip, then thinned to 600). A two-pass design (signatures first, decide, then encode only
  keepers) bounds memory and enables the scoring above.
- **The final state can be missed.** Sampling stops at the last step before `durationMs`; the end
  of a recording ("…and see, it's broken") deserves a guaranteed frame.
- **Cancellation** is string-matched (`message === 'cancelled'`) and never reaches an in-flight
  seek, so a cancel can wait up to 20 s.
- **`engineName` hardcodes Handback's models** ('groq' → "Whisper large-v3-turbo", 'whisper' →
  "Whisper small.en"); recording.json says `transcriber: 'webspeech'` when there is no transcript.
- **No format version** anywhere, though the docs say "version it".

## Distribution and quality gates

- `github:` + `prepare` forces every consumer to build tsc on install; each consumer has
  invented its own workaround (vendor, build-in-place script, a copy).
- Extensionless ESM output breaks bare Node / Bun-without-bundler imports.
- No tests at all; the report writers are pure functions that beg for golden snapshots, and bx
  already proves the whole pipeline can run headless in Chrome for an end-to-end fixture test.

## Ranked improvements

**Structure (decides whether anything else matters)**

1. Make the library the single pipeline: Handback web + extension import it (including the live
   recorder's dedup primitives that `live.ts` borrows), delete the copies.
2. Ship real artifacts (npm or prebuilt release), ESM with explicit extensions, a `format`
   version in recording.json + MANIFEST.
3. Tests: golden report/manifest/recording.json snapshots; a headless-Chrome fixture run on
   short known videos (toast at 0:03.4, number change, scroll) asserting which frames survive.

**What the model sees** 4. Legible sheets: 2000 px wide (configurable, 2576 for API consumers), tiles labeled with
timeline time, aspect-correct contain-fit. 5. Change boxes: we already know which cells changed; draw the changed region on each tile and
store `change: {x,y,w,h}` in recording.json. Optional zoom crop for small changes. 6. Report v2 for Opus-class readers: a short preamble; a ranked "open these first" list (3–6
frames: biggest change inside a narration window); best-frame-per-line instead of a uniform
spread; clamp line ends; honest wording ("listed", not "inlined"); a narration-source option
(speech vs action log) replacing bx's regex rewrite; transcriber label from the caller.

**Engine** 7. Two-pass extraction with scored selection, bounded memory, guaranteed final frame. 8. Higher-resolution grayscale signature (aspect-preserving) so small text changes register. 9. WebCodecs/mediabunny fast path (denser sampling, audio-only demux), seek-step fallback. 10. AbortSignal through every wait.

**Handback side (biggest Opus lever, outside this repo)**

- H1. `get_walkthrough` returns contact sheets + the top frames as MCP image blocks.
- H2. Replace inline presigned URLs with a path-addressed `get_file` tool or short links.
- H3. Always include the verbatim transcript; collapse digest/summary/key-points/brief redundancy.

## Open questions (asked 2026-10-15)

- Handback onto the library as the single pipeline? Handback MCP in scope?
- Freedom to version the format (sheet size, change boxes, report v2)?
- npm publish name; a CLI that distills a video on disk via headless Chrome?

## Progress (2026-10-15)

- Library side of the ranked list is built and measured (see cliffnotes Status and the review page
  https://claude.ai/artifact/NbTveyzKvZNgdSqka4Z1nG). Uncommitted, pending Sal's approval.
- Remaining before this plan is done: commit, npm publish, Handback web + extension migration and
  MCP brief (H1–H3), bx and coterie switch-over, then delete
  `W:\junk\video-to-prompt\sample-7fa3\` (Coterie PII).
