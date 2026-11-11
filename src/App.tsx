import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import Peer, { type DataConnection } from 'peerjs'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import {
  ArrowLeft, ArrowRight, Brush, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Circle, CircleHelp, Clapperboard, Copy, Download, Droplets, Eraser, Eye, EyeOff,
  Film, FlipHorizontal2, FolderOpen, Grid2X2, Hand, Image, Layers, Link2, Lock, Maximize,
  Minus, Monitor, MoreHorizontal, PaintBucket, Palette, Pause, Pen,
  Pencil, Pipette, Play, Plus, RectangleHorizontal, Redo2, RefreshCw, Settings2,
  ShieldCheck, SlidersHorizontal, Slash, Smartphone, Sparkles, Trash2, Undo2,
  Unlock, Wifi, WifiOff, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import {
  addFrame, addLayer, appendStroke, createProject, drawStroke, HEIGHT, removeFrame, renderProject,
  sampleColor, undoStroke, WIDTH,
  type Point, type Project, type Stroke, type Tool,
} from './engine'

type Role = 'pc' | 'phone' | null
type Status = 'idle' | 'creating' | 'ready' | 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'error'
type Action =
  | { type: 'set'; key: 'name' | 'fps' | 'onion' | 'grid' | 'background' | 'activeFrame' | 'activeLayer'; value: string | number | boolean }
  | { type: 'newFrame'; duplicate: boolean; id?: string }
  | { type: 'deleteFrame' }
  | { type: 'newLayer'; id?: string }
  | { type: 'updateLayer'; id: string; key: 'name' | 'visible' | 'locked'; value: string | boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'stroke'; frame: number; layer: string; stroke: Stroke }
  | { type: 'replace'; project: Project }

type Wire =
  | { type: 'sync'; project: Project; version: number; accepted: string[]; resumeToken: string }
  | { type: 'action'; id: string; action: Action }
  | { type: 'commit'; version: number; action: Action }
  | { type: 'ack'; id: string; version: number }
  | { type: 'requestSync' }
  | { type: 'start'; frame: number; layer: string; stroke: Stroke }
  | { type: 'points'; strokeId: string; points: Point[] }
  | { type: 'cancel' }
  | { type: 'ping' | 'pong' }

const STORAGE = 'frame-studio-autosave-v1'
const PRESETS = ['#20243c', '#ffffff', '#ef5d6d', '#ffb55a', '#e9ce64', '#6bd5b3', '#5aa5ef', '#9b83f2']
const TOOLS: { id: Tool; name: string; icon: typeof Pencil; shortcut: string }[] = [
  { id: 'pencil', name: '鉛筆', icon: Pencil, shortcut: 'B' },
  { id: 'pen', name: 'Gペン', icon: Pen, shortcut: 'P' },
  { id: 'brush', name: 'ブラシ', icon: Brush, shortcut: 'A' },
  { id: 'eraser', name: '消しゴム', icon: Eraser, shortcut: 'E' },
  { id: 'line', name: '直線', icon: Slash, shortcut: 'L' },
  { id: 'rect', name: '長方形', icon: RectangleHorizontal, shortcut: 'R' },
  { id: 'ellipse', name: '楕円', icon: Circle, shortcut: 'O' },
  { id: 'fill', name: '塗りつぶし', icon: PaintBucket, shortcut: 'F' },
  { id: 'eyedropper', name: 'スポイト', icon: Pipette, shortcut: 'I' },
  { id: 'hand', name: '移動', icon: Hand, shortcut: 'H' },
]

function readSaved(): Project {
  try {
    const raw = localStorage.getItem(STORAGE)
    if (raw) {
      const value = JSON.parse(raw) as Project
      if (value.frames?.length && value.layers?.length && typeof value.activeFrame === 'number') return value
    }
  } catch { /* Skip invalid local data. */ }
  return createProject()
}

function secureCode() {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return String(10000 + (values[0] % 90000))
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<Project>
  return !!(Array.isArray(p.frames) && p.frames.length > 0 && p.frames.length <= 120 &&
    Array.isArray(p.layers) && p.layers.length > 0 && p.layers.length <= 12 &&
    typeof p.activeFrame === 'number' && p.activeFrame >= 0 && p.activeFrame < p.frames.length &&
    typeof p.activeLayer === 'string' && p.layers.some(l => l.id === p.activeLayer))
}

function applyBasicAction(doc: Project, action: Action): Project {
  switch (action.type) {
    case 'set': {
      if (action.key === 'fps') return { ...doc, fps: Math.max(1, Math.min(24, Number(action.value) || 8)) }
      if (action.key === 'activeFrame') return { ...doc, activeFrame: Math.max(0, Math.min(doc.frames.length - 1, Number(action.value) || 0)) }
      if (action.key === 'activeLayer') return doc.layers.some(l => l.id === action.value) ? { ...doc, activeLayer: String(action.value) } : doc
      if (action.key === 'name') return { ...doc, name: String(action.value).slice(0, 80) }
      if (action.key === 'background') return { ...doc, background: String(action.value) }
      if (action.key === 'grid' || action.key === 'onion') return { ...doc, [action.key]: Boolean(action.value) }
      return doc
    }
    case 'newFrame': return addFrame(doc, action.duplicate, action.id)
    case 'deleteFrame': return removeFrame(doc)
    case 'newLayer': return addLayer(doc, action.id)
    case 'updateLayer': return {
      ...doc, layers: doc.layers.map(l => l.id === action.id ? { ...l, [action.key]: action.value } : l),
    }
    case 'stroke': return appendStroke(doc, action.frame, action.layer, action.stroke)
    case 'replace': return isProject(action.project) ? action.project : doc
    case 'undo': return undoStroke(doc)
    default: return doc
  }
}

function Button({ children, onClick, className = '', title, disabled = false }: {
  children: ReactNode; onClick?: () => void; className?: string; title?: string; disabled?: boolean
}) {
  return <button type="button" className={`button ${className}`} title={title} onClick={onClick} disabled={disabled}>{children}</button>
}

function IconButton({ icon: Icon, title, active, onClick, disabled, className = '' }: {
  icon: typeof Pencil; title: string; active?: boolean; onClick?: () => void; disabled?: boolean; className?: string
}) {
  return <button type="button" aria-label={title} title={title} disabled={disabled}
    onClick={onClick} className={`icon-button ${active ? 'active' : ''} ${className}`}><Icon size={18} strokeWidth={1.85} /></button>
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand-mark"><span className="brand-symbol"><span /></span>
    {!compact && <span className="brand-word"><b>frame<span>.</span></b><small>ANIMATION STUDIO</small></span>}
  </div>
}

function Thumb({ project, index, active, onClick }: { project: Project; index: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    // Rapid pen input must not trigger a complete thumbnail redraw for each point/stroke.
    const timer = window.setTimeout(() => { if (ref.current) renderProject(ref.current, project, index) }, 180)
    return () => clearTimeout(timer)
  }, [project, index])
  return <button onClick={onClick} className={`frame-thumb ${active ? 'selected' : ''}`} title={`フレーム ${index + 1}`}>
    <div className="frame-thumb-image"><canvas ref={ref} width={WIDTH} height={HEIGHT} /></div>
    <span className="frame-number">{String(index + 1).padStart(2, '0')}</span>
    {active && <span className="frame-active-dot" />}
  </button>
}

const MemoThumb = memo(Thumb, (before, after) => before.index === after.index && before.active === after.active &&
  before.project.frames[before.index] === after.project.frames[after.index] &&
  before.project.layers === after.project.layers && before.project.background === after.project.background)

function CanvasStage({ project, frameIndex, live, tool, interactive, onStart, onPoint, onFinish, onCancel, onPick,
  zoom, setZoom, pan, setPan, displayOptions = true, className = '' }: {
  project: Project; frameIndex: number; live: { layer: string; stroke: Stroke } | null; tool: Tool; interactive: boolean
  onStart: (point: Point) => void; onPoint: (point: Point) => void; onFinish: () => void; onCancel: () => void; onPick: (value: string) => void
  zoom: number; setZoom: (v: number) => void; pan: { x: number; y: number }; setPan: (v: { x: number; y: number }) => void
  displayOptions?: boolean; className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ distance: number; zoom: number; x: number; y: number; cx: number; cy: number } | null>(null)
  const dragging = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const drawingId = useRef<number | null>(null)
  const lastPen = useRef(0)
  const renderedRef = useRef<{ project: Project; frameIndex: number; grid: boolean; onion: boolean } | null>(null)
  const destructivePreviewRef = useRef(false)

  useEffect(() => {
    const baseCanvas = canvas.current
    if (!baseCanvas) return
    const grid = displayOptions && project.grid
    const onion = displayOptions && project.onion
    const before = renderedRef.current
    const earlier = before?.project
    const prior = earlier?.frames[frameIndex]
    const current = project.frames[frameIndex]
    // A normal stroke on a single visible layer can be composited without replaying
    // the whole drawing. This keeps long animations responsive after hundreds of strokes.
    if (before && before.frameIndex === frameIndex && before.grid === grid && before.onion === onion &&
      !grid && earlier && earlier.frames.length === project.frames.length &&
      earlier.layers === project.layers && project.layers.length === 1 &&
      earlier.background === project.background && prior && current &&
      project.frames.every((frame, idx) => idx === frameIndex || earlier.frames[idx] === frame) &&
      prior !== current) {
      const id = project.layers[0].id
      const oldStrokes = prior.tracks[id] || []
      const newStrokes = current.tracks[id] || []
      const addition = newStrokes[newStrokes.length - 1]
      if (newStrokes.length === oldStrokes.length + 1 &&
        oldStrokes.every((item, idx) => item === newStrokes[idx]) &&
        addition && addition.tool !== 'eraser' && addition.tool !== 'fill') {
        drawStroke(baseCanvas.getContext('2d')!, addition)
        renderedRef.current = { project, frameIndex, grid, onion }
        return
      }
    }
    renderProject(baseCanvas, project, frameIndex, { onion, grid })
    renderedRef.current = { project, frameIndex, grid, onion }
  }, [project, frameIndex, displayOptions])

  // Render the active stroke separately; existing frames never need to be replayed on every pen event.
  useEffect(() => {
    const overlay = preview.current
    if (!overlay) return
    const ctx = overlay.getContext('2d')!
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    if (live?.stroke.tool === 'eraser' || live?.stroke.tool === 'fill') {
      if (canvas.current) renderProject(canvas.current, project, frameIndex, {
        onion: displayOptions && project.onion, grid: displayOptions && project.grid, extra: live,
      })
      destructivePreviewRef.current = true
    } else {
      if (destructivePreviewRef.current && canvas.current) {
        renderProject(canvas.current, project, frameIndex, {
          onion: displayOptions && project.onion, grid: displayOptions && project.grid,
        })
      }
      destructivePreviewRef.current = false
      if (live) drawStroke(ctx, live.stroke)
    }
  }, [live, project, frameIndex, displayOptions])

  const coord = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(WIDTH, (e.clientX - rect.left) / rect.width * WIDTH)),
      y: Math.max(0, Math.min(HEIGHT, (e.clientY - rect.top) / rect.height * HEIGHT)),
      p: e.pointerType === 'pen' ? Math.max(.15, e.pressure || .5) : 1 }
  }

  const pointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') lastPen.current = Date.now()
    else if (e.pointerType === 'touch' && Date.now() - lastPen.current < 700) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2) {
      if (drawingId.current !== null) { onCancel(); drawingId.current = null }
      const [a, b] = [...pointers.current.values()]
      gesture.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom, x: pan.x, y: pan.y,
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
      return
    }
    if (!interactive || tool === 'hand') {
      dragging.current = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
      return
    }
    if (tool === 'eyedropper') {
      const p = coord(e)
      if (canvas.current) onPick(sampleColor(canvas.current, p.x, p.y))
      return
    }
    drawingId.current = e.pointerId
    onStart(coord(e))
  }

  const pointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()]
      const centerX = (a.x + b.x) / 2
      const centerY = (a.y + b.y) / 2
      setZoom(Math.max(.35, Math.min(4, gesture.current.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.current.distance))))
      setPan({ x: gesture.current.x + centerX - gesture.current.cx, y: gesture.current.y + centerY - gesture.current.cy })
    } else if (dragging.current?.id === e.pointerId) {
      setPan({ x: dragging.current.panX + e.clientX - dragging.current.x,
        y: dragging.current.panY + e.clientY - dragging.current.y })
    } else if (drawingId.current === e.pointerId) {
      onPoint(coord(e))
    }
  }

  const pointerUp = (e: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) => {
    if (drawingId.current === e.pointerId) {
      if (cancelled) onCancel()
      else onFinish()
      drawingId.current = null
    }
    pointers.current.delete(e.pointerId)
    if (dragging.current?.id === e.pointerId) dragging.current = null
    if (pointers.current.size < 2) gesture.current = null
  }

  return <div className={`stage ${className}`} onWheel={e => {
    if (!e.ctrlKey && !e.altKey) return
    e.preventDefault()
    setZoom(Math.max(.35, Math.min(4, zoom * (e.deltaY > 0 ? .9 : 1.1))))
  }}>
    <div className="stage-surface"><div className="artboard" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" />
      <canvas ref={preview} width={WIDTH} height={HEIGHT}
        className={interactive && tool !== 'hand' ? 'draw-canvas' : 'move-canvas'}
        onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={e => pointerUp(e)} onPointerCancel={e => pointerUp(e, true)}
        onContextMenu={e => e.preventDefault()}
      />
    </div></div>
    {displayOptions && <div className="stage-corner">1280 × 720 <span>•</span> 16:9</div>}
  </div>
}

export default function App() {
  const [role, setRole] = useState<Role>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [code, setCode] = useState('')
  const [entryCode, setEntryCode] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<DataConnection | null>(null)
  const [project, setProject] = useState<Project>(readSaved)
  const projectRef = useRef(project)
  const peerRef = useRef<Peer | null>(null)
  const connRef = useRef<DataConnection | null>(null)
  const roleRef = useRef<Role>(role)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(PRESETS[0])
  const [size, setSize] = useState(8)
  const [opacity, setOpacity] = useState(100)
  const [pressure, setPressure] = useState(true)
  const [live, setLive] = useState<{ layer: string; stroke: Stroke } | null>(null)
  const liveRef = useRef<{ layer: string; stroke: Stroke } | null>(null)
  const drawFrameRef = useRef(0)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showSettings, setShowSettings] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState('')
  const historyRef = useRef<Project[]>([])
  const redoRef = useRef<Project[]>([])
  const hostBaseRef = useRef(project)
  const versionRef = useRef(0)
  const acceptedRef = useRef<string[]>([])
  const pendingActionsRef = useRef<{ id: string; action: Action; sent: boolean; sentAt: number }[]>([])
  const resumeTokenRef = useRef('')
  const everConnectedRef = useRef(false)
  const phoneReadyRef = useRef(false)
  const reconnectWantedRef = useRef(false)
  const pendingRef = useRef<DataConnection | null>(null)
  const retryTimerRef = useRef<number | null>(null)
  const connectTimerRef = useRef<number | null>(null)
  const attemptRef = useRef(0)
  const retryStartRef = useRef<() => void>(() => {})
  const scheduleRetryRef = useRef<() => void>(() => {})
  const flushActionsRef = useRef<() => void>(() => {})
  const lastReceivedRef = useRef(Date.now())
  const lastSyncRequestRef = useRef(0)
  const previewPointsRef = useRef<Point[]>([])
  const previewStrokeRef = useRef('')
  const previewTimerRef = useRef<number | null>(null)
  const liveRafRef = useRef<number | null>(null)

  // setDoc is the sole writer to projectRef. A React effect can run after newer
  // remote actions were applied and overwrite the ref with an older render.
  useEffect(() => { roleRef.current = role }, [role])
  useEffect(() => { const id = setTimeout(() => { try { localStorage.setItem(STORAGE, JSON.stringify(project)) } catch { /* Storage may be full. */ } }, 800); return () => clearTimeout(id) }, [project])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 2600); return () => clearTimeout(id) }, [toast])

  const send = useCallback((message: Wire, previewOnly = false): boolean => {
    const conn = connRef.current
    if (!conn?.open || conn.dataChannel?.readyState !== 'open') return false
    if (previewOnly && conn.dataChannel.bufferedAmount > 128_000) return false
    try { conn.send(message); return true } catch { return false }
  }, [])
  const setDoc = useCallback((next: Project) => { projectRef.current = next; setProject(next) }, [])
  const sync = useCallback((next: Project = projectRef.current) => {
    if (roleRef.current === 'pc') send({
      type: 'sync', project: next, version: versionRef.current,
      accepted: acceptedRef.current, resumeToken: resumeTokenRef.current,
    })
  }, [send])
  const scheduleLive = useCallback(() => {
    if (liveRafRef.current !== null) return
    liveRafRef.current = requestAnimationFrame(() => {
      liveRafRef.current = null
      const drawing = liveRef.current
      setLive(drawing ? { layer: drawing.layer, stroke: { ...drawing.stroke } } : null)
    })
  }, [])
  const reconcilePhone = useCallback(() => {
    let next = hostBaseRef.current
    for (const entry of pendingActionsRef.current) {
      // Undo/redo are resolved by an authoritative snapshot; other edits can be previewed offline.
      if (entry.action.type !== 'undo' && entry.action.type !== 'redo')
        next = applyBasicAction(next, entry.action)
    }
    setDoc(next)
  }, [setDoc])
  const flushActions = useCallback(() => {
    const conn = connRef.current
    if (roleRef.current !== 'phone' || !phoneReadyRef.current || !conn?.open) return
    const now = Date.now()
    let inFlight = 0
    for (const entry of pendingActionsRef.current) {
      if (entry.sent && now - entry.sentAt > 2500) entry.sent = false
      if (entry.sent) inFlight++
    }
    for (const entry of pendingActionsRef.current) {
      if (inFlight >= 6) break
      if (entry.sent) continue
      if (!conn.dataChannel || conn.dataChannel.readyState !== 'open' || conn.dataChannel.bufferedAmount > 64_000) break
      if (!send({ type: 'action', id: entry.id, action: entry.action })) break
      entry.sent = true
      entry.sentAt = now
      inFlight++
    }
  }, [send])
  flushActionsRef.current = flushActions
  useEffect(() => {
    const id = window.setInterval(() => flushActionsRef.current(), 60)
    return () => clearInterval(id)
  }, [])

  const execute = useCallback((input: Action, fromRemote = false) => {
    const action: Action = !fromRemote && input.type === 'newFrame' && !input.id
      ? { ...input, id: crypto.randomUUID() }
      : !fromRemote && input.type === 'newLayer' && !input.id
        ? { ...input, id: crypto.randomUUID() } : input
    const previous = projectRef.current
    let next = previous
    if (action.type === 'undo') {
      const back = historyRef.current.pop()
      if (back) { redoRef.current.push(previous); next = back }
    } else if (action.type === 'redo') {
      const forward = redoRef.current.pop()
      if (forward) { historyRef.current.push(previous); next = forward }
    } else {
      next = applyBasicAction(previous, action)
      if (next !== previous) {
        if (['stroke', 'deleteFrame', 'newFrame', 'newLayer', 'replace'].includes(action.type)) {
          historyRef.current.push(previous)
          if (historyRef.current.length > 35) historyRef.current.shift()
          redoRef.current = []
        }
      }
    }
    if (next !== previous) setDoc(next)
    if (roleRef.current === 'phone' && !fromRemote && next !== previous) {
      pendingActionsRef.current.push({ id: crypto.randomUUID(), action, sent: false, sentAt: 0 })
      flushActionsRef.current()
    }
    if (roleRef.current === 'pc' && next !== previous) {
      versionRef.current++
      if (!fromRemote) {
        if (action.type === 'set' || action.type === 'updateLayer' || action.type === 'stroke')
          send({ type: 'commit', version: versionRef.current, action })
        else sync(next)
      }
    }
  }, [send, setDoc, sync])

  const executeRef = useRef(execute)
  executeRef.current = execute

  const handleWire = useCallback((payload: unknown) => {
    if (!payload || typeof payload !== 'object' || !('type' in payload)) return
    const msg = payload as Wire
    lastReceivedRef.current = Date.now()
    if (msg.type === 'ping') { send({ type: 'pong' }, true); return }
    if (msg.type === 'pong') return
    if (roleRef.current === 'phone') {
      if (msg.type === 'sync' && isProject(msg.project)) {
        hostBaseRef.current = msg.project
        versionRef.current = msg.version
        resumeTokenRef.current = msg.resumeToken
        const accepted = new Set(msg.accepted || [])
        pendingActionsRef.current = pendingActionsRef.current
          .filter(entry => !accepted.has(entry.id))
          .map(entry => ({ ...entry, sent: false, sentAt: 0 }))
        reconcilePhone()
        everConnectedRef.current = true
        phoneReadyRef.current = true
        attemptRef.current = 0
        setStatus('connected')
        setError('')
        flushActionsRef.current()
      } else if (msg.type === 'commit') {
        if (msg.version === versionRef.current + 1) {
          hostBaseRef.current = applyBasicAction(hostBaseRef.current, msg.action)
          versionRef.current = msg.version
          reconcilePhone()
        } else if (msg.version > versionRef.current && Date.now() - lastSyncRequestRef.current > 1500) {
          lastSyncRequestRef.current = Date.now()
          send({ type: 'requestSync' })
        }
      } else if (msg.type === 'ack') {
        const entry = pendingActionsRef.current.find(item => item.id === msg.id)
        if (!entry) return
        pendingActionsRef.current = pendingActionsRef.current.filter(item => item.id !== msg.id)
        if (msg.version === versionRef.current + 1 &&
          (entry.action.type === 'set' || entry.action.type === 'updateLayer' || entry.action.type === 'stroke')) {
          hostBaseRef.current = applyBasicAction(hostBaseRef.current, entry.action)
          versionRef.current = msg.version
        } else if (msg.version !== versionRef.current) {
          if (Date.now() - lastSyncRequestRef.current > 1500) {
            lastSyncRequestRef.current = Date.now()
            send({ type: 'requestSync' })
          }
        }
        reconcilePhone()
        flushActionsRef.current()
      }
      return
    }
    if (roleRef.current !== 'pc') return
    if (msg.type === 'requestSync') { sync(); return }
    if (msg.type === 'action' && msg.id && msg.action && typeof msg.action.type === 'string') {
      if (acceptedRef.current.includes(msg.id)) {
        send({ type: 'ack', id: msg.id, version: versionRef.current })
        return
      }
      if (msg.action.type === 'stroke') { liveRef.current = null; setLive(null) }
      executeRef.current(msg.action, true)
      acceptedRef.current.push(msg.id)
      if (acceptedRef.current.length > 1200) acceptedRef.current.shift()
      send({ type: 'ack', id: msg.id, version: versionRef.current })
      if (msg.action.type !== 'set' && msg.action.type !== 'updateLayer' && msg.action.type !== 'stroke') sync()
    }
    if (msg.type === 'start' && msg.stroke && msg.stroke.points?.length && msg.frame >= 0 && msg.frame < projectRef.current.frames.length &&
        projectRef.current.layers.some(l => l.id === msg.layer && !l.locked)) {
      liveRef.current = { layer: msg.layer, stroke: msg.stroke }
      setLive(liveRef.current)
      drawFrameRef.current = msg.frame
    }
    if (msg.type === 'points' && liveRef.current && liveRef.current.stroke.id === msg.strokeId &&
        Array.isArray(msg.points) && msg.points.length <= 64) {
      if (['line', 'rect', 'ellipse'].includes(liveRef.current.stroke.tool)) {
        liveRef.current.stroke.points = [liveRef.current.stroke.points[0], msg.points[msg.points.length - 1]]
      } else {
        for (const point of msg.points)
          if (Number.isFinite(point.x) && Number.isFinite(point.y)) liveRef.current.stroke.points.push(point)
      }
      scheduleLive()
    }
    if (msg.type === 'cancel') { liveRef.current = null; setLive(null) }
  }, [reconcilePhone, scheduleLive, send, sync])

  const handleWireRef = useRef(handleWire)
  handleWireRef.current = handleWire

  const closePeer = useCallback(() => {
    reconnectWantedRef.current = false
    phoneReadyRef.current = false
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current)
    if (connectTimerRef.current !== null) clearTimeout(connectTimerRef.current)
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current)
    if (liveRafRef.current !== null) cancelAnimationFrame(liveRafRef.current)
    retryTimerRef.current = null
    connectTimerRef.current = null
    previewTimerRef.current = null
    liveRafRef.current = null
    const oldConn = connRef.current
    connRef.current = null
    oldConn?.close()
    const oldPeer = peerRef.current
    peerRef.current = null
    oldPeer?.destroy()
    pendingRef.current = null
    setPending(null)
  }, [])
  useEffect(() => () => closePeer(), [closePeer])

  const onConnected = useCallback((conn: DataConnection, isHost: boolean) => {
    connRef.current = conn
    lastReceivedRef.current = Date.now()
    if (connectTimerRef.current !== null) clearTimeout(connectTimerRef.current)
    connectTimerRef.current = null
    conn.on('data', value => handleWireRef.current(value))
    const disconnected = () => {
      if (connRef.current !== conn) return
      connRef.current = null
      phoneReadyRef.current = false
      previewPointsRef.current = []
      liveRef.current = null
      setLive(null)
      if (isHost) {
        setStatus('ready')
      } else if (reconnectWantedRef.current) {
        for (const entry of pendingActionsRef.current) { entry.sent = false; entry.sentAt = 0 }
        setStatus('reconnecting')
        setError('接続を復旧しています。描画は端末内に保持されます。')
        scheduleRetryRef.current()
      }
    }
    conn.on('close', disconnected)
    conn.on('error', () => {
      disconnected()
      if (conn.open) conn.close()
    })
    if (isHost) {
      setStatus('connected')
      sync()
    } else setStatus(everConnectedRef.current ? 'reconnecting' : 'waiting')
  }, [sync])

  const startPhoneAttempt = useCallback(() => {
    if (!reconnectWantedRef.current || !/^\d{5}$/.test(entryCode)) return
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current)
    if (connectTimerRef.current !== null) clearTimeout(connectTimerRef.current)
    const oldConn = connRef.current
    connRef.current = null
    oldConn?.close()
    const oldPeer = peerRef.current
    peerRef.current = null
    oldPeer?.destroy()
    const peer = new Peer()
    peerRef.current = peer
    setStatus(everConnectedRef.current ? 'reconnecting' : 'connecting')
    const fail = (message: string) => {
      if (peerRef.current !== peer || !reconnectWantedRef.current) return
      if (connectTimerRef.current !== null) clearTimeout(connectTimerRef.current)
      connectTimerRef.current = null
      if (everConnectedRef.current) {
        setStatus('reconnecting')
        setError(message)
        scheduleRetryRef.current()
      } else {
        setStatus('error')
        setError(message)
        reconnectWantedRef.current = false
      }
    }
    connectTimerRef.current = window.setTimeout(() => fail('接続がタイムアウトしました。'), 16_000)
    peer.on('open', () => {
      if (peerRef.current !== peer) return
      const conn = peer.connect(`frame-studio-${entryCode}`, {
        reliable: true, serialization: 'binary',
        metadata: { resumeToken: resumeTokenRef.current || undefined },
      })
      conn.on('open', () => {
        if (peerRef.current === peer) onConnected(conn, false)
        else conn.close()
      })
      conn.on('error', () => fail('接続が中断しました。再試行します。'))
      conn.on('close', () => {
        if (connRef.current !== conn) fail('接続が切れました。')
      })
    })
    peer.on('disconnected', () => {
      if (peerRef.current !== peer || peer.destroyed) return
      try { peer.reconnect() } catch { fail('接続サービスに再接続しています。') }
    })
    peer.on('error', err => fail(err.type === 'peer-unavailable'
      ? 'このコードのPCが見つかりません。'
      : `接続サービスのエラー（${err.type}）`))
  }, [entryCode, onConnected])
  retryStartRef.current = startPhoneAttempt
  const scheduleRetry = useCallback(() => {
    if (!reconnectWantedRef.current || retryTimerRef.current !== null) return
    const delay = Math.min(12_000, 1200 * Math.pow(1.7, Math.min(attemptRef.current++, 5)))
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null
      retryStartRef.current()
    }, delay)
  }, [])
  scheduleRetryRef.current = scheduleRetry

  useEffect(() => {
    const check = window.setInterval(() => {
      const conn = connRef.current
      if (!conn?.open) return
      if (Date.now() - lastReceivedRef.current > 30_000) {
        conn.close()
      } else send({ type: 'ping' }, true)
    }, 5000)
    const wake = () => {
      if (roleRef.current === 'phone' && reconnectWantedRef.current && !connRef.current?.open)
        scheduleRetryRef.current()
    }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      clearInterval(check)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [send])

  const createHost = useCallback(() => {
    closePeer()
    everConnectedRef.current = false
    resumeTokenRef.current = ''
    versionRef.current = 0
    acceptedRef.current = []
    setRole('pc'); roleRef.current = 'pc'; setError(''); setCode(''); setStatus('creating')
    const hostCode = secureCode()
    const peer = new Peer(`frame-studio-${hostCode}`)
    peerRef.current = peer
    peer.on('open', () => { setCode(hostCode); setStatus('ready') })
    peer.on('connection', incoming => {
      if (connRef.current?.open || pendingRef.current?.open) {
        incoming.on('open', () => incoming.close())
        return
      }
      incoming.on('open', () => {
        if (peerRef.current !== peer) { incoming.close(); return }
        if (resumeTokenRef.current && incoming.metadata?.resumeToken === resumeTokenRef.current) {
          onConnected(incoming, true)
        } else {
          pendingRef.current = incoming
          setPending(incoming)
        }
      })
      const clearPending = () => {
        if (pendingRef.current === incoming) pendingRef.current = null
        setPending(current => current === incoming ? null : current)
      }
      incoming.on('error', clearPending)
      incoming.on('close', clearPending)
    })
    peer.on('error', err => {
      setError(err.type === 'unavailable-id' ? 'コードが重複しました。再発行してください。' : `接続サービスにアクセスできません（${err.type}）。`)
      setStatus('error')
    })
    peer.on('disconnected', () => {
      if (!peer.destroyed) { try { peer.reconnect() } catch { setError('接続サービスへの再接続に失敗しました。') } }
    })
  }, [closePeer, onConnected])

  const createPhone = useCallback(() => {
    closePeer(); setRole('phone'); roleRef.current = 'phone'; setStatus('idle'); setError('')
    pendingActionsRef.current = []
    resumeTokenRef.current = ''
    everConnectedRef.current = false
  }, [closePeer])

  const connectPhone = useCallback(() => {
    if (!/^\d{5}$/.test(entryCode)) { setError('5桁の数字を入力してください。'); return }
    reconnectWantedRef.current = true
    resumeTokenRef.current = ''
    attemptRef.current = 0
    setError('')
    startPhoneAttempt()
  }, [entryCode, startPhoneAttempt])

  const acceptPending = () => {
    if (pending?.open) {
      resumeTokenRef.current = crypto.randomUUID()
      onConnected(pending, true)
    }
    pendingRef.current = null
    setPending(null)
  }

  const flushPreview = () => {
    if (!previewStrokeRef.current) return
    while (previewPointsRef.current.length) {
      const points = previewPointsRef.current.splice(0, 48)
      // Preview traffic is expendable. A completed stroke is always sent reliably.
      if (!send({ type: 'points', strokeId: previewStrokeRef.current, points }, true)) {
        previewPointsRef.current = []
        break
      }
    }
  }
  const drawStart = (p: Point) => {
    if (playing) setPlaying(false)
    if (roleRef.current === 'phone' && !everConnectedRef.current) return
    const layer = projectRef.current.layers.find(l => l.id === projectRef.current.activeLayer)
    if (!layer || layer.locked || !layer.visible) { setToast('レイヤーのロックまたは非表示を解除してください'); return }
    const stroke: Stroke = { id: crypto.randomUUID(), tool: tool as Stroke['tool'], color, size, opacity: opacity / 100, pressure, points: [p] }
    drawFrameRef.current = projectRef.current.activeFrame
    liveRef.current = { layer: layer.id, stroke }
    setLive(liveRef.current)
    previewStrokeRef.current = stroke.id
    previewPointsRef.current = []
    if (roleRef.current === 'phone') send({ type: 'start', frame: drawFrameRef.current, layer: layer.id, stroke }, true)
  }

  const drawPoint = (p: Point) => {
    if (!liveRef.current) return
    const previous = liveRef.current
    const toolId = previous.stroke.tool
    const rounded: Point = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, p: Math.round(p.p * 100) / 100 }
    const points = previous.stroke.points
    const last = points[points.length - 1]
    if (Math.abs(last.x - rounded.x) + Math.abs(last.y - rounded.y) < .35) return
    if (toolId === 'line' || toolId === 'rect' || toolId === 'ellipse')
      previous.stroke.points = [points[0], rounded]
    else points.push(rounded)
    scheduleLive()
    if (roleRef.current === 'phone') {
      if (toolId === 'line' || toolId === 'rect' || toolId === 'ellipse') previewPointsRef.current = [rounded]
      else previewPointsRef.current.push(rounded)
      if (previewTimerRef.current === null) {
        previewTimerRef.current = window.setTimeout(() => {
          previewTimerRef.current = null
          flushPreview()
        }, 32)
      }
    }
  }

  const drawFinish = () => {
    const current = liveRef.current
    if (!current) return
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
    flushPreview()
    previewStrokeRef.current = ''
    previewPointsRef.current = []
    liveRef.current = null; setLive(null)
    execute({ type: 'stroke', frame: drawFrameRef.current, layer: current.layer, stroke: current.stroke })
  }
  const drawCancel = () => {
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
    previewStrokeRef.current = ''
    previewPointsRef.current = []
    liveRef.current = null
    setLive(null)
    if (roleRef.current === 'phone') send({ type: 'cancel' }, true)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!role || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && key === 'z') { e.preventDefault(); execute({ type: e.shiftKey ? 'redo' : 'undo' }); return }
      if (e.code === 'Space') { e.preventDefault(); setPlaying(v => !v); return }
      if (key === 'arrowright') { execute({ type: 'set', key: 'activeFrame', value: Math.min(projectRef.current.activeFrame + 1, projectRef.current.frames.length - 1) }); return }
      if (key === 'arrowleft') { execute({ type: 'set', key: 'activeFrame', value: Math.max(0, projectRef.current.activeFrame - 1) }); return }
      const chosen = TOOLS.find(t => t.shortcut.toLowerCase() === key)
      if (chosen) setTool(chosen.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [role, execute])

  useEffect(() => {
    if (!playing) return
    setPlayhead(projectRef.current.activeFrame)
    const timer = window.setInterval(() => setPlayhead(i => (i + 1) % projectRef.current.frames.length), 1000 / project.fps)
    return () => clearInterval(timer)
  }, [playing, project.fps])

  const exportImage = () => {
    const canvas = document.createElement('canvas')
    renderProject(canvas, projectRef.current, projectRef.current.activeFrame)
    canvas.toBlob(blob => { if (blob) downloadBlob(blob, `${projectRef.current.name}-frame-${projectRef.current.activeFrame + 1}.png`) }, 'image/png')
    setShowExport(false)
    setToast('PNG画像を書き出しました')
  }

  const exportGif = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const encoder = GIFEncoder()
      const source = document.createElement('canvas')
      const small = document.createElement('canvas')
      small.width = 640; small.height = 360
      const ctx = small.getContext('2d', { willReadFrequently: true })!
      const doc = projectRef.current
      for (let i = 0; i < doc.frames.length; i++) {
        renderProject(source, doc, i)
        ctx.drawImage(source, 0, 0, small.width, small.height)
        const pixels = ctx.getImageData(0, 0, small.width, small.height).data
        const palette = quantize(pixels, 256)
        const indexed = applyPalette(pixels, palette)
        encoder.writeFrame(indexed, small.width, small.height, { palette, delay: Math.round(1000 / doc.fps) })
        if (i % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      }
      encoder.finish()
      downloadBlob(new Blob([new Uint8Array(encoder.bytes())], { type: 'image/gif' }), `${doc.name}.gif`)
      setShowExport(false)
      setToast('アニメーションGIFを保存しました')
    } catch { setToast('GIFの書き出しに失敗しました') }
    finally { setExporting(false) }
  }

  const exportProject = () => {
    downloadBlob(new Blob([JSON.stringify(projectRef.current)], { type: 'application/json' }), `${projectRef.current.name}.frame.json`)
    setShowExport(false)
    setToast('編集可能なプロジェクトを保存しました')
  }

  const fileInput = useRef<HTMLInputElement>(null)
  const importProject = async (file: File) => {
    try {
      const value: unknown = JSON.parse(await file.text())
      if (!isProject(value)) throw Error('invalid')
      execute({ type: 'replace', project: value })
      setToast('プロジェクトを読み込みました')
    } catch { setToast('対応していないプロジェクトファイルです') }
  }

  const choose = (action: Action) => execute(action)
  const activeFrame = playing ? playhead : project.activeFrame
  const layers = [...project.layers].reverse()
  const connected = status === 'connected'

  if (!role) return <div className="landing">
    <header className="landing-nav"><Brand /><span className="nav-right"><span className="nav-dot" /> BROWSER-BASED ANIMATION STUDIO <span className="nav-version">v1.0</span></span></header>
    <main className="landing-main">
      <div className="hero-left"><div className="eyebrow"><Sparkles size={13} /> YOUR IDEAS, IN MOTION</div>
        <h1>その1コマが、<br /><em>動き</em>になる。</h1>
        <p className="hero-description">スマホで描く。PCで確認する。<br />思いついた瞬間から、アニメーション制作をはじめよう。</p>
        <div className="hero-select-title"><span>01</span> デバイスを選んではじめる</div>
        <div className="role-cards">
          <button className="role-card" onClick={createHost}><span className="role-icon pc"><Monitor size={28} /></span>
            <span className="role-text"><b>PCでスタジオを開く</b><small>プレビュー・タイムライン・作品管理</small></span><ArrowRight size={19} /></button>
          <button className="role-card" onClick={createPhone}><span className="role-icon phone"><Smartphone size={28} /></span>
            <span className="role-text"><b>スマホで描く</b><small>Apple Pencil・ペンツール・直感操作</small></span><ArrowRight size={19} /></button>
        </div>
        <div className="hero-footnote"><ShieldCheck size={15} /> インストール不要・5桁のコードで接続・自動保存</div>
      </div>
      <div className="hero-visual"><div className="hero-orbit one" /><div className="hero-orbit two" />
        <div className="visual-pc"><div className="mock-top"><span className="mock-logo">frame<span>.</span></span><span>● ● ●</span></div>
          <div className="mock-body"><div className="mock-tools"><span /><span /><span /><span /></div><div className="mock-art">
            <svg viewBox="0 0 440 256" fill="none"><circle cx="218" cy="123" r="93" fill="#fff1d9" />
              <path d="M133 162c1-61 37-108 83-106 57 2 102 54 88 118-11 54-78 61-117 44-29-12-55-31-54-56Z" fill="#ffd99b" stroke="#24283d" strokeWidth="3" />
              <path d="M147 99c6-62 55-79 89-59 25-13 80 19 76 72-21-28-54-43-87-44-29 11-50 24-78 31Z" fill="#423e61" stroke="#24283d" strokeWidth="3" />
              <path d="M177 134c8-16 23-18 35-2m24 1c10-15 24-16 36-3" stroke="#24283d" strokeWidth="5" strokeLinecap="round" />
              <path d="M221 145c-5 10-4 15 7 16m-30 17c16 13 35 14 53-2" stroke="#24283d" strokeWidth="3" strokeLinecap="round" />
              <path d="M163 206c-38 10-46 30-47 50h211c-3-28-20-42-49-50" fill="#8f9be6" stroke="#24283d" strokeWidth="3" />
              <path d="m335 54 7-16m14 35 21-5M96 165l-15 10" stroke="#e5aa5e" strokeWidth="4" strokeLinecap="round" /></svg>
          </div><div className="mock-side"><span /><span /><span /></div></div><div className="mock-timeline"><i /><i /><i /><i /><i /></div></div>
        <div className="visual-phone"><div className="phone-notch" /><div className="phone-demo"><div className="demo-stroke" /><div className="demo-swatches"><i /><i /><i /><i /></div></div></div>
        <div className="visual-connected"><span className="pulse-dot" /> LIVE SYNC <span>↗</span></div>
        <span className="float-label top">FRAME BY FRAME ✳</span><span className="float-label bottom">DRAW • ANIMATE • CREATE</span>
      </div>
    </main><footer className="landing-footer"><span>CREATIVITY LOOKS BETTER IN MOTION.</span><span>DESIGNED FOR EVERY FIRST FRAME ↗</span></footer>
  </div>

  if (role === 'phone' && !everConnectedRef.current) return <div className="connect-page">
    <div className="connect-head"><button onClick={() => { closePeer(); setRole(null) }}><ArrowLeft size={19} /></button><Brand compact /></div>
    <div className="connect-content"><div className="connect-art"><Smartphone size={44} /><div className="connect-wave" /></div>
      <div className="eyebrow">CONNECT YOUR DEVICE</div><h2>PCとつないで、<br />描きはじめよう。</h2>
      <p>PC画面に表示されている5桁のコードを入力してください。</p>
      <label htmlFor="code-input" className="input-label">接続コード</label>
      <input id="code-input" className="code-input" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={5} placeholder="00000"
        value={entryCode} onChange={e => setEntryCode(e.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={e => { if (e.key === 'Enter') connectPhone() }} />
      <Button className="primary connect-submit" onClick={connectPhone} disabled={status === 'connecting' || status === 'waiting' || entryCode.length !== 5}>
        {status === 'connecting' ? '接続しています…' : status === 'waiting' ? 'PCでの承認を待っています…' : <>接続する <ArrowRight size={19} /></>}</Button>
      {error && <div className="connect-error"><WifiOff size={15} /> {error}</div>}
      {status === 'waiting' && <div className="connect-help"><ShieldCheck size={17} /> PC側で「接続を許可」を押してください。</div>}
      <div className="connect-steps"><span><b>1</b> PCでスタジオを開く</span><span><b>2</b> 5桁のコードを入力</span><span><b>3</b> PCで接続を許可</span></div>
    </div>
  </div>

  const isPhone = role === 'phone'
  return <div className={`studio ${isPhone ? 'studio-phone' : 'studio-pc'}`}>
    <header className="studio-header">
      <div className="header-left"><button className="header-back" title="デバイス選択に戻る" onClick={() => { closePeer(); setRole(null); setPlaying(false) }}><Brand compact /></button><span className="header-divider" />
        <input className="project-title" aria-label="作品名" value={project.name} onChange={e => choose({ type: 'set', key: 'name', value: e.target.value })} />
        <span className="save-indicator"><Check size={13} /> 自動保存</span></div>
      <div className="header-actions">
        <span className={`connection-pill ${connected ? 'is-connected' : isPhone ? 'is-reconnecting' : ''}`}><span className="pulse-dot" /> {connected ? 'LIVE接続中' : isPhone ? '再接続中' : '待機中'}</span>
        {!isPhone && <Button className="outline tiny" onClick={() => { navigator.clipboard?.writeText(code).then(() => setToast('コードをコピーしました')).catch(() => setToast(`接続コード: ${code}`)) }}><Link2 size={15} /> <span className="hide-small">接続コード</span> {code || '·····'}</Button>}
        <IconButton icon={CircleHelp} title="使い方" onClick={() => setShowHelp(true)} />
        <Button className="primary tiny export-main" onClick={() => setShowExport(true)}><Download size={16} /> <span>書き出し</span></Button>
      </div>
    </header>

    {role === 'pc' && <div className="desktop-layout">
      <aside className="tool-rail"><div className="rail-heading">TOOLS</div>
        {TOOLS.map(t => <IconButton key={t.id} icon={t.icon} title={`${t.name} (${t.shortcut})`} active={tool === t.id} onClick={() => setTool(t.id)} />)}
        <div className="rail-spacer" /><div className="rail-separator" />
        <IconButton icon={Undo2} title="元に戻す (Ctrl+Z)" onClick={() => choose({ type: 'undo' })} />
        <IconButton icon={Redo2} title="やり直す (Ctrl+Shift+Z)" onClick={() => choose({ type: 'redo' })} />
      </aside>
      <section className="workspace-main">
        <div className="workspace-toolbar"><div className="workspace-crumb"><span>WORKSPACE</span><ChevronRight size={14} /><b>キャンバス</b></div>
          <div className="workspace-toolbar-right"><Button className={`chip ${project.onion ? 'checked' : ''}`} onClick={() => choose({ type: 'set', key: 'onion', value: !project.onion })}><FlipHorizontal2 size={15} /> オニオンスキン</Button>
            <IconButton icon={Grid2X2} title="グリッド" active={project.grid} onClick={() => choose({ type: 'set', key: 'grid', value: !project.grid })} />
            <span className="toolbar-divide" /><IconButton icon={ZoomOut} title="縮小" onClick={() => setZoom(Math.max(.35, zoom - .15))} /><span className="zoom-value">{Math.round(zoom * 100)}%</span><IconButton icon={ZoomIn} title="拡大" onClick={() => setZoom(Math.min(4, zoom + .15))} />
            <IconButton icon={Maximize} title="表示をリセット" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} />
          </div></div>
        <div className="canvas-wrap"><CanvasStage project={project} frameIndex={activeFrame} live={live} tool={tool} interactive={false}
          onStart={drawStart} onPoint={drawPoint} onFinish={drawFinish} onCancel={drawCancel} onPick={setColor}
          zoom={zoom} setZoom={setZoom} pan={pan} setPan={setPan} />
          {!connected && <div className="live-tip"><span className="tip-glow"><Wifi size={17} /></span><span>{status === 'creating' ? '接続コードを発行しています…' : 'スマホを接続すると、ここに描画がリアルタイム表示されます。'}</span></div>}
          {error && <div className="canvas-alert">{error} <button onClick={createHost}>コード再発行</button></div>}
        </div>
        <section className="timeline"><div className="timeline-top"><div className="timeline-title"><Clapperboard size={17} /><b>タイムライン</b><span>{project.frames.length} FRAMES</span></div>
          <div className="timeline-controls"><IconButton icon={ChevronLeft} title="前のフレーム" onClick={() => choose({ type: 'set', key: 'activeFrame', value: Math.max(0, project.activeFrame - 1) })} />
            <button className="play-button" onClick={() => setPlaying(p => !p)} aria-label={playing ? '停止' : '再生'}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
            <IconButton icon={ChevronRight} title="次のフレーム" onClick={() => choose({ type: 'set', key: 'activeFrame', value: Math.min(project.frames.length - 1, project.activeFrame + 1) })} />
            <span className="timeline-time">{String(activeFrame + 1).padStart(2, '0')} <span>/ {String(project.frames.length).padStart(2, '0')}</span></span>
            <span className="toolbar-divide" /><span className="fps-label">FPS</span><select aria-label="再生速度" value={project.fps} onChange={e => choose({ type: 'set', key: 'fps', value: Number(e.target.value) })}>{[4, 6, 8, 10, 12, 15, 18, 24].map(v => <option key={v}>{v}</option>)}</select>
          </div></div>
          <div className="timeline-strip">{project.frames.map((frame, i) => <MemoThumb key={frame.id} project={project} index={i} active={activeFrame === i} onClick={() => { setPlaying(false); choose({ type: 'set', key: 'activeFrame', value: i }) }} />)}
            <div className="timeline-add"><button title="空のフレームを追加" onClick={() => choose({ type: 'newFrame', duplicate: false })}><Plus size={20} /><span>新規</span></button>
              <button title="現在のフレームを複製" onClick={() => choose({ type: 'newFrame', duplicate: true })}><Copy size={17} /><span>複製</span></button></div></div>
          <div className="timeline-bottom"><span><span className="keyboard-key">SPACE</span> 再生 / 停止</span><span><span className="keyboard-key">← →</span> フレーム移動</span>
            <Button className="text-action danger" onClick={() => choose({ type: 'deleteFrame' })} disabled={project.frames.length === 1}><Trash2 size={14} /> フレーム削除</Button></div>
        </section>
      </section>
      <aside className={`inspector ${showSettings ? '' : 'inspector-hidden'}`}>
        <div className="inspector-heading"><div><Settings2 size={17} /> インスペクター</div><IconButton icon={MoreHorizontal} title="パネルの表示切替" onClick={() => setShowSettings(s => !s)} /></div>
        {showSettings && <><div className="inspector-section"><div className="section-heading"><span>PROJECT</span><SlidersHorizontal size={14} /></div>
          <div className="property-row"><span>キャンバス</span><b>1280 × 720</b></div><div className="property-row"><span>フレームレート</span><b>{project.fps} fps</b></div>
          <div className="property-row"><span>再生時間</span><b>{(project.frames.length / project.fps).toFixed(2)} 秒</b></div>
          <div className="property-row"><span>背景色</span><label className="background-control"><input type="color" value={project.background} onChange={e => choose({ type: 'set', key: 'background', value: e.target.value })} /> {project.background}</label></div>
        </div>
        <div className="inspector-section"><div className="section-heading"><span>VIEW</span><Eye size={14} /></div>
          <label className="toggle-row"><span>オニオンスキン<small>前後の絵を薄く表示</small></span><input type="checkbox" checked={project.onion} onChange={e => choose({ type: 'set', key: 'onion', value: e.target.checked })} /><i /></label>
          <label className="toggle-row"><span>ガイドグリッド</span><input type="checkbox" checked={project.grid} onChange={e => choose({ type: 'set', key: 'grid', value: e.target.checked })} /><i /></label>
        </div>
        <div className="inspector-section layer-section"><div className="section-heading"><span>LAYERS <em>{project.layers.length}</em></span><button aria-label="レイヤーを追加" title="レイヤーを追加" onClick={() => choose({ type: 'newLayer' })}><Plus size={17} /></button></div>
          <div className="layer-list">{layers.map(layer => <div key={layer.id} className={`layer-item ${layer.id === project.activeLayer ? 'selected' : ''}`}>
            <button className="layer-select" onClick={() => choose({ type: 'set', key: 'activeLayer', value: layer.id })}><span className="layer-icon"><Layers size={15} /></span><span>{layer.name}</span></button>
            <IconButton icon={layer.visible ? Eye : EyeOff} title="表示切替" onClick={() => choose({ type: 'updateLayer', id: layer.id, key: 'visible', value: !layer.visible })} />
            <IconButton icon={layer.locked ? Lock : Unlock} title="ロック切替" onClick={() => choose({ type: 'updateLayer', id: layer.id, key: 'locked', value: !layer.locked })} />
          </div>)}</div>
        </div>
        <div className="inspector-helper"><div className="helper-sparkle"><Sparkles size={18} /></div><b>はじめてのアニメ制作？</b><p>最初の1コマから再生まで、ステップごとにご案内します。</p><button onClick={() => setShowHelp(true)}>制作ガイドを開く <ArrowRight size={15} /></button></div>
        </>}
      </aside>
    </div>}

    {isPhone && <div className="phone-layout">
      <div className="mobile-context"><div className="mobile-work-label"><span className="pulse-dot" /> {connected ? 'PCと同期中' : 'オフライン編集・再接続中'}</div><div className="mobile-frame-indicator">FRAME <b>{String(project.activeFrame + 1).padStart(2, '0')}</b><span> / {String(project.frames.length).padStart(2, '0')}</span></div></div>
      {!connected && <div className="recovery-notice" role="status"><WifiOff size={17} /><span>接続を復旧しています。描画は保存され、復旧後に転送されます。</span><button onClick={startPhoneAttempt}>再接続</button></div>}
      <div className="mobile-stage-wrap"><CanvasStage className="mobile-stage" project={project} frameIndex={activeFrame} live={live} tool={tool} interactive
        onStart={drawStart} onPoint={drawPoint} onFinish={drawFinish} onCancel={drawCancel} onPick={setColor}
        zoom={zoom} setZoom={setZoom} pan={pan} setPan={setPan} />
        <div className="mobile-zoom-controls"><IconButton icon={Minus} title="縮小" onClick={() => setZoom(Math.max(.35, zoom - .2))} /><span>{Math.round(zoom * 100)}%</span><IconButton icon={Plus} title="拡大" onClick={() => setZoom(Math.min(4, zoom + .2))} /><IconButton icon={Maximize} title="ズームを戻す" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} /></div>
      </div>
      <div className="mobile-drawing-panel"><div className="mobile-panel-handle" />
        <div className="mobile-tool-title"><span><Palette size={16} /> 描画ツール</span><div><IconButton icon={Undo2} title="戻す" onClick={() => choose({ type: 'undo' })} /><IconButton icon={Redo2} title="やり直す" onClick={() => choose({ type: 'redo' })} /></div></div>
        <div className="mobile-tools">{TOOLS.map(t => <button key={t.id} className={`mobile-tool ${tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)}><t.icon size={21} strokeWidth={1.85} /><span>{t.name}</span></button>)}</div>
        <div className="mobile-color-row"><div className="color-picker-wrap"><input type="color" aria-label="色を選ぶ" value={color} onChange={e => setColor(e.target.value)} /><span className="color-picker-border" /></div>
          <div className="palette-swatches">{PRESETS.map(s => <button key={s} aria-label={`色 ${s}`} className={color === s ? 'chosen' : ''} style={{ '--swatch': s } as CSSProperties} onClick={() => setColor(s)} />)}</div></div>
        <div className="mobile-sliders"><label><span><Droplets size={15} /> ブラシサイズ</span><b>{size} px</b><input aria-label="ブラシサイズ" type="range" min="1" max="80" value={size} onChange={e => setSize(Number(e.target.value))} /></label>
          <label><span>不透明度</span><b>{opacity}%</b><input aria-label="不透明度" type="range" min="5" max="100" step="5" value={opacity} onChange={e => setOpacity(Number(e.target.value))} /></label></div>
        <div className="mobile-quick-row"><label className="pressure-control"><input type="checkbox" checked={pressure} onChange={e => setPressure(e.target.checked)} /><span><Check size={13} /></span> 筆圧を反映</label><span>Apple Pencil / タッチ対応</span></div>
        <div className="mobile-timeline"><div><span>FRAMES</span><b>{project.frames.length} 枚</b></div><div className="mobile-frame-actions"><IconButton icon={ChevronLeft} title="前のフレーム" onClick={() => choose({ type: 'set', key: 'activeFrame', value: Math.max(0, project.activeFrame - 1) })} /><span>{project.activeFrame + 1} / {project.frames.length}</span><IconButton icon={ChevronRight} title="次のフレーム" onClick={() => choose({ type: 'set', key: 'activeFrame', value: Math.min(project.frames.length - 1, project.activeFrame + 1) })} /><IconButton icon={Plus} title="フレームを追加" onClick={() => choose({ type: 'newFrame', duplicate: false })} /><IconButton icon={Copy} title="フレームを複製" onClick={() => choose({ type: 'newFrame', duplicate: true })} /></div></div>
        <div className="mobile-options"><Button onClick={() => choose({ type: 'set', key: 'onion', value: !project.onion })} className={`chip ${project.onion ? 'checked' : ''}`}><FlipHorizontal2 size={15} /> オニオンスキン</Button>
          <Button onClick={() => choose({ type: 'newLayer' })} className="chip"><Layers size={15} /> レイヤー追加</Button><div className="mobile-layer-dropdown"><Layers size={14} /><select aria-label="描画レイヤー" value={project.activeLayer} onChange={e => choose({ type: 'set', key: 'activeLayer', value: e.target.value })}>{project.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select><ChevronDown size={13} /></div></div>
      </div>
    </div>}

    {role === 'pc' && status !== 'connected' && <div className="session-card"><div className="session-heading"><div className="session-symbol"><Smartphone size={19} /></div><span><b>スマホをペアリング</b><small>接続コードをスマホに入力</small></span><button onClick={() => setToast('スマホでこのサイトを開いてください')}><CircleHelp size={16} /></button></div>
      <div className="session-code">{(code || '•••••').split('').map((number, i) => <span key={i}>{number}</span>)}</div>
      <div className="session-actions"><span><span className="pulse-dot" /> {status === 'ready' ? '接続待機中' : status === 'creating' ? '発行中' : '再接続が必要です'}</span><button onClick={createHost} title="コードを再発行"><RefreshCw size={16} /></button></div></div>}

    {pending && role === 'pc' && <div className="modal-backdrop"><div className="dialog approval"><div className="dialog-icon"><ShieldCheck size={25} /></div><h3>スマホから接続リクエスト</h3><p>コードを入力したスマホをこのスタジオに接続しますか？</p><div className="dialog-actions"><Button onClick={() => { pending.close(); setPending(null) }} className="outline">拒否する</Button><Button className="primary" onClick={acceptPending}>接続を許可 <Check size={16} /></Button></div></div></div>}

    {showExport && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowExport(false) }}><div className="dialog export-dialog"><button className="dialog-close" onClick={() => setShowExport(false)}><X size={19} /></button><div className="dialog-icon"><Download size={24} /></div><h3>作品を書き出す</h3><p>つくったアニメーションを保存しましょう。</p>
      <button className="export-option" onClick={exportGif} disabled={exporting}><span className="export-option-icon"><Film size={20} /></span><span><b>アニメーション GIF</b><small>すべてのフレームを動く画像に / 640×360</small></span><ArrowRight size={18} /></button>
      <button className="export-option" onClick={exportImage}><span className="export-option-icon"><Image size={20} /></span><span><b>現在のフレームを PNG</b><small>高解像度の静止画 / 1280×720</small></span><ArrowRight size={18} /></button>
      <button className="export-option" onClick={exportProject}><span className="export-option-icon"><FolderOpen size={20} /></span><span><b>編集可能なプロジェクト</b><small>あとから編集できる .frame.json ファイル</small></span><ArrowRight size={18} /></button>
      {exporting && <span className="export-working">GIFを生成しています…</span>}</div></div>}

    {showHelp && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowHelp(false) }}><div className="dialog help-dialog"><button className="dialog-close" onClick={() => setShowHelp(false)}><X size={19} /></button><div className="dialog-icon"><Sparkles size={24} /></div><div className="eyebrow">YOUR FIRST ANIMATION</div><h3>はじめてのアニメ制作ガイド</h3><p>ぱらぱら漫画のように、少しずつ絵を動かしてみましょう。</p>
      <div className="help-steps"><div><span>01</span><div><b>PCとスマホをつなぐ</b><p>PCの5桁のコードをスマホに入力し、PC側で接続を許可します。</p></div></div><div><span>02</span><div><b>最初の絵を描く</b><p>スマホのGペンや鉛筆で自由に描きます。Apple Pencilの筆圧にも対応します。</p></div></div><div><span>03</span><div><b>次のフレームを追加</b><p>「複製」で前の絵をコピーし、少し位置を変えるだけで動きを作れます。</p></div></div><div><span>04</span><div><b>オニオンスキンを使う</b><p>前後のフレームを薄く重ねて表示。動きのつながりがわかります。</p></div></div><div><span>05</span><div><b>再生して書き出す</b><p>▶ でプレビュー。FPSで速さを変え、GIFとして保存しましょう。</p></div></div></div>
      <Button className="primary help-done" onClick={() => setShowHelp(false)}>制作をはじめる <ArrowRight size={17} /></Button></div></div>}

    {toast && <div role="status" className="toast"><CheckCircle2 size={17} /> {toast}</div>}
    <input ref={fileInput} hidden type="file" accept=".json,.frame.json,application/json" onChange={e => { const file = e.target.files?.[0]; if (file) void importProject(file); e.target.value = '' }} />
    {!isPhone && <div className="studio-statusbar"><span><span className="pulse-dot" /> {connected ? '1 DEVICE CONNECTED' : 'READY TO CONNECT'}</span><span>FRAME. STUDIO <span className="muted">/</span> 1280 × 720 <span className="muted">/</span> {project.fps} FPS</span><button onClick={() => fileInput.current?.click()}><FolderOpen size={13} /> プロジェクト読み込み</button></div>}
  </div>
}
