import type { SourceFrame } from './decode.js'
import { mmssFile, pad2 } from './format.js'
import { toJpeg } from './media.js'
import type { Pick, Slot } from './select.js'
import type { FrameBox, FramePointer, RecordingFrame } from './types.js'

/**
 * The pixels behind a Selector's decisions, shared by the extractor (a
 * finished clip) and LiveFrames (a capture still running): the three slots a
 * candidate can be held in until it's decided, and the JPEG of whatever is
 * kept, the whole screen or a detail's region of it.
 */

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
const JPEG_QUALITY = 0.8 // 0.9 until 2026-08-25 — mirrors handback (frames dominate upload size)

/**
 * Draws on a whole-screen keyframe as it's encoded (a live recorder's pointer)
 * and says what it drew. `t` is the keyframe's time, which for a held
 * candidate is earlier than now.
 */
export type Decorate = (
  ctx: CanvasRenderingContext2D,
  t: number,
  width: number,
  height: number
) => FramePointer | undefined

export interface Encoded {
  jpeg: Blob
  pointer?: FramePointer
}

export class Keeper {
  private readonly slots: Record<Slot, CanvasRenderingContext2D> = {
    pending: canvas2d(1, 1, false),
    anchor: canvas2d(1, 1, false),
    parked: canvas2d(1, 1, false),
  }
  private readonly scratch = canvas2d(1, 1, false)
  private readonly out = canvas2d(1, 1, false)

  constructor(private readonly decorate?: Decorate) {}

  /** Copy `frame` into `slot`, replacing what it held. */
  hold(slot: Slot, frame: SourceFrame): void {
    fit(this.slots[slot], frame)
  }

  /** The JPEG for `pick`, from a slot or straight from `frame`. */
  async encode(pick: Pick, from: Slot | SourceFrame): Promise<Encoded> {
    let ctx: CanvasRenderingContext2D
    if (typeof from === 'string') ctx = this.slots[from]
    else {
      fit(this.scratch, from)
      ctx = this.scratch
    }
    const src = ctx.canvas
    const region = pick.detail ? detailCrop(pick.detail.box) : { x: 0, y: 0, w: 1, h: 1 }
    const sw = region.w * src.width
    const sh = region.h * src.height
    const width = Math.round(Math.min(sw, pick.detail ? DETAIL_MAX_W : MAX_FRAME_W))
    const height = Math.round((sh * width) / sw)
    const out = this.out
    if (out.canvas.width !== width || out.canvas.height !== height) {
      out.canvas.width = width
      out.canvas.height = height
    }
    out.imageSmoothingQuality = 'high'
    out.drawImage(src, region.x * src.width, region.y * src.height, sw, sh, 0, 0, width, height)
    const pointer = pick.detail ? undefined : this.decorate?.(out, pick.t, width, height)
    return { jpeg: await toJpeg(out.canvas, JPEG_QUALITY), ...(pointer ? { pointer } : {}) }
  }
}

function fit(ctx: CanvasRenderingContext2D, frame: SourceFrame): void {
  const width = Math.min(frame.width, MAX_HOLD_W)
  const height = Math.round((frame.height * width) / frame.width)
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx.canvas.width = width
    ctx.canvas.height = height
  }
  ctx.imageSmoothingQuality = 'high'
  frame.draw(ctx, width, height)
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

/** A pick as recording.json says it: numbered `index`, its detail's base by that numbering. */
export function toRecordingFrame(
  pick: Pick,
  index: number,
  indexOf: Map<number, number>,
  pointer?: FramePointer
): RecordingFrame {
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
    ...(pointer ? { pointer } : {}),
  }
}

export function canvas2d(width: number, height: number, readback: boolean): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined)
  if (!ctx) throw new Error("couldn't read frames from that video")
  return ctx
}
