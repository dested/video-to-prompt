/**
 * Scroll-aware comparison. A page that scrolled changed almost every cell of
 * the main signature, yet shows nothing new except the rows that slid in. To
 * tell the two apart a second grid is read from each candidate: 40 columns by
 * four times the main grid's rows, so a cell is a short horizontal strip (8 px
 * tall at 2160p, 3 px at 1080p). Text lines are horizontal, so the strips keep
 * the vertical structure a scroll moves while dropping the horizontal detail it
 * doesn't. Same cell area as the main grid, so cell counts compare one to one.
 *
 * Pure, like the rest of selection: it sees two grids and answers how far the
 * content moved, how much of it is new, and what changed in place.
 */

import type { Signature } from './signature.js'

/** Scroll grid width in cells. */
export const VSIG_COLS = 40
/** Scroll grid rows per main-grid row. */
export const VSIG_ROW_FACTOR = 4

/** A cell that didn't move counts as unchanged within this many levels (the main grid's tolerance). */
const STILL_TOL = 10
/** A cell moved past this many levels after the shift is undone: an edit, a highlight. Above the main grid's tolerance because 8 px strips of scrolled text land between rows. */
const RESIDUAL_TOL = 24
/** A column belongs to the moving band when this share of its cells changed. */
const BAND_COL_SHARE = 0.08
/** The band must be at least this many columns (a tenth of the frame) to be a scrolling surface. */
const MIN_BAND_COLS = 4
/** …and the change inside it at least this many strips tall. */
const MIN_BAND_ROWS = 20
/** Rows two grids must still share after a shift for the match to mean anything… */
const MIN_OVERLAP_ROWS = 12
/** …and at least this share of the band: a sliver of shared edge (a margin, a rule) matches anywhere. */
const MIN_OVERLAP_SHARE = 0.2
/** A shift explains the change when it leaves this share of the unshifted error, or less… */
const SHIFT_GAIN = 0.45
/** …and the mean error that's left is at most this many levels. */
const SHIFT_MAX_MAD = 10
/** A shift is settled to 1/(2·SUBSTEPS) of a strip: a pixel at 2160p. */
const SUBSTEPS = 4
/** Residual cells this close (in cells) are one region. */
const REGION_GAP = 2
/** A residual region this big is a real change in place: a highlighted line, a typed word. */
const RESIDUAL_REGION = 12
/** Residual cells in clusters, in total, that are a real change even when no one cluster is big. */
const RESIDUAL_TOTAL = 40
/** Fewest residual cells that make a cluster. */
const CLUSTER_MIN = 6
/** Strips at the band's top and bottom edge are half page, half frame (a sticky header, the viewport's border): never residual. */
const EDGE_ROWS = 2
/** Share of a column's rows that may disagree with the shift and still count as moving with the page. */
const WIDEN_SLACK = 0.04

export function vsigRows(mainRows: number): number {
  return mainRows * VSIG_ROW_FACTOR
}

export interface Band {
  x0: number
  x1: number
  y0: number
  y1: number
}

export interface ShiftMatch {
  /** The columns and rows that moved. */
  band: Band
  /** Content moved up by this many scroll-grid rows, to a fraction of one (positive = scrolled down the page). */
  dy: number
  /** Share of the band's height that slid in: content the earlier grid never showed. */
  revealed: number
  /** Cells that still differ once the shift is undone, counting only clusters (see `clusters`). */
  residual: number
  /** The largest connected run of them. */
  residualRegion: number
}

/** The widest run of columns where a real share of cells changed between `a` and `b`. */
export function movingBand(a: Signature, b: Signature, tol = 12): Band | null {
  const { cols, rows } = a
  if (b.cols !== cols || b.rows !== rows) return null
  const perCol = new Uint16Array(cols)
  for (let i = 0; i < a.luma.length; i++) {
    if (Math.abs((a.luma[i] ?? 0) - (b.luma[i] ?? 0)) > tol) perCol[i % cols]!++
  }
  let best: [number, number] | null = null
  let start = -1
  let gap = 0
  for (let x = 0; x <= cols; x++) {
    const on = x < cols && (perCol[x] ?? 0) >= rows * BAND_COL_SHARE
    if (on) {
      if (start < 0) start = x
      gap = 0
    } else if (start >= 0) {
      // One quiet column inside a band (a gutter between text columns) doesn't split it.
      if (x < cols && gap === 0 && (perCol[x + 1] ?? 0) >= rows * BAND_COL_SHARE) {
        gap = 1
        continue
      }
      const end = x - 1 - gap
      if (!best || end - start > best[1] - best[0]) best = [start, end]
      start = -1
      gap = 0
    }
  }
  if (!best || best[1] - best[0] + 1 < MIN_BAND_COLS) return null
  let y0 = rows
  let y1 = -1
  for (let y = 0; y < rows; y++) {
    for (let x = best[0]; x <= best[1]; x++) {
      const i = y * cols + x
      if (Math.abs((a.luma[i] ?? 0) - (b.luma[i] ?? 0)) > tol) {
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        break
      }
    }
  }
  if (y1 - y0 + 1 < MIN_BAND_ROWS) return null
  return { x0: best[0], x1: best[1], y0, y1 }
}

/**
 * Luma of column `x` at a fractional row: a strip is a box average, so a page
 * that moved part of a strip reads as a blend of the two strips it straddles.
 */
function lumaAt(s: Signature, y: number, x: number): number {
  const y0 = Math.floor(y)
  const f = y - y0
  const top = s.luma[y0 * s.cols + x] ?? 0
  return f === 0 ? top : top * (1 - f) + (s.luma[(y0 + 1) * s.cols + x] ?? 0) * f
}

/** Mean |a(y+dy) − b(y)| over the band's overlap; Infinity when it shares fewer than `minRows`. */
function madAt(a: Signature, b: Signature, band: Band, dy: number, minRows: number): number {
  const cols = a.cols
  let sum = 0
  let n = 0
  for (
    let y = Math.max(band.y0, Math.ceil(band.y0 - dy));
    y + Math.ceil(dy) <= band.y1 && y <= band.y1;
    y++
  ) {
    const rb = y * cols
    for (let x = band.x0; x <= band.x1; x++) {
      sum += Math.abs(lumaAt(a, y + dy, x) - (b.luma[rb + x] ?? 0))
      n++
    }
  }
  return n >= (band.x1 - band.x0 + 1) * minRows ? sum / n : Infinity
}

/** Row means over the band's columns: a 1-D profile cheap enough to slide over every shift. */
function profile(s: Signature, band: Band): Float32Array {
  const out = new Float32Array(band.y1 - band.y0 + 1)
  const w = band.x1 - band.x0 + 1
  for (let y = band.y0; y <= band.y1; y++) {
    let sum = 0
    for (let x = band.x0; x <= band.x1; x++) sum += s.luma[y * s.cols + x] ?? 0
    out[y - band.y0] = sum / w
  }
  return out
}

/**
 * Did `b` come from `a` by scrolling? Finds the band that changed, slides `a`'s
 * profile over `b`'s to shortlist shifts, checks the best few cell by cell, and
 * accepts one only when it explains most of the change. Null: not a scroll.
 *
 * `ignore` (scroll-grid cells, 1 = leave out) carries the selector's busy cells
 * over, so a recorder's own ticking clock never reads as a change in place.
 */
export function matchShift(
  a: Signature,
  b: Signature,
  ignore?: Uint8Array | null
): ShiftMatch | null {
  const band = movingBand(a, b)
  if (!band) return null
  const h = band.y1 - band.y0 + 1
  const pa = profile(a, band)
  const pb = profile(b, band)
  const minRows = Math.max(MIN_OVERLAP_ROWS, Math.ceil(h * MIN_OVERLAP_SHARE))
  const maxShift = h - minRows
  const scored: { dy: number; e: number }[] = []
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    if (dy === 0) continue
    let sum = 0
    let n = 0
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
      sum += Math.abs((pa[y + dy] ?? 0) - (pb[y] ?? 0))
      n++
    }
    scored.push({ dy, e: sum / n })
  }
  scored.sort((p, q) => p.e - q.e)
  const base = madAt(a, b, band, 0, minRows)
  let best = { dy: 0, mad: base }
  for (const { dy } of scored.slice(0, 4)) {
    for (let d = dy - 1; d <= dy + 1; d++) {
      if (d === 0) continue
      const mad = madAt(a, b, band, d, minRows)
      if (mad < best.mad) best = { dy: d, mad }
    }
  }
  // Scrolls rarely land on a strip boundary: settle the part of a strip too,
  // or every text line reads as edited where the shift splits it.
  if (best.dy !== 0) {
    const whole = best.dy
    for (let f = -SUBSTEPS + 1; f < SUBSTEPS; f++) {
      if (f === 0) continue
      const d = whole + f / (2 * SUBSTEPS)
      const mad = madAt(a, b, band, d, minRows)
      if (mad < best.mad) best = { dy: d, mad }
    }
  }
  if (best.dy === 0 || !(best.mad <= SHIFT_MAX_MAD) || !(best.mad <= base * SHIFT_GAIN)) return null

  const wide = widen(a, b, band, best.dy, ignore ?? null)
  const { residual, residualRegion } = residualOf(a, b, wide, best.dy, ignore ?? null)
  return { band: wide, dy: best.dy, revealed: Math.abs(best.dy) / h, residual, residualRegion }
}

/**
 * The band grown sideways over every column the shift explains as well. The
 * band is where most rows changed; a ragged right edge (the few lines longer
 * than the rest) moved with the page too, and left outside it, the rows it
 * revealed would read as an edit.
 */
function widen(
  a: Signature,
  b: Signature,
  band: Band,
  dy: number,
  ignore: Uint8Array | null
): Band {
  const cols = a.cols
  const y0 = Math.max(band.y0 + EDGE_ROWS, Math.ceil(band.y0 + EDGE_ROWS - dy))
  const y1 = Math.min(band.y1 - EDGE_ROWS, Math.floor(band.y1 - EDGE_ROWS - dy))
  // The pointer, or a strip of codec ringing, sitting in a margin column.
  const slack = Math.max(2, Math.round((y1 - y0 + 1) * WIDEN_SLACK))
  const follows = (x: number): boolean => {
    let off = 0
    for (let y = y0; y <= y1; y++) {
      const i = y * cols + x
      if (ignore?.[i]) continue
      if (Math.abs(lumaAt(a, y + dy, x) - (b.luma[i] ?? 0)) > RESIDUAL_TOL && ++off > slack)
        return false
    }
    return true
  }
  let x0 = band.x0
  let x1 = band.x1
  while (x0 > 0 && follows(x0 - 1)) x0--
  while (x1 < cols - 1 && follows(x1 + 1)) x1++
  return { ...band, x0, x1 }
}

/**
 * What still differs anywhere on screen once the shift is undone: a cell is
 * explained when it matches `a` where it was (a sidebar that didn't move) or
 * where the shift says it came from (the page that did). The rows that slid
 * into the band have no source and are the reveal, not a residual.
 */
function residualOf(
  a: Signature,
  b: Signature,
  band: Band,
  dy: number,
  ignore: Uint8Array | null
): { residual: number; residualRegion: number } {
  const { cols, rows } = a
  const mask = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    const sy = y + dy
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (ignore?.[i]) continue
      const inBand = x >= band.x0 && x <= band.x1 && y >= band.y0 && y <= band.y1
      if (inBand && (sy < band.y0 + EDGE_ROWS || sy > band.y1 - EDGE_ROWS)) continue
      if (inBand && (y < band.y0 + EDGE_ROWS || y > band.y1 - EDGE_ROWS)) continue
      const bv = b.luma[i] ?? 0
      if (Math.abs((a.luma[i] ?? 0) - bv) <= STILL_TOL) continue
      if (sy >= 0 && sy <= rows - 1 && Math.abs(lumaAt(a, sy, x) - bv) <= RESIDUAL_TOL) continue
      mask[i] = 1
    }
  }
  const c = clusters(mask, cols, rows)
  return { residual: c.total, residualRegion: c.largest }
}

/**
 * What differs inside `band` between two views of the same page whose offset
 * is already known (`b` shows `a`'s row y + dy at row y): the check that rows a
 * keyframe from minutes ago showed still read the same. Only the rows both
 * show are compared; `rows` says how many that was, and `changed` which of
 * `b`'s rows hold a cluster of differences.
 */
export function residualAt(
  a: Signature,
  b: Signature,
  band: Band,
  dy: number,
  ignore?: Uint8Array | null
): { residual: number; residualRegion: number; rows: number; changed: [number, number][] } {
  const { cols, rows } = a
  const mask = new Uint8Array(cols * rows)
  let compared = 0
  const y0 = Math.max(band.y0 + EDGE_ROWS, Math.ceil(band.y0 + EDGE_ROWS - dy))
  const y1 = Math.min(band.y1 - EDGE_ROWS, Math.floor(band.y1 - EDGE_ROWS - dy))
  for (let y = y0; y <= y1; y++) {
    compared++
    for (let x = band.x0; x <= band.x1; x++) {
      const i = y * cols + x
      if (ignore?.[i]) continue
      if (Math.abs(lumaAt(a, y + dy, x) - (b.luma[i] ?? 0)) <= RESIDUAL_TOL) continue
      mask[i] = 1
    }
  }
  const hit = new Uint8Array(rows)
  const c = clusters(mask, cols, rows, hit)
  const changed: [number, number][] = []
  for (let y = 0; y < rows; y++) {
    if (!hit[y]) continue
    const last = changed[changed.length - 1]
    if (last && last[1] === y) last[1] = y + 1
    else changed.push([y, y + 1])
  }
  return { residual: c.total, residualRegion: c.largest, rows: compared, changed }
}

/**
 * Residual cells that form something: runs of CLUSTER_MIN or more that span
 * more than one column, in total and the largest. One column is a strip as
 * narrow as the mouse pointer, which moves between any two frames and stands
 * six strips tall; a lone strip or two is codec ringing on text. An edit, a
 * highlight, a column scrolled sideways is always a cluster.
 */
function clusters(
  mask: Uint8Array,
  w: number,
  h: number,
  rowsHit?: Uint8Array
): { total: number; largest: number } {
  const seen = new Uint8Array(mask.length)
  const stack: number[] = []
  const members: number[] = []
  let largest = 0
  let total = 0
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue
    seen[s] = 1
    stack.push(s)
    members.length = 0
    let n = 0
    let x0 = w
    let x1 = -1
    while (stack.length) {
      const i = stack.pop() ?? 0
      n++
      members.push(i)
      const x = i % w
      const y = (i - x) / w
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      for (let ny = Math.max(0, y - REGION_GAP); ny <= Math.min(h - 1, y + REGION_GAP); ny++) {
        for (let nx = Math.max(0, x - REGION_GAP); nx <= Math.min(w - 1, x + REGION_GAP); nx++) {
          const j = ny * w + nx
          if (mask[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    if (x1 > x0 && n >= CLUSTER_MIN) {
      total += n
      if (n > largest) largest = n
      if (rowsHit) for (const i of members) rowsHit[Math.floor(i / w)] = 1
    }
  }
  return { total, largest }
}

/** A scroll left something changed in place: a highlight, an edit, a new line under the cursor. */
export function changedInPlace(m: { residual: number; residualRegion: number }): boolean {
  return m.residualRegion >= RESIDUAL_REGION || m.residual >= RESIDUAL_TOTAL
}
