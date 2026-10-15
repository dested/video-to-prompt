import type { FrameEngine } from './decode.js';
import { type ReportOptions } from './report.js';
import type { ClipInput, OutputFile, Recording, Session, StageProgress, TranscriberId, TranscriptSegment } from './types.js';
/**
 * What a transcriber hands back: the lines, or the lines plus the engine that
 * actually wrote them, for a transcriber that routes between several (a hosted
 * endpoint that prefers one provider and falls back to another).
 */
export type Heard = TranscriptSegment[] | {
    segments: TranscriptSegment[];
    label?: string;
};
/** Speech-to-text over the decoded narration. Return null to ship without words — never throw for "no transcript". */
export type TranscribeFn = (audio: Float32Array, ctx: {
    /** Always `SAMPLE_RATE` (16 kHz mono). */
    sampleRate: number;
    /** 0..1 through this clip's transcription. */
    onProgress: (fraction: number) => void;
    signal?: AbortSignal;
}) => Promise<Heard | null>;
export interface Transcriber {
    /** Short stable id, stored in recording.json ('whisper', 'groq', anything). */
    id: TranscriberId;
    /** How the report names it where it says who wrote the words (e.g. "Whisper large-v3-turbo, hosted"). Default: the id. A label `run` returns wins. */
    label?: string;
    run: TranscribeFn;
}
/**
 * The cleanup pass after transcription: fix what a speech engine can't know —
 * product nouns, library names, acronyms. Must return the SAME number of
 * segments with only `text` changed, or null to keep the originals. Timings
 * never cross this boundary.
 */
export type Polisher = (segments: TranscriptSegment[], ctx: {
    signal?: AbortSignal;
}) => Promise<TranscriptSegment[] | null>;
export interface DistillOptions {
    title: string;
    /** No transcriber = the walkthrough ships without words. */
    transcriber?: Transcriber;
    /** No polisher = the transcript ships as transcribed. */
    polish?: Polisher;
    onProgress?: (p: StageProgress) => void;
    signal?: AbortSignal;
    /** Branding/wording for report.md and MANIFEST.txt. */
    report?: ReportOptions;
    /** Contact sheet width in px. Default 2000 (Claude Code's display limit); 2576 suits a model fed through the API. */
    sheetWidth?: number;
    /** Frame decoding: 'auto' (default) uses WebCodecs where it can and seeks otherwise. */
    frameEngine?: FrameEngine | 'auto';
    /** Put each take's own video in the file set. Default true. */
    includeVideo?: boolean;
    /**
     * Pull keyframes and draw contact sheets. Default true. False when the video
     * itself is the deliverable and stills would only be storage: the takes
     * carry no frames and the stage never reports progress.
     */
    keyframes?: boolean;
}
export interface DistillOutput {
    session: Session;
    takes: Recording[];
    /** The whole file set: report.md, MANIFEST.txt, rec-NN/… — paths are walkthrough-relative. */
    files: OutputFile[];
    /** Same bytes as the `report.md` entry in `files`, for callers that want the text directly. */
    report: string;
    manifest: string;
    frameCount: number;
    lineCount: number;
    durationMs: number;
    transcribed: boolean;
    polished: boolean;
}
export declare function distill(clips: ClipInput[], opts: DistillOptions): Promise<DistillOutput>;
