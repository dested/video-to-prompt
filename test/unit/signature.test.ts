import { describe, expect, test } from 'bun:test'
import { diffSignatures, LUMA_TOL, sigRows, signatureFromRgba, unionBox } from '../../src/signature.ts'
import { flat, paint } from './helpers.ts'

describe('signature', () => {
  test('rows follow the aspect ratio', () => {
    expect(sigRows(1920, 1080)).toBe(90)
    expect(sigRows(1080, 1920)).toBe(284)
    expect(sigRows(0, 0)).toBe(90)
  })

  test('luma from RGBA uses BT.601 weights', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
    const sig = signatureFromRgba(rgba, 4, 1)
    expect([...sig.luma]).toEqual([255, 76, 149, 28])
  })

  test('identical signatures do not differ', () => {
    const d = diffSignatures(flat(), flat())
    expect(d.changed).toBe(0)
    expect(d.box).toBeNull()
    expect(d.regions).toEqual([])
  })

  test('moves at or under the tolerance are noise', () => {
    expect(diffSignatures(flat(200), flat(200 + LUMA_TOL)).changed).toBe(0)
    expect(diffSignatures(flat(200), flat(201 + LUMA_TOL)).changed).toBe(160 * 90)
  })

  test('a painted block is one region with an exact box', () => {
    const d = diffSignatures(flat(), paint(flat(), 10, 20, 12, 4))
    expect(d.changed).toBe(48)
    expect(d.box).toEqual({ x: 10, y: 20, w: 12, h: 4 })
    expect(d.regions).toEqual([{ x: 10, y: 20, w: 12, h: 4, cells: 48 }])
  })

  test('changes one empty cell apart join one region; two apart stay separate', () => {
    const near = paint(paint(flat(), 10, 10, 2, 2), 13, 10, 2, 2)
    expect(diffSignatures(flat(), near).regions).toHaveLength(1)
    const apart = paint(paint(flat(), 10, 10, 2, 2), 14, 10, 2, 2)
    expect(diffSignatures(flat(), apart).regions).toHaveLength(2)
    const far = paint(paint(flat(), 10, 10, 2, 2), 40, 40, 2, 2)
    const d = diffSignatures(flat(), far)
    expect(d.regions).toHaveLength(2)
    expect(d.box).toEqual({ x: 10, y: 10, w: 32, h: 32 })
  })

  test('ignored cells are left out', () => {
    const changed = paint(flat(), 0, 0, 4, 4)
    const ignore = new Uint8Array(160 * 90)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) ignore[y * 160 + x] = 1
    expect(diffSignatures(flat(), changed, { ignore }).changed).toBe(8)
  })

  test('different shapes are wholly different', () => {
    const d = diffSignatures(flat(), { cols: 160, rows: 284, luma: new Uint8Array(160 * 284) })
    expect(d.fraction).toBe(1)
  })

  test('unionBox', () => {
    expect(unionBox([])).toBeNull()
    expect(unionBox([{ x: 1, y: 1, w: 2, h: 2 }, { x: 5, y: 0, w: 1, h: 1 }])).toEqual({ x: 1, y: 0, w: 5, h: 3 })
  })
})
