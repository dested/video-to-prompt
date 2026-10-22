import { throwIfAborted } from './cancel.js'
import { openFrameSource, type FrameEngine, type SourceFrame } from './decode.js'
import { canvas2d, Keeper, toRecordingFrame } from './keeper.js'
import { Selector, type NarrationWindow, type SelectAction } from './select.js'
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
const FRAMES_PER_MIN = 40
const MIN_FRAME_BUDGET = 150
const MAX_FRAME_BUDGET = 600
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
  const keeper = new Keeper()
  /** By pick id until the end, when picks are renumbered in time order. */
  const byId = new Map<number, Blob>()
  let sampled = 0

  const apply = async (actions: SelectAction[], frame: SourceFrame | null) => {
    for (const action of actions) {
      if (action.kind === 'hold') {
        if (frame) keeper.hold(action.slot, frame)
      } else if (action.kind === 'keep') {
        const from = action.from === 'current' ? frame : action.from
        if (!from) continue
        byId.set(action.pick.id, (await keeper.encode(action.pick, from)).jpeg)
      } else if (action.kind === 'drop') {
        byId.delete(action.id)
      } else {
        for await (const again of source.frames([action.t], opts.signal)) {
          byId.set(action.pick.id, (await keeper.encode(action.pick, again)).jpeg)
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
