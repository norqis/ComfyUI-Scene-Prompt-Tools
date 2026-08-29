"""Load the package with real ComfyUI modules, not local test doubles."""

from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def _comfyui_source():
    if os.environ.get("RUN_REAL_COMFYUI_SMOKE") != "1":
        raise unittest.SkipTest("The real ComfyUI smoke test runs only when explicitly requested.")
    source = os.environ.get("COMFYUI_SOURCE")
    if not source:
        raise unittest.SkipTest("COMFYUI_SOURCE is not configured for the real ComfyUI smoke test.")
    root = Path(source).resolve()
    if not (root / "server.py").is_file() or not (root / "comfy_execution" / "graph_utils.py").is_file():
        raise RuntimeError("COMFYUI_SOURCE is not a ComfyUI source checkout.")
    return root


class RealComfyUISmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = _comfyui_source()
        sys.path.insert(0, str(source))
        from comfy.cli_args import args

        args.cpu = True

        from server import PromptServer

        cls.loop = asyncio.new_event_loop()
        PromptServer(cls.loop)

        spec = importlib.util.spec_from_file_location(
            "scene_prompt_tools_smoke",
            ROOT / "__init__.py",
            submodule_search_locations=[str(ROOT)],
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("Could not load the custom-node package.")
        cls.package = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.package
        spec.loader.exec_module(cls.package)

    @classmethod
    def tearDownClass(cls):
        cls.loop.close()

    def test_registers_current_nodes_and_web_directory(self):
        self.assertIn("ScenePrompt", self.package.NODE_CLASS_MAPPINGS)
        self.assertEqual(self.package.NODE_DISPLAY_NAME_MAPPINGS["ScenePrompt"], "Scene Prompt")
        self.assertEqual(self.package.NODE_CLASS_MAPPINGS["SceneSaveImage"].CATEGORY, "Scene/output")
        self.assertEqual(self.package.WEB_DIRECTORY, "./web")
        self.assertTrue((ROOT / self.package.WEB_DIRECTORY).is_dir())

    def test_uses_real_comfyui_graph_builder_and_routes(self):
        from comfy_execution.graph_utils import GraphBuilder
        from server import PromptServer

        presets = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.presets"]
        routes = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.routes"]
        paths = {route.path for route in PromptServer.instance.routes._items}

        self.assertIs(presets.GraphBuilder, GraphBuilder)
        self.assertEqual(GraphBuilder.__module__, "comfy_execution.graph_utils")
        self.assertIn("/scene_prompt/items", paths)
        self.assertIn("/scene_prompt/runs/prepare", paths)
        self.assertIn("/scene_prompt/runs/claim", paths)
        self.assertIn("/scene_prompt/runs/release", paths)

    def test_scene_save_image_writes_each_metadata_mode_with_real_comfyui_modules(self):
        from PIL import Image
        import torch
        import execution
        import nodes as comfy_nodes

        nodes = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.nodes"]
        prompt = {
            "1": {
                "class_type": "EmptyImage",
                "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0},
            },
            "2": {
                "class_type": "EmptyImage",
                "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0},
            },
            "4": {
                "class_type": "SceneSaveImage",
                "inputs": {
                    "images": ["1", 0],
                    "path": "",
                    "metadata_mode": "生成経路ノードのみ",
                },
            },
        }
        extra_pnginfo = {
            "prompt": {"reserved": "ignored outside full workflow"},
            "workflow": {"nodes": [{"id": "4", "pos": [1, 2]}]},
            "custom": {"kept": True},
        }

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            nodes.folder_paths, "get_output_directory", return_value=directory
        ):
            saved = {}
            for index, mode in enumerate(nodes.SAVE_METADATA_CHOICES, start=1):
                result = nodes.SceneSaveImage().save_images(
                    [torch.zeros((16, 16, 3), dtype=torch.float32)],
                    "",
                    metadata_mode=mode,
                    scene_info={"use_run_dir": False, "file_index": index, "seed": 7},
                    prompt=prompt,
                    extra_pnginfo=extra_pnginfo,
                    unique_id=4,
                )
                with Image.open(result["result"][1]) as image:
                    saved[mode] = dict(image.text)

        self.assertEqual(json.loads(saved[nodes.SAVE_METADATA_WORKFLOW]["prompt"]), prompt)
        self.assertIn("workflow", saved[nodes.SAVE_METADATA_WORKFLOW])
        self.assertEqual(json.loads(saved[nodes.SAVE_METADATA_WORKFLOW]["custom"]), {"kept": True})

        self.assertNotIn("prompt", saved[nodes.SAVE_METADATA_PROMPT_ONLY])
        self.assertNotIn("workflow", saved[nodes.SAVE_METADATA_PROMPT_ONLY])
        self.assertEqual(json.loads(saved[nodes.SAVE_METADATA_PROMPT_ONLY]["custom"]), {"kept": True})

        execution_path = json.loads(saved[nodes.SAVE_METADATA_EXECUTION_PATH]["prompt"])
        self.assertNotIn("workflow", saved[nodes.SAVE_METADATA_EXECUTION_PATH])
        self.assertEqual(set(execution_path), {"1", "4"})
        self.assertEqual(json.loads(saved[nodes.SAVE_METADATA_EXECUTION_PATH]["custom"]), {"kept": True})
        for node in execution_path.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2:
                    self.assertIn(str(value[0]), execution_path)

        with mock.patch.dict(comfy_nodes.NODE_CLASS_MAPPINGS, {"SceneSaveImage": nodes.SceneSaveImage}):
            valid, error, outputs, _node_errors = asyncio.run(
                execution.validate_prompt("scene-save-metadata-smoke", execution_path, None)
            )
        self.assertTrue(valid, error)
        self.assertIn("4", outputs)

    def test_expand_is_changed_does_not_register_a_seed_plan(self):
        nodes = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.nodes"]
        runs = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.runs"]
        runs.RUN_CONTEXTS.clear()
        handle = runs.create_run_context("smoke")
        unique_id = "expand-1"
        try:
            nodes.ScenePromptExpand.IS_CHANGED(
                current_index=0,
                scene_prompt=None,
                run_handle=handle,
                unique_id=unique_id,
            )
            self.assertEqual(runs.require_run_context(handle)["plans"], {})

            plan = nodes.SceneEmptyLatent().apply_latent(
                nodes.ScenePromptCounter().count(count=2)[0],
                width=896,
                height=1344,
                batch_size=1,
            )[0]
            expander = nodes.ScenePromptExpand()
            first = expander.expand(
                current_index=0,
                timestamp_dir=False,
                scene_prompt=plan,
                run_handle=handle,
                unique_id=unique_id,
            )
            second = expander.expand(
                current_index=1,
                timestamp_dir=False,
                scene_prompt=plan,
                run_handle=handle,
                unique_id=unique_id,
            )

            self.assertEqual(first[2]["total_count"], 2)
            self.assertEqual(second[2]["total_count"], 2)
            self.assertEqual(first[4]["samples"].shape, (1, 4, 168, 112))
            self.assertEqual(second[4]["samples"].shape, (1, 4, 168, 112))
            self.assertEqual(runs.require_run_context(handle)["plans"][unique_id], plan)
        finally:
            runs.release_run_context(handle, "smoke")

    def test_preset_is_changed_cache_keeps_run_and_snapshot_read_only(self):
        import execution
        import nodes as comfy_nodes
        from comfy_execution.graph import DynamicPrompt

        presets = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.presets"]
        runs = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.runs"]
        preset_graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {
                    "class_type": "ScenePrompt",
                    "inputs": {
                        "scene_prompt": ["1", 0],
                        "prompt_name": "cache smoke",
                        "positive_base": "test",
                        "positive_json": '{"version":1,"categories":{}}',
                        "negative_base": "",
                        "negative_json": '{"version":1,"categories":{}}',
                        "category_order": "",
                        "seed": 0,
                        "randomize": True,
                    },
                },
                "3": {
                    "class_type": "ScenePresetOutput",
                    "inputs": {"preset_id": "cache", "scene_prompt": ["2", 0]},
                },
            }
        }
        api_graph = {
            "output": {
                "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "cache"}},
                "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
            }
        }
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            presets, "preset_directory", return_value=Path(directory)
        ):
            runs.RUN_CONTEXTS.clear()
            presets._RUN_SNAPSHOTS.clear()
            handle = runs.create_run_context("default")
            try:
                presets.save_preset(
                    {
                        "preset_id": "cache",
                        "name": "Cache",
                        "output_node_id": "3",
                        "api_graph": preset_graph,
                        "workflow": {"nodes": []},
                    }
                )
                presets.snapshot_presets_for_run(handle, api_graph, "11")
                before_runs = copy.deepcopy(runs.RUN_CONTEXTS._entries)
                before_snapshots = copy.deepcopy(presets._RUN_SNAPSHOTS)
                prompt = DynamicPrompt(
                    {
                        "1": {
                            "class_type": "ScenePresetReference",
                            "inputs": {"preset_id": "cache", "run_handle": handle},
                        }
                    }
                )
                cache = execution.IsChangedCache("cache-smoke", prompt, execution.CacheSet().outputs)
                with mock.patch.dict(
                    comfy_nodes.NODE_CLASS_MAPPINGS,
                    {"ScenePresetReference": presets.ScenePresetReference},
                    clear=False,
                ):
                    first = asyncio.run(cache.get("1"))
                    second = asyncio.run(cache.get("1"))
                self.assertEqual(first, second)
                self.assertEqual(runs.RUN_CONTEXTS._entries, before_runs)
                self.assertEqual(presets._RUN_SNAPSHOTS, before_snapshots)
            finally:
                runs.release_run_context(handle, "default")
                presets.release_scene_preset_snapshot(handle, "default")


if __name__ == "__main__":
    unittest.main()
