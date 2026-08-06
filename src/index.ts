/**
 * video-to-prompt — distill a narrated screen recording into an agent-ready
 * prompt package. Browser-only: the pipeline decodes through <video>, canvas
 * and OfflineAudioContext. `distill()` is the front door; everything else is
 * the pieces it is made of, exported for callers that need one stage alone.
 */

export * from './types'
export {
  distill,
  type DistillOptions,
  type DistillOutput,
  type Polisher,
  type TranscribeFn,
  type Transcriber,
} from './distill'
export { probeClip, type ClipProbe } from './probe'
export { extractFrames, frameBudget, type ExtractOptions, type ExtractedFrames } from './frames'
export { makeGrids, type GridFrame } from './grids'
export { decodeMono, encodeWav, SAMPLE_RATE } from './audio'
export { containerFor, contentTypeFor, type ClipContainer } from './container'
export {
  buildManifestTxt,
  buildRecordingJson,
  buildReport,
  buildTranscriptTxt,
  sheetFile,
  type ReportOptions,
} from './report'
export { framePos, linePos, partSpans, totalMs, type PartSpan } from './timeline'
export { dateTime, hhmm, mmss, mmssFile, pad2, recDirName } from './format'
export { slugify } from './slug'
