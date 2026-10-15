/**
 * video-to-prompt — distill a narrated screen recording into an agent-ready
 * prompt package. Browser-only: the pipeline decodes through WebCodecs (via
 * mediabunny, loaded on first use) with `<video>` seeking as the fallback,
 * canvas, and OfflineAudioContext. `distill()` is the front door; everything
 * else is the pieces it is made of, exported for callers that need one stage
 * alone (and for live recorders that want the same signature and selection
 * rules).
 */

export * from './types.js'
export {
  distill,
  type DistillOptions,
  type DistillOutput,
  type Polisher,
  type TranscribeFn,
  type Transcriber,
} from './distill.js'
export { probeClip, type ClipProbe, type ProbeOptions } from './probe.js'
export {
  candidateTimes,
  extractFrames,
  frameBudget,
  readSignature,
  type ExtractOptions,
  type ExtractedFrames,
} from './frames.js'
export {
  openFrameSource,
  type FrameEngine,
  type FrameSource,
  type OpenOptions,
  type SourceFrame,
} from './decode.js'
export {
  diffSignatures,
  LUMA_TOL,
  SIG_COLS,
  sigRows,
  signatureFromRgba,
  unionBox,
  type CellBox,
  type ChangeRegion,
  type DiffOptions,
  type SigDiff,
  type Signature,
} from './signature.js'
export {
  isMajor,
  MAJOR_REGION,
  MAJOR_TOTAL,
  Selector,
  type Box,
  type NarrationWindow,
  type Pick,
  type PickReason,
  type SelectAction,
  type SelectorOptions,
  type Slot,
} from './select.js'
export { makeGrids, SHEET_WIDTH, type GridFrame, type GridOptions } from './grids.js'
export { decodeMono, encodeWav, SAMPLE_RATE, type DecodeOptions } from './audio.js'
export { abortable, CancelledError, isCancelled, throwIfAborted } from './cancel.js'
export { containerFor, contentTypeFor, type ClipContainer } from './container.js'
export {
  buildManifestTxt,
  buildRecordingJson,
  buildReport,
  buildTranscriptTxt,
  evidenceAt,
  rankFrames,
  sheetFile,
  whereOnScreen,
  type Evidence,
  type RankedFrame,
  type ReportCut,
  type ReportOptions,
} from './report.js'
export { readRecordingJson, type ReadTake } from './read.js'
export { framePos, linePos, partSpans, totalMs, type PartSpan } from './timeline.js'
export { dateTime, hhmm, mmss, mmssFile, pad2, recDirName } from './format.js'
export { slugify } from './slug.js'
