export const WIDTH = 1280
export const HEIGHT = 720

export type Tool = 'pencil' | 'pen' | 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'fill' | 'eyedropper' | 'hand'
export type Point = { x: number; y: number; p: number }
export type Stroke = {
  id: string
  tool: Exclude<Tool, 'eyedropper' | 'hand'>
  color: string
  size: number
  opacity: number
  pressure: boolean
  points: Point[]
}
export type Layer = { id: string; name: string; visible: boolean; locked: boolean }
export type Frame = { id: string; tracks: Record<string, Stroke[]> }
export type Project = {
  name: string
  fps: number
  frames: Frame[]
  layers: Layer[]
  activeFrame: number
  activeLayer: string
  onion: boolean
  grid: boolean
  background: string
}

const uid = () => crypto.randomUUID()

export function createProject(): Project {
  const layer = uid()
  return {
    name: '無題のアニメーション', fps: 8,
    frames: [{ id: uid(), tracks: { [layer]: [] } }],
    layers: [{ id: layer, name: '線画', visible: true, locked: false }],
    activeFrame: 0, activeLayer: layer,
    onion: true, grid: false, background: '#ffffff',
  }
}

export function addFrame(doc: Project, duplicate = false): Project {
  if (doc.frames.length >= 120) return doc
  const source = doc.frames[doc.activeFrame]
  const tracks = duplicate ? structuredClone(source.tracks) : {}
  const next = [...doc.frames]
  next.splice(doc.activeFrame + 1, 0, { id: uid(), tracks })
  return { ...doc, frames: next, activeFrame: doc.activeFrame + 1 }
}

export function removeFrame(doc: Project): Project {
  if (doc.frames.length === 1) return doc
  const frames = doc.frames.filter((_, i) => i !== doc.activeFrame)
  return { ...doc, frames, activeFrame: Math.min(doc.activeFrame, frames.length - 1) }
}

export function addLayer(doc: Project): Project {
  if (doc.layers.length >= 12) return doc
  const layer = { id: uid(), name: `レイヤー ${doc.layers.length + 1}`, visible: true, locked: false }
  return { ...doc, layers: [...doc.layers, layer], activeLayer: layer.id }
}

export function appendStroke(doc: Project, index: number, layerId: string, stroke: Stroke): Project {
  if (index < 0 || index >= doc.frames.length || !doc.layers.some(l => l.id === layerId && !l.locked)) return doc
  const frames = [...doc.frames]
  const frame = frames[index]
  frames[index] = { ...frame, tracks: { ...frame.tracks, [layerId]: [...(frame.tracks[layerId] || []), stroke] } }
  return { ...doc, frames }
}

export function undoStroke(doc: Project): Project {
  const frame = doc.frames[doc.activeFrame]
  const tracks = [...(frame.tracks[doc.activeLayer] || [])]
  if (!tracks.length) return doc
  tracks.pop()
  const frames = [...doc.frames]
  frames[doc.activeFrame] = { ...frame, tracks: { ...frame.tracks, [doc.activeLayer]: tracks } }
  return { ...doc, frames }
}

function floodFill(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, alpha: number) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const sx = Math.max(0, Math.min(w - 1, Math.floor(x)))
  const sy = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const image = ctx.getImageData(0, 0, w, h)
  const data = image.data
  const start = (sy * w + sx) * 4
  const before = [data[start], data[start + 1], data[start + 2], data[start + 3]]
  const colorCanvas = document.createElement('canvas')
  colorCanvas.width = colorCanvas.height = 1
  const colorCtx = colorCanvas.getContext('2d')!
  colorCtx.fillStyle = color
  colorCtx.fillRect(0, 0, 1, 1)
  const result = colorCtx.getImageData(0, 0, 1, 1).data
  const target = [result[0], result[1], result[2], Math.round(alpha * 255)]
  if (before.every((value, i) => value === target[i])) return
  // Scanline flood fill, using a visited bitmap so semi-transparent fills cannot revisit pixels.
  const visited = new Uint8Array(w * h)
  const stack = [sy * w + sx]
  let count = 0
  while (stack.length) {
    const position = stack.pop()!
    if (visited[position]) continue
    visited[position] = 1
    const i = position * 4
    if (Math.abs(data[i] - before[0]) > 12 || Math.abs(data[i + 1] - before[1]) > 12 ||
        Math.abs(data[i + 2] - before[2]) > 12 || Math.abs(data[i + 3] - before[3]) > 12) continue
    data[i] = target[0]
    data[i + 1] = target[1]
    data[i + 2] = target[2]
    data[i + 3] = target[3]
    if (++count > 950000) break
    const xx = position % w
    if (xx > 0) stack.push(position - 1)
    if (xx < w - 1) stack.push(position + 1)
    if (position >= w) stack.push(position - w)
    if (position < w * (h - 1)) stack.push(position + w)
  }
  ctx.putImageData(image, 0, 0)
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const pts = stroke.points
  if (!pts.length) return
  ctx.save()
  ctx.globalAlpha = stroke.opacity
  ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over'
  ctx.strokeStyle = stroke.tool === 'eraser' ? '#000000' : stroke.color
  ctx.fillStyle = ctx.strokeStyle
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const p0 = pts[0]
  const p1 = pts[pts.length - 1]
  const width = stroke.size * (stroke.tool === 'pencil' ? .65 : stroke.tool === 'pen' ? .8 : 1)
  if (stroke.tool === 'fill') {
    ctx.restore()
    floodFill(ctx, p0.x, p0.y, stroke.color, stroke.opacity)
    return
  }
  ctx.lineWidth = width
  if (stroke.tool === 'line' || stroke.tool === 'rect' || stroke.tool === 'ellipse') {
    ctx.beginPath()
    if (stroke.tool === 'line') { ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y) }
    else if (stroke.tool === 'rect') {
      ctx.rect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y))
    } else {
      ctx.ellipse((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.max(.1, Math.abs(p1.x - p0.x) / 2), Math.max(.1, Math.abs(p1.y - p0.y) / 2), 0, 0, Math.PI * 2)
    }
    ctx.stroke()
    ctx.restore()
    return
  }
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(p0.x, p0.y, Math.max(.5, width * (stroke.pressure ? p0.p : 1) / 2), 0, Math.PI * 2)
    ctx.fill()
  } else {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const pressure = stroke.pressure ? Math.max(.18, (a.p + b.p) / 2) : 1
      ctx.lineWidth = Math.max(.5, width * pressure)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
  ctx.restore()
}

function renderLayers(ctx: CanvasRenderingContext2D, project: Project, index: number, opacity = 1, extra?: { layer: string; stroke: Stroke }) {
  const frame = project.frames[index]
  if (!frame) return
  ctx.save()
  ctx.globalAlpha = opacity
  for (const layer of project.layers) {
    if (!layer.visible) continue
    const buffer = document.createElement('canvas')
    buffer.width = WIDTH
    buffer.height = HEIGHT
    const layerCtx = buffer.getContext('2d', { willReadFrequently: true })!
    for (const stroke of frame.tracks[layer.id] || []) drawStroke(layerCtx, stroke)
    if (extra?.layer === layer.id) drawStroke(layerCtx, extra.stroke)
    ctx.drawImage(buffer, 0, 0)
  }
  ctx.restore()
}

export function renderProject(canvas: HTMLCanvasElement, project: Project, index: number,
  options: { onion?: boolean; grid?: boolean; extra?: { layer: string; stroke: Stroke }; transparent?: boolean } = {}) {
  if (canvas.width !== WIDTH || canvas.height !== HEIGHT) { canvas.width = WIDTH; canvas.height = HEIGHT }
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, WIDTH, HEIGHT)
  if (!options.transparent) {
    ctx.fillStyle = project.background
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
  }
  if (options.onion) {
    if (index > 0) renderLayers(ctx, project, index - 1, .22)
    if (index < project.frames.length - 1) renderLayers(ctx, project, index + 1, .13)
  }
  renderLayers(ctx, project, index, 1, options.extra)
  if (options.grid) {
    ctx.save()
    ctx.strokeStyle = 'rgba(55,77,111,.16)'
    ctx.lineWidth = 1
    for (let x = 0; x <= WIDTH; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke() }
    for (let y = 0; y <= HEIGHT; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); ctx.stroke() }
    ctx.restore()
  }
}

export function sampleColor(canvas: HTMLCanvasElement, x: number, y: number) {
  const ctx = canvas.getContext('2d')!
  const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
  return `#${[data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`
}
