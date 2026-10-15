/**
 * Replay a dumped signature stream through `Selector` and score it, no browser.
 *
 *   bun test/browser/tune.ts <file.sig> [--truth truth.json] [--narration narration.json]
 *
 * The fast loop for selection rules: dump once with sigdump.ts, then iterate
 * select.ts here in milliseconds.
 */

import { readFile } from 'node:fs/promises'
import { Selector, type NarrationWindow } from '../../src/select.ts'
import { score } from './eval.ts'
import type { Truth } from './fixtures.ts'
import { loadDump } from './sigdump.ts'

export async function replay(path: string, narration?: NarrationWindow[]) {
  const { dump, lumas } = await loadDump(path)
  const sel = new Selector({ durationMs: dump.durationMs, budget: 150, narration })
  for (let i = 0; i < lumas.length; i++) {
    sel.push(dump.times[i] ?? 0, {
      cols: dump.cols,
      rows: dump.rows,
      luma: lumas[i] ?? new Uint8Array(),
    })
  }
  sel.finish()
  return sel.picks()
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const narrationPath = flag('--narration')
  const narration = narrationPath
    ? (JSON.parse(await readFile(narrationPath, 'utf8')) as NarrationWindow[][])[0]
    : undefined
  const picks = await replay(argv[0] ?? '', narration)
  for (const p of picks) {
    const box = p.change ? ` box ${p.change.x},${p.change.y} ${p.change.w}×${p.change.h}` : ''
    console.log(
      `${String(p.t).padStart(6)} ${p.reason.padEnd(9)} dist=${String(p.dist ?? '-').padStart(5)} held=${String(p.held ?? '-').padStart(5)}${box}`
    )
  }
  const truthPath = flag('--truth')
  if (truthPath) {
    const truth = JSON.parse(await readFile(truthPath, 'utf8')) as Truth
    const s = score(
      truth,
      picks.map((p) => ({ tMs: p.t }))
    )
    console.log(
      `${s.caught}/${s.events.filter((e) => !e.optional).length} states · ${s.frames} frames · noise ${s.noise.map((n) => `${n.frames}/${n.allowed}`).join(' ')}`
    )
    for (const e of s.events) if (!e.hit) console.log(`  ${e.optional ? '·' : '✗'} ${e.name}`)
  }
}
