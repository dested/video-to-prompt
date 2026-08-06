/**
 * The clip's narration, decoded once for the transcriber. OfflineAudioContext
 * rather than a live one, because this runs with nothing to play and an offline
 * context resamples inside `decodeAudioData` without claiming an output device
 * or tripping an autoplay policy.
 *
 * Handed a video container, `decodeAudioData` extracts the audio track — that
 * is the point. A screen recording and a voice memo take the same path.
 */

export const SAMPLE_RATE = 16000
/** Below this peak there is nothing to transcribe; sending it burns a request to hear silence. */
const SILENCE_FLOOR = 0.001

/** Mixdown to mono at 16 kHz. Null when there's no decodable audio, or it's silent. */
export async function decodeMono(file: Blob): Promise<Float32Array | null> {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  try {
    // A clip recorded with the mic off has no audio track at all, and decoding throws.
    const buf = await ctx.decodeAudioData(await file.arrayBuffer())
    const mono = new Float32Array(buf.length)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const channel = buf.getChannelData(c)
      for (let i = 0; i < channel.length; i++) mono[i] += channel[i]
    }
    if (buf.numberOfChannels > 1) {
      for (let i = 0; i < mono.length; i++) mono[i] /= buf.numberOfChannels
    }
    for (let i = 0; i < mono.length; i++) {
      if (Math.abs(mono[i]) > SILENCE_FLOOR) return mono
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
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
