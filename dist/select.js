import { diffSignatures, unionBox, } from './signature.js';
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
export const MAJOR_REGION = 12;
/** Total changed cells that make a change major even when it is scattered. */
export const MAJOR_TOTAL = 40;
/** Continuous motion yields one keyframe per this long. */
const MAX_MOTION_MS = 2000;
/** Kept frames a new state is compared against. */
const DEDUP_WINDOW = 4;
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
/** A line with no reported length is assumed to run this long per word. */
const WORD_MS = 380;
/** A narration line whose screen shows no measurable change still gets a fresh frame once the last one is this old. */
const STALE_MS = 8000;
/** Heat halves this often. */
const HEAT_HALF_LIFE_MS = 10000;
/** Heat at which a cell counts as busy: three small changes within a few seconds. */
const BUSY_HEAT = 2.5;
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
    prevT = -1;
    last = null;
    anchor = null;
    heat = null;
    busy = null;
    scratch = null;
    spread = new Uint8Array(0);
    constructor(opts) {
        this.durationMs = opts.durationMs;
        this.budget = Math.max(2, opts.budget);
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
    push(t, sig) {
        const out = [];
        this.warm(t, sig);
        this.prevT = t;
        if (!this.kept.length) {
            // The opening settles like any change: a recording usually starts on the
            // recorder's own picker or countdown getting out of the way.
            const cand = { t, sig, novelty: emptyDiff() };
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
        const cand = { t, sig, novelty };
        this.markHeld(t, sig);
        // Narration windows that end here decide before this candidate is weighed.
        this.closeWindows(t, out);
        const novel = isMajor(novelty);
        if (this.pending) {
            const fromPending = this.diff(this.pending.sig, sig);
            if (!isMajor(fromPending)) {
                // Held still: the pending state is real.
                this.keep(this.pending, 'change', out, 'pending');
                this.pending = null;
            }
            else if (!novel) {
                // Snapped back to something already kept: the pending state was a flash, gone as of now.
                const pick = this.keep(this.pending, 'change', out, 'pending');
                pick.transient = true;
                pick.held = t - pick.t;
                this.pending = null;
            }
            else if (t - this.pendingSince >= MAX_MOTION_MS) {
                // Still moving after a while: keep where it had got to and keep watching.
                const pick = this.keep(this.pending, 'change', out, 'pending');
                pick.held = t - pick.t;
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
            this.pending = cand;
            this.pendingSince = t;
            out.push({ kind: 'hold', slot: 'pending' });
        }
        else {
            const lastKept = this.latest();
            if (lastKept &&
                t - lastKept.pick.t >= BEAT_MS &&
                this.diff(lastKept.sig, sig).changed >= BEAT_MIN_CELLS) {
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
            const pick = this.keep(this.pending, opening ? 'start' : 'change', out, 'pending');
            if (opening)
                pick.dist = undefined;
            this.pending = null;
        }
        this.closeWindows(Infinity, out);
        const last = this.last;
        const lastKept = this.latest();
        if (last && lastKept && last.t > lastKept.pick.t) {
            // A transient last keyframe already went back to the one before it, so that is what's showing.
            const shown = (lastKept.pick.transient && this.settledBefore(lastKept.pick.t)) || lastKept;
            const d = this.diff(shown.sig, last.sig);
            if (isMajor(d) || (d.changed >= BEAT_MIN_CELLS && last.t - lastKept.pick.t >= FINAL_GAP_MS)) {
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
    warm(t, sig) {
        const prev = this.last;
        const cells = sig.cols * sig.rows;
        if (!this.heat || this.heat.length !== cells) {
            this.heat = new Float32Array(cells);
            this.busy = new Uint8Array(cells);
            this.scratch = new Uint8Array(cells);
            this.spread = new Uint8Array(cells);
        }
        if (!prev || !this.busy || !this.scratch)
            return;
        const heat = this.heat;
        const busy = this.busy;
        const decay = Math.pow(0.5, Math.max(0, t - prev.t) / HEAT_HALF_LIFE_MS);
        const step = diffSignatures(prev.sig, sig, { mask: this.scratch });
        const heats = step.changed > 0 && step.fraction <= HEAT_MAX_FRACTION;
        if (heats)
            dilate(this.scratch, this.spread, sig.cols, sig.rows, HEAT_SPREAD_X, HEAT_SPREAD_Y);
        // One unit per change event to every cell within reach of it, so text that
        // grows in place (a live caption gaining words) turns busy as a line rather
        // than glyph by glyph, while a toast that comes and goes adds only two.
        for (let i = 0; i < cells; i++) {
            heat[i] = (heat[i] ?? 0) * decay + (heats && this.spread[i] ? 1 : 0);
        }
        for (let i = 0; i < cells; i++)
            busy[i] = (heat[i] ?? 0) >= BUSY_HEAT ? 1 : 0;
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
            const d = this.diff(k.sig, sig);
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
        if (!isMajor(this.diff(lastKept.sig, sig)))
            return;
        lastKept.pick.held = t - lastKept.pick.t;
        const before = this.settledBefore(lastKept.pick.t);
        if (before && !isMajor(this.diff(before.sig, sig)))
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
            const box = changeBox(this.diff(before.sig, cand.sig), cand.sig);
            if (box)
                pick.change = box;
        }
        this.kept.push({ pick, sig: cand.sig });
        return pick;
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
            for (const k of this.kept) {
                if (k.pick === first || k.pick === lastPick)
                    continue;
                if (k.pick.reason === 'narration' || k.pick.reason === 'start')
                    continue;
                if (!victim || (k.pick.dist ?? 0) < (victim.pick.dist ?? 0))
                    victim = k;
            }
            if (!victim)
                return;
            this.kept.splice(this.kept.indexOf(victim), 1);
            out.push({ kind: 'drop', id: victim.pick.id });
        }
    }
    /** Track, for the narration window this candidate falls in, the most informative candidate. */
    weighForWindows(cand, out) {
        const open = this.windows.find((w) => cand.t >= w.start && cand.t < w.end);
        if (!open)
            return;
        // Change first; among equals, the moment nearest the line's opening second.
        const score = cand.novelty.changed * 1e6 - Math.abs(cand.t - open.target);
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
            const changed = best ? this.closest(best.sig).changed : 0;
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
    const regions = d.regions.filter((r) => r.cells >= BOX_REGION);
    const box = unionBox(regions);
    if (!box)
        return undefined;
    const area = (box.w * box.h) / (sig.cols * sig.rows);
    if (area > BOX_MAX_AREA)
        return undefined;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    return {
        x: r3(box.x / sig.cols),
        y: r3(box.y / sig.rows),
        w: r3(box.w / sig.cols),
        h: r3(box.h / sig.rows),
    };
}
