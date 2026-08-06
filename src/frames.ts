import { pad2, mmssFile } from './format'
import { hiddenVideo, readyVideo, releaseVideo, seekTo, toJpeg, UNREADABLE } from './media'
import type { RecordingFrame } from './types'

/**
 * Keyframe extraction by seek-stepping an already-recorded file: sample a
 * candidate every step, keep the ones that changed, thin to a length-scaled
 * budget. The keep/drop rule matches a live recorder sampling a screen share at
 * 500 ms — a walkthrough distilled after the fact has to look like one
 * distilled live. The **cadence** does not match: see STEP_FLOOR_MS.
 *
 * No forced keyframes here: an already-recorded clip has no clicks, no
 * navigations and no page events to force one, so the only reasons are
 * 'start', 'change' and 'beat'.
 */

/**
 * Candidate cadence. A live recorder's 500 ms is free — it reads a frame that a
 * screen share was going to paint anyway. A seek-step pays a full decode per
 * candidate, and on iOS that is the whole cost of the run: at 500 ms a
 * thirty-second clip asks the phone for sixty decodes to keep frames the budget
 * below caps at forty a minute. One second still oversamples the budget by 50%
 * and halves the work.
 */
const STEP_FLOOR_MS = 1000
const SIG_SIZE = 64 // 64×64 RGB cells — fine enough that a sprite-sized change still flips whole cells
const PIX_TOL = 25 // a cell counts as changed if any channel moves more than this
const DEDUP_THRESHOLD = 8 // cells that must change for a frame to be new (~0.2% of 4096)
const DEDUP_WINDOW = 4 // vs the last N KEPT frames — A-B-A cutaways don't come back
const BEAT_MS = 15000 // a minute of narration over a slowly-shifting screen must not produce zero frames
const FRAMES_PER_MIN = 40
const MIN_FRAME_BUDGET = 150
const MAX_FRAME_BUDGET = 600
const MAX_FRAME_W = 1920
const JPEG_QUALITY = 0.9
/**
 * Past half an hour even a one-second step is thousands of decodes. Cap the
 * candidate count and let the step stretch past the floor — the budget below
 * thins the result to the same shape either way.
 */
const MAX_CANDIDATES = 1800
/**
 * A single seek that doesn't land is a decoder hiccup — skip the candidate and
 * keep the frames we can get. Three in a row is a decoder that will not step
 * this file at all, and at SEEK_TIMEOUT_MS apiece the remaining candidates are
 * hours of waiting for nothing. Give up and let the caller ship the take
 * frameless. Three *from the start* is the iOS case this exists for.
 */
const MAX_SEEK_FAILURES = 3

/** How many keyframes a take of this length may keep after dedup. Uniform thinning
 *  past this point, so survivors stay spread across the whole recording. */
export function frameBudget(durationMs: number): number {
  const byLength = Math.round((durationMs / 60000) * FRAMES_PER_MIN)
  return Math.min(MAX_FRAME_BUDGET, Math.max(MIN_FRAME_BUDGET, byLength))
}

/** Count of cells whose max channel delta exceeds PIX_TOL. */
function cellDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const cells = SIG_SIZE * SIG_SIZE
  let changed = 0
  for (let i = 0; i < cells; i++) {
    const p = i * 4
    const d = Math.max(
      Math.abs(a[p] - b[p]),
      Math.abs(a[p + 1] - b[p + 1]),
      Math.abs(a[p + 2] - b[p + 2])
    )
    if (d > PIX_TOL) changed++
  }
  return changed
}

export interface ExtractOptions {
  /** 0..1 through this clip. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface ExtractedFrames {
  /** Post-thin, renumbered 1..N. */
  frames: RecordingFrame[]
  /** JPEG per surviving frame, keyed by its final index. Held in memory — a clip is one-shot. */
  blobs: Map<number, Blob>
  /** Candidates examined. The MANIFEST reports it. */
  sampled: number
}

export async function extractFrames(
  file: Blob,
  durationMs: number,
  opts: ExtractOptions = {}
): Promise<ExtractedFrames> {
  const frames: RecordingFrame[] = []
  const blobs = new Map<number, Blob>()
  let sampled = 0
  if (durationMs <= 0) return { frames, blobs, sampled }

  const url = URL.createObjectURL(file)
  const video = hiddenVideo(url)
  try {
    await readyVideo(video, UNREADABLE)

    const sigCanvas = document.createElement('canvas')
    sigCanvas.width = SIG_SIZE
    sigCanvas.height = SIG_SIZE
    const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true })
    const frameCtx = document.createElement('canvas').getContext('2d')
    if (!sigCtx || !frameCtx) throw new Error("couldn't read frames from that video")
    frameCtx.imageSmoothingQuality = 'high'

    /** Signatures of the KEPT frames only — that ring *is* the dedup window. */
    const sigs: Uint8ClampedArray[] = []
    let lastKeptT = 0
    const stepMs = Math.max(STEP_FLOOR_MS, Math.ceil(durationMs / MAX_CANDIDATES))
    let missedSeeks = 0

    for (let t = 0; t < durationMs; t += stepMs) {
      if (opts.signal?.aborted) throw new Error('cancelled')
      try {
        await seekTo(video, t / 1000, "couldn't read frames from that video")
        missedSeeks = 0
      } catch (error) {
        if (opts.signal?.aborted) throw new Error('cancelled')
        if (++missedSeeks >= MAX_SEEK_FAILURES) throw error
        continue
      }
      opts.onProgress?.(t / durationMs)
      if (!video.videoWidth || !video.videoHeight) continue

      sampled++
      sigCtx.drawImage(video, 0, 0, SIG_SIZE, SIG_SIZE)
      const sig = sigCtx.getImageData(0, 0, SIG_SIZE, SIG_SIZE).data

      const minDist = sigs.length ? Math.min(...sigs.map((k) => cellDiff(sig, k))) : undefined
      let reason: RecordingFrame['reason']
      if (minDist === undefined) {
        reason = 'start'
      } else if (minDist <= DEDUP_THRESHOLD) {
        // Below the bar, but the screen *is* moving and nothing has been kept in
        // a while — a drifting low-contrast UI would otherwise go dark for minutes.
        if (!(minDist > 0 && t - lastKeptT > BEAT_MS)) continue
        reason = 'beat'
      } else {
        reason = 'change'
      }
      const dist = minDist // changed-cell count vs the closest kept frame

      const width = Math.min(video.videoWidth, MAX_FRAME_W)
      const height = Math.round((video.videoHeight * width) / video.videoWidth)
      const canvas = frameCtx.canvas
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        frameCtx.imageSmoothingQuality = 'high'
      }
      frameCtx.drawImage(video, 0, 0, width, height)

      const index = frames.length + 1
      blobs.set(index, await toJpeg(canvas, JPEG_QUALITY))
      frames.push({
        index,
        t,
        file: `frames/${pad2(index)}-${mmssFile(t)}.jpg`,
        reason,
        ...(dist === undefined ? {} : { dist }),
      })
      lastKeptT = t
      sigs.push(sig)
      if (sigs.length > DEDUP_WINDOW) sigs.shift()
    }
    opts.onProgress?.(1)
  } finally {
    releaseVideo(video)
    URL.revokeObjectURL(url)
  }

  return thin(frames, blobs, sampled, durationMs)
}

/**
 * A uniform thin: survivors stay spread across the whole clip, so nothing is
 * protected from it and nothing gets a run of neighbours it doesn't earn.
 * Survivors renumber ascending; `t` is untouched, so transcript citations stay
 * valid.
 */
function thin(
  frames: RecordingFrame[],
  blobs: Map<number, Blob>,
  sampled: number,
  durationMs: number
): ExtractedFrames {
  const allowed = frameBudget(durationMs)
  if (frames.length <= allowed) return { frames, blobs, sampled }

  const keepIdx = new Set<number>()
  const step = frames.length / allowed
  for (let i = 0; i < allowed; i++) keepIdx.add(Math.floor(i * step))
  const survivors = frames.filter((_, i) => keepIdx.has(i))

  const kept = new Map<number, Blob>()
  survivors.forEach((frame, n) => {
    const blob = blobs.get(frame.index)
    frame.index = n + 1
    frame.file = `frames/${pad2(frame.index)}-${mmssFile(frame.t)}.jpg`
    if (blob) kept.set(frame.index, blob)
  })
  return { frames: survivors, blobs: kept, sampled }
}
