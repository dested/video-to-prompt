import { describe, expect, test } from 'bun:test'
import { readRecordingJson } from '../../src/read.ts'
import {
  buildManifestTxt,
  buildRecordingJson,
  buildReport,
  buildTranscriptTxt,
  evidenceAt,
  rankFrames,
  whereOnScreen,
} from '../../src/report.ts'
import {
  FORMAT_1,
  type Recording,
  type RecordingFrame,
  type Session,
  type TranscriptSegment,
} from '../../src/types.ts'

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

function frame(
  index: number,
  t: number,
  rest: Omit<RecordingFrame, 'index' | 't' | 'file'>
): RecordingFrame {
  const file = `frames/${String(index).padStart(2, '0')}-${String(Math.round(t / 100)).padStart(4, '0')}.jpg`
  return { index, t, file, ...rest }
}

/** The fixture app's run, as the v2 extractor reports it. */
const frames: RecordingFrame[] = [
  frame(1, 0, { reason: 'start', held: 3000 }),
  frame(2, 3000, { reason: 'change', dist: 838, held: 2250 }),
  frame(3, 5250, {
    reason: 'change',
    dist: 46,
    held: 500,
    transient: true,
    change: { x: 0.913, y: 0.933, w: 0.075, h: 0.044 },
  }),
  frame(4, 9000, {
    reason: 'change',
    dist: 34,
    held: 7000,
    change: { x: 0.794, y: 0.144, w: 0.181, h: 0.044 },
  }),
  frame(5, 16000, {
    reason: 'change',
    dist: 106,
    held: 3000,
    change: { x: 0.794, y: 0.189, w: 0.113, h: 0.144 },
  }),
  frame(6, 19000, { reason: 'change', dist: 12283, held: 3000 }),
  frame(7, 22000, {
    reason: 'change',
    dist: 34,
    held: 1250,
    change: { x: 0.4, y: 0.5, w: 0.05, h: 0.03 },
  }),
  frame(8, 24000, {
    reason: 'change',
    dist: 387,
    held: 3250,
    change: { x: 0.15, y: 0.089, w: 0.538, h: 0.844 },
  }),
  frame(9, 27250, {
    reason: 'change',
    dist: 36,
    held: 750,
    transient: true,
    change: { x: 0.863, y: 0.3, w: 0.075, h: 0.033 },
  }),
  frame(10, 29500, { reason: 'end', dist: 1225, held: 1500 }),
]

const transcript: TranscriptSegment[] = [
  { t: 600, d: 2100, text: 'This is the checkout page for a single order.' },
  { t: 4800, d: 1500, text: 'Saving shows a toast that disappears fast.' },
  {
    t: 8200,
    d: 2600,
    text: 'Look at the total, it says 1,240 but the line items add up to 1,180.',
  },
  {
    t: 15600,
    d: 2400,
    text: 'The coupon field still throws a validation error even with a valid code.',
  },
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
      events: [
        {
          level: 'error',
          message: 'TypeError: cannot read properties of undefined (reading "code")',
          ts: T0 + 16100,
        },
      ],
      videoFile: 'video.webm',
      ...over,
    },
  }
}

describe('report', () => {
  test('a narrated take', () => {
    expect(
      buildReport(session, [take()], { url: 'https://handback.example/w/s1', source: 'handback' })
    ).toMatchSnapshot()
  })

  test('two sittings, two voices, live dictation', () => {
    const voices = transcript.map((s, i) => ({ ...s, speaker: i % 3 === 1 ? 2 : 1 }))
    const later = T0 + 3600000
    const second = {
      ...take(
        {
          startedAt: later,
          transcript: voices.slice(0, 3),
          transcriber: undefined,
          transcriberLabel: undefined,
          events: [],
        },
        2
      ),
      createdAt: later,
    }
    const first = take({ transcript: voices })
    expect(buildReport({ ...session, recCount: 2 }, [first, second])).toMatchSnapshot()
  })

  test("a tool's action log", () => {
    const report = buildReport(
      session,
      [take({ transcriber: undefined, transcriberLabel: undefined })],
      {
        narration: 'log',
        narrationBy: 'bx',
        intro: 'bx drove this browser session.',
        videoPath: () => 'video.webm',
      }
    )
    expect(report).toMatchSnapshot()
    expect(report).not.toContain('spoken')
  })

  test('a silent take', () => {
    expect(
      buildReport(session, [
        take({ transcript: [], transcriber: undefined, transcriberLabel: undefined }),
      ])
    ).toMatchSnapshot()
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
    const json: unknown = JSON.parse(
      buildRecordingJson(session, take(), 'https://handback.example/w/s1')
    )
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

  test('a click is timeline evidence, not an error', () => {
    const clicked = take({
      events: [
        ...take().meta.events,
        { level: 'info', message: 'click: button#apply "Apply"', ts: T0 + 14000 },
        { level: 'info', message: 'nav: https://shop.example/cart', ts: T0 + 20000 },
      ],
    })
    const back = readRecordingJson(buildRecordingJson(session, clicked))
    expect(back?.recording.meta.events.map((e) => e.level)).toEqual(['error', 'info', 'info'])
    const report = back ? buildReport(session, [back.recording]) : ''
    expect(report).toContain('`[info] @ 0:14` click: button#apply "Apply"')
    expect(report).toContain('1 error captured')
    expect(buildManifestTxt(session, [clicked])).toContain('1 error(s)')
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

/** recording.json as a plain object, for tests that age it into older writers' shapes. */
function fileOf(rec: Recording): Record<string, unknown> {
  const value: unknown = JSON.parse(
    buildRecordingJson(session, rec, 'https://handback.example/w/s1')
  )
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('not an object')
  return { ...value }
}

function read(input: unknown): Recording {
  const got = readRecordingJson(input)
  if (!got) throw new Error('unreadable')
  return got.recording
}

describe('reading recording.json back', () => {
  test('round trip: the report from the file is the report from memory', () => {
    const original = take({ polished: true })
    const back = readRecordingJson(
      buildRecordingJson(session, original, 'https://handback.example/w/s1')
    )
    expect(back?.url).toBe('https://handback.example/w/s1')
    expect(back?.session.name).toBe('Checkout total')
    const opts = { url: 'https://handback.example/w/s1', source: 'handback', polishedBy: 'Claude' }
    const fromFile = back ? buildReport(session, [back.recording], opts) : ''
    expect(fromFile).toBe(buildReport(session, [original], opts))
    expect(fromFile).toContain('wording cleaned up by Claude')
  })

  test('two sittings with voices and a moved line survive the trip', () => {
    const voices = transcript.map((s, i) => ({ ...s, speaker: i % 3 === 1 ? 2 : 1 }))
    const moved = voices.map((s, i) => (i === 2 ? { ...s, tl: 40000 } : s))
    const later = T0 + 3600000
    const first = take({ transcript: moved })
    const second = {
      ...take({ startedAt: later, transcript: voices.slice(0, 3), events: [] }, 2),
      createdAt: later,
    }
    const back = [first, second].map((r) => read(buildRecordingJson(session, r)))
    expect(buildReport(session, back)).toBe(buildReport(session, [first, second]))
  })

  test('a format 1 file never claims the whole screen changed', () => {
    const file = fileOf(take())
    delete file.format
    const v1 = read(file)
    expect(v1.meta.format).toBe(FORMAT_1)
    // Format 1 had no change boxes at all.
    for (const f of v1.meta.frames) delete f.change
    const report = buildReport(session, [v1])
    expect(report).not.toContain('most of the screen changed')
    expect(report).not.toContain('magenta')
    expect(report).not.toContain('change boxes')
    expect(buildReport(session, [take()])).toContain('most of the screen changed')
    expect(buildReport(session, [take()])).toContain('magenta')
  })

  test("a live recorder's frames promise no outlines, here or after the trip", () => {
    // A live recorder keeps frames as it goes, by its own rule: no sampling, no change boxes.
    const live = take({
      sampling: undefined,
      frames: frames.map(({ change: _change, held: _held, transient: _t, ...f }) => f),
    })
    for (const rec of [live, read(fileOf(live))]) {
      const report = buildReport(session, [rec])
      const manifest = buildManifestTxt(session, [rec])
      expect(report).not.toContain('most of the screen changed')
      expect(report).not.toContain('magenta')
      expect(report).not.toContain('change boxes')
      expect(manifest).not.toContain('magenta')
      expect(manifest).not.toContain('change boxes')
    }
    expect(buildManifestTxt(session, [take()])).toContain('magenta')
  })

  test("the extension's shape: webspeech, folder-prefixed files, m:ss-only events", () => {
    const value: unknown = JSON.parse(`{
      "session": { "name": "Old one", "slug": "2026-07-29-1412-old", "createdAt": "2026-07-29T14:12:00.000Z", "origin": "https://app.example" },
      "recording": {
        "part": 2, "dir": "rec-02", "startedAt": "2026-07-29T14:12:05.000Z", "durationMs": 20000, "sampled": 20,
        "video": "walkthrough.webm", "transcriber": "webspeech", "transcriptReviewed": false,
        "frames": [
          { "index": 1, "at": "0:00", "tMs": 0, "file": "rec-02/frames/01-0000.jpg", "reason": "start" },
          { "index": 2, "at": "0:05", "tMs": 5000, "file": "frames/02-0005.jpg", "reason": "click", "dist": 400,
            "pointer": { "nx": 0.5, "ny": 0.4, "selector": "button.save", "text": "Save" } },
          { "index": 3, "file": "frames/03-0009.jpg", "reason": "teleport" },
          "junk"
        ],
        "transcript": [{ "at": "0:04", "tMs": 4000, "endMs": 6500, "aboutFromMs": 2000, "aboutToMs": 9000, "text": "Saving does nothing" }],
        "events": [{ "level": "error", "at": "0:06", "message": "500 POST /api/save" }, { "level": "debug", "at": "0:07", "message": "x" }]
      }
    }`)
    const got = readRecordingJson(value)
    const rec = got?.recording
    expect(rec?.index).toBe(2)
    expect(rec?.meta.transcriber).toBeUndefined()
    expect(rec?.meta.frames.map((f) => f.file)).toEqual([
      'frames/01-0000.jpg',
      'frames/02-0005.jpg',
    ])
    expect(rec?.meta.frames[1]?.pointer?.selector).toBe('button.save')
    expect(rec?.meta.transcript[0]?.d).toBe(2500)
    expect(rec?.meta.events).toHaveLength(1)
    expect(rec?.meta.events[0]?.ts).toBe(Date.parse('2026-07-29T14:12:05.000Z') + 6000)
    const report = rec && got ? buildReport(got.session, [rec]) : ''
    expect(report).toContain('`rec-02/frames/02-0005.jpg`')
    expect(report).toContain('live dictation (Web Speech)')
  })

  test('refuses what is not a recording', () => {
    expect(readRecordingJson('not json')).toBeNull()
    expect(readRecordingJson('{"session":{}}')).toBeNull()
    expect(readRecordingJson(null)).toBeNull()
  })
})

describe('host additions', () => {
  test("a transcriber's echo of the line before is said once", () => {
    const echoed = [
      ...transcript.slice(0, 3),
      {
        t: 11000,
        d: 3000,
        text: 'look at the total,  it says 1,240 but the line items add up to 1,180.',
      },
      ...transcript.slice(3),
    ]
    const report = buildReport(session, [take({ transcript: echoed })])
    expect(report.match(/it says 1,240/gi)).toHaveLength(2) // Start here + the timeline, once each
    expect(report).toContain('7 spoken lines')
  })

  test('a cut leaves out what it covers and marks the gap', () => {
    const report = buildReport(session, [take()], {
      cuts: [{ fromMs: 15000, toMs: 19000, reason: 'retook the coupon part' }],
    })
    expect(report).toContain('✂ **0:15–0:19** removed after recording: retook the coupon part')
    expect(report).toContain('Stretches marked ✂ were removed after recording')
    expect(report).not.toContain('frames/05-0160.jpg` ')
    expect(report).not.toContain('coupon field')
    expect(report).not.toContain('TypeError')
    expect(report).not.toContain('error captured')
    expect(
      rankFrames([take()], { cuts: [{ fromMs: 15000, toMs: 19000 }] }).map((r) => r.frame.index)
    ).not.toContain(5)
  })

  test('captions read as a model looking at the frame', () => {
    const report = buildReport(session, [take()], {
      captions: {
        'rec-01/frames/04-0090.jpg': 'The order total reads $1,240.00 under three line items.',
      },
    })
    expect(report).toContain('· shows: The order total reads $1,240.00 under three line items.')
    expect(report).toContain("`shows:` is a model's one-line reading of a frame")
    expect(buildReport(session, [take()])).not.toContain('shows:')
  })

  test('evidenceAt: the line said there, the frame that shows it, the error beside it', () => {
    const total = evidenceAt([take()], 8000)
    expect(total.line?.text).toContain('1,240')
    expect(total.frame?.path).toBe('rec-01/frames/04-0090.jpg')
    expect(total.error).toBeUndefined()

    const coupon = evidenceAt([take()], 16000)
    expect(coupon.line?.text).toContain('coupon')
    expect(coupon.frame?.path).toBe('rec-01/frames/05-0160.jpg')
    expect(coupon.error?.message).toContain('TypeError')

    // Nothing said within 5 s: the frame on screen then.
    const after = evidenceAt([take()], 40000)
    expect(after.line).toBeUndefined()
    expect(after.frame?.path).toBe('rec-01/frames/10-0295.jpg')
  })

  test('a line points at what was up while it was said, not what arrived as it ended', () => {
    // The fixture app's confirm dialog: up 19–22 s, closed at 22 s, narrated 19.5–22.5 s.
    const closed = frames.map((f) =>
      f.index === 7 ? frame(7, 22000, { reason: 'change', dist: 12283, held: 1250 }) : f
    )
    const said: TranscriptSegment[] = [
      {
        t: 3500,
        d: 3000,
        text: 'I save the invoice and it says saved, but it disappears really fast.',
      },
      {
        t: 19500,
        d: 3000,
        text: "When I click send it asks me to confirm, which is fine, I'll cancel.",
      },
    ]
    const recs = [take({ frames: closed, transcript: said, events: [] })]
    expect(evidenceAt(recs, 20000).frame?.path).toBe('rec-01/frames/06-0190.jpg')
    // Something that appears partway through is still what the line is about.
    expect(evidenceAt(recs, 4000).frame?.path).toBe('rec-01/frames/03-0053.jpg')
  })
})
