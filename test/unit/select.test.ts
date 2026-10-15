import { describe, expect, test } from 'bun:test'
import { candidateTimes, frameBudget } from '../../src/frames.ts'
import { flat, hold, paint, replay, scrolled } from './helpers.ts'

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
    expect(picks.map((p) => [p.t, p.reason])).toEqual([[0, 'start'], [2000, 'change'], [4000, 'change'], [8750, 'end']])
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
    expect(replay(frames).picks.map((p) => [p.t, p.reason])).toEqual([[0, 'start'], [5750, 'end']])
    const spoken = replay(frames, { narration: [{ t: 2500, d: 2000, text: 'look at the total' }] })
    // Narrated, it is shown while it's talked about, and that frame is the ending too.
    expect(spoken.picks.map((p) => p.reason)).toEqual(['start', 'narration'])
    const anchor = spoken.picks[1]
    expect(anchor?.t).toBeGreaterThanOrEqual(2500)
    expect(anchor?.t).toBeLessThan(4500)
  })

  test('a narration line over an unchanged screen adds nothing', () => {
    const { picks } = replay(hold(page, 24), { narration: [{ t: 1000, d: 3000, text: 'this is the dashboard' }] })
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

  test('long clips stretch the step instead of the candidate count', () => {
    expect(candidateTimes(3 * 3600 * 1000, 'webcodecs').times.length).toBeLessThanOrEqual(7201)
  })

  test('frame budget', () => {
    expect(frameBudget(30000)).toBe(150)
    expect(frameBudget(10 * 60000)).toBe(400)
    expect(frameBudget(3 * 3600000)).toBe(600)
  })
})
