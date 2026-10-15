import { throwIfAborted } from './cancel.js';
import { openFrameSource } from './decode.js';
import { mmssFile, pad2 } from './format.js';
import { toJpeg } from './media.js';
import { Selector, } from './select.js';
import { SIG_COLS, sigRows, signatureFromRgba } from './signature.js';
/**
 * Keyframe extraction from an already-recorded file. A candidate every
 * `stepMs`, a signature of each, and `Selector` deciding which survive (see
 * select.ts for the rule). Only the keepers are ever encoded, and at most two
 * full-size candidates are held at once, so memory is the budget's worth of
 * JPEGs whatever the clip's length.
 *
 * Cadence depends on the engine. WebCodecs decodes every packet once anyway,
 * so a candidate costs a canvas draw: 250 ms, dense enough that a toast shown
 * for half a second is seen twice. The seek fallback pays a decode from the
 * previous keyframe per candidate, which on iOS is the whole cost of the run:
 * it keeps the first version's one second.
 */
const STEP_MS = { webcodecs: 250, seek: 1000 };
/** Past this many candidates the step stretches. 30 min at 250 ms; 30 min at 1 s. */
const MAX_CANDIDATES = { webcodecs: 7200, seek: 1800 };
const FRAMES_PER_MIN = 40;
const MIN_FRAME_BUDGET = 150;
const MAX_FRAME_BUDGET = 600;
const MAX_FRAME_W = 1920;
const JPEG_QUALITY = 0.8; // 0.9 until 2026-08-25 — mirrors handback (frames dominate upload size)
/** The last candidate sits this far before the end: a seek to the exact duration can land on nothing. */
const TAIL_MS = 100;
/** How many keyframes a take of this length may keep. A cap, not a target. */
export function frameBudget(durationMs) {
    const byLength = Math.round((durationMs / 60000) * FRAMES_PER_MIN);
    return Math.min(MAX_FRAME_BUDGET, Math.max(MIN_FRAME_BUDGET, byLength));
}
export function candidateTimes(durationMs, engine) {
    const stepMs = Math.max(STEP_MS[engine], Math.ceil(durationMs / MAX_CANDIDATES[engine]));
    const times = [];
    for (let t = 0; t < durationMs; t += stepMs)
        times.push(t);
    const tail = Math.max(0, durationMs - TAIL_MS);
    if (times.length && tail - (times[times.length - 1] ?? 0) > stepMs / 2)
        times.push(tail);
    return { times, stepMs };
}
export async function extractFrames(file, durationMs, opts = {}) {
    const blobs = new Map();
    if (durationMs <= 0)
        return { frames: [], blobs, sampled: 0, engine: 'seek', stepMs: 0 };
    const source = await openFrameSource(file, { engine: opts.engine, signal: opts.signal });
    const engine = source.engine;
    const { times, stepMs } = candidateTimes(durationMs, engine);
    const selector = new Selector({
        durationMs,
        budget: frameBudget(durationMs),
        narration: opts.narration,
    });
    const sigCtx = canvas2d(SIG_COLS, 1, true);
    const slots = {
        pending: canvas2d(1, 1, false),
        anchor: canvas2d(1, 1, false),
    };
    const scratch = canvas2d(1, 1, false);
    /** By pick id until the end, when picks are renumbered in time order. */
    const byId = new Map();
    let sampled = 0;
    const fit = (ctx, frame) => {
        const width = Math.min(frame.width, MAX_FRAME_W);
        const height = Math.round((frame.height * width) / frame.width);
        if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
            ctx.canvas.width = width;
            ctx.canvas.height = height;
        }
        ctx.imageSmoothingQuality = 'high';
        frame.draw(ctx, width, height);
    };
    const encode = async (ctx, id) => {
        byId.set(id, await toJpeg(ctx.canvas, JPEG_QUALITY));
    };
    const apply = async (actions, frame) => {
        for (const action of actions) {
            if (action.kind === 'hold') {
                if (frame)
                    fit(slots[action.slot], frame);
            }
            else if (action.kind === 'keep') {
                if (action.from === 'current') {
                    if (!frame)
                        continue;
                    fit(scratch, frame);
                    await encode(scratch, action.pick.id);
                }
                else {
                    await encode(slots[action.from], action.pick.id);
                }
            }
            else if (action.kind === 'drop') {
                byId.delete(action.id);
            }
            else {
                for await (const again of source.frames([action.t], opts.signal)) {
                    fit(scratch, again);
                    await encode(scratch, action.pick.id);
                }
            }
        }
    };
    try {
        let sig = null;
        for await (const frame of source.frames(times, opts.signal)) {
            throwIfAborted(opts.signal);
            sampled++;
            sig = readSignature(sigCtx, frame);
            await apply(selector.push(frame.t, sig), frame);
            opts.onProgress?.(frame.t / durationMs);
        }
        await apply(selector.finish(), null);
        opts.onProgress?.(1);
    }
    finally {
        source.close();
    }
    const frames = [];
    for (const pick of selector.picks()) {
        const blob = byId.get(pick.id);
        if (!blob)
            continue;
        const index = frames.length + 1;
        blobs.set(index, blob);
        frames.push(toRecordingFrame(pick, index));
    }
    return { frames, blobs, sampled, engine, stepMs };
}
function toRecordingFrame(pick, index) {
    return {
        index,
        t: pick.t,
        file: `frames/${pad2(index)}-${mmssFile(pick.t)}.jpg`,
        reason: pick.reason,
        ...(pick.dist === undefined ? {} : { dist: pick.dist }),
        ...(pick.change ? { change: pick.change } : {}),
        ...(pick.held === undefined ? {} : { held: pick.held }),
        ...(pick.transient ? { transient: true } : {}),
    };
}
function canvas2d(width, height, readback) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined);
    if (!ctx)
        throw new Error("couldn't read frames from that video");
    return ctx;
}
/** Shrink a frame onto the signature grid (aspect kept) and read it back as luma. */
export function readSignature(ctx, frame) {
    const cols = SIG_COLS;
    const rows = sigRows(frame.width, frame.height);
    if (ctx.canvas.width !== cols || ctx.canvas.height !== rows) {
        ctx.canvas.width = cols;
        ctx.canvas.height = rows;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    frame.draw(ctx, cols, rows);
    return signatureFromRgba(ctx.getImageData(0, 0, cols, rows).data, cols, rows);
}
