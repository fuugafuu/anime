// RIFE inference is isolated in a Worker so strokes, UI, and peer heartbeats stay responsive.
const MODEL = '/models/rife49.onnx'
const WIDTH = 320
const HEIGHT = 192 // 320x180 composition with a 12px replicated bottom edge (multiple of 32).

type Response = {
  id: number
  type: 'loaded' | 'progress' | 'inferred' | 'error'
  progress?: number
  provider?: 'webgpu' | 'wasm'
  error?: string
  rgba?: ArrayBuffer
  width?: number
  height?: number
}

let worker: Worker | null = null
let nextId = 0
let provider: string | null = null
let loading: Promise<string> | null = null
const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void; progress?: (value: number) => void }>()

function workerInstance() {
  if (worker) return worker
  worker = new Worker(new URL('./rife.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }: MessageEvent<Response>) => {
    const entry = pending.get(data.id)
    if (!entry) return
    if (data.type === 'progress') { entry.progress?.(data.progress || 0); return }
    pending.delete(data.id)
    if (data.type === 'error') entry.reject(new Error(data.error || 'ブラウザー内のAI処理でエラーが発生しました'))
    else entry.resolve(data)
  }
  worker.onerror = event => {
    const error = new Error(event.message || 'AI推論Workerが停止しました')
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    worker?.terminate()
    worker = null
    provider = null
  }
  return worker
}

function send(message: object, transfers: Transferable[] = [], progress?: (value: number) => void) {
  const id = ++nextId
  return new Promise<Response>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress })
    workerInstance().postMessage({ ...message, id }, transfers)
  })
}

export function loadedRifeProvider() { return provider }

export async function loadBrowserRife(progress?: (value: number) => void): Promise<string> {
  if (provider) return `RIFE v4.9 を読み込み済み（${provider.toUpperCase()}）`
  if (loading) return loading
  loading = (async () => {
    const response = await send({ type: 'load', url: new URL(MODEL, location.origin).href }, [], progress)
    if (response.type !== 'loaded' || !response.provider) throw Error('AIモデルを初期化できませんでした')
    provider = response.provider
    return `RIFE v4.9 をブラウザーで読み込みました（${provider.toUpperCase()}）`
  })()
  try { return await loading } finally { loading = null }
}

function getPixels(canvas: HTMLCanvasElement): ArrayBuffer {
  const scaled = document.createElement('canvas')
  scaled.width = WIDTH
  scaled.height = HEIGHT
  const ctx = scaled.getContext('2d', { willReadFrequently: true })!
  // Pad the 180px image to a 32-aligned 192px frame using the final scanline.
  ctx.drawImage(canvas, 0, 0, WIDTH, 180)
  ctx.drawImage(scaled, 0, 179, WIDTH, 1, 0, 180, WIDTH, 12)
  return ctx.getImageData(0, 0, WIDTH, HEIGHT).data.buffer
}

function visibleInk(data: ArrayBuffer): number {
  const pixels = new Uint8Array(data)
  let count = 0
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i] < 200 || pixels[i + 1] < 200 || pixels[i + 2] < 200) count++
  return count
}

export async function inferRife(first: HTMLCanvasElement, second: HTMLCanvasElement, count: number,
  spacing: (t: number) => number, fallback: (t: number) => HTMLCanvasElement): Promise<{ images: string[]; fallbackCount: number }> {
  if (!provider) throw Error('RIFEモデルの読み込みが必要です')
  const a = getPixels(first), b = getPixels(second)
  const sourceInk = Math.min(visibleInk(a), visibleInk(b))
  const results: string[] = []
  let fallbackCount = 0
  for (let i = 1; i <= count; i++) {
    const t = spacing(i / (count + 1))
    const response = await send({ type: 'infer', first: a.slice(0), second: b.slice(0), width: WIDTH, height: HEIGHT, t })
    if (response.type !== 'inferred' || !response.rgba) throw Error('RIFEの推論結果がありません')
    const temp = document.createElement('canvas')
    temp.width = WIDTH
    temp.height = HEIGHT
    temp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(response.rgba), WIDTH, HEIGHT), 0, 0)
    const out = document.createElement('canvas')
    out.width = 640
    out.height = 360
    const ctx = out.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    // A neural video model can erase very thin ink against a white background.
    // Show an explicitly identified geometry fallback instead of a blank frame.
    if (sourceInk >= 12 && visibleInk(response.rgba) < sourceInk * .15) {
      ctx.drawImage(fallback(t), 0, 0, 640, 360)
      fallbackCount++
    } else ctx.drawImage(temp, 0, 0, WIDTH, 180, 0, 0, 640, 360)
    results.push(out.toDataURL('image/webp', .75))
  }
  return { images: results, fallbackCount }
}
