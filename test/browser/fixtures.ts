/**
 * Synthetic screen recordings with exact ground truth.
 *
 *   bun test/browser/fixtures.ts            → test/.fixtures/app/{app.webm, app.mp4, truth.json, narration.json}
 *
 * A mock app is rendered as a pure function of time and screenshotted at a fixed
 * frame rate, then encoded twice: VP9 webm (what MediaRecorder hands over) and
 * H.264 mp4 with a 2 s GOP (what an OS screen recorder hands over, and the case
 * where every seek decodes from the previous keyframe). Because the page is a
 * function of t, every state change has a known start and end — the eval scores
 * which of them the keyframes actually caught.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { $ } from 'bun'
import { chromium } from 'playwright-core'

export const FPS = 12
export const DURATION_S = 31
const W = 1920
const H = 1080

/** A state the keyframes must catch: some kept frame has t in [at, until). */
export interface TruthEvent {
  name: string
  at: number
  until: number
  /** Small on screen — the cases a coarse signature averages away. */
  subtle?: boolean
  transient?: boolean
  /** Reported but not scored: a return to an earlier screen, which dedup drops by design. */
  optional?: boolean
}

/** A stretch where only noise moves; kept frames here are waste. `allowed` is the tolerated count. */
export interface TruthNoise {
  name: string
  at: number
  until: number
  allowed: number
}

export interface Truth {
  durationMs: number
  events: TruthEvent[]
  noise: TruthNoise[]
}

export const TRUTH: Truth = {
  durationMs: DURATION_S * 1000,
  events: [
    { name: 'dashboard', at: 0, until: 3000 },
    { name: 'navigate to invoices', at: 3000, until: 5000 },
    { name: 'toast (0.6 s, off the 1 s grid)', at: 5100, until: 5700, transient: true },
    // Below any signature's resolution (same ink, one glyph). It persists, so it
    // counts as caught when a frame shows it while the narration talks about it.
    { name: 'total $1,240 → $1,245 (one digit)', at: 7000, until: 10500, subtle: true },
    { name: 'validation message', at: 16000, until: 19000, subtle: true },
    { name: 'modal open', at: 19000, until: 22000 },
    { name: 'modal closed (back to an earlier screen)', at: 22000, until: 23000, optional: true },
    { name: 'scroll settled', at: 24000, until: 27000 },
    { name: 'tooltip (0.8 s, off the 1 s grid)', at: 27150, until: 27950, transient: true },
    { name: 'error banner (final state)', at: 29500, until: 31000 },
  ],
  noise: [
    { name: 'blinking caret only', at: 9000, until: 16000, allowed: 1 },
    { name: 'cursor wandering', at: 11000, until: 14000, allowed: 2 },
  ],
}

/** Scripted narration over the fixture, ms from clip start, as a transcriber would return it. */
export const NARRATION = [
  { t: 500, d: 2300, text: "Okay so this is the dashboard, I'm going to go to invoices." },
  {
    t: 3500,
    d: 3000,
    text: 'I save the invoice and it says saved, but it disappears really fast.',
  },
  {
    t: 7200,
    d: 3300,
    text: 'And now look at the total, it went up by five dollars. It should still be twelve forty.',
  },
  {
    t: 16200,
    d: 2600,
    text: "Also the email validation shows up before I've even typed anything.",
  },
  {
    t: 19500,
    d: 3000,
    text: "When I click send it asks me to confirm, which is fine, I'll cancel.",
  },
  { t: 24500, d: 3000, text: 'Scrolling down, the rows look right.' },
  {
    t: 29600,
    d: 1300,
    text: 'And then payment failed, card declined, but I never entered a card.',
  },
]

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; overflow: hidden; font: 14px/1.4 Inter, system-ui, sans-serif;
         color: #1d2433; background: #f6f7fb; display: flex; }
  aside { width: 240px; background: #fff; border-right: 1px solid #e3e6ee; padding: 20px 12px; }
  aside .logo { font-weight: 700; font-size: 18px; padding: 0 10px 18px; }
  aside a { display: block; padding: 9px 10px; border-radius: 8px; color: #4a5268; text-decoration: none; }
  aside a.on { background: #eef1ff; color: #2f49d1; font-weight: 600; }
  main { flex: 1; position: relative; display: flex; flex-direction: column; }
  header { height: 64px; border-bottom: 1px solid #e3e6ee; background: #fff; display: flex;
           align-items: center; padding: 0 28px; font-size: 20px; font-weight: 600; }
  .content { flex: 1; display: flex; gap: 24px; padding: 24px 28px; overflow: hidden; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; width: 100%; align-content: start; }
  .card { background: #fff; border: 1px solid #e3e6ee; border-radius: 12px; padding: 20px; height: 140px; }
  .card b { display: block; font-size: 28px; margin-top: 10px; }
  .tablewrap { flex: 1; background: #fff; border: 1px solid #e3e6ee; border-radius: 12px; overflow: hidden;
               display: flex; flex-direction: column; }
  .scroller { flex: 1; overflow: hidden; position: relative; }
  .rows { position: absolute; left: 0; right: 0; top: 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 12px 18px; border-bottom: 1px solid #eef0f5; }
  th { color: #7a8299; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .total { padding: 14px 18px; border-top: 1px solid #e3e6ee; text-align: right; font-weight: 600; }
  .form { width: 380px; background: #fff; border: 1px solid #e3e6ee; border-radius: 12px; padding: 20px;
          align-self: start; position: relative; }
  .form label { display: block; font-size: 12px; color: #7a8299; margin: 14px 0 6px; }
  .input { height: 38px; border: 1px solid #cfd4e2; border-radius: 8px; padding: 0 10px; display: flex;
           align-items: center; }
  .input.focus { border-color: #2f49d1; box-shadow: 0 0 0 3px #dfe5ff; }
  .caret { width: 1px; height: 18px; background: #1d2433; }
  .err { color: #c92a2a; font-size: 12px; margin-top: 6px; }
  .btn { display: inline-block; margin-top: 18px; padding: 9px 16px; border-radius: 8px; background: #2f49d1;
         color: #fff; font-weight: 600; }
  .btn.ghost { background: #eef1ff; color: #2f49d1; margin-left: 8px; }
  .toast { position: absolute; right: 28px; bottom: 28px; background: #1d2433; color: #fff; padding: 12px 18px;
           border-radius: 10px; font-weight: 500; }
  .backdrop { position: absolute; inset: 0; background: rgba(15,20,35,.45); display: flex;
              align-items: center; justify-content: center; }
  .modal { width: 460px; background: #fff; border-radius: 14px; padding: 24px; }
  .modal h3 { font-size: 18px; margin-bottom: 8px; }
  .tip { position: absolute; background: #1d2433; color: #fff; font-size: 12px; padding: 6px 10px; border-radius: 6px; }
  .banner { margin: 16px 28px 0; padding: 12px 16px; border-radius: 10px; background: #fff0f0;
            border: 1px solid #ffc9c9; color: #c92a2a; font-weight: 600; }
  .cursor { position: absolute; width: 18px; height: 26px; pointer-events: none; z-index: 10; }
</style>
<aside><div class="logo">Ledgerly</div>
  <a id="nav-dash">Dashboard</a><a id="nav-inv">Invoices</a><a>Clients</a><a>Reports</a><a>Settings</a></aside>
<main><header id="title"></header><div id="banner"></div><div class="content" id="content"></div><div id="overlay"></div></main>
<svg class="cursor" id="cursor" viewBox="0 0 18 26"><path d="M1 1 L1 21 L6 16 L10 25 L13 24 L9 15 L16 15 Z" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>
<script>
  const rows = Array.from({ length: 22 }, (_, i) => {
    const n = 1040 + i
    const amt = [120, 85, 240, 60, 95, 140, 75, 210, 55, 160][i % 10]
    return '<tr><td>INV-' + n + '</td><td>' + ['Acme Co', 'Globex', 'Initech', 'Umbrella', 'Hooli'][i % 5] +
      '</td><td>Oct ' + (i + 3) + '</td><td>$' + amt + '.00</td><td>' + (i % 3 ? 'Paid' : 'Due') + '</td></tr>'
  }).join('')
  const ease = (x) => (x < 0 ? 0 : x > 1 ? 1 : x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
  const lerp = (a, b, x) => a + (b - a) * ease(x)
  const path = [[0, 900, 500], [11, 900, 500], [12, 1300, 300], [13, 700, 650], [14, 1500, 700], [99, 1500, 700]]
  window.renderAt = (t) => {
    const s = t / 1000
    const inv = s >= 3
    document.getElementById('nav-dash').className = inv ? '' : 'on'
    document.getElementById('nav-inv').className = inv ? 'on' : ''
    document.getElementById('title').textContent = inv ? 'Invoices' : 'Dashboard'
    document.getElementById('banner').innerHTML = s >= 29.5 ? '<div class="banner">Payment failed: card declined (code 402)</div>' : ''
    const content = document.getElementById('content')
    if (!inv) {
      content.innerHTML = '<div class="cards">' + ['Outstanding', 'Paid this month', 'Overdue', 'Clients', 'Drafts', 'Avg days to pay']
        .map((k, i) => '<div class="card">' + k + '<b>' + ['$4,820', '$12,340', '$960', '38', '4', '17'][i] + '</b></div>').join('') + '</div>'
    } else {
      const total = s >= 7 ? '$1,245.00' : '$1,240.00'
      const focus = s >= 9 && s < 19
      const caret = focus && Math.floor(s * 2) % 2 === 0 ? '<span class="caret"></span>' : ''
      const err = s >= 16 ? '<div class="err">Email is required</div>' : ''
      const scroll = s < 23 ? 0 : lerp(0, 400, s - 23)
      content.innerHTML =
        '<div class="tablewrap"><div class="scroller"><div class="rows" style="top:' + -scroll + 'px"><table><tr><th>Invoice</th><th>Client</th><th>Date</th><th>Amount</th><th>Status</th></tr>' +
        rows + '</table></div></div><div class="total">Total: ' + total + '</div></div>' +
        '<div class="form"><b>Send invoice</b><label>Recipient email</label><div class="input' + (focus ? ' focus' : '') + '">' + caret + '</div>' + err +
        '<label>Message</label><div class="input"></div><span class="btn" id="send">Send</span><span class="btn ghost" id="pdf">Download PDF</span></div>'
    }
    let overlay = ''
    if (s >= 5.1 && s < 5.7) overlay += '<div class="toast">Invoice saved</div>'
    if (s >= 19 && s < 22) overlay += '<div class="backdrop"><div class="modal"><h3>Send invoice INV-1040?</h3><p>The client will receive it by email.</p><span class="btn">Send</span><span class="btn ghost">Cancel</span></div></div>'
    if (s >= 27.15 && s < 27.95) overlay += '<div class="tip" style="right:120px;top:330px">Download as PDF (A4)</div>'
    document.getElementById('overlay').innerHTML = overlay
    let i = 0
    while (i < path.length - 2 && s >= path[i + 1][0]) i++
    const [t0, x0, y0] = path[i], [t1, x1, y1] = path[i + 1]
    const k = t1 === t0 ? 1 : (s - t0) / (t1 - t0)
    const c = document.getElementById('cursor')
    c.style.left = lerp(x0, x1, k) + 'px'
    c.style.top = lerp(y0, y1, k) + 'px'
  }
</script>`

export async function makeAppFixture(
  dir = resolve(import.meta.dir, '../.fixtures/app')
): Promise<string> {
  const framesDir = join(dir, 'frames')
  await rm(dir, { recursive: true, force: true })
  await mkdir(framesDir, { recursive: true })

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
    await page.setContent(PAGE)
    const count = DURATION_S * FPS
    for (let f = 0; f < count; f++) {
      await page.evaluate(
        (t) => (window as unknown as { renderAt(t: number): void }).renderAt(t),
        (f * 1000) / FPS
      )
      await page.screenshot({ path: join(framesDir, `${String(f).padStart(5, '0')}.png`) })
    }
  } finally {
    await browser.close()
  }

  const input = join(framesDir, '%05d.png')
  // Narration stand-in: quiet pink noise, so the audio stage has something to decode.
  const noise = `anoisesrc=color=pink:amplitude=0.02:duration=${DURATION_S}`
  await $`ffmpeg -loglevel error -y -framerate ${FPS} -i ${input} -f lavfi -i ${noise} -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -g 120 -pix_fmt yuv420p -c:a libopus -shortest ${join(dir, 'app.webm')}`
  await $`ffmpeg -loglevel error -y -framerate ${FPS} -i ${input} -f lavfi -i ${noise} -c:v libx264 -crf 20 -preset veryfast -g ${FPS * 2} -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart ${join(dir, 'app.mp4')}`
  await writeFile(join(dir, 'truth.json'), JSON.stringify(TRUTH, null, 2))
  await writeFile(join(dir, 'narration.json'), JSON.stringify([NARRATION], null, 2))
  await rm(framesDir, { recursive: true, force: true })
  return dir
}

if (import.meta.main) {
  if (process.argv.includes('--truth-only')) {
    const dir = resolve(import.meta.dir, '../.fixtures/app')
    await writeFile(join(dir, 'truth.json'), JSON.stringify(TRUTH, null, 2))
    await writeFile(join(dir, 'narration.json'), JSON.stringify([NARRATION], null, 2))
    console.log(`truth → ${dir}`)
  } else {
    const dir = await makeAppFixture()
    console.log(`fixture → ${dir}`)
  }
}
