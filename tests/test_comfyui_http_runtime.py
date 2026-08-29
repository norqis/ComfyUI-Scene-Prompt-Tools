"""Isolated HTTP runtime smoke against a pinned real ComfyUI checkout."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _source_root():
    if os.environ.get("RUN_REAL_COMFYUI_HTTP_SMOKE") != "1":
        raise unittest.SkipTest("The isolated ComfyUI HTTP smoke runs only when explicitly requested.")
    source = Path(os.environ["COMFYUI_SOURCE"]).resolve()
    if not (source / "main.py").is_file():
        raise RuntimeError("COMFYUI_SOURCE is not a ComfyUI source checkout.")
    return source


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _scene_prompt_inputs():
    return {
        "prompt_name": "HTTP smoke",
        "positive_base": "test",
        "positive_json": '{"version":1,"categories":{}}',
        "negative_base": "",
        "negative_json": '{"version":1,"categories":{}}',
        "category_order": "",
        "seed": 0,
        "randomize": True,
        "run_handle": "",
    }


def _save_graph(mode, path="runtime", *, width=16, height=16, batch_size=1):
    return {
        "1": {"class_type": "ScenePrompt", "inputs": _scene_prompt_inputs()},
        "2": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["1", 0], "count": 2}},
        "3": {
            "class_type": "SceneEmptyLatent",
            "inputs": {"scene_prompt": ["2", 0], "width": 512, "height": 512, "batch_size": 1},
        },
        "4": {
            "class_type": "ScenePromptExpand",
            "inputs": {
                "scene_prompt": ["3", 0],
                "current_index": 0,
                "run_id": "http-smoke",
                "seed_base": 0,
                "timestamp_dir": False,
                "prefix": "",
            },
        },
        "5": {
            "class_type": "EmptyImage",
            "inputs": {"width": width, "height": height, "batch_size": batch_size, "color": 0},
        },
        "6": {
            "class_type": "SceneSaveImage",
            "inputs": {"images": ["5", 0], "path": path, "metadata_mode": mode, "scene_info": ["4", 2]},
        },
        "7": {
            "class_type": "SceneSaveImage",
            "inputs": {"images": ["5", 0], "path": path, "metadata_mode": mode, "scene_info": ["4", 2]},
        },
    }


def _large_extra_pnginfo():
    """Use realistic workflow metadata without adding model inference to CPU CI."""
    workflow_nodes = [
        {
            "id": index,
            "type": "ScenePrompt",
            "title": f"Scene {index:03d}",
            "widgets_values": ["metadata-check", "x" * 256],
        }
        for index in range(180)
    ]
    return {
        "workflow": {"version": 1, "nodes": workflow_nodes, "groups": []},
        "custom": {"source": "http-runtime-smoke", "notes": "metadata-" * 12000},
    }


class RealComfyUIHttpRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = _source_root()
        cls.temp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.temp.name)
        cls.port = _free_port()
        cls.node_dir = cls.base / "custom_nodes" / "scene-prompt-tools-http-smoke"
        (cls.base / "custom_nodes").mkdir()
        shutil.rmtree(cls.node_dir, ignore_errors=True)
        shutil.copytree(ROOT, cls.node_dir, ignore=shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", "*.pyc"))
        cls.log_path = cls.base / "comfyui-http-smoke.log"
        cls.log = cls.log_path.open("w", encoding="utf-8")
        cls.process = subprocess.Popen(
            [
                sys.executable,
                "main.py",
                "--cpu",
                "--listen",
                "127.0.0.1",
                "--port",
                str(cls.port),
                "--disable-auto-launch",
                "--base-directory",
                str(cls.base),
            ],
            cwd=cls.source,
            stdout=cls.log,
            stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                object_info = cls._request("/object_info")
                if "ScenePrompt" in object_info and "SceneSaveImage" in object_info:
                    return
            except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
                pass
            if cls.process.poll() is not None:
                break
            time.sleep(0.25)
        log = cls.log_path.read_text(encoding="utf-8", errors="replace") if cls.log_path.exists() else ""
        if cls.process.poll() is None:
            cls.process.terminate()
            cls.process.wait(timeout=15)
        cls.log.close()
        shutil.rmtree(cls.node_dir, ignore_errors=True)
        cls.temp.cleanup()
        raise RuntimeError(f"ComfyUI HTTP smoke did not start.\n{log[-4000:]}")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "process", None) is not None and cls.process.poll() is None:
            cls.process.terminate()
            try:
                cls.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                cls.process.kill()
        if getattr(cls, "log", None) is not None:
            cls.log.close()
        if getattr(cls, "node_dir", None) is not None:
            shutil.rmtree(cls.node_dir, ignore_errors=True)
        if getattr(cls, "temp", None) is not None:
            cls.temp.cleanup()

    @classmethod
    def _request(cls, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{cls.port}{path}",
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method="POST" if data else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise AssertionError(f"{path} returned HTTP {exc.code}: {detail}") from exc

    def _wait_for_prompt(self, prompt_id, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            history = self._request(f"/history/{prompt_id}")
            entry = history.get(prompt_id)
            status = entry.get("status", {}) if isinstance(entry, dict) else {}
            if status.get("completed"):
                self.assertEqual(status.get("status_str"), "success", entry)
                return entry
            if status.get("status_str") == "error":
                self.fail(json.dumps(entry, ensure_ascii=False))
            time.sleep(0.2)
        self.fail(f"Timed out waiting for prompt {prompt_id}")

    def _queue_and_wait(self, graph, *, extra_data=None, timeout=60):
        payload = {"prompt": graph}
        if extra_data is not None:
            payload["extra_data"] = extra_data
        return self._wait_for_prompt(self._request("/prompt", payload)["prompt_id"], timeout)

    def test_http_prompt_history_two_outputs_and_metadata_modes(self):
        for index, mode in enumerate(("ワークフロー全体", "プロンプトのみ", "生成経路ノードのみ"), start=1):
            entry = self._queue_and_wait(_save_graph(mode, f"metadata-{index}"))
            outputs = entry["outputs"]
            self.assertEqual(set(outputs).intersection({"6", "7"}), {"6", "7"})
            files = sorted((self.base / "output" / f"metadata-{index}").glob("*.png"))
            self.assertEqual(len(files), 2)
            from PIL import Image
            with Image.open(files[0]) as image:
                metadata = dict(image.text)
            if mode == "プロンプトのみ":
                self.assertNotIn("prompt", metadata)
            else:
                self.assertIn("prompt", metadata)

    def test_http_large_batch_multiple_saves_preserve_workflow_metadata(self):
        graph = _save_graph(
            "ワークフロー全体",
            "large-batch",
            width=832,
            height=1216,
            batch_size=3,
        )
        extra_pnginfo = _large_extra_pnginfo()
        self.assertGreater(len(json.dumps(extra_pnginfo)), 100_000)

        started = time.monotonic()
        entry = self._queue_and_wait(
            graph,
            extra_data={"extra_pnginfo": extra_pnginfo},
            timeout=90,
        )
        self.assertLess(time.monotonic() - started, 90)
        self.assertEqual(set(entry["outputs"]).intersection({"6", "7"}), {"6", "7"})

        files = sorted((self.base / "output" / "large-batch").glob("*.png"))
        self.assertEqual(len(files), 6)
        from PIL import Image

        for file_path in files:
            with Image.open(file_path) as image:
                self.assertEqual(image.size, (832, 1216))
                image.verify()
            with Image.open(file_path) as image:
                metadata = dict(image.text)
            saved_prompt = json.loads(metadata["prompt"])
            self.assertEqual(set(saved_prompt), set(graph))
            self.assertEqual(json.loads(metadata["workflow"]), extra_pnginfo["workflow"])
            self.assertEqual(json.loads(metadata["custom"]), extra_pnginfo["custom"])

    def test_preset_http_lifecycle_and_save_failure_recovery(self):
        preset_graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {"class_type": "ScenePrompt", "inputs": {**_scene_prompt_inputs(), "scene_prompt": ["1", 0]}},
                "3": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "http", "preset_name": "HTTP", "scene_prompt": ["2", 0]}},
            }
        }
        saved = self._request("/scene_presets/save", {"preset_id": "http", "name": "HTTP", "api_graph": preset_graph, "workflow": {"version": 1, "nodes": []}})
        self.assertEqual(saved["metadata"]["preset_id"], "http")
        listed = self._request("/scene_presets/list")
        self.assertIn("http", [entry["metadata"]["preset_id"] for entry in listed["presets"]])

        graph = _save_graph("ワークフロー全体", "preset-output")
        graph["1"] = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "http"}}
        graph["2"] = {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["1", 0], "count": 2}}
        prepared = self._request("/scene_prompt/runs/prepare", {"api_graph": {"output": graph}, "expand_node_id": "4"})
        handle = prepared["run_handle"]
        graph["1"]["inputs"]["run_handle"] = handle
        graph["4"]["inputs"]["run_handle"] = handle
        queued = self._request("/prompt", {"prompt": graph})
        self._request("/scene_prompt/runs/claim", {"run_handle": handle, "prompt_id": queued["prompt_id"]})
        preset_entry = self._wait_for_prompt(queued["prompt_id"])
        self.assertEqual(set(preset_entry["outputs"]).intersection({"6", "7"}), {"6", "7"})
        released = self._request("/scene_prompt/runs/release", {"run_handle": handle})
        self.assertTrue(released["released"])

        blocked = self.base / "output" / "blocked"
        blocked.parent.mkdir(parents=True, exist_ok=True)
        blocked.write_text("not a directory", encoding="utf-8")
        queued = self._request("/prompt", {"prompt": _save_graph("ワークフロー全体", "blocked")})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            entry = self._request(f"/history/{queued['prompt_id']}").get(queued["prompt_id"])
            if entry and entry.get("status", {}).get("status_str") == "error":
                break
            time.sleep(0.2)
        else:
            self.fail("The intentionally blocked save did not fail.")
        self.assertEqual(list((self.base / "output").glob("**/.scene-save-*.png")), [])
        self._queue_and_wait(_save_graph("ワークフロー全体", "after-failure"))


if __name__ == "__main__":
    unittest.main()
