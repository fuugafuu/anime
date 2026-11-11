import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, Clapperboard, Cpu, FolderOpen, LoaderCircle, Pen, ScanEye, Sparkles, X } from 'lucide-react'
import type { AiHealth, AssistMode, AssistRequest, AssistResult, ModelSource } from './ai-client'

type Form = Pick<AssistRequest, 'mode' | 'count' | 'spacing' | 'arc' | 'strength'>

const FEATURES: { mode: AssistMode; title: string; detail: string; icon: typeof Pen }[] = [
  { mode: 'neural', title: 'RIFE AI中割り', detail: 'PCのGPUと学習済みモデルで中間画を生成', icon: Sparkles },
  { mode: 'inbetween', title: '線の中割り', detail: '線の形状を対応付けて編集可能な中間画を生成', icon: Clapperboard },
  { mode: 'cleanup', title: '線画クリーンアップ', detail: '手描きの輪郭を保ちながら線を整理', icon: Pen },
  { mode: 'review', title: '動きの制作診断', detail: 'フレーム間の移動・縮尺・空白を数値で検査', icon: ScanEye },
]

export default function AiDialog({ role, connected, busy, result, health, onRequest, onApply, onDiscard, onModelLoad, onClose }: {
  role: 'pc' | 'phone'; connected: boolean; busy: boolean; result: AssistResult | null
  health: AiHealth | null; onRequest: (request: Form) => void; onApply: () => void
  onDiscard: () => void; onModelLoad: (source: ModelSource, directory?: string) => Promise<string>
  onClose: () => void
}) {
  const [mode, setMode] = useState<AssistMode>('neural')
  const [count, setCount] = useState(2)
  const [spacing, setSpacing] = useState<Form['spacing']>('smooth')
  const [arc, setArc] = useState(0)
  const [strength, setStrength] = useState(.65)
  const [modelBusy, setModelBusy] = useState(false)
  const [modelPath, setModelPath] = useState('')
  const [showPath, setShowPath] = useState(false)
  const [modelFeedback, setModelFeedback] = useState<{ success: boolean; text: string } | null>(null)
  const selected = FEATURES.find(feature => feature.mode === mode)!
  const canRun = !busy && !modelBusy && !!health?.ready && (mode !== 'neural' || health.neuralReady) && (role === 'pc' || connected)
  const readModel = async (source: ModelSource, directory?: string) => {
    setModelBusy(true)
    setModelFeedback(null)
    try {
      const text = await onModelLoad(source, directory)
      setModelFeedback({ success: true, text })
    } catch (error) {
      setModelFeedback({ success: false, text: error instanceof Error ? error.message : 'モデルを読み込めませんでした。' })
    } finally { setModelBusy(false) }
  }
  return <div className="modal-backdrop ai-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="ai-dialog" role="dialog" aria-modal="true" aria-label="アニメ制作AIアシスト">
      <header className="ai-header"><div className="ai-heading-icon"><Sparkles size={25} /></div>
        <div><span className="ai-kicker">FRAME / CREATIVE INTELLIGENCE</span><h2>アニメ制作アシスト</h2>
          <p>作画・中割り・演出を支援。判断と仕上げは制作者が担当します。</p></div>
        <button className="ai-close" aria-label="閉じる" onClick={onClose}><X size={20} /></button></header>
      <div className="ai-status"><span className={role === 'phone' ? connected ? 'ai-ok' : 'ai-off' : health?.ready ? 'ai-ok' : 'ai-off'} />
        {role === 'phone' ? (connected ? health?.ready ? 'PCのAIサービスで処理 / スマホは描画に専念' : 'PC側で START_AI.bat を起動してください' : 'PCとの接続が必要です') :
          (health?.ready ? 'PCのローカルAIサービス 接続済み' : 'PCのAIサーバー未接続 — START_AI.bat を起動')}
        {role === 'pc' && health?.ready && <span className="ai-model"><Cpu size={13} /> {health.neuralReady ? `RIFE ${health.neuralModel} 読み込み済み` : health.neuralInstalled ? `${health.detectedModel} 検出済み・読み込み待ち` : 'モデル未読み込み'}</span>}
      </div>
      {role === 'pc' && mode === 'neural' && <section className="ai-model-setup" aria-label="PCのAIモデル設定">
        <div className="ai-model-title"><span>PC MODEL SETUP</span><b>AIモデルの読み込み</b><em className={health?.neuralReady ? 'loaded' : ''}>{health?.neuralReady ? '● 使用可能' : '○ 読み込みが必要'}</em></div>
        <div className="ai-model-steps"><span><b>01</b> PC用セットアップを展開し、INSTALL_AI_ENGINE.bat を実行</span><span><b>02</b> START_AI.bat を起動</span><span><b>03</b> この画面でモデルを読み込む</span></div>
        <a className="ai-model-download" href="https://github.com/fuugafuu/anime/archive/refs/heads/main.zip" target="_blank" rel="noopener noreferrer">初めて使う方：PC用セットアップ一式をダウンロード ↗</a>
        <p>{health?.neuralReady ? `「${health.neuralModel}」をこのPCで使用できます。再起動後は再度読み込んでください。` :
          health?.neuralInstalled ? `「${health.detectedModel}」を検出しました。下のボタンで読み込みを完了してください。` :
            '最初にPCで付属のインストール用BATを実行してください。RIFEはモデルとVulkan対応GPUが必要です。既に別の場所に導入済みならフォルダーを指定できます。'}</p>
        <div className="ai-model-buttons">
          <button type="button" className="ai-model-primary" onClick={() => void readModel('detected')} disabled={!health?.neuralInstalled || modelBusy || busy}>
            {modelBusy ? <LoaderCircle className="ai-spin" size={15} /> : <Cpu size={15} />} 検出したモデルを読み込む
          </button>
          <button type="button" onClick={() => void readModel('browse')} disabled={!health?.ready || modelBusy || busy}><FolderOpen size={15} /> PCでフォルダーを選択</button>
        </div>
        <button type="button" className="ai-path-toggle" onClick={() => setShowPath(s => !s)} aria-expanded={showPath}>{showPath ? '詳細設定を閉じる' : 'フォルダーパスを直接入力する'} <ChevronDown size={13} /></button>
        {showPath && <div className="ai-path-entry"><input value={modelPath} onChange={e => setModelPath(e.target.value)} aria-label="PC上のRIFEフォルダーパス" placeholder="C:\\AI\\rife-ncnn-vulkan" autoComplete="off" />
          <button type="button" disabled={!health?.ready || !modelPath.trim() || modelBusy || busy} onClick={() => void readModel('path', modelPath.trim())}>指定した場所を読み込む</button></div>}
        {modelFeedback && <p className={`ai-model-feedback ${modelFeedback.success ? 'success' : 'failure'}`} role="status">{modelFeedback.text}</p>}
        <small>モデルはPC内で読み込みます。スマホや公開サイトへのファイル送信はありません。フォルダー選択画面はPC側に表示されます。</small>
      </section>}
      <div className="ai-content"><nav className="ai-feature-list">{FEATURES.map(feature => <button key={feature.mode}
        className={`ai-feature ${mode === feature.mode ? 'selected' : ''}`} disabled={busy}
        onClick={() => { setMode(feature.mode); onDiscard() }}><feature.icon size={20} /><span><b>{feature.title}</b><small>{feature.detail}</small></span><ArrowRight size={15} /></button>)}
        <p className="ai-feature-note">RIFEは実際の学習済み映像補間モデルです。線の補間・清書・動き診断は軽量な数値処理で、画像生成AIとは区別しています。</p>
      </nav>
      <section className="ai-workspace"><span className="ai-section-tag">ASSIST WORKSPACE</span><h3>{selected.title}</h3><p>{selected.detail}</p>
        {(mode === 'inbetween' || mode === 'neural') && <div className="ai-controls">
          <label>追加する中間フレーム <b>{count} 枚</b><input type="range" min="1" max={mode === 'neural' ? 3 : 4} value={Math.min(count, mode === 'neural' ? 3 : 4)} onChange={e => setCount(+e.target.value)} /></label>
          <label>動きの間隔 <span className="ai-select"><select value={spacing} onChange={e => setSpacing(e.target.value as Form['spacing'])}><option value="smooth">自然な加減速</option><option value="linear">等速</option><option value="ease-in">徐々に速く</option><option value="ease-out">徐々に遅く</option></select><ChevronDown size={15} /></span></label>
          {mode === 'inbetween' && <label>動きの弧 <b>{arc > 0 ? '+' : ''}{arc} px</b><input type="range" min="-70" max="70" step="5" value={arc} onChange={e => setArc(+e.target.value)} /></label>}
          <small>{mode === 'neural' ? '現在と次の原画を640×360で処理し、画像として中間に追加します。編集可能な線画は生成しません。' : '現在と次のフレームの選択レイヤーに、線が必要です。'}</small>
        </div>}
        {mode === 'cleanup' && <div className="ai-controls"><label>整理の強度 <b>{Math.round(strength*100)}%</b>
          <input type="range" min=".1" max="1" step=".05" value={strength} onChange={e => setStrength(+e.target.value)} /></label>
          <small>現在フレームの選択レイヤーを整理。元の線はUndoで復元できます。</small></div>}
        {mode === 'review' && <div className="ai-controls">
          <small>前後最大12コマの線の位置・サイズ変化・空白を調べ、修正するコマを数値で示します。人物や絵の意味を解釈する機能ではありません。</small></div>}
        <button className="ai-execute" disabled={!canRun} onClick={() => { onDiscard(); onRequest({ mode, count: Math.min(count, mode === 'neural' ? 3 : 4), spacing, arc, strength }) }}>
          {busy ? <><LoaderCircle className="ai-spin" size={18} /> PCで処理しています…</> : <><Sparkles size={18} /> {mode === 'review' ? '動きを診断' : '候補を生成する'} <ArrowRight size={17} /></>}
        </button>
        {!canRun && !busy && <p className="ai-unavailable">{!connected && role === 'phone' ? 'PCへの接続後に利用できます。' : mode === 'neural' && health?.ready ? role === 'phone' ? 'PCのアシスト画面でAIモデルを読み込んでください。' : '上の設定からRIFEモデルを読み込んでください。' : 'PCで START_AI.bat を起動してください。'}</p>}
        {result && <div className={`ai-result ${result.error ? 'ai-error' : ''}`} aria-live="polite">
          <div className="ai-result-label">{result.error ? 'ERROR' : 'ASSIST RESULT'}{result.method && <span> · {result.method === 'neural' ? 'RIFE neural inference' : result.method === 'geometry' ? 'vector geometry' : 'frame metrics'}</span>}</div>
          {result.preview && <img src={result.preview} alt="採用前の中割り・清書プレビュー" className="ai-preview" />}
          <p>{result.error || result.message}</p>
          {result.preview && !result.error && <div className="ai-decision"><button onClick={onDiscard}>破棄</button><button className="ai-accept" onClick={onApply}><Check size={17} /> この候補を採用</button></div>}
        </div>}
      </section></div>
    </div>
  </div>
}
