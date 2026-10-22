/**
 * Frame signatures: a frame shrunk to a small grayscale grid that keeps the
 * frame's aspect ratio, and the diff that says what changed between two of
 * them. Pure on purpose: the pixels arrive as RGBA from whatever drew them (a
 * decoded sample, a `<video>` element, a live screen share), so one rule serves
 * an after-the-fact distill and a live recorder alike.
 *
 * The grid used to be 64×64 RGB with a 25-level tolerance per channel mean,
 * squashing 16:9 into a square: a cell was ~30×17 px of a 1080p frame, and a
 * changed digit, a checkbox or a one-line validation message moved no cell
 * far enough to count. 160 columns with rows that follow the aspect ratio
 * make a cell ~12×12 px, and luma alone (text is dark-on-light far more
 * often than it is a hue) needs a third of the tolerance.
 */
/** Signature width in cells. At 1920 px wide a cell is 12×12 px: one changed glyph in 14 px text moves a cell ~30 levels. */
export declare const SIG_COLS = 160;
/** A cell counts as changed past this many luma levels. Codec noise on flat UI sits at ±3–4; a 1 px caret moves its cells ~14. */
export declare const LUMA_TOL = 10;
/** Regions kept per diff, largest first. Enough to bound a page-wide change; past that the screen is just "different". */
export declare const MAX_REGIONS = 64;
export interface Signature {
    cols: number;
    rows: number;
    /** cols × rows luma, row-major. */
    luma: Uint8Array;
}
/** A rectangle in signature cells. */
export interface CellBox {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface ChangeRegion extends CellBox {
    /** Changed cells inside the region. */
    cells: number;
}
export interface SigDiff {
    /** Cells past LUMA_TOL. */
    changed: number;
    /** changed ÷ all cells. */
    fraction: number;
    /** Sum over changed cells of how far each moved: weights a bold change over a faint one of the same size. */
    energy: number;
    /** Every changed cell's bounding box; null when nothing changed. */
    box: CellBox | null;
    /** Connected changed regions, largest first, at most MAX_REGIONS. */
    regions: ChangeRegion[];
}
/** Rows that keep the frame's aspect ratio at SIG_COLS columns. */
export declare function sigRows(width: number, height: number): number;
/** RGBA (as `getImageData` hands it over) → a luma signature. BT.601 weights in fixed point. */
export declare function signatureFromRgba(rgba: Uint8ClampedArray, cols: number, rows: number): Signature;
export interface DiffOptions {
    /** Luma levels a cell must move. Default LUMA_TOL. */
    tol?: number;
    /** Cells to leave out entirely (1 = ignore), e.g. the ones that never stop changing. */
    ignore?: Uint8Array | null;
    /** Filled with 1 for every changed cell, when given. */
    mask?: Uint8Array;
}
/**
 * Cells that differ between `a` and `b` (as `diffSignatures` counts them),
 * counting no further than `limit`: a cheap first look before a full diff.
 */
export declare function changedCells(a: Signature, b: Signature, limit: number, ignore?: Uint8Array | null): number;
/** What changed from `a` to `b`. Signatures of different shapes are wholly different. */
export declare function diffSignatures(a: Signature, b: Signature, opts?: DiffOptions): SigDiff;
/** Merge boxes into their bounding box; null for none. */
export declare function unionBox(boxes: CellBox[]): CellBox | null;
