/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu'

type LoadMessage = { id: number; type: 'load'; url: string }
type InferMessage = { id: number; type: 'infer'; first: ArrayBuffer; second: ArrayBuffer; width: number; height: number; t: number }
type Incoming = LoadMessage | InferMessage

let session: ort.InferenceSession | null = null
let provider: 'webgpu' | 'wasm' | null = null
let loading: Promise<void> | null = null

ort.env.wasm.numThreads = 1 // Cross-origin isolation is not enabled on the Vercel site.
ort.env.wasm.wasmPaths = new URL('/ort/', self.location.origin).href

const reply = (message: object, transfer?: Transferable[]) => self.postMessage(message, { transfer: transfer || [] })
const failure = (id: number, error: unknown) => reply({ id, type: 'error', error: error instanceof Error ? error.message : String(error) })

async function downloadModel(id: number, url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw Error(`モデルの取得に失敗しました (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || 0
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      reply({ id, type: 'progress', progress: total ? Math.min(95, Math.round(received / total * 90)) : 30 })
    }
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function load(id: number, url: string) {
  if (session) { reply({ id, type: 'loaded', provider }); return }
  if (loading) {
    await loading
    if (!session) throw Error('モデルの読み込みが完了しませんでした')
    reply({ id, type: 'loaded', provider })
    return
  }
  loading = (async () => {
    const bytes = await downloadModel(id, url)
    reply({ id, type: 'progress', progress: 95 })
    let gpuError: unknown = null
    if ('gpu' in navigator && navigator.gpu) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' })
        provider = 'webgpu'
      } catch (error) { gpuError = error }
    }
    if (!session) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
        provider = 'wasm'
      } catch (error) {
        throw Error(`RIFEモデルの初期化に失敗しました: ${error instanceof Error ? error.message : String(error)}${gpuError ? '（WebGPUも利用不可）' : ''}`)
      }
    }
    if (!session.inputNames.includes('img0') || !session.inputNames.includes('img1') || !session.inputNames.includes('timestep'))
      throw Error('このRIFEモデルは想定した入出力形式ではありません')
  })()
  try {
    await loading
    reply({ id, type: 'progress', progress: 100 })
    reply({ id, type: 'loaded', provider })
  } finally { loading = null }
}

function planar(rgba: Uint8Array, width: number, height: number) {
  const n = width * height
  if (rgba.length !== n * 4) throw Error('フレーム画像のサイズが正しくありません')
  const data = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    data[i] = rgba[4 * i] / 255
    data[i + n] = rgba[4 * i + 1] / 255
    data[i + n * 2] = rgba[4 * i + 2] / 255
  }
  return data
}

async function infer(message: InferMessage) {
  if (!session) throw Error('先にRIFEモデルを読み込んでください')
  const { width, height, t } = message
  if (width < 32 || height < 32 || width > 640 || height > 384 || width % 32 || height % 32 || !(t > 0 && t < 1))
    throw Error('推論する画像サイズまたは時刻が正しくありません')
  const feeds = {
    img0: new ort.Tensor('float32', planar(new Uint8Array(message.first), width, height), [1, 3, height, width]),
    img1: new ort.Tensor('float32', planar(new Uint8Array(message.second), width, height), [1, 3, height, width]),
    timestep: new ort.Tensor('float32', new Float32Array([t]), [1]),
  }
  const outputs = await session.run(feeds)
  const output = outputs.output
  if (!output || output.type !== 'float32' || output.dims.join(',') !== [1, 3, height, width].join(','))
    throw Error('RIFEの出力形式が想定と異なります')
  const pixels = output.data as Float32Array
  const n = width * height
  const rgba = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    rgba[4 * i] = Math.round(Math.max(0, Math.min(1, pixels[i])) * 255)
    rgba[4 * i + 1] = Math.round(Math.max(0, Math.min(1, pixels[i + n])) * 255)
    rgba[4 * i + 2] = Math.round(Math.max(0, Math.min(1, pixels[i + n * 2])) * 255)
    rgba[4 * i + 3] = 255
  }
  reply({ id: message.id, type: 'inferred', rgba: rgba.buffer, width, height }, [rgba.buffer])
}

self.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data
  void (async () => {
    try {
      if (message.type === 'load') await load(message.id, message.url)
      else await infer(message)
    } catch (error) { failure(message.id, error) }
  })()
}
