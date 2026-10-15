/** A take with no measured duration still needs width, or nothing inside it is reachable. */
const MIN_SPAN_MS = 1000;
/** Spans laid end to end in createdAt order. end - start = max(durationMs, 1000). */
export function partSpans(recordings) {
    const spans = [];
    let start = 0;
    for (const rec of [...recordings].sort((a, b) => a.createdAt - b.createdAt)) {
        const end = start + Math.max(rec.meta.durationMs, MIN_SPAN_MS);
        spans.push({ rec, start, end });
        start = end;
    }
    return spans;
}
export function totalMs(spans) {
    return spans[spans.length - 1]?.end ?? 0;
}
function startOf(rec, spans) {
    return spans.find((s) => s.rec.id === rec.id)?.start ?? 0;
}
/** tl ?? span.start + t */
export function linePos(rec, seg, spans) {
    return seg.tl ?? startOf(rec, spans) + seg.t;
}
/** tl ?? span.start + t */
export function framePos(rec, frame, spans) {
    return frame.tl ?? startOf(rec, spans) + frame.t;
}
