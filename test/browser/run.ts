/**
 * Run the real pipeline in headless Chrome and write the package to disk.
 *
 *   bun test/browser/run.ts <clip> [<clip>…] --out <dir>
 *       [--ref <git-ref>]          run an older checkout's src/ instead of this one
 *       [--transcript <json>]      scripted narration: [[{t,d,text},…] per clip]
 *       [--title <text>] [--extra <json>]
 *
 * The library is browser-only, so this is how it is exercised end to end: the
 * runner bundles a harness for the chosen source tree, serves it with the clips,
 * drives `distill` through Playwright and receives every output file by PUT.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { $ } from 'bun'
import { chromium, type Browser } from 'playwright-core'
import type { RunRequest, RunResult } from './harness-core.ts'

const repo = resolve(import.meta.dir, '../..')

const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
}

export interface RunOptions {
  clips: string[]
  out: string
  /** Git ref whose src/ to run; omitted = the working tree. */
  ref?: string
  transcripts?: RunRequest['transcripts']
  transcriberId?: string
  title?: string
  extra?: Record<string, unknown>
  report?: Record<string, unknown>
  /** Reuse a browser across runs (eval.ts runs many). */
  browser?: Browser
}

/** Materialise `<ref>:src/` into a cache dir so an old version bundles like the new one. */
async function srcFor(ref: string | undefined): Promise<string> {
  if (!ref) return join(repo, 'src')
  const sha = (await $`git -C ${repo} rev-parse ${ref}`.text()).trim()
  const dir = join(repo, 'test/.runs/src', sha.slice(0, 12))
  const files = (await $`git -C ${repo} ls-tree -r --name-only ${sha} src`.text())
    .split('\n')
    .filter(Boolean)
  for (const file of files) {
    const body = await $`git -C ${repo} show ${sha}:${file}`.text()
    const target = join(dir, file.slice('src/'.length))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return dir
}

async function bundle(srcRoot: string): Promise<string> {
  const label = srcRoot === join(repo, 'src') ? 'head' : basename(srcRoot)
  const outDir = join(repo, 'test/browser/.out', label)
  await mkdir(outDir, { recursive: true })
  const entry = join(outDir, 'entry.ts')
  await writeFile(
    entry,
    `import * as lib from ${JSON.stringify(join(srcRoot, 'index.ts'))}\n` +
      `import { install } from ${JSON.stringify(join(repo, 'test/browser/harness-core.ts'))}\n` +
      `install(lib)\n`
  )
  const built = await Bun.build({ entrypoints: [entry], outdir: outDir, target: 'browser' })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  return join(outDir, 'entry.js')
}

export async function runDistill(opts: RunOptions): Promise<RunResult> {
  const script = await bundle(await srcFor(opts.ref))
  const out = resolve(opts.out)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const clips = opts.clips.map((path, i) => ({
    path: resolve(path),
    url: `/clip/${i}/${basename(path)}`,
    name: basename(path),
    type: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    // Spaced a minute apart in argument order: distill orders takes by mtime.
    lastModified: Date.UTC(2026, 9, 15, 12, i),
  }))

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/') {
        return new Response(
          '<!doctype html><meta charset="utf-8"><body><script type="module" src="/harness.js"></script></body>',
          { headers: { 'content-type': 'text/html' } }
        )
      }
      if (url.pathname === '/harness.js') {
        return new Response(Bun.file(script), { headers: { 'content-type': 'text/javascript' } })
      }
      const clip = clips.find((c) => c.url === decodeURIComponent(url.pathname))
      if (clip) return new Response(Bun.file(clip.path))
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

  const browser =
    opts.browser ??
    (await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }))
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForFunction(() => Boolean(window.v2p))
    const req: RunRequest = {
      clips: clips.map(({ url, name, type, lastModified }) => ({ url, name, type, lastModified })),
      title: opts.title ?? 'Fixture walkthrough',
      outPrefix: 'run',
      transcripts: opts.transcripts,
      transcriberId: opts.transcriberId,
      report: opts.report,
      extra: opts.extra,
    }
    const result = await page.evaluate((r) => window.v2p.run(r), req)
    await page.close()
    if (errors.length) result.stages.push({ stage: 'pageerror', at: 0, detail: errors.join(' | ') })
    await writeFile(join(out, '.run.json'), JSON.stringify(result, null, 2))
    return result
  } finally {
    if (!opts.browser) await browser.close()
    server.stop(true)
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const flags = new Set(['--out', '--ref', '--transcript', '--title', '--extra'])
  const clips = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith('--') && !flags.has(all[i - 1] ?? ''))
  const out = arg('--out')
  if (!clips.length || !out) {
    console.error(
      'usage: bun test/browser/run.ts <clip>… --out <dir> [--ref <ref>] [--transcript <json>]'
    )
    process.exit(1)
  }
  const transcriptPath = arg('--transcript')
  const extra = arg('--extra')
  const result = await runDistill({
    clips,
    out,
    ref: arg('--ref'),
    title: arg('--title'),
    transcripts: transcriptPath ? JSON.parse(await readFile(transcriptPath, 'utf8')) : undefined,
    extra: extra ? JSON.parse(extra) : undefined,
  })
  console.log(
    `${result.frameCount} frames · ${result.lineCount} lines · ${(result.durationMs / 1000).toFixed(1)}s video · ${(result.ms / 1000).toFixed(1)}s run`
  )
  for (const s of result.stages)
    console.log(`  ${String(s.at).padStart(6)}ms ${s.stage}${s.detail ? ` — ${s.detail}` : ''}`)
}
