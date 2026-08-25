/**
 * The pipeline's vocabulary. Two halves:
 *
 * 1. The public surface a caller codes against — stages, progress, clip inputs,
 *    the files a distill run produces.
 * 2. The recording shapes — the on-disk format of a distilled walkthrough. These
 *    are frozen by their readers: `report.md`, `recording.json`, the MANIFEST
 *    and anything downstream that parses them all read exactly these fields.
 */

import type { ClipProbe } from './probe'

// ── the public surface ─────────────────────────────────────────────────────

export type DistillStage =
  | 'probe'
  | 'audio'
  | 'transcribe'
  | 'polish'
  | 'frames'
  | 'sheets'
  | 'build'

export interface StageProgress {
  stage: DistillStage
  /** 0..1 across the whole run. -1 = indeterminate (no meaningful fraction). */
  pct: number
  detail?: string
}

/**
 * One recorded file the caller picked. `probe` is the read a picker UI already
 * did: on iOS, readying a blob-URL video costs the better part of a minute, so
 * a caller that has one hands it over rather than making the pipeline pay twice.
 */
export interface ClipInput {
  file: File
  probe?: ClipProbe
}

/** One file of the output set, at the walkthrough-relative path it lives under. */
export interface OutputFile {
  /** Forward slashes: `report.md`, `rec-01/frames/03-0125.jpg`. */
  path: string
  blob: Blob
  contentType: string
}

// ── the recording shapes (the format; change with care) ────────────────────

export interface PageEvent {
  level: 'error' | 'warn' | 'network'
  message: string
  detail?: string
  ts: number
}

/**
 * Which engine wrote the transcript that shipped. `whisper` (on-device) and
 * `groq` (hosted Whisper) are the ids the report knows how to name; any other
 * string is printed as-is. Absent means live dictation (Web Speech).
 */
export type TranscriberId = 'whisper' | 'groq' | (string & {})

export interface TranscriptSegment {
  /** ms from recording start — where the speaker *started* the line */
  t: number
  /** Spoken length in ms when the transcriber reported one. A line covers a window, not an instant. */
  d?: number
  /** Position on the walkthrough's unified axis, ms. Set only when a human moved it; absent = computed from t. */
  tl?: number
  text: string
  /** 1-based speaker rank AFTER normalization (rank 1 = most talk time); absent when diarization didn't run. */
  speaker?: number
}

/** The pointer as it applies to one keyframe. Only a live screen recorder can set it. */
export interface FramePointer {
  nx?: number
  ny?: number
  selector?: string
  text?: string
}

export interface RecordingFrame {
  index: number
  /** ms from recording start */
  t: number
  /** Path relative to the take dir, e.g. frames/03-0125.jpg */
  file: string
  /**
   * Why this frame exists. After-the-fact extraction only ever produces
   * `start`, `change` and `beat` — there are no clicks or navigations to force
   * one — but the union stays whole so a reader of this shape is the reader of
   * a live recorder's too.
   */
  reason: 'start' | 'change' | 'click' | 'nav' | 'beat'
  /** Changed-cell count (of 64×64) vs the closest of the last kept frames (absent on the first). */
  dist?: number
  pointer?: FramePointer
  tl?: number
}

export interface RecordingMeta {
  startedAt: number
  durationMs: number
  /** Candidate frames examined; frames[] is what survived dedup. */
  sampled: number
  frames: RecordingFrame[]
  transcript: TranscriptSegment[]
  transcriber?: TranscriberId
  /** A cleanup pass rewrote the wording. Timings are the transcriber's either way. */
  polished?: boolean
  rev?: number
  reviewed?: boolean
  events: PageEvent[]
  eventScope?: string
  droppedEvents?: number
  /** The take's video, named for the container it actually arrived in. */
  videoFile: string
}

/** One take. A walkthrough is one or more of them laid end to end on one clock. */
export interface Recording {
  id: string
  sessionId: string
  /** 1-based part number; names the rec-NN folder. */
  index: number
  createdAt: number
  state: 'recording' | 'done'
  interrupted?: boolean
  mime: string
  chunks: number
  meta: RecordingMeta
}

export interface Session {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
  origin: string
  recCount: number
}

/** Contact sheet shape. The sheet builder and the report that cites the sheets must agree. */
export const GRID_COLS = 3
export const GRID_ROWS = 3
export const GRID_PER_SHEET = GRID_COLS * GRID_ROWS
