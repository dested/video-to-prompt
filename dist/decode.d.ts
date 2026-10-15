/**
 * Pixels out of a recorded file, at the times the extractor asks for. Two
 * engines behind one shape:
 *
 *  - **webcodecs**: mediabunny demuxes the container and the platform's
 *    VideoDecoder decodes it front to back. Every packet is decoded once, so a
 *    candidate costs a canvas draw rather than a seek, and dense sampling is
 *    affordable. mediabunny is imported on first use, so an SSR import of this
 *    library never loads it.
 *  - **seek**: an offscreen `<video>` stepped one seek per candidate. Each seek
 *    decodes from the previous keyframe; it is the engine every browser has,
 *    and the fallback whenever WebCodecs is missing, refuses the codec, or
 *    fails partway (the remaining times continue on it).
 */
export type FrameEngine = 'webcodecs' | 'seek';
export interface SourceFrame {
    /** The requested time, ms from clip start. */
    t: number;
    /** Display size of the frame. */
    width: number;
    height: number;
    /** Draw the frame scaled into (0, 0, dw, dh). Valid only until the iterator advances. */
    draw(ctx: CanvasRenderingContext2D, dw: number, dh: number): void;
}
export interface FrameSource {
    readonly engine: FrameEngine;
    /** The frame shown at each of `times` (ascending ms), skipping any the decoder could not produce. */
    frames(times: number[], signal?: AbortSignal): AsyncGenerator<SourceFrame, void, undefined>;
    close(): void;
}
export interface OpenOptions {
    /** 'auto' (default) tries WebCodecs and falls back to seeking. */
    engine?: FrameEngine | 'auto';
    signal?: AbortSignal;
}
export declare function openFrameSource(file: Blob, opts?: OpenOptions): Promise<FrameSource>;
