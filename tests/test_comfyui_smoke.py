"""Load the package with real ComfyUI modules, not local test doubles."""

from __future__ import annotations

import asyncio
import copy
import gc
import importlib.util
import inspect
import json
import os
import sys
import tempfile
import unittest
import weakref
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def _switch_prompt_inputs(label, scene_prompt=None):
    inputs = {"prompt_name": label, "positive_base": label, "negative_base": "",
              "positive_json": '{"version":1,"categories":{}}', "negative_json": '{"version":1,"categories":{}}',
              "category_order": "", "seed": 0, "randomize": False}
    if scene_prompt is not None:
        inputs["scene_prompt"] = scene_prompt
    return inputs


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
        cls.addClassCleanup(cls.loop.close)
        if "asset_manager" in inspect.signature(PromptServer).parameters:
            from app.assets.manager import default_asset_manager

            args.enable_assets = False
            asset_manager = default_asset_manager()
            cls.addClassCleanup(asset_manager.shutdown)
            PromptServer(cls.loop, asset_manager)
        else:
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

    def test_registers_current_nodes_and_web_directory(self):
        input_node = self.package.NODE_CLASS_MAPPINGS["ScenePromptRandomRoute"]
        output_node = self.package.NODE_CLASS_MAPPINGS["ScenePromptRandomRouteOutput"]
        self.assertEqual(self.package.NODE_DISPLAY_NAME_MAPPINGS["ScenePromptRandomRoute"], "Scene Prompt Random Route Input")
        self.assertEqual(self.package.NODE_DISPLAY_NAME_MAPPINGS["ScenePromptRandomRouteOutput"], "Scene Prompt Random Route Output")
        self.assertTrue(input_node.INPUT_TYPES()["optional"]["preserve_join"][1]["default"])
        self.assertEqual(output_node.INPUT_TYPES()["required"], {})
        self.assertEqual(len(output_node.INPUT_TYPES()["optional"]), 10)
        self.assertIn("ScenePrompter", self.package.NODE_CLASS_MAPPINGS)
        self.assertIn("ScenePromptDelete", self.package.NODE_CLASS_MAPPINGS)
        self.assertIn("ScenePromptToText", self.package.NODE_CLASS_MAPPINGS)
        self.assertIn("ScenePromptCallback", self.package.NODE_CLASS_MAPPINGS)
        self.assertIn("ScenePromptCallbackDesktop", self.package.NODE_CLASS_MAPPINGS)
        self.assertIn("ScenePromptCallbackDiscord", self.package.NODE_CLASS_MAPPINGS)
        self.assertIn("ScenePromptCallbackRequest", self.package.NODE_CLASS_MAPPINGS)
        self.assertEqual(self.package.NODE_DISPLAY_NAME_MAPPINGS["ScenePrompter"], "Scene Prompt")
        self.assertEqual(self.package.NODE_DISPLAY_NAME_MAPPINGS["ScenePromptCallback"], "Scene Prompt Callback")
        self.assertEqual(self.package.NODE_CLASS_MAPPINGS["SceneSaveImage"].CATEGORY, "Scene/output")
        self.assertEqual(self.package.WEB_DIRECTORY, "./web")
        self.assertTrue((ROOT / self.package.WEB_DIRECTORY).is_dir())

    def test_gpu_handoff_uses_real_executor_caches_and_weak_lifetime_registration(self):
        import execution
        import comfy.model_management as management
        from comfy_execution.graph import DynamicPrompt
        module = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.gpu_handoff"]
        server = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.routes"].PromptServer.instance
        coordinator = module.get_coordinator(server)
        self.assertTrue(execution.PromptQueue._scene_gpu_hooks)
        class CachedObject:
            pass
        for mode in (execution.CacheType.CLASSIC, execution.CacheType.LRU, execution.CacheType.RAM_PRESSURE):
            with self.subTest(mode=mode):
                executor = execution.PromptExecutor(server, cache_type=mode, cache_args={"lru": 2, "ram": 0, "ram_inactive": 0})
                executor_ref = weakref.ref(executor)
                asyncio.run(executor.caches.objects.set_prompt(DynamicPrompt({"object": {
                    "class_type": "SceneSaveImage", "inputs": {}}}), ["object"], None))
                cached = CachedObject()
                cached_ref = weakref.ref(cached)
                executor.caches.objects.set_local("object", cached)
                del cached
                self.assertIsNotNone(cached_ref())
                future = self.loop.create_future()
                coordinator.controls.append(future)
                with mock.patch.object(management, "unload_all_models") as unload, mock.patch.object(management, "soft_empty_cache") as empty:
                    coordinator.service_controls()
                self.loop.run_until_complete(asyncio.sleep(0))
                self.assertIsNone(future.result())
                unload.assert_called_once()
                empty.assert_called_once()
                self.assertIsNone(cached_ref())
                del executor
                gc.collect()
                self.assertIsNone(executor_ref())
        self.assertFalse(coordinator.executors)

    def test_real_object_caches_reuse_save_owner_and_release_unused_fallback(self):
        import execution
        from comfy_execution.graph import DynamicPrompt

        nodes = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.nodes"]
        for mode in (execution.CacheType.CLASSIC, execution.CacheType.LRU, execution.CacheType.RAM_PRESSURE):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, \
                    mock.patch.object(nodes, "_resolve_run_dir", side_effect=(["first"], ["changed"])) as resolve:
                objects = execution.CacheSet(mode).objects
                first_prompt = {"save": {"class_type": "SceneSaveImage", "inputs": {"path": "first"}}}
                asyncio.run(objects.set_prompt(DynamicPrompt(first_prompt), ["save"], None))
                owner = nodes.SceneSaveImage()
                original_parts = owner._run_parts(directory, {}, first_prompt)
                reference = weakref.ref(owner)
                objects.set_local("save", owner)
                del owner

                asyncio.run(objects.set_prompt(DynamicPrompt(copy.deepcopy(first_prompt)), ["save"], None))
                objects.clean_unused()
                reused = objects.get_local("save")
                self.assertIs(reused, reference())
                self.assertIs(reused._run_parts(directory, {}, first_prompt), original_parts)

                changed_prompt = copy.deepcopy(first_prompt)
                changed_prompt["save"]["inputs"]["path"] = "changed"
                asyncio.run(objects.set_prompt(DynamicPrompt(changed_prompt), ["save"], None))
                objects.clean_unused()
                self.assertIs(objects.get_local("save"), reused)
                self.assertEqual(reused._run_parts(directory, {}, changed_prompt), ["changed"])
                self.assertEqual(resolve.call_count, 2)
                del reused

                asyncio.run(objects.set_prompt(DynamicPrompt({}), [], None))
                objects.clean_unused()
                gc.collect()
                self.assertIsNone(reference(), "ComfyUI's unused object cleanup must release the owner")

    def test_callback_node_contract_uses_real_comfyui_type_registration(self):
        callback = self.package.NODE_CLASS_MAPPINGS["ScenePromptCallback"].INPUT_TYPES()
        desktop = self.package.NODE_CLASS_MAPPINGS["ScenePromptCallbackDesktop"].INPUT_TYPES()
        discord = self.package.NODE_CLASS_MAPPINGS["ScenePromptCallbackDiscord"].INPUT_TYPES()
        request = self.package.NODE_CLASS_MAPPINGS["ScenePromptCallbackRequest"].INPUT_TYPES()
        expand = self.package.NODE_CLASS_MAPPINGS["ScenePrompterExpand"].INPUT_TYPES()

        self.assertEqual(callback["optional"]["callback"][0], "SCENE_CALLBACK")

        self.assertIn("frequency", callback["required"])
        self.assertIn("timeout_seconds", callback["required"])
        self.assertIn("failure_mode", callback["required"])
        self.assertEqual(callback["optional"]["scene_prompt"][0], "SCENE_PROMPT")
        self.assertEqual(desktop["required"]["title"][0], "STRING")
        self.assertEqual(desktop["required"]["text"][0], "STRING")
        self.assertEqual(
            self.package.NODE_CLASS_MAPPINGS["ScenePromptCallbackDesktop"].RETURN_TYPES,
            ("SCENE_CALLBACK",),
        )
        self.assertEqual(discord["required"]["webhook_url"][0], "STRING")
        self.assertEqual(discord["required"]["text"][0], "STRING")
        self.assertIn("username", discord["optional"])
        self.assertEqual(request["required"]["method"][0], ["GET", "POST"])
        self.assertEqual(request["required"]["url"][0], "STRING")
        self.assertEqual(request["required"]["text"][0], "STRING")
        self.assertEqual(request["required"]["body_type"][0], ["text", "json"])
        self.assertEqual(request["required"]["headers_json"][0], "STRING")
        for name in ("callback_first", "callback_each", "callback_last"):
            self.assertEqual(expand["optional"][name][0], "SCENE_CALLBACK")
        self.assertNotIn("callback_timeout_seconds", expand["optional"])
        self.assertIn("callback_failure_mode", expand["optional"])

    def test_scene_model_route_uses_real_graph_builder_links(self):
        apply_model = self.package.NODE_CLASS_MAPPINGS["SceneApplyModel"]()
        apply_lora = self.package.NODE_CLASS_MAPPINGS["SceneApplyLora"]()
        expand = self.package.NODE_CLASS_MAPPINGS["ScenePrompterExpand"]()
        plan = apply_model.apply_model(
            ["checkpoint", 0], ["checkpoint", 1], ["checkpoint", 2],
        )[0]
        plan = apply_lora.apply_lora("style/example.safetensors", 0.8, 0.7, plan)[0]
        plan = apply_lora.apply_lora("style/anima.safetensors", 0.4, 0.3, plan, model_mode="Anima")[0]
        result = expand.expand(current_index=0, timestamp_dir=False, scene_prompt=plan)
        self.assertIsInstance(result, dict)
        self.assertEqual(len(result["expand"]), 1)
        lora_node = next(iter(result["expand"].values()))
        self.assertEqual(lora_node["class_type"], "LoraLoader")
        self.assertEqual(lora_node["inputs"]["model"], ["checkpoint", 0])
        self.assertEqual(lora_node["inputs"]["lora_name"], "style/example.safetensors")
        self.assertEqual(result["result"][7], ["checkpoint", 2])
        anima = expand.expand(current_index=0, timestamp_dir=False, scene_prompt=plan, model_mode="Anima")
        self.assertEqual([node["inputs"]["lora_name"] for node in anima["expand"].values()], ["style/anima.safetensors"])
        empty = apply_lora.apply_lora("style/anima.safetensors", model_mode="Anima")[0]
        empty = apply_model.apply_model(["checkpoint", 0], ["checkpoint", 1], ["checkpoint", 2], empty)[0]
        empty_result = expand.expand(timestamp_dir=False, scene_prompt=empty)
        self.assertEqual(empty_result["expand"], {})
        self.assertEqual(empty_result["result"][5:], (["checkpoint", 0], ["checkpoint", 1], ["checkpoint", 2]))

    def test_native_executor_loads_shared_lora_once_and_distinct_same_file_twice(self):
        import execution
        import folder_paths
        import nodes as comfy_nodes
        from server import PromptServer

        import comfy.model_management as management
        self.assertEqual(management.get_torch_device().type, "cpu")
        runs = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.runs"]
        presets = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.presets"]
        loaded = []
        received = []

        class ResourceSource:
            RETURN_TYPES = ("MODEL", "CLIP", "VAE")
            FUNCTION = "produce"

            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {}}

            def produce(self):
                return (), (), "fixture-vae"

        class Loader:
            RETURN_TYPES = ("MODEL", "CLIP")
            FUNCTION = "load"

            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"model": ("MODEL",), "clip": ("CLIP",), "lora_name": ("STRING",),
                                     "strength_model": ("FLOAT",), "strength_clip": ("FLOAT",)}}

            def load(self, model, clip, lora_name, strength_model, strength_clip):
                loaded.append((lora_name, strength_model, strength_clip))
                return (*model, (lora_name, strength_model)), (*clip, (lora_name, strength_clip))

        class ResourceSink:
            RETURN_TYPES = ()
            OUTPUT_NODE = True
            FUNCTION = "receive"

            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"model": ("MODEL",), "clip": ("CLIP",), "positive": ("STRING",), "negative": ("STRING",)}}

            def receive(self, model, clip, positive, negative):
                received.append((model, clip, positive, negative))
                return ()

        original_catalog = folder_paths.get_filename_list
        mappings = {**self.package.NODE_CLASS_MAPPINGS, "SceneFixtureResources": ResourceSource,
                    "SceneFixtureResourceSink": ResourceSink, "LoraLoader": Loader}
        with mock.patch.dict(comfy_nodes.NODE_CLASS_MAPPINGS, mappings), \
             mock.patch.object(folder_paths, "get_filename_list", side_effect=lambda category: ["fixture.safetensors"] if category == "loras" else original_catalog(category)):
            for mode in ("Illustrious", "Anima"):
                for shared in (True, False):
                    with self.subTest(mode=mode, shared=shared):
                        loaded.clear()
                        received.clear()
                        prompt = {
                            "resources": {"class_type": "SceneFixtureResources", "inputs": {}},
                            "model": {"class_type": "SceneApplyModel", "inputs": {
                                "model": ["resources", 0], "clip": ["resources", 1], "vae": ["resources", 2],
                            }},
                            "lora-a": {"class_type": "SceneApplyLora", "inputs": {
                                "scene_prompt": ["model", 0], "lora_name": "fixture.safetensors", "strength_model": 0.8,
                                "strength_clip": 0.7, "model_mode": mode, "positive": "trigger", "negative": "bad",
                            }},
                            "merge": {"class_type": "ScenePrompterMerge", "inputs": {"scene_prompt1": ["left", 0], "scene_prompt2": ["right", 0]}},
                            "expand": {"class_type": "ScenePrompterExpand", "inputs": {
                                "scene_prompt": ["merge", 0], "seed_base": 7, "timestamp_dir": False, "model_mode": mode,
                                "current_index": 0, "run_id": "auto",
                            }},
                            "sink": {"class_type": "SceneFixtureResourceSink", "inputs": {
                                "model": ["expand", 5], "clip": ["expand", 6], "positive": ["expand", 0], "negative": ["expand", 1],
                            }},
                        }
                        if not shared:
                            prompt["lora-b"] = copy.deepcopy(prompt["lora-a"])
                            prompt["lora-b"]["inputs"].update({"strength_model": 0.5, "strength_clip": 0.4})
                        for name in ("left", "right"):
                            source = "lora-b" if name == "right" and not shared else "lora-a"
                            prompt[name] = {"class_type": "ScenePrompter", "inputs": {
                                "scene_prompt": [source, 0], "prompt_name": name, "positive_base": name,
                                "positive_json": '{"version":1,"categories":{}}', "negative_base": "",
                                "negative_json": '{"version":1,"categories":{}}', "category_order": "", "seed": 0, "randomize": False,
                            }}
                        prompt_id = f"scene-lora-convergence-{mode}-{shared}"
                        handle = runs.create_run_context("default")
                        try:
                            for node_id in ("left", "right", "expand"):
                                prompt[node_id]["inputs"]["run_handle"] = handle
                            presets.snapshot_presets_for_run(handle, {"output": prompt}, "expand")
                            self.assertTrue(runs.claim_run_context(handle, "default", prompt_id))
                            valid, error, outputs, node_errors = asyncio.run(execution.validate_prompt(prompt_id, prompt, None))
                            self.assertTrue(valid, (error, node_errors))
                            executor = execution.PromptExecutor(PromptServer.instance, cache_type=execution.CacheType.CLASSIC,
                                                                cache_args={"lru": 0, "ram": 0, "ram_inactive": 0})
                            executor.execute(prompt, prompt_id, {}, outputs)
                            self.assertTrue(executor.success, executor.status_messages)
                        finally:
                            runs.release_run_context(handle, "default")
                            presets.release_scene_preset_snapshot(handle, "default")
                        expected = [("fixture.safetensors", 0.8, 0.7)]
                        if not shared:
                            expected.append(("fixture.safetensors", 0.5, 0.4))
                        self.assertEqual(loaded, expected)
                        self.assertEqual(received, [(tuple((name, strength) for name, strength, _clip in expected),
                                                    tuple((name, strength) for name, _model, strength in expected),
                                                    "left, right, trigger", "bad")])

    def test_uses_established_scene_node_ids_without_aliases(self):
        self.assertNotIn("ScenePrompt", self.package.NODE_CLASS_MAPPINGS)
        self.assertNotIn("ScenePromptExpand", self.package.NODE_CLASS_MAPPINGS)
        self.assertNotIn("ScenePromptQueue", self.package.NODE_CLASS_MAPPINGS)
        self.assertNotIn("ScenePromptMerge", self.package.NODE_CLASS_MAPPINGS)

    def test_preset_switch_native_slot_contract_and_default_payload(self):
        input_type = self.package.NODE_CLASS_MAPPINGS["ScenePresetInput"]
        reference_type = self.package.NODE_CLASS_MAPPINGS["ScenePresetReference"]
        self.assertEqual(input_type.RETURN_TYPES, ("SCENE_PROMPT",) + ("BOOLEAN",) * 10 + ("SCENE_SWITCHES",))
        self.assertEqual(input_type.RETURN_NAMES, ("scene_prompt",) + tuple(f"switch_{index}" for index in range(1, 11)) + ("switches",))
        self.assertEqual(input_type.INPUT_TYPES()["optional"]["switch_names_json"][0], "STRING")
        self.assertEqual(input_type.INPUT_TYPES()["optional"]["switch_values"][0], "SCENE_SWITCHES")
        self.assertEqual(reference_type.INPUT_TYPES()["optional"]["switches"][0], "SCENE_SWITCHES")
        self.assertEqual(reference_type.INPUT_TYPES()["optional"]["switch_settings_json"][0], "STRING")
        defaults = input_type().build()
        self.assertEqual(defaults[1:11], (False,) * 10)
        self.assertEqual(tuple(defaults[11]), (False,) * 10)
        values = (True, False, True, False, False, True, False, True, False, True)
        named = input_type().build(switch_values=values, switch_names_json='["重複", "重複", "", "日本語"]')
        self.assertEqual(named[1:11], values)
        self.assertEqual(tuple(named[11]), values, "display names cannot alter effective runtime values")
        transported = input_type().build(switch_values={"values": list(values)})
        self.assertEqual(transported[1:11], values, "internal literal transport remains valid to ComfyUI's link validator")

    def _execute_native_switch_graph(self, graph, executor=None, allowed_models=()):
        import execution
        import nodes as comfy_nodes
        from comfy_extras.nodes_logic import SwitchNode
        from comfy_extras.nodes_primitive import Boolean
        from server import PromptServer

        presets = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.presets"]
        runs = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.runs"]
        self._switch_received = []
        self._switch_model_calls = []
        owner = self

        class Sink:
            RETURN_TYPES = ()
            FUNCTION = "receive"
            OUTPUT_NODE = True

            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"positive": ("STRING",), "scene_info": ("SCENE_SAVE_INFO",)}}

            def receive(self, positive, scene_info):
                owner._switch_received.append((positive, scene_info["total_count"]))
                return ()

        class NeverLoadModel:
            RETURN_TYPES = ("MODEL", "CLIP", "VAE")
            FUNCTION = "load"

            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {}}

            def load(self):
                owner._switch_model_calls.append("model")
                raise AssertionError("The unselected Scene switch branch must never load models")

        class SelectedModel:
            RETURN_TYPES = ("MODEL", "CLIP", "VAE")
            FUNCTION = "load"

            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"label": ("STRING",)}}

            def load(self, label):
                owner._switch_model_calls.append(label)
                return "fixture-model", "fixture-clip", "fixture-vae"

        mappings = {**self.package.NODE_CLASS_MAPPINGS, "ComfySwitchNode": SwitchNode, "PrimitiveBoolean": Boolean,
                    "NativeSwitchSink": Sink, "NativeSwitchNeverModel": NeverLoadModel, "NativeSwitchSelectedModel": SelectedModel}
        prompt = copy.deepcopy(graph)
        handle = runs.create_run_context("default")
        prompt_id = f"native-switch-{handle}"
        try:
            for node in prompt.values():
                if node["class_type"] in {"ScenePrompter", "SceneMatrix", "ScenePresetReference", "ScenePrompterExpand", "ScenePromptToText"}:
                    node["inputs"]["run_handle"] = handle
            with mock.patch.dict(comfy_nodes.NODE_CLASS_MAPPINGS, mappings):
                prepared = presets.snapshot_presets_for_run(handle, {"output": prompt}, "expand")
                self.assertEqual(self._switch_model_calls, [], "preflight never executes either model branch")
                self.assertTrue(runs.claim_run_context(handle, "default", prompt_id))
                valid, error, outputs, node_errors = asyncio.run(execution.validate_prompt(prompt_id, prompt, None))
                self.assertTrue(valid, (error, node_errors))
                if executor is None:
                    executor = execution.PromptExecutor(PromptServer.instance, cache_type=execution.CacheType.CLASSIC,
                        cache_args={"lru": 0, "ram": 0, "ram_inactive": 0})
                executor.execute(prompt, prompt_id, {}, outputs)
                self.assertTrue(executor.success, executor.status_messages)
            self.assertTrue(set(self._switch_model_calls).issubset(allowed_models), self._switch_model_calls)
            self.assertEqual(len(self._switch_received), 1)
            return prepared, self._switch_received[0], executor
        finally:
            runs.release_run_context(handle, "default")
            presets.release_scene_preset_snapshot(handle, "default")

    def test_standard_switch_native_executor_literal_and_primitive_select_only_one_scene_branch(self):
        prompt_type = self.package.NODE_CLASS_MAPPINGS["ScenePrompter"]
        original_build = prompt_type.build
        visited = []

        def record_build(instance, *args, **kwargs):
            visited.append(kwargs.get("positive_base", args[1] if len(args) > 1 else ""))
            return original_build(instance, *args, **kwargs)

        for primitive in (False, True):
            executor = None
            for selected in (False, True, False):
                with self.subTest(primitive=primitive, selected=selected):
                    graph = {
                        "model_false": {"class_type": "NativeSwitchNeverModel", "inputs": {}},
                        "model_true": {"class_type": "NativeSwitchNeverModel", "inputs": {}},
                        "apply_false": {"class_type": "SceneApplyModel", "inputs": {"model": ["model_false", 0], "clip": ["model_false", 1], "vae": ["model_false", 2]}},
                        "apply_true": {"class_type": "SceneApplyModel", "inputs": {"model": ["model_true", 0], "clip": ["model_true", 1], "vae": ["model_true", 2]}},
                        "false": {"class_type": "ScenePrompter", "inputs": _switch_prompt_inputs("false_branch", ["apply_false", 0])},
                        "true": {"class_type": "ScenePrompter", "inputs": _switch_prompt_inputs("true_branch", ["apply_true", 0])},
                        "false_count": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["false", 0], "count": 2}},
                        "true_count": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["true", 0], "count": 3}},
                        "switch": {"class_type": "ComfySwitchNode", "inputs": {"switch": selected, "on_false": ["false_count", 0], "on_true": ["true_count", 0]}},
                        "count": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["switch", 0], "count": 2}},
                        "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["count", 0], "current_index": 0, "seed_base": 11, "run_id": "auto", "timestamp_dir": False}},
                        "sink": {"class_type": "NativeSwitchSink", "inputs": {"positive": ["expand", 0], "scene_info": ["expand", 2]}},
                    }
                    selected_model = "true" if selected else "false"
                    graph[f"model_{selected_model}"] = {"class_type": "NativeSwitchSelectedModel", "inputs": {"label": selected_model}}
                    if primitive:
                        graph["boolean"] = {"class_type": "PrimitiveBoolean", "inputs": {"value": selected}}
                        graph["switch"]["inputs"]["switch"] = ["boolean", 0]
                    visited.clear()
                    with mock.patch.object(prompt_type, "build", record_build):
                        prepared, received, executor = self._execute_native_switch_graph(graph, executor, (selected_model,))
                    expected = "true_branch" if selected else "false_branch"
                    self.assertEqual(prepared["total_batches"], 6 if selected else 4)
                    self.assertEqual(received, (expected, 6 if selected else 4))
                    self.assertIn(expected, visited)
                    self.assertNotIn("false_branch" if selected else "true_branch", visited,
                        "preflight and native lazy execution must never visit the other Scene branch")

    def test_nested_mapped_switch_native_expansion_duplicate_reference_cache_and_no_inheritance(self):
        presets = sys.modules["scene_prompt_tools_smoke.scene_prompt_tools.presets"]
        leaf = {
            "1": {"class_type": "ScenePresetInput", "inputs": {"switch_names_json": '["入口", "同名", "同名"]'}},
            "2": {"class_type": "ScenePrompter", "inputs": _switch_prompt_inputs("leaf_false", ["1", 0])},
            "3": {"class_type": "ScenePrompter", "inputs": _switch_prompt_inputs("leaf_true", ["1", 0])},
            "4": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["2", 0], "count": 2}},
            "5": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["3", 0], "count": 3}},
            "6": {"class_type": "ComfySwitchNode", "inputs": {"switch": ["1", 3], "on_false": ["4", 0], "on_true": ["5", 0]}},
            "7": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["6", 0]}},
        }
        middle = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "native-switch-leaf", "switches": ["1", 11],
                "switch_settings_json": json.dumps([False, False, 1, False, False, False, False, False, False, False])}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
        }
        outer = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "native-switch-middle", "switches": ["1", 11],
                "switch_settings_json": json.dumps([2, 1, 3, 4, 5, 6, 7, 8, 9, 10])}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
        }
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(presets, "preset_directory", return_value=Path(directory)):
            for preset_id, nodes, output_id in (("native-switch-leaf", leaf, "7"), ("native-switch-middle", middle, "3"), ("native-switch-outer", outer, "3")):
                presets.save_preset({"preset_id": preset_id, "name": preset_id, "output_node_id": output_id,
                    "api_graph": {"output": nodes}, "workflow": {"nodes": []}})
            graph = {
                "1": {"class_type": "ScenePresetInput", "inputs": {"switch_values": {"values": [True, False, False, False, False, False, False, False, False, False]}}},
                "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "native-switch-outer", "switches": ["1", 11], "switch_settings_json": json.dumps([False] * 10)}},
                "3": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "native-switch-outer", "switches": ["1", 11], "switch_settings_json": json.dumps([2, 1, 3, 4, 5, 6, 7, 8, 9, 10])}},
                "4": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["2", 0], "scene_prompt2": ["3", 0]}},
                "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["4", 0], "current_index": 0, "seed_base": 9, "run_id": "auto", "timestamp_dir": False}},
                "sink": {"class_type": "NativeSwitchSink", "inputs": {"positive": ["expand", 0], "scene_info": ["expand", 2]}},
            }
            executor = None
            for settings, expected_rows in (([2, 1, 3, 4, 5, 6, 7, 8, 9, 10], ["leaf_false"] * 2 + ["leaf_true"] * 3),
                                            ([False] * 10, ["leaf_false"] * 4),
                                            ([2, 1, 3, 4, 5, 6, 7, 8, 9, 10], ["leaf_false"] * 2 + ["leaf_true"] * 3)):
                graph["3"]["inputs"]["switch_settings_json"] = json.dumps(settings)
                observed = []
                for index in range(len(expected_rows)):
                    graph["expand"]["inputs"]["current_index"] = index
                    prepared, received, executor = self._execute_native_switch_graph(graph, executor)
                    self.assertEqual(prepared["total_batches"], len(expected_rows))
                    self.assertEqual(received[1], len(expected_rows))
                    observed.append(received[0])
                self.assertEqual(observed, expected_rows, "occurrence vectors and changed settings cannot bleed through a reused native cache")
            disconnected = copy.deepcopy(middle)
            disconnected["2"]["inputs"].pop("switches")
            disconnected["2"]["inputs"]["scene_prompt"] = ["1", 0]
            presets.save_preset({"preset_id": "native-switch-disconnected", "name": "disconnected", "output_node_id": "3",
                "api_graph": {"output": disconnected}, "workflow": {"nodes": []}})
            graph["2"]["inputs"].update(preset_id="native-switch-disconnected", switch_settings_json=json.dumps([True] * 10))
            graph["4"]["inputs"].pop("scene_prompt2")
            graph["expand"]["inputs"]["current_index"] = 0
            prepared, received, _ = self._execute_native_switch_graph(graph, executor)
            self.assertEqual(prepared["total_batches"], 2)
            self.assertEqual(received, ("leaf_false", 2), "a disconnected child bundle has no implicit inheritance")

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
            "workflow": {
                "nodes": [
                    {"id": 1, "type": "EmptyImage", "pos": [10, 20], "outputs": [{"links": [7]}]},
                    {"id": 2, "type": "EmptyImage", "pos": [30, 40], "outputs": [{"links": []}]},
                    {"id": 4, "type": "SceneSaveImage", "pos": [50, 60], "inputs": [{"link": 7}]},
                ],
                "links": [[7, 1, 0, 4, 0, "IMAGE"]],
                "groups": [],
            },
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
        self.assertEqual(set(execution_path), {"1", "4"})
        execution_workflow = json.loads(saved[nodes.SAVE_METADATA_EXECUTION_PATH]["workflow"])
        self.assertEqual({str(node["id"]) for node in execution_workflow["nodes"]}, {"1", "4"})
        self.assertEqual(execution_workflow["links"], [[7, 1, 0, 4, 0, "IMAGE"]])
        self.assertEqual(next(node for node in execution_workflow["nodes"] if node["id"] == 1)["pos"], [10, 20])
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
                    "class_type": "ScenePrompter",
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
                "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
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
