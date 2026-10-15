import { toJpeg } from './media.js';
import { GRID_PER_SHEET } from './types.js';
/**
 * Contact sheets. A model reading consecutive frames side by side in one image
 * follows motion and progression far better than the same frames one at a
 * time, at a fraction of the tokens, which is why the report offers them.
 * Batching is nine at a time in frame order, and it has to match `report.ts`'s
 * frame→sheet map exactly.
 *
 * Sized to be read, not glanced at. The first version drew 480 px tiles into a
 * 1440 px sheet: cheap, and not one word of UI text survived it. A model like
 * Opus 5.5 takes images up to 2576 px on the long edge, and Claude Code shows
 * up to 2000 px wide, so sheets default to 2000 px: ~660 px tiles, where
 * headings, banners, buttons and the URL bar all read. Each tile carries its
 * frame number, its time and, for a state that didn't last, how long it was up;
 * the region that changed since the previous frame is outlined in magenta, a
 * colour UIs almost never use. The frames themselves are never drawn on.
 */
/** Default sheet width. Claude Code's image display limit; pass 2576 for API consumers. */
export const SHEET_WIDTH = 2000;
/** No sheet edge may exceed this (Opus 5.5's input limit). */
const MAX_EDGE = 2576;
const GUTTER = 6;
const LABEL_H = 30;
const LABEL_FONT = '600 19px ui-monospace, Menlo, Consolas, monospace';
const OUTLINE = '#ff2bd6';
const OUTLINE_W = 4;
/** Padding around a change box, as a fraction of the tile, so the outline doesn't sit on the change itself. */
const OUTLINE_PAD = 0.012;
const GRID_QUALITY = 0.85;
/** Columns for a batch: three for landscape and square frames, five for portrait (phone) recordings. */
function columnsFor(aspect) {
    return aspect < 0.8 ? 5 : 3;
}
/** Contact sheets of consecutive keyframes, nine per sheet. */
export async function makeGrids(frames, opts = {}) {
    if (!frames.length)
        return [];
    const sheets = [];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return [];
    for (let start = 0; start < frames.length; start += GRID_PER_SHEET) {
        const batch = frames.slice(start, start + GRID_PER_SHEET);
        const bitmaps = await Promise.all(batch.map((f) => createImageBitmap(f.blob)));
        try {
            // One tile shape per sheet, from its first frame, so the grid stays a grid.
            const first = bitmaps[0];
            if (!first)
                continue;
            const aspect = first.width / first.height;
            const cols = Math.min(columnsFor(aspect), batch.length);
            const rows = Math.ceil(batch.length / cols);
            let width = Math.min(opts.width ?? SHEET_WIDTH, MAX_EDGE);
            let tileW = Math.floor((width - GUTTER * (cols + 1)) / cols);
            let tileH = Math.round(tileW / aspect);
            let height = rows * (tileH + LABEL_H) + GUTTER * (rows + 1);
            if (height > MAX_EDGE) {
                // Tall portrait batches: shrink the tiles until the sheet fits.
                const scale = (MAX_EDGE - GUTTER * (rows + 1) - rows * LABEL_H) / (rows * tileH);
                tileH = Math.floor(tileH * scale);
                tileW = Math.round(tileH * aspect);
                width = cols * tileW + GUTTER * (cols + 1);
                height = rows * (tileH + LABEL_H) + GUTTER * (rows + 1);
            }
            canvas.width = width;
            canvas.height = height;
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, width, height);
            ctx.imageSmoothingQuality = 'high';
            ctx.font = LABEL_FONT;
            ctx.textBaseline = 'middle';
            bitmaps.forEach((bitmap, i) => {
                const frame = batch[i];
                if (!frame)
                    return;
                const x = GUTTER + (i % cols) * (tileW + GUTTER);
                const y = GUTTER + Math.floor(i / cols) * (tileH + LABEL_H + GUTTER);
                ctx.fillStyle = '#fff';
                ctx.fillText(frame.label, x + 4, y + LABEL_H / 2);
                const ty = y + LABEL_H;
                ctx.drawImage(bitmap, x, ty, tileW, tileH);
                if (frame.change)
                    outline(ctx, frame.change, x, ty, tileW, tileH);
            });
            sheets.push(await toJpeg(canvas, GRID_QUALITY));
        }
        finally {
            bitmaps.forEach((b) => b.close());
        }
    }
    return sheets;
}
function outline(ctx, box, x, y, w, h) {
    const x0 = Math.max(0, box.x - OUTLINE_PAD) * w + x;
    const y0 = Math.max(0, box.y - OUTLINE_PAD) * h + y;
    const x1 = Math.min(1, box.x + box.w + OUTLINE_PAD) * w + x;
    const y1 = Math.min(1, box.y + box.h + OUTLINE_PAD) * h + y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = OUTLINE_W;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
}
