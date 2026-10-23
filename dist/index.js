/**
 * video-to-prompt — distill a narrated screen recording into an agent-ready
 * prompt package. Browser-only: the pipeline decodes through WebCodecs (via
 * mediabunny, loaded on first use) with `<video>` seeking as the fallback,
 * canvas, and OfflineAudioContext. `distill()` is the front door; everything
 * else is the pieces it is made of, exported for callers that need one stage
 * alone (and for live recorders that want the same signature and selection
 * rules).
 */
export * from './types.js';
export { distill, } from './distill.js';
export { probeClip } from './probe.js';
export { candidateTimes, extractFrames, frameBudget, readSignature, } from './frames.js';
export { detailCrop } from './keeper.js';
export { LIVE_STEP_MS, LiveFrames } from './live.js';
export { openFrameSource, } from './decode.js';
export { diffSignatures, LUMA_TOL, SIG_COLS, sigRows, signatureFromRgba, unionBox, } from './signature.js';
export { isMajor, MAJOR_REGION, MAJOR_TOTAL, Selector, } from './select.js';
export { makeGrids, SHEET_WIDTH } from './grids.js';
export { decodeMono, encodeWav, SAMPLE_RATE } from './audio.js';
export { dropUnheard } from './unheard.js';
export { abortable, CancelledError, isCancelled, throwIfAborted } from './cancel.js';
export { containerFor, contentTypeFor } from './container.js';
export { buildManifestTxt, buildRecordingJson, buildReport, buildTranscriptTxt, evidenceAt, rankFrames, sheetFile, whereOnScreen, } from './report.js';
export { readRecordingJson } from './read.js';
export { framePos, linePos, partSpans, totalMs } from './timeline.js';
export { dateTime, hhmm, mmss, mmssFile, pad2, recDirName } from './format.js';
export { slugify } from './slug.js';
