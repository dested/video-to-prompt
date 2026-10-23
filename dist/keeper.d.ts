import type { SourceFrame } from './decode.js';
import type { Pick, Slot } from './select.js';
import type { FrameBox, FramePointer, RecordingFrame } from './types.js';
/**
 * Draws on a whole-screen keyframe as it's encoded (a live recorder's pointer)
 * and says what it drew. `t` is the keyframe's time, which for a held
 * candidate is earlier than now.
 */
export type Decorate = (ctx: CanvasRenderingContext2D, t: number, width: number, height: number) => FramePointer | undefined;
export interface Encoded {
    jpeg: Blob;
    pointer?: FramePointer;
}
export declare class Keeper {
    private readonly decorate?;
    private readonly slots;
    private readonly scratch;
    private readonly out;
    constructor(decorate?: Decorate | undefined);
    /** Copy `frame` into `slot`, replacing what it held. */
    hold(slot: Slot, frame: SourceFrame): void;
    /** The JPEG for `pick`, from a slot or straight from `frame`. */
    encode(pick: Pick, from: Slot | SourceFrame): Promise<Encoded>;
}
/** The region a detail is cut from: the change, padded, grown to a readable minimum, kept on screen. */
export declare function detailCrop(change: FrameBox): FrameBox;
/** A pick as recording.json says it: numbered `index`, its detail's base by that numbering. */
export declare function toRecordingFrame(pick: Pick, index: number, indexOf: Map<number, number>, pointer?: FramePointer): RecordingFrame;
export declare function canvas2d(width: number, height: number, readback: boolean): CanvasRenderingContext2D;
