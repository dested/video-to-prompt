import { describe, expect, test } from 'bun:test'
import { dropUnheard, type TimedLine } from '../../src/unheard.ts'

const SR = 16000

/** `seconds` of audio: digital zero, or noise at `db` dBFS RMS. Deterministic. */
function clip(seconds: number, db?: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  if (db === undefined) return out
  // Uniform noise in [-a, a] has RMS a/√3.
  const a = Math.sqrt(3) * 10 ** (db / 20)
  let seed = 7
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    out[i] = (seed / 2147483648) * 2 * a - a
  }
  return out
}

/** `base` with [from, to) seconds overwritten by noise at `db`. */
function burst(base: Float32Array, from: number, to: number, db: number): Float32Array {
  const out = Float32Array.from(base)
  out.set(clip(to - from, db), Math.round(from * SR))
  return out
}

const kept = (lines: TimedLine[], audio: Float32Array) =>
  dropUnheard(lines, audio).map((l) => l.text)

describe('dropUnheard', () => {
  test('"Thank you." over thirty seconds of digital zero is dropped', () => {
    expect(kept([{ t: 0, d: 30000, text: 'Thank you.' }], clip(60))).toEqual([])
  })

  test('any text over a window with nothing audible is dropped', () => {
    const audio = burst(clip(20), 0, 2, -30)
    const lines = [
      { t: 500, d: 1000, text: 'Open settings.' },
      { t: 8000, d: 3000, text: 'Subtítulos realizados por la comunidad.' },
    ]
    expect(kept(lines, audio)).toEqual(['Open settings.'])
  })

  test('a stock phrase claiming a long window over one app click is dropped', () => {
    const audio = burst(clip(40), 12, 12.3, -10)
    expect(kept([{ t: 0, d: 30000, text: 'Thank you.' }], audio)).toEqual([])
  })

  test('a stock phrase over steady room noise with nothing standing out is dropped', () => {
    const audio = clip(60, -45)
    expect(kept([{ t: 10000, d: 30000, text: 'Thank you.' }], audio)).toEqual([])
  })

  test('a real "Thank you." that stands out of the room is kept', () => {
    const audio = burst(clip(30, -50), 10, 11, -25)
    expect(kept([{ t: 10000, d: 1000, text: 'Thank you.' }], audio)).toEqual(['Thank you.'])
  })

  test('a short stock reply is kept even when it barely clears the room', () => {
    const audio = burst(clip(30, -60), 5, 5.3, -55)
    expect(kept([{ t: 5000, d: 300, text: 'Okay.' }], audio)).toEqual(['Okay.'])
  })

  test('a long "Okay" window with real talk in it is kept', () => {
    const audio = burst(burst(clip(30, -55), 3, 4.5, -28), 6, 7.5, -28)
    expect(kept([{ t: 2000, d: 9000, text: 'Okay.' }], audio)).toEqual(['Okay.'])
  })

  test('quiet speech is never dropped for being quiet', () => {
    const audio = burst(clip(30, -60), 10, 11.2, -56)
    const lines = [{ t: 10000, d: 1200, text: 'looks like it' }]
    expect(kept(lines, audio)).toEqual(['looks like it'])
  })

  test('a colleague across the room, never above the background, is kept', () => {
    const audio = clip(30, -45)
    const lines = [{ t: 5000, d: 2000, text: 'Sandwiches are coming in.' }]
    expect(kept(lines, audio)).toEqual(['Sandwiches are coming in.'])
  })

  test('lines with no words are dropped wherever they sit', () => {
    const audio = clip(10, -30)
    const lines = [
      { t: 0, d: 2000, text: '.' },
      { t: 2000, d: 2000, text: ' ♪ ' },
      { t: 4000, text: '…' },
    ]
    expect(kept(lines, audio)).toEqual([])
  })

  test('a line without a length, or outside the audio, is kept', () => {
    const audio = clip(10)
    const lines = [
      { t: 2000, text: 'Thank you.' },
      { t: 20000, d: 1000, text: 'Later.' },
    ]
    expect(kept(lines, audio)).toEqual(['Thank you.', 'Later.'])
  })

  test('other fields ride along untouched', () => {
    const audio = burst(clip(10), 1, 2, -30)
    const out = dropUnheard([{ t: 1000, d: 1000, text: 'Hi.', speaker: 2 }], audio)
    expect(out).toEqual([{ t: 1000, d: 1000, text: 'Hi.', speaker: 2 }])
  })
})
