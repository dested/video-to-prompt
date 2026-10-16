import { SAMPLE_RATE } from './audio.js'

/**
 * Lines a speech engine wrote over audio that holds no speech. Whisper fills
 * silence with stock phrases ("Thank you." across a 30 s window of digital
 * zero, the usual sound of a phone screen recording with the mic off), and any
 * engine can print text over a stretch where nothing was audible. Each line is
 * judged against the window of the clip's own audio it claims, and three kinds
 * are dropped:
 *
 * - nothing audible: no 50 ms frame of the window rises above −70 dBFS;
 * - a stock phrase ("Thank you.", "Okay.", "you") claiming 4 s or more, with
 *   under 15% of that window standing 10 dB above the clip's background. A
 *   real "Thank you." takes a second and stands out of the room;
 * - no letters or digits at all (".", "♪").
 *
 * Loudness alone never drops a line: a mumbled aside at −56 dBFS and a
 * colleague talking across the room both stay. A line with no reported length
 * (`d`), or whose window lies outside the audio, is kept unless it has no words.
 */

const FRAME_MS = 50
/** Below this, a 50 ms frame holds nothing a person could hear. */
const SILENT_DB = -70
/** How far above the clip's background a frame must rise to stand out of it. */
const RISE_DB = 10
/** A stock phrase this long has claimed a window, not a breath. */
const STOCK_MIN_MS = 4000
/** The share of that window that must stand out for the phrase to be speech. */
const STOCK_MIN_SHARE = 0.15

/** What Whisper says to silence and room noise. Matched against the whole line. */
const STOCK =
  /^(?:thank you(?: (?:so much|very much|for watching))?|thanks(?: for watching)?|you|bye(?:-bye)?|okay|ok|so|oh|yeah|um|uh|hmm|.*\bamara\.org\b.*|subtitles by .*|please subscribe)[.!?…]*$/i

/** The fields judged; anything else on a segment rides along untouched. */
export interface TimedLine {
  t: number
  d?: number
  text: string
}

/**
 * `segments` without the lines nobody said. `audio` is the mono PCM the
 * engine heard (segment times are ms into it), `sampleRate` its rate.
 */
export function dropUnheard<S extends TimedLine>(
  segments: S[],
  audio: Float32Array,
  sampleRate: number = SAMPLE_RATE
): S[] {
  const hop = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
  const frames = new Float32Array(Math.ceil(audio.length / hop))
  for (let f = 0; f < frames.length; f++) {
    const start = f * hop
    const end = Math.min(audio.length, start + hop)
    let sum = 0
    for (let i = start; i < end; i++) sum += (audio[i] ?? 0) ** 2
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    frames[f] = rms > 0 ? 20 * Math.log10(rms) : -Infinity
  }
  // The room: the level 90% of the clip sits above. Digital zero is no room,
  // so the floor never drops below the threshold of hearing.
  const sorted = Float32Array.from(frames).sort()
  const floor = Math.max(SILENT_DB, sorted[Math.floor(sorted.length * 0.1)] ?? SILENT_DB)
  return segments.filter((seg) => heard(seg, frames, floor))
}

function heard(seg: TimedLine, frames: Float32Array, floor: number): boolean {
  const text = seg.text.trim()
  if (!/[\p{L}\p{N}]/u.test(text)) return false
  if (seg.d === undefined) return true
  const from = Math.max(0, Math.floor(seg.t / FRAME_MS))
  const to = Math.min(frames.length, Math.max(from + 1, Math.ceil((seg.t + seg.d) / FRAME_MS)))
  if (to <= from) return true
  let audible = 0
  let standing = 0
  for (let f = from; f < to; f++) {
    const level = frames[f] ?? -Infinity
    if (level > SILENT_DB) audible++
    if (level > floor + RISE_DB) standing++
  }
  if (audible === 0) return false
  const claimsSilence = seg.d >= STOCK_MIN_MS && standing / (to - from) < STOCK_MIN_SHARE
  return !(claimsSilence && STOCK.test(text))
}
