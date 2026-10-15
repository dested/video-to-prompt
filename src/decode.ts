import { CancelledError, isCancelled, throwIfAborted } from './cancel.js'
import { hiddenVideo, readyVideo, releaseVideo, seekTo, UNREADABLE } from './media.js'
import type { VideoSample } from 'mediabunny'

/**
 * Pixels out of a recorded file, at the times the extractor asks for. Two
 * engines behind one shape:
 *
 *  - **webcodecs**: mediabunny demuxes the container and the platform's
 *    VideoDecoder decodes it front to back. Every packet is decoded once, so a
 *    candidate costs a canvas draw rather than a seek, and dense sampling is
 *    affordable. mediabunny is imported on first use, so an SSR import of this
 *    library never loads it.
 *  - **seek**: an offscreen `<video>` stepped one seek per candidate. Each seek
 *    decodes from the previous keyframe; it is the engine every browser has,
 *    and the fallback whenever WebCodecs is missing, refuses the codec, or
 *    fails partway (the remaining times continue on it).
 */

export type FrameEngine = 'webcodecs' | 'seek'

export interface SourceFrame {
  /** The requested time, ms from clip start. */
  t: number
  /** Display size of the frame. */
  width: number
  height: number
  /** Draw the frame scaled into (0, 0, dw, dh). Valid only until the iterator advances. */
  draw(ctx: CanvasRenderingContext2D, dw: number, dh: number): void
}

export interface FrameSource {
  readonly engine: FrameEngine
  /** The frame shown at each of `times` (ascending ms), skipping any the decoder could not produce. */
  frames(times: number[], signal?: AbortSignal): AsyncGenerator<SourceFrame, void, undefined>
  close(): void
}

/**
 * A single seek that doesn't land is a decoder hiccup: skip the candidate and
 * keep the frames we can get. Three in a row is a decoder that will not step
 * this file at all, and at SEEK_TIMEOUT_MS apiece the remaining candidates are
 * hours of waiting for nothing. Three *from the start* is the iOS case.
 */
const MAX_SEEK_FAILURES = 3
const FRAMES_UNREADABLE = "couldn't read frames from that video"
/** A frame stamped a hair after a requested time still counts as on screen at it (float timestamps). */
const PTS_SLOP_MS = 0.5

export interface OpenOptions {
  /** 'auto' (default) tries WebCodecs and falls back to seeking. */
  engine?: FrameEngine | 'auto'
  signal?: AbortSignal
}

export async function openFrameSource(file: Blob, opts: OpenOptions = {}): Promise<FrameSource> {
  const want = opts.engine ?? 'auto'
  if (want !== 'seek') {
    const fast = await openWebCodecs(file).catch(() => null)
    throwIfAborted(opts.signal)
    if (fast)
      return want === 'webcodecs' ? fast : withFallback(fast, () => openSeek(file, opts.signal))
    if (want === 'webcodecs') throw new Error(FRAMES_UNREADABLE)
  }
  return openSeek(file, opts.signal)
}

async function openWebCodecs(file: Blob): Promise<FrameSource | null> {
  if (typeof VideoDecoder === 'undefined') return null
  const mb = await import('mediabunny')
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose()
      return null
    }
    // A <video> element calls the first frame 0; so does every time we're handed.
    const origin = await track.getFirstTimestamp()
    const sink = new mb.VideoSampleSink(track)
    return {
      engine: 'webcodecs',
      async *frames(times, signal) {
        // Front to back, every packet decoded once, and each requested time gets
        // the frame on screen at that moment: the latest one presented at or
        // before it. (samplesAtTimestamps would skip work on long steps, but on a
        // MediaRecorder webm, which carries no Cues index, it finds almost
        // nothing.)
        let i = 0
        let shown: VideoSample | null = null
        const frame = (sample: VideoSample, t: number): SourceFrame => ({
          t,
          width: sample.displayWidth,
          height: sample.displayHeight,
          draw: (ctx, dw, dh) => sample.draw(ctx, 0, 0, dw, dh),
        })
        // Start a second early: the first time wants the frame already on screen.
        const from = times.length ? Math.max(origin, origin + (times[0] ?? 0) / 1000 - 1) : origin
        const samples = sink.samples(from)
        try {
          for await (const sample of samples) {
            throwIfAborted(signal)
            const at = (sample.timestamp - origin) * 1000
            for (
              let next = times[i];
              next !== undefined && next < at - PTS_SLOP_MS;
              next = times[++i]
            ) {
              if (shown) yield frame(shown, next)
            }
            shown?.close()
            shown = sample
            if (i >= times.length) break
          }
          // The last frame stays on screen to the end of the clip.
          for (let next = times[i]; shown && next !== undefined; next = times[++i])
            yield frame(shown, next)
        } finally {
          shown?.close()
          await samples.return(undefined)
        }
      },
      close: () => input.dispose(),
    }
  } catch {
    input.dispose()
    return null
  }
}

async function openSeek(file: Blob, signal?: AbortSignal): Promise<FrameSource> {
  const url = URL.createObjectURL(file)
  const video = hiddenVideo(url)
  const close = () => {
    releaseVideo(video)
    URL.revokeObjectURL(url)
  }
  try {
    await readyVideo(video, UNREADABLE, signal)
  } catch (error) {
    close()
    throw error
  }
  return {
    engine: 'seek',
    async *frames(times, frameSignal) {
      let missed = 0
      for (const t of times) {
        throwIfAborted(frameSignal)
        try {
          await seekTo(video, t / 1000, FRAMES_UNREADABLE, frameSignal)
          missed = 0
        } catch (error) {
          if (isCancelled(error, frameSignal)) throw new CancelledError()
          if (++missed >= MAX_SEEK_FAILURES) throw error
          continue
        }
        if (!video.videoWidth || !video.videoHeight) continue
        yield {
          t,
          width: video.videoWidth,
          height: video.videoHeight,
          draw: (ctx, dw, dh) => ctx.drawImage(video, 0, 0, dw, dh),
        }
      }
    },
    close,
  }
}

/** WebCodecs first; if it throws partway, the times it didn't reach continue on a seek source. */
function withFallback(primary: FrameSource, openBackup: () => Promise<FrameSource>): FrameSource {
  let backup: FrameSource | null = null
  return {
    get engine() {
      return backup?.engine ?? primary.engine
    },
    async *frames(times, signal) {
      let last = -Infinity
      try {
        for await (const frame of primary.frames(times, signal)) {
          last = frame.t
          yield frame
        }
        return
      } catch (error) {
        if (isCancelled(error, signal)) throw error
      }
      primary.close()
      backup = await openBackup()
      yield* backup.frames(
        times.filter((t) => t > last),
        signal
      )
    },
    close() {
      primary.close()
      backup?.close()
    },
  }
}
