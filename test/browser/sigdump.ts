/**
 * Dump a clip's signature stream for offline tuning.
 *
 *   bun test/browser/sigdump.ts <clip> --out <file.sig> [--step 250] [--engine webcodecs|seek]
 *
 * Decodes the clip in headless Chrome through the library's own FrameSource
 * and signature code, and writes every candidate's luma grid to disk:
 * `<file.sig>.json` (header + times) and `<file.sig>` (the grids back to back).
 * Selection logic is pure, so it can then be iterated in Bun against real
 * streams without a browser in the loop.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const repo = resolve(import.meta.dir, '../..')

export interface SigDump {
  clip: string
  engine: string
  cols: number
  rows: number
  width: number
  height: number
  stepMs: number
  durationMs: number
  times: number[]
  ms: number
}

const PAGE_ENTRY = `
import { openFrameSource } from ${JSON.stringify(join(repo, 'src/decode.ts'))}
import { SIG_COLS, sigRows } from ${JSON.stringify(join(repo, 'src/signature.ts'))}
window.dump = async ({ url, name, type, stepMs, durationMs, engine, sigCols, sigRowsOverride }) => {
  const started = performance.now()
  const blob = await (await fetch(url)).blob()
  const file = new File([blob], name, { type })
  const source = await openFrameSource(file, { engine })
  const times = []
  for (let t = 0; t < durationMs; t += stepMs) times.push(t)
  if (times[times.length - 1] < durationMs - 50) times.push(durationMs - 50)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out = []
  let cols = 0, rows = 0, width = 0, height = 0
  const got = []
  for await (const f of source.frames(times)) {
    if (!cols) {
      cols = sigCols || SIG_COLS; rows = sigRowsOverride || Math.round(sigRows(f.width, f.height) * cols / SIG_COLS); width = f.width; height = f.height
      canvas.width = cols; canvas.height = rows
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
    }
    f.draw(ctx, cols, rows)
    const rgba = ctx.getImageData(0, 0, cols, rows).data
    const luma = new Uint8Array(cols * rows)
    for (let i = 0; i < luma.length; i++) luma[i] = (77 * rgba[i*4] + 150 * rgba[i*4+1] + 29 * rgba[i*4+2]) >> 8
    out.push(luma)
    got.push(f.t)
  }
  const engineUsed = source.engine
  source.close()
  const all = new Uint8Array(out.length * cols * rows)
  out.forEach((l, i) => all.set(l, i * cols * rows))
  await fetch('/sig', { method: 'PUT', body: all })
  return { engine: engineUsed, cols, rows, width, height, times: got, ms: Math.round(performance.now() - started) }
}
`

export async function sigDump(
  clip: string,
  out: string,
  stepMs: number,
  engine: string,
  durationMs: number,
  sigCols = 0,
  sigRowsOverride = 0
): Promise<SigDump> {
  const outDir = join(repo, 'test/browser/.out/sigdump')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'entry.ts'), PAGE_ENTRY)
  const built = await Bun.build({
    entrypoints: [join(outDir, 'entry.ts')],
    outdir: outDir,
    target: 'browser',
  })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  let sig: Uint8Array | null = null
  const server = Bun.serve({
    port: 0,
    // An hour of grids comes back as one PUT.
    maxRequestBodySize: 4 * 1024 ** 3,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/') {
        return new Response(
          '<!doctype html><body><script type="module" src="/entry.js"></script></body>',
          {
            headers: { 'content-type': 'text/html' },
          }
        )
      }
      if (url.pathname === '/entry.js')
        return new Response(Bun.file(join(outDir, 'entry.js')), {
          headers: { 'content-type': 'text/javascript' },
        })
      if (url.pathname === '/clip') return new Response(Bun.file(clip))
      if (url.pathname === '/sig' && req.method === 'PUT') {
        sig = new Uint8Array(await req.arrayBuffer())
        return new Response('ok')
      }
      return new Response('nf', { status: 404 })
    },
  })
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForFunction(() => 'dump' in window)
    const type = clip.endsWith('.mp4') ? 'video/mp4' : 'video/webm'
    const res = await page.evaluate(
      (a) =>
        (
          window as unknown as {
            dump(x: typeof a): Promise<Omit<SigDump, 'clip' | 'stepMs' | 'durationMs'>>
          }
        ).dump(a),
      {
        url: '/clip',
        name: basename(clip),
        type,
        stepMs,
        durationMs,
        engine,
        sigCols,
        sigRowsOverride,
      }
    )
    if (!sig) throw new Error('no signature upload')
    const dump: SigDump = { clip, stepMs, durationMs, ...res }
    await mkdir(dirname(resolve(out)), { recursive: true })
    await writeFile(out, sig)
    await writeFile(`${out}.json`, JSON.stringify(dump))
    return dump
  } finally {
    await browser.close()
    server.stop(true)
  }
}

export async function loadDump(path: string): Promise<{ dump: SigDump; lumas: Uint8Array[] }> {
  const dump = JSON.parse(await readFile(`${path}.json`, 'utf8')) as SigDump
  const all = new Uint8Array(await readFile(path))
  const n = dump.cols * dump.rows
  const lumas = dump.times.map((_, i) => all.subarray(i * n, (i + 1) * n))
  return { dump, lumas }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const clip = argv[0]
  const out = flag('--out')
  const duration = Number(flag('--duration'))
  if (!clip || !out || !duration) {
    console.error(
      'usage: bun test/browser/sigdump.ts <clip> --out <file.sig> --duration <ms> [--step 250] [--engine auto]'
    )
    process.exit(1)
  }
  const d = await sigDump(
    resolve(clip),
    out,
    Number(flag('--step') ?? 250),
    flag('--engine') ?? 'auto',
    duration,
    Number(flag('--cols') ?? 0),
    Number(flag('--rows') ?? 0)
  )
  console.log(`${d.times.length} frames ${d.cols}×${d.rows} via ${d.engine} in ${d.ms} ms`)
}
