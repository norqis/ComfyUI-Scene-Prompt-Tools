"""Isolated HTTP runtime smoke against a pinned real ComfyUI checkout."""

from __future__ import annotations

import copy
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread


ROOT = Path(__file__).resolve().parents[1]
SCENE_RUN_NODE_CLASSES = {
    "ScenePrompter",
    "SceneMatrix",
    "ScenePresetReference",
    "ScenePrompterExpand",
}


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


class _CallbackReceiver:
    """A loopback-only callback endpoint used by the isolated CPU harness."""

    def __enter__(self):
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def _record(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b""
                with receiver._lock:
                    receiver.requests.append({
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers.items()),
                        "body": body,
                        "received_at": time.time(),
                    })
                self.send_response(204)
                self.end_headers()

            do_GET = _record
            do_POST = _record

            def log_message(self, _format, *_args):
                pass

        self._lock = Lock()
        self.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_exc_info):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def url(self):
        host, port = self.server.server_address
        return f"http://{host}:{port}/callback"

    def wait_for(self, count, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if len(self.requests) >= count:
                    return list(self.requests)
            time.sleep(0.02)
        with self._lock:
            return list(self.requests)


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


def _save_graph(mode, path="runtime", *, width=16, height=16, batch_size=1, expand_presets=False):
    graph = {
        "1": {"class_type": "ScenePrompter", "inputs": _scene_prompt_inputs()},
        "2": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["1", 0], "count": 2}},
        "3": {
            "class_type": "SceneEmptyLatent",
            "inputs": {"scene_prompt": ["2", 0], "width": 512, "height": 512, "batch_size": 1},
        },
        "4": {
            "class_type": "ScenePrompterExpand",
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
    if expand_presets:
        graph["6"]["inputs"]["expand_preset_contents"] = True
        graph["7"]["inputs"]["expand_preset_contents"] = True
    return graph


def _callback_payload_template(marker):
    return json.dumps({
        "marker": marker,
        "current_positive": "{current_positive}",
        "current_negative": "{current_negative}",
        "all_positive": "{all_positive}",
        "all_negative": "{all_negative}",
        "current_node_names": "{current_node_names}",
        "all_node_names": "{all_node_names}",
        "exec_current_count": "{exec_current_count}",
        "exec_total_count": "{exec_total_count}",
        "exec_model": "{exec_model}",
        "exec_seed": "{exec_seed}",
    }, ensure_ascii=False)


def _callback_graph(receiver_url, path="callbacks", *, batch_size=2, count=2, expand_presets=False):
    """A no-inference graph whose callbacks bracket later plan contributions."""
    graph = {
        "1": {
            "class_type": "ScenePrompter",
            "inputs": {
                **_scene_prompt_inputs(),
                "positive_base": "before",
                "negative_base": "before-negative",
                "source_node_name": "Callback source",
            },
        },
        "2": {
            "class_type": "ScenePromptCallbackRequest",
            "inputs": {
                "method": "POST",
                "url": receiver_url,
                "text": _callback_payload_template("every"),
                "body_type": "json",
                "headers_json": '{"X-Callback-Test":"{exec_current_count}"}',
            },
        },
        "3": {
            "class_type": "ScenePromptCallback",
            "inputs": {
                "scene_prompt": ["1", 0],
                "callback": ["2", 0],
                "frequency": "毎回",
                "timeout_seconds": 10,
                "failure_mode": "停止",
            },
        },
        "4": {
            "class_type": "ScenePromptCallbackRequest",
            "inputs": {
                "method": "POST",
                "url": receiver_url,
                "text": _callback_payload_template("first"),
                "body_type": "json",
                "headers_json": "{}",
            },
        },
        "5": {
            "class_type": "ScenePromptCallback",
            "inputs": {
                "scene_prompt": ["3", 0],
                "callback": ["4", 0],
                "frequency": "初回",
                "timeout_seconds": 10,
                "failure_mode": "停止",
            },
        },
        "6": {
            "class_type": "ScenePrompter",
            "inputs": {
                **_scene_prompt_inputs(),
                "scene_prompt": ["5", 0],
                "positive_base": "after",
                "negative_base": "after-negative",
                "source_node_name": "Later source",
            },
        },
        "7": {
            "class_type": "ScenePrompterQueue",
            "inputs": {
                "scene_prompt1": ["6", 0],
                "source_node_name": "Selected queue",
            },
        },
        "8": {
            "class_type": "ScenePromptCounter",
            "inputs": {"scene_prompt": ["7", 0], "count": count, "source_node_name": "Selected count"},
        },
        "9": {
            "class_type": "SceneEmptyLatent",
            "inputs": {
                "scene_prompt": ["8", 0],
                "width": 16,
                "height": 16,
                "batch_size": batch_size,
                "source_node_name": "Selected latent",
            },
        },
        "10": {
            "class_type": "ScenePrompterExpand",
            "inputs": {
                "scene_prompt": ["15", 0],
                "current_index": 0,
                "run_id": "callback-http",
                "seed_base": 41,
                "timestamp_dir": False,
                "prefix": "",
            },
        },
        "11": {
            "class_type": "EmptyImage",
            "inputs": {"width": 16, "height": 16, "batch_size": batch_size, "color": 0},
        },
        "12": {
            "class_type": "SceneSaveImage",
            "inputs": {
                "images": ["11", 0],
                "path": path,
                "metadata_mode": "生成経路ノードのみ",
                "scene_info": ["10", 2],
                "expand_preset_contents": expand_presets,
            },
        },
        "13": {
            "class_type": "ScenePrompter",
            "inputs": {
                **_scene_prompt_inputs(),
                "positive_base": "unconnected",
                "source_node_name": "Unconnected branch",
            },
        },
        "14": {
            "class_type": "ScenePromptCallbackRequest",
            "inputs": {
                "method": "POST",
                "url": "http://127.0.0.1:1/unreachable",
                "text": "must stay isolated",
                "body_type": "text",
                "headers_json": "{}",
            },
        },
        "15": {
            "class_type": "ScenePromptCallback",
            "inputs": {"scene_prompt": ["9", 0]},
        },
        "16": {
            "class_type": "ScenePrompter",
            "inputs": {
                **_scene_prompt_inputs(),
                "positive_base": "other queue",
                "source_node_name": "Other queue source",
            },
        },
        "17": {
            "class_type": "ScenePrompterQueue",
            "inputs": {"scene_prompt1": ["16", 0], "source_node_name": "Other queue"},
        },
        "18": {
            "class_type": "SceneEmptyLatent",
            "inputs": {"scene_prompt": ["17", 0], "width": 16, "height": 16, "batch_size": 1},
        },
        "19": {
            "class_type": "ScenePrompterExpand",
            "inputs": {
                "scene_prompt": ["18", 0],
                "current_index": 0,
                "run_id": "other-expand",
                "seed_base": 0,
                "timestamp_dir": False,
            },
        },
    }
    return graph


def _expand_lifecycle_graph(receiver_url, path="expand-lifecycle", *, count=2):
    def producer(marker):
        return {
            "class_type": "ScenePromptCallbackRequest",
            "inputs": {
                "method": "POST",
                "url": receiver_url,
                "text": _callback_payload_template(marker),
                "body_type": "json",
                "headers_json": "{}",
            },
        }

    return {
        "1": {
            "class_type": "ScenePrompter",
            "inputs": {
                **_scene_prompt_inputs(),
                "positive_base": "lifecycle",
                "negative_base": "lifecycle-negative",
                "source_node_name": "Lifecycle source",
            },
        },
        "2": producer("first"),
        "3": producer("each"),
        "4": producer("pathA"),
        "5": {
            "class_type": "ScenePromptCallback",
            "inputs": {
                "scene_prompt": ["1", 0],
                "callback": ["4", 0],
                "frequency": "毎回",
                "timeout_seconds": 10,
                "failure_mode": "停止",
            },
        },
        "6": producer("pathB"),
        "7": {
            "class_type": "ScenePromptCallback",
            "inputs": {
                "scene_prompt": ["5", 0],
                "callback": ["6", 0],
                "frequency": "毎回",
                "timeout_seconds": 10,
                "failure_mode": "停止",
            },
        },
        "8": {
            "class_type": "ScenePromptCounter",
            "inputs": {"scene_prompt": ["7", 0], "count": count, "source_node_name": "Lifecycle count"},
        },
        "9": {
            "class_type": "SceneEmptyLatent",
            "inputs": {
                "scene_prompt": ["8", 0],
                "width": 16,
                "height": 16,
                "batch_size": 1,
                "source_node_name": "Lifecycle latent",
            },
        },
        "10": {
            "class_type": "ScenePrompterExpand",
            "inputs": {
                "scene_prompt": ["9", 0],
                "current_index": 0,
                "run_id": "expand-lifecycle",
                "seed_base": 101,
                "timestamp_dir": False,
                "prefix": "",
                "callback_first": ["2", 0],
                "callback_each": ["3", 0],
                "callback_last": ["11", 0],
                "callback_timeout_seconds": 10,
                "callback_failure_mode": "停止",
            },
        },
        "11": producer("last"),
        "12": {"class_type": "EmptyImage", "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0}},
        "13": {
            "class_type": "SceneSaveImage",
            "inputs": {
                "images": ["12", 0],
                "path": path,
                "metadata_mode": "生成経路ノードのみ",
                "scene_info": ["10", 2],
            },
        },
    }


def _renumber_graph(graph, offset):
    """Make a disjoint prompt graph that can share a single run handle."""
    mapping = {str(node_id): str(int(node_id) + offset) for node_id in graph}
    result = {}
    for node_id, node in graph.items():
        copied = copy.deepcopy(node)
        for value in copied.get("inputs", {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in mapping:
                value[0] = mapping[str(value[0])]
        result[mapping[str(node_id)]] = copied
    return result


def _workflow_for_graph(graph):
    nodes = []
    links = []
    link_id = 1
    for index, (node_id, node) in enumerate(graph.items()):
        inputs = []
        for name, value in node.get("inputs", {}).items():
            inputs.append({"name": name, "type": "*", "link": None})
        nodes.append({
            "id": int(node_id),
            "type": node["class_type"],
            "pos": [index * 180, 40],
            "inputs": inputs,
            "outputs": [{"name": "output", "type": "*", "links": []}],
            "widgets_values": [node.get("inputs", {}).get("preset_id", "")] if node["class_type"] == "ScenePresetReference" else [],
        })
    by_id = {str(node["id"]): node for node in nodes}
    for target_id, target in graph.items():
        for target_slot, (_name, value) in enumerate(target.get("inputs", {}).items()):
            if not isinstance(value, list) or len(value) != 2:
                continue
            source_id, source_slot = str(value[0]), value[1]
            by_id[source_id]["outputs"][0]["links"].append(link_id)
            by_id[str(target_id)]["inputs"][target_slot]["link"] = link_id
            links.append([link_id, int(source_id), source_slot, int(target_id), target_slot, "*"])
            link_id += 1
    return {"version": 1, "nodes": nodes, "links": links, "groups": [], "last_node_id": max(int(node_id) for node_id in graph), "last_link_id": link_id - 1}


def _apply_run_handle(graph, handle):
    for node in graph.values():
        if node.get("class_type") not in SCENE_RUN_NODE_CLASSES:
            continue
        node.setdefault("inputs", {})["run_handle"] = handle


def _large_extra_pnginfo():
    """Use realistic workflow metadata without adding model inference to CPU CI."""
    workflow_nodes = [
        {
            "id": index,
            "type": "ScenePrompter",
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
                if "ScenePrompter" in object_info and "SceneSaveImage" in object_info:
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

    @classmethod
    def _request_status(cls, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{cls.port}{path}",
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method="POST" if data else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

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

    def _wait_for_prompt_error(self, prompt_id, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            entry = self._request(f"/history/{prompt_id}").get(prompt_id)
            status = entry.get("status", {}) if isinstance(entry, dict) else {}
            if status.get("status_str") == "error":
                return entry
            time.sleep(0.1)
        self.fail(f"Timed out waiting for failed prompt {prompt_id}")

    def _queue_and_wait(self, graph, *, extra_data=None, timeout=60):
        payload = {"prompt": graph}
        if extra_data is not None:
            payload["extra_data"] = extra_data
        return self._wait_for_prompt(self._request("/prompt", payload)["prompt_id"], timeout)

    def _prepare_callback_run(self, graph, expand_node_id="10"):
        workflow = _workflow_for_graph(graph)
        prepared = self._request("/scene_prompt/runs/prepare", {
            "api_graph": {"output": graph},
            "expand_node_id": expand_node_id,
            "workflow": workflow,
        })
        _apply_run_handle(graph, prepared["run_handle"])
        return prepared["run_handle"], workflow

    def _queue_callback_graph(self, graph, handle, workflow, *, claim_run=False):
        queued = self._request("/prompt", {
            "prompt": graph,
            "extra_data": {"extra_pnginfo": {"workflow": workflow}},
        })
        if claim_run:
            claimed = self._request("/scene_prompt/runs/claim", {
                "run_handle": handle,
                "prompt_id": queued["prompt_id"],
            })
            self.assertTrue(claimed["claimed"])
        return self._wait_for_prompt(queued["prompt_id"])

    def _queue_lifecycle_graph(self, graph, handle, workflow, *, claim_run=False):
        queued = self._request("/prompt", {
            "prompt": graph,
            "extra_data": {"extra_pnginfo": {"workflow": workflow}},
        })
        if claim_run:
            claimed = self._request("/scene_prompt/runs/claim", {
                "run_handle": handle,
                "prompt_id": queued["prompt_id"],
            })
            self.assertTrue(claimed["claimed"])
        return queued["prompt_id"], self._wait_for_prompt(queued["prompt_id"])

    def test_http_expand_callback_lifecycle_finalizes_after_last_saved_image(self):
        with _CallbackReceiver() as receiver:
            graph = _expand_lifecycle_graph(receiver.url)
            handle, workflow = self._prepare_callback_run(graph)
            try:
                first_prompt_id, _first = self._queue_lifecycle_graph(graph, handle, workflow, claim_run=True)
                received = receiver.wait_for(4)
                self.assertEqual(len(received), 4)
                first_files = sorted((self.base / "output" / "expand-lifecycle").glob("*.png"))
                self.assertEqual(len(first_files), 1)
                self.assertLessEqual(
                    max(request["received_at"] for request in received),
                    first_files[0].stat().st_mtime + 0.02,
                )

                cached = copy.deepcopy({node_id: graph[node_id] for node_id in ("10", "12", "13")})
                del cached["10"]["inputs"]["scene_prompt"]
                cached["10"]["inputs"]["current_index"] = 1
                second_prompt_id, _second = self._queue_lifecycle_graph(cached, handle, workflow)
                received = receiver.wait_for(7)
                self.assertEqual(len(received), 7)
                all_files = sorted((self.base / "output" / "expand-lifecycle").glob("*.png"))
                self.assertEqual(len(all_files), 2)
                new_files = [file_path for file_path in all_files if file_path not in first_files]
                self.assertEqual(len(new_files), 1)
                self.assertLessEqual(
                    max(request["received_at"] for request in received[4:]),
                    new_files[0].stat().st_mtime + 0.02,
                )

                pending_status, pending = self._request_status("/scene_prompt/runs/finalize", {
                    "run_handle": handle,
                    "expand_node_id": "10",
                    "prompt_id": f"{second_prompt_id}-not-finished",
                })
                self.assertEqual(pending_status, 202)
                self.assertEqual(pending["state"], "pending")
                self.assertEqual(len(receiver.wait_for(7, timeout=0.1)), 7)

                wrong_status, wrong = self._request_status("/scene_prompt/runs/finalize", {
                    "run_handle": handle,
                    "expand_node_id": "10",
                    "prompt_id": first_prompt_id,
                })
                self.assertEqual(wrong_status, 409)
                self.assertEqual(wrong["state"], "wrong_prompt")
                self.assertEqual(len(receiver.wait_for(7, timeout=0.1)), 7)

                finalized = self._request("/scene_prompt/runs/finalize", {
                    "run_handle": handle,
                    "expand_node_id": "10",
                    "prompt_id": second_prompt_id,
                })
                self.assertEqual(finalized["state"], "finalized")
                received = receiver.wait_for(8)
                self.assertEqual(len(received), 8)
                self.assertGreaterEqual(received[-1]["received_at"], max(file_path.stat().st_mtime for file_path in all_files))

                duplicate_status, duplicate = self._request_status("/scene_prompt/runs/finalize", {
                    "run_handle": handle,
                    "expand_node_id": "10",
                    "prompt_id": second_prompt_id,
                })
                self.assertEqual(duplicate_status, 200)
                self.assertEqual(duplicate["state"], "finalized")
                self.assertEqual(len(receiver.wait_for(8, timeout=0.1)), 8)

                a_received = list(received)
                second_expand = _renumber_graph(
                    _expand_lifecycle_graph(receiver.url, "expand-lifecycle-second", count=1),
                    100,
                )
                second_expand["110"]["inputs"]["run_id"] = "expand-lifecycle-second"
                _apply_run_handle(second_expand, handle)
                second_prompt_id, _second_expand = self._queue_lifecycle_graph(
                    second_expand, handle, _workflow_for_graph(second_expand)
                )
                second_received = receiver.wait_for(12)
                self.assertEqual(len(second_received), 12)
                self.assertEqual(
                    [json.loads(request["body"].decode("utf-8"))["marker"] for request in second_received[-4:]],
                    ["first", "each", "pathA", "pathB"],
                )
                self.assertEqual(self._request("/scene_prompt/runs/finalize", {
                    "run_handle": handle,
                    "expand_node_id": "110",
                    "prompt_id": second_prompt_id,
                })["state"], "finalized")
                second_received = receiver.wait_for(13)
                self.assertEqual(len(second_received), 13)
                self.assertEqual(json.loads(second_received[-1]["body"].decode("utf-8"))["marker"], "last")
            finally:
                self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": handle})["released"])

            payloads = [json.loads(request["body"].decode("utf-8")) for request in a_received]
            self.assertEqual(
                [payload["marker"] for payload in payloads],
                ["first", "each", "pathA", "pathB", "each", "pathA", "pathB", "last"],
            )
            for payload in payloads:
                self.assertEqual(payload["current_positive"], payload["all_positive"])
                self.assertEqual(payload["current_negative"], payload["all_negative"])
                self.assertEqual(payload["current_positive"], "lifecycle")
                self.assertEqual(payload["current_negative"], "lifecycle-negative")
                self.assertEqual(payload["exec_total_count"], "2")
            self.assertEqual(payloads[0]["exec_current_count"], "1")
            self.assertEqual(payloads[0]["exec_seed"], "101")
            self.assertEqual(payloads[-1]["exec_current_count"], "2")
            self.assertEqual(payloads[-1]["exec_seed"], "102")
            for payload in payloads:
                if payload["marker"] in {"first", "each", "last"}:
                    self.assertEqual(payload["current_node_names"], payload["all_node_names"])
                    self.assertEqual(
                        payload["all_node_names"],
                        "Lifecycle source_Lifecycle count_Lifecycle latent",
                    )

            reset_graph = _expand_lifecycle_graph(receiver.url, "expand-lifecycle-reset", count=1)
            reset_handle, reset_workflow = self._prepare_callback_run(reset_graph)
            try:
                reset_prompt_id, _reset = self._queue_lifecycle_graph(
                    reset_graph, reset_handle, reset_workflow, claim_run=True
                )
                self.assertEqual(len(receiver.wait_for(17)), 17)
                self.assertEqual(self._request("/scene_prompt/runs/finalize", {
                    "run_handle": reset_handle,
                    "expand_node_id": "10",
                    "prompt_id": reset_prompt_id,
                })["state"], "finalized")
                reset_received = receiver.wait_for(18)
                self.assertEqual(len(reset_received), 18)
            finally:
                self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": reset_handle})["released"])
            self.assertEqual(
                [json.loads(request["body"].decode("utf-8"))["marker"] for request in reset_received[-5:]],
                ["first", "each", "pathA", "pathB", "last"],
            )

            blocked = self.base / "output" / "expand-lifecycle-failed"
            blocked.parent.mkdir(parents=True, exist_ok=True)
            blocked.write_text("not a directory", encoding="utf-8")
            failed_graph = _expand_lifecycle_graph(receiver.url, "expand-lifecycle-failed", count=1)
            failed_handle, failed_workflow = self._prepare_callback_run(failed_graph)
            try:
                queued = self._request("/prompt", {
                    "prompt": failed_graph,
                    "extra_data": {"extra_pnginfo": {"workflow": failed_workflow}},
                })
                self.assertTrue(self._request("/scene_prompt/runs/claim", {
                    "run_handle": failed_handle,
                    "prompt_id": queued["prompt_id"],
                })["claimed"])
                self._wait_for_prompt_error(queued["prompt_id"])
                self.assertEqual(len(receiver.wait_for(22)), 22)
                status_code, failed_finalize = self._request_status("/scene_prompt/runs/finalize", {
                    "run_handle": failed_handle,
                    "expand_node_id": "10",
                    "prompt_id": queued["prompt_id"],
                })
                self.assertEqual(status_code, 409)
                self.assertEqual(failed_finalize["state"], "not_success")
                self.assertEqual(len(receiver.wait_for(22, timeout=0.1)), 22)
            finally:
                self._request("/scene_prompt/runs/release", {"run_handle": failed_handle})

    def test_http_callbacks_dispatch_final_values_once_per_run_and_reuse_cached_plan(self):
        with _CallbackReceiver() as receiver:
            graph = _callback_graph(receiver.url, "callback-runtime")
            handle, workflow = self._prepare_callback_run(graph)
            self.assertEqual(receiver.requests, [], "Preparing or previewing a run must not dispatch callbacks.")
            try:
                first = self._queue_callback_graph(graph, handle, workflow, claim_run=True)
                self.assertIn("12", first["outputs"])
                received = receiver.wait_for(2)
                self.assertEqual(len(received), 2)
                first_files = sorted((self.base / "output" / "callback-runtime").glob("*.png"))
                self.assertEqual(len(first_files), 2)
                self.assertLessEqual(
                    max(request["received_at"] for request in received),
                    min(file_path.stat().st_mtime for file_path in first_files) + 0.02,
                )

                cached = copy.deepcopy({node_id: graph[node_id] for node_id in ("10", "11", "12")})
                del cached["10"]["inputs"]["scene_prompt"]
                cached["10"]["inputs"]["current_index"] = 1
                cached["10"]["inputs"]["seed_base"] = 41
                self._queue_callback_graph(cached, handle, workflow)
                received = receiver.wait_for(3)
                self.assertEqual(len(received), 3)
                second_files = sorted((self.base / "output" / "callback-runtime").glob("*.png"))
                self.assertEqual(len(second_files), 4)
                new_files = [file_path for file_path in second_files if file_path not in first_files]
                self.assertEqual(len(new_files), 2)
                self.assertLessEqual(
                    received[-1]["received_at"],
                    min(file_path.stat().st_mtime for file_path in new_files) + 0.02,
                )
            finally:
                self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": handle})["released"])

            received_before_reset = list(received)
            reset_graph = _callback_graph(receiver.url, "callback-reset", batch_size=1, count=1)
            reset_handle, reset_workflow = self._prepare_callback_run(reset_graph)
            try:
                self._queue_callback_graph(reset_graph, reset_handle, reset_workflow, claim_run=True)
                reset_received = receiver.wait_for(5)
                self.assertEqual(len(reset_received), 5)
            finally:
                self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": reset_handle})["released"])

        payloads = [json.loads(request["body"].decode("utf-8")) for request in received_before_reset]
        reset_payloads = [json.loads(request["body"].decode("utf-8")) for request in reset_received[-2:]]
        self.assertEqual({payload["marker"] for payload in reset_payloads}, {"every", "first"})
        self.assertEqual([payload["marker"] for payload in payloads], ["every", "first", "every"])
        every = [payload for payload in payloads if payload["marker"] == "every"]
        first_only = [payload for payload in payloads if payload["marker"] == "first"]
        self.assertEqual(len(every), 2)
        self.assertEqual(len(first_only), 1)
        self.assertEqual([payload["exec_current_count"] for payload in every], ["1", "2"])
        self.assertEqual([payload["exec_seed"] for payload in every], ["41", "42"])
        for payload in payloads:
            self.assertEqual(payload["current_positive"], "before")
            self.assertEqual(payload["current_negative"], "before-negative")
            self.assertEqual(payload["all_positive"], "before, after")
            self.assertEqual(payload["all_negative"], "before-negative, after-negative")
            self.assertEqual(payload["exec_total_count"], "2")
            self.assertEqual(payload["exec_model"], "Illustrious")
            self.assertEqual(payload["current_node_names"], "Callback source")
            self.assertEqual(
                payload["all_node_names"],
                "Callback source_Later source_Selected queue_Selected count_Selected latent",
            )

        self.assertEqual(received[0]["headers"]["X-Callback-Test"], "1")
        files = sorted((self.base / "output" / "callback-runtime").glob("*.png"))
        self.assertEqual(len(files), 4, "Two batches with batch_size=2 must save four images.")
        from PIL import Image
        for file_path in files:
            with Image.open(file_path) as image:
                saved_prompt = json.loads(image.text["prompt"])
            self.assertIn("2", saved_prompt)
            self.assertIn("3", saved_prompt)
            self.assertIn("4", saved_prompt)
            self.assertIn("5", saved_prompt)
            self.assertNotIn("13", saved_prompt)
            self.assertNotIn("14", saved_prompt)
            self.assertNotIn("16", saved_prompt)
            self.assertNotIn("17", saved_prompt)
            self.assertNotIn("18", saved_prompt)
            self.assertNotIn("19", saved_prompt)

    def test_http_preset_callbacks_expand_into_execution_metadata_and_replay(self):
        with _CallbackReceiver() as receiver:
            preset_graph = {
                "output": {
                    "1": {"class_type": "ScenePresetInput", "inputs": {}},
                    "2": {
                        "class_type": "ScenePrompter",
                        "inputs": {
                            **_scene_prompt_inputs(),
                            "scene_prompt": ["1", 0],
                            "positive_base": "preset-positive",
                            "source_node_name": "Preset source",
                        },
                    },
                    "3": {
                        "class_type": "ScenePromptCallbackRequest",
                        "inputs": {
                            "method": "POST",
                            "url": receiver.url,
                            "text": _callback_payload_template("preset"),
                            "body_type": "json",
                            "headers_json": "{}",
                        },
                    },
                    "4": {
                        "class_type": "ScenePromptCallback",
                        "inputs": {
                            "scene_prompt": ["2", 0],
                            "callback": ["3", 0],
                            "frequency": "初回",
                            "timeout_seconds": 10,
                            "failure_mode": "停止",
                        },
                    },
                    "5": {
                        "class_type": "ScenePresetOutput",
                        "inputs": {
                            "preset_id": "callback-preset",
                            "preset_name": "Callback preset",
                            "scene_prompt": ["4", 0],
                        },
                    },
                },
            }
            self._request("/scene_presets/save", {
                "preset_id": "callback-preset",
                "name": "Callback preset",
                "output_node_id": "5",
                "api_graph": preset_graph,
                "workflow": _workflow_for_graph(preset_graph["output"]),
            })
            wrapper_graph = {
                "output": {
                    "1": {"class_type": "ScenePresetInput", "inputs": {}},
                    "2": {
                        "class_type": "ScenePresetReference",
                        "inputs": {"preset_id": "callback-preset", "scene_prompt": ["1", 0]},
                    },
                    "3": {
                        "class_type": "ScenePresetOutput",
                        "inputs": {
                            "preset_id": "callback-wrapper",
                            "preset_name": "Callback wrapper",
                            "scene_prompt": ["2", 0],
                        },
                    },
                },
            }
            self._request("/scene_presets/save", {
                "preset_id": "callback-wrapper",
                "name": "Callback wrapper",
                "output_node_id": "3",
                "api_graph": wrapper_graph,
                "workflow": _workflow_for_graph(wrapper_graph["output"]),
            })
            graph = {
                "1": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "callback-preset"}},
                "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "callback-wrapper"}},
                "3": {
                    "class_type": "ScenePrompterQueue",
                    "inputs": {
                        "scene_prompt1": ["1", 0],
                        "scene_prompt2": ["2", 0],
                        "source_node_name": "Preset queue",
                    },
                },
                "4": {
                    "class_type": "SceneEmptyLatent",
                    "inputs": {"scene_prompt": ["3", 0], "width": 16, "height": 16, "batch_size": 1},
                },
                "6": {
                    "class_type": "ScenePrompterExpand",
                    "inputs": {
                        "scene_prompt": ["4", 0],
                        "current_index": 0,
                        "run_id": "preset-callback-http",
                        "seed_base": 7,
                        "timestamp_dir": False,
                        "prefix": "",
                    },
                },
                "7": {"class_type": "EmptyImage", "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0}},
                "8": {
                    "class_type": "SceneSaveImage",
                    "inputs": {
                        "images": ["7", 0],
                        "path": "preset-callback-off",
                        "metadata_mode": "生成経路ノードのみ",
                        "scene_info": ["6", 2],
                        "expand_preset_contents": False,
                    },
                },
                "9": {
                    "class_type": "SceneSaveImage",
                    "inputs": {
                        "images": ["7", 0],
                        "path": "preset-callback-on",
                        "metadata_mode": "生成経路ノードのみ",
                        "scene_info": ["6", 2],
                        "expand_preset_contents": True,
                    },
                },
            }
            handle, workflow = self._prepare_callback_run(graph, "6")
            try:
                self._queue_callback_graph(graph, handle, workflow, claim_run=True)
                cached = copy.deepcopy({node_id: graph[node_id] for node_id in ("6", "7", "8", "9")})
                del cached["6"]["inputs"]["scene_prompt"]
                cached["6"]["inputs"]["current_index"] = 1
                self._queue_callback_graph(cached, handle, workflow)
                received = receiver.wait_for(2)
                self.assertEqual(len(received), 2)
                self.assertEqual(
                    [json.loads(request["body"].decode("utf-8"))["exec_current_count"] for request in received],
                    ["1", "2"],
                )
                for request in received:
                    names = json.loads(request["body"].decode("utf-8"))["all_node_names"].split("_")
                    self.assertEqual(names, list(dict.fromkeys(names)))
            finally:
                self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": handle})["released"])

            from PIL import Image
            off_pngs = sorted((self.base / "output" / "preset-callback-off").glob("*.png"))
            on_pngs = sorted((self.base / "output" / "preset-callback-on").glob("*.png"))
            self.assertEqual(len(off_pngs), 2)
            self.assertEqual(len(on_pngs), 2)
            on_prompts = []
            for file_path in off_pngs:
                with Image.open(file_path) as image:
                    off_prompt = json.loads(image.text["prompt"])
                self.assertIn("ScenePresetReference", {node["class_type"] for node in off_prompt.values()})
            for file_path in on_pngs:
                with Image.open(file_path) as image:
                    on_prompt = json.loads(image.text["prompt"])
                    on_workflow = json.loads(image.text["workflow"])
                on_prompts.append(on_prompt)
                self.assertNotIn("ScenePresetReference", {node["class_type"] for node in on_prompt.values()})
                self.assertIn("ScenePromptCallback", {node["class_type"] for node in on_prompt.values()})
                self.assertIn("ScenePromptCallbackRequest", {node["class_type"] for node in on_prompt.values()})
                callback_node = next(node for node in on_prompt.values() if node["class_type"] == "ScenePromptCallback")
                callback_source = callback_node["inputs"]["callback"]
                self.assertIsInstance(callback_source, list)
                self.assertEqual(on_prompt[str(callback_source[0])]["class_type"], "ScenePromptCallbackRequest")
                self.assertIn("ScenePromptCallback", {node["type"] for node in on_workflow["nodes"]})

            replay_handle, replay_workflow = self._prepare_callback_run(on_prompts[0], "6")
            try:
                self._queue_callback_graph(on_prompts[0], replay_handle, replay_workflow, claim_run=True)
                replay_received = receiver.wait_for(3)
                self.assertEqual(len(replay_received), 3)
            finally:
                self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": replay_handle})["released"])

        self.assertEqual(
            [json.loads(request["body"].decode("utf-8"))["marker"] for request in replay_received],
            ["preset", "preset", "preset"],
        )

    def test_http_prompt_history_two_outputs_and_metadata_modes(self):
        for index, mode in enumerate(("ワークフロー全体", "生成経路ノードのみ", "プロンプトのみ"), start=1):
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

    def test_http_expanded_preset_metadata_reloads_and_queues(self):
        preset_graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {"class_type": "ScenePrompter", "inputs": {**_scene_prompt_inputs(), "scene_prompt": ["1", 0]}},
                "3": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "expanded", "preset_name": "Expanded", "scene_prompt": ["2", 0]}},
            }
        }
        self._request("/scene_presets/save", {
            "preset_id": "expanded",
            "name": "Expanded",
            "output_node_id": "3",
            "api_graph": preset_graph,
            "workflow": _workflow_for_graph(preset_graph["output"]),
        })
        graph = _save_graph("ワークフロー全体", "preset-expanded", expand_presets=True)
        graph["1"] = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "expanded"}}
        graph["2"] = {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["1", 0], "count": 2}}
        workflow = _workflow_for_graph(graph)
        prepared = self._request("/scene_prompt/runs/prepare", {
            "api_graph": {"output": graph},
            "expand_node_id": "4",
            "workflow": workflow,
        })
        handle = prepared["run_handle"]
        _apply_run_handle(graph, handle)
        queued = self._request("/prompt", {"prompt": graph, "extra_data": {"extra_pnginfo": {"workflow": workflow}}})
        self._request("/scene_prompt/runs/claim", {"run_handle": handle, "prompt_id": queued["prompt_id"]})
        first = self._wait_for_prompt(queued["prompt_id"])
        self.assertEqual(set(first["outputs"]).intersection({"6", "7"}), {"6", "7"})

        from PIL import Image
        files = sorted((self.base / "output" / "preset-expanded").glob("*.png"))
        self.assertEqual(len(files), 2)
        with Image.open(files[0]) as image:
            metadata = dict(image.text)
        reloaded_prompt = json.loads(metadata["prompt"])
        reloaded_workflow = json.loads(metadata["workflow"])
        self.assertNotIn("ScenePresetReference", {node["class_type"] for node in reloaded_prompt.values()})
        self.assertNotIn("ScenePresetReference", {node["type"] for node in reloaded_workflow["nodes"]})
        self.assertNotIn("ScenePresetInput", {node["type"] for node in reloaded_workflow["nodes"]})
        self.assertNotIn("ScenePresetOutput", {node["type"] for node in reloaded_workflow["nodes"]})

        self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": handle})["released"])
        replay_prepared = self._request("/scene_prompt/runs/prepare", {
            "api_graph": {"output": reloaded_prompt},
            "expand_node_id": "4",
            "workflow": reloaded_workflow,
        })
        replay_handle = replay_prepared["run_handle"]
        _apply_run_handle(reloaded_prompt, replay_handle)
        replay_queued = self._request("/prompt", {
            "prompt": reloaded_prompt,
            "extra_data": {"extra_pnginfo": {"workflow": reloaded_workflow}},
        })
        self._request("/scene_prompt/runs/claim", {
            "run_handle": replay_handle,
            "prompt_id": replay_queued["prompt_id"],
        })
        replay = self._wait_for_prompt(replay_queued["prompt_id"])
        self.assertEqual(set(replay["outputs"]).intersection({"6", "7"}), {"6", "7"})
        self.assertTrue(self._request("/scene_prompt/runs/release", {"run_handle": replay_handle})["released"])

    def test_preset_http_lifecycle_and_save_failure_recovery(self):
        preset_graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {"class_type": "ScenePrompter", "inputs": {**_scene_prompt_inputs(), "scene_prompt": ["1", 0]}},
                "3": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "http", "preset_name": "HTTP", "scene_prompt": ["2", 0]}},
            }
        }
        saved = self._request("/scene_presets/save", {"preset_id": "http", "name": "HTTP", "output_node_id": "3", "api_graph": preset_graph, "workflow": {"version": 1, "nodes": []}})
        self.assertEqual(saved["metadata"]["preset_id"], "http")
        listed = self._request("/scene_presets/list")
        self.assertIn("http", [entry["metadata"]["preset_id"] for entry in listed["presets"]])
        loaded = self._request("/scene_presets/load?preset_id=http")
        self.assertSetEqual(set(loaded), {"metadata", "workflow"})
        self.assertEqual(loaded["metadata"]["preset_id"], "http")

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
