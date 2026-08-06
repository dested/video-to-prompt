import { decodeMono, SAMPLE_RATE } from './audio'
import { containerFor, contentTypeFor } from './container'
import { mmss, recDirName } from './format'
import { extractFrames } from './frames'
import { makeGrids, type GridFrame } from './grids'
import { probeClip } from './probe'
import {
  buildManifestTxt,
  buildRecordingJson,
  buildReport,
  buildTranscriptTxt,
  sheetFile,
  type ReportOptions,
} from './report'
import { slugify } from './slug'
import type {
  ClipInput,
  DistillStage,
  OutputFile,
  Recording,
  RecordingFrame,
  Session,
  StageProgress,
  TranscriberId,
  TranscriptSegment,
} from './types'

/**
 * The pipeline, end to end: already-recorded clips in, a complete walkthrough
 * file set out — deduped keyframes, 3×3 contact sheets, a transcript (when a
 * transcriber is plugged in), report.md and MANIFEST.txt. What happens to the
 * files afterwards — upload, zip, hand to an agent directly — is the caller's
 * business; every path is walkthrough-relative so the set moves as one folder.
 *
 * One clip at a time, on purpose: a phone has a few hundred MB of headroom and
 * a decoded minute of audio is ~2 MB of Float32 before the frames are counted.
 */

/** Speech-to-text over the decoded narration. Return null to ship without words — never throw for "no transcript". */
export type TranscribeFn = (
  audio: Float32Array,
  ctx: {
    /** Always `SAMPLE_RATE` (16 kHz mono). */
    sampleRate: number
    /** 0..1 through this clip's transcription. */
    onProgress: (fraction: number) => void
    signal?: AbortSignal
  }
) => Promise<TranscriptSegment[] | null>

export interface Transcriber {
  /** Lands in recording.json and the report's trust caveat ('whisper', 'groq', or any label). */
  id: TranscriberId
  run: TranscribeFn
}

/**
 * The cleanup pass after transcription: fix what a speech engine can't know —
 * product nouns, library names, acronyms. Must return the SAME number of
 * segments with only `text` changed, or null to keep the originals. Timings
 * never cross this boundary.
 */
export type Polisher = (
  segments: TranscriptSegment[],
  ctx: { signal?: AbortSignal }
) => Promise<TranscriptSegment[] | null>

export interface DistillOptions {
  title: string
  /** No transcriber = the walkthrough ships without words. */
  transcriber?: Transcriber
  /** No polisher = the transcript ships as transcribed. */
  polish?: Polisher
  onProgress?: (p: StageProgress) => void
  signal?: AbortSignal
  /** Branding/wording for report.md and MANIFEST.txt. */
  report?: ReportOptions
}

export interface DistillOutput {
  session: Session
  takes: Recording[]
  /** The whole file set: report.md, MANIFEST.txt, rec-NN/… — paths are walkthrough-relative. */
  files: OutputFile[]
  /** Same bytes as the `report.md` entry in `files`, for callers that want the text directly. */
  report: string
  manifest: string
  frameCount: number
  lineCount: number
  durationMs: number
  transcribed: boolean
  polished: boolean
}

export async function distill(clips: ClipInput[], opts: DistillOptions): Promise<DistillOutput> {
  if (!clips.length) throw new Error('pick a clip first')
  const count = clips.length
  const now = Date.now()

  const stop = () => {
    if (opts.signal?.aborted) throw new Error('cancelled')
  }
  /** Cancellation travels as an error like any other; it is the one nothing may swallow. */
  const cancelled = (error: unknown): boolean =>
    Boolean(opts.signal?.aborted) || (error instanceof Error && error.message === 'cancelled')
  /** Local progress within one clip, scaled onto the whole run. -1 stays -1. */
  const report = (stage: DistillStage, clipIdx: number, local: number, detail?: string) => {
    const pct = local < 0 ? -1 : (clipIdx + Math.min(1, Math.max(0, local))) / count
    opts.onProgress?.({ stage, pct, detail })
  }
  const text = (path: string, body: string): OutputFile => {
    const contentType = contentTypeFor(path)
    return { path, blob: new Blob([body], { type: contentType }), contentType }
  }

  // Phones name clips unhelpfully but stamp them honestly, so recording order is
  // the file's own mtime. Clips that carry none keep the order they were picked in.
  const ordered = clips
    .map((clip, position) => ({
      file: clip.file,
      probe: clip.probe,
      position,
      at: Number.isFinite(clip.file.lastModified) ? clip.file.lastModified : 0,
    }))
    .sort((a, b) => a.at - b.at || a.position - b.position)

  const session: Session = {
    id: crypto.randomUUID(),
    name: opts.title,
    slug: slugify(opts.title),
    createdAt: now,
    updatedAt: now,
    origin: '',
    recCount: clips.length,
  }

  const takes: Recording[] = []
  const files: OutputFile[] = []
  let transcribed = false
  let polished = false

  for (const [i, entry] of ordered.entries()) {
    stop()
    const file = entry.file
    const index = i + 1
    const dir = recDirName(index)
    const label = count > 1 ? `clip ${index} of ${count}` : file.name

    // Reading a clip is the most expensive thing that happens before any real
    // work does — a minute per clip on an iPhone, because readying a blob-URL
    // video there is slow. A picker UI already paid it, so when it hands its
    // probe over the pipeline takes it rather than decoding the file twice.
    report('probe', i, -1, label)
    const probe = entry.probe ?? (await probeClip(file))
    // The poster is for a picker screen; nothing here shows one. A borrowed
    // probe's poster belongs to whoever lent it — only revoke our own.
    if (!entry.probe && probe.posterUrl) URL.revokeObjectURL(probe.posterUrl)

    // Audio first, frames second, and the order is load-bearing. Decoding the
    // audio pulls the whole file in as an ArrayBuffer and then holds a Float32
    // channel of it — a spike measured in hundreds of MB on a long clip. Six
    // hundred JPEG blobs are a comparable pile. Overlapping the two is what kills
    // the tab, so the spike is taken and released before a single frame exists.
    let transcript: TranscriptSegment[] = []
    if (opts.transcriber) {
      report('audio', i, -1, label)
      let audio = await decodeMono(file)
      if (audio) {
        report('transcribe', i, 0, label)
        const heard = await opts.transcriber.run(audio, {
          sampleRate: SAMPLE_RATE,
          signal: opts.signal,
          onProgress: (fraction) => report('transcribe', i, fraction, label),
        })
        // Megabytes per minute of clip; the frames below need the room.
        audio = null
        if (heard) {
          transcribed = true
          transcript = heard
        }
      }
    }
    stop()

    let takePolished = false
    if (transcript.length && opts.polish) {
      report('polish', i, -1, label)
      const cleaned = await opts.polish(transcript, { signal: opts.signal })
      // A cleanup pass that changes the line count would desync every timing;
      // refuse it rather than ship a transcript that disagrees with itself.
      if (cleaned && cleaned.length === transcript.length) {
        transcript = cleaned
        takePolished = true
        polished = true
      }
    }
    stop()

    // Keyframes and the contact sheets drawn from them are best-effort, and they
    // are the only stage that is. A decoder that will not step through a long
    // recording — the iOS case this exists for — costs the walkthrough its
    // stills; it must not cost the walkthrough. Video, transcript and report all
    // ship regardless, and the take degrades to zero frames.
    //
    // The rollback is the whole stage at once: half a set of frames with no
    // sheets would leave report.md citing grid files nobody wrote.
    let kept: RecordingFrame[] = []
    let sampled = 0
    const framesMark = files.length
    try {
      let frames: RecordingFrame[] = []
      let frameBlobs = new Map<number, Blob>()
      if (probe.hasVideo) {
        const total = mmss(probe.durationMs)
        report('frames', i, 0, `0:00 of ${total}`)
        const extracted = await extractFrames(file, probe.durationMs, {
          signal: opts.signal,
          onProgress: (fraction) =>
            report('frames', i, fraction, `${mmss(fraction * probe.durationMs)} of ${total}`),
        })
        frames = extracted.frames
        frameBlobs = extracted.blobs
        sampled = extracted.sampled
      }
      stop()

      // Only frames whose JPEG exists ship, and the take carries only those — the
      // report's citations, the sheets and the counts then all describe what is
      // actually in the set.
      const gridFrames: GridFrame[] = []
      for (const frame of frames) {
        const blob = frameBlobs.get(frame.index)
        if (!blob) continue
        files.push({ path: `${dir}/${frame.file}`, blob, contentType: contentTypeFor(frame.file) })
        kept.push(frame)
        gridFrames.push({ blob, label: frame.file.split('/').pop() ?? frame.file })
      }
      // `files` owns every surviving blob now; the extractor's own map does not.
      frameBlobs = new Map()
      frames = []

      if (gridFrames.length) {
        report('sheets', i, 0, label)
        // Nine at a time in frame order — exactly how report.ts maps a frame to its sheet.
        for (const [n, sheet] of (await makeGrids(gridFrames)).entries()) {
          const path = sheetFile(n + 1, `${dir}/`)
          files.push({ path, blob: sheet, contentType: contentTypeFor(path) })
        }
        // The sheets are drawn; these were only ever the source pixels.
        gridFrames.length = 0
      }
    } catch (error) {
      if (cancelled(error)) throw error
      files.length = framesMark
      kept = []
      sampled = 0
      report('frames', i, 1, 'keyframes unavailable — shipping video + transcript')
    }
    stop()

    const container = containerFor(file.type, probe.hasVideo)
    const startedAt = entry.at || now
    const take: Recording = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      index,
      createdAt: startedAt,
      state: 'done',
      mime: file.type,
      chunks: 0,
      meta: {
        startedAt,
        durationMs: probe.durationMs,
        sampled,
        frames: kept,
        transcript,
        ...(transcript.length && opts.transcriber ? { transcriber: opts.transcriber.id } : {}),
        ...(takePolished ? { polished: true } : {}),
        events: [],
        videoFile: container.videoFile,
      },
    }
    takes.push(take)
    // Both are written even when the take has neither frames nor words — a
    // reader of the format counts on them existing.
    files.push(text(`${dir}/transcript.txt`, buildTranscriptTxt(take.meta)))
    files.push(text(`${dir}/recording.json`, buildRecordingJson(session, take, opts.report?.url)))
    files.push({
      path: `${dir}/${container.videoFile}`,
      blob: file,
      contentType: container.contentType,
    })
  }

  stop()
  // The summaries describe the whole set, so they go last — written from the
  // takes as shipped, not as recorded.
  opts.onProgress?.({ stage: 'build', pct: -1 })
  const reportMd = buildReport(session, takes, opts.report)
  const manifest = buildManifestTxt(session, takes, opts.report)
  files.push(text('report.md', reportMd))
  files.push(text('MANIFEST.txt', manifest))

  return {
    session,
    takes,
    files,
    report: reportMd,
    manifest,
    frameCount: takes.reduce((n, t) => n + t.meta.frames.length, 0),
    lineCount: takes.reduce((n, t) => n + t.meta.transcript.length, 0),
    durationMs: takes.reduce((n, t) => n + t.meta.durationMs, 0),
    transcribed,
    polished,
  }
}
