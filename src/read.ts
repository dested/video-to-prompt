import { contentTypeFor } from './container.js'
import type {
  FrameBox,
  FramePointer,
  PageEvent,
  Recording,
  RecordingFrame,
  Session,
  TranscriptSegment,
} from './types.js'
import { FORMAT_1 } from './types.js'

/**
 * recording.json back into the recording shapes, so a reader that only holds
 * the files (a server, a CLI) can run the same report writers. Pure; no DOM.
 *
 * Tolerant on purpose: it reads every recording.json this format has produced,
 * format 1 included, from the library, Handback's web pipeline and its
 * extension. A field that is missing or the wrong type is dropped, never
 * guessed. Only a file with no `recording` object at all is refused.
 *
 * Round trip: buildRecordingJson → readRecordingJson → buildReport gives the
 * report the original produced. Spoken lengths come back from each line's
 * `endMs`, and event times from `tMs`, or from their m:ss stamps on files
 * older than that.
 */

/** One take as its recording.json describes it. */
export interface ReadTake {
  /**
   * The walkthrough as this take's file names it. A host with its own record
   * (a renamed title, a database id) should build the Session from that instead.
   */
  session: Session
  recording: Recording
  /** The walkthrough's URL, when the file carries one. */
  url?: string
}

const FRAME_REASONS: ReadonlySet<string> = new Set<RecordingFrame['reason']>([
  'start',
  'change',
  'click',
  'nav',
  'beat',
  'narration',
  'end',
])
const EVENT_LEVELS: ReadonlySet<string> = new Set<PageEvent['level']>(['error', 'warn', 'network'])
const isReason = (v: string | undefined): v is RecordingFrame['reason'] =>
  v !== undefined && FRAME_REASONS.has(v)
const isLevel = (v: string | undefined): v is PageEvent['level'] =>
  v !== undefined && EVENT_LEVELS.has(v)

/** The default engine's own id. The report names it itself, so it never prints the bare id. */
const WEB_SPEECH = 'webspeech'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** "4:32" or "1:04:32" → ms. The format writes whole seconds. */
function parseStamp(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d+(:\d{1,2}){1,2}$/.test(v)) return undefined
  return v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) * 1000
}

function parseDate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

function readBox(v: unknown): FrameBox | undefined {
  if (!isObj(v)) return undefined
  const x = num(v.x)
  const y = num(v.y)
  const w = num(v.w)
  const h = num(v.h)
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  return { x, y, w, h }
}

function readPointer(v: unknown): FramePointer | undefined {
  if (!isObj(v)) return undefined
  const p: FramePointer = {}
  const nx = num(v.nx)
  const ny = num(v.ny)
  const selector = str(v.selector)
  const text = str(v.text)
  if (nx !== undefined) p.nx = nx
  if (ny !== undefined) p.ny = ny
  if (selector) p.selector = selector
  if (text) p.text = text
  return Object.keys(p).length ? p : undefined
}

function readFrame(v: unknown, i: number, dir: string): RecordingFrame | undefined {
  if (!isObj(v)) return undefined
  const file = str(v.file)
  const t = num(v.tMs) ?? parseStamp(v.at)
  if (!file || t === undefined) return undefined
  const reason = str(v.reason)
  const frame: RecordingFrame = {
    index: num(v.index) ?? i + 1,
    t,
    // Some writers put the take's folder into `file`; the shape keeps it take-relative.
    file: file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file,
    reason: isReason(reason) ? reason : 'change',
  }
  const dist = num(v.dist)
  const change = readBox(v.change)
  const held = num(v.held)
  const transient = bool(v.transient)
  const pointer = readPointer(v.pointer)
  const tl = num(v.tlMs)
  if (dist !== undefined) frame.dist = dist
  if (change) frame.change = change
  if (held !== undefined) frame.held = held
  if (transient) frame.transient = true
  if (pointer) frame.pointer = pointer
  if (tl !== undefined) frame.tl = tl
  return frame
}

function readLine(v: unknown): TranscriptSegment | undefined {
  if (!isObj(v)) return undefined
  const text = str(v.text)?.trim()
  const t = num(v.tMs) ?? parseStamp(v.at)
  if (!text || t === undefined) return undefined
  const seg: TranscriptSegment = { t, text }
  const end = num(v.endMs)
  const speaker = num(v.speaker)
  const tl = num(v.tlMs)
  if (end !== undefined && end > t) seg.d = end - t
  if (speaker !== undefined && Number.isInteger(speaker) && speaker >= 1) seg.speaker = speaker
  if (tl !== undefined) seg.tl = tl
  return seg
}

function readEvent(v: unknown, startedAt: number): PageEvent | undefined {
  if (!isObj(v)) return undefined
  const level = str(v.level)
  const message = str(v.message)
  const at = num(v.tMs) ?? parseStamp(v.at)
  if (!isLevel(level) || message === undefined || at === undefined) return undefined
  const ev: PageEvent = { level, message, ts: startedAt + at }
  const detail = str(v.detail)
  if (detail) ev.detail = detail
  return ev
}

/**
 * Parse one take's recording.json (its text, or the value already parsed).
 * Null when it isn't JSON or carries no `recording` object.
 */
export function readRecordingJson(input: unknown): ReadTake | null {
  let root: unknown = input
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (!isObj(root) || !isObj(root.recording)) return null
  const rec = root.recording
  const ses = isObj(root.session) ? root.session : {}

  const dirMatch = /^rec-(\d+)$/.exec(str(rec.dir) ?? '')
  const part = num(rec.part) ?? (dirMatch ? Number(dirMatch[1]) : 1)
  const dir = str(rec.dir) ?? `rec-${String(part).padStart(2, '0')}`
  const createdAt = parseDate(ses.createdAt)
  const startedAt = parseDate(rec.startedAt) ?? createdAt ?? 0
  const slug = str(ses.slug) ?? ''
  const videoFile = str(rec.video) ?? ''

  const transcript = arr(rec.transcript)
    .map(readLine)
    .filter((s): s is TranscriptSegment => s !== undefined)
    .sort((a, b) => a.t - b.t)
  const transcriber = str(rec.transcriber)
  const sampling = isObj(rec.sampling) ? rec.sampling : undefined
  const engine = str(sampling?.engine)
  const stepMs = num(sampling?.stepMs)
  const droppedEvents = num(rec.droppedEvents)
  const transcriberLabel = str(rec.transcriberLabel)
  const eventScope = str(rec.eventScope)

  const recording: Recording = {
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
        .filter((f): f is RecordingFrame => f !== undefined),
      transcript,
      // Words only: a silent take's engine is noise, and the default engine names itself.
      ...(transcript.length && transcriber && transcriber !== WEB_SPEECH ? { transcriber } : {}),
      ...(transcriberLabel ? { transcriberLabel } : {}),
      ...(engine !== undefined && stepMs !== undefined ? { sampling: { engine, stepMs } } : {}),
      ...(bool(rec.polished) ? { polished: true } : {}),
      ...(bool(rec.transcriptReviewed) ? { reviewed: true } : {}),
      events: arr(rec.events)
        .map((e) => readEvent(e, startedAt))
        .filter((e): e is PageEvent => e !== undefined),
      ...(eventScope ? { eventScope } : {}),
      ...(droppedEvents ? { droppedEvents } : {}),
      videoFile,
      format: str(root.format) ?? FORMAT_1,
    },
  }

  const session: Session = {
    id: slug,
    name: str(ses.name) ?? '',
    slug,
    createdAt: createdAt ?? startedAt,
    updatedAt: createdAt ?? startedAt,
    origin: str(ses.origin) ?? '',
    recCount: 1,
  }
  const url = str(ses.url)
  return { session, recording, ...(url ? { url } : {}) }
}
