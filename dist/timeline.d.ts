import type { Recording, RecordingFrame, TranscriptSegment } from './types.js';
/**
 * A walkthrough is one clock: takes are laid end to end in the order they were
 * recorded, no gaps, and every position in the report comes from here so
 * nothing has to do take arithmetic.
 */
/** A take's stretch of the unified axis. */
export interface PartSpan {
    rec: Recording;
    start: number;
    end: number;
}
/** Spans laid end to end in createdAt order. end - start = max(durationMs, 1000). */
export declare function partSpans(recordings: Recording[]): PartSpan[];
export declare function totalMs(spans: PartSpan[]): number;
/** tl ?? span.start + t */
export declare function linePos(rec: Recording, seg: TranscriptSegment, spans: PartSpan[]): number;
/** tl ?? span.start + t */
export declare function framePos(rec: Recording, frame: RecordingFrame, spans: PartSpan[]): number;
