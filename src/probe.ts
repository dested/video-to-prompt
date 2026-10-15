import { throwIfAborted } from './cancel.js'
import {
  hiddenVideo,
  LOAD_TIMEOUT_MS,
  releaseVideo,
  seekTo,
  toJpeg,
  UNREADABLE,
  waitFor,
} from './media.js'

/**
 * What a picked file actually is, before the pipeline commits to anything: how
 * long it runs, whether it carries a picture, and one still to show the human
 * they picked the right clip.
 *
 * The container is read directly first (mediabunny, imported on first use):
 * tracks, sizes and duration come out of the file's own headers in
 * milliseconds, where readying a `<video>` costs seconds on a desktop, the
 * better part of a minute on an iPhone, and the whole LOAD_TIMEOUT when a
 * headless or background tab never decodes a frame. The element path stays as
 * the fallback for anything the demuxer doesn't know. There, audio-only files
 * go through the same element: a `<video>` plays an m4a perfectly well and
 * reports 0×0 for it, which is the test for "this is a voice memo".
 */

/** Wide enough to look like something on a phone, small enough to decode instantly. */
const POSTER_W = 320
const POSTER_QUALITY = 0.8
/** The duration hack seeks past the end; the browser answers within a frame or two. */
const DURATION_PROBE_MS = 3000

export interface ClipProbe {
  durationMs: number
  width: number
  height: number
  hasVideo: boolean
  /** An objectURL the caller owns and must revoke. Null for audio-only clips. */
  posterUrl: string | null
}

export interface ProbeOptions {
  /** Make the poster still. Default true; a pipeline that never shows one should say false. */
  poster?: boolean
  signal?: AbortSignal
}

export async function probeClip(file: File, opts: ProbeOptions = {}): Promise<ClipProbe> {
  const fast = await probeContainer(file, opts.poster ?? true).catch(() => null)
  throwIfAborted(opts.signal)
  return fast ?? probeElement(file, opts.poster ?? true)
}

/** Headers, not decoding. Null hands over to the element path. */
async function probeContainer(file: File, wantPoster: boolean): Promise<ClipProbe | null> {
  const mb = await import('mediabunny')
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    if (!video && !audio) return null
    const seconds = await input.computeDuration()
    const durationMs = Math.max(0, Math.round(seconds * 1000))
    if (!video) return { durationMs, width: 0, height: 0, hasVideo: false, posterUrl: null }

    let posterUrl: string | null = null
    if (wantPoster) {
      // No WebCodecs decoder for this track means the element has to make the
      // still, and readying it is the cost this path exists to avoid. Let it.
      if (typeof VideoDecoder === 'undefined' || !(await video.canDecode())) return null
      const origin = await video.getFirstTimestamp()
      const sample = await new mb.VideoSampleSink(video).getSample(
        origin + Math.min(1000, durationMs / 2) / 1000
      )
      if (sample) {
        try {
          const width = Math.min(POSTER_W, sample.displayWidth)
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = Math.round((sample.displayHeight * width) / sample.displayWidth)
          const ctx = canvas.getContext('2d')
          if (ctx) {
            sample.draw(ctx, 0, 0, canvas.width, canvas.height)
            posterUrl = URL.createObjectURL(await toJpeg(canvas, POSTER_QUALITY))
          }
        } finally {
          sample.close()
        }
      }
    }
    return {
      durationMs,
      width: video.displayWidth,
      height: video.displayHeight,
      hasVideo: true,
      posterUrl,
    }
  } finally {
    input.dispose()
  }
}

async function probeElement(file: File, wantPoster: boolean): Promise<ClipProbe> {
  const url = URL.createObjectURL(file)
  const video = hiddenVideo(url)
  try {
    await waitFor(video, ['loadedmetadata'], LOAD_TIMEOUT_MS, UNREADABLE)
    const durationMs = Number.isFinite(video.duration)
      ? Math.max(0, Math.round(video.duration * 1000))
      : await resolveDuration(video)
    // videoWidth is only trustworthy once a frame has been decoded — a
    // metadata-only load can still report 0×0 for a real video.
    if (video.readyState < 2) {
      await waitFor(video, ['loadeddata'], LOAD_TIMEOUT_MS, UNREADABLE).catch(() => {})
    }
    const hasVideo = video.videoWidth > 0
    const posterUrl =
      hasVideo && wantPoster ? await poster(video, durationMs).catch(() => null) : null
    return {
      durationMs,
      width: video.videoWidth,
      height: video.videoHeight,
      hasVideo,
      posterUrl,
    }
  } finally {
    releaseVideo(video)
    URL.revokeObjectURL(url)
  }
}

/**
 * MediaRecorder webm ships with no duration in the container, so the element
 * reports Infinity. Seeking past the end forces the browser to walk the file
 * and work it out; after that, `duration` (or the seekable range) is real.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('timeupdate', finish)
      video.removeEventListener('seeked', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, DURATION_PROBE_MS)
    video.addEventListener('timeupdate', finish)
    video.addEventListener('seeked', finish)
    video.currentTime = 1e9
  })
  const seconds = Number.isFinite(video.duration)
    ? video.duration
    : video.seekable.length
      ? video.seekable.end(0)
      : 0
  video.currentTime = 0
  return Math.max(0, Math.round(seconds * 1000))
}

/** A frame from near the top of the clip — far enough in to be past a black lead-in. */
async function poster(video: HTMLVideoElement, durationMs: number): Promise<string | null> {
  const width = Math.min(POSTER_W, video.videoWidth)
  if (!width) return null
  await seekTo(video, Math.min(1000, durationMs / 2) / 1000, UNREADABLE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round((video.videoHeight * width) / video.videoWidth)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return URL.createObjectURL(await toJpeg(canvas, POSTER_QUALITY))
}
