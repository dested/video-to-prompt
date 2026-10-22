/**
 * LiveFrames end to end in headless Chrome, on a recorded clip standing in for
 * a screen share. Its frames should be the extractor's: compare the two with
 * test/compare/build.ts.
 *
 *   bun test/browser/live.ts <clip> --out <dir> --duration <ms>
 *       [--transcript <json>]   narration [[{t,d,text},…]]: speech opened and closed from it
 *       [--crop x,y,w,h]
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { z } from 'zod'
import type { LiveRequest } from './live-page.ts'

const repo = resolve(import.meta.dir, '../..')

const Narration = z.array(z.array(z.object({ t: z.number(), d: z.number().optional(), text: z.string() })))

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const clip = process.argv[2]
const outArg = arg('--out')
const duration = Number(arg('--duration'))
if (!clip || clip.startsWith('--') || !outArg || !duration) {
  console.error('usage: bun test/browser/live.ts <clip> --out <dir> --duration <ms> [--transcript <json>] [--crop x,y,w,h]')
  process.exit(1)
}
const out = resolve(outArg)
const transcriptPath = arg('--transcript')
const lines = transcriptPath
  ? (Narration.parse(JSON.parse(await readFile(transcriptPath, 'utf8')))[0] ?? []).map((l) => ({
      t: l.t,
      d: l.d ?? 2000,
      text: l.text,
    }))
  : []
const cropArg = arg('--crop')
const [x = 0, y = 0, w = 1, h = 1] = (cropArg ?? '').split(',').filter(Boolean).map(Number)

const outDir = join(repo, 'test/browser/.out/live')
await mkdir(outDir, { recursive: true })
const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'live-page.ts')], outdir: outDir, target: 'browser' })
if (!built.success) throw new Error(built.logs.map(String).join('\n'))
const script = join(outDir, 'live-page.js')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const clipPath = resolve(clip)

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(
        '<!doctype html><meta charset="utf-8"><body><script type="module" src="/page.js"></script></body>',
        { headers: { 'content-type': 'text/html' } }
      )
    }
    if (url.pathname === '/page.js') {
      return new Response(Bun.file(script), { headers: { 'content-type': 'text/javascript' } })
    }
    if (url.pathname === '/clip.webm') return new Response(Bun.file(clipPath))
    if (req.method === 'PUT' && url.pathname.startsWith('/out/')) {
      const rel = decodeURIComponent(url.pathname).split('/').slice(3).join('/')
      if (rel.includes('..')) return new Response('bad path', { status: 400 })
      const target = join(out, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, new Uint8Array(await req.arrayBuffer()))
      return new Response('ok')
    }
    return new Response('not found', { status: 404 })
  },
})

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => Boolean(window.v2pLive))
  const req: LiveRequest = {
    url: '/clip.webm',
    durationMs: duration,
    lines,
    outPrefix: 'run',
    ...(cropArg ? { crop: { x, y, w, h } } : {}),
  }
  const result = await page.evaluate((r) => window.v2pLive.run(r), req)
  if (errors.length) console.error(errors.join('\n'))
  console.log(`${result.frameCount} frames · ${result.sampled} candidates · ${(result.ms / 1000).toFixed(1)}s run`)
} finally {
  await browser.close()
  server.stop(true)
}
