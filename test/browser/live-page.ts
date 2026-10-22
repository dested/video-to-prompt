/**
 * The page side of test/browser/live.ts: plays a recorded clip into LiveFrames
 * the way a recorder would hand it a screen share, a candidate every
 * LIVE_STEP_MS, with speech opened and closed from the clip's narration, and
 * PUTs back what a live take would hold: its frames and a recording.json.
 */

import { LIVE_STEP_MS, LiveFrames, type FrameBox } from '../../src/index.ts'

export interface LiveRequest {
  url: string
  durationMs: number
  crop?: FrameBox
  /** Speech, ms from the clip's start. */
  lines: { t: number; d: number; text: string }[]
  outPrefix: string
}

export interface LiveResult {
  ms: number
  sampled: number
  frameCount: number
}

declare global {
  interface Window {
    v2pLive: { run(req: LiveRequest): Promise<LiveResult> }
  }
}

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(type, () => resolve(), { once: true }))
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  const done = once(video, 'seeked')
  video.currentTime = t / 1000
  await done
}

async function put(path: string, body: Blob): Promise<void> {
  const res = await fetch(path, { method: 'PUT', body })
  if (!res.ok) throw new Error(`upload ${path}: ${res.status}`)
}

window.v2pLive = {
  async run(req) {
    const started = performance.now()
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    const loaded = once(video, 'loadeddata')
    video.src = req.url
    await loaded

    const jpegs = new Map<number, Blob>()
    const live = new LiveFrames({
      store: async (key, jpeg) => {
        jpegs.set(key, jpeg)
      },
      discard: async (key) => {
        jpegs.delete(key)
      },
      crop: req.crop,
    })

    let line = 0
    let open = false
    for (let t = 0; t < req.durationMs; t += LIVE_STEP_MS) {
      await seek(video, t)
      while (line < req.lines.length) {
        const l = req.lines[line]
        if (!l) break
        if (!open && t >= l.t) {
          live.openLine(t)
          open = true
        }
        if (open && t >= l.t + l.d) {
          live.closeLine(t)
          open = false
          line++
          continue
        }
        break
      }
      await live.push(t, video)
    }
    await seek(video, Math.max(0, req.durationMs - 100))
    await live.finish(req.durationMs, video)

    const frames = live.frames()
    for (const { frame, key } of frames) {
      const jpeg = jpegs.get(key)
      if (jpeg) await put(`/out/${req.outPrefix}/${frame.file}`, jpeg)
    }
    const recording = {
      recording: {
        durationMs: req.durationMs,
        sampled: live.sampled,
        sampling: live.sampling,
        frames: frames.map(({ frame: f }) => ({
          index: f.index,
          tMs: f.t,
          file: f.file,
          reason: f.reason,
          dist: f.dist,
          change: f.change,
          held: f.held,
          transient: f.transient,
          ...(f.detail ? { detail: f.detail } : {}),
          ...(f.seen?.length ? { seenMs: f.seen } : {}),
        })),
        transcript: req.lines.map((l) => ({ tMs: l.t, endMs: l.t + l.d, text: l.text })),
      },
    }
    await put(
      `/out/${req.outPrefix}/recording.json`,
      new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' })
    )
    return { ms: Math.round(performance.now() - started), sampled: live.sampled, frameCount: frames.length }
  },
}
