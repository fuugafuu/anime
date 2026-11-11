import type { Point, Stroke } from './engine'
import type { AssistRequest } from './ai-client'

type Features = { cx: number; cy: number; w: number; h: number; length: number }
export type GeometryResult = { kind?: 'insert' | 'replace'; frames?: Stroke[][]; message: string; method: 'geometry' | 'analysis' }

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const point = (x: number, y: number, p = 1): Point => ({
  x: +clamp(x, 0, 1280).toFixed(2), y: +clamp(y, 0, 720).toFixed(2), p: +clamp(p, .1, 1).toFixed(3),
})

export function resample(points: Point[], count = 48): Point[] {
  if (!points.length) return []
  if (points.length === 1) return Array.from({ length: count }, () => ({ ...points[0] }))
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + distance(points[i], points[i - 1]))
  const total = lengths[lengths.length - 1]
  if (total < .001) return Array.from({ length: count }, () => ({ ...points[0] }))
  const result: Point[] = []
  let j = 0
  for (let i = 0; i < count; i++) {
    const d = total * i / (count - 1)
    while (j < points.length - 2 && lengths[j + 1] < d) j++
    const v = (d - lengths[j]) / Math.max(.0001, lengths[j + 1] - lengths[j])
    const a = points[j], b = points[j + 1]
    result.push(point(a.x + (b.x - a.x) * v, a.y + (b.y - a.y) * v, a.p + (b.p - a.p) * v))
  }
  return result
}

function features(stroke: Stroke): Features {
  const pts = stroke.points
  if (!pts.length) return { cx: 0, cy: 0, w: 0, h: 0, length: 0 }
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
  let length = 0
  for (let i = 1; i < pts.length; i++) length += distance(pts[i - 1], pts[i])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, length }
}

function matchStrokes(a: Stroke[], b: Stroke[]): [number, number][] {
  const options: { cost: number; i: number; j: number }[] = []
  const aa = a.map(features), bb = b.map(features)
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const x = aa[i], y = bb[j]
    const spatial = Math.hypot((x.cx - y.cx) / 1280, (x.cy - y.cy) / 720)
    const shape = (Math.abs(Math.log((x.w + 4) / (y.w + 4))) + Math.abs(Math.log((x.h + 4) / (y.h + 4)))) * .09
      + Math.abs(Math.log((x.length + 5) / (y.length + 5))) * .08
    const cost = spatial * .7 + shape + (a[i].tool === b[j].tool ? 0 : .15) + (a[i].color === b[j].color ? 0 : .09)
    options.push({ cost, i, j })
  }
  options.sort((x, y) => x.cost - y.cost)
  const paired: [number, number][] = []
  const usedA = new Set<number>(), usedB = new Set<number>()
  for (const { cost, i, j } of options) if (cost < .83 && !usedA.has(i) && !usedB.has(j)) {
    paired.push([i, j]); usedA.add(i); usedB.add(j)
  }
  return paired
}

function ease(t: number, spacing: AssistRequest['spacing']) {
  switch (spacing) {
    case 'ease-in': return t * t
    case 'ease-out': return 1 - (1 - t) ** 2
    case 'linear': return t
    default: return t * t * (3 - 2 * t)
  }
}

export function interpolateStrokes(a: Stroke[], b: Stroke[], t: number, spacing: AssistRequest['spacing'], arc: number): [Stroke[], number] {
  const pairs = matchStrokes(a, b)
  const amount = ease(t, spacing)
  const dx = pairs.reduce((n, [i, j]) => n + features(b[j]).cx - features(a[i]).cx, 0) / Math.max(1, pairs.length)
  const dy = pairs.reduce((n, [i, j]) => n + features(b[j]).cy - features(a[i]).cy, 0) / Math.max(1, pairs.length)
  const output: Stroke[] = []
  const usedA = new Set<number>(), usedB = new Set<number>()
  for (const [i, j] of pairs) {
    const first = a[i], second = b[j]
    usedA.add(i); usedB.add(j)
    if (first.tool === 'fill' || second.tool === 'fill') {
      output.push({ ...(t < .5 ? first : second), id: `assist-${i}-${j}-${Math.round(t * 100)}` })
      continue
    }
    const lhs = resample(first.points), rhs = resample(second.points)
    if (!lhs.length || lhs.length !== rhs.length) continue
    const direct = lhs.reduce((n, p, k) => n + distance(p, rhs[k]), 0)
    const reverse = lhs.reduce((n, p, k) => n + distance(p, rhs[rhs.length - 1 - k]), 0)
    if (reverse < direct * .85) rhs.reverse()
    const firstCenter = features(first), secondCenter = features(second)
    const deltaX = secondCenter.cx - firstCenter.cx, deltaY = secondCenter.cy - firstCenter.cy
    const magnitude = Math.hypot(deltaX, deltaY)
    const curveX = magnitude > .1 ? -deltaY / magnitude * arc * 4 * t * (1 - t) : 0
    const curveY = magnitude > .1 ? deltaX / magnitude * arc * 4 * t * (1 - t) : 0
    output.push({ id: `assist-${i}-${j}-${Math.round(t * 100)}`, tool: 'pen', color: first.color,
      size: +(first.size * (1 - amount) + second.size * amount).toFixed(2),
      opacity: +(first.opacity * (1 - amount) + second.opacity * amount).toFixed(3), pressure: true,
      points: lhs.map((p, k) => point(p.x * (1 - amount) + rhs[k].x * amount + curveX,
        p.y * (1 - amount) + rhs[k].y * amount + curveY, p.p * (1 - amount) + rhs[k].p * amount)),
    })
  }
  for (const [source, used, fade, sign] of [[a, usedA, 1 - t, 0], [b, usedB, t, 1]] as const) {
    source.forEach((s, idx) => {
      if (used.has(idx) || s.tool === 'fill' || !s.points.length) return
      const shift = sign === 0 ? amount : amount - 1
      output.push({ ...s, id: `detail-${idx}-${Math.round(t * 100)}-${sign}`, tool: 'pen',
        points: s.points.slice(0, 96).map(p => point(p.x + dx * shift, p.y + dy * shift, p.p)),
        opacity: +clamp(s.opacity * fade, .05, 1).toFixed(3),
      })
    })
  }
  return [output.slice(0, 160), pairs.length]
}

export function cleanStroke(stroke: Stroke, strength: number): Stroke {
  if (!['pen', 'pencil', 'brush'].includes(stroke.tool) || stroke.points.length < 5)
    return { ...stroke, id: `clean-${stroke.id}` }
  let length = 0
  for (let i = 1; i < stroke.points.length; i++) length += distance(stroke.points[i - 1], stroke.points[i])
  const target = Math.min(180, Math.max(8, Math.trunc(length / Math.max(1.3, 2.2 + strength * 2))))
  const pts = resample(stroke.points, target)
  const smoothed: Point[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1]
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y
    const cosine = (ux * vx + uy * vy) / Math.max(.0001, Math.hypot(ux, uy) * Math.hypot(vx, vy))
    const preserve = clamp((1 - cosine) * 2.5, 0, 1)
    const mix = clamp(strength * .42 * (1 - preserve), 0, .48)
    smoothed.push(point(b.x * (1 - mix) + (a.x + c.x) * .5 * mix, b.y * (1 - mix) + (a.y + c.y) * .5 * mix, b.p))
  }
  smoothed.push(pts[pts.length - 1])
  const output = [smoothed[0]]
  for (const p of smoothed.slice(1, -1)) if (distance(p, output[output.length - 1]) >= .75) output.push(p)
  output.push(smoothed[smoothed.length - 1])
  return { ...stroke, id: `clean-${stroke.id}`, points: output }
}

export function productionReview(sequence: Stroke[][], fps: number): GeometryResult {
  const featuresList = sequence.map(strokes => {
    const points = strokes.flatMap(stroke => stroke.points)
    if (!points.length) return null
    const xs = points.map(p => p.x), ys = points.map(p => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY }
  })
  if (!featuresList.some(Boolean)) return { message: '線がありません。まず1枚の原画を描き、次のフレームに動かした原画を描いてください。', method: 'analysis' }
  const lines = [`確認範囲: ${sequence.length}枚 / 作画あり${featuresList.filter(Boolean).length}枚 / ${fps}fps。`]
  const empty = featuresList.map((item, i) => item ? '' : String(i + 1)).filter(Boolean)
  if (empty.length) lines.push(`空白フレーム: ${empty.slice(0, 8).join('、')}。意図しない空白なら原画を追加してください。`)
  const jumps: { i: number; d: number; scale: number }[] = []
  for (let i = 1; i < featuresList.length; i++) {
    const before = featuresList[i - 1], after = featuresList[i]
    if (!before || !after) continue
    jumps.push({ i, d: Math.hypot(after.cx - before.cx, after.cy - before.cy),
      scale: Math.max(Math.abs(after.w - before.w), Math.abs(after.h - before.h)) })
  }
  if (jumps.length) {
    const biggest = jumps.reduce((a, b) => a.d >= b.d ? a : b)
    lines.push(`${biggest.i}→${biggest.i + 1}コマ: 画面上の中心移動 ${biggest.d.toFixed(1)}px（推定 ${(biggest.d * fps).toFixed(0)}px/秒）。`)
    if (biggest.d > 100) lines.push('中心移動が大きいため、該当コマ間に中割りを2枚以上追加し、動きを目視確認してください。')
    const wobble = jumps.reduce((a, b) => a.scale >= b.scale ? a : b)
    if (wobble.scale > 80) lines.push(`${wobble.i}→${wobble.i + 1}コマでシルエット寸法が最大${wobble.scale.toFixed(0)}px変化。意図しない縮尺変動なら輪郭と原画を修正してください。`)
    if (jumps.every(j => j.d <= 8)) lines.push('位置変化が少ない動きです。まばたき・髪・服・手の動きなど局所的な原画を追加すると変化が出ます。')
  }
  if (featuresList.length < 3) lines.push('動きを診断するには3枚以上の原画・中割りを用意すると、速度変化を比較できます。')
  lines.push('これは線の統計による制作診断です。人物の姿勢や絵の意味を理解する画像生成AIではありません。')
  return { message: lines.join('\n'), method: 'analysis' }
}

export function runGeometry(request: AssistRequest, from: Stroke[], to: Stroke[], sequence: Stroke[][], fps: number): GeometryResult {
  if (from.length > 160 || to.length > 160 || [...from, ...to].some(s => s.points.length > 2000 || s.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.p))))
    throw Error('線画データの上限を超えるか、描画座標が不正です。')
  if (request.mode === 'review') return productionReview(sequence, fps)
  if (request.mode === 'cleanup') {
    const strength = clamp(request.strength, .1, 1)
    return { kind: 'replace', frames: [from.map(stroke => cleanStroke(stroke, strength))], method: 'geometry',
      message: `${from.length}本の線を形状に合わせて整理しました。輪郭や角を保護し、線の揺らぎと余分な点を削減しています。` }
  }
  if (request.mode !== 'inbetween') throw Error('未対応の作画補助です。')
  if (!from.length || !to.length) throw Error('前後のキーフレームの選択レイヤーに線を描いてください。')
  const count = clamp(Math.trunc(request.count), 1, 4)
  let pairs = 0
  const frames = Array.from({ length: count }, (_, i) => {
    const [strokes, matched] = interpolateStrokes(from, to, (i + 1) / (count + 1), request.spacing, clamp(request.arc, -100, 100))
    pairs = matched
    return strokes
  })
  return { kind: 'insert', frames, method: 'geometry',
    message: `前後の線を形状・位置・長さで対応付け、${pairs}組を追跡。${count}枚の中間フレームを作りました。崩れやすい部分は採用前に確認してください。` }
}
