import { type FrameEngine, type SourceFrame } from './decode.js';
import { type NarrationWindow } from './select.js';
import { type Signature } from './signature.js';
import type { FrameBox, RecordingFrame } from './types.js';
/**
 * The old per-length cap (40 a minute, 150–600). Extraction no longer uses
 * one: a frame is kept because it shows something, never dropped for count.
 * @deprecated Kept for live recorders that still cap themselves; goes in 2.0.
 */
export declare function frameBudget(durationMs: number): number;
export interface ExtractOptions {
    /** 0..1 through this clip. */
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
    /** The take's transcript: every line whose window passes with no keyframe gets one. */
    narration?: NarrationWindow[];
    /** 'auto' (default): WebCodecs where the browser can decode the file, seeking otherwise. */
    engine?: FrameEngine | 'auto';
    /** Only this part of the picture (fractions of the frame). */
    crop?: FrameBox;
}
export interface ExtractedFrames {
    /** Kept frames in time order, numbered 1..N. */
    frames: RecordingFrame[];
    /** JPEG per kept frame, keyed by its index. Held in memory — a clip is one-shot. */
    blobs: Map<number, Blob>;
    /** Candidates examined. The MANIFEST reports it. */
    sampled: number;
    /** Which engine produced the candidates, and how far apart they were. */
    engine: FrameEngine;
    stepMs: number;
}
export declare function candidateTimes(durationMs: number, engine: FrameEngine): {
    times: number[];
    stepMs: number;
};
export declare function extractFrames(file: Blob, durationMs: number, opts?: ExtractOptions): Promise<ExtractedFrames>;
/** The region a detail is cut from: the change, padded, grown to a readable minimum, kept on screen. */
export declare function detailCrop(change: FrameBox): FrameBox;
/** Shrink a frame onto a signature grid (by default the change grid, aspect kept) and read it back as luma. */
export declare function readSignature(ctx: CanvasRenderingContext2D, frame: SourceFrame, cols?: number, rows?: number): Signature;
