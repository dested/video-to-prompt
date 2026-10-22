import { throwIfAborted } from './cancel.js'
import { openFrameSource, type FrameEngine, type SourceFrame } from './decode.js'
import { mmssFile, pad2 } from './format.js'
import { toJpeg } from './media.js'
import {
  Selector,
  type NarrationWindow,
  type Pick,
  type SelectAction,
  type Slot,
} from './select.js'
import { VSIG_COLS, vsigRows } from './scroll.js'
import { SIG_COLS, sigRows, signatureFromRgba, type Signature } from './signature.js'
import type { FrameBox, RecordingFrame } from './types.js'

/**
 * Keyframe extraction from an already-recorded file. A candidate every
 * `stepMs`, two signatures of each (the change grid and the scroll grid), and
 * `Selector` deciding which survive (see select.ts for the rule). Only the
 * keepers are ever encoded, and at most three full-size candidates are held at
 * once, so memory is the keepers' JPEGs whatever the clip's length.
 *
 * Cadence depends on the engine. WebCodecs decodes every packet once anyway,
 * so a candidate costs a canvas draw: 250 ms, dense enough that a toast shown
 * for half a second is seen twice. The seek fallback pays a decode from the
 * previous keyframe per candidate, which on iOS is the whole cost of the run:
 * it keeps the first version's one second.
 */

const STEP_MS: Record<FrameEngine, number> = { webcodecs: 250, seek: 1000 }
/** Past this many candidates the step stretches. 2 h at 250 ms; 30 min at 1 s. */
const MAX_CANDIDATES: Record<FrameEngine, number> = { webcodecs: 28800, seek: 1800 }
const MAX_FRAME_W = 1920
/** Held candidates keep this much width, so a detail is cut from the screen's own pixels (a 5K screen keeps 3840). */
const MAX_HOLD_W = 3840
/** A detail is cut with this much context on every side of the change, as a share of the frame… */
const DETAIL_PAD = 0.03
/** …and never narrower or shorter than this share of it, so the change has surroundings to be read in. */
const DETAIL_MIN_W = 0.2
const DETAIL_MIN_H = 0.12
/** Detail images are no wider than this. */
const DETAIL_MAX_W = 1600
const FRAMES_PER_MIN = 40
const MIN_FRAME_BUDGET = 150
const MAX_FRAME_BUDGET = 600
const JPEG_QUALITY = 0.8 // 0.9 until 2026-08-25 — mirrors handback (frames dominate upload size)
/** The last candidate sits this far before the end: a seek to the exact duration can land on nothing. */
const TAIL_MS = 100

/**
 * The old per-length cap (40 a minute, 150–600). Extraction no longer uses
 * one: a frame is kept because it shows something, never dropped for count.
 * @deprecated Kept for live recorders that still cap themselves; goes in 2.0.
 */
export function frameBudget(durationMs: number): number {
  const byLength = Math.round((durationMs / 60000) * FRAMES_PER_MIN)
  return Math.min(MAX_FRAME_BUDGET, Math.max(MIN_FRAME_BUDGET, byLength))
}

export interface ExtractOptions {
  /** 0..1 through this clip. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** The take's transcript: every line whose window passes with no keyframe gets one. */
  narration?: NarrationWindow[]
  /** 'auto' (default): WebCodecs where the browser can decode the file, seeking otherwise. */
  engine?: FrameEngine | 'auto'
  /** Only this part of the picture (fractions of the frame). */
  crop?: FrameBox
}

export interface ExtractedFrames {
  /** Kept frames in time order, numbered 1..N. */
  frames: RecordingFrame[]
  /** JPEG per kept frame, keyed by its index. Held in memory — a clip is one-shot. */
  blobs: Map<number, Blob>
  /** Candidates examined. The MANIFEST reports it. */
  sampled: number
  /** Which engine produced the candidates, and how far apart they were. */
  engine: FrameEngine
  stepMs: number
}

export function candidateTimes(
  durationMs: number,
  engine: FrameEngine
): { times: number[]; stepMs: number } {
  const stepMs = Math.max(STEP_MS[engine], Math.ceil(durationMs / MAX_CANDIDATES[engine]))
  const times: number[] = []
  for (let t = 0; t < durationMs; t += stepMs) times.push(t)
  const tail = Math.max(0, durationMs - TAIL_MS)
  if (times.length && tail - (times[times.length - 1] ?? 0) > stepMs / 2) times.push(tail)
  return { times, stepMs }
}

export async function extractFrames(
  file: Blob,
  durationMs: number,
  opts: ExtractOptions = {}
): Promise<ExtractedFrames> {
  const blobs = new Map<number, Blob>()
  if (durationMs <= 0) return { frames: [], blobs, sampled: 0, engine: 'seek', stepMs: 0 }

  const source = await openFrameSource(file, {
    engine: opts.engine,
    signal: opts.signal,
    crop: opts.crop,
  })
  const engine = source.engine
  const { times, stepMs } = candidateTimes(durationMs, engine)
  const selector = new Selector({ durationMs, narration: opts.narration })

  const sigCtx = canvas2d(SIG_COLS, 1, true)
  const vsigCtx = canvas2d(VSIG_COLS, 1, true)
  const slots: Record<Slot, CanvasRenderingContext2D> = {
    pending: canvas2d(1, 1, false),
    anchor: canvas2d(1, 1, false),
    parked: canvas2d(1, 1, false),
  }
  const scratch = canvas2d(1, 1, false)
  /** By pick id until the end, when picks are renumbered in time order. */
  const byId = new Map<number, Blob>()
  let sampled = 0

  const out = canvas2d(1, 1, false)
  const fit = (ctx: CanvasRenderingContext2D, frame: SourceFrame) => {
    const width = Math.min(frame.width, MAX_HOLD_W)
    const height = Math.round((frame.height * width) / frame.width)
    if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
      ctx.canvas.width = width
      ctx.canvas.height = height
    }
    ctx.imageSmoothingQuality = 'high'
    frame.draw(ctx, width, height)
  }
  /** The whole screen at MAX_FRAME_W, or a detail's region of it at up to DETAIL_MAX_W. */
  const encode = async (ctx: CanvasRenderingContext2D, pick: Pick) => {
    const src = ctx.canvas
    const region = pick.detail ? detailCrop(pick.detail.box) : { x: 0, y: 0, w: 1, h: 1 }
    const sw = region.w * src.width
    const sh = region.h * src.height
    const width = Math.round(Math.min(sw, pick.detail ? DETAIL_MAX_W : MAX_FRAME_W))
    const height = Math.round((sh * width) / sw)
    if (out.canvas.width !== width || out.canvas.height !== height) {
      out.canvas.width = width
      out.canvas.height = height
    }
    out.imageSmoothingQuality = 'high'
    out.drawImage(src, region.x * src.width, region.y * src.height, sw, sh, 0, 0, width, height)
    byId.set(pick.id, await toJpeg(out.canvas, JPEG_QUALITY))
  }
  const apply = async (actions: SelectAction[], frame: SourceFrame | null) => {
    for (const action of actions) {
      if (action.kind === 'hold') {
        if (frame) fit(slots[action.slot], frame)
      } else if (action.kind === 'keep') {
        if (action.from === 'current') {
          if (!frame) continue
          fit(scratch, frame)
          await encode(scratch, action.pick)
        } else {
          await encode(slots[action.from], action.pick)
        }
      } else if (action.kind === 'drop') {
        byId.delete(action.id)
      } else {
        for await (const again of source.frames([action.t], opts.signal)) {
          fit(scratch, again)
          await encode(scratch, action.pick)
        }
      }
    }
  }

  try {
    for await (const frame of source.frames(times, opts.signal)) {
      throwIfAborted(opts.signal)
      sampled++
      const sig = readSignature(sigCtx, frame)
      const vsig = readSignature(vsigCtx, frame, VSIG_COLS, vsigRows(sig.rows))
      await apply(selector.push(frame.t, sig, vsig), frame)
      opts.onProgress?.(frame.t / durationMs)
    }
    await apply(selector.finish(), null)
    opts.onProgress?.(1)
  } finally {
    source.close()
  }

  const frames: RecordingFrame[] = []
  const indexOf = new Map<number, number>()
  for (const pick of selector.picks()) {
    const blob = byId.get(pick.id)
    if (!blob) continue
    const index = frames.length + 1
    blobs.set(index, blob)
    indexOf.set(pick.id, index)
    frames.push(toRecordingFrame(pick, index, indexOf))
  }
  return { frames, blobs, sampled, engine, stepMs }
}

/** The region a detail is cut from: the change, padded, grown to a readable minimum, kept on screen. */
export function detailCrop(change: FrameBox): FrameBox {
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  const axis = (at: number, size: number, min: number): [number, number] => {
    let len = Math.min(1, Math.max(size + 2 * DETAIL_PAD, min))
    let start = at + size / 2 - len / 2
    start = Math.min(Math.max(0, start), 1 - len)
    len = Math.min(len, 1 - start)
    return [r3(start), r3(len)]
  }
  const [x, w] = axis(change.x, change.w, DETAIL_MIN_W)
  const [y, h] = axis(change.y, change.h, DETAIL_MIN_H)
  return { x, y, w, h }
}

function toRecordingFrame(pick: Pick, index: number, indexOf: Map<number, number>): RecordingFrame {
  const base = pick.detail ? indexOf.get(pick.detail.of) : undefined
  return {
    index,
    t: pick.t,
    file: `frames/${pad2(index)}-${mmssFile(pick.t)}.jpg`,
    reason: pick.reason,
    ...(pick.dist === undefined ? {} : { dist: pick.dist }),
    ...(pick.change ? { change: pick.change } : {}),
    ...(pick.held === undefined ? {} : { held: pick.held }),
    ...(pick.transient ? { transient: true } : {}),
    ...(pick.seen?.length ? { seen: pick.seen } : {}),
    ...(pick.detail && base !== undefined
      ? { detail: { of: base, box: detailCrop(pick.detail.box) } }
      : {}),
  }
}

function canvas2d(width: number, height: number, readback: boolean): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined)
  if (!ctx) throw new Error("couldn't read frames from that video")
  return ctx
}

/** Shrink a frame onto a signature grid (by default the change grid, aspect kept) and read it back as luma. */
export function readSignature(
  ctx: CanvasRenderingContext2D,
  frame: SourceFrame,
  cols = SIG_COLS,
  rows = sigRows(frame.width, frame.height)
): Signature {
  if (ctx.canvas.width !== cols || ctx.canvas.height !== rows) {
    ctx.canvas.width = cols
    ctx.canvas.height = rows
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  frame.draw(ctx, cols, rows)
  return signatureFromRgba(ctx.getImageData(0, 0, cols, rows).data, cols, rows)
}
