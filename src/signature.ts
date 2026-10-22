/**
 * Frame signatures: a frame shrunk to a small grayscale grid that keeps the
 * frame's aspect ratio, and the diff that says what changed between two of
 * them. Pure on purpose: the pixels arrive as RGBA from whatever drew them (a
 * decoded sample, a `<video>` element, a live screen share), so one rule serves
 * an after-the-fact distill and a live recorder alike.
 *
 * The grid used to be 64×64 RGB with a 25-level tolerance per channel mean,
 * squashing 16:9 into a square: a cell was ~30×17 px of a 1080p frame, and a
 * changed digit, a checkbox or a one-line validation message moved no cell
 * far enough to count. 160 columns with rows that follow the aspect ratio
 * make a cell ~12×12 px, and luma alone (text is dark-on-light far more
 * often than it is a hue) needs a third of the tolerance.
 */

/** Signature width in cells. At 1920 px wide a cell is 12×12 px: one changed glyph in 14 px text moves a cell ~30 levels. */
export const SIG_COLS = 160
/** A cell counts as changed past this many luma levels. Codec noise on flat UI sits at ±3–4; a 1 px caret moves its cells ~14. */
export const LUMA_TOL = 10
/**
 * Changed cells closer than this (in cells, Chebyshev) belong to one region.
 * Two is the gap between words of body text at 1080p, so a changed line of
 * text is one region rather than one per glyph.
 */
const REGION_GAP = 2
/** Regions kept per diff, largest first. Enough to bound a page-wide change; past that the screen is just "different". */
export const MAX_REGIONS = 64

export interface Signature {
  cols: number
  rows: number
  /** cols × rows luma, row-major. */
  luma: Uint8Array
}

/** A rectangle in signature cells. */
export interface CellBox {
  x: number
  y: number
  w: number
  h: number
}

export interface ChangeRegion extends CellBox {
  /** Changed cells inside the region. */
  cells: number
}

export interface SigDiff {
  /** Cells past LUMA_TOL. */
  changed: number
  /** changed ÷ all cells. */
  fraction: number
  /** Sum over changed cells of how far each moved: weights a bold change over a faint one of the same size. */
  energy: number
  /** Every changed cell's bounding box; null when nothing changed. */
  box: CellBox | null
  /** Connected changed regions, largest first, at most MAX_REGIONS. */
  regions: ChangeRegion[]
}

/** Rows that keep the frame's aspect ratio at SIG_COLS columns. */
export function sigRows(width: number, height: number): number {
  if (width <= 0 || height <= 0) return Math.round(SIG_COLS * (9 / 16))
  return Math.max(8, Math.min(SIG_COLS * 4, Math.round((SIG_COLS * height) / width)))
}

/** RGBA (as `getImageData` hands it over) → a luma signature. BT.601 weights in fixed point. */
export function signatureFromRgba(rgba: Uint8ClampedArray, cols: number, rows: number): Signature {
  const cells = cols * rows
  const luma = new Uint8Array(cells)
  for (let i = 0; i < cells; i++) {
    const p = i * 4
    luma[i] = (77 * (rgba[p] ?? 0) + 150 * (rgba[p + 1] ?? 0) + 29 * (rgba[p + 2] ?? 0)) >> 8
  }
  return { cols, rows, luma }
}

export interface DiffOptions {
  /** Luma levels a cell must move. Default LUMA_TOL. */
  tol?: number
  /** Cells to leave out entirely (1 = ignore), e.g. the ones that never stop changing. */
  ignore?: Uint8Array | null
  /** Filled with 1 for every changed cell, when given. */
  mask?: Uint8Array
}

/**
 * Cells that differ between `a` and `b` (as `diffSignatures` counts them),
 * counting no further than `limit`: a cheap first look before a full diff.
 */
export function changedCells(
  a: Signature,
  b: Signature,
  limit: number,
  ignore: Uint8Array | null = null
): number {
  if (b.cols !== a.cols || b.rows !== a.rows) return limit
  let n = 0
  for (let i = 0; i < a.luma.length; i++) {
    if (Math.abs((a.luma[i] ?? 0) - (b.luma[i] ?? 0)) <= LUMA_TOL || (ignore !== null && ignore[i]))
      continue
    if (++n >= limit) return limit
  }
  return n
}

/** What changed from `a` to `b`. Signatures of different shapes are wholly different. */
export function diffSignatures(a: Signature, b: Signature, opts: DiffOptions = {}): SigDiff {
  const tol = opts.tol ?? LUMA_TOL
  const ignore = opts.ignore ?? null
  const { cols, rows } = a
  const cells = cols * rows
  if (b.cols !== cols || b.rows !== rows) {
    return {
      changed: cells,
      fraction: 1,
      energy: cells * 255,
      box: { x: 0, y: 0, w: cols, h: rows },
      regions: [{ x: 0, y: 0, w: cols, h: rows, cells }],
    }
  }

  const mask = opts.mask ?? new Uint8Array(cells)
  if (opts.mask) mask.fill(0)
  let changed = 0
  let energy = 0
  let x0 = cols
  let y0 = rows
  let x1 = -1
  let y1 = -1
  for (let i = 0; i < cells; i++) {
    const d = Math.abs((a.luma[i] ?? 0) - (b.luma[i] ?? 0))
    if (d <= tol || (ignore !== null && ignore[i])) continue
    mask[i] = 1
    changed++
    energy += d
    const x = i % cols
    const y = (i - x) / cols
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (!changed) return { changed: 0, fraction: 0, energy: 0, box: null, regions: [] }

  return {
    changed,
    fraction: changed / cells,
    energy,
    box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    regions: regionsOf(mask, cols, rows),
  }
}

/** Flood-fill the changed mask into regions, joining cells within REGION_GAP of each other. */
function regionsOf(mask: Uint8Array, cols: number, rows: number): ChangeRegion[] {
  const seen = new Uint8Array(mask.length)
  const stack: number[] = []
  const regions: ChangeRegion[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    seen[start] = 1
    stack.push(start)
    let cells = 0
    let x0 = cols
    let y0 = rows
    let x1 = -1
    let y1 = -1
    while (stack.length) {
      const i = stack.pop() ?? 0
      const x = i % cols
      const y = (i - x) / cols
      cells++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const ny0 = Math.max(0, y - REGION_GAP)
      const ny1 = Math.min(rows - 1, y + REGION_GAP)
      const nx0 = Math.max(0, x - REGION_GAP)
      const nx1 = Math.min(cols - 1, x + REGION_GAP)
      for (let ny = ny0; ny <= ny1; ny++) {
        for (let nx = nx0; nx <= nx1; nx++) {
          const j = ny * cols + nx
          if (mask[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    regions.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, cells })
  }
  regions.sort((p, q) => q.cells - p.cells)
  return regions.slice(0, MAX_REGIONS)
}

/** Merge boxes into their bounding box; null for none. */
export function unionBox(boxes: CellBox[]): CellBox | null {
  if (!boxes.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
