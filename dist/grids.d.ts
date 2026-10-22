import { type FrameBox } from './types.js';
/**
 * Contact sheets. A model reading consecutive frames side by side in one image
 * follows motion and progression far better than the same frames one at a
 * time, at a fraction of the tokens, which is why the report offers them.
 * Batching is nine at a time in frame order, and it has to match `report.ts`'s
 * frame→sheet map exactly.
 *
 * Sized to be read, not glanced at. The first version drew 480 px tiles into a
 * 1440 px sheet: cheap, and not one word of UI text survived it. A model like
 * Opus 5.5 takes images up to 2576 px on the long edge, and Claude Code shows
 * up to 2000 px wide, so sheets default to 2000 px: ~660 px tiles, where
 * headings, banners, buttons and the URL bar all read. Each tile carries its
 * frame number, its time and, for a state that didn't last, how long it was up;
 * the region that changed since the previous frame is outlined in magenta, a
 * colour UIs almost never use. The frames themselves are never drawn on.
 */
/** Default sheet width. Claude Code's image display limit; pass 2576 for API consumers. */
export declare const SHEET_WIDTH = 2000;
export interface GridFrame {
    blob: Blob;
    /** Tile caption, e.g. "03 · 0:05 · up 0.5 s". */
    label: string;
    /** What changed since the previous frame, outlined on the tile. */
    change?: FrameBox;
    /** `blob` is a detail: the tile shows `base` with it laid over `box`, the whole screen as it was. */
    detail?: {
        base: Blob;
        box: FrameBox;
    };
}
export interface GridOptions {
    /** Sheet width in px. Default SHEET_WIDTH. */
    width?: number;
}
/** Contact sheets of consecutive keyframes, nine per sheet. */
export declare function makeGrids(frames: GridFrame[], opts?: GridOptions): Promise<Blob[]>;
