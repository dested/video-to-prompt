import { describe, expect, test } from 'bun:test'
import { candidateTimes, frameBudget } from '../../src/frames.ts'
import {
  COLS,
  doc,
  flat,
  highlight,
  hold,
  paint,
  replay,
  replayDoc,
  ROWS,
  scrolled,
  VROWS,
  type Sample,
} from './helpers.ts'

const page = flat(240)
/** A toast: 12×4 cells in the bottom-right corner. */
const toast = paint(page, 146, 84, 12, 4)

describe('Selector', () => {
  test('a still screen is one frame', () => {
    const { picks } = replay(hold(page, 40))
    expect(picks.map((p) => [p.t, p.reason])).toEqual([[0, 'start']])
    expect(picks[0]?.held).toBe(10000)
  })

  test('a toast up for half a second is kept, flagged transient, boxed bottom-right', () => {
    const { picks } = replay([...hold(page, 8), ...hold(toast, 2), ...hold(page, 8)])
    expect(picks.map((p) => p.t)).toEqual([0, 2000])
    const kept = picks[1]
    expect(kept?.transient).toBe(true)
    expect(kept?.held).toBe(500)
    expect(kept?.change?.x).toBeGreaterThan(0.85)
    expect(kept?.change?.y).toBeGreaterThan(0.85)
  })

  test('a single-sample flash that snaps back is kept, up for one step', () => {
    const { picks } = replay([...hold(page, 8), toast, ...hold(page, 8)])
    expect(picks.map((p) => p.t)).toEqual([0, 2000])
    expect(picks[1]?.transient).toBe(true)
    expect(picks[1]?.held).toBe(250)
  })

  test('a wandering cursor makes no frames, even where it comes to rest', () => {
    // 1×2 cells is a pointer at 1080p (12 px cells).
    const frames = [...hold(page, 4)]
    for (let i = 0; i < 24; i++) frames.push(paint(page, 20 + i * 4, 30 + (i % 5) * 3, 1, 2, 0))
    frames.push(...hold(frames[frames.length - 1] ?? page, 8))
    expect(replay(frames).picks).toHaveLength(1)
  })

  test('a scroll yields its resting place, plus one frame per two seconds of motion', () => {
    // Scrolls from 1 s to 5.75 s, then rests.
    const frames = [...hold(scrolled(0), 4)]
    for (let s = 1; s <= 20; s++) frames.push(scrolled(s * 3))
    frames.push(...hold(scrolled(60), 8))
    const { picks } = replay(frames)
    expect(picks.map((p) => p.t)).toEqual([0, 2750, 4750, 5750])
    expect(picks.map((p) => p.held)).toEqual([1000, 250, 250, 2250])
    expect(picks.some((p) => p.transient)).toBe(false)
    // The whole page moved: no box.
    expect(picks[3]?.change).toBeUndefined()
  })

  test('a modal that closes is marked gone, and the page under it is not a new frame', () => {
    const modal = paint(page, 40, 20, 80, 50, 120)
    const { picks } = replay([...hold(page, 8), ...hold(modal, 8), ...hold(page, 8)])
    expect(picks.map((p) => p.t)).toEqual([0, 2000])
    expect(picks[1]?.transient).toBe(true)
    expect(picks[1]?.held).toBe(2000)
  })

  test('an A-B-C-A walk ends on a frame of A, since the last keyframe shows C', () => {
    const b = paint(page, 10, 10, 60, 30, 90)
    const c = paint(page, 80, 40, 60, 30, 160)
    const { picks } = replay([...hold(page, 8), ...hold(b, 8), ...hold(c, 8), ...hold(page, 12)])
    expect(picks.map((p) => [p.t, p.reason])).toEqual([
      [0, 'start'],
      [2000, 'change'],
      [4000, 'change'],
      [8750, 'end'],
    ])
  })

  test('the opening settles before the first frame is taken', () => {
    const picker = paint(page, 0, 0, 160, 90, 20)
    const { picks } = replay([picker, page, ...hold(page, 8)])
    expect(picks.map((p) => [p.t, p.reason])).toEqual([[250, 'start']])
  })

  test('a narration line over a minor change gets a frame inside it', () => {
    // A figure in a total changing: under the major bar.
    const figure = paint(page, 80, 60, 3, 2)
    const frames = [...hold(page, 8), ...hold(figure, 16)]
    // Unnarrated, only the ending catches it, at the very end.
    expect(replay(frames).picks.map((p) => [p.t, p.reason])).toEqual([
      [0, 'start'],
      [5750, 'end'],
    ])
    const spoken = replay(frames, { narration: [{ t: 2500, d: 2000, text: 'look at the total' }] })
    // Narrated, it is shown while it's talked about, and that frame is the ending too.
    expect(spoken.picks.map((p) => p.reason)).toEqual(['start', 'narration'])
    const anchor = spoken.picks[1]
    expect(anchor?.t).toBeGreaterThanOrEqual(2500)
    expect(anchor?.t).toBeLessThan(4500)
  })

  test('a narration line over an unchanged screen adds nothing', () => {
    const { picks } = replay(hold(page, 24), {
      narration: [{ t: 1000, d: 3000, text: 'this is the dashboard' }],
    })
    expect(picks).toHaveLength(1)
  })

  test('a minor change at the end gets a final frame, re-read at the last candidate', () => {
    const frames = [...hold(page, 12), ...hold(paint(page, 80, 60, 3, 2), 4)]
    const { picks, actions } = replay(frames)
    expect(picks.map((p) => p.reason)).toEqual(['start', 'end'])
    expect(actions.some((a) => a.kind === 'refetch' && a.t === 3750)).toBe(true)
  })

  test('a ticking clock goes quiet once busy, while a real change elsewhere still lands', () => {
    const frames = []
    for (let i = 0; i < 40; i++) {
      const tick = paint(page, 140, 2, 8, 2, i % 2 ? 30 : 90)
      frames.push(i >= 32 ? paint(tick, 30, 30, 40, 20, 100) : tick)
    }
    const { picks } = replay(frames)
    const late = picks.filter((p) => p.t >= 3000 && p.t < 8000)
    expect(late).toHaveLength(0)
    expect(picks.some((p) => p.t === 8000)).toBe(true)
  })

  test('past the budget the least-changed frames go, never the first or last', () => {
    const frames = [...hold(page, 4)]
    for (let i = 0; i < 20; i++) {
      const size = 4 + (i % 5) * 6
      frames.push(...hold(paint(page, (i * 7) % 120, (i * 11) % 60, size, size, (i * 37) % 200), 4))
    }
    const { picks, actions } = replay(frames, { budget: 8 })
    expect(picks).toHaveLength(8)
    expect(picks[0]?.reason).toBe('start')
    expect(actions.filter((a) => a.kind === 'drop').length).toBeGreaterThan(0)
  })
})

describe('page model (scroll grids)', () => {
  /** A doc read one wheel notch (15 strip rows) at a time, 2 s per notch, `notches` deep. */
  function readDown(notches: number): Sample[] {
    const out = [...hold(doc(0), 8)]
    for (let n = 1; n <= notches; n++) out.push(...hold(doc(n * 15), 8))
    return out
  }
  function readUp(
    from: number,
    overlay?: (n: number) => ReturnType<typeof highlight> | undefined
  ): Sample[] {
    const out: Sample[] = []
    for (let n = from - 1; n >= 0; n--) out.push(...hold(doc(n * 15, overlay?.(n)), 8))
    return out
  }
  const other: Sample = {
    sig: paint(flat(90), 20, 20, 60, 30, 200),
    vsig: { cols: 40, rows: VROWS, luma: new Uint8Array(40 * VROWS).fill(90) },
  }

  test('a doc read a notch at a time costs a frame per half screen, and every moment has one', () => {
    // 48 notches is two screens past the first.
    const { picks } = replayDoc(readDown(48))
    expect(picks.map((p) => p.t)).toEqual([0, 24000, 48000, 72000, 96000])
    // The notches between keyframes are stood in for by the one that shows them.
    expect(picks[0]?.seen).toEqual([[2000, 24000]])
    expect(picks[1]?.seen).toEqual([[26000, 48000]])
  })

  test('without scroll grids the same read is a frame per notch', () => {
    const { picks } = replay(readDown(48).map((s) => s.sig))
    expect(picks.length).toBeGreaterThan(40)
  })

  test('scrolling back over what was read adds nothing; the frames that showed it say when', () => {
    const { picks } = replayDoc([...readDown(48), ...readUp(48)])
    expect(picks.map((p) => p.t)).toEqual([0, 24000, 48000, 72000, 96000])
    // The way back up ends on the top of the doc, which the first frame shows.
    expect(picks[0]?.seen?.at(-1)).toEqual([182000, 194000])
  })

  test('a passage changed while it was off screen is new when it comes back, once', () => {
    const marked = highlight(40, 46, 8, 90)
    const { picks } = replayDoc([
      ...readDown(48),
      ...readUp(48, (n) => (n < 20 ? marked : undefined)),
    ])
    // Rows 40-46 come into view at notch 2 (t 188 s): kept there, and the
    // notches above it stand in on that frame, not the unmarked first one.
    expect(picks.map((p) => p.t)).toEqual([0, 24000, 48000, 72000, 96000, 188000])
    expect(picks[5]?.seen).toEqual([[190000, 194000]])
  })

  test('a view looked at, then left for another screen, is kept on the way out', () => {
    // 60 rows down is a sixth of the screen unseen: not enough to keep at once.
    const { picks } = replayDoc([...hold(doc(0), 8), ...hold(doc(60), 8), ...hold(other, 8)])
    expect(picks.map((p) => p.t)).toEqual([0, 2250, 4000])
  })

  test('a view only passed through (under the dwell) is not kept on the way out', () => {
    const { picks } = replayDoc([...hold(doc(0), 8), ...hold(doc(60), 4), ...hold(other, 8)])
    expect(picks.map((p) => p.t)).toEqual([0, 3000])
  })

  test('a highlight on a page is a detail of the frame it was made on', () => {
    const { picks } = replayDoc([
      ...hold(doc(0), 8),
      ...hold(doc(200), 8),
      ...hold(doc(200, highlight(250, 256, 8, 80)), 8),
    ])
    expect(picks.map((p) => p.t)).toEqual([0, 2000, 4000])
    expect(picks[1]?.detail).toBeUndefined()
    expect(picks[2]?.detail?.of).toBe(picks[1]?.id)
    const box = picks[2]?.detail?.box
    expect(box && box.w * box.h).toBeLessThan(0.02)
  })

  test('a drag-selection shows in full once it stops, though it heated as it grew', () => {
    const drag: Sample[] = [...hold(doc(0), 8)]
    for (let i = 1; i <= 12; i++) drag.push(doc(0, highlight(100, 106, 8, 8 + i * 4)))
    drag.push(...hold(doc(0, highlight(100, 106, 8, 56)), 12))
    const { picks } = replayDoc(drag)
    // The drag ends at 4.75 s; the frame is the finished selection, standing in from when it settled.
    const last = picks.at(-1)
    expect(last?.t).toBe(4750)
    // Measured from the whole screen, the detail spans the selection's full width.
    expect(last?.detail?.of).toBe(picks[0]?.id)
    expect(last?.detail?.box.x).toBeCloseTo(0.05, 2)
    expect(last?.detail?.box.w).toBeCloseTo(0.3, 2)
  })

  test('a modal over a page is a full frame, not a detail', () => {
    const modal = doc(0, highlight(60, 300, 30, 130, 250))
    const { picks } = replayDoc([...hold(doc(0), 8), ...hold(modal, 8)])
    expect(picks.map((p) => p.t)).toEqual([0, 2000])
    expect(picks[1]?.detail).toBeUndefined()
  })
})

describe('video', () => {
  /**
   * A 32×24-cell webcam tile on `base`: each step re-shades four 2×2 specks
   * somewhere in it. `inPlace` puts each step's specks on the bare tile, a face
   * that moves but stays where it sits.
   */
  function webcam(base: typeof page, steps: number, seed = 7, inPlace = false): (typeof page)[] {
    let r = seed
    const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648)
    const out: (typeof page)[] = []
    const tile = paint(base, 40, 20, 32, 24, 120)
    let cur = tile
    for (let i = 0; i < steps; i++) {
      if (inPlace) cur = tile
      for (let k = 0; k < 4; k++)
        cur = paint(cur, 40 + Math.floor(rand() * 30), 20 + Math.floor(rand() * 22), 2, 2, 60 + Math.floor(rand() * 120))
      out.push(cur)
    }
    return out
  }

  test('a webcam tile that keeps moving makes no frames once it is known for video', () => {
    const { picks } = replay(webcam(page, 240), { budget: 1000 })
    // It takes a few seconds of change to tell video from a page being worked on.
    expect(picks.filter((p) => p.t > 10000 && p.reason !== 'end')).toEqual([])
  })

  test('coming back to a call from another window costs no frame', () => {
    const other = paint(paint(page, 0, 0, COLS, ROWS, 200), 10, 10, 100, 4, 30)
    const call = webcam(page, 120)
    // Back mid-call: every face has moved since the call's frames were taken.
    const back = webcam(page, 240, 11).slice(120)
    const { picks } = replay([...call, ...hold(other, 120), ...back], { budget: 1000 })
    // The other window gets its frame; the call, come back to, is the frame it already has.
    expect(picks.filter((p) => p.t >= 30000 && p.t < 60000).length).toBe(1)
    expect(picks.filter((p) => p.t >= 60000 && p.reason !== 'end')).toEqual([])
  })

  test('a clip that stops shows its last picture once it has held', () => {
    const moving = webcam(page, 160)
    const still = paint(paint(page, 40, 20, 32, 24, 120), 44, 24, 24, 16, 20)
    const { picks } = replay([...moving, ...hold(still, 80)], { budget: 1000 })
    const last = picks.at(-1)
    expect(last?.t).toBeGreaterThanOrEqual(40000)
    expect(last?.t).toBeLessThan(40000 + 12000)
  })

  test('a face that settles a few cells from where it was costs no frame', () => {
    const moving = webcam(page, 160, 7, true)
    const settled = paint(paint(page, 40, 20, 32, 24, 120), 50, 30, 2, 2, 60)
    // Talking over it the whole time: every line wants a picture.
    const narration = Array.from({ length: 12 }, (_, i) => ({ t: 42000 + i * 3000, d: 2500, text: 'so anyway' }))
    const { picks } = replay([...moving, ...hold(settled, 160)], { budget: 1000, narration })
    expect(picks.filter((p) => p.t > 10000 && p.reason !== 'end')).toEqual([])
  })
})

describe('cadence', () => {
  test('WebCodecs samples every 250 ms, seeking every second, both ending near the tail', () => {
    const fast = candidateTimes(2000, 'webcodecs')
    expect(fast.stepMs).toBe(250)
    expect(fast.times).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 1900])
    const slow = candidateTimes(2700, 'seek')
    expect(slow.stepMs).toBe(1000)
    expect(slow.times).toEqual([0, 1000, 2000, 2600])
    // A tail within half a step of the last candidate adds nothing.
    expect(candidateTimes(2600, 'seek').times).toEqual([0, 1000, 2000])
  })

  test('an hour still samples every 250 ms; past two hours the step stretches instead', () => {
    expect(candidateTimes(3600 * 1000, 'webcodecs').stepMs).toBe(250)
    expect(candidateTimes(3 * 3600 * 1000, 'webcodecs').times.length).toBeLessThanOrEqual(28801)
  })

  test('frame budget', () => {
    expect(frameBudget(30000)).toBe(150)
    expect(frameBudget(10 * 60000)).toBe(400)
    expect(frameBudget(3 * 3600000)).toBe(600)
  })
})
