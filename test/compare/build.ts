/**
 * Side-by-side viewer: what two packages of the same recording kept, against the source.
 *
 *   bun test/compare/build.ts --name <take> --old <rec dir> --new <rec dir> --out <dir>
 *       [--video <clip>] [--note <text>] [--old-label <text>] [--new-label <text>]
 *
 * A rec dir is a package's recording folder (recording.json + frames/). Writes
 * `<out>/<take>.html` (static, opens from disk: images and video load by
 * relative path) and `<out>/<take>.json` (its summary), then rebuilds
 * `<out>/index.html` from every summary there.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'

const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const Frame = z.object({
  index: z.number(),
  tMs: z.number(),
  file: z.string(),
  reason: z.string(),
  held: z.number().optional(),
  change: Box.optional(),
  detail: z.object({ of: z.number(), box: Box }).optional(),
  seenMs: z.array(z.tuple([z.number(), z.number()])).optional(),
})
const Line = z.object({ tMs: z.number(), endMs: z.number().optional(), text: z.string() })
const Recording = z.object({
  durationMs: z.number(),
  frames: z.array(Frame),
  transcript: z.array(Line),
})
const Package = z.union([
  z.object({ recording: Recording }).transform((p) => p.recording),
  Recording,
])

type Frame = z.infer<typeof Frame>

export interface Side {
  label: string
  /** Frame image paths relative to the page. */
  frames: (Omit<Frame, 'file'> & { src: string })[]
}

export interface Summary {
  name: string
  note: string
  durationMs: number
  old: { label: string; frames: number; details: number }
  new: { label: string; frames: number; details: number }
}

async function side(dir: string, out: string, label: string) {
  const rec = Package.parse(JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8')))
  const frames = rec.frames.map(({ file, ...f }) => ({ ...f, src: relative(out, join(dir, file)) }))
  return { rec, side: { label, frames } satisfies Side }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

async function main() {
  const argv = process.argv.slice(2)
  const name = flag(argv, '--name')
  const oldDir = flag(argv, '--old')
  const newDir = flag(argv, '--new')
  const outArg = flag(argv, '--out')
  if (!name || !oldDir || !newDir || !outArg) {
    console.error('usage: bun test/compare/build.ts --name <take> --old <dir> --new <dir> --out <dir> [--video <clip>]')
    process.exit(1)
  }
  const out = resolve(outArg)
  await mkdir(out, { recursive: true })
  const a = await side(resolve(oldDir), out, flag(argv, '--old-label') ?? 'Old')
  const b = await side(resolve(newDir), out, flag(argv, '--new-label') ?? 'New')
  const video = flag(argv, '--video')
  const note = flag(argv, '--note') ?? ''
  const data = {
    name,
    note,
    durationMs: b.rec.durationMs,
    video: video ? relative(out, resolve(video)) : null,
    transcript: b.rec.transcript.length ? b.rec.transcript : a.rec.transcript,
    old: a.side,
    new: b.side,
  }
  const count = (s: Side) => ({
    label: s.label,
    frames: s.frames.length,
    details: s.frames.filter((f) => f.detail).length,
  })
  const summary: Summary = {
    name,
    note,
    durationMs: data.durationMs,
    old: count(a.side),
    new: count(b.side),
  }
  await writeFile(join(out, `${name}.html`), page(data))
  await writeFile(join(out, `${name}.json`), JSON.stringify(summary))
  const summaries: Summary[] = []
  for (const f of (await readdir(out)).filter((f) => f.endsWith('.json')).sort())
    summaries.push(JSON.parse(await readFile(join(out, f), 'utf8')) as Summary)
  await writeFile(join(out, 'index.html'), index(summaries))
  console.log(`${join(out, `${name}.html`)} · old ${summary.old.frames} · new ${summary.new.frames}`)
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

const STYLE = `
:root { --bg:#f6f5f2; --panel:#fff; --ink:#1d1d1f; --mute:#6b6b70; --line:#dedcd6; --old:#5b6b8c; --new:#1f7a5a; --detail:#7fb89f; --hi:#2457d6; }
* { box-sizing: border-box }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif }
a { color:var(--hi) }
h1 { font-size:18px; margin:0 }
.mute { color:var(--mute) }
`

function index(all: Summary[]): string {
  const rows = all
    .map(
      (s) => `<tr><td><a href="${esc(s.name)}.html">${esc(s.name)}</a></td><td>${mmss(s.durationMs)}</td>
<td>${s.old.frames}${s.old.details ? ` <span class="mute">(${s.old.details} close-ups)</span>` : ''}</td>
<td>${s.new.frames} <span class="mute">(${s.new.frames - s.new.details} full, ${s.new.details} close-ups)</span></td>
<td class="mute">${esc(s.note)}</td></tr>`
    )
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Capture compare</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}
main { max-width:1100px; margin:32px auto; padding:0 16px }
table { border-collapse:collapse; width:100%; background:var(--panel); border:1px solid var(--line); margin-top:16px }
td, th { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top }
th { font-weight:600; color:var(--mute); font-size:12px }
</style></head><body><main>
<h1>Capture compare</h1>
<p class="mute">Each take: the source, what the old pipeline kept and what the new one keeps, at every moment</p>
<table><tr><th>Take</th><th>Length</th><th>Old</th><th>New</th><th>Note</th></tr>
${rows}
</table></main></body></html>`
}

function page(data: object): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Capture compare</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}
header { display:flex; gap:16px; align-items:baseline; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap }
header .stats { display:flex; gap:16px; flex-wrap:wrap }
header .keys { margin-left:auto; font-size:12px }
kbd { font:11px ui-monospace, monospace; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; background:var(--bg) }
.wrap { padding:12px 16px; display:flex; flex-direction:column; gap:12px }
.src { background:#000; border-radius:6px; overflow:hidden; display:flex; justify-content:center }
.src video { max-width:100%; max-height:28vh; display:block }
.src.hidden { display:none }
.pair { display:grid; grid-template-columns:1fr 1fr; gap:12px }
body.stacked .pair { grid-template-columns:1fr }
@media (max-width: 800px) { .pair { grid-template-columns:1fr } }
.stage img { cursor:zoom-in }
.pane { background:var(--panel); border:1px solid var(--line); border-radius:6px; overflow:hidden; display:flex; flex-direction:column }
.pane .bar { display:flex; gap:8px; padding:6px 10px; border-bottom:1px solid var(--line); font-size:12px; align-items:baseline }
.pane .bar b { font-size:13px }
.pane .bar .age { margin-left:auto }
.frame { background:#eceae4; display:flex; justify-content:center }
.stage { position:relative; line-height:0; width:fit-content }
.stage img.base { display:block; max-width:100%; max-height:68vh }
.stage img.detail { position:absolute; outline:2px solid var(--new); box-shadow:0 0 0 9999px rgba(0,0,0,.18) }
.stage .tag { position:absolute; left:8px; top:8px; background:var(--new); color:#fff; font-size:11px; line-height:1; padding:4px 6px; border-radius:3px }
.old .bar b { color:var(--old) } .new .bar b { color:var(--new) }
.stale { color:#b3261e }
.timeline { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:8px 10px }
canvas { width:100%; height:86px; display:block; cursor:pointer }
.now { display:flex; gap:12px; align-items:baseline; font-size:13px; margin-top:6px }
.now .t { font:600 15px ui-monospace, monospace }
.lines { font-size:13px; display:flex; flex-direction:column; gap:2px }
.lines div { padding:2px 6px; border-radius:3px; cursor:pointer }
.lines div.cur { background:#e8eefc }
.lines div span { font:12px ui-monospace, monospace; color:var(--mute); margin-right:8px }
.grid { display:none }
body.gridmode .grid { display:block }
body.gridmode .compare { display:none }
.minute { display:grid; grid-template-columns:56px 1fr 1fr; gap:10px; padding:8px 0; border-bottom:1px solid var(--line) }
.minute .m { font:600 13px ui-monospace, monospace; color:var(--mute) }
.thumbs { display:flex; flex-wrap:wrap; gap:4px; align-content:flex-start }
.thumbs figure { margin:0; width:132px; cursor:pointer }
.thumbs img { width:132px; display:block; border:1px solid var(--line); background:#eceae4 }
.thumbs figure.d img { border-color:var(--detail); border-width:2px }
.thumbs figcaption { font:11px ui-monospace, monospace; color:var(--mute); line-height:1.3 }
.gridhead { display:grid; grid-template-columns:56px 1fr 1fr; gap:10px; font-weight:600; position:sticky; top:0; background:var(--bg); padding:6px 0; z-index:1 }
</style></head><body>
<script type="application/json" id="data">${json}</script>
<header>
  <h1 id="title"></h1>
  <div class="stats" id="stats"></div>
  <div class="keys mute">
    <kbd>←</kbd><kbd>→</kbd> line · <kbd>,</kbd><kbd>.</kbd> 1 s · <kbd>[</kbd><kbd>]</kbd> old frame · <kbd>{</kbd><kbd>}</kbd> new frame · <kbd>space</kbd> play · <kbd>v</kbd> video · <kbd>s</kbd> stack · <kbd>g</kbd> grid · click a frame for full size
  </div>
</header>
<div class="wrap compare">
  <div class="src" id="src"><video id="video" muted playsinline preload="auto"></video></div>
  <div class="pair">
    <div class="pane old"><div class="bar" id="oldbar"></div><div class="frame"><div class="stage" id="oldstage"></div></div></div>
    <div class="pane new"><div class="bar" id="newbar"></div><div class="frame"><div class="stage" id="newstage"></div></div></div>
  </div>
  <div class="timeline">
    <canvas id="tl"></canvas>
    <div class="now"><span class="t" id="clock"></span><span class="mute" id="counts"></span></div>
  </div>
  <div class="lines" id="lines"></div>
</div>
<div class="wrap grid" id="grid"></div>
<script>
const D = JSON.parse(document.getElementById('data').textContent)
const $ = (id) => document.getElementById(id)
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
const byIndex = (side) => new Map(side.frames.map((f) => [f.index, f]))
const OLD = byIndex(D.old), NEW = byIndex(D.new)
let t = 0

$('title').textContent = D.name
document.title = D.name + ' · capture compare'
const nd = D.new.frames.filter((f) => f.detail).length
$('stats').innerHTML =
  '<span>' + mmss(D.durationMs) + '</span>' +
  '<span><b style="color:var(--old)">' + D.old.label + '</b> ' + D.old.frames.length + ' frames</span>' +
  '<span><b style="color:var(--new)">' + D.new.label + '</b> ' + D.new.frames.length + ' frames (' + (D.new.frames.length - nd) + ' full, ' + nd + ' close-ups)</span>' +
  (D.note ? '<span class="mute">' + D.note + '</span>' : '')

const video = $('video')
if (D.video) {
  video.src = D.video
  // A seek before the data arrives shows nothing: land it again once a frame can show.
  video.addEventListener('loadeddata', () => { video.currentTime = t / 1000 }, { once: true })
} else $('src').classList.add('hidden')

/** The frame on screen at t: the latest one taken by then, or one whose seen span holds t and began later. */
function at(side, t) {
  let best = null, start = -Infinity
  for (const f of side.frames) {
    if (f.tMs <= t && f.tMs >= start) { best = f; start = f.tMs }
    for (const [a, b] of f.seenMs || []) if (a <= t && t < b && a >= start) { best = f; start = a }
  }
  return { f: best, since: start }
}

function stage(el, map, f) {
  el.innerHTML = ''
  if (!f) return
  const base = f.detail ? map.get(f.detail.of) : f
  const img = document.createElement('img')
  img.className = 'base'
  img.src = (base || f).src
  img.onclick = () => open(img.src, '_blank')
  img.onload = () => { if (first && img.naturalWidth / img.naturalHeight > 1.9) document.body.classList.add('stacked'); first = false }
  el.appendChild(img)
  if (f.detail && base) {
    const d = document.createElement('img')
    d.className = 'detail'
    d.src = f.src
    d.onclick = () => open(d.src, '_blank')
    const b = f.detail.box
    Object.assign(d.style, { left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' })
    el.appendChild(d)
    const tag = document.createElement('div')
    tag.className = 'tag'
    tag.textContent = 'close-up on #' + f.detail.of
    el.appendChild(tag)
  }
}

function bar(el, side, cur) {
  const f = cur.f
  if (!f) { el.innerHTML = '<b>' + side.label + '</b><span class="mute">nothing yet</span>'; return }
  const age = t - cur.since
  const seen = cur.since !== f.tMs ? ' · seen again since ' + mmss(cur.since) : ''
  el.innerHTML = '<b>' + side.label + '</b><span>#' + f.index + ' · ' + mmss(f.tMs) + ' · ' + f.reason +
    (f.held ? ' · held ' + (f.held / 1000).toFixed(1) + ' s' : '') + seen + '</span>' +
    '<span class="age ' + (age > 15000 ? 'stale' : 'mute') + '">' + (age / 1000).toFixed(1) + ' s old</span>'
}

let lastOld = null, lastNew = null, first = true
function render() {
  const o = at(D.old, t), n = at(D.new, t)
  if (o.f !== lastOld) { stage($('oldstage'), OLD, o.f); lastOld = o.f }
  if (n.f !== lastNew) { stage($('newstage'), NEW, n.f); lastNew = n.f }
  bar($('oldbar'), D.old, o)
  bar($('newbar'), D.new, n)
  $('clock').textContent = mmss(t)
  const upTo = (s) => s.frames.filter((f) => f.tMs <= t).length
  $('counts').textContent = 'frames so far · old ' + upTo(D.old) + ' · new ' + upTo(D.new)
  lines()
  draw()
}

function curLine() {
  let k = -1
  D.transcript.forEach((l, i) => { if (l.tMs <= t) k = i })
  return k
}
function lines() {
  const k = curLine()
  const el = $('lines')
  el.innerHTML = ''
  for (let i = Math.max(0, k - 2); i <= Math.min(D.transcript.length - 1, k + 3); i++) {
    const l = D.transcript[i]
    const div = document.createElement('div')
    if (i === k) div.className = 'cur'
    div.innerHTML = '<span>' + mmss(l.tMs) + '</span>'
    div.appendChild(document.createTextNode(l.text))
    div.onclick = () => seek(l.tMs)
    el.appendChild(div)
  }
}

const cv = $('tl')
function draw() {
  const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr }
  const c = cv.getContext('2d')
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, w, h)
  const x = (ms) => (ms / D.durationMs) * w
  c.font = '11px system-ui'
  c.fillStyle = '#6b6b70'
  c.fillText(D.old.label, 2, 11); c.fillText(D.new.label, 2, 39); c.fillText('speech', 2, 67)
  c.fillStyle = '#5b6b8c'
  for (const f of D.old.frames) c.fillRect(x(f.tMs), 14, 1, 14)
  for (const f of D.new.frames) { c.fillStyle = f.detail ? '#7fb89f' : '#1f7a5a'; c.fillRect(x(f.tMs), f.detail ? 48 : 42, 1, f.detail ? 8 : 14) }
  c.fillStyle = 'rgba(31,122,90,.18)'
  for (const f of D.new.frames) for (const [a, b] of f.seenMs || []) c.fillRect(x(a), 42, Math.max(1, x(b) - x(a)), 14)
  c.fillStyle = '#c9c6bd'
  for (const l of D.transcript) c.fillRect(x(l.tMs), 70, Math.max(1, x(l.endMs ?? l.tMs + 2000) - x(l.tMs) - 1), 12)
  c.fillStyle = '#2457d6'
  c.fillRect(x(t) - 1, 0, 2, h)
}
function fromEvent(e) { const r = cv.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * D.durationMs }
let dragging = false
cv.onpointerdown = (e) => { dragging = true; cv.setPointerCapture(e.pointerId); seek(fromEvent(e)) }
cv.onpointermove = (e) => { if (dragging) seek(fromEvent(e)) }
cv.onpointerup = () => { dragging = false }
addEventListener('resize', draw)

function seek(ms, fromVideo) {
  t = Math.max(0, Math.min(D.durationMs, ms))
  if (!fromVideo && D.video && Math.abs(video.currentTime * 1000 - t) > 300) video.currentTime = t / 1000
  render()
  try { history.replaceState(null, '', '#t=' + Math.round(t)) } catch {}
}
video.addEventListener('timeupdate', () => { if (!video.paused) seek(video.currentTime * 1000, true) })

function step(side, dir) {
  const fs = side.frames
  if (dir > 0) { const f = fs.find((f) => f.tMs > t + 1); if (f) seek(f.tMs) }
  else { const f = [...fs].reverse().find((f) => f.tMs < t - 1); if (f) seek(f.tMs) }
}
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return
  const k = curLine()
  if (e.key === 'ArrowRight') { const l = D.transcript[k + 1]; if (l) seek(l.tMs); e.preventDefault() }
  else if (e.key === 'ArrowLeft') { const l = D.transcript[Math.max(0, D.transcript[k] && D.transcript[k].tMs < t - 500 ? k : k - 1)]; if (l) seek(l.tMs); e.preventDefault() }
  else if (e.key === '.') seek(t + 1000)
  else if (e.key === ',') seek(t - 1000)
  else if (e.key === ']') step(D.old, 1)
  else if (e.key === '[') step(D.old, -1)
  else if (e.key === '}') step(D.new, 1)
  else if (e.key === '{') step(D.new, -1)
  else if (e.key === ' ') { if (D.video) { video.paused ? video.play() : video.pause() } e.preventDefault() }
  else if (e.key === 'v') $('src').classList.toggle('hidden')
  else if (e.key === 's') document.body.classList.toggle('stacked')
  else if (e.key === 'g') { document.body.classList.toggle('gridmode'); if (!$('grid').childElementCount) grid() }
})

function grid() {
  const el = $('grid')
  const minutes = Math.ceil(D.durationMs / 60000)
  el.innerHTML = '<div class="gridhead"><span></span><span style="color:var(--old)">' + D.old.label + '</span><span style="color:var(--new)">' + D.new.label + '</span></div>'
  for (let m = 0; m < minutes; m++) {
    const row = document.createElement('div')
    row.className = 'minute'
    const lab = document.createElement('div')
    lab.className = 'm'
    lab.textContent = m + ':00'
    row.appendChild(lab)
    for (const side of [D.old, D.new]) {
      const box = document.createElement('div')
      box.className = 'thumbs'
      for (const f of side.frames.filter((f) => f.tMs >= m * 60000 && f.tMs < (m + 1) * 60000)) {
        const fig = document.createElement('figure')
        if (f.detail) fig.className = 'd'
        fig.innerHTML = '<img loading="lazy" src="' + f.src + '"><figcaption>#' + f.index + ' ' + mmss(f.tMs) + (f.detail ? ' close-up' : '') + '</figcaption>'
        fig.onclick = () => { document.body.classList.remove('gridmode'); seek(f.tMs) }
        box.appendChild(fig)
      }
      row.appendChild(box)
    }
    el.appendChild(row)
  }
}

const h = /t=(\\d+)/.exec(location.hash)
seek(h ? Number(h[1]) : 0)
</script></body></html>`
}

if (import.meta.main) await main()
