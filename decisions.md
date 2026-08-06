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
