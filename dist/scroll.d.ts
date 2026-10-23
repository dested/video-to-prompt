/**
 * Scroll-aware comparison. A page that scrolled changed almost every cell of
 * the main signature, yet shows nothing new except the rows that slid in. To
 * tell the two apart a second grid is read from each candidate: 40 columns by
 * four times the main grid's rows, so a cell is a short horizontal strip (8 px
 * tall at 2160p, 3 px at 1080p). Text lines are horizontal, so the strips keep
 * the vertical structure a scroll moves while dropping the horizontal detail it
 * doesn't. Same cell area as the main grid, so cell counts compare one to one.
 *
 * Pure, like the rest of selection: it sees two grids and answers how far the
 * content moved, how much of it is new, and what changed in place.
 */
import type { Signature } from './signature.js';
/** Scroll grid width in cells. */
export declare const VSIG_COLS = 40;
/** Scroll grid rows per main-grid row. */
export declare const VSIG_ROW_FACTOR = 4;
export declare function vsigRows(mainRows: number): number;
export interface Band {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}
export interface ShiftMatch {
    /** The columns and rows that moved. */
    band: Band;
    /** Content moved up by this many scroll-grid rows, to a fraction of one (positive = scrolled down the page). */
    dy: number;
    /** Share of the band's height that slid in: content the earlier grid never showed. */
    revealed: number;
    /** Cells that still differ once the shift is undone, counting only clusters (see `clusters`). */
    residual: number;
    /** The largest connected run of them. */
    residualRegion: number;
}
/** The widest run of columns where a real share of cells changed between `a` and `b`. */
export declare function movingBand(a: Signature, b: Signature, tol?: number): Band | null;
/**
 * Did `b` come from `a` by scrolling? Finds the band that changed, slides `a`'s
 * profile over `b`'s to shortlist shifts, checks the best few cell by cell, and
 * accepts one only when it explains most of the change. Null: not a scroll.
 *
 * `ignore` (scroll-grid cells, 1 = leave out) carries the selector's busy cells
 * over, so a recorder's own ticking clock never reads as a change in place.
 */
export declare function matchShift(a: Signature, b: Signature, ignore?: Uint8Array | null): ShiftMatch | null;
/**
 * What differs inside `band` between two views of the same page whose offset
 * is already known (`b` shows `a`'s row y + dy at row y): the check that rows a
 * keyframe from minutes ago showed still read the same. Only the rows both
 * show are compared; `rows` says how many that was, and `changed` which of
 * `b`'s rows hold a cluster of differences.
 */
export declare function residualAt(a: Signature, b: Signature, band: Band, dy: number, ignore?: Uint8Array | null): {
    residual: number;
    residualRegion: number;
    rows: number;
    changed: [number, number][];
};
/** A scroll left something changed in place: a highlight, an edit, a new line under the cursor. */
export declare function changedInPlace(m: {
    residual: number;
    residualRegion: number;
}): boolean;
