"""Regression checks for the real PC-local animation assistant."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_server


def stroke(identifier, x, y):
    return {
        "id": identifier, "tool": "pen", "color": "#ff0000",
        "size": 4, "opacity": 1, "pressure": True,
        "points": [{"x": x, "y": y, "p": 1}, {"x": x + 20, "y": y + 20, "p": .7}],
    }


class AnimationAssistTests(unittest.TestCase):
    def tearDown(self):
        with ai_server.MODEL_LOCK:
            ai_server.ACTIVE_MODEL = None

    @staticmethod
    def make_model(root):
        model = root / 'models' / 'rife-v4.6'
        model.mkdir(parents=True)
        (root / 'rife-ncnn-vulkan.exe').write_bytes(b'fake test executable')
        (model / 'flownet.param').write_text('test')
        (model / 'flownet.bin').write_bytes(b'test')
        return model

    def test_model_must_be_explicitly_loaded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_model(root)
            with patch.object(ai_server, 'RIFE_DIR', root), patch.object(ai_server, 'Image', object()):
                state = ai_server.model_health()
                self.assertTrue(state['neuralInstalled'])
                self.assertFalse(state['neuralReady'])
                with self.assertRaisesRegex(ValueError, '読み込んで'):
                    ai_server.neural_inbetween({})
                self.assertTrue(ai_server.load_rife('detected')['neuralReady'])
                self.assertEqual(ai_server.model_health()['neuralModel'], 'rife-v4.6')
                self.assertTrue(ai_server.model_health()['neuralReady'])

    def test_browse_and_path_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = self.make_model(root)
            with patch.object(ai_server, 'Image', object()), patch.object(ai_server, 'pick_model_directory', return_value=model):
                self.assertTrue(ai_server.load_rife('browse')['neuralReady'])
            with patch.object(ai_server, 'Image', object()):
                self.assertTrue(ai_server.load_rife('path', str(root))['neuralReady'])

    def test_invalid_and_incomplete_model_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'rife-ncnn-vulkan.exe').write_bytes(b'fake')
            (root / 'models' / 'rife-v4.6').mkdir(parents=True)
            (root / 'models' / 'rife-v4.6' / 'flownet.param').write_text('test')
            with patch.object(ai_server, 'Image', object()):
                for path in (str(root), str(root / 'not-found')):
                    with self.assertRaisesRegex(ValueError, '見つかりません'):
                        ai_server.load_rife('path', path)
                with self.assertRaisesRegex(ValueError, '正しくありません'):
                    ai_server.load_rife('invalid')
                self.assertFalse(ai_server.model_health()['neuralReady'])

    def test_inference_lock_prevents_model_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_model(root)
            with patch.object(ai_server, 'Image', object()), patch.object(ai_server, 'RIFE_DIR', root):
                ai_server.INFERENCE_LOCK.acquire()
                try:
                    with self.assertRaisesRegex(ValueError, 'AI処理中'):
                        ai_server.load_rife('detected')
                finally:
                    ai_server.INFERENCE_LOCK.release()
                self.assertFalse(ai_server.model_health()['neuralReady'])

    def test_http_status_and_model_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_model(root)
            with patch.object(ai_server, 'RIFE_DIR', root), patch.object(ai_server, 'Image', object()):
                server = ThreadingHTTPServer(('127.0.0.1', 0), ai_server.Handler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    base = f'http://127.0.0.1:{server.server_port}'
                    before = json.load(urllib.request.urlopen(base + '/api/health', timeout=3))
                    self.assertFalse(before['neuralReady'])
                    payload = json.dumps({'source': 'detected'}).encode('utf-8')
                    request = urllib.request.Request(base + '/api/model/load', data=payload,
                                                     headers={'Content-Type': 'application/json'}, method='POST')
                    loaded = json.load(urllib.request.urlopen(request, timeout=3))
                    self.assertTrue(loaded['neuralReady'])
                    after = json.load(urllib.request.urlopen(base + '/api/health', timeout=3))
                    self.assertTrue(after['neuralReady'])
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join(timeout=2)
    def test_vector_inbetween_creates_distinct_frames(self):
        answer = ai_server.assist({
            "mode": "inbetween", "from": [stroke("start", 20, 40)],
            "to": [stroke("end", 80, 40)], "count": 2,
            "spacing": "linear", "arc": 0,
        })
        self.assertEqual(answer["kind"], "insert")
        self.assertEqual(answer["method"], "geometry")
        self.assertEqual(len(answer["frames"]), 2)
        self.assertAlmostEqual(answer["frames"][0][0]["points"][0]["x"], 40)
        self.assertAlmostEqual(answer["frames"][1][0]["points"][0]["x"], 60)

    def test_cleanup_preserves_endpoints(self):
        sketch = stroke("sample", 5, 8)
        sketch["points"] = [{"x": 5 + i, "y": 8 + .2 * (i % 2), "p": 1} for i in range(20)]
        result = ai_server.assist({"mode": "cleanup", "from": [sketch], "strength": .6})
        self.assertEqual(result["kind"], "replace")
        cleaned = result["frames"][0][0]["points"]
        self.assertEqual(cleaned[0]["x"], 5)
        self.assertEqual(cleaned[-1]["x"], 24)
        self.assertLessEqual(len(cleaned), 200)

    def test_review_reports_frame_motion(self):
        answer = ai_server.assist({"mode": "review", "fps": 12, "sequence": [
            {"strokes": [stroke("a", 0, 0)]},
            {"strokes": [stroke("b", 160, 0)]},
            {"strokes": []},
        ]})
        self.assertEqual(answer["method"], "analysis")
        self.assertIn("160", answer["message"])
        self.assertIn("空白", answer["message"])

    def test_rejects_too_many_strokes(self):
        with self.assertRaises(ValueError):
            ai_server.assist({"mode": "inbetween", "from": [stroke("x", 0, 0)] * 161})

    def test_rejects_invalid_points_instead_of_server_error(self):
        bad = stroke('bad', 10, 20)
        bad['points'][0]['x'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'drawing coordinates'):
            ai_server.assist({"mode": "cleanup", "from": [bad]})

    def test_rejects_excessive_points(self):
        bad = stroke('oversized', 10, 20)
        bad['points'] = bad['points'] * 1001
        with self.assertRaisesRegex(ValueError, 'too many points'):
            ai_server.assist({"mode": "cleanup", "from": [bad]})

    def test_partial_model_install_does_not_report_neural_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / 'models' / 'rife-v4.6'
            model.mkdir(parents=True)
            (root / 'rife-ncnn-vulkan.exe').touch()
            with patch.object(ai_server, 'RIFE_DIR', root):
                self.assertEqual(ai_server.locate_rife(), (None, None))
                (model / 'flownet.param').write_text('test')
                (model / 'flownet.bin').write_bytes(b'test')
                self.assertEqual(ai_server.locate_rife(), (root / 'rife-ncnn-vulkan.exe', model))


if __name__ == "__main__":
    unittest.main()
