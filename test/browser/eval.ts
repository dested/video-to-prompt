/**
 * Score keyframe extraction against fixture ground truth.
 *
 *   bun test/browser/eval.ts [--ref <git-ref>] [--label <name>]…
 *
 * Runs each fixture clip (webm + mp4) through the chosen source tree in headless
 * Chrome and reports, per clip: which ground-truth states got a keyframe and how
 * late, how many frames landed in noise-only stretches, total frames and wall
 * time. `--ref HEAD --ref ''` compares a committed version with the working tree.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { makeAppFixture, type Truth } from './fixtures.ts'
import { runDistill } from './run.ts'

interface FrameRow {
  tMs: number
}

export interface Score {
  label: string
  clip: string
  frames: number
  ms: number
  caught: number
  events: { name: string; hit: boolean; latencyMs: number | null; optional?: boolean }[]
  noise: { name: string; frames: number; allowed: number }[]
}

export function score(truth: Truth, frames: FrameRow[]): Omit<Score, 'label' | 'clip' | 'ms'> {
  const ts = frames.map((f) => f.tMs).sort((a, b) => a - b)
  const events = truth.events.map((e) => {
    const first = ts.find((t) => t >= e.at && t < e.until)
    return {
      name: e.name,
      hit: first !== undefined,
      latencyMs: first === undefined ? null : first - e.at,
      optional: e.optional,
    }
  })
  // A frame inside a noise stretch is waste unless an event also lives there.
  const noise = truth.noise.map((n) => ({
    name: n.name,
    allowed: n.allowed,
    frames: ts.filter(
      (t) => t >= n.at && t < n.until && !truth.events.some((e) => t >= e.at && t < e.until)
    ).length,
  }))
  return {
    frames: ts.length,
    caught: events.filter((e) => e.hit && !e.optional).length,
    events,
    noise,
  }
}

function arg(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === name) out.push(process.argv[i + 1] ?? '')
  })
  return out
}

if (import.meta.main) {
  const dir = resolve(import.meta.dir, '../.fixtures/app')
  if (!existsSync(join(dir, 'app.webm'))) await makeAppFixture(dir)
  const truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8')) as Truth
  const narration = JSON.parse(await readFile(join(dir, 'narration.json'), 'utf8'))
  const refs = arg('--ref')
  const labels = arg('--label')
  const configs = (refs.length ? refs : ['']).map((ref, i) => ({
    ref: ref || undefined,
    label: labels[i] ?? (ref || 'working tree'),
  }))

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  const scores: Score[] = []
  try {
    for (const config of configs) {
      for (const clip of ['app.webm', 'app.mp4']) {
        const out = resolve(import.meta.dir, '../.runs', config.label.replace(/\W+/g, '-'), clip)
        const result = await runDistill({
          clips: [join(dir, clip)],
          out,
          ref: config.ref,
          browser,
          transcripts: narration,
          title: 'Ledgerly invoices: total wrong, payment failed',
        })
        const rec = JSON.parse(await readFile(join(out, 'rec-01/recording.json'), 'utf8'))
        scores.push({
          label: config.label,
          clip,
          ms: result.ms,
          ...score(truth, rec.recording.frames),
        })
      }
    }
  } finally {
    await browser.close()
  }

  for (const s of scores) {
    const noise = s.noise.map((n) => `${n.name} ${n.frames}/${n.allowed}`).join(', ')
    console.log(
      `\n${s.label} · ${s.clip}: ${s.caught}/${s.events.filter((e) => !e.optional).length} states · ${s.frames} frames · ${(s.ms / 1000).toFixed(1)}s · noise: ${noise}`
    )
    for (const e of s.events) {
      console.log(
        `  ${e.hit ? '✓' : e.optional ? '·' : '✗'} ${e.name}${e.latencyMs === null ? '' : ` (+${e.latencyMs}ms)`}`
      )
    }
  }
}
