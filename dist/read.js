import { contentTypeFor } from './container.js';
import { FORMAT_1 } from './types.js';
const FRAME_REASONS = new Set([
    'start',
    'change',
    'click',
    'nav',
    'beat',
    'narration',
    'end',
]);
const EVENT_LEVELS = new Set(['error', 'warn', 'network']);
const isReason = (v) => v !== undefined && FRAME_REASONS.has(v);
const isLevel = (v) => v !== undefined && EVENT_LEVELS.has(v);
/** The default engine's own id. The report names it itself, so it never prints the bare id. */
const WEB_SPEECH = 'webspeech';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v) => (typeof v === 'string' ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const arr = (v) => (Array.isArray(v) ? v : []);
/** "4:32" or "1:04:32" → ms. The format writes whole seconds. */
function parseStamp(v) {
    if (typeof v !== 'string' || !/^\d+(:\d{1,2}){1,2}$/.test(v))
        return undefined;
    return v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) * 1000;
}
function parseDate(v) {
    if (typeof v !== 'string')
        return undefined;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
}
function readBox(v) {
    if (!isObj(v))
        return undefined;
    const x = num(v.x);
    const y = num(v.y);
    const w = num(v.w);
    const h = num(v.h);
    if (x === undefined || y === undefined || w === undefined || h === undefined)
        return undefined;
    return { x, y, w, h };
}
function readPointer(v) {
    if (!isObj(v))
        return undefined;
    const p = {};
    const nx = num(v.nx);
    const ny = num(v.ny);
    const selector = str(v.selector);
    const text = str(v.text);
    if (nx !== undefined)
        p.nx = nx;
    if (ny !== undefined)
        p.ny = ny;
    if (selector)
        p.selector = selector;
    if (text)
        p.text = text;
    return Object.keys(p).length ? p : undefined;
}
function readFrame(v, i, dir) {
    if (!isObj(v))
        return undefined;
    const file = str(v.file);
    const t = num(v.tMs) ?? parseStamp(v.at);
    if (!file || t === undefined)
        return undefined;
    const reason = str(v.reason);
    const frame = {
        index: num(v.index) ?? i + 1,
        t,
        // Some writers put the take's folder into `file`; the shape keeps it take-relative.
        file: file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file,
        reason: isReason(reason) ? reason : 'change',
    };
    const dist = num(v.dist);
    const change = readBox(v.change);
    const held = num(v.held);
    const transient = bool(v.transient);
    const pointer = readPointer(v.pointer);
    const tl = num(v.tlMs);
    const detail = readDetail(v.detail);
    const seen = arr(v.seenMs)
        .map((s) => (Array.isArray(s) ? [num(s[0]), num(s[1])] : []))
        .filter((s) => s[0] !== undefined && s[1] !== undefined && s[1] > s[0]);
    if (dist !== undefined)
        frame.dist = dist;
    if (change)
        frame.change = change;
    if (held !== undefined)
        frame.held = held;
    if (transient)
        frame.transient = true;
    if (pointer)
        frame.pointer = pointer;
    if (tl !== undefined)
        frame.tl = tl;
    if (detail)
        frame.detail = detail;
    if (seen.length)
        frame.seen = seen;
    return frame;
}
function readDetail(v) {
    if (!isObj(v))
        return undefined;
    const of = num(v.of);
    const box = readBox(v.box);
    return of !== undefined && box ? { of, box } : undefined;
}
function readLine(v) {
    if (!isObj(v))
        return undefined;
    const text = str(v.text)?.trim();
    const t = num(v.tMs) ?? parseStamp(v.at);
    if (!text || t === undefined)
        return undefined;
    const seg = { t, text };
    const end = num(v.endMs);
    const speaker = num(v.speaker);
    const tl = num(v.tlMs);
    if (end !== undefined && end > t)
        seg.d = end - t;
    if (speaker !== undefined && Number.isInteger(speaker) && speaker >= 1)
        seg.speaker = speaker;
    if (tl !== undefined)
        seg.tl = tl;
    return seg;
}
function readEvent(v, startedAt) {
    if (!isObj(v))
        return undefined;
    const level = str(v.level);
    const message = str(v.message);
    const at = num(v.tMs) ?? parseStamp(v.at);
    if (!isLevel(level) || message === undefined || at === undefined)
        return undefined;
    const ev = { level, message, ts: startedAt + at };
    const detail = str(v.detail);
    if (detail)
        ev.detail = detail;
    return ev;
}
/**
 * Parse one take's recording.json (its text, or the value already parsed).
 * Null when it isn't JSON or carries no `recording` object.
 */
export function readRecordingJson(input) {
    let root = input;
    if (typeof input === 'string') {
        try {
            root = JSON.parse(input);
        }
        catch {
            return null;
        }
    }
    if (!isObj(root) || !isObj(root.recording))
        return null;
    const rec = root.recording;
    const ses = isObj(root.session) ? root.session : {};
    const dirMatch = /^rec-(\d+)$/.exec(str(rec.dir) ?? '');
    const part = num(rec.part) ?? (dirMatch ? Number(dirMatch[1]) : 1);
    const dir = str(rec.dir) ?? `rec-${String(part).padStart(2, '0')}`;
    const createdAt = parseDate(ses.createdAt);
    const startedAt = parseDate(rec.startedAt) ?? createdAt ?? 0;
    const slug = str(ses.slug) ?? '';
    const videoFile = str(rec.video) ?? '';
    const transcript = arr(rec.transcript)
        .map(readLine)
        .filter((s) => s !== undefined)
        .sort((a, b) => a.t - b.t);
    const transcriber = str(rec.transcriber);
    const sampling = isObj(rec.sampling) ? rec.sampling : undefined;
    const engine = str(sampling?.engine);
    const stepMs = num(sampling?.stepMs);
    const droppedEvents = num(rec.droppedEvents);
    const transcriberLabel = str(rec.transcriberLabel);
    const eventScope = str(rec.eventScope);
    const crop = readBox(rec.crop);
    const recording = {
        id: `${slug || 'take'}:${part}`,
        sessionId: slug,
        index: part,
        createdAt: startedAt,
        state: 'done',
        ...(bool(rec.interrupted) ? { interrupted: true } : {}),
        mime: videoFile ? contentTypeFor(videoFile) : '',
        chunks: 0,
        meta: {
            startedAt,
            durationMs: Math.max(0, num(rec.durationMs) ?? 0),
            sampled: num(rec.sampled) ?? 0,
            frames: arr(rec.frames)
                .map((f, i) => readFrame(f, i, dir))
                .filter((f) => f !== undefined),
            transcript,
            // Words only: a silent take's engine is noise, and the default engine names itself.
            ...(transcript.length && transcriber && transcriber !== WEB_SPEECH ? { transcriber } : {}),
            ...(transcriberLabel ? { transcriberLabel } : {}),
            ...(engine !== undefined && stepMs !== undefined ? { sampling: { engine, stepMs } } : {}),
            ...(crop ? { crop } : {}),
            ...(bool(rec.polished) ? { polished: true } : {}),
            ...(bool(rec.transcriptReviewed) ? { reviewed: true } : {}),
            events: arr(rec.events)
                .map((e) => readEvent(e, startedAt))
                .filter((e) => e !== undefined),
            ...(eventScope ? { eventScope } : {}),
            ...(droppedEvents ? { droppedEvents } : {}),
            videoFile,
            format: str(root.format) ?? FORMAT_1,
        },
    };
    const session = {
        id: slug,
        name: str(ses.name) ?? '',
        slug,
        createdAt: createdAt ?? startedAt,
        updatedAt: createdAt ?? startedAt,
        origin: str(ses.origin) ?? '',
        recCount: 1,
    };
    const url = str(ses.url);
    return { session, recording, ...(url ? { url } : {}) };
}
