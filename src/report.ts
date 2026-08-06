import { dateTime, hhmm, mmss, recDirName } from './format'
import type { PartSpan } from './timeline'
import { framePos, linePos, partSpans, totalMs } from './timeline'
import type {
  PageEvent,
  Recording,
  RecordingFrame,
  RecordingMeta,
  Session,
  TranscriptSegment,
} from './types'
import { GRID_PER_SHEET } from './types'

/**
 * The walkthrough's prose, its per-take JSON and its listing. Written for a
 * coding agent first and a human second: evidence up front, no prose the model
 * has to wade through, and every image path relative so the file set can be
 * moved.
 *
 * Product-specific wording (who recorded this, how a reader fetches the files)
 * is injected via `ReportOptions` — the format itself carries no brand.
 */

/**
 * Everything a consumer may want to say about itself inside the report. All
 * optional; the defaults describe a bare folder of files.
 */
export interface ReportOptions {
  /** Where this walkthrough lives — a URL an agent can act on. Omitted = no link is printed. */
  url?: string
  /** Continues the url line: how to pull the referenced files given that URL (e.g. "pull them with the `get_walkthrough` MCP tool"). */
  urlHint?: string
  /** Names the producer in the report footer and the MANIFEST `source:` line. */
  source?: string
  /** Continues "Every path is relative to the walkthrough's own file set" — where those paths resolve for this reader. */
  pathsHint?: string
  /** Who rewrote the transcript wording when a polish pass ran (e.g. "Claude"). */
  polishedBy?: string
}

interface ResolvedOptions {
  url?: string
  urlHint?: string
  source: string
  pathsHint: string
  polishedBy: string
}

function resolve(opts: ReportOptions): ResolvedOptions {
  return {
    url: opts.url,
    urlHint: opts.urlHint,
    source: opts.source ?? 'video-to-prompt',
    pathsHint: opts.pathsHint ?? 'the paths inside the folder if you downloaded it',
    polishedBy: opts.polishedBy ?? 'an LLM',
  }
}

/** The report needs a truncate and owns it — format.ts is frozen and has none. */
function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The opening always applies. The paragraph after it is added only when there is a recording. */
function preambleHead(pathsHint: string): string {
  return `> **You are reading a walkthrough — recorded feedback from a human using the running app: sometimes a bug, sometimes review notes, sometimes a change they want.**
> Everything below sits on one timeline, in the order it happened — and the human
> pruned and reordered it before handing it over, so what is here is what they meant
> you to read. **Read the images:**
> they are the primary evidence, and the words are shorthand that assumes you looked.
> Every path is relative to the walkthrough's own file set — ${pathsHint}. Wherever
> this report caps or thins what it shows you it prints the count — when you see one,
> you are looking at a subset, and the rest is in the walkthrough.`
}

const PREAMBLE_PARTS = `> The **walkthrough** is a narrated screen recording, distilled. Read it in this order:
> first the **contact sheets** — nine keyframes per image, in order, covering the
> *whole* recording at a fraction of the tokens — then the flow below, which is the same
> recording as text. A full still is inlined only where the narration is pointing at
> something; every other keyframe is listed by filename (\`rec-NN/frames/NN-mmss.jpg\`)
> so you can open one when you need it. **The mmss inside a filename is time within
> that file's own video** (\`rec-NN/walkthrough.webm\`); every time *printed* below is
> a position on this report's single timeline, so the two do not have to match.
> A spoken line covers a **window, not an
> instant**: it is stamped where the speaker started talking, and people narrate what
> just happened, so each line names the frames it is actually about — trust that range
> over the stamp. An accent crosshair drawn on a frame is the mouse pointer, and
> \`pointer\` under a frame names what it was over — that is how "this one over here"
> resolves. It may have been recorded in more than one sitting; those are laid end to
> end on a single clock, so every time below reads straight through and no arithmetic
> is asked of you.`

function preamble(hasParts: boolean, pathsHint: string): string {
  const blocks = hasParts ? [preambleHead(pathsHint), PREAMBLE_PARTS] : [preambleHead(pathsHint)]
  return blocks.join('\n>\n')
}

/**
 * Where this walkthrough lives, for an agent that arrived holding only the
 * report text. Omitted when the caller doesn't know the URL — a host that mints
 * ids during upload can't know it before these bytes are counted, so the first
 * copy of a report is deliberately silent rather than guessing at a link.
 */
function urlLines(opts: ResolvedOptions): string[] {
  if (!opts.url) return []
  const hint = opts.urlHint ? ` — ${opts.urlHint}` : ''
  return [`**This walkthrough:** \`${opts.url}\`${hint}`, '']
}

/** How far around a spoken line we consider "the frames that line is about". */
const SPEECH_LEAD_MS = 2000
const SPEECH_TAIL_MS = 2500
/** Fallback line length when the transcriber gave no end time. */
const WORD_MS = 380
const MIN_LINE_MS = 1200
/** Ceilings on inlined stills, per take — the complaint that started all this was 68 for 6 lines. */
const MAX_INLINE = 16
const QUIET_INLINE = 12
/** A silence this long closes a section; whatever is said next opens the one after. */
const CHAPTER_GAP_MS = 15000

function spokenMs(seg: TranscriptSegment): number {
  return seg.d ?? Math.max(MIN_LINE_MS, seg.text.split(/\s+/).length * WORD_MS)
}

/** A spoken line plus the window of screen time it plausibly refers to. Take-local. */
interface Spoken {
  seg: TranscriptSegment
  end: number
  from: number
  to: number
}

/** Take-local windows, for the per-take files (`transcript.txt`, `recording.json`, MANIFEST). */
function spokenWindows(rec: RecordingMeta): Spoken[] {
  return rec.transcript.map((seg) => {
    const end = seg.t + spokenMs(seg)
    return { seg, end, from: Math.max(0, seg.t - SPEECH_LEAD_MS), to: end + SPEECH_TAIL_MS }
  })
}

/** The same line, placed on the walkthrough's axis. This is what the report reads. */
interface Line {
  rec: Recording
  seg: TranscriptSegment
  pos: number
  end: number
  from: number
  to: number
}

/** A keyframe on the axis, carrying the `rec-NN/` its paths need and a key that survives takes. */
interface Shot {
  rec: Recording
  frame: RecordingFrame
  pos: number
  prefix: string
  sheet?: number
  /** Frame numbers restart in every take, so identity is the pair. */
  key: string
}

interface Trace {
  pos: number
  ev: PageEvent
}

function axisLines(recordings: Recording[], spans: PartSpan[]): Line[] {
  const out: Line[] = []
  for (const rec of recordings) {
    const span = spans.find((s) => s.rec.id === rec.id)
    for (const seg of rec.meta.transcript) {
      const pos = linePos(rec, seg, spans)
      const end = pos + spokenMs(seg)
      let from = Math.max(0, pos - SPEECH_LEAD_MS)
      let to = end + SPEECH_TAIL_MS
      // Takes abut with no gap, so an unmoved line's window would otherwise reach
      // across the seam and claim frames from a sitting recorded hours later.
      if (seg.tl === undefined && span) {
        from = Math.max(from, span.start)
        to = Math.min(to, span.end)
      }
      out.push({ rec, seg, pos, end, from, to })
    }
  }
  return out.sort((a, b) => a.pos - b.pos)
}

function axisShots(recordings: Recording[], spans: PartSpan[]): Shot[] {
  const out: Shot[] = []
  for (const rec of recordings) {
    const prefix = `${recDirName(rec.index)}/`
    const sheets = sheetOf(rec.meta)
    for (const frame of rec.meta.frames) {
      out.push({
        rec,
        frame,
        prefix,
        pos: framePos(rec, frame, spans),
        sheet: sheets.get(frame.index),
        key: `${rec.id}:${frame.index}`,
      })
    }
  }
  return out.sort((a, b) => a.pos - b.pos)
}

function axisEvents(recordings: Recording[], spans: PartSpan[]): Trace[] {
  const out: Trace[] = []
  for (const rec of recordings) {
    // Event timestamps are absolute; the axis is not. A stamp from after the
    // recorder stopped must not drift into the next take, so pin it to this one.
    const span = spans.find((s) => s.rec.id === rec.id)
    const start = span?.start ?? 0
    const end = span?.end ?? Infinity
    for (const ev of rec.meta.events) {
      out.push({ pos: Math.min(end, start + Math.max(0, ev.ts - rec.meta.startedAt)), ev })
    }
  }
  return out.sort((a, b) => a.pos - b.pos)
}

/** frame index → the contact sheet it appears on. Batching must match `makeGrids`. */
function sheetOf(rec: RecordingMeta): Map<number, number> {
  const map = new Map<number, number>()
  rec.frames.forEach((f, i) => map.set(f.index, Math.floor(i / GRID_PER_SHEET) + 1))
  return map
}

/**
 * Paths inside a take are stored take-relative; the report reads from the
 * walkthrough root. Exported because a consumer's uploader has to send this
 * exact path — the citation and the upload are built by one function so they
 * cannot drift.
 */
export function sheetFile(n: number, prefix = ''): string {
  return `${prefix}grids/grid_${String(n).padStart(2, '0')}.jpg`
}

/** Pick every nth of `pool` until `budget` is met — the thinning shape used for frames. */
function spread<T>(pool: T[], budget: number): T[] {
  if (budget <= 0 || !pool.length) return []
  if (pool.length <= budget) return pool
  const step = pool.length / budget
  return Array.from({ length: budget }, (_, i) => pool[Math.floor(i * step)])
}

/** The frame every take opens on. These are never thinned. */
function mustShow(recordings: Recording[]): Set<string> {
  const keys = new Set<string>()
  for (const rec of recordings) {
    const first = rec.meta.frames[0]
    if (first) keys.add(`${rec.id}:${first.index}`)
  }
  return keys
}

/**
 * Which frames get a full still. The must-haves always; otherwise the ones inside a
 * spoken window, thinned if the human talked the whole time. With no narration at all
 * there is nothing to aim at, so take a spread and lean on the sheets.
 */
function inlineShots(shots: Shot[], lines: Line[], recordings: Recording[]): Set<string> {
  const shown = mustShow(recordings)
  const takes = Math.max(1, recordings.length)
  const budget = (lines.length ? MAX_INLINE : QUIET_INLINE) * takes - shown.size
  const pool = shots.filter(
    (s) => !shown.has(s.key) && (!lines.length || lines.some((l) => claims(l, s)))
  )
  for (const s of spread(pool, budget)) shown.add(s.key)
  return shown
}

/**
 * Does this line point at this frame? Position alone is not enough: takes abut, so
 * a window ending exactly on the seam would reach the next take's first frame.
 */
function claims(line: Line, shot: Shot): boolean {
  if (shot.pos < line.from || shot.pos > line.to) return false
  return line.seg.tl !== undefined || shot.frame.tl !== undefined || shot.rec.id === line.rec.id
}

/** The frames a spoken line is pointing at. Frame numbers restart per take, so name files. */
function coverage(shots: Shot[], line: Line, hasSheets: boolean): string {
  const hit = shots.filter((s) => claims(line, s))
  // Never point at sheets that were never written — a take with no frames has none.
  if (!hit.length) {
    return hasSheets
      ? 'no keyframe inside that window — see the contact sheets'
      : 'no keyframe inside that window'
  }
  const first = hit[0]
  const last = hit[hit.length - 1]
  if (hit.length === 1) return `${mmss(first.pos)} — \`${first.prefix}${first.frame.file}\``
  return `${hit.length} frames, ${mmss(first.pos)}–${mmss(last.pos)} — \`${first.prefix}${first.frame.file}\` … \`${last.prefix}${last.frame.file}\``
}

/** A spoken line or an error, already rendered, carrying where it lands on the axis. */
interface Beat {
  pos: number
  lines: string[]
}

function lineBeat(line: Line, shots: Shot[], hasSheets: boolean): Beat {
  return {
    pos: line.pos,
    lines: [
      '',
      `> **${mmss(line.pos)}–${mmss(line.end)}** ${line.seg.text}`,
      `> ↳ about ${coverage(shots, line, hasSheets)}`,
    ],
  }
}

function traceBeat(trace: Trace): Beat {
  const detail = trace.ev.detail ? ` — ${truncate(trace.ev.detail, 200)}` : ''
  return {
    pos: trace.pos,
    lines: [
      '',
      `- \`[${trace.ev.level}] @ ${mmss(trace.pos)}\` ${truncate(trace.ev.message, 200)}${detail}`,
    ],
  }
}

function pointerLine(frame: RecordingFrame): string | null {
  const p = frame.pointer
  if (!p?.selector) return null
  const text = p.text ? ` — "${truncate(p.text, 60)}"` : ''
  const drawn = p.nx === undefined ? ' (position not drawable on this capture)' : ''
  return `- **pointer** \`${p.selector}\`${text}${drawn}`
}

/** One inlined still. */
function frameBlock(shot: Shot): string[] {
  const at = mmss(shot.pos)
  const bits = [at, `\`${shot.prefix}${shot.frame.file}\``]
  if (shot.sheet) bits.push(`also on \`${sheetFile(shot.sheet, shot.prefix)}\``)
  const lines = [
    '---',
    '',
    `#### ${bits.join(' · ')}`,
    '',
    `![keyframe at ${at}](${shot.prefix}${shot.frame.file})`,
  ]
  const pointer = pointerLine(shot.frame)
  if (pointer) lines.push('', pointer)
  return lines
}

/** Past this many, a run stops naming every file and hands the rest to the sheets. */
const RUN_NAMES = 6

/**
 * A run of frames nobody narrated over: one line, not one image each — but every
 * file in it is named, because the report promises the rest are "listed by
 * filename, not dropped" and a first…last range names neither of the middles.
 */
function runLine(run: Shot[]): string {
  const first = run[0]
  const last = run[run.length - 1]
  const grids = [
    ...new Set(run.map((s) => (s.sheet ? sheetFile(s.sheet, s.prefix) : '')).filter(Boolean)),
  ]
  const on = grids.length ? ` · on ${grids.map((g) => `\`${g}\``).join(', ')}` : ''
  if (run.length === 1) return `- ${mmss(first.pos)} — \`${first.prefix}${first.frame.file}\`${on}`
  const named = run.length <= RUN_NAMES ? run : run.slice(0, RUN_NAMES - 1)
  const rest = run.length - named.length
  const files = named.map((s) => `\`${s.prefix}${s.frame.file}\``).join(', ')
  const more = rest ? ` (+${rest} more, all on the contact sheets)` : ''
  return `- ${mmss(first.pos)}–${mmss(last.pos)} — ${run.length} keyframes, nothing said over them: ${files}${more}${on}`
}

/** How much to trust the words — the ASR error that sent an agent to the wrong file. */
function transcriptCaveat(recordings: Recording[], opts: ResolvedOptions): string[] {
  const spoken = recordings.filter((r) => r.meta.transcript.length)
  if (!spoken.length) return []
  if (spoken.every((r) => r.meta.reviewed)) {
    return ['> The speaker read this transcript back and corrected it — the wording is theirs.', '']
  }
  const engines = [...new Set(spoken.map((r) => engineName(r.meta, opts)))]
  const some = spoken.some((r) => r.meta.reviewed)
  return [
    some
      ? `> The transcript is machine-transcribed (${engines.join(' / ')}); **only part of it was read back by the speaker**.`
      : `> The transcript is machine-transcribed (${engines.join(' / ')}) and **was not checked by the speaker**.`,
    '> Speech recognition mangles exactly the words that matter most — nouns, units, small numbers.',
    '> Where a word contradicts the frames or the code, believe the frames.',
    '',
  ]
}

function scopeLines(recordings: Recording[]): string[] {
  const scopes = recordings.map((r) => r.meta.eventScope).filter((s): s is string => Boolean(s))
  const events = recordings.reduce((n, r) => n + r.meta.events.length, 0)
  const dropped = recordings.reduce((n, r) => n + (r.meta.droppedEvents ?? 0), 0)
  if (!scopes.length || (!events && !dropped)) return []
  const from = [...new Set(scopes)].map((s) => `\`${s}\``).join(', ')
  const lost = dropped ? ` ${dropped} event(s) from other tabs were dropped.` : ''
  return [
    `> Console/network lines below come only from ${from} — the tab that was in front while recording.${lost}`,
    '',
  ]
}

/** A recording reassembled from chunks — say so, never imply it is whole. */
function interruptedLines(recordings: Recording[]): string[] {
  const hurt = recordings.filter((r) => r.interrupted)
  if (!hurt.length) return []
  return [
    `_(interrupted — the recorder died mid-recording; ${hurt.length === 1 ? 'a stretch of' : `${hurt.length} stretches of`} the walkthrough may be missing)_`,
    '',
  ]
}

/** Where one `##` section ends and the next opens: a silence runs long. */
function chapterBreaks(lines: Line[]): number[] {
  const cuts: number[] = []
  let reach = lines[0]?.to ?? 0
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].pos - reach > CHAPTER_GAP_MS) cuts.push(lines[i].from)
    reach = Math.max(reach, lines[i].to)
  }
  return [...new Set(cuts)].sort((a, b) => a - b)
}

/** A stretch of the axis, rendered, carrying the position it starts at. */
interface Block {
  pos: number
  lines: string[]
}

/**
 * The walkthrough as `##` sections, one per stretch of narration: frames anchor the
 * flow, spoken lines and errors land under the last frame at or before them, and
 * everything nobody talked over collapses to one line per run.
 */
function walkthroughBlocks(
  shots: Shot[],
  lines: Line[],
  traces: Trace[],
  shown: Set<string>,
  cuts: number[],
  hasSheets: boolean
): Block[] {
  interface Entry {
    pos: number
    rank: number
    shot?: Shot
    line?: Line
    trace?: Trace
  }
  const entries: Entry[] = [
    ...shots.map((shot) => ({ pos: shot.pos, rank: 0, shot })),
    ...lines.map((line) => ({ pos: line.pos, rank: 1, line })),
    ...traces.map((trace) => ({ pos: trace.pos, rank: 2, trace })),
  ]
  entries.sort((a, b) => a.pos - b.pos || a.rank - b.rank)

  const chapters: Entry[][] = [[]]
  let cut = 0
  for (const entry of entries) {
    while (cut < cuts.length && entry.pos >= cuts[cut]) {
      cut++
      chapters.push([])
    }
    chapters[chapters.length - 1].push(entry)
  }

  return chapters
    .filter((chapter) => chapter.length)
    .map((chapter) => {
      const frames = chapter.flatMap((e) => (e.shot ? [e.shot] : []))
      const beats = chapter.flatMap((e) =>
        e.line ? [lineBeat(e.line, shots, hasSheets)] : e.trace ? [traceBeat(e.trace)] : []
      )
      const opener = chapter.find((e) => e.line)?.line
      const out: string[] = []
      out.push(
        opener
          ? `## ${mmss(opener.pos)} — "${truncate(opener.seg.text, 80)}"`
          : `## ${mmss(chapter[0].pos)} — nothing said over these frames`
      )
      out.push('')

      // Every beat lands under the last frame at or before it — so anything spoken
      // before the first frame rides with it, and the final frame absorbs the tail.
      let cursor = 0
      let run: Shot[] = []
      const flushRun = () => {
        if (run.length) out.push(runLine(run), '')
        run = []
      }

      frames.forEach((shot, i) => {
        const end = frames[i + 1]?.pos ?? Infinity
        const due = cursor < beats.length && beats[cursor].pos < end
        if (shown.has(shot.key)) {
          flushRun()
          // Nothing under the heading yet: it is already the separator.
          const block = frameBlock(shot)
          out.push(...(out.length === 2 ? block.slice(2) : block))
        } else {
          // A run never crosses a seam: the mmss inside the filenames is take-local,
          // so first…last across two takes reads backwards.
          if (run.length && run[run.length - 1].rec.id !== shot.rec.id) flushRun()
          run.push(shot)
          if (due) flushRun() // narration has to stay in order with the frames it follows
        }
        while (cursor < beats.length && beats[cursor].pos < end) {
          out.push(...beats[cursor].lines)
          cursor++
        }
        if (shown.has(shot.key) || due) out.push('')
      })
      flushRun()
      // No frames means nothing to anchor to, but the narration still has to survive.
      for (; cursor < beats.length; cursor++) out.push(...beats[cursor].lines)
      if (out[out.length - 1] !== '') out.push('')
      return { pos: chapter[0].pos, lines: out }
    })
}

/** Every take's sheets in axis order. Batching must match `makeGrids`: meta order, nine at a time. */
function contactSheets(spans: PartSpan[]): { file: string; from: number; to: number }[] {
  const out: { file: string; from: number; to: number }[] = []
  for (const span of spans) {
    const prefix = `${recDirName(span.rec.index)}/`
    const frames = span.rec.meta.frames
    for (let n = 1; n <= Math.ceil(frames.length / GRID_PER_SHEET); n++) {
      const batch = frames.slice((n - 1) * GRID_PER_SHEET, n * GRID_PER_SHEET)
      // A moved frame can leave its sheet out of order, so bound the label rather than assume.
      const at = batch.map((f) => framePos(span.rec, f, spans))
      out.push({ file: sheetFile(n, prefix), from: Math.min(...at), to: Math.max(...at) })
    }
  }
  // "In order" has to mean axis order, which is the order everything else here is in.
  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

/** Two sheets covering the same stretch — true only after a human reordered items. */
function sheetsOverlap(sheets: { from: number; to: number }[]): boolean {
  return sheets.some((sheet, i) => i > 0 && sheet.from < sheets[i - 1].to)
}

/** One report for the whole walkthrough, in axis order. */
export function buildReport(
  session: Session,
  recordings: Recording[],
  options: ReportOptions = {}
): string {
  const opts = resolve(options)
  const spans = partSpans(recordings)
  const takes = spans.map((s) => s.rec)
  const shots = axisShots(takes, spans)
  const lines = axisLines(takes, spans)
  const traces = axisEvents(takes, spans)
  const shown = inlineShots(shots, lines, takes)

  // The span the evidence covers, not when the walkthrough was last touched — a
  // rename hours later must not stretch the recorded window.
  const first = takes.length ? Math.min(...takes.map((r) => r.createdAt)) : session.createdAt
  const last = takes.length
    ? Math.max(...takes.map((r) => r.createdAt + r.meta.durationMs))
    : session.updatedAt
  const origin = takes.find((r) => r.meta.eventScope)?.meta.eventScope ?? session.origin

  const out: string[] = []
  out.push(`# Walkthrough — ${session.name}`)
  out.push('')
  const counts: string[] = []
  if (takes.length) counts.push(`\`walkthrough ${mmss(totalMs(spans))}\``)
  if (shots.length) counts.push(`\`${shots.length} keyframe${shots.length === 1 ? '' : 's'}\``)
  if (lines.length) counts.push(`\`${lines.length} spoken line${lines.length === 1 ? '' : 's'}\``)
  if (traces.length) {
    counts.push(`\`${traces.length} error${traces.length === 1 ? '' : 's'} captured\``)
  }
  if (!counts.length) counts.push('`empty`')
  // A clip recorded off a device has no origin; an empty one must not leave a
  // dangling separator behind the timestamp.
  const header = [counts.join(' · '), `recorded ${dateTime(first)}–${hhmm(last)}`]
  if (origin) header.push(origin)
  out.push(header.join(' · '))
  out.push('')
  out.push(...urlLines(opts))
  out.push(preamble(takes.length > 0, opts.pathsHint))
  out.push('')

  if (takes.length) {
    const files = spans
      .map(
        (s) =>
          `\`${recDirName(s.rec.index)}/${s.rec.meta.videoFile}\` (${mmss(s.rec.meta.durationMs)})`
      )
      .join(' · ')
    out.push(
      `**Video:** ${files} — the raw recording, for humans. Everything below is distilled from it.`
    )
    out.push('')
  }
  out.push(...interruptedLines(takes))
  out.push(...transcriptCaveat(takes, opts))
  out.push(...scopeLines(takes))

  const sheets = contactSheets(spans)
  if (sheets.length) {
    out.push('### Contact sheets — read these first')
    out.push('')
    const jumbled = sheetsOverlap(sheets) ? ' (ranges overlap — items were reordered)' : ''
    out.push(
      `${shots.length} keyframes across ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}, nine per image, in order, each tile labeled with its filename.${jumbled}`
    )
    out.push('')
    sheets.forEach((sheet, i) => {
      const span = `${mmss(sheet.from)}–${mmss(sheet.to)}`
      out.push(`![contact sheet ${i + 1} of ${sheets.length} — ${span}](${sheet.file})`)
      out.push('')
    })
  }
  if (shots.length) {
    out.push(
      `${shown.size} of ${shots.length} keyframe${shots.length === 1 ? '' : 's'} are inlined below — the moments the narration is pointing at. The rest are named by filename in the flow, run by run; only where a silent run passes ${RUN_NAMES} frames are the first ${RUN_NAMES - 1} named and the remainder counted. Nothing is dropped, and every keyframe is on the sheets above. Machine-readable: \`rec-NN/recording.json\` — frame times, pointer positions, transcript windows, events. Words alone: \`rec-NN/transcript.txt\`.`
    )
    out.push('')
  }

  const blocks: Block[] = walkthroughBlocks(
    shots,
    lines,
    traces,
    shown,
    chapterBreaks(lines),
    sheets.length > 0
  ).sort((a, b) => a.pos - b.pos)

  for (const block of blocks) {
    out.push('---')
    out.push('')
    out.push(...block.lines)
  }

  const machine = recordings.length ? '`rec-NN/recording.json`' : '`MANIFEST.txt`'
  out.push('---')
  out.push('')
  out.push(
    `<sub>Recorded with ${opts.source}. Machine-readable copy: ${machine}. Full listing of this walkthrough: \`MANIFEST.txt\`.</sub>`
  )
  out.push('')
  return out.join('\n')
}

export function buildTranscriptTxt(rec: RecordingMeta): string {
  if (!rec.transcript.length) return '(no narration)\n'
  const lines = spokenWindows(rec).map((s) => `[${mmss(s.seg.t)}–${mmss(s.end)}] ${s.seg.text}`)
  return `${lines.join('\n')}\n`
}

/**
 * One take, machine-readable. The shape is the format's contract: a viewer, an
 * uploader or a re-push tool can re-derive a walkthrough's takes from these
 * files alone.
 */
export function buildRecordingJson(session: Session, recording: Recording, url?: string): string {
  const rec = recording.meta
  return JSON.stringify(
    {
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
        video: rec.videoFile,
        transcriber: rec.transcriber ?? 'webspeech',
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
          pointer: f.pointer,
        })),
        transcript: spokenWindows(rec).map((s) => ({
          at: mmss(s.seg.t),
          tMs: s.seg.t,
          // The window this line is about, not just where it started.
          endMs: s.end,
          aboutFromMs: s.from,
          aboutToMs: s.to,
          text: s.seg.text,
        })),
        events: rec.events.map((e) => ({
          level: e.level,
          at: mmss(Math.max(0, e.ts - rec.startedAt)),
          message: e.message,
          detail: e.detail,
        })),
      },
    },
    null,
    2
  )
}

/**
 * Which engine wrote the words. Named plainly, because an agent reading the
 * report should weigh a large-model pass differently from live dictation.
 * Unknown transcriber ids print as-is.
 */
function engineName(
  meta: Pick<RecordingMeta, 'transcriber' | 'polished'>,
  opts: ResolvedOptions
): string {
  const engine =
    meta.transcriber === 'groq'
      ? 'Whisper large-v3-turbo, hosted'
      : meta.transcriber === 'whisper'
        ? 'Whisper small.en, on-device'
        : meta.transcriber
          ? meta.transcriber
          : 'live dictation, Web Speech'
  // A model rewrote the wording; say so. The reader is deciding how much to
  // trust these words, and that's a fact they need.
  return meta.polished ? `${engine}, wording cleaned up by ${opts.polishedBy}` : engine
}

/** Where the lines in transcript.txt came from — the agent should weigh them differently. */
function transcriptSource(rec: RecordingMeta, opts: ResolvedOptions): string {
  return `${engineName(rec, opts)} — ${rec.reviewed ? 'read back and corrected by the speaker' : 'NOT checked by the speaker; treat wording as approximate'}`
}

/** `name  description` with the descriptions lined up. */
function rowLines(rows: [string, string][]): string[] {
  const width = rows.reduce((max, [name]) => Math.max(max, name.length), 0) + 2
  return rows.map(([name, what]) => `${name.padEnd(width)}${what}`)
}

/** Stats up top, transcripts inline — the whole walkthrough's file set, listed. */
export function buildManifestTxt(
  session: Session,
  recordings: Recording[],
  options: ReportOptions = {}
): string {
  const opts = resolve(options)
  const parts = [...recordings].sort((a, b) => a.index - b.index)
  const rows: [string, string][] = [
    ['report.md', 'the whole walkthrough in order, on one timeline. read this one'],
    ['MANIFEST.txt', 'this listing'],
  ]
  for (const part of parts) {
    const rec = part.meta
    const dir = recDirName(part.index)
    const sheets = Math.ceil(rec.frames.length / GRID_PER_SHEET)
    rows.push([
      `${dir}/`,
      `part ${part.index} — walkthrough, ${Math.round(rec.durationMs / 1000)}s, ${rec.transcript.length} spoken line(s)${part.interrupted ? ' (interrupted — tail may be missing)' : ''}`,
    ])
    rows.push([
      `${dir}/frames/`,
      `${rec.frames.length} keyframes, NN-mmss.jpg (the mmss is time inside this part's own ${rec.videoFile}, not a position in report.md's timeline) — 1s candidates + dedup, deduped from ${rec.sampled} sampled`,
    ])
    if (sheets) {
      rows.push([
        `${dir}/grids/`,
        `${sheets} contact sheet(s), ${GRID_PER_SHEET} frames each, in order`,
      ])
    }
    rows.push([
      `${dir}/transcript.txt`,
      rec.transcript.length
        ? transcriptSource(rec, opts)
        : '(none — no narration was captured)',
    ])
    rows.push([
      `${dir}/recording.json`,
      `frame times, pointer positions, transcript windows, ${rec.events.length} error(s)${rec.eventScope ? ` from ${rec.eventScope}` : ''}${rec.droppedEvents ? ` (${rec.droppedEvents} dropped from other tabs)` : ''}`,
    ])
    rows.push([`${dir}/${rec.videoFile}`, 'raw video (for humans)'])
  }

  // Same omission as the report header: no origin, no empty trailing field.
  const recorded = [`recorded: ${dateTime(session.createdAt)}`, `${parts.length} part(s)`]
  if (session.origin) recorded.push(session.origin)
  const lines = [
    `source: ${opts.source} — ${session.name}`,
    ...(opts.url ? [`walkthrough: ${opts.url}`] : []),
    recorded.join(' | '),
    'note: every path below is relative to this walkthrough',
    '--- files ---',
    ...rowLines(rows),
  ]
  const spoken = parts.filter((p) => p.meta.transcript.length)
  if (spoken.length) {
    lines.push(
      'note: line stamps are where the speaker started; the bracketed range is the window the line is about'
    )
  }
  for (const part of parts) {
    lines.push(`--- transcript: ${recDirName(part.index)} (${mmss(part.meta.durationMs)}) ---`)
    lines.push(
      part.meta.transcript.length
        ? spokenWindows(part.meta)
            .map((s) => `[${mmss(s.seg.t)}–${mmss(s.end)}] ${s.seg.text}`)
            .join('\n')
        : '(none)'
    )
  }
  return lines.join('\n') + '\n'
}
