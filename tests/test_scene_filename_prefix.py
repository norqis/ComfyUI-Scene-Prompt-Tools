import importlib
import importlib.util
import json
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from PIL import Image

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"


def _install_comfy_stubs(output_dir):
    install_comfy_execution_stub()
    comfy = types.ModuleType("comfy")
    model_management = types.ModuleType("comfy.model_management")
    model_management.intermediate_device = lambda: "cpu"
    model_management.intermediate_dtype = lambda: torch.float32
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    comfy.model_management = model_management

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: str(output_dir)
    folder_paths.get_user_directory = lambda: str(output_dir / "user")
    folder_paths.get_public_user_directory = lambda user_id: str(output_dir / "user" / user_id)

    sys.modules["comfy"] = comfy
    sys.modules["comfy.model_management"] = model_management
    sys.modules["comfy.cli_args"] = cli_args
    sys.modules["folder_paths"] = folder_paths


def _load_nodes(output_dir):
    _install_comfy_stubs(output_dir)
    package_name = "scene_prompt_prefix_test"
    for module_name in list(sys.modules):
        if module_name == package_name or module_name.startswith(f"{package_name}."):
            del sys.modules[module_name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return importlib.import_module(f"{package_name}.nodes")


def _load_node_package(output_dir):
    _install_comfy_stubs(output_dir)
    package_name = "scene_node_description_test"
    for module_name in list(sys.modules):
        if module_name == package_name or module_name.startswith(f"{package_name}."):
            del sys.modules[module_name]

    package_spec = importlib.util.spec_from_file_location(
        package_name,
        ROOT / "__init__.py",
        submodule_search_locations=[str(ROOT)],
    )
    package = importlib.util.module_from_spec(package_spec)
    sys.modules[package_name] = package

    internal_package = types.ModuleType(f"{package_name}.scene_prompt_tools")
    internal_package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[internal_package.__name__] = internal_package

    routes = types.ModuleType(f"{package_name}.scene_prompt_tools.routes")
    routes.define_routes = lambda: None
    sys.modules[routes.__name__] = routes

    for module_name in ("nodes", "prompt", "presets"):
        module = importlib.import_module(f"{package_name}.scene_prompt_tools.{module_name}")
        setattr(internal_package, module_name, module)
    for name in (
        "SceneEmptyLatent",
        "SceneMatrix",
        "ScenePath",
        "ScenePromptCounter",
        "ScenePromptExpand",
        "ScenePromptMerge",
        "ScenePromptQueue",
        "SceneSaveImage",
    ):
        setattr(internal_package, name, getattr(internal_package.nodes, name))
    internal_package.ScenePrompt = internal_package.prompt.ScenePrompt
    for name in ("ScenePresetInput", "ScenePresetOutput", "ScenePresetReference"):
        setattr(internal_package, name, getattr(internal_package.presets, name))
    internal_package.define_routes = routes.define_routes

    package_spec.loader.exec_module(package)
    return package


def _scene_prompt(nodes, count=2):
    return nodes.multiply_count(
        nodes.transform(None, lambda row, _item: {**row, "positive_parts": ["test"]}),
        count,
    )


def _matrix_line(name, **overrides):
    line = {
        "type": "SCENE_MATRIX_LINE",
        "version": 1,
        "row_id": f"row-{name}",
        "node_id": "",
        "category": "",
        "name": name,
        "path_label": name,
        "enabled": True,
        "positive_base": "",
        "positive_json": '{"version":1,"categories":{}}',
        "negative_base": "",
        "negative_json": '{"version":1,"categories":{}}',
        "category_order": "",
        "positive_parts": [],
        "negative_parts": [],
        "display_labels": [],
        "display_label_groups": [],
    }
    line.update(overrides)
    return line


class SceneFilenamePrefixTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.nodes = _load_nodes(Path(self.temp_dir.name))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_expand_prefix_is_visible_and_kept_in_save_info(self):
        input_types = self.nodes.ScenePromptExpand.INPUT_TYPES()
        self.assertEqual(input_types["optional"]["prefix"][0], "STRING")
        self.assertEqual(input_types["optional"]["prefix"][1]["default"], "")

        result = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            prefix="00100_",
            scene_prompt=_scene_prompt(self.nodes),
        )
        self.assertEqual(result[2]["filename_prefix"], "00100_")
        self.assertEqual(result[2]["file_index"], 1)

    def test_empty_prefix_remains_empty(self):
        normalized = self.nodes._normalize_scene_save_info({"file_index": 1})
        self.assertEqual(normalized["filename_prefix"], "")
        result = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            scene_prompt=_scene_prompt(self.nodes),
        )
        self.assertEqual(result[2]["filename_prefix"], "")

    def test_prefix_sanitizer_cannot_create_directories(self):
        self.assertEqual(
            self.nodes._safe_filename_prefix("001/00\\bad:name\x01\x7f"),
            "001_00_bad_name_",
        )
        self.assertEqual(self.nodes._safe_filename_prefix("NUL."), "_NUL.")
        self.assertEqual(self.nodes._safe_filename_prefix("COM¹."), "_COM¹.")

    def test_is_changed_includes_prefix(self):
        scene_prompt = _scene_prompt(self.nodes)
        first = self.nodes.ScenePromptExpand.IS_CHANGED(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            prefix="00100_",
            scene_prompt=scene_prompt,
        )
        second = self.nodes.ScenePromptExpand.IS_CHANGED(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            prefix="00200_",
            scene_prompt=scene_prompt,
        )
        self.assertNotEqual(first, second)

    def test_matrix_state_accepts_only_version_one_sets_schema(self):
        current = json.dumps({
            "version": 1,
            "sets": [_matrix_line("A")],
        })
        self.assertEqual(self.nodes._parse_matrix_data(current)["sets"][0]["name"], "A")
        self.assertEqual(self.nodes._parse_matrix_data(""), {"version": 1, "sets": []})
        for invalid in ('[{"name":"A"}]', '{"sets":[]}', '{"version":2,"sets":[]}', '{broken'):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    self.nodes._parse_matrix_data(invalid)
        with self.assertRaises(ValueError):
            self.nodes._parse_matrix_sets('{"version":1,"sets":[{"name":"A"}]}')
        invalid_parts = json.dumps({
            "version": 1,
            "sets": [_matrix_line("A", positive_parts=[1])],
        })
        with self.assertRaises(ValueError):
            self.nodes._parse_matrix_sets(invalid_parts)

    def test_matrix_backend_requires_the_complete_current_frontend_schema(self):
        required_fields = (
            "type",
            "version",
            "row_id",
            "node_id",
            "category",
            "name",
            "path_label",
            "enabled",
            "positive_base",
            "positive_json",
            "negative_base",
            "negative_json",
            "category_order",
            "positive_parts",
            "negative_parts",
            "display_labels",
            "display_label_groups",
        )
        for field in required_fields:
            invalid = _matrix_line("A")
            invalid.pop(field)
            with self.subTest(missing=field):
                with self.assertRaises(ValueError):
                    self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))

        for retired_field in ("label", "id", "positive", "negative"):
            invalid = _matrix_line("A", **{retired_field: "retired"})
            with self.subTest(retired=retired_field):
                with self.assertRaises(ValueError):
                    self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))

        invalid = _matrix_line("A", enabled="true")
        with self.assertRaises(ValueError):
            self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))

    def test_matrix_expands_current_schema_prompt_parts_for_both_sides(self):
        matrix_json = json.dumps({
            "version": 1,
            "sets": [_matrix_line("夜", positive_base="night, forest", negative_base="daylight")],
        })
        plan = self.nodes.SceneMatrix().build(matrix_json)[0]
        row = plan["rows"][0]["row"]
        self.assertEqual(row["positive_parts"], ["night", "forest"])
        self.assertEqual(row["negative_parts"], ["daylight"])

    def test_save_uses_prefix_and_records_it_in_png_metadata(self):
        saver = self.nodes.SceneSaveImage()
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        info = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            prefix="00100_",
            scene_prompt=_scene_prompt(self.nodes),
        )[2]
        result = saver.save_images([image, image], "", scene_info=info)
        saved = [Path(value) for value in result["result"][1].splitlines()]
        self.assertEqual([path.name for path in saved], ["00100_00001.png", "00100_00002.png"])
        with Image.open(saved[0]) as saved_image:
            metadata = json.loads(saved_image.text["scene_info"])
        self.assertEqual(metadata["filename_prefix"], "00100_")
        self.assertNotIn("absolute_path", metadata)
        self.assertNotIn(str(self.temp_dir.name), saved_image.text["scene_info"])

    def test_save_without_prefix_uses_numbered_filename(self):
        saver = self.nodes.SceneSaveImage()
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        result = saver.save_images([image], "", scene_info={"use_run_dir": False, "file_index": 1})
        self.assertEqual(Path(result["result"][1]).name, "00001.png")

    def test_save_metadata_keeps_large_effective_counts(self):
        plan = _scene_prompt(self.nodes, 10_000)
        plan = self.nodes.multiply_count(plan, 10_000)
        info = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            timestamp_dir=False,
            scene_prompt=plan,
        )[2]
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        result = self.nodes.SceneSaveImage().save_images([image], "", scene_info=info)
        with Image.open(Path(result["result"][1])) as saved_image:
            metadata = json.loads(saved_image.text["scene_info"])
        self.assertEqual(metadata["repeat_count"], 100_000_000)
        self.assertEqual(metadata["total_count"], 100_000_000)

    def test_independent_expand_unique_ids_keep_separate_immutable_plans(self):
        runs = sys.modules[f"{self.nodes.__package__}.runs"]
        runs.RUN_CONTEXTS.clear()
        handle = runs.create_run_context("alice", {"by_key": {}, "by_id": {}})
        first = _scene_prompt(self.nodes)
        second = self.nodes.transform(first, lambda row, _item: {**row, "positive_parts": ["second"]})
        self.assertEqual(self.nodes._scene_run_plan(handle, first, "expand-1")["rows"][0]["row"]["positive_parts"], ["test"])
        self.assertEqual(self.nodes._scene_run_plan(handle, second, "expand-2")["rows"][0]["row"]["positive_parts"], ["second"])
        self.assertEqual(self.nodes._scene_run_plan(handle, second, "expand-1")["rows"][0]["row"]["positive_parts"], ["test"])
        self.assertEqual(self.nodes._scene_run_plan(handle, first, "expand-2")["rows"][0]["row"]["positive_parts"], ["second"])
        runs.release_run_context(handle, "alice")
        with self.assertRaises(runs.SceneRunError):
            self.nodes._scene_run_plan(handle, first)

    def test_is_changed_does_not_register_a_seed_plan_before_expand(self):
        runs = sys.modules[f"{self.nodes.__package__}.runs"]
        runs.RUN_CONTEXTS.clear()
        handle = runs.create_run_context("alice", {"by_key": {}, "by_id": {}})
        unique_id = "expand-1"
        try:
            self.nodes.ScenePromptExpand.IS_CHANGED(
                current_index=0,
                scene_prompt=None,
                run_handle=handle,
                unique_id=unique_id,
            )
            self.assertEqual(runs.require_run_context(handle)["plans"], {})

            plan = self.nodes.SceneEmptyLatent().apply_latent(
                _scene_prompt(self.nodes, 2),
                width=896,
                height=1344,
                batch_size=1,
            )[0]
            expander = self.nodes.ScenePromptExpand()
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
            self.assertEqual(first[2]["file_index"], 1)
            self.assertEqual(second[2]["file_index"], 2)
            self.assertEqual(runs.require_run_context(handle)["plans"][unique_id], plan)
        finally:
            runs.release_run_context(handle, "alice")

    def test_concurrent_saves_reserve_distinct_filenames_and_keep_metadata(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        scene_info = {"use_run_dir": False, "file_index": 1, "filename_prefix": "parallel_", "positive": "test"}

        def save_one(_index):
            return self.nodes.SceneSaveImage().save_images([image], "", scene_info=scene_info)["result"][1]

        with ThreadPoolExecutor(max_workers=8) as pool:
            paths = [Path(value) for value in pool.map(save_one, range(16))]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertTrue(all(path.exists() for path in paths))
        file_indexes = []
        for path in paths:
            with Image.open(path) as saved:
                scene_metadata = json.loads(saved.text["scene_info"])
            self.assertEqual(scene_metadata["positive"], "test")
            self.assertEqual(scene_metadata["file_index"], int(path.stem.rsplit("_", 1)[1]))
            file_indexes.append(scene_metadata["file_index"])
        self.assertEqual(len(file_indexes), len(set(file_indexes)))

    def test_failed_batch_leaves_no_placeholder_temp_or_partial_png(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        original_save = Image.Image.save
        calls = 0

        def fail_second_save(instance, fp, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("second image failed")
            return original_save(instance, fp, *args, **kwargs)

        with mock.patch.object(Image.Image, "save", fail_second_save):
            with self.assertRaisesRegex(OSError, "second image failed"):
                self.nodes.SceneSaveImage().save_images(
                    [image, image],
                    "atomic",
                    scene_info={"use_run_dir": False, "file_index": 1},
                )
        target = Path(self.temp_dir.name) / "atomic"
        self.assertEqual(list(target.glob("*.png")), [])
        self.assertEqual(list(target.glob(".scene-save-*.png")), [])
        self.assertEqual(list(target.glob("*.scene-save-reservation")), [])

    def test_save_does_not_publish_png_until_it_is_verified(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        save_started = threading.Event()
        allow_save = threading.Event()
        original_save = Image.Image.save

        def block_save(instance, fp, *args, **kwargs):
            save_started.set()
            self.assertTrue(allow_save.wait(timeout=5))
            return original_save(instance, fp, *args, **kwargs)

        with mock.patch.object(Image.Image, "save", block_save):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    self.nodes.SceneSaveImage().save_images,
                    [image],
                    "incomplete",
                    scene_info={"use_run_dir": False, "file_index": 1},
                )
                self.assertTrue(save_started.wait(timeout=5))
                target = Path(self.temp_dir.name) / "incomplete"
                self.assertEqual(list(target.glob("*.png")), [])
                self.assertEqual(len(list(target.glob("*.scene-save-reservation"))), 1)
                allow_save.set()
                result = future.result(timeout=5)

        self.assertEqual(Path(result["result"][1]).name, "00001.png")
        self.assertEqual(len(list(target.glob("*.png"))), 1)
        self.assertEqual(list(target.glob("*.scene-save-reservation")), [])

    def test_reservation_collision_uses_next_filename_without_png_placeholder(self):
        target = Path(self.temp_dir.name) / "collision"
        target.mkdir()
        (target / "00001.png.scene-save-reservation").touch()
        image = torch.zeros((16, 16, 3), dtype=torch.float32)

        result = self.nodes.SceneSaveImage().save_images(
            [image], "collision", scene_info={"use_run_dir": False, "file_index": 1}
        )

        self.assertEqual(Path(result["result"][1]).name, "00002.png")
        self.assertFalse((target / "00001.png").exists())

    def test_competing_final_png_is_not_overwritten_after_reservation(self):
        target = Path(self.temp_dir.name) / "competing"
        target.mkdir()
        output_path = target / "00001.png"
        original_save = Image.Image.save

        def create_competing_png(instance, fp, *args, **kwargs):
            original_save(instance, fp, *args, **kwargs)
            original_save(Image.new("RGB", (1, 1), "red"), output_path, format="PNG")

        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        with mock.patch.object(Image.Image, "save", create_competing_png):
            with self.assertRaises(FileExistsError):
                self.nodes.SceneSaveImage().save_images(
                    [image], "competing", scene_info={"use_run_dir": False, "file_index": 1}
                )

        with Image.open(output_path) as existing:
            self.assertEqual(existing.getpixel((0, 0)), (255, 0, 0))
        self.assertEqual(list(target.glob("*.scene-save-reservation")), [])

    def test_save_metadata_mode_choices_are_ordered_and_default_to_full_workflow(self):
        metadata_mode = self.nodes.SceneSaveImage.INPUT_TYPES()["required"]["metadata_mode"]
        self.assertEqual(
            metadata_mode[0],
            (
                "ワークフロー全体",
                "プロンプトのみ",
                "生成経路ノードのみ",
            ),
        )
        self.assertEqual(metadata_mode[1]["default"], "ワークフロー全体")

    def test_save_metadata_modes_write_expected_png_metadata_without_mutating_inputs(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        prompt = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "2": {"class_type": "KSampler", "inputs": {"model": ["1", 0]}},
            "3": {"class_type": "KSampler", "inputs": {"model": ["1", 0]}},
            "4": {"class_type": "SceneSaveImage", "inputs": {"images": ["2", 0]}},
            "5": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        extra_pnginfo = {
            "prompt": {"reserved": "must not override the submitted prompt"},
            "workflow": {"nodes": [{"id": "4", "pos": [200, 100]}]},
            "custom": {"keep": ["this", "value"]},
        }
        original_prompt = json.loads(json.dumps(prompt))
        original_extra = json.loads(json.dumps(extra_pnginfo))
        saver = self.nodes.SceneSaveImage()

        saved = {}
        for file_index, mode in enumerate(self.nodes.SAVE_METADATA_CHOICES, start=1):
            result = saver.save_images(
                [image],
                "",
                metadata_mode=mode,
                scene_info={
                    "use_run_dir": False,
                    "file_index": file_index,
                    "positive": "positive text",
                    "negative": "negative text",
                    "seed": 42,
                },
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
                unique_id=4,
            )
            with Image.open(Path(result["result"][1])) as png:
                saved[mode] = dict(png.text)

        full = saved["ワークフロー全体"]
        self.assertEqual(json.loads(full["prompt"]), prompt)
        self.assertEqual(json.loads(full["workflow"]), extra_pnginfo["workflow"])
        self.assertEqual(json.loads(full["custom"]), extra_pnginfo["custom"])

        prompt_only = saved["プロンプトのみ"]
        self.assertNotIn("prompt", prompt_only)
        self.assertNotIn("workflow", prompt_only)
        self.assertEqual(json.loads(prompt_only["custom"]), extra_pnginfo["custom"])

        execution_path = saved["生成経路ノードのみ"]
        self.assertNotIn("workflow", execution_path)
        self.assertEqual(set(json.loads(execution_path["prompt"])), {"1", "2", "4"})
        self.assertEqual(json.loads(execution_path["custom"]), extra_pnginfo["custom"])

        for metadata in saved.values():
            self.assertEqual(json.loads(metadata["scene_info"])["positive"], "positive text")
            self.assertEqual(metadata["scene_positive"], "positive text")
            self.assertEqual(metadata["scene_negative"], "negative text")
            self.assertEqual(metadata["scene_seed"], "42")
        self.assertEqual(prompt, original_prompt)
        self.assertEqual(extra_pnginfo, original_extra)

    def test_non_full_metadata_excludes_only_lowercase_reserved_extra_keys(self):
        prompt = {"save": {"class_type": "SceneSaveImage", "inputs": {}}}
        extra_pnginfo = {
            "prompt": {"reserved": True},
            "workflow": {"nodes": []},
            "Prompt": {"keep": True},
            "Workflow": {"keep": True},
            "custom": {"keep": True},
        }
        for mode in (self.nodes.SAVE_METADATA_PROMPT_ONLY, self.nodes.SAVE_METADATA_EXECUTION_PATH):
            with self.subTest(mode=mode):
                saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
                    prompt, extra_pnginfo, "save", mode
                )
                self.assertNotIn("prompt", saved_extra)
                self.assertNotIn("workflow", saved_extra)
                self.assertEqual(saved_extra["Prompt"], {"keep": True})
                self.assertEqual(saved_extra["Workflow"], {"keep": True})
                self.assertEqual(saved_extra["custom"], {"keep": True})
                if mode == self.nodes.SAVE_METADATA_PROMPT_ONLY:
                    self.assertIsNone(saved_prompt)
                else:
                    self.assertEqual(saved_prompt, prompt)

    def test_full_metadata_reuses_inputs_without_mutating_them(self):
        prompt = {"save": {"class_type": "SceneSaveImage", "inputs": {}}}
        extra_pnginfo = {"workflow": {"nodes": []}, "custom": {"value": 1}}
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt, extra_pnginfo, "save", self.nodes.SAVE_METADATA_WORKFLOW
        )
        self.assertIs(saved_prompt, prompt)
        self.assertIs(saved_extra, extra_pnginfo)

    def test_generation_path_metadata_is_specific_to_each_save_node(self):
        prompt = {
            "shared": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "left": {"class_type": "KSampler", "inputs": {"model": ["shared", 0]}},
            "right": {"class_type": "KSampler", "inputs": {"model": ["shared", 0]}},
            "save_left": {"class_type": "SceneSaveImage", "inputs": {"images": ["left", 0]}},
            "save_right": {"class_type": "SceneSaveImage", "inputs": {"images": ["right", 0]}},
        }
        self.assertEqual(set(self.nodes._slice_prompt_for_output(prompt, "save_left")), {"shared", "left", "save_left"})
        self.assertEqual(set(self.nodes._slice_prompt_for_output(prompt, "save_right")), {"shared", "right", "save_right"})

    def test_generation_path_metadata_keeps_each_internal_link_source(self):
        prompt = {
            "shared": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "left": {"class_type": "KSampler", "inputs": {"model": ["shared", 0]}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["left", 0]}},
            "other": {"class_type": "KSampler", "inputs": {"model": ["shared", 0]}},
        }
        saved = self.nodes._slice_prompt_for_output(prompt, "save")
        self.assertEqual(set(saved), {"shared", "left", "save"})
        for node in saved.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2:
                    self.assertIn(str(value[0]), saved)

    def test_generation_path_metadata_rejects_unknown_target_and_invalid_links(self):
        prompt = {"save": {"class_type": "SceneSaveImage", "inputs": {"images": ["missing", 0]}}}
        with self.assertRaisesRegex(ValueError, "保存対象のノードID"):
            self.nodes._slice_prompt_for_output(prompt, "unknown")
        with self.assertRaisesRegex(ValueError, "存在しないノード missing"):
            self.nodes._slice_prompt_for_output(prompt, "save")
        prompt["save"]["inputs"]["images"] = ["other", -1]
        with self.assertRaisesRegex(ValueError, "接続先が不正"):
            self.nodes._slice_prompt_for_output(prompt, "save")

    def test_disable_metadata_skips_all_scene_save_metadata(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        original_value = self.nodes.args.disable_metadata
        self.nodes.args.disable_metadata = True
        try:
            result = self.nodes.SceneSaveImage().save_images(
                [image],
                "",
                metadata_mode="生成経路ノードのみ",
                scene_info={"use_run_dir": False, "file_index": 1, "positive": "kept out"},
                prompt={"save": {"class_type": "SceneSaveImage", "inputs": {}}},
                extra_pnginfo={"workflow": {"nodes": []}},
                unique_id="save",
            )
        finally:
            self.nodes.args.disable_metadata = original_value
        with Image.open(Path(result["result"][1])) as png:
            self.assertEqual(dict(png.text), {})

    def test_all_registered_scene_nodes_have_japanese_descriptions(self):
        package = _load_node_package(Path(self.temp_dir.name))

        expected_node_names = {
            "ScenePrompt",
            "SceneMatrix",
            "ScenePath",
            "ScenePromptMerge",
            "ScenePromptCounter",
            "ScenePromptQueue",
            "SceneEmptyLatent",
            "ScenePromptExpand",
            "SceneSaveImage",
            "ScenePresetInput",
            "ScenePresetOutput",
            "ScenePresetReference",
        }
        self.assertSetEqual(set(package.NODE_CLASS_MAPPINGS), expected_node_names)
        self.assertEqual(
            package.NODE_DISPLAY_NAME_MAPPINGS,
            {
                "ScenePrompt": "Scene Prompt",
                "SceneMatrix": "Scene Matrix",
                "ScenePath": "Scene Path",
                "ScenePromptMerge": "Scene Prompt Merge",
                "ScenePromptCounter": "Scene Prompt Count",
                "ScenePromptQueue": "Scene Prompt Queue",
                "SceneEmptyLatent": "Scene Empty Latent",
                "ScenePromptExpand": "Scene Prompt Expand",
                "SceneSaveImage": "Scene Save Image",
                "ScenePresetInput": "Scene Preset Input",
                "ScenePresetOutput": "Scene Preset Output",
                "ScenePresetReference": "Scene Preset Reference",
            },
        )
        for node_name, node_class in package.NODE_CLASS_MAPPINGS.items():
            with self.subTest(node=node_name):
                description = getattr(node_class, "DESCRIPTION", "")
                self.assertIsInstance(description, str)
                self.assertTrue(description.strip())
                self.assertRegex(description, r"[\u3040-\u30ff\u3400-\u9fff]")


if __name__ == "__main__":
    unittest.main()
