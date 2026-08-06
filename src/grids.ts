import { toJpeg } from './media'
import { GRID_COLS as COLS, GRID_PER_SHEET, GRID_ROWS as ROWS } from './types'

/**
 * Contact sheets. A model reading consecutive frames side by side in one image
 * follows motion and progression far better than the same frames seen one at a
 * time, at an eighth of the tokens — which is why the report leads with them.
 * Batching is nine at a time in frame order, and it has to match `report.ts`'s
 * frame→sheet map exactly.
 */

const CELL_W = 480
const LABEL_H = 22
const GRID_QUALITY = 0.85

export interface GridFrame {
  blob: Blob
  label: string
}

/** 3×3 contact sheets of consecutive keyframes. */
export async function makeGrids(frames: GridFrame[]): Promise<Blob[]> {
  if (!frames.length) return []

  const per = GRID_PER_SHEET
  const sheets: Blob[] = []
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  for (let start = 0; start < frames.length; start += per) {
    const batch = frames.slice(start, start + per)
    const bitmaps = await Promise.all(batch.map((f) => createImageBitmap(f.blob)))
    // Cell height comes from the batch's first frame — one aspect ratio per
    // sheet, so the grid stays a grid.
    const first = bitmaps[0]
    const ch = Math.round((first.height * CELL_W) / first.width) + LABEL_H

    canvas.width = COLS * CELL_W
    canvas.height = ROWS * ch
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace'
    ctx.textBaseline = 'top'

    for (let i = 0; i < bitmaps.length; i++) {
      const x = (i % COLS) * CELL_W
      const y = Math.floor(i / COLS) * ch
      ctx.drawImage(bitmaps[i], x, y + LABEL_H, CELL_W, ch - LABEL_H)
      ctx.fillStyle = 'white'
      ctx.fillText(batch[i].label, x + 6, y + 4)
    }
    bitmaps.forEach((b) => b.close())

    sheets.push(await toJpeg(canvas, GRID_QUALITY))
  }

  return sheets
}
