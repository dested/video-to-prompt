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
 *  4. **A page is read once.** With scroll grids (see scroll.ts), a view that
 *     scrolled from a keyframe gets a place on that page, and it is new only
 *     for the rows no keyframe of the page shows, or for what changed in
 *     place. A settled view with half its rows unseen is kept at once; one
 *     with less is parked, and kept as the screen leaves it only if it was
 *     looked at for DWELL_MS and rows it showed would otherwise vanish unseen,
 *     or for READ_MS and no single keyframe shows it whole.
 *     A doc read a wheel notch at a time costs a frame per half screen, and a
 *     passage scrolled back to, or a screen come back to however long ago,
 *     costs nothing: the frame that showed it says so in `seen`.
 *  5. **Every narration line gets a picture.** When a spoken line's window
 *     passes with no keyframe inside it, the candidate inside it that differs
 *     most from the last keyframe is kept. People narrate what they're looking
 *     at; a change too small to pass rule 1 (one digit in a total) is still on
 *     screen while they talk about it. A page view the keyframes already show
 *     needs none.
 *  6. **The ending is always shown.** The final state gets a frame unless the
 *     last keyframe already shows it (or, when that was a transient, the
 *     keyframe it went back to), or the page's keyframes do.
 *  7. **A budget, only when asked for.** Past `budget` keyframes the
 *     least-changed one goes, never the first, the last, or a narration frame.
 *     By default there is none: a frame is kept because it shows something.
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
    /** Other spans [from, to) ms when this frame is what was on screen: a page view it already shows, scrolled or come back to. */
    seen?: [number, number][];
    /**
     * The screen differs from keyframe `of` only inside `box`: a highlight
     * moved, a message appeared, a toast. The caller encodes that region (with
     * some context) rather than the whole screen again.
     */
    detail?: {
        of: number;
        box: Box;
    };
}
/** Candidate pixels the caller must keep: `pending`, `anchor` and `parked` are the holding slots. */
export type Slot = 'pending' | 'anchor' | 'parked';
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
    /** The clip's length. A live recording doesn't know it yet: leave it out and `finish` says when it ended. */
    durationMs?: number;
    /** Most keyframes to keep. Default: no limit — a frame is kept because it shows something new, never dropped for count. */
    budget?: number;
    narration?: NarrationWindow[];
}
export declare class Selector {
    private durationMs;
    private readonly budget;
    private readonly kept;
    private readonly windows;
    private nextId;
    private pending;
    private pendingSince;
    private parked;
    private prevT;
    private last;
    private anchor;
    private heat;
    private busy;
    /** When each cell last changed in a small way. */
    private lastHeat;
    private scratch;
    /** Cells the previous step changed, before any were let off heating. */
    private stepBefore;
    /** Per block: whether it changed, for each of the last VIDEO_STEPS steps (a ring), how many did, and when it last did. */
    private videoRing;
    private videoCount;
    private videoLast;
    /** Per block: changed within VIDEO_LIVE_MS. Bumps `liveEpoch` when it flips: comparisons with a screen's video depend on it. */
    private videoLive;
    private liveEpoch;
    private videoStep;
    /** videoStep of the last scroll or page-sized change. */
    private videoLarge;
    /** Blocks known for video by their votes, moving now or not; null when none is. */
    private videoKnown;
    /** The keyframe the screen was last found to show: it learns the screen's video. */
    private onScreen;
    private ignoreBuf;
    private spread;
    /** The last step between candidates was a major change. */
    private moving;
    /** Pages, as a union-find: a surface's rows plus `shift` are its parent's rows. */
    private readonly surfaces;
    /** Bumped whenever the keyframes or the pages change: a cached view is stale past it. */
    private version;
    private byRecency;
    constructor(opts: SelectorOptions);
    /**
     * Live: someone started talking at `t`. A narration window opens and stays
     * open until `closeLine`, so the line gets a picture like a transcript line
     * does (rule 5). Lines come in time order, one at a time.
     */
    openLine(t: number): void;
    /** Live: the talking `openLine` heard stopped at `t`. A blip too short to be a line is forgotten. */
    closeLine(t: number): void;
    /** Keyframes so far, in time order. */
    picks(): Pick[];
    push(t: number, sig: Signature, vsig?: Signature): SelectAction[];
    /**
     * End of stream: settle what's pending, close the windows, make sure the
     * ending shows. A live recording passes when it ended.
     */
    finish(endMs?: number): SelectAction[];
    /** Every comparison but the heat's own leaves the busy cells out. */
    private diff;
    /** Cool every cell for the time since the last candidate, then heat the ones that just changed in a small way. */
    private warm;
    /**
     * What a comparison of `sig` with `k` leaves out: the busy cells, `k`'s video
     * where something still moves, and its video gone still when what changed
     * there is less than a new picture (a face that drifted, not a clip that
     * stopped on something else).
     */
    private ignoring;
    /** A diff against a keyframe, leaving out what `ignoring` does. */
    private against;
    /**
     * Counts this step's change per block and returns which blocks are video
     * now (null when none is), from `changed`: the step's voting cells, null for
     * a step too large to vote, 'swept' for a scroll or a page-sized change.
     */
    private watchVideo;
    /**
     * Does this state show something the keyframes don't? Plainly covered: no.
     * Not scroll-related to any keyframe: yes (it is major against the recent
     * past, or it wouldn't be asked). On a page: when something changed in place,
     * or at least `reveal` of its rows no keyframe shows.
     */
    private showsNew;
    /** The page's keyframes already show this view, near enough every row of it, or one of them shows it as it is. */
    private pageShows;
    /**
     * A view the screen settled on: kept when it shows enough that's new,
     * parked otherwise. The view it left before this one is settled first, now
     * that it's known where the screen went.
     */
    private settle;
    /**
     * The screen has moved on from the parked view to `next` (null: the clip
     * ended). Keep it when it was up long enough to be read and rows of it would
     * otherwise never be in a frame: not in a keyframe, not in the view the
     * screen went to; or when, judged again now that what was dragged out as it
     * settled has cooled, something in it changed in place. Keep it too when it
     * was looked at for READ_MS and no one keyframe shows it whole. Otherwise the keyframe that shows most of it
     * stood in for it, and says so.
     */
    private leaveParked;
    /** What the keyframes already show of `cand`, cached until they change. */
    private view;
    private computeView;
    /**
     * Which of the view's rows the page's keyframes show. The keyframe it
     * scrolled from is checked already when it matched clean; every other one is
     * compared at the offset the page gives it, so rows edited while off screen
     * read as unseen.
     */
    private coverage;
    /** Keyframes, newest first. */
    private recent;
    /** The keyframes a view is matched against: the recent ones, and the latest of every other page. */
    private linkPool;
    /** Where a view that scrolled from `k` by `m` sits, giving `k` a page of its own first if it had none. */
    private place;
    /** `k` shows the view at `page` scrolled by `m`: put it on that page, joining the two if it was on another. */
    private join;
    /** A page position on its root surface. */
    private resolve;
    /** What a narration line's frame is weighed by: changed cells no keyframe explains. A page view the keyframes show has none. */
    private unexplained;
    /** Did `b` follow `a` by scrolling? */
    private scrolled;
    /** The busy mask carried onto a scroll grid: a strip is busy when the main cell it sits in is. */
    private busyOn;
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
    private byId;
    private keep;
    /** Over budget: drop the least-changed keyframe that isn't structural. */
    private enforceBudget;
    /** Track, for the narration window this candidate falls in, the most informative candidate. */
    private weighForWindows;
    private closeWindows;
}
