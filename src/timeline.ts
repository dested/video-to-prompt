import type { Recording, RecordingFrame, TranscriptSegment } from './types.js'

/**
 * A walkthrough is one clock: takes are laid end to end in the order they were
 * recorded, no gaps, and every position in the report comes from here so
 * nothing has to do take arithmetic.
 */

/** A take's stretch of the unified axis. */
export interface PartSpan {
  rec: Recording
  start: number
  end: number
}

/** A take with no measured duration still needs width, or nothing inside it is reachable. */
const MIN_SPAN_MS = 1000

/** Spans laid end to end in createdAt order. end - start = max(durationMs, 1000). */
export function partSpans(recordings: Recording[]): PartSpan[] {
  const spans: PartSpan[] = []
  let start = 0
  for (const rec of [...recordings].sort((a, b) => a.createdAt - b.createdAt)) {
    const end = start + Math.max(rec.meta.durationMs, MIN_SPAN_MS)
    spans.push({ rec, start, end })
    start = end
  }
  return spans
}

export function totalMs(spans: PartSpan[]): number {
  return spans[spans.length - 1]?.end ?? 0
}

function startOf(rec: Recording, spans: PartSpan[]): number {
  return spans.find((s) => s.rec.id === rec.id)?.start ?? 0
}

/** tl ?? span.start + t */
export function linePos(rec: Recording, seg: TranscriptSegment, spans: PartSpan[]): number {
  return seg.tl ?? startOf(rec, spans) + seg.t
}

/** tl ?? span.start + t */
export function framePos(rec: Recording, frame: RecordingFrame, spans: PartSpan[]): number {
  return frame.tl ?? startOf(rec, spans) + frame.t
}
