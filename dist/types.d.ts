/**
 * The pipeline's vocabulary. Two halves:
 *
 * 1. The public surface a caller codes against — stages, progress, clip inputs,
 *    the files a distill run produces.
 * 2. The recording shapes — the on-disk format of a distilled walkthrough. These
 *    are frozen by their readers: `report.md`, `recording.json`, the MANIFEST
 *    and anything downstream that parses them all read exactly these fields.
 */
import type { ClipProbe } from './probe.js';
export type DistillStage = 'probe' | 'audio' | 'transcribe' | 'polish' | 'frames' | 'sheets' | 'build';
export interface StageProgress {
    stage: DistillStage;
    /** 0..1 across the whole run. -1 = indeterminate (no meaningful fraction). */
    pct: number;
    detail?: string;
}
/**
 * One recorded file the caller picked. `probe` is the read a picker UI already
 * did: on iOS, readying a blob-URL video costs the better part of a minute, so
 * a caller that has one hands it over rather than making the pipeline pay twice.
 */
export interface ClipInput {
    file: File;
    probe?: ClipProbe;
}
/** One file of the output set, at the walkthrough-relative path it lives under. */
export interface OutputFile {
    /** Forward slashes: `report.md`, `rec-01/frames/03-0125.jpg`. */
    path: string;
    blob: Blob;
    contentType: string;
}
/**
 * The format this library writes, stamped into recording.json and the
 * MANIFEST. Format 1 (unstamped) is everything before it. Format 2 adds frame
 * `change`/`held`/`transient`, the `narration` and `end` reasons, the
 * transcriber's own label and the sampling engine, and changes the meaning of
 * `dist` (see RecordingFrame). Readers of format 1 keep working: nothing was
 * removed or renamed.
 */
export declare const FORMAT = "video-to-prompt/2";
export interface PageEvent {
    level: 'error' | 'warn' | 'network';
    message: string;
    detail?: string;
    ts: number;
}
/**
 * Which engine wrote the transcript that shipped. Any string; the report
 * prints `transcriberLabel` when the recording has one, else this id. Absent
 * on a take with words means live dictation (Web Speech).
 */
export type TranscriberId = 'whisper' | 'groq' | (string & {});
export interface TranscriptSegment {
    /** ms from recording start — where the speaker *started* the line */
    t: number;
    /** Spoken length in ms when the transcriber reported one. A line covers a window, not an instant. */
    d?: number;
    /** Position on the walkthrough's unified axis, ms. Set only when a human moved it; absent = computed from t. */
    tl?: number;
    text: string;
    /** 1-based speaker rank AFTER normalization (rank 1 = most talk time); absent when diarization didn't run. */
    speaker?: number;
}
/** The pointer as it applies to one keyframe. Only a live screen recorder can set it. */
export interface FramePointer {
    nx?: number;
    ny?: number;
    selector?: string;
    text?: string;
}
export interface RecordingFrame {
    index: number;
    /** ms from recording start */
    t: number;
    /** Path relative to the take dir, e.g. frames/03-0125.jpg */
    file: string;
    /**
     * Why this frame exists. After-the-fact extraction produces `start`,
     * `change`, `beat`, and from format 2 `narration` (a spoken line had no
     * frame, so one was taken inside it) and `end` (the final state). `click`
     * and `nav` only come from a live recorder; the union stays whole so a
     * reader of this shape is the reader of a live recorder's too.
     */
    reason: 'start' | 'change' | 'click' | 'nav' | 'beat' | 'narration' | 'end';
    /**
     * Changed cells vs the closest of the last kept frames (absent on the first).
     * Format 1: of a 64×64 RGB grid. Format 2: of a 160-column luma grid whose
     * rows follow the aspect ratio (160×90 at 16:9).
     */
    dist?: number;
    /** Format 2: where this frame differs from the keyframe before it, 0..1 of the frame. Absent when the whole screen changed. */
    change?: FrameBox;
    /** Format 2: how long this state stayed on screen, ms. */
    held?: number;
    /** Format 2: the screen went back to how it was before this frame (a toast, a flash of an error, a hover). */
    transient?: boolean;
    pointer?: FramePointer;
    tl?: number;
}
/** A rectangle as fractions of the frame: x, y from the top-left, w, h its size. */
export interface FrameBox {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface RecordingMeta {
    startedAt: number;
    durationMs: number;
    /** Candidate frames examined; frames[] is what survived dedup. */
    sampled: number;
    frames: RecordingFrame[];
    transcript: TranscriptSegment[];
    transcriber?: TranscriberId;
    /** Format 2: the transcriber's own description of itself, printed where the report says who wrote the words. */
    transcriberLabel?: string;
    /** Format 2: how frames were sampled — which engine, and how far apart candidates were. */
    sampling?: {
        engine: string;
        stepMs: number;
    };
    /** A cleanup pass rewrote the wording. Timings are the transcriber's either way. */
    polished?: boolean;
    rev?: number;
    reviewed?: boolean;
    events: PageEvent[];
    eventScope?: string;
    droppedEvents?: number;
    /** The take's video, named for the container it actually arrived in. */
    videoFile: string;
}
/** One take. A walkthrough is one or more of them laid end to end on one clock. */
export interface Recording {
    id: string;
    sessionId: string;
    /** 1-based part number; names the rec-NN folder. */
    index: number;
    createdAt: number;
    state: 'recording' | 'done';
    interrupted?: boolean;
    mime: string;
    chunks: number;
    meta: RecordingMeta;
}
export interface Session {
    id: string;
    name: string;
    slug: string;
    createdAt: number;
    updatedAt: number;
    origin: string;
    recCount: number;
}
/** Contact sheet shape. The sheet builder and the report that cites the sheets must agree. */
export declare const GRID_COLS = 3;
export declare const GRID_ROWS = 3;
export declare const GRID_PER_SHEET: number;
