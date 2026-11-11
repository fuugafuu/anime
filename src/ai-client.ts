import { drawStroke, renderProject, waitForRasterFrames, type Frame, type Project, type Stroke } from './engine'
import { interpolateStrokes, runGeometry } from './assist-geometry'
import { inferRife, loadBrowserRife, loadedRifeProvider } from './browser-rife'

export type AssistMode = 'neural' | 'inbetween' | 'cleanup' | 'review'
export type AssistRequest = {
  id: string
  mode: AssistMode
  count: number
  spacing: 'smooth' | 'linear' | 'ease-in' | 'ease-out'
  arc: number
  strength: number
  frameId: string
  layerId: string
}
export type AssistResult = {
  id: string
  message: string
  preview?: string
  method?: 'geometry' | 'neural' | 'analysis'
  count?: number
  error?: string
}
export type AssistCandidate = {
  id: string
  kind: 'insert' | 'replace'
  frameId: string
  nextFrameId?: string
  layerId: string
  source: Frame
  target?: Frame
  frames: Frame[]
}
export type AssistAction = Pick<AssistCandidate, 'kind' | 'frameId' | 'nextFrameId' | 'layerId' | 'frames'>
export type AiHealth = {
  ready: boolean
  neuralReady: boolean
  neuralInstalled: boolean
  neuralModel: string | null
  detectedModel: string | null
  progress?: number
}

export type ModelSource = 'browser'

export async function getAiHealth(): Promise<AiHealth> {
  const loaded = loadedRifeProvider()
  return { ready: true, neuralReady: !!loaded, neuralInstalled: true,
    neuralModel: loaded ? `v4.9 / ${loaded.toUpperCase()}` : null, detectedModel: 'RIFE v4.9（21MB）' }
}

export async function loadAiModel(source: ModelSource, _directory = '', progress?: (value: number) => void): Promise<string> {
  if (source !== 'browser') throw Error('ブラウザー用モデルを選択してください')
  return loadBrowserRife(progress)
}

async function scaledImage(doc: Project, index: number, width: number, height: number, format: string, quality?: number): Promise<string> {
  await waitForRasterFrames(doc)
  const canvas = document.createElement('canvas')
  renderProject(canvas, doc, index, { onion: false, grid: false })
  const reduced = document.createElement('canvas')
  reduced.width = width
  reduced.height = height
  reduced.getContext('2d')!.drawImage(canvas, 0, 0, width, height)
  return reduced.toDataURL(format, quality)
}

async function renderedCanvas(doc: Project, index: number) {
  await waitForRasterFrames(doc)
  const canvas = document.createElement('canvas')
  renderProject(canvas, doc, index, { onion: false, grid: false })
  return canvas
}

const spacingAt = (t: number, mode: AssistRequest['spacing']) =>
  mode === 'linear' ? t : mode === 'ease-in' ? t * t : mode === 'ease-out' ? 1 - (1 - t) ** 2 : t * t * (3 - 2 * t)

export function applyAssistAction(doc: Project, action: AssistAction): Project {
  const index = doc.frames.findIndex(frame => frame.id === action.frameId)
  if (index < 0 || !doc.layers.some(layer => layer.id === action.layerId && !layer.locked)) return doc
  if (action.kind === 'replace') {
    if (action.frames.length !== 1 || action.frames[0].id !== action.frameId) return doc
    const frames = [...doc.frames]
    frames[index] = action.frames[0]
    return { ...doc, frames, activeFrame: index }
  }
  if (doc.frames.length + action.frames.length > 120 || !action.frames.length ||
      doc.frames[index+1]?.id !== action.nextFrameId || action.frames.some(frame => !frame.id)) return doc
  const frames = [...doc.frames]
  frames.splice(index+1, 0, ...action.frames)
  return { ...doc, frames, activeFrame: index+1 }
}

export function applyAssist(doc: Project, candidate: AssistCandidate): Project | null {
  const index = doc.frames.findIndex(frame => frame.id === candidate.frameId)
  if (index < 0 || doc.frames[index] !== candidate.source) return null
  if (candidate.kind === 'insert' && doc.frames[index + 1] !== candidate.target) return null
  const next = applyAssistAction(doc, candidate)
  return next === doc ? null : next
}

export async function processAi(doc: Project, request: AssistRequest): Promise<{
  result: AssistResult
  candidate?: AssistCandidate
}> {
  const index = doc.frames.findIndex(frame => frame.id === request.frameId)
  if (index < 0) throw Error('対象フレームが見つかりません')
  const layer = doc.layers.find(item => item.id === request.layerId)
  if (!layer || layer.locked) throw Error('編集可能なレイヤーを選んでください')
  const current = doc.frames[index]
  const next = doc.frames[index+1]
  if ((request.mode === 'inbetween' || request.mode === 'neural') && (!next || doc.frames.length + request.count > 120))
    throw Error('次のキーフレームが必要です（最大120フレーム）')
  if (request.mode === 'inbetween' && (current.image || next?.image))
    throw Error('線の中割りは線画キーフレームに対応します。画像原画はRIFEを利用してください。')
  let raw: { kind?: 'insert' | 'replace'; frames?: Stroke[][]; images?: string[]; message: string; method: 'neural' | 'geometry' | 'analysis' }
  if (request.mode === 'neural') {
    if (!loadedRifeProvider()) throw Error('AIモデルを読み込んでから実行してください')
    const firstCanvas = await renderedCanvas(doc, index)
    const secondCanvas = await renderedCanvas(doc, index + 1)
    const fallback = (t: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1280; canvas.height = 720
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = doc.background
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      if (current.image || next?.image) {
        ctx.drawImage(firstCanvas, 0, 0)
        ctx.globalAlpha = t
        ctx.drawImage(secondCanvas, 0, 0)
        ctx.globalAlpha = 1
      } else {
        for (const visibleLayer of doc.layers.filter(item => item.visible)) {
          const [strokes] = interpolateStrokes(current.tracks[visibleLayer.id] || [], next.tracks[visibleLayer.id] || [], t, 'linear', 0)
          for (const stroke of strokes) drawStroke(ctx, stroke)
        }
      }
      return canvas
    }
    const { images, fallbackCount } = await inferRife(firstCanvas, secondCanvas,
      Math.min(3, request.count), t => spacingAt(t, request.spacing), fallback)
    raw = { kind: 'insert', images, method: fallbackCount === images.length ? 'geometry' : 'neural',
      message: fallbackCount
        ? `RIFE v4.9 で推論しましたが、${fallbackCount}枚で細い線が消えたため、線画補間による画像に置き換えました。結果を確認してください。`
        : `RIFE v4.9 ニューラルネットワークで${images.length}枚の中間画像をブラウザー内で生成しました。輪郭の崩れを確認して採用してください。` }
  } else {
    const sequence = doc.frames.slice(Math.max(0, index - 4), Math.min(doc.frames.length, index + 6))
      .map(frame => frame.tracks[layer.id] || [])
    raw = runGeometry(request, current.tracks[layer.id] || [], next?.tracks[layer.id] || [], sequence, doc.fps)
  }
  const result: AssistResult = {
    id: request.id, message: raw.message,
    method: raw.method === 'neural' ? 'neural' : raw.method === 'analysis' ? 'analysis' : 'geometry',
  }
  if (raw.kind !== 'insert' && raw.kind !== 'replace') return { result }
  const frames: Frame[] = []
  if (request.mode === 'neural') {
    if (!Array.isArray(raw.images) || !raw.images.length || raw.images.length > 3 ||
        raw.images.some(image => typeof image !== 'string' || !image.startsWith('data:image/webp;base64,') || image.length > 600_000))
      throw Error('画像生成結果が不正です')
    for (const image of raw.images)
      frames.push({ id: crypto.randomUUID(), tracks: {}, image })
  } else {
    if (!Array.isArray(raw.frames) || !raw.frames.length || raw.frames.length > 4 ||
        raw.frames.some(frame => !Array.isArray(frame) || frame.length > 160 ||
          frame.some((stroke: Stroke) => !Array.isArray(stroke.points) || stroke.points.length > 200)))
      throw Error('線画生成結果が不正です')
    for (const strokes of raw.frames) frames.push({
      id: raw.kind === 'replace' ? current.id : crypto.randomUUID(),
      tracks: { ...(raw.kind === 'replace' ? current.tracks : current.tracks), [layer.id]: strokes },
      ...(raw.kind === 'replace' ? { image: current.image } : {}),
    })
  }
  const candidate: AssistCandidate = {
    id: request.id, kind: raw.kind, frameId: current.id, nextFrameId: next?.id,
    layerId: layer.id, source: current, target: next, frames,
  }
  const sample = applyAssist(doc, candidate)
  if (!sample) throw Error('描画内容が更新されました。再度生成してください')
  result.preview = await scaledImage(sample, sample.activeFrame, 480, 270, 'image/webp', .65)
  result.count = frames.length
  return { result, candidate }
}
