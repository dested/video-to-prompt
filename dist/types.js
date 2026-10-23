/**
 * The pipeline's vocabulary. Two halves:
 *
 * 1. The public surface a caller codes against — stages, progress, clip inputs,
 *    the files a distill run produces.
 * 2. The recording shapes — the on-disk format of a distilled walkthrough. These
 *    are frozen by their readers: `report.md`, `recording.json`, the MANIFEST
 *    and anything downstream that parses them all read exactly these fields.
 */
// ── the recording shapes (the format; change with care) ────────────────────
/**
 * The format this library writes, stamped into recording.json and the
 * MANIFEST. Format 1 (unstamped) is everything before it. Format 2 adds frame
 * `change`/`held`/`transient`, the `narration` and `end` reasons, the
 * transcriber's own label and the sampling engine, and changes the meaning of
 * `dist` (see RecordingFrame). Readers of format 1 keep working: nothing was
 * removed or renamed.
 */
export const FORMAT = 'video-to-prompt/2';
/** What `readRecordingJson` calls a file with no `format` stamp: everything written before format 2. */
export const FORMAT_1 = 'video-to-prompt/1';
/** Contact sheet shape. The sheet builder and the report that cites the sheets must agree. */
export const GRID_COLS = 3;
export const GRID_ROWS = 3;
export const GRID_PER_SHEET = GRID_COLS * GRID_ROWS;
