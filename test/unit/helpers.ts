import type { Signature } from '../../src/signature.ts'
import { Selector, type NarrationWindow, type Pick, type SelectAction } from '../../src/select.ts'

export const COLS = 160
export const ROWS = 90

/** A flat signature: a page of one shade. */
export function flat(luma = 240): Signature {
  return { cols: COLS, rows: ROWS, luma: new Uint8Array(COLS * ROWS).fill(luma) }
}

/** A copy of `base` with a rectangle (in cells) painted `luma`. */
export function paint(base: Signature, x: number, y: number, w: number, h: number, luma = 30): Signature {
  const out = { ...base, luma: base.luma.slice() }
  for (let yy = y; yy < Math.min(base.rows, y + h); yy++) {
    for (let xx = x; xx < Math.min(base.cols, x + w); xx++) out.luma[yy * base.cols + xx] = luma
  }
  return out
}

/** A tall page of uneven bands, scrolled `shift` rows: no two offsets look alike. */
export function scrolled(shift: number): Signature {
  const out = flat(240)
  for (let y = 0; y < ROWS; y++) {
    const row = y + shift
    const shade = (row * 2654435761) % 7 < 3 ? 40 + ((row * 97) % 120) : 240
    out.luma.fill(shade, y * COLS, (y + 1) * COLS)
  }
  return out
}

export interface Replay {
  picks: Pick[]
  actions: SelectAction[]
}

/** Feed `frames` (one per `stepMs`) through a Selector. */
export function replay(
  frames: Signature[],
  opts: { stepMs?: number; budget?: number; narration?: NarrationWindow[] } = {}
): Replay {
  const step = opts.stepMs ?? 250
  const sel = new Selector({
    durationMs: frames.length * step,
    budget: opts.budget ?? 150,
    narration: opts.narration,
  })
  const actions: SelectAction[] = []
  frames.forEach((sig, i) => actions.push(...sel.push(i * step, sig)))
  actions.push(...sel.finish())
  return { picks: sel.picks(), actions }
}

/** n copies of a signature. */
export function hold(sig: Signature, n: number): Signature[] {
  return Array.from({ length: n }, () => sig)
}
