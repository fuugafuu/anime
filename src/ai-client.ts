import { renderProject, waitForRasterFrames, type Frame, type Project, type Stroke } from './engine'

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
}

export type ModelSource = 'detected' | 'browse' | 'path'

const BASE = 'http://127.0.0.1:8766'
export async function getAiHealth(): Promise<AiHealth> {
  const response = await fetch(`${BASE}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw Error('PCのAIサービスに接続できません')
  return response.json() as Promise<AiHealth>
}

export async function loadAiModel(source: ModelSource, directory = ''): Promise<string> {
  const response = await fetch(`${BASE}/api/model/load`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, directory }), signal: AbortSignal.timeout(195_000),
  })
  const raw = await response.json() as { message?: string; error?: string }
  if (!response.ok) throw Error(raw.error || `モデル読み込みに失敗しました (HTTP ${response.status})`)
  return raw.message || 'モデルを読み込みました。'
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
  const payload: Record<string, unknown> = {
    mode: request.mode, count: request.count,
    spacing: request.spacing, arc: request.arc, strength: request.strength,
    from: current.tracks[layer.id] || [], to: next?.tracks[layer.id] || [],
  }
  if (request.mode === 'neural') {
    payload.imageFrom = await scaledImage(doc, index, 640, 360, 'image/png')
    payload.imageTo = await scaledImage(doc, index+1, 640, 360, 'image/png')
  }
  if (request.mode === 'review') {
    payload.fps = doc.fps
    payload.sequence = doc.frames.slice(Math.max(0, index - 4), Math.min(doc.frames.length, index + 6))
      .map(frame => ({ strokes: frame.tracks[layer.id] || [] }))
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 175_000)
  let raw: Record<string, unknown>
  try {
    const response = await fetch(`${BASE}/api/assist`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    })
    raw = await response.json() as Record<string, unknown>
    if (!response.ok) throw Error(typeof raw.error === 'string' ? raw.error : `HTTP ${response.status}`)
  } catch (err) {
    if (err instanceof TypeError) throw Error('PCのAIサービスに接続できません。START_AI.batを実行してください。')
    if (controller.signal.aborted) throw Error('AI処理がタイムアウトしました')
    throw err
  } finally {
    window.clearTimeout(timer)
  }
  const result: AssistResult = {
    id: request.id, message: String(raw.message || ''),
    method: raw.method === 'neural' ? 'neural' : raw.method === 'analysis' ? 'analysis' : 'geometry',
  }
  if (raw.kind !== 'insert' && raw.kind !== 'replace') return { result }
  const frames: Frame[] = []
  if (request.mode === 'neural') {
    if (!Array.isArray(raw.images) || !raw.images.length || raw.images.length > 3 ||
        raw.images.some(image => typeof image !== 'string' || !image.startsWith('data:image/webp;base64,') || image.length > 215_000))
      throw Error('画像生成結果が不正です')
    for (const image of raw.images as string[])
      frames.push({ id: crypto.randomUUID(), tracks: {}, image })
  } else {
    if (!Array.isArray(raw.frames) || !raw.frames.length || raw.frames.length > 4 ||
        raw.frames.some(frame => !Array.isArray(frame) || frame.length > 160 ||
          frame.some((stroke: Stroke) => !Array.isArray(stroke.points) || stroke.points.length > 200)))
      throw Error('線画生成結果が不正です')
    for (const strokes of raw.frames as Stroke[][]) frames.push({
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
