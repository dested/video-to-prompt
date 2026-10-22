import { changedCells, diffSignatures, LUMA_TOL, MAX_REGIONS, unionBox, } from './signature.js';
import { changedInPlace, matchShift, residualAt } from './scroll.js';
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
export const MAJOR_REGION = 12;
/** Total changed cells that make a change major even when it is scattered. */
export const MAJOR_TOTAL = 40;
/** Continuous motion yields one keyframe per this long. */
const MAX_MOTION_MS = 2000;
/** Kept frames a new state is compared against. */
const DEDUP_WINDOW = 4;
/** Recent keyframes a view is matched against to find which page it scrolled on. */
const SCROLL_WINDOW = 8;
/** …plus the latest keyframe of this many other pages, so a page come back to is recognised. */
const PAGE_POOL = 16;
/** Keyframes of one page checked when deciding which of a view's rows are already shown. */
const COVER_POOL = 48;
/** A settled view with this share of its rows unseen is kept straight away. */
const SETTLE_REVEAL = 0.5;
/** While the page keeps moving, one frame per MAX_MOTION_MS once this share is unseen. */
const MOTION_REVEAL = 0.25;
/** A parked view is kept on the way out when this share of its rows would vanish unseen… */
const LOST_MIN = 0.05;
/** …and it was up this long: a pause to read, not a stutter in a scroll. */
const DWELL_MS = 1500;
/**
 * A view looked at this long is what the narration over it is about: it gets a
 * frame of its own unless one keyframe already shows it whole, so nobody has
 * to piece it together from two.
 */
const READ_MS = 8000;
/** Strip rows at a view's top and bottom edge that never count as shown or unseen (a sticky header, a cut-off line). */
const PAGE_EDGE = 2;
/** Fewest strip rows two views must share before their overlap counts as checked. */
const MIN_COMPARE_ROWS = 6;
/** A slowly drifting screen still gets a frame this often. */
const BEAT_MS = 15000;
/** …provided at least this much has drifted. */
const BEAT_MIN_CELLS = 4;
/** The final state gets its own frame when the last keyframe is older than this and something changed. */
const FINAL_GAP_MS = 2000;
/** Regions below this are left out of a change box: the cursor, a caret, a speck of codec noise. */
const BOX_REGION = 6;
/** A change covering more of the frame than this gets no box: the whole screen is the change. */
const BOX_MAX_AREA = 0.5;
/** A keyframe whose change from the last full one fits a box this small (share of the frame) is a detail of it. */
const DETAIL_MAX_AREA = 0.1;
/** A line with no reported length is assumed to run this long per word. */
const WORD_MS = 380;
/** A narration line whose screen shows no measurable change still gets a fresh frame once the last one is this old. */
const STALE_MS = 8000;
/** Heat halves this often. */
const HEAT_HALF_LIFE_MS = 10000;
/** Heat at which a cell counts as busy: three small changes within a few seconds. */
const BUSY_HEAT = 2.5;
/**
 * …and it stays left out only while it is itself still changing: a clock
 * ticks, a caret blinks, a caption grows at least this often. Text selected by
 * dragging heats the same way, but once the drag stops, what it highlighted is
 * on screen and counts, however long the pointer wanders over it.
 */
const LIVE_MS = 1500;
/**
 * Video (a webcam tile, a clip playing) changes a few scattered cells on many
 * steps, too sparsely for any one cell to heat. It is caught by the block: a
 * VIDEO_BLOCK-cell square that changed in VIDEO_SHARE of the last VIDEO_STEPS
 * steps (20 s) is video. It is left out while anything within VIDEO_REACH of
 * it changed in the last VIDEO_LIVE_MS: a face that holds still a moment is
 * still a face, and a clip that stops shows its last picture once that passes.
 */
const VIDEO_BLOCK = 8;
const VIDEO_STEPS = 80;
const VIDEO_SHARE = 0.1;
const VIDEO_LIVE_MS = 10000;
/** A block's change in a step counts only past this many cells across two columns or more. */
const VIDEO_MIN_CELLS = 3;
/**
 * A step whose only small changes are one or two blobs under this many cells
 * across is the pointer moving (where it was, where it is): they cast no
 * video vote. Video changes in specks all over at once.
 */
const POINTER_CELLS = 7;
/**
 * A change this many times wider than tall (and VIDEO_STRIP cells wide) is a
 * line of the UI: text typed or selected, a row lit by hover. Video's changes
 * are blobs.
 */
const VIDEO_STRIP = 8;
const VIDEO_STRIP_ASPECT = 3;
/**
 * A scroll or a page-sized change comes with small steps either side: a smooth
 * scroll easing in and out, a page painting in. Steps this close to one cast
 * no vote, and it takes back the votes just before it. Video's own large steps
 * (six webcams moving at once) are neither a scroll nor this large.
 */
const VIDEO_QUIET_STEPS = 4;
const VIDEO_SWEEP = 0.1;
/**
 * A change this large that is not a scroll (a window switch, a navigation)
 * replaced what was there: the blocks it repainted forget their video. The
 * screen it left keeps its own record (`Kept.video`) for when it comes back.
 */
const VIDEO_REPLACE = 0.25;
/**
 * Blocks this close to live video are left out too: a webcam tile's wall
 * changes when an arm sweeps past or the camera re-exposes, not step by step.
 */
const VIDEO_REACH = 2;
/** Consecutive changes larger than this fraction of the frame add no heat (a scroll is not a clock). */
const HEAT_MAX_FRACTION = 0.05;
/** How far a change's heat spreads, in cells: along a line of text more than across lines. */
const HEAT_SPREAD_X = 3;
const HEAT_SPREAD_Y = 1;
export function isMajor(d) {
    if (d.changed >= MAJOR_TOTAL)
        return true;
    return d.regions.length > 0 && (d.regions[0]?.cells ?? 0) >= MAJOR_REGION;
}
export class Selector {
    durationMs;
    budget;
    kept = [];
    windows;
    nextId = 1;
    pending = null;
    pendingSince = 0;
    parked = null;
    prevT = -1;
    last = null;
    anchor = null;
    heat = null;
    busy = null;
    /** When each cell last changed in a small way. */
    lastHeat = null;
    scratch = null;
    /** Cells the previous step changed, before any were let off heating. */
    stepBefore = null;
    /** Per block: whether it changed, for each of the last VIDEO_STEPS steps (a ring), how many did, and when it last did. */
    videoRing = null;
    videoCount = new Uint8Array(0);
    videoLast = new Float64Array(0);
    /** Per block: changed within VIDEO_LIVE_MS. Bumps `liveEpoch` when it flips: comparisons with a screen's video depend on it. */
    videoLive = new Uint8Array(0);
    liveEpoch = 0;
    videoStep = 0;
    /** videoStep of the last scroll or page-sized change. */
    videoLarge = -Infinity;
    /** Blocks known for video by their votes, moving now or not; null when none is. */
    videoKnown = null;
    /** The keyframe the screen was last found to show: it learns the screen's video. */
    onScreen = null;
    ignoreBuf = new Uint8Array(0);
    spread = new Uint8Array(0);
    /** The last step between candidates was a major change. */
    moving = false;
    /** Pages, as a union-find: a surface's rows plus `shift` are its parent's rows. */
    surfaces = [];
    /** Bumped whenever the keyframes or the pages change: a cached view is stale past it. */
    version = 0;
    byRecency = null;
    constructor(opts) {
        this.durationMs = opts.durationMs;
        this.budget = Math.max(2, opts.budget ?? Infinity);
        this.windows = (opts.narration ?? [])
            .map((line) => {
            const words = (line.text ?? '').trim().split(/\s+/).filter(Boolean).length;
            const d = line.d ?? Math.max(1000, words * WORD_MS);
            const start = Math.max(0, line.t);
            const end = Math.min(opts.durationMs, line.t + d);
            return { start, end, best: null, bestScore: -1, target: start + Math.min(d / 2, 1000) };
        })
            .filter((w) => w.end > w.start)
            .sort((a, b) => a.start - b.start);
    }
    /** Keyframes so far, in time order. */
    picks() {
        return this.kept.map((k) => k.pick).sort((a, b) => a.t - b.t);
    }
    push(t, sig, vsig) {
        const out = [];
        this.warm(t, sig, vsig);
        this.prevT = t;
        if (!this.kept.length) {
            // The opening settles like any change: a recording usually starts on the
            // recorder's own picker or countdown getting out of the way.
            const cand = { t, sig, vsig, novelty: emptyDiff(), moving: this.moving };
            if (!this.pending) {
                this.pending = cand;
                this.pendingSince = t;
                out.push({ kind: 'hold', slot: 'pending' });
            }
            else if (!isMajor(this.diff(this.pending.sig, sig)) ||
                t - this.pendingSince >= MAX_MOTION_MS) {
                this.keep(this.pending, 'start', out, 'pending').dist = undefined;
                this.pending = null;
            }
            else {
                this.pending = cand;
                out.push({ kind: 'hold', slot: 'pending' });
            }
            this.weighForWindows(cand, out);
            this.last = cand;
            return out;
        }
        const novelty = this.closest(sig);
        const cand = { t, sig, vsig, novelty, moving: this.moving };
        this.markHeld(t, sig);
        // Narration windows that end here decide before this candidate is weighed.
        this.closeWindows(t, out);
        const parked = this.parked;
        if (parked && parked.left === null) {
            if (isMajor(this.diff(parked.cand.sig, sig)))
                parked.left = t;
            else {
                if (this.busy)
                    parked.busy = copyInto(parked.busy, this.busy);
                if (diffSignatures(parked.cand.sig, sig).changed > 0) {
                    // Still the parked view, moved on a little (a selection dragged out, a
                    // caret): what it ends up showing is what a frame of it should show.
                    parked.cand = cand;
                    out.push({ kind: 'hold', slot: 'parked' });
                }
            }
        }
        const novel = isMajor(novelty);
        if (this.pending) {
            const pending = this.pending;
            const fromPending = this.diff(pending.sig, sig);
            if (!isMajor(fromPending)) {
                // Held still: a settled view.
                this.settle(pending, cand, out);
                this.pending = null;
            }
            else if (!novel) {
                // Snapped back to something already kept. A flash in between (a toast
                // that came and went) is the evidence; a scroll that passed by and came
                // back is not.
                if (!this.scrolled(pending, cand) && this.showsNew(pending)) {
                    const pick = this.keep(pending, 'change', out, 'pending');
                    pick.transient = true;
                    pick.held = t - pick.t;
                }
                this.pending = null;
                this.leaveParked(cand, out);
            }
            else if (t - this.pendingSince >= MAX_MOTION_MS) {
                // Still moving after a while: keep where it had got to when that shows
                // enough no kept frame does, and keep watching.
                if (this.showsNew(pending, MOTION_REVEAL)) {
                    const pick = this.keep(pending, 'change', out, 'pending');
                    pick.held = t - pick.t;
                }
                this.pending = cand;
                this.pendingSince = t;
                out.push({ kind: 'hold', slot: 'pending' });
            }
            else {
                this.pending = cand;
                out.push({ kind: 'hold', slot: 'pending' });
            }
        }
        else if (novel) {
            // Still on the parked view: it was settled already.
            if (!parked || parked.left !== null) {
                this.pending = cand;
                this.pendingSince = t;
                out.push({ kind: 'hold', slot: 'pending' });
            }
        }
        else {
            if (parked && parked.left !== null)
                this.leaveParked(cand, out);
            // Drift is measured against the keyframe this screen matches, which is
            // not the latest one when the screen came back to an earlier state.
            const lastKept = this.latest();
            if (lastKept &&
                t - lastKept.pick.t >= BEAT_MS &&
                novelty.changed >= BEAT_MIN_CELLS &&
                !this.pageShows(cand)) {
                this.keep(cand, 'beat', out, 'current');
            }
        }
        this.weighForWindows(cand, out);
        this.last = cand;
        return out;
    }
    /** End of stream: settle what's pending, close the windows, make sure the ending shows. */
    finish() {
        const out = [];
        if (this.pending) {
            const opening = !this.kept.length;
            if (opening) {
                this.keep(this.pending, 'start', out, 'pending').dist = undefined;
            }
            else {
                // Still moving at the end: the place it got to, unless the page already shows it.
                this.leaveParked(this.pending, out);
                if (!this.pageShows(this.pending))
                    this.keep(this.pending, 'change', out, 'pending');
            }
            this.pending = null;
        }
        this.closeWindows(Infinity, out);
        this.leaveParked(null, out);
        const last = this.last;
        const lastKept = this.latest();
        if (last && lastKept && last.t > lastKept.pick.t) {
            // A transient last keyframe already went back to the one before it, so that is what's showing.
            const shown = (lastKept.pick.transient && this.settledBefore(lastKept.pick.t)) || lastKept;
            const d = this.against(shown, last.sig);
            if ((isMajor(d) || (d.changed >= BEAT_MIN_CELLS && last.t - lastKept.pick.t >= FINAL_GAP_MS)) &&
                !this.pageShows(last)) {
                const pick = this.record(last, 'end');
                out.push({ kind: 'refetch', t: last.t, pick });
                this.enforceBudget(out);
            }
        }
        // A state with no successor ran to the end of the clip.
        for (const k of this.kept) {
            if (k.pick.held === undefined)
                k.pick.held = Math.max(0, this.durationMs - k.pick.t);
        }
        return out;
    }
    // ── internals ────────────────────────────────────────────────────────────
    /** Every comparison but the heat's own leaves the busy cells out. */
    diff(a, b) {
        return diffSignatures(a, b, { ignore: this.busy });
    }
    /** Cool every cell for the time since the last candidate, then heat the ones that just changed in a small way. */
    warm(t, sig, vsig) {
        const prev = this.last;
        const cells = sig.cols * sig.rows;
        if (!this.heat || this.heat.length !== cells) {
            this.heat = new Float32Array(cells);
            this.busy = new Uint8Array(cells);
            this.lastHeat = new Float64Array(cells).fill(-Infinity);
            this.scratch = new Uint8Array(cells);
            this.spread = new Uint8Array(cells);
            this.stepBefore = new Uint8Array(cells);
        }
        if (!prev || !this.busy || !this.scratch)
            return;
        const heat = this.heat;
        const busy = this.busy;
        const decay = Math.pow(0.5, Math.max(0, t - prev.t) / HEAT_HALF_LIFE_MS);
        const step = diffSignatures(prev.sig, sig, { mask: this.scratch });
        this.moving = isMajor(step);
        const before = this.stepBefore;
        const now = this.scratch.slice();
        const largest = step.regions[0];
        let swept = false;
        if (step.fraction > HEAT_MAX_FRACTION && largest) {
            const shift = vsig && prev.vsig ? matchShift(prev.vsig, vsig) : null;
            swept = Boolean(shift) || step.fraction > VIDEO_SWEEP;
            if (shift || !vsig || !prev.vsig) {
                // A scroll heats nothing in the columns it moved through; what changed
                // beside it at the same moment (a clock next to a scrolling page)
                // still heats, or a page that keeps scrolling would keep its
                // neighbours' noise from ever settling. With no scroll grid to tell,
                // any page-wide change is taken for one.
                const k = shift && vsig ? sig.cols / vsig.cols : 1;
                const bx0 = shift ? Math.floor(shift.band.x0 * k) : largest.x;
                const bx1 = shift ? Math.ceil((shift.band.x1 + 1) * k) - 1 : largest.x + largest.w - 1;
                const x0 = Math.max(0, bx0 - HEAT_SPREAD_X);
                const x1 = Math.min(sig.cols - 1, bx1 + HEAT_SPREAD_X);
                for (let y = 0; y < sig.rows; y++)
                    this.scratch.fill(0, y * sig.cols + x0, y * sig.cols + x1 + 1);
            }
            else if (before) {
                // Not a scroll. A navigation changes once and holds; video (a webcam
                // tile, a clip playing) changes step after step. Only cells that
                // changed in the step before too heat.
                for (let i = 0; i < cells; i++)
                    if (!before[i])
                        this.scratch[i] = 0;
            }
        }
        const video = this.watchVideo(t, sig, swept ? 'swept' : step.fraction > HEAT_MAX_FRACTION ? null : votes(step, this.scratch, sig.cols), swept && step.fraction > VIDEO_REPLACE ? now : null);
        this.stepBefore = now;
        let heats = false;
        for (let i = 0; i < cells && !heats; i++)
            if (this.scratch[i])
                heats = true;
        if (heats)
            dilate(this.scratch, this.spread, sig.cols, sig.rows, HEAT_SPREAD_X, HEAT_SPREAD_Y);
        // One unit per change event to every cell within reach of it, so text that
        // grows in place (a live caption gaining words) turns busy as a line rather
        // than glyph by glyph, while a toast that comes and goes adds only two.
        // A cell is live only while it changes itself: heat spreads, but a pointer
        // wandering over a selection doesn't keep the selection out of comparisons.
        const lastHeat = this.lastHeat;
        for (let i = 0; i < cells; i++) {
            const hit = heats && this.spread[i] ? 1 : 0;
            heat[i] = (heat[i] ?? 0) * decay + hit;
            if (heats && this.scratch[i] && lastHeat)
                lastHeat[i] = t;
        }
        for (let i = 0; i < cells; i++) {
            const hot = (heat[i] ?? 0) >= BUSY_HEAT;
            busy[i] = hot && t - (lastHeat?.[i] ?? -Infinity) < LIVE_MS ? 1 : 0;
        }
        if (video) {
            const bc = Math.ceil(sig.cols / VIDEO_BLOCK);
            for (let i = 0; i < cells; i++) {
                const b = Math.floor(i / sig.cols / VIDEO_BLOCK) * bc + Math.floor((i % sig.cols) / VIDEO_BLOCK);
                if (video[b])
                    busy[i] = 1;
            }
        }
        const on = this.onScreen;
        const known = this.videoKnown;
        if (on && known && changedCells(on.sig, sig, MAJOR_TOTAL, this.ignoring(on, sig)) < MAJOR_TOTAL) {
            const v = (on.video ??= new Uint8Array(known.length));
            for (let b = 0; b < known.length; b++)
                if (known[b])
                    v[b] = 1;
        }
    }
    /**
     * What a comparison of `sig` with `k` leaves out: the busy cells, `k`'s video
     * where something still moves, and its video gone still when what changed
     * there is less than a new picture (a face that drifted, not a clip that
     * stopped on something else).
     */
    ignoring(k, sig) {
        const v = k.video;
        const busy = this.busy;
        if (!v || !busy || v.length !== this.videoLast.length)
            return busy;
        const { cols, rows } = k.sig;
        const bc = Math.ceil(cols / VIDEO_BLOCK);
        const live = new Uint8Array(v.length);
        let any = false;
        for (let b = 0; b < v.length; b++) {
            if (!v[b])
                continue;
            any = true;
            if (this.videoLive[b])
                live[b] = 1;
        }
        if (!any)
            return busy;
        const all = dilateBlocks(v, bc, VIDEO_REACH);
        const reach = dilateBlocks(live, bc, VIDEO_REACH);
        const blockOf = (i) => Math.floor(i / cols / VIDEO_BLOCK) * bc + Math.floor((i % cols) / VIDEO_BLOCK);
        let still = 0;
        if (sig.cols === cols && sig.rows === rows) {
            for (let i = 0; i < cols * rows && still < MAJOR_TOTAL; i++) {
                const b = blockOf(i);
                if (!all[b] || reach[b] || busy[i])
                    continue;
                if (Math.abs((k.sig.luma[i] ?? 0) - (sig.luma[i] ?? 0)) > LUMA_TOL)
                    still++;
            }
        }
        const left = still < MAJOR_TOTAL ? all : reach;
        if (this.ignoreBuf.length !== busy.length)
            this.ignoreBuf = new Uint8Array(busy.length);
        const out = this.ignoreBuf;
        for (let i = 0; i < busy.length; i++)
            out[i] = busy[i] || (i < cols * rows && left[blockOf(i)]) ? 1 : 0;
        return out;
    }
    /** A diff against a keyframe, leaving out what `ignoring` does. */
    against(k, sig) {
        return diffSignatures(k.sig, sig, { ignore: this.ignoring(k, sig) });
    }
    /**
     * Counts this step's change per block and returns which blocks are video
     * now (null when none is), from `changed`: the step's voting cells, null for
     * a step too large to vote, 'swept' for a scroll or a page-sized change.
     */
    watchVideo(t, sig, changed, replaced) {
        const bc = Math.ceil(sig.cols / VIDEO_BLOCK);
        const blocks = bc * Math.ceil(sig.rows / VIDEO_BLOCK);
        if (!this.videoRing || this.videoCount.length !== blocks) {
            this.videoRing = new Uint8Array(blocks * VIDEO_STEPS);
            this.videoCount = new Uint8Array(blocks);
            this.videoLast = new Float64Array(blocks).fill(-Infinity);
            this.videoLive = new Uint8Array(blocks);
            this.videoStep = 0;
        }
        const ring = this.videoRing;
        if (replaced) {
            const n = new Uint16Array(blocks);
            for (let y = 0; y < sig.rows; y++)
                for (let x = 0; x < sig.cols; x++)
                    if (replaced[y * sig.cols + x]) {
                        const b = Math.floor(y / VIDEO_BLOCK) * bc + Math.floor(x / VIDEO_BLOCK);
                        n[b] = (n[b] ?? 0) + 1;
                    }
            for (let b = 0; b < blocks; b++) {
                if ((n[b] ?? 0) * 2 < VIDEO_BLOCK * VIDEO_BLOCK)
                    continue;
                for (let k = 0; k < VIDEO_STEPS; k++)
                    ring[k * blocks + b] = 0;
                this.videoCount[b] = 0;
                // Not known for video any more, but what it shows is new: a screen
                // with video there, come back to, is judged as if it still moved
                // until VIDEO_LIVE_MS says otherwise.
                this.videoLast[b] = t;
            }
        }
        if (changed === 'swept') {
            this.videoLarge = this.videoStep;
            for (let k = 1; k <= Math.min(VIDEO_QUIET_STEPS, this.videoStep); k++) {
                const back = ((this.videoStep - k) % VIDEO_STEPS) * blocks;
                for (let b = 0; b < blocks; b++) {
                    this.videoCount[b] = (this.videoCount[b] ?? 0) - (ring[back + b] ?? 0);
                    ring[back + b] = 0;
                }
            }
        }
        const n = new Uint16Array(blocks);
        const columns = new Uint8Array(blocks);
        if (changed && changed !== 'swept' && this.videoStep - this.videoLarge > VIDEO_QUIET_STEPS) {
            for (let y = 0; y < sig.rows; y++) {
                for (let x = 0; x < sig.cols; x++) {
                    if (!changed[y * sig.cols + x])
                        continue;
                    const b = Math.floor(y / VIDEO_BLOCK) * bc + Math.floor(x / VIDEO_BLOCK);
                    n[b] = (n[b] ?? 0) + 1;
                    columns[b] = (columns[b] ?? 0) | (1 << x % VIDEO_BLOCK);
                }
            }
        }
        const slot = (this.videoStep++ % VIDEO_STEPS) * blocks;
        const out = new Uint8Array(blocks);
        const known = new Uint8Array(blocks);
        let any = false;
        let anyKnown = false;
        for (let b = 0; b < blocks; b++) {
            const cols = columns[b] ?? 0;
            const hit = (n[b] ?? 0) >= VIDEO_MIN_CELLS && (cols & (cols - 1)) !== 0 ? 1 : 0;
            this.videoCount[b] = (this.videoCount[b] ?? 0) - (ring[slot + b] ?? 0) + hit;
            ring[slot + b] = hit;
            if (n[b])
                this.videoLast[b] = t;
            const live = t - (this.videoLast[b] ?? -Infinity) < VIDEO_LIVE_MS ? 1 : 0;
            if (live !== this.videoLive[b]) {
                this.videoLive[b] = live;
                this.liveEpoch++;
            }
            if ((this.videoCount[b] ?? 0) < VIDEO_SHARE * VIDEO_STEPS)
                continue;
            known[b] = 1;
            anyKnown = true;
            if (t - (this.videoLast[b] ?? -Infinity) < VIDEO_LIVE_MS) {
                out[b] = 1;
                any = true;
            }
        }
        this.videoKnown = anyKnown ? known : null;
        return any ? dilateBlocks(out, bc, VIDEO_REACH) : null;
    }
    /**
     * Does this state show something the keyframes don't? Plainly covered: no.
     * Not scroll-related to any keyframe: yes (it is major against the recent
     * past, or it wouldn't be asked). On a page: when something changed in place,
     * or at least `reveal` of its rows no keyframe shows.
     */
    showsNew(cand, reveal = SETTLE_REVEAL) {
        const v = this.view(cand);
        if (v.plain)
            return false;
        if (!v.page)
            return true;
        return v.inPlace || v.unseen >= reveal;
    }
    /** The page's keyframes already show this view, near enough every row of it, or one of them shows it as it is. */
    pageShows(cand) {
        const v = this.view(cand);
        return v.page !== null && !v.inPlace && (v.plain !== null || v.unseen < LOST_MIN);
    }
    /**
     * A view the screen settled on: kept when it shows enough that's new,
     * parked otherwise. The view it left before this one is settled first, now
     * that it's known where the screen went.
     */
    settle(pending, now, out) {
        this.leaveParked(pending, out);
        if (this.showsNew(pending)) {
            this.keep(pending, 'change', out, 'pending');
            return;
        }
        this.parked = {
            cand: now,
            since: pending.t,
            left: null,
            busy: this.busy ? this.busy.slice() : null,
        };
        out.push({ kind: 'hold', slot: 'parked' });
    }
    /**
     * The screen has moved on from the parked view to `next` (null: the clip
     * ended). Keep it when it was up long enough to be read and rows of it would
     * otherwise never be in a frame: not in a keyframe, not in the view the
     * screen went to; or when, judged again now that what was dragged out as it
     * settled has cooled, something in it changed in place. Keep it too when it
     * was looked at for READ_MS and no one keyframe shows it whole. Otherwise the keyframe that shows most of it
     * stood in for it, and says so.
     */
    leaveParked(next, out) {
        const p = this.parked;
        if (!p)
            return;
        this.parked = null;
        const left = p.left ?? next?.t ?? this.durationMs;
        // Judged afresh: when it settled, a selection just dragged out was still
        // busy and left out; by its last still moment it had cooled and counts.
        const busy = this.busy;
        this.busy = p.busy ?? busy;
        p.cand.view = undefined;
        let v;
        try {
            v = this.view(p.cand);
        }
        finally {
            this.busy = busy;
        }
        let lost = v.gaps;
        const nextPage = next && v.page ? this.view(next).page : null;
        // Rows the next view still shows aren't lost, provided they still read the same there.
        if (next?.vsig && p.cand.vsig && v.page && nextPage && nextPage.surface === v.page.surface) {
            const same = residualAt(p.cand.vsig, next.vsig, v.page.band, nextPage.off - v.page.off, this.busyOn(next.vsig));
            if (!changedInPlace(same)) {
                const [lo, hi] = viewRows(nextPage);
                lost = subtract(lost, lo, hi);
            }
        }
        const rows = v.page ? viewRows(v.page) : null;
        const share = rows ? span(lost) / Math.max(1, rows[1] - rows[0]) : 0;
        const dwell = left - p.since;
        const fresh = !v.plain && (v.inPlace || !v.page);
        if ((dwell >= DWELL_MS && (share >= LOST_MIN || fresh)) || (dwell >= READ_MS && !v.whole)) {
            const pick = this.keep(p.cand, 'change', out, 'parked');
            pick.held = left - pick.t;
            // Its pixels are the view's last; the view was up from `since`.
            if (p.since < pick.t)
                addSeen(pick, p.since, pick.t);
            return;
        }
        if (v.shownBy)
            addSeen(v.shownBy.pick, p.since, left);
    }
    /** What the keyframes already show of `cand`, cached until they change. */
    view(cand) {
        const c = cand.view;
        if (c && c.version === this.version && c.epoch === this.liveEpoch)
            return c.view;
        const view = this.computeView(cand);
        cand.view = { version: this.version, epoch: this.liveEpoch, view };
        return view;
    }
    computeView(cand) {
        const none = {
            plain: null,
            inPlace: false,
            page: null,
            unseen: 1,
            gaps: [],
            shownBy: null,
            whole: false,
        };
        const recent = this.recent();
        // As it is, on any keyframe however long ago: a screen come back to.
        for (const k of recent) {
            if (changedCells(k.sig, cand.sig, MAJOR_TOTAL, this.ignoring(k, cand.sig)) >= MAJOR_TOTAL)
                continue;
            if (!isMajor(this.against(k, cand.sig))) {
                this.onScreen = k;
                return {
                    ...none,
                    plain: k,
                    unseen: 0,
                    shownBy: k,
                    whole: true,
                    page: k.page ? this.resolve(k.page) : null,
                };
            }
        }
        const vsig = cand.vsig;
        if (!vsig)
            return none;
        const ignore = this.busyOn(vsig);
        const matches = [];
        const pool = this.linkPool(recent);
        for (const k of pool) {
            if (!k.vsig)
                continue;
            const m = matchShift(k.vsig, vsig, ignore);
            if (m)
                matches.push({ k, m });
        }
        if (!matches.length) {
            // A jump further than a screen from anything recent (a flick of the
            // wheel, a link to a section read before): any keyframe of any page.
            const tried = new Set(pool);
            for (const k of recent) {
                if (tried.has(k) || !k.vsig || !k.page)
                    continue;
                const m = matchShift(k.vsig, vsig, ignore);
                if (!m)
                    continue;
                matches.push({ k, m });
                if (!changedInPlace(m))
                    break;
            }
        }
        if (!matches.length)
            return none;
        const nearest = (xs) => xs.reduce((a, b) => (Math.abs(b.m.dy) < Math.abs(a.m.dy) ? b : a));
        const clean = matches.filter((x) => !changedInPlace(x.m));
        if (!clean.length) {
            // Every keyframe it scrolled from shows something else in place (each
            // its own selection, say): row by row, others may still show it as it is.
            const link = nearest(matches);
            return this.coverage(vsig, ignore, this.place(link.k, link.m), link.k, false);
        }
        const link = nearest(clean);
        const page = this.place(link.k, link.m);
        // Every keyframe this view scrolled from is on the same page: join theirs.
        for (const other of clean)
            if (other !== link)
                this.join(page, other.k, other.m);
        return this.coverage(vsig, ignore, page, link.k, true);
    }
    /**
     * Which of the view's rows the page's keyframes show. The keyframe it
     * scrolled from is checked already when it matched clean; every other one is
     * compared at the offset the page gives it, so rows edited while off screen
     * read as unseen.
     */
    coverage(vsig, ignore, page, link, linkClean) {
        const [lo, hi] = viewRows(page);
        let gaps = [[lo, hi]];
        let shownBy = link;
        let most = -Infinity;
        /** Page rows a keyframe showed in another state: an edit, unless another keyframe shows it as it is. */
        const differ = [];
        const onPage = this.recent().filter((k) => k !== link && k.vsig && k.page && this.resolve(k.page).surface === page.surface);
        const rows = Math.max(1, hi - lo);
        let whole = false;
        for (const k of [link, ...onPage.slice(0, COVER_POOL)]) {
            if (!gaps.length && whole)
                break;
            if (!k.page || !k.vsig)
                continue;
            const at = this.resolve(k.page);
            const [kLo, kHi] = viewRows({ ...at, band: page.band });
            // Past the rows still unseen, a keyframe matters only as one that could show it whole.
            const overlap = Math.min(hi, kHi) - Math.max(lo, kLo);
            if (span(intersect(gaps, kLo, kHi)) <= 0 && (whole || overlap < rows * (1 - LOST_MIN)))
                continue;
            // What it shows as it is now: its rows, less any it showed in another state.
            let shown = [[Math.max(lo, kLo), Math.min(hi, kHi)]];
            let stale = false;
            if (k !== link || !linkClean) {
                const r = residualAt(k.vsig, vsig, page.band, page.off - at.off, ignore);
                if (r.rows < MIN_COMPARE_ROWS)
                    continue;
                if (changedInPlace(r)) {
                    stale = true;
                    for (const [a, b] of r.changed) {
                        differ.push([page.off + a, page.off + b]);
                        shown = subtract(shown, page.off + a, page.off + b);
                    }
                }
            }
            // A stand-in that shows the view as it was is the last resort.
            const shows = span(shown) - (stale ? rows : 0);
            if (shows > most) {
                shownBy = k;
                most = shows;
            }
            if (shows >= rows * (1 - LOST_MIN))
                whole = true;
            for (const [a, b] of shown)
                gaps = subtract(gaps, a, b);
        }
        const unseen = span(gaps) / rows;
        const edited = differ.some(([a, b]) => span(intersect(gaps, a, b)) > 0);
        return { plain: null, inPlace: edited, page, unseen, gaps, shownBy, whole };
    }
    /** Keyframes, newest first. */
    recent() {
        if (this.byRecency?.version !== this.version) {
            this.byRecency = {
                version: this.version,
                kept: [...this.kept].sort((a, b) => b.pick.t - a.pick.t),
            };
        }
        return this.byRecency.kept;
    }
    /** The keyframes a view is matched against: the recent ones, and the latest of every other page. */
    linkPool(recent) {
        const pool = recent.slice(0, SCROLL_WINDOW);
        const pages = new Set();
        for (const k of pool)
            if (k.page)
                pages.add(this.resolve(k.page).surface);
        for (const k of recent.slice(SCROLL_WINDOW)) {
            if (pages.size >= PAGE_POOL + SCROLL_WINDOW)
                break;
            if (!k.page || !k.vsig)
                continue;
            const surface = this.resolve(k.page).surface;
            if (pages.has(surface))
                continue;
            pages.add(surface);
            pool.push(k);
        }
        return pool;
    }
    /** Where a view that scrolled from `k` by `m` sits, giving `k` a page of its own first if it had none. */
    place(k, m) {
        if (!k.page) {
            this.surfaces.push({ parent: this.surfaces.length, shift: 0 });
            k.page = { surface: this.surfaces.length - 1, off: 0, band: m.band };
            this.version++;
        }
        const at = this.resolve(k.page);
        return { surface: at.surface, off: at.off + m.dy, band: m.band };
    }
    /** `k` shows the view at `page` scrolled by `m`: put it on that page, joining the two if it was on another. */
    join(page, k, m) {
        const off = page.off - m.dy;
        if (!k.page) {
            k.page = { surface: page.surface, off, band: m.band };
            this.version++;
            return;
        }
        const at = this.resolve(k.page);
        if (at.surface === page.surface)
            return;
        this.surfaces[at.surface] = { parent: page.surface, shift: off - at.off };
        this.version++;
    }
    /** A page position on its root surface. */
    resolve(p) {
        let surface = p.surface;
        let off = p.off;
        for (;;) {
            const node = this.surfaces[surface];
            if (!node || node.parent === surface)
                break;
            off += node.shift;
            surface = node.parent;
        }
        return { surface, off, band: p.band };
    }
    /** What a narration line's frame is weighed by: changed cells no keyframe explains. A page view the keyframes show has none. */
    unexplained(cand) {
        const v = this.view(cand);
        if (v.page && !v.plain && !v.inPlace)
            return 0;
        return this.closest(cand.sig).changed;
    }
    /** Did `b` follow `a` by scrolling? */
    scrolled(a, b) {
        return Boolean(a.vsig && b.vsig && matchShift(a.vsig, b.vsig));
    }
    /** The busy mask carried onto a scroll grid: a strip is busy when the main cell it sits in is. */
    busyOn(vsig) {
        const busy = this.busy;
        const main = this.last?.sig;
        if (!busy || !main)
            return null;
        const out = new Uint8Array(vsig.cols * vsig.rows);
        const sx = main.cols / vsig.cols;
        const sy = main.rows / vsig.rows;
        for (let y = 0; y < vsig.rows; y++) {
            const my = Math.min(main.rows - 1, Math.floor(y * sy));
            for (let x = 0; x < vsig.cols; x++) {
                const mx0 = Math.floor(x * sx);
                const mx1 = Math.min(main.cols - 1, Math.ceil((x + 1) * sx) - 1);
                for (let mx = mx0; mx <= mx1; mx++) {
                    if (busy[my * main.cols + mx]) {
                        out[y * vsig.cols + x] = 1;
                        break;
                    }
                }
            }
        }
        return out;
    }
    latest() {
        let best;
        for (const k of this.kept)
            if (!best || k.pick.t > best.pick.t)
                best = k;
        return best;
    }
    /** The diff against whichever recent keyframe this signature is closest to. */
    closest(sig) {
        const recent = [...this.kept].sort((a, b) => b.pick.t - a.pick.t).slice(0, DEDUP_WINDOW);
        let best = null;
        for (const k of recent) {
            const d = this.against(k, sig);
            if (!best || d.changed < best.changed)
                best = d;
        }
        return best ?? emptyDiff();
    }
    /**
     * The most recent keyframe stops being on screen at the first major
     * departure from it. When that departure lands back on the keyframe before
     * it, the state was a transient: a toast that came and went, a flash.
     */
    markHeld(t, sig) {
        const lastKept = this.latest();
        if (!lastKept || lastKept.pick.held !== undefined)
            return;
        if (!isMajor(this.against(lastKept, sig)))
            return;
        lastKept.pick.held = t - lastKept.pick.t;
        const before = this.settledBefore(lastKept.pick.t);
        if (before && !isMajor(this.against(before, sig)))
            lastKept.pick.transient = true;
    }
    /** The latest keyframe before `t` that wasn't a transient: what was really on screen. */
    settledBefore(t) {
        let best;
        for (const k of this.kept) {
            if (k.pick.t >= t || k.pick.transient)
                continue;
            if (!best || k.pick.t > best.pick.t)
                best = k;
        }
        return best;
    }
    record(cand, reason) {
        const previous = [...this.kept]
            .filter((k) => k.pick.t < cand.t)
            .sort((a, b) => b.pick.t - a.pick.t)[0];
        const pick = { id: this.nextId++, t: cand.t, reason, dist: cand.novelty.changed };
        if (previous && previous.pick.held === undefined)
            previous.pick.held = cand.t - previous.pick.t;
        // The box says what changed from what was really on screen, so a toast
        // that came and went in between doesn't stretch it.
        const before = this.settledBefore(cand.t);
        if (before) {
            const box = changeBox(this.against(before, cand.sig), cand.sig);
            if (box)
                pick.change = box;
            // Measured against the last whole screen, so details never stack.
            const base = before.pick.detail ? this.byId(before.pick.detail.of) : before;
            if (base && reason !== 'start') {
                const d = this.against(base, cand.sig);
                const small = d.changed > 0
                    ? (changeBox(d, cand.sig) ?? toBox(unionBox(d.regions), cand.sig))
                    : undefined;
                if (small && small.w * small.h <= DETAIL_MAX_AREA)
                    pick.detail = { of: base.pick.id, box: small };
            }
        }
        const v = this.view(cand);
        const page = v.page ?? undefined;
        const kept = { pick, sig: cand.sig, vsig: cand.vsig, ...(page ? { page } : {}) };
        if (this.videoKnown)
            kept.video = this.videoKnown.slice();
        this.kept.push(kept);
        this.onScreen = kept;
        this.version++;
        return pick;
    }
    byId(id) {
        return this.kept.find((k) => k.pick.id === id);
    }
    keep(cand, reason, out, from) {
        const pick = this.record(cand, reason);
        out.push({ kind: 'keep', from, pick });
        this.enforceBudget(out);
        return pick;
    }
    /** Over budget: drop the least-changed keyframe that isn't structural. */
    enforceBudget(out) {
        while (this.kept.length > this.budget) {
            const ordered = this.picks();
            const first = ordered[0];
            const lastPick = ordered[ordered.length - 1];
            let victim;
            const bases = new Set(this.kept.map((k) => k.pick.detail?.of));
            for (const k of this.kept) {
                if (k.pick === first || k.pick === lastPick)
                    continue;
                if (k.pick.reason === 'narration' || k.pick.reason === 'start')
                    continue;
                if (bases.has(k.pick.id))
                    continue;
                if (!victim || (k.pick.dist ?? 0) < (victim.pick.dist ?? 0))
                    victim = k;
            }
            if (!victim)
                return;
            this.kept.splice(this.kept.indexOf(victim), 1);
            this.version++;
            out.push({ kind: 'drop', id: victim.pick.id });
        }
    }
    /** Track, for the narration window this candidate falls in, the most informative candidate. */
    weighForWindows(cand, out) {
        const open = this.windows.find((w) => cand.t >= w.start && cand.t < w.end);
        if (!open)
            return;
        // A still screen over one mid-motion; then change; among equals, the
        // moment nearest the line's opening second.
        const score = (cand.moving ? 0 : 1e12) + cand.novelty.changed * 1e6 - Math.abs(cand.t - open.target);
        if (score <= open.bestScore)
            return;
        open.best = cand;
        open.bestScore = score;
        // One anchor slot: a window that takes it over from an earlier one has already outlived it.
        this.anchor = open;
        out.push({ kind: 'hold', slot: 'anchor' });
    }
    closeWindows(now, out) {
        while (this.windows.length && (this.windows[0]?.end ?? Infinity) <= now) {
            const w = this.windows.shift();
            if (!w)
                break;
            const covered = this.kept.some((k) => k.pick.t >= w.start && k.pick.t < w.end) ||
                (this.pending !== null && this.pending.t >= w.start && this.pending.t < w.end);
            const best = w.best;
            const lastKept = this.latest();
            // A frame already showing this screen covers the line too; only a
            // measurable change, or a picture gone stale, earns a new one. Measured
            // now, against everything kept since the candidate was seen.
            const changed = best ? this.unexplained(best) : 0;
            const earns = best !== null &&
                (changed >= BEAT_MIN_CELLS ||
                    (changed > 0 && (!lastKept || best.t - lastKept.pick.t >= STALE_MS)));
            if (!covered && best && earns && this.anchor === w) {
                this.keep(best, 'narration', out, 'anchor');
            }
            if (this.anchor === w)
                this.anchor = null;
        }
    }
}
/** `out` = `mask` grown by rx columns and ry rows (a separable max filter). */
/** Blocks within `reach` of a set one (a grid `bc` blocks across). */
function dilateBlocks(mask, bc, reach) {
    const out = new Uint8Array(mask.length);
    const br = Math.ceil(mask.length / bc);
    for (let b = 0; b < mask.length; b++) {
        if (!mask[b])
            continue;
        const bx = b % bc;
        const by = Math.floor(b / bc);
        for (let y = Math.max(0, by - reach); y <= Math.min(br - 1, by + reach); y++)
            out.fill(1, y * bc + Math.max(0, bx - reach), y * bc + Math.min(bc - 1, bx + reach) + 1);
    }
    return out;
}
/**
 * The cells of a small step that vote for video: all of them, less lines of
 * the UI, and less the pointer's blobs when that is all the small change there is.
 */
function votes(step, changed, cols) {
    const strips = step.regions.filter((r) => r.w >= VIDEO_STRIP && r.w > VIDEO_STRIP_ASPECT * r.h);
    const small = step.regions.filter((r) => r.w < POINTER_CELLS && r.h < POINTER_CELLS);
    const pointer = small.length > 0 && small.length <= 2 && step.regions.length < MAX_REGIONS;
    if (!strips.length && !pointer)
        return changed;
    const out = changed.slice();
    for (const r of pointer ? [...strips, ...small] : strips)
        for (let y = r.y; y < r.y + r.h; y++)
            out.fill(0, y * cols + r.x, y * cols + r.x + r.w);
    return out;
}
function dilate(mask, out, cols, rows, rx, ry) {
    const row = new Uint8Array(mask.length);
    for (let y = 0; y < rows; y++) {
        // Two sweeps per row: nearest set cell to the left, then to the right.
        let last = -Infinity;
        for (let x = 0; x < cols; x++) {
            if (mask[y * cols + x])
                last = x;
            row[y * cols + x] = x - last <= rx ? 1 : 0;
        }
        last = Infinity;
        for (let x = cols - 1; x >= 0; x--) {
            if (mask[y * cols + x])
                last = x;
            if (last - x <= rx)
                row[y * cols + x] = 1;
        }
    }
    for (let x = 0; x < cols; x++) {
        let last = -Infinity;
        for (let y = 0; y < rows; y++) {
            if (row[y * cols + x])
                last = y;
            out[y * cols + x] = y - last <= ry ? 1 : 0;
        }
        last = Infinity;
        for (let y = rows - 1; y >= 0; y--) {
            if (row[y * cols + x])
                last = y;
            if (last - y <= ry)
                out[y * cols + x] = 1;
        }
    }
}
function emptyDiff() {
    return { changed: 0, fraction: 0, energy: 0, box: null, regions: [] };
}
/** The regions that matter, as one normalized box; none when the whole screen moved or nothing major did. */
function changeBox(d, sig) {
    const box = toBox(unionBox(d.regions.filter((r) => r.cells >= BOX_REGION)), sig);
    return box && box.w * box.h <= BOX_MAX_AREA ? box : undefined;
}
/** A cell box as fractions of the frame, to three places. */
function toBox(box, sig) {
    if (!box)
        return undefined;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    return {
        x: r3(box.x / sig.cols),
        y: r3(box.y / sig.rows),
        w: r3(box.w / sig.cols),
        h: r3(box.h / sig.rows),
    };
}
/** Strip rows [from, to) of a page that a view shows, less the edges. */
function viewRows(p) {
    return [p.off + p.band.y0 + PAGE_EDGE, p.off + p.band.y1 + 1 - PAGE_EDGE];
}
function span(gaps) {
    return gaps.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
}
function intersect(gaps, lo, hi) {
    const out = [];
    for (const [a, b] of gaps)
        if (Math.min(b, hi) > Math.max(a, lo))
            out.push([Math.max(a, lo), Math.min(b, hi)]);
    return out;
}
function subtract(gaps, lo, hi) {
    const out = [];
    for (const [a, b] of gaps) {
        if (b <= lo || a >= hi)
            out.push([a, b]);
        else {
            if (a < lo)
                out.push([a, lo]);
            if (b > hi)
                out.push([hi, b]);
        }
    }
    return out;
}
/** Note that `pick` stood for the screen over [from, to), merging with a span it continues. */
function copyInto(into, from) {
    if (!into || into.length !== from.length)
        return from.slice();
    into.set(from);
    return into;
}
function addSeen(pick, from, to) {
    if (to <= from)
        return;
    const own = pick.t + (pick.held ?? 0);
    if (from >= pick.t && to <= own)
        return;
    const seen = (pick.seen ??= []);
    const prev = seen[seen.length - 1];
    if (prev && from <= prev[1])
        prev[1] = Math.max(prev[1], to);
    else
        seen.push([from, to]);
}
