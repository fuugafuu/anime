"""FRAME. PC-local animation assistant: native RIFE neural inference + vector tools."""

from __future__ import annotations

import base64
import io
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


HOST = "127.0.0.1"
PORT = int(os.environ.get("FRAME_AI_PORT", "8766"))
ROOT = Path(__file__).resolve().parent
RIFE_DIR = ROOT / "tools" / "rife"
INFERENCE_LOCK = threading.BoundedSemaphore(1)
MODEL_LOCK = threading.Lock()
ACTIVE_MODEL: tuple[Path, Path] | None = None
try:
    from PIL import Image
except ImportError:
    Image = None
ALLOWED_ORIGINS = {
    "https://anime-fuugafuus-projects.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:5180",
    "http://127.0.0.1:5180",
}
MAX_BODY = 7_000_000


def locate_rife() -> tuple:
    if not RIFE_DIR.exists():
        return (None, None)
    for exe in RIFE_DIR.rglob("rife-ncnn-vulkan.exe"):
        for path in (exe.parent / "models" / "rife-v4.6",
                     exe.parent / "models" / "rife-anime",
                     exe.parent / "rife-v4.6"):
            # A previous interrupted extraction can leave an empty model folder.
            if path.is_dir() and any(path.glob('*.param')) and any(path.glob('*.bin')):
                return (exe, path)
    return (None, None)


def valid_rife_pair(exe: Path, model: Path) -> bool:
    """An executable and a complete model must live together on the host PC."""
    if not exe.is_file() or not model.is_dir():
        return False
    params = {p.stem for p in model.glob('*.param') if p.is_file() and p.stat().st_size > 0}
    binaries = {p.stem for p in model.glob('*.bin') if p.is_file() and p.stat().st_size > 0}
    return bool(params & binaries)


def pair_from_directory(directory: Path) -> tuple[Path, Path] | None:
    """Accept an extracted RIFE folder or its models/<model-name> directory."""
    folder = directory.expanduser().resolve()
    if not folder.is_dir():
        return None
    roots = [folder, folder.parent, folder.parent.parent]
    for root in roots:
        exe = root / 'rife-ncnn-vulkan.exe'
        models = [folder, root / 'rife-v4.6', root / 'rife-anime']
        model_root = root / 'models'
        if model_root.is_dir():
            models.extend(p for p in model_root.iterdir() if p.is_dir())
        for model in models:
            if valid_rife_pair(exe, model):
                return (exe, model)
    return None


def detected_rife() -> tuple[Path, Path] | None:
    exe, model = locate_rife()
    return (exe, model) if exe and model and valid_rife_pair(exe, model) else None


def current_model() -> tuple[Path, Path] | None:
    with MODEL_LOCK:
        loaded = ACTIVE_MODEL
    return loaded if loaded and valid_rife_pair(*loaded) else None


def pick_model_directory() -> Path | None:
    """Choose files on the host PC without sending enormous model files via HTTP."""
    if os.name == 'nt':
        # A dedicated STA process owns the picker. Tk from an HTTP worker thread
        # is unreliable on Windows, especially after the first dialog is closed.
        script = (
            'Add-Type -AssemblyName System.Windows.Forms; '
            '$owner = New-Object System.Windows.Forms.Form; '
            '$owner.TopMost = $true; '
            '$picker = New-Object System.Windows.Forms.FolderBrowserDialog; '
            '$picker.Description = "Select the extracted RIFE folder"; '
            'try { if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) '
            '{ [Console]::Write($picker.SelectedPath) } } '
            'finally { $picker.Dispose(); $owner.Dispose() }'
        )
        try:
            result = subprocess.run(
                ['powershell.exe', '-NoProfile', '-STA', '-Command', script],
                capture_output=True, text=True, timeout=180, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError('PCでフォルダー選択画面を開けませんでした。パスを入力してください。') from exc
        if result.returncode != 0:
            raise ValueError('フォルダー選択に失敗しました。パスを入力してください。')
        return Path(result.stdout.strip()) if result.stdout.strip() else None
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise ValueError('PCのフォルダー選択機能を利用できません。モデルのパスを入力してください。') from exc
    window = tk.Tk()
    try:
        window.withdraw()
        window.attributes('-topmost', True)
        selected = filedialog.askdirectory(parent=window, title='RIFEの実行ファイルとモデルがあるフォルダーを選択')
        return Path(selected) if selected else None
    finally:
        window.destroy()


def load_rife(source: str, directory: str = '') -> dict:
    """Explicitly activate a model; discovery alone must never activate it."""
    global ACTIVE_MODEL
    if Image is None:
        raise ValueError('画像処理ライブラリがありません。PCで INSTALL_AI_ENGINE.bat を実行してください。')
    if source == 'detected':
        pair = detected_rife()
    elif source == 'browse':
        selected = pick_model_directory()
        if selected is None:
            raise ValueError('フォルダーの選択をキャンセルしました。')
        pair = pair_from_directory(selected)
    elif source == 'path' and isinstance(directory, str) and 1 <= len(directory) <= 1024:
        pair = pair_from_directory(Path(directory))
    else:
        raise ValueError('モデルの読み込み方法が正しくありません。')
    if not pair:
        raise ValueError('RIFEの実行ファイルと対応する .param / .bin モデルが見つかりません。展開済みのRIFEフォルダーを選択してください。')
    if not INFERENCE_LOCK.acquire(blocking=False):
        raise ValueError('AI処理中はモデルを変更できません。')
    try:
        with MODEL_LOCK:
            ACTIVE_MODEL = pair
    finally:
        INFERENCE_LOCK.release()
    return {'neuralModel': pair[1].name, 'neuralReady': True, 'message': f'{pair[1].name} をPCで読み込みました。'}


def model_health() -> dict:
    """Installed is distinct from explicitly loaded, including after restart."""
    loaded = current_model()
    detected = detected_rife()
    return {
        'ready': True,
        'neuralReady': bool(loaded and Image),
        'neuralInstalled': bool(detected),
        'neuralModel': loaded[1].name if loaded else None,
        'detectedModel': detected[1].name if detected else None,
        'features': ['cleanup', 'inbetween', 'review', 'neural'],
    }


def validate_strokes(value: Any, label: str = 'strokes') -> list[dict]:
    """Reject damaged or oversized browser/peer input before geometry processing."""
    if not isinstance(value, list) or len(value) > 160:
        raise ValueError(f'{label}: expected at most 160 strokes')
    total_points = 0
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str):
            raise ValueError(f'{label}: invalid stroke')
        points = item.get('points')
        if not isinstance(points, list) or len(points) > 2000:
            raise ValueError(f'{label}: too many points in a stroke')
        total_points += len(points)
        if total_points > 32000:
            raise ValueError(f'{label}: too many total points')
        for p in points:
            if not isinstance(p, dict) or not all(
                isinstance(p.get(key), (int, float)) and math.isfinite(p[key])
                for key in ('x', 'y')
            ):
                raise ValueError(f'{label}: invalid drawing coordinates')
            if 'p' in p and (not isinstance(p['p'], (int, float)) or not math.isfinite(p['p'])):
                raise ValueError(f'{label}: invalid pen pressure')
    return value


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def point(x: float, y: float, pressure: float = 1.0) -> dict:
    return {"x": round(clamp(x, 0, 1280), 2),
            "y": round(clamp(y, 0, 720), 2), "p": round(clamp(pressure, .1, 1), 3)}


def length(points: list[dict]) -> float:
    return sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"])
               for a, b in zip(points, points[1:]))


def resample(points: list[dict], count: int = 48) -> list[dict]:
    if not points:
        return []
    if len(points) == 1:
        return [dict(points[0]) for _ in range(count)]
    cumulative = [0.0]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.hypot(b["x"]-a["x"], b["y"]-a["y"]))
    total = cumulative[-1]
    if total < .001:
        return [dict(points[0]) for _ in range(count)]
    output = []
    j = 0
    for i in range(count):
        d = total * i / (count - 1)
        while j < len(points) - 2 and cumulative[j+1] < d:
            j += 1
        v = (d - cumulative[j]) / max(.0001, cumulative[j+1]-cumulative[j])
        a, b = points[j], points[j+1]
        output.append(point(a["x"] + (b["x"]-a["x"]) * v,
                            a["y"] + (b["y"]-a["y"]) * v,
                            a.get("p", 1) + (b.get("p", 1)-a.get("p", 1)) * v))
    return output


def stroke_features(stroke: dict) -> tuple:
    pts = stroke.get("points", [])
    if not pts:
        return (0, 0, 0, 0, 0, 0)
    xs = [p["x"] for p in pts]
    ys = [p["y"] for p in pts]
    return ((min(xs)+max(xs))/2, (min(ys)+max(ys))/2,
            max(xs)-min(xs), max(ys)-min(ys), length(pts), len(pts))


def match_strokes(left: list[dict], right: list[dict]) -> list[tuple[int, int]]:
    """Topology-aware, globally greedy stroke association with shape/style cues."""
    options = []
    for i, a in enumerate(left):
        acx, acy, aw, ah, al, _ = stroke_features(a)
        for j, b in enumerate(right):
            bcx, bcy, bw, bh, bl, _ = stroke_features(b)
            spatial = math.hypot((acx-bcx)/1280, (acy-bcy)/720)
            shape = (abs(math.log((aw+4)/(bw+4))) + abs(math.log((ah+4)/(bh+4)))) * .09
            shape += abs(math.log((al+5)/(bl+5))) * .08
            style = (0 if a.get("tool") == b.get("tool") else .15)
            color = (0 if a.get("color") == b.get("color") else .09)
            options.append((spatial*.7 + shape + style + color, i, j))
    pairs, used_a, used_b = [], set(), set()
    for cost, i, j in sorted(options):
        if i not in used_a and j not in used_b and cost < .83:
            pairs.append((i, j))
            used_a.add(i)
            used_b.add(j)
    return pairs


def ease(t: float, spacing: str) -> float:
    if spacing == "ease-in":
        return t * t
    if spacing == "ease-out":
        return 1 - (1-t)*(1-t)
    if spacing == "linear":
        return t
    return t*t*(3-2*t)


def interpolate_strokes(a: list[dict], b: list[dict], t: float,
                        spacing: str = "smooth", arc: float = 0) -> tuple[list[dict], int]:
    pairs = match_strokes(a, b)
    result = []
    amount = ease(t, spacing)
    global_dx = sum(stroke_features(b[j])[0] - stroke_features(a[i])[0] for i, j in pairs)/max(1, len(pairs))
    global_dy = sum(stroke_features(b[j])[1] - stroke_features(a[i])[1] for i, j in pairs)/max(1, len(pairs))
    used_a, used_b = set(), set()
    for i, j in pairs:
        first, second = a[i], b[j]
        used_a.add(i)
        used_b.add(j)
        if first.get("tool") == "fill" or second.get("tool") == "fill":
            chosen = first if t < .5 else second
            result.append({**chosen, "id": f"assist-{i}-{j}-{round(t*100)}"})
            continue
        # Preserve a closed contour's seam and reverse winding only when useful.
        lhs = resample(first["points"])
        rhs = resample(second["points"])
        if len(lhs) != len(rhs) or not lhs:
            continue
        direct = sum(math.hypot(x["x"]-y["x"], x["y"]-y["y"]) for x, y in zip(lhs, rhs))
        reversed_distance = sum(math.hypot(x["x"]-y["x"], x["y"]-y["y"]) for x, y in zip(lhs, reversed(rhs)))
        if reversed_distance < direct * .85:
            rhs.reverse()
        # Hand-drawn motion follows a controllable curved path rather than pure linear position.
        dx = stroke_features(second)[0] - stroke_features(first)[0]
        dy = stroke_features(second)[1] - stroke_features(first)[1]
        magnitude = math.hypot(dx, dy)
        curve_x = -dy/magnitude * arc * 4*t*(1-t) if magnitude > .1 else 0
        curve_y = dx/magnitude * arc * 4*t*(1-t) if magnitude > .1 else 0
        pts = [point(x["x"] * (1-amount) + y["x"]*amount + curve_x,
                     x["y"] * (1-amount) + y["y"]*amount + curve_y,
                     x.get("p", 1)*(1-amount) + y.get("p", 1)*amount)
               for x, y in zip(lhs, rhs)]
        result.append({"id": f"assist-{i}-{j}-{round(t*100)}", "tool": "pen",
                       "color": first.get("color", "#20243c"),
                       "size": round(first.get("size", 4)*(1-amount)+second.get("size", 4)*amount, 2),
                       "opacity": round(first.get("opacity", 1)*(1-amount) + second.get("opacity", 1)*amount, 3),
                       "pressure": True, "points": pts})
    # Secondary motion propagation keeps unmatched details attached to the overall pose.
    for source, used, fade in ((a, used_a, 1-t), (b, used_b, t)):
        for idx, stroke in enumerate(source):
            if idx in used or stroke.get("tool") == "fill":
                continue
            shift = amount if source is a else amount-1
            pts = [point(p["x"]+global_dx*shift, p["y"]+global_dy*shift, p.get("p", 1))
                   for p in stroke.get("points", [])[:96]]
            if pts:
                result.append({**stroke, "id": f"detail-{idx}-{round(t*100)}-{int(source is b)}",
                               "tool": "pen", "points": pts,
                               "opacity": round(clamp(stroke.get("opacity", 1)*fade, .05, 1), 3)})
    return result[:160], len(pairs)


def clean_stroke(stroke: dict, strength: float) -> dict:
    """Adaptive denoising: protect endpoints and sharp corners, simplify redundant points."""
    if stroke.get("tool") not in ("pencil", "pen", "brush") or len(stroke.get("points", [])) < 5:
        return {**stroke, "id": f"clean-{stroke['id']}"}
    raw = stroke["points"]
    target = min(180, max(8, int(length(raw)/max(1.3, 2.2+strength*2))))
    pts = resample(raw, target)
    smoothed = [pts[0]]
    for i in range(1, len(pts)-1):
        a, b, c = pts[i-1], pts[i], pts[i+1]
        ux, uy = b["x"]-a["x"], b["y"]-a["y"]
        vx, vy = c["x"]-b["x"], c["y"]-b["y"]
        cosine = (ux*vx+uy*vy)/max(.0001, math.hypot(ux,uy)*math.hypot(vx,vy))
        preserve = clamp((1-cosine)*2.5, 0, 1)
        mix = clamp(strength*.42*(1-preserve), 0, .48)
        smoothed.append(point(b["x"]*(1-mix)+(a["x"]+c["x"])*.5*mix,
                              b["y"]*(1-mix)+(a["y"]+c["y"])*.5*mix, b.get("p", 1)))
    smoothed.append(pts[-1])
    # Remove near-redundant points while retaining endpoints and pressure variation.
    output = [smoothed[0]]
    for p in smoothed[1:-1]:
        if math.hypot(p["x"]-output[-1]["x"], p["y"]-output[-1]["y"]) >= .75:
            output.append(p)
    output.append(smoothed[-1])
    return {**stroke, "id": f"clean-{stroke['id']}", "points": output}


def neural_inbetween(payload: dict) -> dict:
    """Run the released RIFE network locally; never send artwork to a remote API."""
    if Image is None:
        raise ValueError("画像処理ライブラリがありません。PCで INSTALL_AI_ENGINE.bat を実行してください。")
    if not current_model():
        raise ValueError("PCのAIアシスト画面でRIFEモデルを読み込んでください。")
    encoded = [payload.get("imageFrom"), payload.get("imageTo")]
    if any(not isinstance(s, str) or not s.startswith("data:image/png;base64,")
           or len(s) > 1_600_000 for s in encoded):
        raise ValueError("中割り用の前後2枚の画像が不正です")
    count = int(clamp(int(payload.get("count", 1)), 1, 3))
    spacing = str(payload.get("spacing", "smooth"))
    if not INFERENCE_LOCK.acquire(blocking=False):
        raise ValueError("PCは別の中割りを生成中です。完了後に再実行してください。")
    try:
        pair = current_model()
        if not pair:
            raise ValueError("RIFEモデルの読み込みが解除されました。PCで読み込み直してください。")
        exe, model = pair
        with tempfile.TemporaryDirectory(prefix="frame-rife-") as work:
            base = Path(work)
            inputs = []
            for index, data in enumerate(encoded):
                try:
                    raw = base64.b64decode(data.split(",", 1)[1], validate=True)
                    img = Image.open(io.BytesIO(raw))
                    if img.size != (640, 360):
                        raise ValueError("入力画像は640x360である必要があります")
                    name = base / ("before.png" if index == 0 else "after.png")
                    img.convert("RGB").save(name, format="PNG")
                except (OSError, ValueError) as exc:
                    raise ValueError("入力画像を読み込めませんでした") from exc
                inputs.append(name)
            frames = []
            for index in range(count):
                t = ease((index+1)/(count+1), spacing)
                output = base / ("generated-%d.png" % index)
                command = [str(exe), "-0", str(inputs[0]), "-1", str(inputs[1]),
                           "-o", str(output), "-m", str(model), "-s", "%.5f" % t]
                try:
                    finished = subprocess.run(command, cwd=str(exe.parent), capture_output=True,
                                              text=True, errors="replace", timeout=80, check=False)
                except (subprocess.TimeoutExpired, OSError) as exc:
                    raise RuntimeError("RIFEを実行できませんでした。GPUドライバとVulkan対応を確認してください。") from exc
                if finished.returncode != 0 or not output.exists():
                    raise RuntimeError("RIFEの推論に失敗しました（Vulkan対応GPUが必要です）: "
                                       + finished.stderr[-450:])
                with Image.open(output) as image:
                    buffer = io.BytesIO()
                    image.convert("RGB").save(buffer, "WEBP", quality=68, method=5)
                    if buffer.tell() > 155_000:
                        raise ValueError("生成画像が大きすぎます。原画を整理して再実行してください。")
                    frames.append("data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"))
        return {"kind": "insert", "images": frames, "method": "neural",
                "message": "RIFEニューラルネットワークで%d枚の中割りをPCで生成しました。輪郭のゆがみを確認して採用してください。" % count}
    finally:
        INFERENCE_LOCK.release()


def production_review(payload: dict) -> dict:
    """Numerical pose/shape diagnosis, explicitly not an LLM or an image generator."""
    frames = payload.get("sequence")
    if not isinstance(frames, list) or len(frames) > 12:
        raise ValueError("診断できるフレーム数は12枚以内です")
    fps = int(clamp(int(payload.get("fps", 8)), 1, 24))
    features = []
    for frame in frames:
        strokes = validate_strokes(frame.get("strokes", []), 'sequence strokes') if isinstance(frame, dict) else []
        points = [p for s in strokes for p in s.get("points", []) if "x" in p and "y" in p]
        if points:
            xs, ys = [p["x"] for p in points], [p["y"] for p in points]
            features.append(((min(xs)+max(xs))/2, (min(ys)+max(ys))/2,
                             max(xs)-min(xs), max(ys)-min(ys), len(strokes)))
        else:
            features.append(None)
    steps = []
    if not features or not any(features):
        return {"message": "線がありません。まず1枚の原画を描き、次のフレームに動かした原画を描いてください。", "method": "analysis"}
    filled = sum(feature is not None for feature in features)
    steps.append("確認範囲: %d枚 / 作画あり%d枚 / %dfps。" % (len(features), filled, fps))
    empty = [str(i+1) for i, f in enumerate(features) if f is None]
    if empty:
        steps.append("空白フレーム: %s。意図しない空白なら原画を追加してください。" % "、".join(empty[:8]))
    jumps = []
    for i in range(1, len(features)):
        before, after = features[i-1], features[i]
        if not before or not after:
            continue
        d = math.hypot(after[0]-before[0], after[1]-before[1])
        scale = max(abs(after[2]-before[2]), abs(after[3]-before[3]))
        jumps.append((i, d, scale))
    if jumps:
        biggest = max(jumps, key=lambda j: j[1])
        steps.append("%d→%dコマ: 画面上の中心移動 %.1fpx（推定 %.0fpx/秒）。"
                     % (biggest[0], biggest[0]+1, biggest[1], biggest[1]*fps))
        if biggest[1] > 100:
            steps.append("中心移動が大きいため、該当コマ間に中割りを2枚以上追加し、動きを目視確認してください。")
        wobble = max(jumps, key=lambda j: j[2])
        if wobble[2] > 80:
            steps.append("%d→%dコマでシルエット寸法が最大%.0fpx変化。意図しない縮尺変動なら輪郭と原画を修正してください。"
                         % (wobble[0], wobble[0]+1, wobble[2]))
        if not any(j[1] > 8 for j in jumps):
            steps.append("位置変化が少ない動きです。まばたき・髪・服・手の動きなど局所的な原画を追加すると変化が出ます。")
    if len(features) < 3:
        steps.append("動きを診断するには3枚以上の原画・中割りを用意すると、速度変化を比較できます。")
    steps.append("これは線の統計による制作診断です。人物の姿勢や絵の意味を理解する画像生成AIではありません。")
    return {"message": "\n".join(steps), "method": "analysis"}


def assist(payload: dict) -> dict:
    mode = payload.get("mode")
    if mode == "neural":
        return neural_inbetween(payload)
    if mode == "review":
        return production_review(payload)
    strokes_a = validate_strokes(payload.get("from", []), 'from')
    if mode == "cleanup":
        strength = clamp(float(payload.get("strength", .65)), .1, 1)
        return {"kind": "replace", "frames": [[clean_stroke(s, strength) for s in strokes_a]],
                "message": f"{len(strokes_a)}本の線を形状に合わせて整理しました。輪郭や角を保護し、線の揺らぎと余分な点を削減しています。",
                "method": "geometry"}
    if mode == "inbetween":
        strokes_b = validate_strokes(payload.get("to", []), 'to')
        if not strokes_a or not strokes_b:
            raise ValueError("前後のキーフレームの選択レイヤーに線を描いてください")
        count = int(clamp(int(payload.get("count", 1)), 1, 4))
        spacing = str(payload.get("spacing", "smooth"))
        if spacing not in ("smooth", "linear", "ease-in", "ease-out"):
            spacing = "smooth"
        arc = clamp(float(payload.get("arc", 0)), -100, 100)
        output, pairs = [], 0
        for i in range(1, count+1):
            candidate, pairs = interpolate_strokes(strokes_a, strokes_b, i/(count+1), spacing, arc)
            output.append(candidate)
        return {"kind": "insert", "frames": output, "method": "geometry",
                "message": f"前後の線を形状・位置・長さで対応付け、{pairs}組を追跡。{count}枚の中間フレームを作りました。崩れやすい部分は採用前に確認してください。"}
    raise ValueError("未対応のAI処理です")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        print("[FRAME AI] " + fmt % args)

    def origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "")
        return not origin or origin in ALLOWED_ORIGINS

    def headers_common(self, status: int, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def reply(self, status: int, data: dict) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.headers_common(status)
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self.headers_common(204 if self.origin_allowed() else 403)

    def do_GET(self) -> None:
        if not self.origin_allowed():
            return self.reply(403, {"error": "Origin not allowed"})
        if self.path == "/api/health":
            return self.reply(200, model_health())
        return self.reply(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self.origin_allowed():
            return self.reply(403, {"error": "Origin not allowed"})
        if self.path not in ("/api/assist", "/api/model/load") or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.reply(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_BODY:
                raise ValueError("入力サイズが許容範囲外です")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("JSON object required")
            if self.path == "/api/model/load":
                self.reply(200, load_rife(payload.get('source'), payload.get('directory', '')))
            else:
                self.reply(200, assist(payload))
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            self.reply(400, {"error": str(exc)})
        except Exception as exc:
            self.reply(503, {"error": str(exc)})


if __name__ == "__main__":
    print(f"FRAME AI listening at http://{HOST}:{PORT} (PC only)", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
