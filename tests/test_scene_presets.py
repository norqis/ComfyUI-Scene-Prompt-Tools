import importlib
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


install_torch_stub()

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"
COMFY_ROOT = ROOT.parents[1]


def install_stubs(user_directory):
    install_comfy_execution_stub()
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_user_directory = lambda: str(user_directory)
    folder_paths.get_output_directory = lambda: str(user_directory / "output")
    sys.modules["folder_paths"] = folder_paths

    comfy = types.ModuleType("comfy")
    model_management = types.ModuleType("comfy.model_management")
    model_management.intermediate_device = lambda: "cpu"
    model_management.intermediate_dtype = lambda: __import__("torch").float32
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    comfy.model_management = model_management
    sys.modules["comfy"] = comfy
    sys.modules["comfy.model_management"] = model_management
    sys.modules["comfy.cli_args"] = cli_args


def load_presets_module(user_directory):
    install_stubs(user_directory)
    if str(COMFY_ROOT) not in sys.path:
        sys.path.insert(0, str(COMFY_ROOT))
    package_name = "scene_preset_test"
    for module_name in list(sys.modules):
        if module_name == package_name or module_name.startswith(f"{package_name}."):
            del sys.modules[module_name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return importlib.import_module(f"{package_name}.presets")


def graph(nodes):
    return {"output": nodes}


def basic_nodes(positive="first"):
    return {
        "1": {"class_type": "ScenePresetInput", "inputs": {}},
        "2": {
            "class_type": "ScenePrompt",
            "inputs": {
                "prompt_name": "Preset prompt",
                "positive_base": positive,
                "positive_json": "{\"version\":1,\"categories\":{}}",
                "negative_base": "",
                "negative_json": "{\"version\":1,\"categories\":{}}",
                "category_order": "",
                "seed": 0,
                "randomize": True,
                "scene_prompt": ["1", 0],
            },
        },
        "3": {
            "class_type": "ScenePresetOutput",
            "inputs": {"preset_id": "test", "preset_name": "Test", "scene_prompt": ["2", 0]},
        },
    }


def matrix_line(name, **overrides):
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
        "positive_json": "{\"version\":1,\"categories\":{}}",
        "negative_base": "",
        "negative_json": "{\"version\":1,\"categories\":{}}",
        "category_order": "",
        "positive_parts": [],
        "negative_parts": [],
        "display_labels": [],
        "display_label_groups": [],
    }
    line.update(overrides)
    return line


class ScenePresetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.module = load_presets_module(self.root)
        self.nodes = sys.modules[f"{self.module.__package__}.nodes"]

    def tearDown(self):
        self.temp.cleanup()

    def save(self, preset_id, nodes, name=None, workflow=None):
        return self.module.save_preset({
            "preset_id": preset_id,
            "name": name or preset_id,
            "api_graph": graph(nodes),
            "workflow": workflow or {"version": 1, "nodes": []},
        })

    def test_save_is_atomic_and_revision_hash_increase(self):
        first = self.save("preset_a", basic_nodes("first"))
        path = self.module._preset_path("preset_a")
        self.assertTrue(path.exists())
        self.assertEqual(first["metadata"]["revision"], 1)
        self.assertEqual(len(first["metadata"]["sha256"]), 64)
        self.assertFalse(list(path.parent.glob("*.tmp")))

        second = self.save("preset_a", basic_nodes("second"), "Renamed")
        self.assertEqual(second["metadata"]["revision"], 2)
        self.assertNotEqual(first["metadata"]["sha256"], second["metadata"]["sha256"])
        with path.open("r", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["metadata"]["name"], "Renamed")

    def test_atomic_save_validates_temp_before_replace(self):
        first = self.save("atomic", basic_nodes("first"))
        original_validator = self.module._validate_preset_payload

        def reject_second_revision(payload):
            if payload["metadata"]["revision"] == 2:
                raise self.module.ScenePresetError("一時ファイルの検証に失敗しました。")
            return original_validator(payload)

        self.module._validate_preset_payload = reject_second_revision
        try:
            with self.assertRaisesRegex(self.module.ScenePresetError, "一時ファイル"):
                self.save("atomic", basic_nodes("second"))
        finally:
            self.module._validate_preset_payload = original_validator

        with self.module._preset_path("atomic").open("r", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["metadata"]["revision"], first["metadata"]["revision"])

    def test_overwrite_rejects_a_corrupt_existing_preset_without_mutation(self):
        self.save("corrupt", basic_nodes("first"))
        path = self.module._preset_path("corrupt")
        path.write_text('{"schema_version":0}', encoding="utf-8")
        original = path.read_text(encoding="utf-8")
        with self.assertRaises(self.module.ScenePresetError):
            self.save("corrupt", basic_nodes("second"))
        self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_validation_rejects_missing_boundary_and_unused_node(self):
        nodes = basic_nodes()
        del nodes["3"]
        with self.assertRaisesRegex(self.module.ScenePresetError, "Output"):
            self.save("missing_output", nodes)

        nodes = basic_nodes()
        nodes["4"] = {"class_type": "ScenePrompt", "inputs": {}}
        with self.assertRaisesRegex(self.module.ScenePresetError, "到達"):
            self.save("unused", nodes)

    def test_validation_rejects_cycle_and_nonzero_output_index(self):
        nodes = basic_nodes()
        nodes["2"]["inputs"]["scene_prompt"] = ["4", 0]
        nodes["4"] = {"class_type": "ScenePath", "inputs": {"scene_prompt": ["2", 0]}}
        with self.assertRaisesRegex(self.module.ScenePresetError, "循環"):
            self.save("cycle", nodes)

        nodes = basic_nodes()
        nodes["3"]["inputs"]["scene_prompt"] = ["2", 1]
        with self.assertRaisesRegex(self.module.ScenePresetError, "出力0"):
            self.save("bad_output", nodes)

    def test_workflow_rejects_unexecuted_nodes_and_ignores_annotations(self):
        workflow = {
            "version": 1,
            "nodes": [
                {"id": 1, "type": "ScenePresetInput"},
                {"id": 2, "type": "ScenePrompt"},
                {"id": 3, "type": "ScenePresetOutput"},
                {"id": 90, "type": "Reroute"},
                {"id": 91, "type": "Note"},
                {"id": 92, "type": "KSampler"},
            ],
        }
        with self.assertRaisesRegex(self.module.ScenePresetError, "KSampler #92"):
            self.save("workflow_side_effect", basic_nodes(), workflow=workflow)

        workflow["nodes"] = workflow["nodes"][:-1]
        self.save("workflow_annotations", basic_nodes(), workflow=workflow)

    def test_node_expansion_keeps_existing_scene_nodes_and_links(self):
        nodes = basic_nodes()
        nodes["4"] = {
            "class_type": "ScenePromptQueue",
            "inputs": {"scene_prompt1": ["2", 0]},
        }
        nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]
        self.save("expanded", nodes)
        result = self.module.expand_preset_reference("expanded", ["outer", 0], "")
        self.assertIn("result", result)
        self.assertIn("expand", result)
        queue = next(value for value in result["expand"].values() if value["class_type"] == "ScenePromptQueue")
        self.assertEqual(queue["inputs"]["scene_prompt1"][1], 0)
        prompt = next(value for value in result["expand"].values() if value["class_type"] == "ScenePrompt")
        self.assertEqual(prompt["inputs"]["scene_prompt"], ["outer", 0])

        source_result = self.module.expand_preset_reference("expanded")
        self.assertTrue(any(value["class_type"] == "ScenePresetInput" for value in source_result["expand"].values()))

    def test_queue_matrix_merge_order_is_preserved_by_scene_nodes(self):
        matrix = self.module.SceneMatrix().build(
            json.dumps({"version": 1, "sets": [
                matrix_line("A", positive_parts=["a"]),
                matrix_line("B", positive_parts=["b"]),
            ]}),
        )[0]
        right = self.module.ScenePrompt().build(
            "Right", "right", "{\"version\":1,\"categories\":{}}", "", "{\"version\":1,\"categories\":{}}", "", 0, True,
        )[0]
        merged = self.module.ScenePromptMerge().merge(matrix, right)[0]
        queued = self.module.ScenePromptQueue().queue(scene_prompt1=merged, scene_prompt2=matrix)[0]
        labels = [item["row"]["labels"] for item in self.nodes.normalize_plan(queued)["rows"]]
        self.assertEqual(labels, [["A", "Right"], ["B", "Right"], ["A"], ["B"]])
        self.assertEqual(queued["total_images"], 4)

    def test_preset_can_start_from_an_unconnected_optional_scene_input(self):
        nodes = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {
                "class_type": "SceneEmptyLatent",
                "inputs": {"width": 832, "height": 1216, "batch_size": 2},
            },
            "3": {
                "class_type": "ScenePresetOutput",
                "inputs": {"scene_prompt": ["2", 0]},
            },
        }
        self.save("standalone", nodes)
        expanded = self.module.expand_preset_reference("standalone")
        self.assertFalse(any(
            node["class_type"] == "ScenePresetInput"
            for node in expanded["expand"].values()
        ))

        result = self.module.snapshot_presets_for_run("standalone-run", graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "standalone"}},
            "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
        }), "11")
        self.assertEqual(result["total_batches"], 1)
        self.assertEqual(result["total_images"], 2)

    def test_nested_cycle_is_rejected_when_snapshotting(self):
        a_nodes = basic_nodes()
        a_nodes["2"] = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "preset_b", "scene_prompt": ["1", 0]}}
        self.save("preset_a", a_nodes)
        b_nodes = basic_nodes()
        b_nodes["2"] = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "preset_a", "scene_prompt": ["1", 0]}}
        self.save("preset_b", b_nodes)
        with self.assertRaisesRegex(self.module.ScenePresetError, "循環"):
            self.module.snapshot_presets_for_run("run-cycle", graph({
                "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "preset_a"}},
                "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
            }), "11")

    def test_run_snapshot_is_fixed_after_later_save(self):
        self.save("fixed", basic_nodes("first"))
        self.module.snapshot_presets_for_run("run-fixed", graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
        }), "11")
        self.save("fixed", basic_nodes("second"))
        result = self.module.expand_preset_reference("fixed", ["outer", 0], "run-fixed")
        prompt = next(value for value in result["expand"].values() if value["class_type"] == "ScenePrompt")
        self.assertEqual(prompt["inputs"]["positive_base"], "first")
        self.module.release_scene_preset_snapshot("run-fixed")
        fresh = self.module.expand_preset_reference("fixed", ["outer", 0], "")
        prompt = next(value for value in fresh["expand"].values() if value["class_type"] == "ScenePrompt")
        self.assertEqual(prompt["inputs"]["positive_base"], "second")

    def test_run_snapshot_never_falls_back_to_latest_preset(self):
        self.save("fixed", basic_nodes("first"))
        with self.assertRaisesRegex(self.module.ScenePresetError, "スナップショットがありません"):
            self.module.expand_preset_reference("fixed", ["outer", 0], "missing-run")

        self.module.snapshot_presets_for_run(
            "run-without-fixed",
            graph({
                "10": {"class_type": "ScenePresetInput", "inputs": {}},
                "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
            }),
            "11",
        )
        with self.assertRaisesRegex(self.module.ScenePresetError, "含まれていません"):
            self.module.expand_preset_reference("fixed", ["outer", 0], "run-without-fixed")

    def test_cancel_tombstone_rejects_snapshot_before_save(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        self.module.release_scene_preset_snapshot("cancelled-before-save")
        with self.assertRaisesRegex(self.module.ScenePresetError, "キャンセル"):
            self.module.snapshot_presets_for_run("cancelled-before-save", api_graph, "11")
        self.assertNotIn("cancelled-before-save", self.module._RUN_SNAPSHOTS)

    def test_cancel_race_releases_snapshot_after_resolve_has_started(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        started = threading.Event()
        continue_resolve = threading.Event()
        result = {}
        original = self.module._resolve_preset_tree

        def delayed_resolve(*args, **kwargs):
            started.set()
            self.assertTrue(continue_resolve.wait(2))
            return original(*args, **kwargs)

        self.module._resolve_preset_tree = delayed_resolve
        try:
            resolver = threading.Thread(
                target=lambda: result.setdefault("value", self.module.snapshot_presets_for_run("race-run", api_graph, "11")),
            )
            resolver.start()
            self.assertTrue(started.wait(2))
            releaser = threading.Thread(target=lambda: self.module.release_scene_preset_snapshot("race-run"))
            releaser.start()
            self.assertTrue(releaser.is_alive())
            continue_resolve.set()
            resolver.join(2)
            releaser.join(2)
        finally:
            self.module._resolve_preset_tree = original
        self.assertIn("value", result)
        self.assertNotIn("race-run", self.module._RUN_SNAPSHOTS)
        with self.assertRaisesRegex(self.module.ScenePresetError, "スナップショットがありません"):
            self.module.expand_preset_reference("fixed", ["outer", 0], "race-run")

    def test_snapshot_ignores_references_outside_selected_expand_closure(self):
        self.save("reachable", basic_nodes("reachable"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "reachable"}},
            "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "missing_preset"}},
            "21": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["20", 0]}},
        })
        result = self.module.snapshot_presets_for_run("run-closure", api_graph, "11")
        self.assertEqual([item["preset_id"] for item in result["presets"]], ["reachable"])
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "missing_preset") as error:
            self.module.snapshot_presets_for_run("run-other-closure", api_graph, "21")
        self.assertEqual(error.exception.node_id, "20")

    def test_nested_preset_failure_keeps_outer_reference_node_id(self):
        outer_nodes = basic_nodes()
        outer_nodes["2"] = {
            "class_type": "ScenePresetReference",
            "inputs": {"preset_id": "missing_nested", "scene_prompt": ["1", 0]},
        }
        self.save("outer", outer_nodes)
        api_graph = graph({
            "42": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "outer"}},
            "43": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["42", 0]}},
        })
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "missing_nested") as error:
            self.module.snapshot_presets_for_run("run-nested-error", api_graph, "43")
        self.assertEqual(error.exception.node_id, "42")

    def test_empty_top_level_reference_keeps_its_node_id(self):
        api_graph = graph({
            "51": {"class_type": "ScenePresetReference", "inputs": {"preset_id": ""}},
            "52": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["51", 0]}},
        })
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "preset_id") as error:
            self.module.snapshot_presets_for_run("run-empty-reference", api_graph, "52")
        self.assertEqual(error.exception.node_id, "51")

    def test_lists_saved_presets(self):
        self.save("zeta", basic_nodes(), "Zeta")
        self.save("alpha", basic_nodes(), "Alpha")
        listed = self.module.list_presets()
        self.assertEqual(
            [item["metadata"]["preset_id"] for item in listed["presets"]],
            ["alpha", "zeta"],
        )
        self.assertEqual(listed["errors"], [])

    def test_list_skips_corrupt_preset_and_keeps_valid_entries(self):
        self.save("valid", basic_nodes(), "Valid")
        broken = self.module._preset_path("broken")
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("{not json", encoding="utf-8")
        listed = self.module.list_presets()
        self.assertEqual([item["metadata"]["preset_id"] for item in listed["presets"]], ["valid"])
        self.assertEqual([item["preset_id"] for item in listed["errors"]], ["broken"])

    def test_real_scene_executor_keeps_matrix_merge_queue_path_latent_and_primitive_count(self):
        nodes = basic_nodes("left")
        nodes["4"] = {
            "class_type": "SceneMatrix",
            "inputs": {
                "matrix_json": json.dumps({
                    "version": 1,
                    "sets": [
                        matrix_line("A", positive_parts=["a"]),
                        matrix_line("B", positive_parts=["b"]),
                    ],
                }),
                "scene_prompt": ["2", 0],
            },
        }
        nodes["5"] = {
            "class_type": "ScenePrompt",
            "inputs": {
                "prompt_name": "right",
                "positive_base": "right",
                "positive_json": "{\"version\":1,\"categories\":{}}",
                "negative_base": "",
                "negative_json": "{\"version\":1,\"categories\":{}}",
                "category_order": "",
                "seed": 0,
                "randomize": True,
            },
        }
        nodes["6"] = {"class_type": "ScenePromptMerge", "inputs": {"scene_prompt1": ["4", 0], "scene_prompt2": ["5", 0]}}
        nodes["7"] = {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["6", 0], "count": 2}}
        nodes["8"] = {"class_type": "ScenePath", "inputs": {"scene_prompt": ["7", 0], "path_name": "preset_path", "path_mode": "directory"}}
        nodes["9"] = {"class_type": "SceneEmptyLatent", "inputs": {"scene_prompt": ["8", 0], "width": 832, "height": 1216, "batch_size": 1}}
        nodes["10"] = {"class_type": "ScenePromptQueue", "inputs": {"scene_prompt1": ["9", 0], "scene_prompt2": ["4", 0]}}
        nodes["3"]["inputs"]["scene_prompt"] = ["10", 0]
        self.save("integrated", nodes)
        expanded = self.module.expand_preset_reference("integrated", ["outer", 0])
        expanded_classes = {node["class_type"] for node in expanded["expand"].values()}
        self.assertTrue({"SceneMatrix", "ScenePromptMerge", "ScenePromptCounter", "ScenePath", "SceneEmptyLatent", "ScenePromptQueue"}.issubset(expanded_classes))
        api_graph = graph({
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "integrated"}},
            "21": {"class_type": "PrimitiveInt", "inputs": {"value": 3}},
            "22": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["20", 0], "count": ["21", 0]}},
            "23": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["22", 0]}},
        })
        result = self.module.snapshot_presets_for_run("run-integrated", api_graph, "23")
        self.assertEqual(result["total_images"], 18)
        scene = self.module._scene_node_value(
            api_graph["output"], "22", {"integrated": self.module.load_preset("integrated")}, set()
        )
        self.assertEqual(scene["total_images"], 18)
        self.assertEqual(
            [item["row"]["labels"] for item in scene["rows"]],
            [["Preset prompt", "A", "right"], ["Preset prompt", "B", "right"], ["Preset prompt", "A"], ["Preset prompt", "B"]],
        )
        self.assertEqual(scene["rows"][0]["row"]["path_parts"], ["preset_path"])
        self.assertEqual(scene["rows"][0]["row"]["latent"], {"width": 832, "height": 1216, "batch_size": 1})

    def test_snapshot_uses_real_scene_nodes_for_expand_total(self):
        nodes = basic_nodes()
        nodes["4"] = {
            "class_type": "SceneMatrix",
            "inputs": {
                "matrix_json": json.dumps({
                    "version": 1,
                    "sets": [
                        matrix_line("A"),
                        matrix_line("B"),
                    ],
                }),
                "scene_prompt": ["2", 0],
            },
        }
        nodes["5"] = {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["4", 0]}}
        del nodes["3"]
        self.save("total", nodes)
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "total"}},
            "11": {"class_type": "ScenePromptExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        result = self.module.snapshot_presets_for_run("run-total", api_graph, "11")
        self.assertEqual(result["total_images"], 2)


if __name__ == "__main__":
    unittest.main()
