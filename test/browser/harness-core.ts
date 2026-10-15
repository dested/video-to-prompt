/**
 * The page side of the browser harness: runs `distill` on a fixture the server
 * hosts and PUTs every output file back, so a real Chrome run lands on disk as
 * the same folder a consumer would upload. Library-agnostic on purpose: the
 * runner builds one entry per source tree (this checkout, or an older snapshot)
 * and hands its module in through `install`, so old and new run the same way.
 */

interface HarnessFile {
  path: string
  blob: Blob
}

interface HarnessSegment {
  t: number
  d?: number
  text: string
  speaker?: number
}

/** The slice of the public API the harness drives — v1 and v2 both satisfy it. */
export interface HarnessLib {
  distill(
    clips: { file: File }[],
    opts: {
      title: string
      transcriber?: {
        id: string
        run: (
          audio: Float32Array
        ) => Promise<HarnessSegment[] | { segments: HarnessSegment[]; label?: string } | null>
      }
      report?: Record<string, unknown>
      onProgress?: (p: { stage: string; pct: number; detail?: string }) => void
    }
  ): Promise<{ files: HarnessFile[]; frameCount: number; lineCount: number; durationMs: number }>
}

export interface RunRequest {
  /** Server path of each clip, in recording order. */
  clips: { url: string; name: string; type: string; lastModified?: number }[]
  title: string
  outPrefix: string
  /** Scripted narration per clip, returned by a stand-in transcriber (ms from clip start). */
  transcripts?: HarnessSegment[][]
  transcriberId?: string
  /** The stand-in transcriber answers `{ segments, label }`, naming the engine as a router would (v2 1.1.3+). */
  heardLabel?: string
  report?: Record<string, unknown>
  /** Extra options merged into the distill call (v2-only knobs). */
  extra?: Record<string, unknown>
}

export interface RunResult {
  ms: number
  frameCount: number
  lineCount: number
  durationMs: number
  files: { path: string; bytes: number }[]
  stages: { stage: string; at: number; detail?: string }[]
}

declare global {
  interface Window {
    v2p: { run(req: RunRequest): Promise<RunResult> }
  }
}

export function install(lib: HarnessLib): void {
  window.v2p = {
    async run(req) {
      const started = performance.now()
      const clips: { file: File }[] = []
      for (const clip of req.clips) {
        const res = await fetch(clip.url)
        if (!res.ok) throw new Error(`fixture ${clip.url}: ${res.status}`)
        const blob = await res.blob()
        clips.push({
          file: new File([blob], clip.name, {
            type: clip.type,
            lastModified: clip.lastModified ?? Date.now(),
          }),
        })
      }

      // Clips are sorted by lastModified inside distill; the scripted transcripts
      // follow the request order, so hand them out by which file is asking.
      const byName = new Map(req.clips.map((c, i) => [c.name, req.transcripts?.[i] ?? null]))
      let calls = 0
      const order = [...req.clips].sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0))
      const transcriber = req.transcripts
        ? {
            id: req.transcriberId ?? 'scripted',
            label: req.transcriberId ? undefined : 'a script (the fixture narration)',
            run: async () => {
              const clip = order[calls++]
              const segments = clip ? (byName.get(clip.name) ?? null) : null
              return segments && req.heardLabel ? { segments, label: req.heardLabel } : segments
            },
          }
        : undefined

      const stages: RunResult['stages'] = []
      let last = ''
      const out = await lib.distill(clips, {
        title: req.title,
        transcriber,
        report: req.report,
        onProgress: (p) => {
          if (p.stage === last) return
          last = p.stage
          stages.push({
            stage: p.stage,
            at: Math.round(performance.now() - started),
            detail: p.detail,
          })
        },
        ...req.extra,
      })

      const files: RunResult['files'] = []
      for (const file of out.files) {
        const res = await fetch(`/out/${req.outPrefix}/${file.path}`, {
          method: 'PUT',
          body: file.blob,
        })
        if (!res.ok) throw new Error(`upload ${file.path}: ${res.status}`)
        files.push({ path: file.path, bytes: file.blob.size })
      }
      return {
        ms: Math.round(performance.now() - started),
        frameCount: out.frameCount,
        lineCount: out.lineCount,
        durationMs: out.durationMs,
        files,
        stages,
      }
    },
  }
}
