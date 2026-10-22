Status: active

# Page model: no cap, nothing lost, no repeats

Driven by Handback walkthrough c5cbb71c ("qg"): 28 min of Sal reading a long doc on a
5120×2160 ultrawide. The old pipeline capped it at 600 near-identical frames. Sal's bar: no
frame cap, nothing lost, 30 to 60 minute takes, top tier.

## What a page model is

A second signature grid (40 cols × 4× main rows: 8 px strips at 2160p) reads vertical
structure. `matchShift` finds the scrolling band and the shift between two grids, to a
fraction of a strip, and what changed in place once the shift is undone. The band is widened
over every column the shift explains too (a ragged right edge moves with the page).

Every kept frame that is scroll-related to another gets a position on a **surface** (one
scrolling page): `off` in strip rows. Surfaces merge when one view links frames from two
of them. A view that matches nothing recent is matched against every keyframe (a flick of
the wheel, a jump to a section read before).

A settled view's rows are **covered** row by row: a keyframe credits the rows it shows in
the same state (checked at the known shift), less the rows that differ (`residualAt` reports
which). Rows a keyframe showed in another state and no other keyframe shows as they are now
are an edit, and make the view new.

## When a frame is kept

- Not scroll-related (navigation, a dialog, a new app): as before, major and settled.
- A screen come back to, however long ago (plain match on any keyframe): never.
- Scrolled with something changed in place (a highlight, a typed word): kept when settled.
- Scrolled into rows no kept frame shows:
  - settled with at least half the view unseen: kept straight away;
  - otherwise **parked**. While parked, the parked pixels follow small drift (a selection
    dragged out, a caret), and the busy mask is snapshotted at each still step. When the
    screen leaves, the view is judged again with that snapshot and kept when it was up
    1.5 s and either 5% of its rows would vanish unseen or something in it changed in
    place; or when it was up 8 s and no single keyframe shows it whole.
- Continuous motion: one frame per 2 s while a quarter of the view is unseen.
- A narration line's own frame only for non-scroll changes; a beat only for drift against
  the keyframe the screen matches, and never for a view the page shows.

## Busy cells

Heat spreads to neighbours as before, but a cell is *live* (left out of comparisons) only
while it changes itself. A pointer wandering over a finished selection no longer hides it.
The chronic-cell discount is gone: cropping the recorder's panel is the real fix.

## Video

A webcam call (toothio: six tiles filling a 42-minute Meet call) changes a few scattered cells
on many steps, too sparsely for per-cell heat, and made 2145 frames. Video is caught per 8×8-cell
block: a block that changed (3+ cells over 2+ columns) in 10% of the last 80 steps (20 s) is
video, and it and the blocks within 2 of it are left out while anything near it changed in the
last 10 s. A clip that stops shows its last picture once that passes, if it stopped on a new
picture: still video that differs from the keyframe by under 40 cells in all stays left out. A
face that settled a few cells from where it sat was most of what toothio still kept (117 of its
227 frames were narration lines over faces); this took it to 175 and moved nothing else.

What must not vote, found on qg (each one a regression to fix there):
- steps over 5% of the frame (scrolls, recognised or not; navigations);
- small steps within 1 s of a recognised scroll or a step over 10% (a smooth scroll easing in and
  out), and a scroll takes back the votes of the steps just before it;
- one or two pointer-sized blobs when that is all the small change there is;
- strips 3× wider than tall and 8+ cells wide: a line typed or selected, a table row lit by hover.

Each keyframe remembers its video blocks (`Kept.video`, learned while the screen still matches
it), and a comparison with it leaves them out while they move. A non-scroll change over a quarter
of the screen (a window switch) wipes the video history of the blocks it repainted, so a
terminal that replaced the call isn't masked by the call's votes; those blocks count as moving
for 10 s, so a call come back to matches its old frame at once. The view cache is keyed on which
blocks move (`liveEpoch`): a slide that replaced a face is compared again once it holds still.
toothio switches between the call and a terminal all through: this took it from 455 to 255.

Six webcams moving at once is a large step too, but toothio's are 5 to 7% of the frame and only
3 of 473 match a scroll; qg's are 12 to 23% and 737 of 817 are scrolls.

## Detail crops

A keyframe whose change from the last full keyframe fits a box ≤ 10% of the frame is a
`detail {of, box}`: the extractor encodes that region at native resolution and the sheets
composite it onto its base.

## Crop

`ClipInput.crop` (fractions of the frame) cuts the picture before signatures and encoding;
`meta.crop` records it. Handback's recorder panel goes this way (auto-detected, confirmed on
the review sheet).

## Results on qg (5120×2160, 28 min, crop x 0..0.86)

The audit finds every settled view (held ≥ 1.5 s) and checks, row by row, whether some kept
frame shows each row in the same state. "Repeats" are full frames under 2% of whose rows are
new against earlier frames.

| Build | Frames | Full | Details | Lost (view-s of 1148) | Repeats |
| --- | --- | --- | --- | --- | --- |
| Handback live pipeline (cap) | 600 | 600 | 0 | 0.0 | 206 (34%) |
| This pass | 481 | 311 | 170 | 0.0 | 29 (9%) |

Earlier builds on the way (strict audit, now superseded): 741 (no budget) → 362 (scroll
grid) → 336 → 269 (page model) → 469 (live busy).

## Corpus (replays, crop where a recorder panel shows)

| Take | What | Old frames | New frames (full + close-ups) | Lost view-s | Repeats old → new |
| --- | --- | --- | --- | --- | --- |
| qg | 28 min doc, 5120×2160 | 600 | 482 (309 + 173) | 0 | 206 → 31 |
| w606 | 6 min Mac, panel | 239 | 45 (39 + 6) | 0 | 159 → 3 |
| w1315 | 13 min Windows: terminal, notes, a doc | 84 | 90 (52 + 38) | 0 (old 1.3) | 32 → 14 |
| toothio | 43 min Meet, six webcams, a terminal now and then | 600 (cap; 2145 uncapped) | 175 (62 + 113) | 0 off the call | n/a |

The row audits mean nothing on the call itself (every sample has faces in a new pose); split by
screen, the 87 s the terminal is up lose nothing. Judge the call in the viewer. Real-pipeline runs (crop before the signature, so a finer grid) land a few frames
higher than the replays: w606 53, toothio 178.

## Viewer

`bun test/compare/build.ts --name <take> --old <rec dir> --new <rec dir> --out <dir> --video <clip>`
writes a static page: source video, old and new frame at each moment, a timeline, a per-minute
grid. Pages for the four takes: `W:\junk\video-to-prompt\compare\index.html`.

## Still open

- Coterie takes, with Sal's OK.
- Handback: stop importing `frameBudget`; fixed-height caption box; auto-crop + review
  sheet; viewer and MCP support for `detail` and `seen`.
- The first few seconds of a webcam call still make frames while the video vote builds.
- A clock that ticks once a minute (Meet's top-left time) is too slow for the heat mask, so a
  narration line over it earns a small close-up: about 20 of toothio's 178.
