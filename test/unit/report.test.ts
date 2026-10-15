import { describe, expect, test } from 'bun:test'
import {
  buildManifestTxt,
  buildRecordingJson,
  buildReport,
  buildTranscriptTxt,
  rankFrames,
  whereOnScreen,
} from '../../src/report.ts'
import type { Recording, RecordingFrame, Session, TranscriptSegment } from '../../src/types.ts'

// Local-time stamps in the report must not depend on the machine running the tests.
process.env.TZ = 'UTC'

const T0 = Date.UTC(2026, 9, 15, 14, 2, 0)

const session: Session = {
  id: 's1',
  name: 'Checkout total',
  slug: 'checkout-total',
  createdAt: T0,
  updatedAt: T0 + 60000,
  origin: 'http://localhost:4810',
  recCount: 1,
}

function frame(index: number, t: number, rest: Omit<RecordingFrame, 'index' | 't' | 'file'>): RecordingFrame {
  const file = `frames/${String(index).padStart(2, '0')}-${String(Math.round(t / 100)).padStart(4, '0')}.jpg`
  return { index, t, file, ...rest }
}

/** The fixture app's run, as the v2 extractor reports it. */
const frames: RecordingFrame[] = [
  frame(1, 0, { reason: 'start', held: 3000 }),
  frame(2, 3000, { reason: 'change', dist: 838, held: 2250 }),
  frame(3, 5250, { reason: 'change', dist: 46, held: 500, transient: true, change: { x: 0.913, y: 0.933, w: 0.075, h: 0.044 } }),
  frame(4, 9000, { reason: 'change', dist: 34, held: 7000, change: { x: 0.794, y: 0.144, w: 0.181, h: 0.044 } }),
  frame(5, 16000, { reason: 'change', dist: 106, held: 3000, change: { x: 0.794, y: 0.189, w: 0.113, h: 0.144 } }),
  frame(6, 19000, { reason: 'change', dist: 12283, held: 3000 }),
  frame(7, 22000, { reason: 'change', dist: 34, held: 1250, change: { x: 0.4, y: 0.5, w: 0.05, h: 0.03 } }),
  frame(8, 24000, { reason: 'change', dist: 387, held: 3250, change: { x: 0.15, y: 0.089, w: 0.538, h: 0.844 } }),
  frame(9, 27250, { reason: 'change', dist: 36, held: 750, transient: true, change: { x: 0.863, y: 0.3, w: 0.075, h: 0.033 } }),
  frame(10, 29500, { reason: 'end', dist: 1225, held: 1500 }),
]

const transcript: TranscriptSegment[] = [
  { t: 600, d: 2100, text: 'This is the checkout page for a single order.' },
  { t: 4800, d: 1500, text: 'Saving shows a toast that disappears fast.' },
  { t: 8200, d: 2600, text: 'Look at the total, it says 1,240 but the line items add up to 1,180.' },
  { t: 15600, d: 2400, text: 'The coupon field still throws a validation error even with a valid code.' },
  { t: 19400, d: 2000, text: 'The shipping modal opens fine.' },
  { t: 26800, d: 1800, text: 'Hovering the info icon shows a tooltip.' },
  { t: 29000, d: 1700, text: "And that's where it ends up." },
]

function take(over: Partial<Recording['meta']> = {}, index = 1): Recording {
  return {
    id: `r${index}`,
    sessionId: 's1',
    index,
    createdAt: T0,
    state: 'done',
    mime: 'video/webm',
    chunks: 1,
    meta: {
      startedAt: T0,
      durationMs: 31000,
      sampled: 125,
      frames,
      transcript,
      transcriber: 'groq',
      transcriberLabel: 'Whisper large-v3 (Groq)',
      sampling: { engine: 'webcodecs', stepMs: 250 },
      events: [{ level: 'error', message: 'TypeError: cannot read properties of undefined (reading "code")', ts: T0 + 16100 }],
      videoFile: 'video.webm',
      ...over,
    },
  }
}

describe('report', () => {
  test('a narrated take', () => {
    expect(buildReport(session, [take()], { url: 'https://handback.example/w/s1', source: 'handback' })).toMatchSnapshot()
  })

  test('two sittings, two voices, live dictation', () => {
    const voices = transcript.map((s, i) => ({ ...s, speaker: i % 3 === 1 ? 2 : 1 }))
    const later = T0 + 3600000
    const second = {
      ...take({ startedAt: later, transcript: voices.slice(0, 3), transcriber: undefined, transcriberLabel: undefined, events: [] }, 2),
      createdAt: later,
    }
    const first = take({ transcript: voices })
    expect(buildReport({ ...session, recCount: 2 }, [first, second])).toMatchSnapshot()
  })

  test("a tool's action log", () => {
    const report = buildReport(session, [take({ transcriber: undefined, transcriberLabel: undefined })], {
      narration: 'log',
      narrationBy: 'bx',
      intro: 'bx drove this browser session.',
      videoPath: () => 'video.webm',
    })
    expect(report).toMatchSnapshot()
    expect(report).not.toContain('spoken')
  })

  test('a silent take', () => {
    expect(buildReport(session, [take({ transcript: [], transcriber: undefined, transcriberLabel: undefined })])).toMatchSnapshot()
  })

  test('the title is the session name, once', () => {
    const report = buildReport({ ...session, name: 'Walkthrough' }, [take()])
    expect(report.split('\n')[0]).toBe('# Walkthrough')
  })
})

describe('files beside the report', () => {
  test('MANIFEST', () => {
    const manifest = buildManifestTxt(session, [take()], { source: 'handback' })
    expect(manifest.split('\n')[0]).toBe('format: video-to-prompt/2')
    expect(manifest).toMatchSnapshot()
  })

  test('recording.json', () => {
    const json: unknown = JSON.parse(buildRecordingJson(session, take(), 'https://handback.example/w/s1'))
    expect(json).toMatchSnapshot()
  })

  test('recording.json leaves transcriber out of a silent take', () => {
    const raw = buildRecordingJson(session, take({ transcript: [] }))
    expect(raw).not.toContain('"transcriber"')
  })

  test('transcript.txt', () => {
    expect(buildTranscriptTxt(take().meta)).toMatchSnapshot()
    expect(buildTranscriptTxt(take({ transcript: [] }).meta)).toBe('(no narration)\n')
  })
})

describe('ranking', () => {
  test('start-here frames: complaint lines first, the ending, in time order', () => {
    const ranked = rankFrames([take()])
    // ceil(10 / 3): one in three frames, clamped to 3–6.
    expect(ranked).toHaveLength(4)
    const picked = ranked.map((r) => r.frame.index)
    // The total (said "but") and the coupon error (said "still … even") make it, and so does the final state.
    expect(picked).toContain(4)
    expect(picked).toContain(5)
    expect(picked).toContain(10)
    expect(ranked.map((r) => r.pos)).toEqual([...ranked.map((r) => r.pos)].sort((a, b) => a - b))
    expect(ranked.find((r) => r.frame.index === 4)?.path).toBe('rec-01/frames/04-0090.jpg')
    expect(ranked.find((r) => r.frame.index === 4)?.line).toContain('1,240')
    expect(ranked.find((r) => r.frame.index === 5)?.error).toContain('TypeError')
  })

  test('whereOnScreen names the region in words', () => {
    expect(whereOnScreen({ x: 0.913, y: 0.933, w: 0.075, h: 0.044 })).toMatchSnapshot()
    expect(whereOnScreen({ x: 0.02, y: 0.02, w: 0.1, h: 0.05 })).toMatchSnapshot()
    expect(whereOnScreen({ x: 0.4, y: 0.45, w: 0.2, h: 0.1 })).toMatchSnapshot()
    expect(whereOnScreen({ x: 0.15, y: 0.089, w: 0.538, h: 0.844 })).toMatchSnapshot()
  })
})
