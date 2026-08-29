import importlib
import importlib.util
import json
import sys
import tempfile
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

    def test_scene_run_plan_cache_is_partitioned_and_lru_bounded(self):
        self.nodes._SCENE_RUN_PLAN_CACHE.clear()
        original_limit = self.nodes._SCENE_RUN_PLAN_CACHE_MAX_ENTRIES
        self.nodes._SCENE_RUN_PLAN_CACHE_MAX_ENTRIES = 2
        try:
            first = _scene_prompt(self.nodes)
            second = self.nodes.transform(first, lambda row, _item: {**row, "positive_parts": ["second"]})
            with mock.patch.object(self.nodes, "normalize_plan", wraps=self.nodes.normalize_plan) as normalize:
                self.nodes._scene_run_plan("one", first, "alice")
                self.nodes._scene_run_plan("one", second, "alice")
                self.nodes._scene_run_plan("one", second, "bob")
                self.assertEqual(normalize.call_count, 2)

            self.nodes._scene_run_plan("two", first, "alice")
            self.nodes._scene_run_plan("one", first, "alice")
            self.nodes._scene_run_plan("three", first, "alice")
            self.assertIn(("alice", "one"), self.nodes._SCENE_RUN_PLAN_CACHE)
            self.assertIn(("alice", "three"), self.nodes._SCENE_RUN_PLAN_CACHE)
            self.assertNotIn(("alice", "two"), self.nodes._SCENE_RUN_PLAN_CACHE)
        finally:
            self.nodes._SCENE_RUN_PLAN_CACHE_MAX_ENTRIES = original_limit
            self.nodes._SCENE_RUN_PLAN_CACHE.clear()

    def test_concurrent_saves_reserve_distinct_filenames_and_keep_metadata(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        scene_info = {"use_run_dir": False, "file_index": 1, "filename_prefix": "parallel_", "positive": "test"}

        def save_one(_index):
            return self.nodes.SceneSaveImage().save_images([image], "", scene_info=scene_info)["result"][1]

        with ThreadPoolExecutor(max_workers=8) as pool:
            paths = [Path(value) for value in pool.map(save_one, range(16))]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertTrue(all(path.exists() for path in paths))
        with Image.open(paths[0]) as saved:
            self.assertEqual(json.loads(saved.text["scene_info"])["positive"], "test")

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
