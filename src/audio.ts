import { isCancelled, throwIfAborted } from './cancel.js'

/**
 * The clip's narration, decoded once for the transcriber: 16 kHz mono Float32.
 *
 * Two paths. The container is demuxed first (mediabunny) and only the audio
 * track's packets are read and decoded through WebCodecs, resampled in
 * half-minute chunks as they arrive: memory is the 16 kHz output and one chunk,
 * whatever the size of the video around it. The fallback is
 * `decodeAudioData` on the whole file in an OfflineAudioContext. It is simple
 * and universal, and it holds the entire file as one ArrayBuffer, which is what
 * kills a phone tab on a long screen recording.
 */

export const SAMPLE_RATE = 16000
/** Below this peak there is nothing to transcribe; sending it burns a request to hear silence. */
const SILENCE_FLOOR = 0.001
/** Source-rate audio buffered before each resample. */
const CHUNK_S = 30

export interface DecodeOptions {
  signal?: AbortSignal
}

/** Mixdown to mono at 16 kHz. Null when there's no decodable audio, or it's silent. */
export async function decodeMono(
  file: Blob,
  opts: DecodeOptions = {}
): Promise<Float32Array | null> {
  try {
    const fast = await decodeTrack(file, opts.signal)
    if (fast !== undefined) return fast
  } catch (error) {
    if (isCancelled(error, opts.signal)) throw error
  }
  throwIfAborted(opts.signal)
  return decodeWhole(file)
}

/** Undefined = this path can't say (no WebCodecs, unknown container, codec refused); fall back. */
async function decodeTrack(
  file: Blob,
  signal?: AbortSignal
): Promise<Float32Array | null | undefined> {
  if (typeof AudioDecoder === 'undefined') return undefined
  const mb = await import('mediabunny')
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      // A container the demuxer read in full with no audio in it: a clip recorded with the mic off.
      return (await input.getPrimaryVideoTrack()) ? null : undefined
    }
    if (!(await track.canDecode())) return undefined

    const seconds = await track.computeDuration()
    let out = new Float32Array(Math.ceil((seconds + 1) * SAMPLE_RATE))
    let written = 0
    let peak = 0
    let rate = 0
    let chunk = new Float32Array(0)
    let filled = 0
    let plane = new Float32Array(0)

    const flush = async () => {
      if (!filled) return
      const resampled = await resample(chunk.subarray(0, filled), rate)
      if (written + resampled.length > out.length) {
        const grown = new Float32Array(Math.ceil((written + resampled.length) * 1.25))
        grown.set(out.subarray(0, written))
        out = grown
      }
      out.set(resampled, written)
      written += resampled.length
      for (let i = 0; i < resampled.length; i++) {
        const v = Math.abs(resampled[i] ?? 0)
        if (v > peak) peak = v
      }
      filled = 0
    }

    for await (const sample of new mb.AudioSampleSink(track).samples()) {
      try {
        throwIfAborted(signal)
        if (sample.sampleRate !== rate) {
          await flush()
          rate = sample.sampleRate
          chunk = new Float32Array(rate * CHUNK_S)
        }
        // Encoder priming sits before zero (AAC's ~1024 frames); the edit list
        // says to drop it, and decodeAudioData does.
        const skip =
          sample.timestamp < 0
            ? Math.min(sample.numberOfFrames, Math.round(-sample.timestamp * sample.sampleRate))
            : 0
        const frames = sample.numberOfFrames - skip
        if (frames <= 0) continue
        if (filled + frames > chunk.length) await flush()
        if (frames > chunk.length) chunk = new Float32Array(frames)
        if (plane.length < frames) plane = new Float32Array(frames)
        const channels = sample.numberOfChannels
        const view = chunk.subarray(filled, filled + frames)
        for (let c = 0; c < channels; c++) {
          sample.copyTo(plane, {
            planeIndex: c,
            format: 'f32-planar',
            frameOffset: skip,
            frameCount: frames,
          })
          for (let i = 0; i < frames; i++) view[i] = (view[i] ?? 0) + (plane[i] ?? 0) / channels
        }
        filled += frames
      } finally {
        sample.close()
      }
    }
    await flush()
    return peak > SILENCE_FLOOR ? out.slice(0, written) : null
  } finally {
    input.dispose()
  }
}

/** The platform's own resampler, offline: one chunk at the source rate in, 16 kHz out. */
async function resample(mono: Float32Array<ArrayBuffer>, rate: number): Promise<Float32Array> {
  if (rate === SAMPLE_RATE) return mono.slice()
  const frames = Math.max(1, Math.round((mono.length * SAMPLE_RATE) / rate))
  const ctx = new OfflineAudioContext(1, frames, SAMPLE_RATE)
  const buffer = ctx.createBuffer(1, mono.length, rate)
  buffer.copyToChannel(mono, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  return (await ctx.startRendering()).getChannelData(0)
}

/**
 * The whole file through `decodeAudioData`. Handed a video container it
 * extracts the audio track, so a screen recording and a voice memo take the
 * same path.
 */
async function decodeWhole(file: Blob): Promise<Float32Array | null> {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  try {
    // A clip recorded with the mic off has no audio track at all, and decoding throws.
    const buf = await ctx.decodeAudioData(await file.arrayBuffer())
    const mono = new Float32Array(buf.length)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const channel = buf.getChannelData(c)
      for (let i = 0; i < channel.length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0)
    }
    if (buf.numberOfChannels > 1) {
      for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) / buf.numberOfChannels
    }
    for (let i = 0; i < mono.length; i++) {
      if (Math.abs(mono[i] ?? 0) > SILENCE_FLOOR) return mono
    }
    return null
  } catch {
    return null
  }
}

/**
 * Float32 mono → a 16-bit PCM WAV blob at SAMPLE_RATE — the one container every
 * speech API accepts without a codec. Hand-rolled because the platform has no
 * encoder and the format's 44-byte header is shorter than any dependency.
 */
export function encodeWav(samples: Float32Array): Blob {
  const bytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header length
  view.setUint16(20, 1, true) // format: uncompressed PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, bytes, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: decoded audio can overshoot ±1 and wrap into noise.
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
