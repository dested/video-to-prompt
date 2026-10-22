import type { SourceFrame } from './decode.js'
import { readSignature } from './frames.js'
import { canvas2d, Keeper, toRecordingFrame, type Decorate } from './keeper.js'
import { VSIG_COLS, vsigRows } from './scroll.js'
import { Selector, type SelectAction } from './select.js'
import { SIG_COLS } from './signature.js'
import type { FrameBox, FramePointer, RecordingFrame } from './types.js'

/**
 * The extractor's rule for a capture that is still running: a recorder hands
 * over its `<video>` of the screen share every LIVE_STEP_MS, and the frames it
 * gets back are the ones a finished clip of the same screen would get. The
 * Selector is online already; what this adds is the pixels. A held candidate
 * is copied when the Selector says hold, a kept one is encoded when it says
 * keep, and the recorder stores the JPEG under the pick's key, so a take that
 * dies mid-recording still has every frame decided so far.
 *
 * What a finished clip has that a live one doesn't is its transcript. The
 * recorder says when speech starts and stops instead (`openLine`/`closeLine`),
 * from its own voice detection, and each line gets its picture the same way.
 */

/** Candidate cadence: the extractor's WebCodecs step. */
export const LIVE_STEP_MS = 250

export interface LiveFramesOptions {
  /** Keep this JPEG as frame `key`. Awaited before the next candidate is read. */
  store(key: number, jpeg: Blob): Promise<void>
  /** Frame `key` is no longer kept (only ever with a budget). */
  discard?(key: number): Promise<void>
  /** Only this part of the picture (fractions of the frame). */
  crop?: FrameBox
  /** Most frames to keep. Default: no limit. */
  budget?: number
  /** Draw on a whole-screen frame as it's encoded (the pointer) and say what was drawn. */
  decorate?: Decorate
}

export interface LiveFrame {
  frame: RecordingFrame
  /** What `store` was given for this frame's JPEG. */
  key: number
}

export class LiveFrames {
  private readonly selector: Selector
  private readonly keeper: Keeper
  private readonly sigCtx = canvas2d(SIG_COLS, 1, true)
  private readonly vsigCtx = canvas2d(VSIG_COLS, 1, true)
  /** Pick id → the pointer drawn on it; present once its JPEG is stored. */
  private readonly stored = new Map<number, FramePointer | undefined>()
  private count = 0

  constructor(private readonly opts: LiveFramesOptions) {
    this.selector = new Selector({ budget: opts.budget })
    this.keeper = new Keeper(opts.decorate)
  }

  /** Candidates read so far. */
  get sampled(): number {
    return this.count
  }

  /** For recording.json: these frames carry change boxes and format 2 `dist`. */
  get sampling(): { engine: string; stepMs: number } {
    return { engine: 'live', stepMs: LIVE_STEP_MS }
  }

  /** The screen as `video` shows it now, `t` ms into the take. Await it before the next. */
  async push(t: number, video: HTMLVideoElement): Promise<void> {
    const frame = liveFrame(video, t, this.opts.crop)
    if (!frame) return
    this.count++
    const sig = readSignature(this.sigCtx, frame)
    const vsig = readSignature(this.vsigCtx, frame, VSIG_COLS, vsigRows(sig.rows))
    await this.apply(this.selector.push(t, sig, vsig), frame)
  }

  /** Someone started talking at `t`. */
  openLine(t: number): void {
    this.selector.openLine(t)
  }

  /** The talking stopped at `t`. */
  closeLine(t: number): void {
    this.selector.closeLine(t)
  }

  /** The take ended at `t`; `video` still shows its last picture (null once the share is gone). */
  async finish(t: number, video: HTMLVideoElement | null): Promise<void> {
    const frame = video ? liveFrame(video, t, this.opts.crop) : null
    await this.apply(this.selector.finish(t), frame)
  }

  /**
   * The frames kept so far, in time order and numbered 1..N, as recording.json
   * holds them. Numbers can shift while recording (a narration line's frame
   * lands before frames already kept), so the key is what names a frame's
   * JPEG until the take is done.
   */
  frames(): LiveFrame[] {
    const picks = this.selector.picks().filter((p) => this.stored.has(p.id))
    const indexOf = new Map(picks.map((p, i) => [p.id, i + 1]))
    return picks.map((p, i) => ({
      frame: toRecordingFrame(p, i + 1, indexOf, this.stored.get(p.id)),
      key: p.id,
    }))
  }

  private async apply(actions: SelectAction[], frame: SourceFrame | null): Promise<void> {
    for (const action of actions) {
      if (action.kind === 'hold') {
        if (frame) this.keeper.hold(action.slot, frame)
      } else if (action.kind === 'drop') {
        if (this.stored.delete(action.id)) await this.opts.discard?.(action.id)
      } else {
        // A refetch is the final frame, and a live take's final frame is the one in front of it.
        const from = action.kind === 'keep' && action.from !== 'current' ? action.from : frame
        if (!from) continue
        const { jpeg, pointer } = await this.keeper.encode(action.pick, from)
        await this.opts.store(action.pick.id, jpeg)
        this.stored.set(action.pick.id, pointer)
      }
    }
  }
}

/** The video's current picture as a candidate, cropped; null while it has none. */
function liveFrame(video: HTMLVideoElement, t: number, crop?: FrameBox): SourceFrame | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (video.readyState < 2 || !vw || !vh) return null
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const sx = Math.round(c.x * vw)
  const sy = Math.round(c.y * vh)
  const sw = Math.max(1, Math.round(c.w * vw))
  const sh = Math.max(1, Math.round(c.h * vh))
  return {
    t,
    width: sw,
    height: sh,
    draw: (ctx, dw, dh) => ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh),
    drawRegion: (ctx, rx, ry, rw, rh, dw, dh) =>
      ctx.drawImage(video, sx + rx, sy + ry, rw, rh, 0, 0, dw, dh),
  }
}
