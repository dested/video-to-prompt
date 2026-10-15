import { type SigDiff, type Signature } from './signature.js';
/**
 * Which candidate frames become keyframes. Pure: it sees signatures and times,
 * never pixels, and tells the caller which candidates to hold on to and which
 * to encode. That keeps the rule testable without a browser, and lets the
 * extractor hold at most a couple of full-size frames at any moment.
 *
 * The rule, in the order it matters:
 *
 *  1. **Major changes only.** A change counts when one connected region of it
 *     reaches MAJOR_REGION cells or the whole of it reaches MAJOR_TOTAL. A
 *     cursor move, a blinking caret, a recorder's own ticking timer all stay
 *     under that. Changes are measured against the frames already kept, not
 *     the previous candidate, so minor edits that accumulate (typing a line)
 *     cross the bar on their own.
 *  2. **Settle before keeping.** A major change opens a pending candidate. It
 *     is kept when the screen holds still, or when the screen snaps back to a
 *     state already kept (a toast that came and went: that flash is the
 *     evidence). Continuous motion is sampled once per MAX_MOTION_MS rather
 *     than at every step, so a scroll yields its resting place, not its blur.
 *  3. **Novel against the recent past.** A state that matches one of the last
 *     DEDUP_WINDOW keyframes is not new: A-B-A cutaways don't come back.
 *  4. **Every narration line gets a picture.** When a spoken line's window
 *     passes with no keyframe inside it, the candidate inside it that differs
 *     most from the last keyframe is kept. People narrate what they're looking
 *     at; a change too small to pass rule 1 (one digit in a total) is still on
 *     screen while they talk about it.
 *  5. **The ending is always shown.** The final state gets a frame unless the
 *     last keyframe already shows it (or, when that was a transient, the
 *     keyframe it went back to).
 *  6. **A budget, spent on novelty.** Past `budget` keyframes the least-changed
 *     one goes, never the first, the last, or a narration frame.
 *
 * Underneath all of it, a **busy-cell mask**: cells that keep changing in small
 * ways (a clock, a spinner, a blinking caret, the recorder's own live caption
 * in a window capture) heat up and are left out of every comparison until
 * they cool. Page-wide changes (a scroll, a navigation) add no heat, so
 * busy-ness only ever describes a small part of the screen.
 */
/** Cells in one connected region that make a change major. ~1,700 px² at 1080p: a toast, a tooltip, a focus ring. */
export declare const MAJOR_REGION = 12;
/** Total changed cells that make a change major even when it is scattered. */
export declare const MAJOR_TOTAL = 40;
export type PickReason = 'start' | 'change' | 'beat' | 'narration' | 'end';
/** A normalized rectangle (0..1 of the frame). */
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface Pick {
    /** Stable id for the caller's blob map; picks are renumbered only at the end. */
    id: number;
    t: number;
    reason: PickReason;
    /** Changed cells against the closest recent keyframe (absent on the first). */
    dist?: number;
    /** Where it differs from the keyframe before it; absent when the whole screen changed or nothing major did. */
    change?: Box;
    /** How long this state stayed on screen, ms. */
    held?: number;
    /** The screen went back to an earlier keyframe's state right after this one. */
    transient?: boolean;
}
/** Candidate pixels the caller must keep: `pending` and `anchor` are the two holding slots. */
export type Slot = 'pending' | 'anchor';
export type SelectAction = 
/** Copy the current candidate's pixels into `slot` (replacing what it held). */
{
    kind: 'hold';
    slot: Slot;
}
/** Encode the pixels in `slot` (or the current candidate) as keyframe `pick.id`. */
 | {
    kind: 'keep';
    from: Slot | 'current';
    pick: Pick;
}
/** Forget keyframe `id` (budget): its pixels can be released. */
 | {
    kind: 'drop';
    id: number;
}
/** Re-read the candidate at `t` and encode it as `pick.id` (only ever the final frame). */
 | {
    kind: 'refetch';
    t: number;
    pick: Pick;
};
export interface NarrationWindow {
    t: number;
    d?: number;
    text?: string;
}
export declare function isMajor(d: SigDiff): boolean;
export interface SelectorOptions {
    durationMs: number;
    budget: number;
    narration?: NarrationWindow[];
}
export declare class Selector {
    private readonly durationMs;
    private readonly budget;
    private readonly kept;
    private readonly windows;
    private nextId;
    private pending;
    private pendingSince;
    private prevT;
    private last;
    private anchor;
    private heat;
    private busy;
    private scratch;
    private spread;
    constructor(opts: SelectorOptions);
    /** Keyframes so far, in time order. */
    picks(): Pick[];
    push(t: number, sig: Signature): SelectAction[];
    /** End of stream: settle what's pending, close the windows, make sure the ending shows. */
    finish(): SelectAction[];
    /** Every comparison but the heat's own leaves the busy cells out. */
    private diff;
    /** Cool every cell for the time since the last candidate, then heat the ones that just changed in a small way. */
    private warm;
    private latest;
    /** The diff against whichever recent keyframe this signature is closest to. */
    private closest;
    /**
     * The most recent keyframe stops being on screen at the first major
     * departure from it. When that departure lands back on the keyframe before
     * it, the state was a transient: a toast that came and went, a flash.
     */
    private markHeld;
    /** The latest keyframe before `t` that wasn't a transient: what was really on screen. */
    private settledBefore;
    private record;
    private keep;
    /** Over budget: drop the least-changed keyframe that isn't structural. */
    private enforceBudget;
    /** Track, for the narration window this candidate falls in, the most informative candidate. */
    private weighForWindows;
    private closeWindows;
}
