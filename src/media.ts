/**
 * The bits of the DOM every stage of the pipeline needs: an offscreen video
 * element to read a picked file through, seeks that can't hang forever, and a
 * canvas→JPEG encoder. Nothing here touches the DOM at module scope, so the
 * whole library stays importable from an SSR render.
 */

/**
 * A seek that never lands means a container we can't step through. Give up
 * rather than wedge — but slowly: a phone decoder under memory pressure can take
 * well past ten seconds on a single seek, and a run that dies there loses the
 * clip for a reason that was only ever "the hardware is busy". The timer freezes
 * with the tab when the screen goes off and resumes with it, which is the
 * behaviour we want.
 */
export const SEEK_TIMEOUT_MS = 20000
/** Metadata for a file already on the device is instant; this is only a wedge guard. */
export const LOAD_TIMEOUT_MS = 30000
/**
 * The prime below is a nudge, not a stage. A muted play() normally settles in a
 * frame or two; when it doesn't, waiting on it is exactly the wedge the ready
 * path exists to avoid, so it is raced rather than awaited.
 */
const PRIME_TIMEOUT_MS = 3000
/**
 * A hidden tab never paints, so the frame wait below would never resolve. This
 * is the escape hatch, not the normal path — a visible page answers in ~16 ms.
 */
const PAINT_GRACE_MS = 150
/** currentTime is a float — a seek to where we already are fires no 'seeked'. */
const SEEK_EPSILON = 0.001

export const UNREADABLE = "that file can't be read as a recording in this browser"

/** Offscreen, muted, inline: the element is a decoder, never something anyone sees. */
export function hiddenVideo(src: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  video.style.cssText = 'position:fixed; left:-9999px; top:0; width:4px; height:4px; opacity:0;'
  document.body.appendChild(video)
  video.src = src
  // Setting src is a request to load on most engines and a suggestion on WebKit;
  // saying it outright costs nothing and is the difference between a decoder
  // that starts now and one that starts when it feels like it.
  video.load()
  return video
}

/**
 * Wait until the element can actually give us pixels. Three things beyond a
 * plain `loadeddata` wait, all of them iOS:
 *
 *  - `canplay` and `loadeddata` both mean "there is a frame"; WebKit does not
 *    always fire the one you asked for, so take whichever arrives first.
 *  - a blob-URL video that has never played will sit at `readyState` 1 forever
 *    and hand back blank canvas reads. A muted play/pause wakes the decoder.
 *  - the whole wait shares one `LOAD_TIMEOUT_MS` budget, so a file that stalls
 *    in two places still fails inside the timeout the caller was promised.
 */
export async function readyVideo(video: HTMLVideoElement, message: string): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  const remaining = () => Math.max(0, deadline - Date.now())

  if (video.readyState < 1) await waitFor(video, ['loadedmetadata'], remaining(), message)
  await prime(video)
  if (video.readyState < 2) await waitFor(video, ['canplay', 'loadeddata'], remaining(), message)
}

/** Play a frame and stop. Every failure here is survivable — the wait after it is the real test. */
async function prime(video: HTMLVideoElement): Promise<void> {
  try {
    await Promise.race([
      video.play(),
      new Promise<void>((resolve) => window.setTimeout(resolve, PRIME_TIMEOUT_MS)),
    ])
  } catch {
    // Autoplay refused, or the element was paused out from under the promise.
  }
  try {
    video.pause()
  } catch {
    // Same as releaseVideo: pausing an element that never started can throw.
  }
}

/** Drop the decoder as well as the node — a mobile browser has very few of them. */
export function releaseVideo(video: HTMLVideoElement): void {
  try {
    video.pause()
  } catch {
    // Pausing a never-started element throws on some engines; nothing depends on it.
  }
  video.removeAttribute('src')
  video.load()
  video.remove()
}

/** Resolve on the first of `events`, reject on 'error' or after `timeoutMs`. */
export function waitFor(
  el: HTMLVideoElement,
  events: string[],
  timeoutMs: number,
  message: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer)
      for (const name of events) el.removeEventListener(name, onDone)
      el.removeEventListener('error', onError)
    }
    const onDone = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(message))
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(message))
    }, timeoutMs)
    for (const name of events) el.addEventListener(name, onDone)
    el.addEventListener('error', onError)
  })
}

/**
 * Give the decoder one frame to put pixels where we're about to read them.
 * 'seeked' fires when the position moved, which is a beat before the picture is
 * there — and reading a canvas one frame early is how a sweep ends up with
 * duplicates of the previous keyframe.
 *
 * This used to wait on `requestVideoFrameCallback`, which is the *correct*
 * signal and the wrong trade: on a paused WebKit video it fires late or not at
 * all, so every candidate in a sweep paid the full grace period. One rAF is a
 * guess, but it is a 16 ms guess, and the sweep is hundreds of these.
 */
function presented(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, PAINT_GRACE_MS)
    window.requestAnimationFrame(() => finish())
  })
}

/** Seek and wait for the picture. Throws `message` if the seek doesn't land in time. */
export async function seekTo(
  video: HTMLVideoElement,
  timeSec: number,
  message: string
): Promise<void> {
  if (Math.abs(video.currentTime - timeSec) < SEEK_EPSILON && video.readyState >= 2) {
    await presented()
    return
  }
  const landed = waitFor(video, ['seeked'], SEEK_TIMEOUT_MS, message)
  video.currentTime = timeSec
  await landed
  await presented()
}

export function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('frame encode failed'))),
      'image/jpeg',
      quality
    )
  })
}
