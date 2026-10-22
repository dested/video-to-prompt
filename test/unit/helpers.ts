import type { Signature } from '../../src/signature.ts'
import { Selector, type NarrationWindow, type Pick, type SelectAction } from '../../src/select.ts'

export const COLS = 160
export const ROWS = 90

/** A flat signature: a page of one shade. */
export function flat(luma = 240): Signature {
  return { cols: COLS, rows: ROWS, luma: new Uint8Array(COLS * ROWS).fill(luma) }
}

/** A copy of `base` with a rectangle (in cells) painted `luma`. */
export function paint(
  base: Signature,
  x: number,
  y: number,
  w: number,
  h: number,
  luma = 30
): Signature {
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

/**
 * Feed `frames` (one per `stepMs`) through a Selector. `heard` replays it the
 * way a live recorder does: no length up front, and speech [start, end) ms
 * opened and closed as the candidates reach it.
 */
export function replay(
  frames: Signature[],
  opts: {
    stepMs?: number
    budget?: number
    narration?: NarrationWindow[]
    heard?: [number, number][]
  } = {}
): Replay {
  const step = opts.stepMs ?? 250
  const live = opts.heard !== undefined
  const sel = new Selector({
    ...(live ? {} : { durationMs: frames.length * step }),
    budget: opts.budget ?? 150,
    narration: opts.narration,
  })
  const heard = [...(opts.heard ?? [])]
  let open = false
  const actions: SelectAction[] = []
  frames.forEach((sig, i) => {
    const t = i * step
    const line = heard[0]
    if (line && !open && t >= line[0]) {
      sel.openLine(t)
      open = true
    }
    if (line && open && t >= line[1]) {
      sel.closeLine(t)
      open = false
      heard.shift()
    }
    actions.push(...sel.push(t, sig))
  })
  actions.push(...sel.finish(live ? frames.length * step : undefined))
  return { picks: sel.picks(), actions }
}

/** n copies of a signature. */
export function hold<T>(sig: T, n: number): T[] {
  return Array.from({ length: n }, () => sig)
}

/** What the selector sees of one sample: both grids. */
export interface Sample {
  sig: Signature
  vsig: Signature
}

/** Scroll-grid rows on one screen, and the text lines on a long document (in those rows). */
export const VROWS = ROWS * 4
const LINE = 10
const INK = 6

function hash(a: number, b: number): number {
  return Math.abs(((a * 2654435761) ^ (b * 40503)) % 9973)
}

/** Luma of the document at pixel (row, col): lines of words, each line its own length. */
function docPixel(row: number, col: number): number {
  const line = Math.floor(row / LINE)
  if (row % LINE >= INK) return 240
  if (col < 8 || col > 60 + (hash(line, 1) % 90)) return 240
  const word = Math.floor((col - 8) / 9)
  if (hash(line, word) % 5 === 0 || (col - 8) % 9 === 8) return 240
  return 30 + (hash(line, word + 100) % 90)
}

export type Overlay = (row: number, col: number) => number | undefined

/**
 * A long document scrolled `top` scroll-grid rows, as both grids: the main grid
 * averages 4 pixel rows a cell, the scroll grid 4 pixel columns. `overlay` is
 * in document rows (a highlight, a selection) and wins over the page.
 */
export function doc(top: number, overlay?: Overlay): Sample {
  const px = new Uint8Array(COLS * VROWS)
  for (let y = 0; y < VROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      px[y * COLS + x] = overlay?.(top + y, x) ?? docPixel(top + y, x)
    }
  }
  const sig = flat(0)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += px[(y * 4 + k) * COLS + x] ?? 0
      sig.luma[y * COLS + x] = Math.round(sum / 4)
    }
  }
  const vcols = COLS / 4
  const vsig: Signature = { cols: vcols, rows: VROWS, luma: new Uint8Array(vcols * VROWS) }
  for (let y = 0; y < VROWS; y++) {
    for (let x = 0; x < vcols; x++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += px[y * COLS + x * 4 + k] ?? 0
      vsig.luma[y * vcols + x] = Math.round(sum / 4)
    }
  }
  return { sig, vsig }
}

/** A highlight over document rows [from, to) and pixel columns [x0, x1). */
export function highlight(from: number, to: number, x0: number, x1: number, luma = 180): Overlay {
  return (row, col) => (row >= from && row < to && col >= x0 && col < x1 ? luma : undefined)
}

/** Feed samples (one per `stepMs`) with their scroll grids through a Selector. */
export function replayDoc(
  samples: Sample[],
  opts: { stepMs?: number; narration?: NarrationWindow[] } = {}
): Replay {
  const step = opts.stepMs ?? 250
  const sel = new Selector({ durationMs: samples.length * step, narration: opts.narration })
  const actions: SelectAction[] = []
  samples.forEach((s, i) => actions.push(...sel.push(i * step, s.sig, s.vsig)))
  actions.push(...sel.finish())
  return { picks: sel.picks(), actions }
}
