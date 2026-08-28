"""Load the package with real ComfyUI modules, not local test doubles."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import unittest
from pathlib import Path


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
        self.assertIn("/scene_presets/resolve", paths)


if __name__ == "__main__":
    unittest.main()
