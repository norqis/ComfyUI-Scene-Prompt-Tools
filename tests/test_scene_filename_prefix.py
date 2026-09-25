import importlib
import importlib.util
import json
import errno
import hashlib
import multiprocessing
import os
import re
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

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
    folder_paths.get_system_user_directory = lambda name: str(output_dir / "user" / "__system__" / name)

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


def _allocate_counter_in_child(output_dir, barrier, result_queue, prefix="shared_"):
    nodes = _load_nodes(Path(output_dir))
    barrier.wait(timeout=10)
    result_queue.put(nodes._allocate_output_index(output_dir, "png", 5, prefix, 1))


def _legacy_counter_paths(root, prefix):
    key = "\0".join(("png", "5", prefix.casefold(), "最後"))
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return root / f".scene-save-{digest}.lock", root / f".scene-save-{digest}.state"


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
        "ScenePromptCallback",
        "ScenePromptCallbackDiscord",
        "ScenePromptCallbackRequest",
        "ScenePromptCallbackDesktop",
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
        self.assertEqual(input_types["optional"]["counter_position"][0], ("先頭", "最後"))
        self.assertEqual(input_types["optional"]["counter_position"][1]["default"], "最後")

        result = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            prefix="00100_",
            scene_prompt=_scene_prompt(self.nodes),
        )
        self.assertEqual(result[2]["filename_prefix"], "00100_")
        self.assertEqual(result[2]["counter_position"], "最後")
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

    def test_prefix_sanitizer_normalizes_reserved_names_and_utf16_length(self):
        self.assertEqual(self.nodes._safe_filename_prefix("e\u0301"), "é")
        self.assertEqual(self.nodes._safe_filename_prefix("aux"), "_aux")
        self.assertEqual(self.nodes._safe_filename_prefix("LPT9 .txt"), "_LPT9 .txt")
        long_prefix = "😀" * 121
        safe = self.nodes._safe_filename_prefix(long_prefix)
        self.assertLessEqual(len(safe.encode("utf-16-le")) // 2, 240)
        self.assertRegex(safe, r"~[0-9a-f]{8}$")

    def test_output_prefix_keeps_png_and_reservation_component_lengths_safe(self):
        prefix = self.nodes._output_filename_prefix("😀" * 200, "png", 5, 10**20)
        filename = f"{prefix}{10**20}.png"
        reservation = f"{filename}.scene-save-reservation"
        self.assertLessEqual(len(filename.encode("utf-8")), 255)
        self.assertLessEqual(len(filename.encode("utf-16-le")) // 2, 255)
        self.assertLessEqual(len(reservation.encode("utf-8")), 255)
        self.assertLessEqual(len(reservation.encode("utf-16-le")) // 2, 255)
        with self.assertRaisesRegex(ValueError, "長すぎます"):
            self.nodes._output_filename_prefix("", "x" * 256, 5)

    def test_output_prefix_stays_stable_for_valid_counter_growth(self):
        value = "日" * 400
        prefixes = {
            self.nodes._output_filename_prefix(value, "png", 5, counter)
            for counter in (1, 99_999, self.nodes.MAX_SAFE_INTEGER)
        }
        self.assertEqual(len(prefixes), 1)

    def test_save_long_prefixes_keep_final_and_reservation_components_safe(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saver = self.nodes.SceneSaveImage()
        for prefix in ("a" * 500, "日" * 500, "😀" * 300):
            with self.subTest(prefix_kind=prefix[:1]):
                result = saver.save_images(
                    [image],
                    "",
                    scene_info={"use_run_dir": False, "file_index": 1, "filename_prefix": prefix},
                )
                path = Path(result["result"][1])
                reservation = f"{path.name}.scene-save-reservation"
                self.assertTrue(path.is_file())
                self.assertLessEqual(len(path.name.encode("utf-8")), 255)
                self.assertLessEqual(len(path.name.encode("utf-16-le")) // 2, 255)
                self.assertLessEqual(len(reservation.encode("utf-8")), 255)
                self.assertLessEqual(len(reservation.encode("utf-16-le")) // 2, 255)
                self.assertFalse(Path(f"{path}.scene-save-reservation").exists())

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

    def test_matrix_backend_normalizes_known_legacy_omissions(self):
        legacy = {
            "row_id": "old-row",
            "name": "Old",
            "path_label": "Old",
            "positive_json": json.dumps({"version": 1, "categories": {"Style": [{
                "label": "Vivid", "prompt": "vivid",
            }]}}),
        }
        parsed = self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [legacy]}))[0]
        self.assertTrue(parsed["enabled"])
        self.assertEqual(parsed["positive_parts"], ["vivid"])
        self.assertEqual(parsed["display_label_groups"], [])

    def test_matrix_backend_rejects_unknown_or_missing_required_fields(self):
        required_fields = ("row_id", "name", "path_label")
        for field in required_fields:
            invalid = _matrix_line("A")
            invalid.pop(field)
            with self.subTest(missing=field):
                with self.assertRaises(ValueError):
                    self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))

        invalid = _matrix_line("A", unknown=True)
        with self.assertRaises(ValueError):
            self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))

        invalid = _matrix_line("A", enabled="true")
        with self.assertRaises(ValueError):
            self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))
        invalid = _matrix_line("A", filename_enabled="true")
        with self.assertRaises(ValueError):
            self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [invalid]}))

    def test_matrix_backend_rejects_duplicate_row_ids(self):
        first = _matrix_line("A", row_id="shared")
        second = _matrix_line("B", row_id="shared")
        with self.assertRaisesRegex(ValueError, "row_id values must be unique"):
            self.nodes._parse_matrix_sets(json.dumps({"version": 1, "sets": [first, second]}))

    def test_matrix_expands_current_schema_prompt_parts_for_both_sides(self):
        matrix_json = json.dumps({
            "version": 1,
            "sets": [_matrix_line("夜", positive_base="night, forest", negative_base="daylight")],
        })
        plan = self.nodes.SceneMatrix().build(matrix_json)[0]
        row = plan["rows"][0]["row"]
        self.assertEqual(row["positive_parts"], ["night", "forest"])
        self.assertEqual(row["negative_parts"], ["daylight"])

    def test_matrix_build_parses_its_json_once(self):
        matrix_json = json.dumps({"version": 1, "sets": [_matrix_line("A")]})
        with mock.patch.object(self.nodes, "_parse_matrix_data", wraps=self.nodes._parse_matrix_data) as parse:
            self.nodes.SceneMatrix().build(matrix_json)
        self.assertEqual(parse.call_count, 1)

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

    def test_expand_puts_literal_prefix_before_prompt_and_matrix_suffixes(self):
        prompt = sys.modules[f"{self.nodes.__package__}.prompt"].ScenePrompt()
        source = prompt.build(
            "PromptA", "", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True,
            filename_enabled=True,
        )[0]
        plan = self.nodes.SceneMatrix().build(json.dumps({"version": 1, "sets": [
            _matrix_line("MatrixA", filename_enabled=True),
        ]}), scene_prompt=source)[0]
        info = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, prefix="", scene_prompt=plan,
        )[2]
        self.assertEqual(info["filename_prefix"], "")
        self.assertEqual(info["filename_suffix"], "PromptAMatrixA")

        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saved = Path(self.nodes.SceneSaveImage().save_images([image], "", scene_info=info)["result"][1])
        self.assertEqual(saved.name, "PromptAMatrixA00001.png")
        with Image.open(saved) as saved_image:
            metadata = json.loads(saved_image.text["scene_info"])
        self.assertEqual(metadata["filename_prefix"], "")
        self.assertEqual(metadata["filename_suffix"], "PromptAMatrixA")

    def test_prefix_remains_first_with_a_direct_prompt_suffix(self):
        info = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, prefix="run_",
            scene_prompt=self.nodes.transform(None, lambda row, _item: {**row, "filename_parts": ["PromptA"]}),
        )[2]
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saved = Path(self.nodes.SceneSaveImage().save_images([image], "", scene_info=info)["result"][1])
        self.assertEqual(saved.name, "run_PromptA00001.png")

    def test_filename_parts_keep_only_user_supplied_underscores(self):
        info = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False,
            scene_prompt=self.nodes.transform(None, lambda row, _item: {**row, "filename_parts": ["Prompt_", "_Matrix"]}),
        )[2]
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saved = Path(self.nodes.SceneSaveImage().save_images([image], "", scene_info=info)["result"][1])
        self.assertEqual(info["filename_suffix"], "Prompt__Matrix")
        self.assertEqual(saved.name, "Prompt__Matrix00001.png")

    def test_counter_position_controls_exact_separator_free_filename_order(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saver = self.nodes.SceneSaveImage()
        first = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_",
            "filename_suffix": "PromptA", "counter_position": "先頭",
        })["result"][1])
        last = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_",
            "filename_suffix": "PromptA", "counter_position": "最後",
        })["result"][1])
        self.assertEqual((first.name, last.name), ("run_00001PromptA.png", "run_PromptA00001.png"))
        with Image.open(first) as saved_image:
            self.assertEqual(json.loads(saved_image.text["scene_info"])["counter_position"], "先頭")

    def test_numeric_adjacent_suffix_recovers_the_metadata_counter(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saver = self.nodes.SceneSaveImage()
        first = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_",
            "filename_suffix": "123", "counter_position": "先頭",
        })["result"][1])
        _lock_path, state_path, _key = self.nodes._counter_state_paths(
            self.temp_dir.name, "png", 5, "run_", "先頭",
        )
        Path(state_path).unlink()
        second = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_",
            "filename_suffix": "123", "counter_position": "先頭",
        })["result"][1])
        self.assertEqual((first.name, second.name), ("run_00001123.png", "run_00002123.png"))

    def test_prefix_counter_is_shared_by_distinct_suffixes_and_digit_suffixes(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saver = self.nodes.SceneSaveImage()
        first = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_", "filename_suffix": "123",
        })["result"][1])
        second = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_", "filename_suffix": "other",
        })["result"][1])
        self.assertEqual((first.name, second.name), ("run_12300001.png", "run_other00002.png"))

        third = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_", "filename_suffix": "restart",
        })["result"][1])
        self.assertEqual(third.name, "run_restart00003.png")

    def test_same_and_different_suffixes_allocate_one_prefix_wide_sequence(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)

        def save_one(index):
            return Path(self.nodes.SceneSaveImage().save_images([image], "", scene_info={
                "use_run_dir": False, "file_index": 1, "filename_prefix": "parallel_",
                "filename_suffix": "same" if index % 2 else "other",
            })["result"][1])

        with ThreadPoolExecutor(max_workers=8) as pool:
            paths = list(pool.map(save_one, range(16)))
        counters = sorted(int(re.search(r"(\d{5})\.png$", path.name).group(1)) for path in paths)
        self.assertEqual(counters, list(range(1, 17)))
        self.assertTrue(all("same" in path.name or "other" in path.name for path in paths))

    def test_suffix_uses_remaining_component_budget_without_changing_prefix(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        raw_prefix = "p" * 500
        effective_prefix = self.nodes._output_filename_prefix(raw_prefix, "png", 5)
        saved = Path(self.nodes.SceneSaveImage().save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": raw_prefix,
            "filename_suffix": "s" * 500,
        })["result"][1])
        self.assertTrue(saved.name.startswith(effective_prefix))
        self.assertLessEqual(len(saved.name.encode("utf-8")), 255)
        self.assertLessEqual(len(saved.name.encode("utf-16-le")) // 2, 255)
        self.assertLessEqual(len(f"{saved.name}.scene-save-reservation".encode("utf-8")), 255)

    def test_legacy_scene_info_without_suffix_keeps_legacy_filename(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saved = Path(self.nodes.SceneSaveImage().save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "legacy_",
        })["result"][1])
        self.assertEqual(saved.name, "legacy_00001.png")

    def test_save_without_prefix_uses_numbered_filename(self):
        saver = self.nodes.SceneSaveImage()
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        result = saver.save_images([image], "", scene_info={"use_run_dir": False, "file_index": 1})
        self.assertEqual(Path(result["result"][1]).name, "00001.png")

    def test_explicit_file_index_is_not_reused_after_output_is_deleted(self):
        saver = self.nodes.SceneSaveImage()
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        scene_info = {"use_run_dir": False, "file_index": 1}

        first = Path(saver.save_images([image], "", scene_info=scene_info)["result"][1])
        first.unlink()
        second = Path(saver.save_images([image], "", scene_info=scene_info)["result"][1])

        self.assertEqual(first.name, "00001.png")
        self.assertEqual(second.name, "00002.png")

    def test_counter_state_restarts_from_persisted_prefix_wide_index(self):
        root = Path(self.temp_dir.name) / "state"
        root.mkdir()
        first = self.nodes._allocate_output_index(str(root), "png", 5, "prefix_", 1)
        second = self.nodes._allocate_output_index(str(root), "png", 5, "prefix_", 1)
        self.assertEqual((first, second), (1, 2))
        self.assertEqual(list(root.iterdir()), [])
        lock_path, state_path, _key = self.nodes._counter_state_paths(str(root), "png", 5, "prefix_")
        self.assertTrue(Path(lock_path).is_file())
        self.assertEqual(Path(state_path).read_text(encoding="ascii"), "3")
        self.assertEqual(Path(state_path).parent, Path(self.temp_dir.name) / "user" / "__system__" / "scene_prompt_tools" / "output_counters")

    def test_central_counter_key_uses_canonical_root_and_all_filename_settings(self):
        root = Path(self.temp_dir.name) / "canonical"
        root.mkdir()
        first = self.nodes._counter_state_paths(str(root), "PNG", 5, "RUN_", "最後")
        equivalent = self.nodes._counter_state_paths(str(root / ".." / "canonical"), "png", 5, "run_", "最後")
        self.assertEqual(first, equivalent)
        if os.name == "nt":
            self.assertEqual(first, self.nodes._counter_state_paths(str(root).upper(), "png", 5, "run_", "最後"))
        for arguments in ((str(root / "other"), "png", 5, "run_", "最後"), (str(root), "jpg", 5, "run_", "最後"),
                          (str(root), "png", 6, "run_", "最後"), (str(root), "png", 5, "other_", "最後"),
                          (str(root), "png", 5, "run_", "先頭")):
            self.assertNotEqual(first[0], self.nodes._counter_state_paths(*arguments)[0])

    def test_each_legacy_artifact_keeps_its_original_lock_and_state_namespace(self):
        for artifact_index in (0, 1):
            with self.subTest(artifact=artifact_index):
                root = Path(self.temp_dir.name) / f"legacy-{artifact_index}"
                root.mkdir()
                (root / "RUN_old00004.png").touch()
                legacy_paths = _legacy_counter_paths(root, "RUN_")
                legacy_paths[artifact_index].write_text("7" if artifact_index else "", encoding="ascii")
                with mock.patch.object(self.nodes.folder_paths, "get_system_user_directory", side_effect=AssertionError("legacy must not use central state")):
                    actual = self.nodes._counter_state_paths(str(root), "PNG", 5, "run_")
                    self.assertEqual(tuple(map(Path, actual[:2])), legacy_paths)
                    self.assertEqual(self.nodes._allocate_output_index(str(root), "png", 5, "run_"), 7 if artifact_index else 5)
                self.assertTrue(all(path.exists() for path in legacy_paths))
                self.assertEqual(len(list(root.glob(".scene-save-*"))), 2)

    def test_central_and_legacy_counters_preserve_recovery_and_exhaustion_contracts(self):
        for namespace in ("central", "legacy"):
            with self.subTest(namespace=namespace):
                root = Path(self.temp_dir.name) / namespace
                root.mkdir()
                if namespace != "central":
                    _legacy_counter_paths(root, "run_")[0].touch()
                allocate = lambda prefix="run_": self.nodes._allocate_output_index(str(root), "png", 5, prefix)
                self.assertEqual(allocate("RUN_"), 1)
                image = root / "RUN_first00001.png"
                image.touch()
                image.unlink()
                with mock.patch.object(self.nodes, "_find_next_index", side_effect=AssertionError("valid state must avoid a rescan")):
                    self.assertEqual(allocate(), 2)
                lock_path, state_path, _key = self.nodes._counter_state_paths(str(root), "png", 5, "run_")
                state = Path(state_path)
                (root / "RUN_other00009.png").touch()
                state.write_text("invalid", encoding="ascii")
                self.assertEqual(allocate(), 10)
                (root / "run_later00010.png").touch()
                state.unlink()
                self.assertEqual(allocate("RUN_"), 11)
                maximum = self.nodes.MAX_SAFE_INTEGER
                state.write_text(str(maximum), encoding="ascii")
                self.assertEqual(allocate(), maximum)
                self.assertEqual(state.read_text(encoding="ascii"), str(maximum + 1))
                with self.assertRaisesRegex(ValueError, "上限"):
                    allocate()
                self.assertTrue(Path(lock_path).exists())
                if namespace == "central":
                    self.assertEqual(list(root.glob(".scene-save-*")), [])

    def test_first_counter_allocation_scans_current_and_legacy_last_png_names(self):
        root = Path(self.temp_dir.name) / "scan"
        nested = root / "nested"
        nested.mkdir(parents=True)
        (nested / "run_suffix00009.png").touch()
        (nested / "PromptArun_00010.png").touch()
        (nested / "run_99999_ignore.png.tmp").touch()
        (nested / "run_00008.jpg").touch()
        self.assertEqual(self.nodes._allocate_output_index(str(root), "png", 5, "run_", 1), 11)

    def test_fallback_uses_five_digits_at_the_requested_position(self):
        first_root = Path(self.temp_dir.name) / "fallback-first"
        last_root = Path(self.temp_dir.name) / "fallback-last"
        first_root.mkdir()
        last_root.mkdir()
        (first_root / "run_00001123.png").touch()
        (last_root / "run_12300001.png").touch()
        self.assertEqual(self.nodes._find_next_index(str(first_root), "png", 5, "run_", "先頭"), 2)
        self.assertEqual(self.nodes._find_next_index(str(last_root), "png", 5, "run_", "最後"), 2)
        (first_root / "run_00009suffix.png").touch()
        (last_root / "run_suffix00008.png").touch()
        self.assertEqual(self.nodes._find_next_index(str(first_root), "png", 5, "run_", "先頭"), 10)
        self.assertEqual(self.nodes._find_next_index(str(last_root), "png", 5, "run_", "最後"), 9)

    def test_missing_state_and_metadata_recover_the_prefix_wide_counter(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        saver = self.nodes.SceneSaveImage()
        first = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_", "filename_suffix": "123",
        })["result"][1])
        with Image.open(first) as saved_image:
            saved_image.copy().save(first)
        _lock_path, state_path, _key = self.nodes._counter_state_paths(self.temp_dir.name, "png", 5, "run_")
        Path(state_path).unlink()
        second = Path(saver.save_images([image], "", scene_info={
            "use_run_dir": False, "file_index": 1, "filename_prefix": "run_", "filename_suffix": "other",
        })["result"][1])
        self.assertEqual((first.name, second.name), ("run_12300001.png", "run_other00002.png"))

    def test_metadata_continues_large_current_and_legacy_counters(self):
        root = Path(self.temp_dir.name) / "metadata"
        root.mkdir()

        def save_metadata(name, scene_info):
            png_info = PngInfo()
            png_info.add_text("scene_info", json.dumps(scene_info))
            Image.new("RGB", (1, 1)).save(root / name, pnginfo=png_info)

        save_metadata("run_suffix100000.png", {
            "file_index": 100000,
            "filename_prefix": "run_",
            "filename_suffix": "suffix",
            "counter_position": "最後",
        })
        save_metadata("PromptARUN_100001.png", {
            "file_index": 100001,
            "filename_prefix": "PromptARUN_",
        })
        self.assertEqual(self.nodes._find_next_index(str(root), "png", 5, "run_", "最後"), 100002)

    def test_metadata_prefix_match_is_case_insensitive(self):
        root = Path(self.temp_dir.name) / "metadata-casefold"
        root.mkdir()
        png_info = PngInfo()
        png_info.add_text("scene_info", json.dumps({
            "file_index": 100000,
            "filename_prefix": "RUN_",
            "filename_suffix": "suffix",
            "counter_position": "最後",
        }))
        Image.new("RGB", (1, 1)).save(root / "RUN_suffix100000.PNG", pnginfo=png_info)
        self.assertEqual(self.nodes._find_next_index(str(root), "png", 5, "run_", "最後"), 100001)

    def test_empty_prefix_scans_legacy_default_png_names(self):
        root = Path(self.temp_dir.name) / "empty-prefix"
        root.mkdir()
        (root / "anything00009.png").touch()
        self.assertEqual(self.nodes._find_next_index(str(root), "png", 5, "", "最後"), 10)
        (root / "anything100001.png").touch()
        self.assertEqual(self.nodes._find_next_index(str(root), "png", 5, "", "最後"), 10)

    def test_counter_state_paths_share_casefolded_prefixes(self):
        root = Path(self.temp_dir.name) / "casefold-state"
        root.mkdir()
        upper_paths = self.nodes._counter_state_paths(str(root), "png", 5, "RUN_")
        lower_paths = self.nodes._counter_state_paths(str(root), "png", 5, "run_")
        self.assertEqual(upper_paths[:2], lower_paths[:2])
        with ThreadPoolExecutor(max_workers=2) as pool:
            counters = list(pool.map(
                lambda prefix: self.nodes._allocate_output_index(str(root), "png", 5, prefix, 1),
                ("RUN_", "run_"),
            ))
        self.assertEqual(sorted(counters), [1, 2])

    def test_counter_state_allows_maximum_once_then_exhausts(self):
        root = Path(self.temp_dir.name) / "maximum-state"
        root.mkdir()
        maximum = self.nodes.MAX_SAFE_INTEGER
        _lock_path, state_path, _key = self.nodes._counter_state_paths(str(root), "png", 5, "run_")
        Path(state_path).parent.mkdir(parents=True, exist_ok=True)
        Path(state_path).write_text(str(maximum), encoding="ascii")
        self.assertEqual(self.nodes._allocate_output_index(str(root), "png", 5, "run_", 1), maximum)
        self.assertIsNone(self.nodes._read_counter_state(state_path))
        with self.assertRaisesRegex(ValueError, "上限"):
            self.nodes._allocate_output_index(str(root), "png", 5, "run_", 1)

    def test_counter_allocation_rejects_requested_and_scanned_overflow(self):
        root = Path(self.temp_dir.name) / "maximum-requested"
        root.mkdir()
        with self.assertRaisesRegex(ValueError, "上限"):
            self.nodes._allocate_output_index(str(root), "png", 5, "run_", self.nodes.MAX_SAFE_INTEGER + 1)

        scan_root = Path(self.temp_dir.name) / "maximum-scanned"
        scan_root.mkdir()
        png_info = PngInfo()
        png_info.add_text("scene_info", json.dumps({
            "file_index": self.nodes.MAX_SAFE_INTEGER,
            "filename_prefix": "run_",
            "filename_suffix": "suffix",
            "counter_position": "最後",
        }))
        Image.new("RGB", (1, 1)).save(scan_root / "run_suffix99999.png", pnginfo=png_info)
        with self.assertRaisesRegex(ValueError, "上限"):
            self.nodes._allocate_output_index(str(scan_root), "png", 5, "run_", 1)

    def test_missing_or_invalid_state_forces_a_rescan_even_after_the_key_was_seen(self):
        root = Path(self.temp_dir.name) / "state-recovery"
        root.mkdir()
        (root / "run_first00001.png").touch()
        self.assertEqual(self.nodes._allocate_output_index(str(root), "png", 5, "run_", 1), 2)
        (root / "run_second00002.png").touch()
        _lock_path, state_path, _key = self.nodes._counter_state_paths(str(root), "png", 5, "run_")
        Path(state_path).write_text("invalid", encoding="ascii")
        self.assertEqual(self.nodes._allocate_output_index(str(root), "png", 5, "run_", 1), 3)

    def test_missing_state_scans_without_holding_the_counter_lock(self):
        root = Path(self.temp_dir.name) / "scan-lock"
        root.mkdir()
        _lock_path, state_path, _key = self.nodes._counter_state_paths(str(root), "png", 5, "run_")
        scan_started = threading.Event()
        release_scan = threading.Event()

        def slow_scan(*_args):
            scan_started.set()
            self.assertTrue(release_scan.wait(timeout=5))
            return 1

        with mock.patch.object(self.nodes, "_find_next_index", side_effect=slow_scan):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self.nodes._allocate_output_index, str(root), "png", 5, "run_", 1)
                self.assertTrue(scan_started.wait(timeout=5))
                Path(state_path).write_text("7", encoding="ascii")
                self.assertEqual(pool.submit(self.nodes._allocate_output_index, str(root), "png", 5, "run_", 1).result(timeout=2), 7)
                release_scan.set()
                self.assertEqual(first.result(timeout=5), 8)

    def test_separate_processes_share_one_prefix_counter(self):
        context = multiprocessing.get_context("spawn")
        for namespace in ("central", "legacy"):
            with self.subTest(namespace=namespace):
                root = Path(self.temp_dir.name) / f"processes-{namespace}"
                root.mkdir()
                if namespace != "central":
                    _legacy_counter_paths(root, "shared_")[0].touch()
                barrier = context.Barrier(2)
                result_queue = context.Queue()
                processes = [
                    context.Process(target=_allocate_counter_in_child, args=(str(root), barrier, result_queue, prefix))
                    for prefix in ("shared_", "SHARED_")
                ]
                for process in processes:
                    process.start()
                for process in processes:
                    process.join(timeout=20)
                self.assertTrue(all(process.exitcode == 0 for process in processes))
                self.assertEqual(sorted(result_queue.get(timeout=5) for _ in processes), [1, 2])
                result_queue.close()
                result_queue.join_thread()

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
        handle = runs.create_run_context("alice")
        first = _scene_prompt(self.nodes)
        second = self.nodes.transform(first, lambda row, _item: {**row, "positive_parts": ["second"]})
        self.assertEqual(self.nodes._scene_run_plan(handle, first, "expand-1")["rows"][0]["row"]["positive_parts"], ["test"])
        self.assertEqual(self.nodes._scene_run_plan(handle, second, "expand-2")["rows"][0]["row"]["positive_parts"], ["second"])
        self.assertEqual(self.nodes._scene_run_plan(handle, second, "expand-1")["rows"][0]["row"]["positive_parts"], ["test"])
        self.assertEqual(self.nodes._scene_run_plan(handle, first, "expand-2")["rows"][0]["row"]["positive_parts"], ["second"])
        runs.release_run_context(handle, "alice")
        with self.assertRaises(runs.SceneRunError):
            self.nodes._scene_run_plan(handle, first)

    def test_expand_reuses_the_internal_cached_plan_without_normalizing_or_copying(self):
        runs = sys.modules[f"{self.nodes.__package__}.runs"]
        runs.RUN_CONTEXTS.clear()
        handle = runs.create_run_context("alice")
        plan = _scene_prompt(self.nodes)
        try:
            self.nodes._scene_run_plan(handle, plan, "expand")
            with mock.patch.object(self.nodes, "normalize_plan", side_effect=AssertionError("must not normalize")), mock.patch.object(
                runs.RUN_CONTEXTS, "get_plan", side_effect=AssertionError("must not use public copied plan")
            ):
                expanded = self.nodes.ScenePromptExpand().expand(
                    current_index=0,
                    seed_base=7,
                    timestamp_dir=False,
                    scene_prompt=plan,
                    run_handle=handle,
                    unique_id="expand",
                )
            self.assertEqual(expanded[0], "test")
        finally:
            runs.release_run_context(handle, "alice")

    def test_is_changed_does_not_register_a_seed_plan_before_expand(self):
        runs = sys.modules[f"{self.nodes.__package__}.runs"]
        runs.RUN_CONTEXTS.clear()
        handle = runs.create_run_context("alice")
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

    def test_concurrent_scene_subfolders_share_one_run_root_sequence(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        barrier = threading.Barrier(2)
        original_save = Image.Image.save

        def wait_for_both_reservations(instance, *args, **kwargs):
            barrier.wait(timeout=5)
            return original_save(instance, *args, **kwargs)

        def save_one(scene_path):
            return self.nodes.SceneSaveImage().save_images(
                [image], "", scene_info={
                    "run_dir": "shared-run", "use_run_dir": True, "path": scene_path, "file_index": 1,
                },
            )["result"][1]

        with mock.patch.object(Image.Image, "save", wait_for_both_reservations):
            with ThreadPoolExecutor(max_workers=2) as pool:
                paths = [Path(path) for path in pool.map(save_one, ("left", "right"))]
        self.assertEqual({path.name for path in paths}, {"00001.png", "00002.png"})
        self.assertEqual({path.parent.name for path in paths}, {"left", "right"})

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

    def test_eacces_reservation_collision_returns_no_claim_only_when_claim_exists(self):
        target = Path(self.temp_dir.name) / "eacces-collision"
        target.mkdir()
        claimed = target / "00001.png.scene-save-reservation"
        claimed.touch()
        original_open = self.nodes.os.open
        calls = []

        def eacces_once(path, flags, mode=0o777):
            calls.append(path)
            if len(calls) == 1:
                raise PermissionError(errno.EACCES, "access denied", path)
            return original_open(path, flags, mode)

        with mock.patch.object(self.nodes.os, "open", side_effect=eacces_once):
            with self.nodes._FILENAME_RESERVATION_LOCK:
                reserved = self.nodes._reserve_output_path(str(target), "png", 5, 1)
        self.assertIsNone(reserved)

    def test_eacces_without_reservation_is_not_hidden(self):
        target = Path(self.temp_dir.name) / "eacces-error"
        target.mkdir()

        with mock.patch.object(
            self.nodes.os,
            "open",
            side_effect=PermissionError(errno.EACCES, "access denied"),
        ):
            with self.nodes._FILENAME_RESERVATION_LOCK:
                with self.assertRaises(PermissionError):
                    self.nodes._reserve_output_path(str(target), "png", 5, 1)

    def test_reservation_cleanup_happens_under_the_reservation_lock(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        observed_lock_states = []
        original_unlink = self.nodes.os.unlink

        def observe_unlink(path, *args, **kwargs):
            if str(path).endswith(".scene-save-reservation"):
                observed_lock_states.append(self.nodes._FILENAME_RESERVATION_LOCK.locked())
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(self.nodes.os, "unlink", side_effect=observe_unlink):
            self.nodes.SceneSaveImage().save_images(
                [image], "reservation-lock", scene_info={"use_run_dir": False, "file_index": 1}
            )
        self.assertEqual(observed_lock_states, [True])

    def test_final_publication_does_not_use_overwriting_replace(self):
        image = torch.zeros((16, 16, 3), dtype=torch.float32)
        original_replace = self.nodes.os.replace

        def replace_state_only(source, destination):
            self.assertTrue(str(destination).endswith(".state"))
            return original_replace(source, destination)

        with mock.patch.object(self.nodes.os, "replace", side_effect=replace_state_only):
            result = self.nodes.SceneSaveImage().save_images(
                [image], "non-overwriting", scene_info={"use_run_dir": False, "file_index": 1}
            )
        self.assertTrue(Path(result["result"][1]).is_file())

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
            result = self.nodes.SceneSaveImage().save_images(
                [image], "competing", scene_info={"use_run_dir": False, "file_index": 1}
            )

        with Image.open(output_path) as existing:
            self.assertEqual(existing.getpixel((0, 0)), (255, 0, 0))
        self.assertEqual(Path(result["result"][1]).name, "00002.png")
        self.assertEqual(list(target.glob("*.scene-save-reservation")), [])

    def test_save_metadata_mode_choices_are_ordered_and_default_to_full_workflow(self):
        metadata_mode = self.nodes.SceneSaveImage.INPUT_TYPES()["required"]["metadata_mode"]
        self.assertEqual(
            metadata_mode[0],
            (
                "ワークフロー全体",
                "生成経路ノードのみ",
                "プロンプトのみ",
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
        workflow_nodes = [
            {
                "id": node_id,
                "type": prompt[str(node_id)]["class_type"],
                "pos": [node_id * 100, node_id * 50],
                "size": [240, 180],
                "inputs": ([{"name": "input", "link": link_id}] if link_id is not None else []),
                "outputs": [{"name": "output", "links": output_links}],
                "widgets_values": (["selected prompt", "selection-json"] if node_id == 2 else []),
                "widgets_values_named": ({"selected": "selection-json"} if node_id == 2 else {}),
                "properties": {"kept": node_id},
            }
            for node_id, link_id, output_links in (
                (1, None, [10, 11]),
                (2, 10, [12]),
                (3, 11, [13]),
                (4, 12, []),
                (5, 13, []),
            )
        ]
        extra_pnginfo = {
            "prompt": {"reserved": "must not override the submitted prompt"},
            "workflow": {
                "id": "workflow-id",
                "nodes": workflow_nodes,
                "links": [
                    [10, 1, 0, 2, 0, "MODEL"],
                    [11, 1, 0, 3, 0, "MODEL"],
                    [12, 2, 0, 4, 0, "IMAGE"],
                    [13, 3, 0, 5, 0, "IMAGE"],
                ],
                "groups": [],
                "reroutes": [{"id": 99, "pos": [0, 0]}],
                "extra": {
                    "reroutes": [{"id": 1, "pos": [150, 75], "linkIds": [10, 11]}],
                    "linkExtensions": [
                        {"id": 10, "parentId": 1},
                        {"id": 11, "parentId": 1},
                    ],
                },
            },
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
        self.assertEqual(set(json.loads(execution_path["prompt"])), {"1", "2", "4"})
        sliced_workflow = json.loads(execution_path["workflow"])
        self.assertEqual({str(node["id"]) for node in sliced_workflow["nodes"]}, {"1", "2", "4"})
        self.assertEqual([link[0] for link in sliced_workflow["links"]], [10, 12])
        self.assertEqual(sliced_workflow["nodes"][0]["outputs"][0]["links"], [10])
        self.assertEqual(sliced_workflow["nodes"][1]["widgets_values"], ["selected prompt", "selection-json"])
        self.assertEqual(sliced_workflow["nodes"][1]["widgets_values_named"], {"selected": "selection-json"})
        self.assertEqual(sliced_workflow["nodes"][1]["pos"], [200, 100])
        self.assertEqual(sliced_workflow["reroutes"], [])
        self.assertEqual(
            sliced_workflow["extra"]["reroutes"],
            [{"id": 1, "pos": [150, 75], "linkIds": [10]}],
        )
        self.assertEqual(
            sliced_workflow["extra"]["linkExtensions"],
            [{"id": 10, "parentId": 1}],
        )
        self.assertEqual(json.loads(execution_path["custom"]), extra_pnginfo["custom"])

        for metadata in saved.values():
            self.assertEqual(json.loads(metadata["scene_info"])["positive"], "positive text")
            self.assertEqual(metadata["scene_positive"], "positive text")
            self.assertEqual(metadata["scene_negative"], "negative text")
            self.assertEqual(metadata["scene_seed"], "42")
        self.assertEqual(prompt, original_prompt)
        self.assertEqual(extra_pnginfo, original_extra)

    def test_execution_path_reconnects_around_bypassed_workflow_node(self):
        prompt = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "3": {"class_type": "KSampler", "inputs": {"model": ["1", 0]}},
            "4": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        workflow = {
            "last_link_id": 12,
            "nodes": [
                {
                    "id": 1, "type": "CheckpointLoaderSimple", "mode": 0,
                    "inputs": [],
                    "outputs": [{"name": "MODEL", "type": "MODEL", "links": [10]}],
                },
                {
                    "id": 2, "type": "ModelPassthrough", "mode": 4,
                    "inputs": [{"name": "model", "type": "MODEL", "link": 10}],
                    "outputs": [{"name": "MODEL", "type": "MODEL", "links": [11]}],
                },
                {
                    "id": 3, "type": "KSampler", "mode": 0,
                    "inputs": [{"name": "model", "type": "MODEL", "link": 11}],
                    "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [12]}],
                },
                {
                    "id": 4, "type": "SceneSaveImage", "mode": 0,
                    "inputs": [{"name": "images", "type": "IMAGE", "link": 12}],
                    "outputs": [],
                },
            ],
            "links": [
                [10, 1, 0, 2, 0, "MODEL"],
                [11, 2, 0, 3, 0, "MODEL"],
                [12, 3, 0, 4, 0, "IMAGE"],
            ],
            "groups": [],
        }

        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "4",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
        )

        self.assertEqual(set(saved_prompt), {"1", "3", "4"})
        saved_workflow = saved_extra["workflow"]
        self.assertEqual({str(node["id"]) for node in saved_workflow["nodes"]}, {"1", "3", "4"})
        self.assertNotIn("2", {str(node["id"]) for node in saved_workflow["nodes"]})
        self.assertIn([13, 1, 0, 3, 0, "MODEL"], saved_workflow["links"])
        sampler = next(node for node in saved_workflow["nodes"] if str(node["id"]) == "3")
        loader = next(node for node in saved_workflow["nodes"] if str(node["id"]) == "1")
        self.assertEqual(sampler["inputs"][0]["link"], 13)
        self.assertEqual(loader["outputs"][0]["links"], [13])
        self.assertEqual(saved_workflow["last_link_id"], 13)

    def test_execution_path_removes_reroutes_for_excluded_links(self):
        prompt = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "2": {"class_type": "KSampler", "inputs": {"model": ["1", 0]}},
            "3": {"class_type": "SceneSaveImage", "inputs": {"images": ["2", 0]}},
        }
        workflow = {
            "version": 0.4,
            "nodes": [
                {"id": 1, "type": "CheckpointLoaderSimple", "inputs": [], "outputs": [{"links": [10, 11]}]},
                {"id": 2, "type": "KSampler", "inputs": [{"name": "model", "link": 10}], "outputs": [{"links": [12]}]},
                {"id": 3, "type": "SceneSaveImage", "inputs": [{"name": "images", "link": 12}], "outputs": []},
                {"id": 4, "type": "Unused", "inputs": [{"name": "model", "link": 11}], "outputs": []},
            ],
            "links": [
                [10, 1, 0, 2, 0, "MODEL"],
                [11, 1, 0, 4, 0, "MODEL"],
                [12, 2, 0, 3, 0, "IMAGE"],
            ],
            "groups": [],
            "extra": {
                "reroutes": [{"id": 1, "pos": [0, 0], "linkIds": [10, 11]}],
                "linkExtensions": [
                    {"id": 10, "parentId": 1},
                    {"id": 11, "parentId": 1},
                ],
            },
        }

        _saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "3",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
        )

        saved_workflow = saved_extra["workflow"]
        self.assertEqual(saved_workflow["extra"]["reroutes"][0]["linkIds"], [10])
        self.assertEqual(saved_workflow["extra"]["linkExtensions"], [{"id": 10, "parentId": 1}])

    def test_non_full_metadata_excludes_only_lowercase_reserved_extra_keys(self):
        prompt = {"save": {"class_type": "SceneSaveImage", "inputs": {}}}
        extra_pnginfo = {
            "prompt": {"reserved": True},
            "workflow": {"nodes": [{"id": "save", "pos": [1, 2]}], "links": [], "groups": []},
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
                self.assertEqual(saved_extra["Prompt"], {"keep": True})
                self.assertEqual(saved_extra["Workflow"], {"keep": True})
                self.assertEqual(saved_extra["custom"], {"keep": True})
                if mode == self.nodes.SAVE_METADATA_PROMPT_ONLY:
                    self.assertNotIn("workflow", saved_extra)
                    self.assertIsNone(saved_prompt)
                else:
                    self.assertIn("workflow", saved_extra)
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

    def test_expand_records_selected_scene_node_provenance(self):
        prompt_module = importlib.import_module(f"{self.nodes.__package__}.prompt")
        prompt = prompt_module.ScenePrompt().build(
            "branch_a", "tag_a", "{\"version\":1,\"categories\":{}}", "", "{\"version\":1,\"categories\":{}}", "", 0, True,
            unique_id="branch_a",
        )[0]
        counted = self.nodes.ScenePromptCounter().count(prompt, 1, unique_id="count_a")[0]
        queued = self.nodes.ScenePromptQueue().queue(scene_prompt1=counted, unique_id="queue_main")[0]
        info = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=1,
            timestamp_dir=False,
            scene_prompt=queued,
            unique_id="expand_main",
        )[2]
        self.assertEqual(info["source_node_ids"], ["branch_a", "count_a", "queue_main", "expand_main"])

    def test_generation_path_metadata_keeps_only_the_selected_scene_queue_branch(self):
        prompt = {
            "model": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "scene_a": {"class_type": "ScenePrompter", "inputs": {}},
            "scene_b": {"class_type": "ScenePrompter", "inputs": {}},
            "queue": {"class_type": "ScenePrompterQueue", "inputs": {
                "scene_prompt1": ["scene_a", 0], "scene_prompt2": ["scene_b", 0],
            }},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["queue", 0]}},
            "positive": {"class_type": "CLIPTextEncode", "inputs": {"text": ["expand", 0]}},
            "negative": {"class_type": "CLIPTextEncode", "inputs": {"text": ["expand", 1]}},
            "sampler": {"class_type": "KSampler", "inputs": {
                "model": ["model", 0], "positive": ["positive", 0], "negative": ["negative", 0],
            }},
            "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sampler", 0]}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["decode", 0], "scene_info": ["expand", 2]}},
        }
        workflow_nodes = [
            {
                "id": node_id, "type": node["class_type"], "pos": [index * 100, index * 25], "size": [220, 120],
                "widgets_values": (["kept"] if node_id == "scene_a" else []),
                "widgets_values_named": ({"selected": "kept"} if node_id == "scene_a" else {}),
                "inputs": [], "outputs": [],
            }
            for index, (node_id, node) in enumerate(prompt.items())
        ]
        links = []
        link_id = 1
        workflow_by_id = {str(node["id"]): node for node in workflow_nodes}
        for target_id, node in prompt.items():
            for input_index, (input_name, value) in enumerate(node["inputs"].items()):
                if not isinstance(value, list):
                    continue
                source_id = str(value[0])
                links.append([link_id, source_id, value[1], target_id, input_index, "*"])
                workflow_by_id[target_id]["inputs"].append({"name": input_name, "link": link_id})
                workflow_by_id[source_id]["outputs"].append({"name": "output", "links": [link_id]})
                link_id += 1
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": {"nodes": workflow_nodes, "links": links, "groups": []}},
            "save",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            {"source_node_ids": ["scene_a", "queue", "expand"]},
        )
        self.assertNotIn("scene_b", saved_prompt)
        self.assertEqual(set(saved_prompt), {"model", "scene_a", "queue", "expand", "positive", "negative", "sampler", "decode", "save"})
        saved_workflow = saved_extra["workflow"]
        saved_ids = {str(node["id"]) for node in saved_workflow["nodes"]}
        self.assertEqual(saved_ids, set(saved_prompt))
        self.assertEqual(next(node for node in saved_workflow["nodes"] if node["id"] == "scene_a")["pos"], [100, 25])
        self.assertEqual(next(node for node in saved_workflow["nodes"] if node["id"] == "scene_a")["widgets_values_named"], {"selected": "kept"})
        for link in saved_workflow["links"]:
            self.assertIn(str(link[1]), saved_ids)
            self.assertIn(str(link[3]), saved_ids)
        for node in saved_prompt.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2:
                    self.assertIn(str(value[0]), saved_prompt)

    def test_generation_path_metadata_keeps_only_the_selected_model_route(self):
        prompt = {
            "loader_a": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "loader_b": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "model_a": {"class_type": "SceneApplyModel", "inputs": {
                "model": ["loader_a", 0], "clip": ["loader_a", 1], "vae": ["loader_a", 2],
            }},
            "model_b": {"class_type": "SceneApplyModel", "inputs": {
                "model": ["loader_b", 0], "clip": ["loader_b", 1], "vae": ["loader_b", 2],
            }},
            "lora_a": {"class_type": "SceneApplyLora", "inputs": {"scene_prompt": ["model_a", 0]}},
            "lora_b": {"class_type": "SceneApplyLora", "inputs": {"scene_prompt": ["model_b", 0]}},
            "queue": {"class_type": "ScenePrompterQueue", "inputs": {
                "scene_prompt1": ["lora_a", 0], "scene_prompt2": ["lora_b", 0],
            }},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["queue", 0]}},
            "positive": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["expand", 6], "text": ["expand", 0]}},
            "negative": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["expand", 6], "text": ["expand", 1]}},
            "sampler": {"class_type": "KSampler", "inputs": {
                "model": ["expand", 5], "positive": ["positive", 0], "negative": ["negative", 0],
            }},
            "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sampler", 0], "vae": ["expand", 7]}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["decode", 0], "scene_info": ["expand", 2]}},
        }
        workflow_nodes = [
            {
                "id": node_id, "type": node["class_type"], "pos": [index * 100, index * 25], "size": [220, 120],
                "widgets_values": [], "inputs": [], "outputs": [],
            }
            for index, (node_id, node) in enumerate(prompt.items())
        ]
        links = []
        workflow_by_id = {str(node["id"]): node for node in workflow_nodes}
        for link_id, (target_id, input_name, value) in enumerate((
            (target_id, input_name, value)
            for target_id, node in prompt.items()
            for input_name, value in node["inputs"].items()
            if isinstance(value, list)
        ), start=1):
            source_id = str(value[0])
            target_slot = len(workflow_by_id[target_id]["inputs"])
            links.append([link_id, source_id, value[1], target_id, target_slot, "*"])
            workflow_by_id[target_id]["inputs"].append({"name": input_name, "link": link_id})
            workflow_by_id[source_id]["outputs"].append({"name": "output", "links": [link_id]})

        selected = {"loader_a", "model_a", "lora_a", "queue", "expand", "positive", "negative", "sampler", "decode", "save"}
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": {"nodes": workflow_nodes, "links": links, "groups": []}},
            "save",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            {"source_node_ids": ["model_a", "lora_a", "queue", "expand"]},
        )
        self.assertEqual(set(saved_prompt), selected)
        self.assertEqual({str(node["id"]) for node in saved_extra["workflow"]["nodes"]}, selected)
        self.assertNotIn("loader_b", saved_prompt)
        self.assertNotIn("model_b", saved_prompt)
        self.assertNotIn("lora_b", saved_prompt)

    def test_generation_path_metadata_drops_superseded_serial_model_loader(self):
        prompt = {
            "scene": {"class_type": "ScenePrompter", "inputs": {}},
            "loader_a": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "loader_b": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "model_a": {"class_type": "SceneApplyModel", "inputs": {
                "scene_prompt": ["scene", 0],
                "model": ["loader_a", 0], "clip": ["loader_a", 1], "vae": ["loader_a", 2],
            }},
            "lora": {"class_type": "SceneApplyLora", "inputs": {"scene_prompt": ["model_a", 0]}},
            "model_b": {"class_type": "SceneApplyModel", "inputs": {
                "scene_prompt": ["lora", 0],
                "model": ["loader_b", 0], "clip": ["loader_b", 1], "vae": ["loader_b", 2],
            }},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["model_b", 0]}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["expand", 4], "scene_info": ["expand", 2]}},
        }
        workflow_nodes = [
            {"id": node_id, "type": node["class_type"], "inputs": [], "outputs": []}
            for node_id, node in prompt.items()
        ]
        workflow_by_id = {str(node["id"]): node for node in workflow_nodes}
        links = []
        for link_id, (target_id, input_name, value) in enumerate((
            (target_id, input_name, value)
            for target_id, node in prompt.items()
            for input_name, value in node["inputs"].items()
            if isinstance(value, list)
        ), start=1):
            source_id, source_slot = value
            source = workflow_by_id[str(source_id)]
            while len(source["outputs"]) <= source_slot:
                source["outputs"].append({"links": []})
            source["outputs"][source_slot]["links"].append(link_id)
            target = workflow_by_id[target_id]
            target_slot = len(target["inputs"])
            target["inputs"].append({"name": input_name, "link": link_id})
            links.append([link_id, source_id, source_slot, target_id, target_slot, "*"])
        workflow = {
            "nodes": workflow_nodes, "links": links,
            "groups": [],
        }
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt, {"workflow": workflow}, "save", self.nodes.SAVE_METADATA_EXECUTION_PATH,
            {"source_node_ids": ["scene", "model_a", "lora", "model_b", "expand"]},
        )
        self.assertEqual(set(saved_prompt), {"scene", "loader_b", "lora", "model_b", "expand", "save"})
        self.assertNotIn("loader_a", saved_prompt)
        self.assertNotIn("model_a", saved_prompt)
        self.assertEqual(saved_prompt["lora"]["inputs"]["scene_prompt"], ["scene", 0])
        self.assertEqual(saved_prompt["model_b"]["inputs"]["scene_prompt"], ["lora", 0])
        saved_workflow = saved_extra["workflow"]
        self.assertEqual({str(node["id"]) for node in saved_workflow["nodes"]}, set(saved_prompt))
        self.assertIn(["scene", 0, "lora"], [[str(link[1]), link[2], str(link[3])] for link in saved_workflow["links"]])
        for node in saved_prompt.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2:
                    self.assertIn(str(value[0]), saved_prompt)
        for link in saved_workflow["links"]:
            self.assertIn(str(link[1]), saved_prompt)
            self.assertIn(str(link[3]), saved_prompt)

    def test_generation_path_metadata_contracts_models_behind_merge_and_queue(self):
        prompt = {
            "left": {"class_type": "ScenePrompter", "inputs": {}},
            "right": {"class_type": "ScenePrompter", "inputs": {}},
            "loader_a": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "loader_b": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "model_a": {"class_type": "SceneApplyModel", "inputs": {
                "scene_prompt": ["left", 0], "model": ["loader_a", 0], "clip": ["loader_a", 1], "vae": ["loader_a", 2],
            }},
            "merge": {"class_type": "ScenePrompterMerge", "inputs": {"scene_prompt1": ["model_a", 0], "scene_prompt2": ["right", 0]}},
            "queue": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["merge", 0]}},
            "model_b": {"class_type": "SceneApplyModel", "inputs": {
                "scene_prompt": ["queue", 0], "model": ["loader_b", 0], "clip": ["loader_b", 1], "vae": ["loader_b", 2],
            }},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["model_b", 0]}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["expand", 4], "scene_info": ["expand", 2]}},
        }
        workflow_nodes = [{"id": node_id, "type": node["class_type"], "inputs": [], "outputs": []} for node_id, node in prompt.items()]
        by_id = {str(node["id"]): node for node in workflow_nodes}
        links = []
        for link_id, (target_id, input_name, value) in enumerate((
            (target_id, input_name, value) for target_id, node in prompt.items()
            for input_name, value in node["inputs"].items() if isinstance(value, list)
        ), start=1):
            source_id, source_slot = value
            source = by_id[str(source_id)]
            while len(source["outputs"]) <= source_slot:
                source["outputs"].append({"links": []})
            source["outputs"][source_slot]["links"].append(link_id)
            target = by_id[target_id]
            target_slot = len(target["inputs"])
            target["inputs"].append({"name": input_name, "link": link_id})
            links.append([link_id, source_id, source_slot, target_id, target_slot, "*"])
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt, {"workflow": {"nodes": workflow_nodes, "links": links, "groups": []}}, "save",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            {"source_node_ids": ["left", "right", "model_a", "merge", "queue", "model_b", "expand"]},
        )
        self.assertNotIn("loader_a", saved_prompt)
        self.assertNotIn("model_a", saved_prompt)
        self.assertEqual(saved_prompt["merge"]["inputs"]["scene_prompt1"], ["left", 0])
        self.assertEqual(saved_prompt["queue"]["inputs"]["scene_prompt1"], ["merge", 0])
        self.assertEqual(saved_prompt["model_b"]["inputs"]["scene_prompt"], ["queue", 0])
        saved_ids = set(saved_prompt)
        self.assertEqual({str(node["id"]) for node in saved_extra["workflow"]["nodes"]}, saved_ids)
        for node in saved_prompt.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2:
                    self.assertIn(str(value[0]), saved_ids)

    def _sibling_merge_model_metadata(self, same_loader=False):
        loader_a = "loader" if same_loader else "loader_a"
        loader_b = "loader" if same_loader else "loader_b"
        prompt = {
            "left": {"class_type": "ScenePrompter", "inputs": {}},
            "right": {"class_type": "ScenePrompter", "inputs": {}},
            loader_a: {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            **({} if same_loader else {loader_b: {"class_type": "CheckpointLoaderSimple", "inputs": {}}}),
            "model_a": {"class_type": "SceneApplyModel", "inputs": {
                "scene_prompt": ["left", 0], "model": [loader_a, 0], "clip": [loader_a, 1], "vae": [loader_a, 2],
            }},
            "model_b": {"class_type": "SceneApplyModel", "inputs": {
                "scene_prompt": ["right", 0], "model": [loader_b, 0], "clip": [loader_b, 1], "vae": [loader_b, 2],
            }},
            "merge": {"class_type": "ScenePrompterMerge", "inputs": {
                "scene_prompt1": ["model_a", 0], "scene_prompt2": ["model_b", 0],
            }},
            "queue": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["merge", 0]}},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["queue", 0]}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["expand", 4], "scene_info": ["expand", 2]}},
        }
        workflow_nodes = [
            {"id": node_id, "type": node["class_type"], "inputs": [], "outputs": []}
            for node_id, node in prompt.items()
        ]
        by_id = {str(node["id"]): node for node in workflow_nodes}
        links = []
        for link_id, (target_id, input_name, value) in enumerate((
            (target_id, input_name, value) for target_id, node in prompt.items()
            for input_name, value in node["inputs"].items() if isinstance(value, list)
        ), start=1):
            source_id, source_slot = value
            source = by_id[str(source_id)]
            while len(source["outputs"]) <= source_slot:
                source["outputs"].append({"links": []})
            source["outputs"][source_slot]["links"].append(link_id)
            target = by_id[target_id]
            target_slot = len(target["inputs"])
            target["inputs"].append({"name": input_name, "link": link_id})
            links.append([link_id, source_id, source_slot, target_id, target_slot, "*"])
        return self.nodes._metadata_for_save_mode(
            prompt, {"workflow": {"nodes": workflow_nodes, "links": links, "groups": []}}, "save",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            {"source_node_ids": ["left", "model_a", "right", "model_b", "merge", "queue", "expand"]},
        )

    def test_generation_path_metadata_keeps_right_sibling_merge_model_and_queue_route(self):
        saved_prompt, saved_extra = self._sibling_merge_model_metadata()
        self.assertNotIn("loader_a", saved_prompt)
        self.assertNotIn("model_a", saved_prompt)
        self.assertEqual(
            set(saved_prompt),
            {"left", "right", "loader_b", "model_b", "merge", "queue", "expand", "save"},
        )
        self.assertEqual(saved_prompt["merge"]["inputs"]["scene_prompt1"], ["left", 0])
        self.assertEqual(saved_prompt["merge"]["inputs"]["scene_prompt2"], ["model_b", 0])
        self.assertEqual(saved_prompt["model_b"]["inputs"]["model"], ["loader_b", 0])
        self.assertEqual(saved_prompt["queue"]["inputs"]["scene_prompt1"], ["merge", 0])
        saved_workflow = saved_extra["workflow"]
        saved_ids = set(saved_prompt)
        self.assertEqual({str(node["id"]) for node in saved_workflow["nodes"]}, saved_ids)
        workflow_routes = {(str(link[1]), link[2], str(link[3])) for link in saved_workflow["links"]}
        self.assertIn(("left", 0, "merge"), workflow_routes)
        self.assertIn(("model_b", 0, "merge"), workflow_routes)
        workflow_links = {link[0]: link for link in saved_workflow["links"]}
        self.assertTrue(all(
            str(link[1]) in saved_ids and str(link[3]) in saved_ids
            for link in workflow_links.values()
        ))
        for workflow_node in saved_workflow["nodes"]:
            node_id = str(workflow_node["id"])
            for slot_index, slot in enumerate(workflow_node.get("inputs", [])):
                if isinstance(slot, dict) and slot.get("link") is not None:
                    link = workflow_links[slot["link"]]
                    self.assertEqual((str(link[3]), link[4]), (node_id, slot_index))
            for slot_index, slot in enumerate(workflow_node.get("outputs", [])):
                if isinstance(slot, dict) and isinstance(slot.get("links"), list):
                    for link_id in slot["links"]:
                        link = workflow_links[link_id]
                        self.assertEqual((str(link[1]), link[2]), (node_id, slot_index))
        for node in saved_prompt.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2:
                    self.assertIn(str(value[0]), saved_ids)

    def test_generation_path_metadata_uses_merge_source_order_when_models_share_loader(self):
        saved_prompt, saved_extra = self._sibling_merge_model_metadata(same_loader=True)
        self.assertNotIn("model_a", saved_prompt)
        self.assertEqual(
            set(saved_prompt),
            {"left", "right", "loader", "model_b", "merge", "queue", "expand", "save"},
        )
        self.assertEqual(saved_prompt["merge"]["inputs"]["scene_prompt1"], ["left", 0])
        self.assertEqual(saved_prompt["merge"]["inputs"]["scene_prompt2"], ["model_b", 0])
        self.assertEqual(saved_prompt["model_b"]["inputs"]["model"], ["loader", 0])
        self.assertEqual({str(node["id"]) for node in saved_extra["workflow"]["nodes"]}, set(saved_prompt))

    def test_execution_path_rebases_queue_second_branch_and_preserves_repeat(self):
        def branch(source_id, text, count):
            plan = self.nodes.with_source_node(
                self.nodes.transform(None, lambda row, _item: {**row, "positive_parts": [text]}),
                source_id,
            )
            return self.nodes.multiply_count(plan, count)

        queued = self.nodes.ScenePromptQueue().queue(
            scene_prompt1=branch("a", "first", 2),
            scene_prompt2=branch("b", "second", 3),
            unique_id="queue",
        )[0]
        info = self.nodes.ScenePromptExpand().expand(
            current_index=3,
            seed_base=100,
            timestamp_dir=False,
            scene_prompt=queued,
            unique_id="expand",
        )[2]
        self.assertEqual(info["repeat_index"], 2)
        self.assertIs(info["_plan_ref"], self.nodes._normalize_scene_save_info(info)["_plan_ref"])
        prompt = {
            "a": {"class_type": "ScenePrompter", "inputs": {}},
            "b": {"class_type": "ScenePrompter", "inputs": {}},
            "queue": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["a", 0], "scene_prompt2": ["b", 0]}},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["queue", 0], "current_index": 3, "seed_base": 100}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["expand", 4]}},
        }
        workflow = {
            "nodes": [
                {"id": node_id, "type": node["class_type"], "widgets_values": [3, "", 100, False, "", "Illustrious", 10, "続行", False], "inputs": [], "outputs": []}
                for node_id, node in prompt.items()
            ],
            "links": [],
            "groups": [],
        }
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "save",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            info,
        )
        self.assertNotIn("a", saved_prompt)
        self.assertEqual(saved_prompt["expand"]["inputs"]["current_index"], 1)
        self.assertEqual(saved_prompt["expand"]["inputs"]["seed_base"], 102)
        self.assertFalse(saved_prompt["expand"]["inputs"]["seed_base_literal"])
        saved_expand = next(node for node in saved_extra["workflow"]["nodes"] if str(node["id"]) == "expand")
        self.assertEqual(saved_expand["widgets_values"][0], 1)
        self.assertEqual(saved_expand["widgets_values"][2], 102)
        self.assertFalse(saved_expand["widgets_values"][8])

    def test_execution_path_keeps_matrix_rows_with_the_same_visible_sources(self):
        base = self.nodes.with_source_node(
            self.nodes.transform(None, lambda row, _item: {**row, "positive_parts": ["base"]}),
            "scene",
        )
        matrix = self.nodes.SceneMatrix().build(
            json.dumps({"version": 1, "sets": [_matrix_line("one"), _matrix_line("two")]}),
            scene_prompt=base,
            unique_id="matrix",
        )[0]
        info = self.nodes.ScenePromptExpand().expand(
            current_index=1,
            seed_base=200,
            timestamp_dir=False,
            scene_prompt=matrix,
            unique_id="expand",
        )[2]
        prompt = {
            "scene": {"class_type": "ScenePrompter", "inputs": {}},
            "matrix": {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["scene", 0]}},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["matrix", 0], "current_index": 1, "seed_base": 200}},
            "save": {"class_type": "SceneSaveImage", "inputs": {"images": ["expand", 4]}},
        }
        saved_prompt, _saved_extra = self.nodes._metadata_for_save_mode(
            prompt, None, "save",
            self.nodes.SAVE_METADATA_EXECUTION_PATH, info,
        )
        self.assertEqual(saved_prompt["expand"]["inputs"]["current_index"], 1)
        self.assertEqual(saved_prompt["expand"]["inputs"]["seed_base"], 200)

    def test_replay_visible_sources_distinguish_expanded_nested_preset_only(self):
        left = self.nodes.with_source_node(self.nodes.transform(None, lambda row, _item: row), "20/30/left")
        right = self.nodes.with_source_node(self.nodes.transform(None, lambda row, _item: row), "20/30/right")
        plan = self.nodes.ScenePromptQueue().queue(scene_prompt1=left, scene_prompt2=right)[0]
        info = {"_plan_ref": plan, "row_index": 1, "repeat_index": 1, "seed": 50, "source_node_ids": ["20/30/right", "expand"]}
        preset_closed = {
            "20": {"class_type": "ScenePresetReference", "inputs": {}},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {}},
        }
        preset_open = {
            "left": {"class_type": "ScenePrompter", "inputs": {}},
            "right": {"class_type": "ScenePrompter", "inputs": {}},
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {}},
        }
        self.assertEqual(self.nodes._replay_expand_values(info, preset_closed), {"current_index": 1, "seed_base": 49, "seed_base_literal": False})
        self.assertEqual(
            self.nodes._replay_expand_values(
                info, preset_open, {"left": "20/30/left", "right": "20/30/right", "expand": "expand"}
            ),
            {"current_index": 0, "seed_base": 50, "seed_base_literal": False},
        )

    def test_literal_zero_seed_replays_after_wraparound(self):
        self.assertIn("seed_base_literal", self.nodes.ScenePromptExpand.INPUT_TYPES()["optional"])
        plan = self.nodes.with_source_node(self.nodes.transform(None, lambda row, _item: row), "scene")
        info = {
            "_plan_ref": plan,
            "row_index": 0,
            "repeat_index": 1,
            "seed": 0,
            "source_node_ids": ["scene", "expand"],
        }
        values = self.nodes._replay_expand_values(
            info,
            {"scene": {"class_type": "ScenePrompter", "inputs": {}}, "expand": {"class_type": "ScenePrompterExpand", "inputs": {}}},
        )
        self.assertEqual(values, {"current_index": 0, "seed_base": 0, "seed_base_literal": True})
        replay = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=0,
            seed_base_literal=True,
            timestamp_dir=False,
            scene_prompt=plan,
        )
        self.assertEqual(replay[3], 0)

    def test_replay_preserves_saved_expand_widget_layouts(self):
        layouts = (
            ([3, "run", 100, False, "prefix_", "Anima", 13, "停止", False], 8),
            ([3, "run", 100, False, "prefix_", None, 13, "停止", False], 8),
            ([3, "run", 100, False, "prefix_", True, False, 13, "停止", False], 9),
            ([3, "run", 100, False, "prefix_", "最後", True, False, 13, "停止", False], 10),
            ([3, "run", 100, False, "prefix_", "最後", True, False, "停止", False], 9),
            ([3, "run", 100, False, "prefix_", "最後", True, False, None, None, False], 10),
            ([3, "run", 100, False, "prefix_", "最後", True, False, None, False], 9),
            ([3, "run", 100, False, "prefix_", None, True, False, None, None, False], 10),
            ([3, "run", 100, False, "prefix_", None, True, False, None, False], 9),
            ([3, "run", 100, False, "prefix_", "最後", "Anima", True, False, "停止", False], 10),
            ([3, "run", 100, False, "prefix_", "最後", None, True, False, None, False], 10),
        )
        for seed in (0, 42):
            for widgets, literal_index in layouts:
                with self.subTest(seed=seed, widgets=widgets):
                    plan = self.nodes.with_source_node(self.nodes.transform(None, lambda row, _item: row), "scene")
                    info = {"_plan_ref": plan, "row_index": 0, "repeat_index": 1, "seed": seed,
                            "source_node_ids": ["scene", "expand"]}
                    prompt = {
                        "scene": {"class_type": "ScenePrompter", "inputs": {}},
                        "expand": {"class_type": "ScenePrompterExpand", "inputs": {"current_index": 3, "seed_base": 100,
                            "callback_timeout_seconds": 13, "callback_failure_mode": "停止", "timestamp_dir": False}},
                    }
                    connected_input = "model_mode" if literal_index == 8 else "counter_position"
                    workflow = {"nodes": [{"id": "expand", "type": "ScenePrompterExpand", "widgets_values": list(widgets),
                        "inputs": [{"name": connected_input, "link": 123}] if widgets[5] is None else []}]}
                    values = self.nodes._replay_expand_values(info, prompt)
                    self.nodes._apply_replay_expand_values(prompt, workflow, info, values)
                    expected = list(widgets)
                    expected[0], expected[2], expected[literal_index] = 0, seed, seed == 0
                    self.assertEqual(workflow["nodes"][0]["widgets_values"], expected)
                    self.assertEqual(prompt["expand"]["inputs"]["callback_timeout_seconds"], 13)
                    replay = self.nodes.ScenePromptExpand().expand(scene_prompt=plan, **prompt["expand"]["inputs"])
                    self.assertEqual(replay[3], seed)

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

        current_node_names = {
            "ScenePrompter",
            "SceneMatrix",
            "ScenePath",
            "ScenePrompterMerge",
            "ScenePromptCounter",
            "ScenePromptReverse",
            "ScenePromptDelete",
            "ScenePromptToText",
            "ScenePrompterQueue",
            "ScenePromptCallback",
            "ScenePromptCallbackDiscord",
            "ScenePromptCallbackRequest",
            "ScenePromptCallbackDesktop",
            "SceneEmptyLatent",
            "SceneApplyModel",
            "SceneApplyLora",
            "ScenePrompterExpand",
            "SceneSaveImage",
            "ScenePresetInput",
            "ScenePresetOutput",
            "ScenePresetReference",
        }
        self.assertSetEqual(set(package.NODE_CLASS_MAPPINGS), current_node_names)
        self.assertEqual(
            package.NODE_DISPLAY_NAME_MAPPINGS,
            {
                "ScenePrompter": "Scene Prompt",
                "SceneMatrix": "Scene Matrix",
                "ScenePath": "Scene Path",
                "ScenePrompterMerge": "Scene Prompt Merge",
                "ScenePromptCounter": "Scene Prompt Count",
                "ScenePromptReverse": "Scene Prompt Reverse",
                "ScenePromptDelete": "Scene Prompt Delete",
                "ScenePromptToText": "Scene Prompt To Text",
                "ScenePrompterQueue": "Scene Prompt Queue",
                "ScenePromptCallback": "Scene Prompt Callback",
                "ScenePromptCallbackDiscord": "Scene Prompt Callback (Discord)",
                "ScenePromptCallbackRequest": "Scene Prompt Callback (Request)",
                "ScenePromptCallbackDesktop": "Scene Prompt Callback (Desktop)",
                "SceneEmptyLatent": "Scene Empty Latent",
                "SceneApplyModel": "Scene Apply Model",
                "SceneApplyLora": "Scene Apply LoRA",
                "ScenePrompterExpand": "Scene Prompt Expand",
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

    def test_expand_uses_clear_position_and_seed_labels(self):
        required = self.nodes.ScenePromptExpand.INPUT_TYPES()["required"]
        self.assertEqual(required["current_index"][1]["display_name"], "生成番号")
        self.assertEqual(required["seed_base"][1]["display_name"], "開始シード")


if __name__ == "__main__":
    unittest.main()
