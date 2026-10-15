import { type FrameEngine, type SourceFrame } from './decode.js';
import { type NarrationWindow } from './select.js';
import { type Signature } from './signature.js';
import type { RecordingFrame } from './types.js';
/** How many keyframes a take of this length may keep. A cap, not a target. */
export declare function frameBudget(durationMs: number): number;
export interface ExtractOptions {
    /** 0..1 through this clip. */
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
    /** The take's transcript: every line whose window passes with no keyframe gets one. */
    narration?: NarrationWindow[];
    /** 'auto' (default): WebCodecs where the browser can decode the file, seeking otherwise. */
    engine?: FrameEngine | 'auto';
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
/** Shrink a frame onto the signature grid (aspect kept) and read it back as luma. */
export declare function readSignature(ctx: CanvasRenderingContext2D, frame: SourceFrame): Signature;
