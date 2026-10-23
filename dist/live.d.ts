import { type Decorate } from './keeper.js';
import type { FrameBox, RecordingFrame } from './types.js';
/**
 * The extractor's rule for a capture that is still running: a recorder hands
 * over its `<video>` of the screen share every LIVE_STEP_MS, and the frames it
 * gets back are the ones a finished clip of the same screen would get. The
 * Selector is online already; what this adds is the pixels. A held candidate
 * is copied when the Selector says hold, a kept one is encoded when it says
 * keep, and the recorder stores the JPEG under the pick's key, so a take that
 * dies mid-recording still has every frame decided so far.
 *
 * What a finished clip has that a live one doesn't is its transcript. The
 * recorder says when speech starts and stops instead (`openLine`/`closeLine`),
 * from its own voice detection, and each line gets its picture the same way.
 */
/** Candidate cadence: the extractor's WebCodecs step. */
export declare const LIVE_STEP_MS = 250;
export interface LiveFramesOptions {
    /** Keep this JPEG as frame `key`. Awaited before the next candidate is read. */
    store(key: number, jpeg: Blob): Promise<void>;
    /** Frame `key` is no longer kept (only ever with a budget). */
    discard?(key: number): Promise<void>;
    /** Only this part of the picture (fractions of the frame). */
    crop?: FrameBox;
    /** Most frames to keep. Default: no limit. */
    budget?: number;
    /** Draw on a whole-screen frame as it's encoded (the pointer) and say what was drawn. */
    decorate?: Decorate;
}
export interface LiveFrame {
    frame: RecordingFrame;
    /** What `store` was given for this frame's JPEG. */
    key: number;
}
export declare class LiveFrames {
    private readonly opts;
    private readonly selector;
    private readonly keeper;
    private readonly sigCtx;
    private readonly vsigCtx;
    /** Pick id → the pointer drawn on it; present once its JPEG is stored. */
    private readonly stored;
    private count;
    constructor(opts: LiveFramesOptions);
    /** Candidates read so far. */
    get sampled(): number;
    /** For recording.json: these frames carry change boxes and format 2 `dist`. */
    get sampling(): {
        engine: string;
        stepMs: number;
    };
    /** The screen as `video` shows it now, `t` ms into the take. Await it before the next. */
    push(t: number, video: HTMLVideoElement): Promise<void>;
    /** Someone started talking at `t`. */
    openLine(t: number): void;
    /** The talking stopped at `t`. */
    closeLine(t: number): void;
    /** The take ended at `t`; `video` still shows its last picture (null once the share is gone). */
    finish(t: number, video: HTMLVideoElement | null): Promise<void>;
    /**
     * The frames kept so far, in time order and numbered 1..N, as recording.json
     * holds them. Numbers can shift while recording (a narration line's frame
     * lands before frames already kept), so the key is what names a frame's
     * JPEG until the take is done.
     */
    frames(): LiveFrame[];
    private apply;
}
