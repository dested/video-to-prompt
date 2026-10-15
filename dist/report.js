import { dateTime, hhmm, mmss, recDirName } from './format.js';
import { framePos, linePos, partSpans, totalMs } from './timeline.js';
import { FORMAT, FORMAT_1, GRID_PER_SHEET } from './types.js';
function resolve(opts) {
    const by = opts.narrationBy ?? 'the recorder';
    const words = opts.narration === 'log'
        ? {
            line: 'logged action',
            lines: 'logged actions',
            intro: opts.intro ??
                `A recording of the app while ${by} drove it, with each of ${by}'s commands logged on the same clock.`,
            silent: opts.intro ?? `A recording of the app while ${by} drove it.`,
            trust: () => `The text lines are ${by}'s action log: what each command did, written by ${by} itself. They are exact, not transcribed.`,
            stamp: 'when the command finished',
            window: 'the second time bounds where its effect should show',
        }
        : {
            line: 'spoken line',
            lines: 'spoken lines',
            intro: opts.intro ??
                'A person recorded this while using the app, talking through what they saw: a bug, review notes, or a change they want.',
            silent: opts.intro ??
                'A person recorded this while using the app: a bug, review notes, or a change they want.',
            trust: speechTrust,
            stamp: 'where the speaker started',
            window: 'the second time is where they stopped',
        };
    return {
        url: opts.url,
        urlHint: opts.urlHint,
        source: opts.source ?? 'video-to-prompt',
        pathsHint: opts.pathsHint ?? 'the paths inside the folder if you downloaded it',
        polishedBy: opts.polishedBy ?? 'an LLM',
        videoPath: opts.videoPath ?? ((part, file) => `${recDirName(part)}/${file}`),
        words,
        cuts: (opts.cuts ?? []).filter((c) => c.toMs > c.fromMs),
        captions: opts.captions ?? {},
    };
}
/** The report needs a truncate and owns it — format.ts is frozen and has none. */
function truncate(value, max) {
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
/** How far around a line we consider "the frames that line is about". */
const SPEECH_LEAD_MS = 2000;
const SPEECH_TAIL_MS = 2500;
/** Fallback line length when the transcriber gave no end time. */
const WORD_MS = 380;
const MIN_LINE_MS = 1200;
/** A silence this long closes a section; whatever is said next opens the one after. */
const CHAPTER_GAP_MS = 15000;
/** Frames in the "start here" list. */
const START_MIN = 3;
const START_MAX = 6;
/** A captured error this close to a frame is evidence for it, and is named beside it in "start here". */
const ERROR_NEAR_MS = 3000;
/** A line repeating the one before word for word, this soon after it ends, is a transcriber's echo. */
const ECHO_MS = 5000;
/** A run of frames with nothing said between them collapses past this many. */
const RUN_MAX = 8;
/** Words that mark a line as a complaint: its frames are likelier to be the evidence. */
const CONCERN = /\b(error|errors|fail|fails|failed|failing|failure|wrong|broken|break|breaks|bug|bugs|crash|crashes|should|shouldn't|supposed|expected|instead|missing|doesn't|didn't|isn't|wasn't|won't|can't|cannot|never|nothing|weird|stuck|disappears?|gone|but|still|even|already|again)\b/i;
function spokenMs(seg) {
    return seg.d ?? Math.max(MIN_LINE_MS, seg.text.split(/\s+/).length * WORD_MS);
}
/** The distinct speaker ranks present across these segments. Two or more = worth labeling. */
function speakerSet(segs) {
    const set = new Set();
    for (const seg of segs)
        if (seg.speaker !== undefined)
            set.add(seg.speaker);
    return set;
}
/**
 * A line's text as it renders — prefixed `S1: ` etc only when there are ≥2
 * voices to tell apart. Render-time only; `seg.text` itself is never touched.
 */
function labeledText(seg, label) {
    return label && seg.speaker !== undefined ? `S${seg.speaker}: ${seg.text}` : seg.text;
}
function spokenWindows(rec) {
    const limit = rec.durationMs > 0 ? rec.durationMs : Infinity;
    return rec.transcript.map((seg) => {
        const end = Math.min(limit, seg.t + spokenMs(seg));
        return {
            seg,
            end: Math.max(seg.t, end),
            from: Math.max(0, seg.t - SPEECH_LEAD_MS),
            to: Math.min(limit, end + SPEECH_TAIL_MS),
        };
    });
}
function axisLines(recordings, spans) {
    const out = [];
    const total = totalMs(spans);
    for (const rec of recordings) {
        const span = spans.find((s) => s.rec.id === rec.id);
        let prev;
        for (const seg of [...rec.meta.transcript].sort((a, b) => a.t - b.t)) {
            // Whisper repeats the previous chunk's last line at a chunk boundary. Same
            // words, starting moments after the first copy ended: say it once.
            const text = seg.text.replace(/\s+/g, ' ').trim().toLowerCase();
            const echo = prev !== undefined && text === prev.text && seg.t - prev.end <= ECHO_MS;
            prev = { text, end: seg.t + spokenMs(seg) };
            if (echo)
                continue;
            const pos = linePos(rec, seg, spans);
            let end = Math.min(total, pos + spokenMs(seg));
            let from = Math.max(0, pos - SPEECH_LEAD_MS);
            let to = end + SPEECH_TAIL_MS;
            // Takes abut with no gap, so an unmoved line's window would otherwise reach
            // across the seam and claim frames from a sitting recorded hours later.
            if (seg.tl === undefined && span) {
                end = Math.min(end, span.end);
                from = Math.max(from, span.start);
                to = Math.min(to, span.end);
            }
            out.push({
                rec,
                seg,
                pos,
                end: Math.max(pos, end),
                from,
                to,
                concern: CONCERN.test(seg.text),
            });
        }
    }
    return out.sort((a, b) => a.pos - b.pos);
}
function axisShots(recordings, spans) {
    const out = [];
    for (const rec of recordings) {
        const prefix = `${recDirName(rec.index)}/`;
        const sheets = sheetOf(rec.meta);
        const frames = rec.meta.frames;
        frames.forEach((frame, i) => {
            out.push({
                rec,
                frame,
                prefix,
                path: `${prefix}${frame.file}`,
                pos: framePos(rec, frame, spans),
                sheet: sheets.get(frame.index),
                key: `${rec.id}:${frame.index}`,
                last: i === frames.length - 1,
            });
        });
    }
    return out.sort((a, b) => a.pos - b.pos);
}
function axisEvents(recordings, spans) {
    const out = [];
    for (const rec of recordings) {
        // Event timestamps are absolute; the axis is not. A stamp from after the
        // recorder stopped must not drift into the next take, so pin it to this one.
        const span = spans.find((s) => s.rec.id === rec.id);
        const start = span?.start ?? 0;
        const end = span?.end ?? Infinity;
        for (const ev of rec.meta.events) {
            out.push({ pos: Math.min(end, start + Math.max(0, ev.ts - rec.meta.startedAt)), ev });
        }
    }
    return out.sort((a, b) => a.pos - b.pos);
}
function axis(recordings, cuts) {
    const spans = partSpans(recordings);
    const takes = spans.map((s) => s.rec);
    const kept = (pos) => !cuts.some((c) => pos >= c.fromMs && pos < c.toMs);
    return {
        spans,
        takes,
        shots: axisShots(takes, spans).filter((s) => kept(s.pos)),
        lines: axisLines(takes, spans).filter((l) => kept(l.pos)),
        traces: axisEvents(takes, spans).filter((t) => kept(t.pos)),
    };
}
/** frame index → the contact sheet it appears on. Batching must match `makeGrids`. */
function sheetOf(rec) {
    const map = new Map();
    rec.frames.forEach((f, i) => map.set(f.index, Math.floor(i / GRID_PER_SHEET) + 1));
    return map;
}
/**
 * Paths inside a take are stored take-relative; the report reads from the
 * walkthrough root. Exported because a consumer's uploader has to send this
 * exact path — the citation and the upload are built by one function so they
 * cannot drift.
 */
export function sheetFile(n, prefix = '') {
    return `${prefix}grids/grid_${String(n).padStart(2, '0')}.jpg`;
}
/**
 * Does this line point at this frame? Position alone is not enough: takes abut, so
 * a window ending exactly on the seam would reach the next take's first frame.
 */
function claims(line, shot) {
    if (shot.pos < line.from || shot.pos > line.to)
        return false;
    return line.seg.tl !== undefined || shot.frame.tl !== undefined || shot.rec.id === line.rec.id;
}
// ── what a frame shows, in words ───────────────────────────────────────────
/** "top-right", "across the bottom", "center": where on screen a box sits. */
export function whereOnScreen(box) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center';
    const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle';
    if (box.w > 0.6 && box.h > 0.6)
        return 'most of the screen';
    if (box.w > 0.6)
        return `across the ${row}`;
    if (box.h > 0.6)
        return `down the ${col}`;
    if (row === 'middle' && col === 'center')
        return 'center';
    if (row === 'middle')
        return col;
    if (col === 'center')
        return row;
    return `${row}-${col}`;
}
function seconds(ms) {
    return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}
/** One phrase for what this frame is: why it exists, what changed and where, whether it lasted. */
/** Format 2 writes a change box whenever part of the screen changed; format 1 never wrote one. */
function hasChangeBoxes(meta) {
    return meta.format !== FORMAT_1;
}
function describe(shot) {
    const f = shot.frame;
    const parts = [];
    if (f.reason === 'start')
        parts.push('first frame');
    else if (f.change) {
        const small = f.change.w * f.change.h < 0.02 ? ' (small)' : '';
        parts.push(`changed ${whereOnScreen(f.change)}${small}`);
    }
    else if (f.reason === 'narration')
        parts.push('on screen during the line below');
    else if (f.reason === 'beat')
        parts.push('periodic frame, slow drift');
    else if (f.reason === 'click')
        parts.push('click');
    else if (f.reason === 'nav')
        parts.push('navigation');
    else if (f.dist !== undefined && f.dist > 0 && hasChangeBoxes(shot.rec.meta))
        parts.push('most of the screen changed');
    else
        parts.push('changed');
    if (f.transient && f.held !== undefined)
        parts.push(`gone after ${seconds(f.held)}`);
    if (f.reason === 'end' || (shot.last && f.reason !== 'start'))
        parts.push('final state');
    return parts.join(', ');
}
// ── ranking: which frames carry the evidence ───────────────────────────────
/** What a frame is worth on its own: how it came to be and what it shows, before any narration. */
function intrinsic(shot, traces) {
    const f = shot.frame;
    let score = 0;
    if (f.transient)
        score += 2;
    if (f.reason === 'end' || shot.last)
        score += 2.5;
    if (f.change)
        score += 1.5;
    else if ((f.dist ?? 0) > 0 && f.reason !== 'start')
        score += 0.5;
    if (f.reason === 'narration')
        score += 1;
    if (f.reason === 'click' || f.reason === 'nav')
        score += 1;
    if (f.pointer?.selector)
        score += 0.5;
    if (errorNear(shot, traces))
        score += 2;
    return score;
}
/** The captured error closest to a frame, within ERROR_NEAR_MS of it. */
function errorNear(shot, traces) {
    return nearestError(shot.pos, traces);
}
/** A frame's worth for the "start here" list: what it is, plus every line that points at it. */
function shotScore(shot, lines, traces) {
    let score = intrinsic(shot, traces);
    for (const line of lines) {
        if (!claims(line, shot))
            continue;
        const during = shot.pos >= line.pos - 250 && shot.pos <= line.end;
        score += during ? 2 : 1;
        if (line.concern)
            score += during ? 2 : 1;
    }
    return score;
}
/**
 * The frame that best shows one line. What was on screen while it was said
 * comes first: the frame showing when it began, anything that appeared while
 * it was spoken, and what appeared just before (people narrate what just
 * happened). Frames from after it ended count only when there is nothing else.
 */
function bestFor(line, shots, worth) {
    const sameTake = (s) => line.seg.tl !== undefined || s.frame.tl !== undefined || s.rec.id === line.rec.id;
    const showing = onScreen(line.pos, shots.filter(sameTake));
    let best;
    let bestScore = -Infinity;
    for (const shot of shots) {
        if (!sameTake(shot))
            continue;
        let bonus;
        if (shot === showing)
            bonus = 1.5;
        else if (shot.pos > line.pos && shot.pos <= line.end)
            bonus = 3;
        else if (shot.pos >= line.from && shot.pos <= line.pos) {
            // Just before it began. A transient already gone by then is a weaker bet.
            const f = shot.frame;
            const gone = f.transient && f.held !== undefined && shot.pos + f.held <= line.pos;
            bonus = gone ? -1 : 1;
        }
        else
            continue;
        const s = (worth.get(shot.key) ?? 0) + bonus;
        if (s > bestScore) {
            best = shot;
            bestScore = s;
        }
    }
    if (best)
        return best;
    return shots.find((s) => sameTake(s) && claims(line, s));
}
/** The frame showing at `pos`: the latest before it, passing over transients that had already gone. */
function onScreen(pos, shots) {
    let found;
    for (const shot of shots) {
        if (shot.pos > pos)
            break;
        const gone = shot.frame.transient && shot.frame.held !== undefined && shot.pos + shot.frame.held <= pos;
        if (!gone)
            found = shot;
    }
    return found;
}
/**
 * The frames that carry the most evidence, in time order: 3–6 of them, more
 * for longer walkthroughs. The report's "Start here" list; exported so a host
 * that hands an agent images directly (an MCP tool) sends the same ones.
 */
export function rankFrames(recordings, options = {}) {
    const { shots, lines, traces } = axis(recordings, options.cuts ?? []);
    return startHere(shots, lines, traces).map(({ shot, score, line }) => ({
        path: shot.path,
        pos: shot.pos,
        part: shot.rec.index,
        frame: shot.frame,
        score,
        what: describe(shot),
        ...(line ? { line: line.seg.text } : {}),
        ...withError(errorNear(shot, traces)),
    }));
}
function withError(trace) {
    return trace ? { error: trace.ev.message } : {};
}
/** How far a stamp may sit from the line it was copied off: stamps are whole seconds, rounded or floored. */
const STAMP_SLACK_MS = 1000;
/** Past this, the nearest line is about something else. */
const LINE_NEAR_MS = 5000;
/**
 * The evidence for a moment on the walkthrough's axis, such as a point a
 * summary pinned to "1:42": the spoken line there (or nearest), the frame that
 * best shows that line, and a captured error within 3 s of the frame. With no
 * line nearby, the frame on screen at that moment.
 */
export function evidenceAt(recordings, posMs, options = {}) {
    const { shots, lines, traces } = axis(recordings, options.cuts ?? []);
    const worth = new Map(shots.map((s) => [s.key, intrinsic(s, traces)]));
    const line = lineAt(lines, posMs);
    const shot = line
        ? bestFor(line, shots, worth)
        : (onScreen(posMs, shots) ?? shots.find((s) => s.pos >= posMs && s.pos - posMs < ERROR_NEAR_MS));
    const err = shot ? errorNear(shot, traces) : nearestError(posMs, traces);
    return {
        ...(line
            ? {
                line: {
                    text: line.seg.text,
                    pos: line.pos,
                    end: line.end,
                    ...(line.seg.speaker === undefined ? {} : { speaker: line.seg.speaker }),
                },
            }
            : {}),
        ...(shot ? { frame: { path: shot.path, pos: shot.pos, what: describe(shot) } } : {}),
        ...(err ? { error: { message: err.ev.message, pos: err.pos } } : {}),
    };
}
/** The line being said at `pos` (closest start wins), else the nearest one within LINE_NEAR_MS. */
function lineAt(lines, pos) {
    let inside;
    let near;
    for (const line of lines) {
        const gap = Math.abs(line.pos - pos);
        if (pos >= line.pos - STAMP_SLACK_MS && pos <= line.end + STAMP_SLACK_MS / 2) {
            if (!inside || gap < Math.abs(inside.pos - pos))
                inside = line;
        }
        else if (gap <= LINE_NEAR_MS && (!near || gap < Math.abs(near.pos - pos))) {
            near = line;
        }
    }
    return inside ?? near;
}
function nearestError(pos, traces) {
    let best;
    for (const t of traces) {
        if (t.ev.level !== 'error')
            continue;
        const gap = Math.abs(t.pos - pos);
        if (gap < ERROR_NEAR_MS && (!best || gap < Math.abs(best.pos - pos)))
            best = t;
    }
    return best;
}
/**
 * Which frames to open first. Every complaint gets its evidence before
 * anything else does: each line that sounds like one contributes the frame
 * that best shows it, strongest first. Then the final state, if it changed.
 * Then the best of what's left by score.
 */
function startHere(shots, lines, traces) {
    if (!shots.length)
        return [];
    const scores = new Map(shots.map((s) => [s.key, shotScore(s, lines, traces)]));
    const worth = new Map(shots.map((s) => [s.key, intrinsic(s, traces)]));
    const want = Math.min(shots.length, Math.max(START_MIN, Math.min(START_MAX, Math.ceil(shots.length / 3))));
    const picked = new Map();
    const add = (shot, line) => {
        if (!shot || picked.size >= want)
            return;
        const held = picked.get(shot.key);
        if (held) {
            if (line && !held.line)
                held.line = line;
            return;
        }
        picked.set(shot.key, { shot, line });
    };
    const evidence = lines
        .map((line) => ({ line, shot: bestFor(line, shots, worth) }))
        .filter((e) => e.shot !== undefined);
    const score = (e) => scores.get(e.shot.key) ?? 0;
    for (const e of evidence.filter((e) => e.line.concern).sort((a, b) => score(b) - score(a))) {
        add(e.shot, e.line);
    }
    const final = shots[shots.length - 1];
    if (final && final.frame.reason !== 'start')
        add(final, evidence.find((e) => e.shot === final)?.line);
    for (const shot of [...shots].sort((a, b) => (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0) || a.pos - b.pos)) {
        add(shot, evidence.find((e) => e.shot === shot)?.line);
    }
    return [...picked.values()]
        .sort((a, b) => a.shot.pos - b.shot.pos)
        .map(({ shot, line }) => ({ shot, score: scores.get(shot.key) ?? 0, line }));
}
// ── the parts of the report ────────────────────────────────────────────────
/** How much to trust transcribed words — the ASR error that sent an agent to the wrong file. */
function speechTrust(takes, opts) {
    const spoken = takes.filter((r) => r.meta.transcript.length);
    if (!spoken.length)
        return '';
    if (spoken.every((r) => r.meta.reviewed)) {
        return 'The speaker read the transcript back and corrected it; the wording is theirs.';
    }
    const engines = [...new Set(spoken.map((r) => engineName(r.meta, opts)))].join(' and ');
    const checked = spoken.some((r) => r.meta.reviewed)
        ? 'The speaker read back only some of them'
        : "The speaker didn't read them back";
    return `The words were transcribed by ${engines}. ${checked}, so names, units and small numbers are the likeliest to be wrong.`;
}
function introParagraph(takes, spans, opts, labelSpeakers) {
    const hasLines = takes.some((r) => r.meta.transcript.length);
    const sentences = [hasLines || !takes.length ? opts.words.intro : opts.words.silent];
    if (hasLines) {
        sentences.push(opts.words.lines === 'spoken lines'
            ? 'The narration says what they meant; the frames show what was on screen. When the two disagree, trust the frames.'
            : 'The log says what was done; the frames show what the app did. Where they disagree, trust the frames.');
        const trust = opts.words.trust(takes, opts);
        if (trust)
            sentences.push(trust);
        if (labelSpeakers)
            sentences.push('More than one voice was heard: S1 is the one who spoke most.');
    }
    else if (takes.length) {
        sentences.push(`No ${opts.words.lines} came with it; the frames are all there is.`);
    }
    if (spans.length > 1) {
        sentences.push(`It was recorded in ${spans.length} sittings, laid end to end on one clock.`);
    }
    return [sentences.join(' '), ''];
}
function orientation(takes, shots, opts) {
    const out = [
        `Every path is relative to this walkthrough's files (${opts.pathsHint}). Times are positions on one clock from the start; the \`mmss\` inside a frame's filename is time inside that take's own video, so the two can differ.`,
    ];
    if (takes.some((r) => r.meta.frames.some((f) => f.pointer?.nx !== undefined))) {
        out.push('An accent crosshair drawn on a frame is the mouse pointer, and `pointer` under a frame names what it was over.');
    }
    if (opts.cuts.length) {
        out.push('Stretches marked ✂ were removed after recording: nothing inside them counts, even where the video or a contact sheet still shows it.');
    }
    if (shots.some((s) => opts.captions[s.path])) {
        out.push("`shows:` is a model's one-line reading of a frame; check it against the image before relying on it.");
    }
    return [out.join(' '), ''];
}
/** Where this walkthrough lives, for an agent that arrived holding only the report text. */
function urlLines(opts) {
    if (!opts.url)
        return [];
    const hint = opts.urlHint ? ` — ${opts.urlHint}` : '';
    return [`**This walkthrough:** \`${opts.url}\`${hint}`, ''];
}
function scopeLines(recordings) {
    const scopes = recordings.map((r) => r.meta.eventScope).filter((s) => Boolean(s));
    const events = recordings.reduce((n, r) => n + r.meta.events.length, 0);
    const dropped = recordings.reduce((n, r) => n + (r.meta.droppedEvents ?? 0), 0);
    if (!scopes.length || (!events && !dropped))
        return [];
    const from = [...new Set(scopes)].map((s) => `\`${s}\``).join(', ');
    const lost = dropped ? ` ${dropped} event(s) from other tabs were dropped.` : '';
    return [
        `Console and network lines come only from ${from}, the tab in front while recording.${lost}`,
        '',
    ];
}
/** A recording reassembled from chunks — say so, never imply it is whole. */
function interruptedLines(recordings) {
    const hurt = recordings.filter((r) => r.interrupted);
    if (!hurt.length)
        return [];
    return [
        `_(interrupted — the recorder died mid-recording; ${hurt.length === 1 ? 'a stretch of' : `${hurt.length} stretches of`} the walkthrough may be missing)_`,
        '',
    ];
}
/** Every take's sheets in axis order. Batching must match `makeGrids`: meta order, nine at a time. */
function contactSheets(spans) {
    const out = [];
    for (const span of spans) {
        const prefix = `${recDirName(span.rec.index)}/`;
        const frames = span.rec.meta.frames;
        for (let n = 1; n <= Math.ceil(frames.length / GRID_PER_SHEET); n++) {
            const batch = frames.slice((n - 1) * GRID_PER_SHEET, n * GRID_PER_SHEET);
            // A moved frame can leave its sheet out of order, so bound the label rather than assume.
            const at = batch.map((f) => framePos(span.rec, f, spans));
            const firstIdx = batch[0]?.index ?? 0;
            const lastIdx = batch[batch.length - 1]?.index ?? 0;
            const take = spans.length > 1 ? `part ${span.rec.index} ` : '';
            out.push({
                file: sheetFile(n, prefix),
                from: Math.min(...at),
                to: Math.max(...at),
                frames: firstIdx === lastIdx
                    ? `${take}frame ${firstIdx}`
                    : `${take}frames ${firstIdx}–${lastIdx}`,
            });
        }
    }
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
function span(from, to) {
    return mmss(from) === mmss(to) ? mmss(from) : `${mmss(from)}–${mmss(to)}`;
}
function pointerLine(frame) {
    const p = frame.pointer;
    if (!p?.selector)
        return null;
    const text = p.text ? ` — "${truncate(p.text, 60)}"` : '';
    const drawn = p.nx === undefined ? ' (position not drawable on this capture)' : '';
    return `  pointer \`${p.selector}\`${text}${drawn}`;
}
/** Where one `###` section ends and the next opens: a silence runs long. */
function chapterBreaks(lines) {
    const breaks = [];
    let reach = lines[0]?.to ?? 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line)
            continue;
        if (line.pos - reach > CHAPTER_GAP_MS)
            breaks.push(line.from);
        reach = Math.max(reach, line.to);
    }
    return [...new Set(breaks)].sort((a, b) => a - b);
}
/** ` · shows: …` when a model captioned this frame. */
function captionOf(shot, opts) {
    const caption = opts.captions[shot.path];
    return caption ? ` · shows: ${truncate(caption, 160)}` : '';
}
/**
 * The timeline: one line per frame (what changed, where, whether it lasted),
 * each spoken line under the frame on screen when it began, naming its best
 * frame when that's a different one. Long silent runs collapse to a count.
 */
function timeline(shots, lines, traces, keep, worth, labelSpeakers, opts) {
    const entries = [
        ...opts.cuts.map((cut) => ({ pos: cut.fromMs, rank: -1, cut })),
        ...shots.map((shot) => ({ pos: shot.pos, rank: 0, shot })),
        ...lines.map((line) => ({ pos: line.pos, rank: 1, line })),
        ...traces.map((trace) => ({ pos: trace.pos, rank: 2, trace })),
    ];
    entries.sort((a, b) => a.pos - b.pos || a.rank - b.rank);
    const breaks = chapterBreaks(lines);
    const out = [];
    let chapter = 0;
    let under;
    let run = [];
    const frameLine = (shot) => {
        const star = keep.has(shot.key) ? ' ★' : '';
        out.push(`- **${mmss(shot.pos)}** \`${shot.path}\`${star} ${describe(shot)}${captionOf(shot, opts)}`);
        const pointer = pointerLine(shot.frame);
        if (pointer)
            out.push(pointer);
    };
    const flush = () => {
        if (run.length > RUN_MAX) {
            const head = run.slice(0, 3);
            const tail = run[run.length - 1];
            const middle = run.slice(3, -1);
            head.forEach(frameLine);
            const first = middle[0];
            const last = middle[middle.length - 1];
            if (first && last) {
                const sheets = [
                    ...new Set(middle.map((s) => (s.sheet ? sheetFile(s.sheet, s.prefix) : ''))),
                ]
                    .filter(Boolean)
                    .map((g) => `\`${g}\``);
                const on = sheets.length ? `, on ${sheets.join(', ')}` : '';
                out.push(`- … ${middle.length} more frames, ${span(first.pos, last.pos)}, nothing said over them${on}`);
            }
            if (tail)
                frameLine(tail);
        }
        else {
            run.forEach(frameLine);
        }
        run = [];
    };
    for (const entry of entries) {
        while (chapter < breaks.length && entry.pos >= (breaks[chapter] ?? Infinity)) {
            flush();
            const opener = lines.find((l) => l.pos >= (breaks[chapter] ?? 0));
            chapter++;
            if (opener)
                out.push('', `### ${mmss(opener.pos)} · "${truncate(opener.seg.text, 70)}"`, '');
        }
        if (entry.rank === -1) {
            flush();
            const why = entry.cut.reason ? `: ${truncate(entry.cut.reason, 120)}` : '';
            out.push(`- ✂ **${span(entry.cut.fromMs, entry.cut.toMs)}** removed after recording${why}`);
            // What was on screen before the cut is no longer what a line after it is looking at.
            under = undefined;
        }
        else if (entry.rank === 0) {
            under = entry.shot;
            // Starred frames and the first of a take never hide inside a collapsed run.
            if (keep.has(entry.shot.key) || entry.shot.frame.index === 1) {
                flush();
                frameLine(entry.shot);
            }
            else {
                run.push(entry.shot);
            }
        }
        else if (entry.rank === 1) {
            flush();
            const line = entry.line;
            const best = bestFor(line, shots, worth);
            const see = best && best.key !== under?.key ? ` → \`${best.path}\`` : '';
            out.push(`  > **${span(line.pos, line.end)}** ${labeledText(line.seg, labelSpeakers)}${see}`);
        }
        else {
            flush();
            const ev = entry.trace.ev;
            const detail = ev.detail ? ` — ${truncate(ev.detail, 200)}` : '';
            out.push(`  - \`[${ev.level}] @ ${mmss(entry.trace.pos)}\` ${truncate(ev.message, 200)}${detail}`);
        }
    }
    flush();
    return out;
}
/** One report for the whole walkthrough, in axis order. */
export function buildReport(session, recordings, options = {}) {
    const opts = resolve(options);
    const { spans, takes, shots, lines, traces } = axis(recordings, opts.cuts);
    // One decision for the whole report: label voices only when ≥2 were heard, so
    // S1 means the same (dominant) voice everywhere it appears.
    const labelSpeakers = speakerSet(lines.map((l) => l.seg)).size >= 2;
    const worth = new Map(shots.map((s) => [s.key, intrinsic(s, traces)]));
    const top = startHere(shots, lines, traces);
    const keep = new Set(top.map((t) => t.shot.key));
    // The span the evidence covers, not when the walkthrough was last touched — a
    // rename hours later must not stretch the recorded window.
    const first = takes.length ? Math.min(...takes.map((r) => r.createdAt)) : session.createdAt;
    const last = takes.length
        ? Math.max(...takes.map((r) => r.createdAt + r.meta.durationMs))
        : session.updatedAt;
    const origin = takes.find((r) => r.meta.eventScope)?.meta.eventScope ?? session.origin;
    const out = [];
    out.push(`# ${session.name.trim() || 'Walkthrough'}`);
    out.push('');
    const counts = [];
    if (takes.length) {
        const kind = takes.some((r) => r.meta.frames.length || r.meta.sampled)
            ? 'screen recording'
            : 'recording';
        counts.push(`${mmss(totalMs(spans))} ${kind}`);
    }
    if (shots.length)
        counts.push(`${shots.length} keyframe${shots.length === 1 ? '' : 's'}`);
    if (lines.length)
        counts.push(`${lines.length} ${lines.length === 1 ? opts.words.line : opts.words.lines}`);
    if (traces.length)
        counts.push(`${traces.length} error${traces.length === 1 ? '' : 's'} captured`);
    if (!counts.length)
        counts.push('empty');
    const when = hhmm(first) === hhmm(last) ? dateTime(first) : `${dateTime(first)}–${hhmm(last)}`;
    // A clip recorded off a device has no origin; an empty one must not leave a
    // dangling separator behind the timestamp.
    const header = [...counts, `recorded ${when}`];
    if (origin)
        header.push(origin);
    out.push(header.join(' · '));
    out.push('');
    out.push(...urlLines(opts));
    out.push(...introParagraph(takes, spans, opts, labelSpeakers));
    out.push(...interruptedLines(takes));
    if (takes.length)
        out.push(...orientation(takes, shots, opts));
    out.push(...scopeLines(takes));
    if (top.length) {
        out.push('## Start here');
        out.push('');
        out.push(`The ${top.length === shots.length ? '' : `${top.length} of ${shots.length} `}frames that carry the most evidence, in time order (★ in the timeline):`);
        out.push('');
        top.forEach(({ shot, line }, i) => {
            const said = line ? ` — "${truncate(line.seg.text, 140)}"` : '';
            const err = errorNear(shot, traces);
            const failed = err ? ` · error at ${mmss(err.pos)}: ${truncate(err.ev.message, 100)}` : '';
            out.push(`${i + 1}. \`${shot.path}\` · ${mmss(shot.pos)} · ${describe(shot)}${captionOf(shot, opts)}${failed}${said}`);
        });
        out.push('');
    }
    const sheets = contactSheets(spans);
    // Format 1 sheets were drawn without outlines; never promise one on them.
    const boxed = takes.every((r) => hasChangeBoxes(r.meta));
    if (sheets.length) {
        out.push(boxed
            ? `**Contact sheets** show every keyframe, nine per image in time order, each tile captioned with its frame number and time. A magenta outline marks what changed since the tile before it; the frames themselves are untouched.`
            : `**Contact sheets** show every keyframe, nine per image in time order, each tile captioned with its frame number and time.`);
        out.push('');
        for (const sheet of sheets) {
            out.push(`![${span(sheet.from, sheet.to)}, ${sheet.frames}](${sheet.file})`);
            out.push('');
        }
    }
    if (shots.length || lines.length || traces.length) {
        out.push('## Timeline');
        out.push('');
        if (lines.length) {
            out.push(`Each ${opts.words.line} sits at its stamp, ${opts.words.stamp}; ${opts.words.window}. → names the frame that best shows it, when that isn't the frame just above.`);
            out.push('');
        }
        out.push(...timeline(shots, lines, traces, keep, worth, labelSpeakers, opts));
        out.push('');
    }
    if (takes.length) {
        const videos = spans
            .map((s) => `\`${opts.videoPath(s.rec.index, s.rec.meta.videoFile)}\` (${mmss(s.rec.meta.durationMs)})`)
            .join(', ');
        const said = takes.some((r) => r.meta.transcript.length);
        const holds = [
            'frame times',
            ...(boxed ? ['change boxes'] : []),
            ...(said ? [`${opts.words.line} windows`] : []),
            'events',
        ];
        out.push(said
            ? `Also here: the raw video ${videos}, for humans; \`rec-NN/recording.json\` (${holds.join(', ')}) and \`rec-NN/transcript.txt\` (the words alone).`
            : `Also here: the raw video ${videos}, for humans; \`rec-NN/recording.json\` (${holds.join(', ')}).`);
        out.push('');
    }
    out.push(`<sub>${opts.source} · format ${FORMAT} · full listing: \`MANIFEST.txt\`</sub>`);
    out.push('');
    return out.join('\n');
}
export function buildTranscriptTxt(rec) {
    if (!rec.transcript.length)
        return '(no narration)\n';
    const label = speakerSet(rec.transcript).size >= 2;
    const lines = spokenWindows(rec).map((s) => `[${mmss(s.seg.t)}–${mmss(s.end)}] ${labeledText(s.seg, label)}`);
    return `${lines.join('\n')}\n`;
}
/**
 * One take, machine-readable. The shape is the format's contract: a viewer, an
 * uploader or a re-push tool can re-derive a walkthrough's takes from these
 * files alone. Format 2 only adds fields.
 */
export function buildRecordingJson(session, recording, url) {
    const rec = recording.meta;
    const transcriber = rec.transcript.length ? (rec.transcriber ?? 'webspeech') : undefined;
    return JSON.stringify({
        format: FORMAT,
        session: {
            name: session.name,
            slug: session.slug,
            url,
            createdAt: new Date(session.createdAt).toISOString(),
            origin: session.origin,
        },
        recording: {
            part: recording.index,
            dir: recDirName(recording.index),
            interrupted: Boolean(recording.interrupted),
            startedAt: new Date(rec.startedAt).toISOString(),
            durationMs: rec.durationMs,
            sampled: rec.sampled,
            sampling: rec.sampling,
            video: rec.videoFile,
            transcriber,
            transcriberLabel: rec.transcriberLabel,
            ...(rec.polished ? { polished: true } : {}),
            transcriptReviewed: Boolean(rec.reviewed),
            eventScope: rec.eventScope,
            droppedEvents: rec.droppedEvents ?? 0,
            frames: rec.frames.map((f) => ({
                index: f.index,
                at: mmss(f.t),
                tMs: f.t,
                file: f.file,
                reason: f.reason,
                dist: f.dist,
                change: f.change,
                held: f.held,
                transient: f.transient,
                pointer: f.pointer,
                // Only when a human moved it onto the walkthrough's axis.
                ...(f.tl === undefined ? {} : { tlMs: f.tl }),
            })),
            transcript: spokenWindows(rec).map((s) => ({
                at: mmss(s.seg.t),
                tMs: s.seg.t,
                // The window this line is about, not just where it started.
                endMs: s.end,
                aboutFromMs: s.from,
                aboutToMs: s.to,
                text: s.seg.text,
                ...(s.seg.speaker === undefined ? {} : { speaker: s.seg.speaker }),
                ...(s.seg.tl === undefined ? {} : { tlMs: s.seg.tl }),
            })),
            events: rec.events.map((e) => ({
                level: e.level,
                at: mmss(Math.max(0, e.ts - rec.startedAt)),
                tMs: Math.max(0, e.ts - rec.startedAt),
                message: e.message,
                detail: e.detail,
            })),
        },
    }, null, 2);
}
/**
 * Which engine wrote the words. Named plainly, because an agent reading the
 * report should weigh a large-model pass differently from live dictation. The
 * caller's label when it gave one; the id otherwise.
 */
function engineName(meta, opts) {
    const engine = meta.transcriberLabel ?? meta.transcriber ?? 'live dictation (Web Speech)';
    // A model rewrote the wording; say so. The reader is deciding how much to
    // trust these words, and that's a fact they need.
    return meta.polished ? `${engine}, wording cleaned up by ${opts.polishedBy}` : engine;
}
/** Where the lines in transcript.txt came from — the agent should weigh them differently. */
function transcriptSource(rec, opts) {
    if (opts.words.lines !== 'spoken lines')
        return `${opts.words.lines}, exact`;
    return `${engineName(rec, opts)} — ${rec.reviewed ? 'read back and corrected by the speaker' : 'NOT checked by the speaker; treat wording as approximate'}`;
}
/** `name  description` with the descriptions lined up. */
function rowLines(rows) {
    const width = rows.reduce((max, [name]) => Math.max(max, name.length), 0) + 2;
    return rows.map(([name, what]) => `${name.padEnd(width)}${what}`);
}
function samplingNote(rec) {
    const s = rec.sampling;
    if (!s)
        return `deduped from ${rec.sampled} sampled`;
    const step = s.stepMs >= 1000 ? `${seconds(s.stepMs)}` : `${s.stepMs} ms`;
    return `a candidate every ${step} (${s.engine}), ${rec.sampled} examined`;
}
/** Stats up top, transcripts inline — the whole walkthrough's file set, listed. */
export function buildManifestTxt(session, recordings, options = {}) {
    const opts = resolve(options);
    const parts = [...recordings].sort((a, b) => a.index - b.index);
    const rows = [
        ['report.md', 'the whole walkthrough in order, on one timeline. read this one'],
        ['MANIFEST.txt', 'this listing'],
    ];
    for (const part of parts) {
        const rec = part.meta;
        const dir = recDirName(part.index);
        const sheets = Math.ceil(rec.frames.length / GRID_PER_SHEET);
        rows.push([
            `${dir}/`,
            `part ${part.index} — ${Math.round(rec.durationMs / 1000)}s, ${rec.transcript.length} ${opts.words.line}(s)${part.interrupted ? ' (interrupted — tail may be missing)' : ''}`,
        ]);
        rows.push([
            `${dir}/frames/`,
            `${rec.frames.length} keyframes, NN-mmss.jpg (the mmss is time inside this part's own ${rec.videoFile}, not a position in report.md's timeline) — ${samplingNote(rec)}`,
        ]);
        if (sheets) {
            rows.push([
                `${dir}/grids/`,
                `${sheets} contact sheet(s), ${GRID_PER_SHEET} frames each, in order, changes outlined in magenta`,
            ]);
        }
        rows.push([
            `${dir}/transcript.txt`,
            rec.transcript.length
                ? transcriptSource(rec, opts)
                : `(none — no ${opts.words.lines} were captured)`,
        ]);
        rows.push([
            `${dir}/recording.json`,
            `frame times, change boxes, ${opts.words.line} windows, ${rec.events.length} error(s)${rec.eventScope ? ` from ${rec.eventScope}` : ''}${rec.droppedEvents ? ` (${rec.droppedEvents} dropped from other tabs)` : ''}`,
        ]);
        rows.push([opts.videoPath(part.index, rec.videoFile), 'raw video (for humans)']);
    }
    // Same omission as the report header: no origin, no empty trailing field.
    const recorded = [`recorded: ${dateTime(session.createdAt)}`, `${parts.length} part(s)`];
    if (session.origin)
        recorded.push(session.origin);
    const lines = [
        `format: ${FORMAT}`,
        `source: ${opts.source} — ${session.name}`,
        ...(opts.url ? [`walkthrough: ${opts.url}`] : []),
        recorded.join(' | '),
        'note: every path below is relative to this walkthrough',
        '--- files ---',
        ...rowLines(rows),
    ];
    const spoken = parts.filter((p) => p.meta.transcript.length);
    if (spoken.length) {
        lines.push(`note: line stamps are ${opts.words.stamp}; the bracketed range is the window the line covers`);
    }
    for (const part of parts) {
        lines.push(`--- transcript: ${recDirName(part.index)} (${mmss(part.meta.durationMs)}) ---`);
        lines.push(part.meta.transcript.length
            ? spokenWindows(part.meta)
                .map((s) => `[${mmss(s.seg.t)}–${mmss(s.end)}] ${s.seg.text}`)
                .join('\n')
            : '(none)');
    }
    return lines.join('\n') + '\n';
}
