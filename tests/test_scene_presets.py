import importlib
import json
import copy
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
    folder_paths.get_public_user_directory = lambda user_id: str(user_directory / user_id)
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
            "class_type": "ScenePrompter",
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
        self.preset_metadata = importlib.import_module(f"{self.module.__package__}.preset_metadata")

    def tearDown(self):
        self.temp.cleanup()

    def save(self, preset_id, nodes, name=None, workflow=None, user_id="default", output_node_id=None, expected_revision=None):
        if output_node_id is None:
            output_node_id = next((
                str(node_id) for node_id, node in nodes.items()
                if isinstance(node, dict) and node.get("class_type") == "ScenePresetOutput"
            ), "3")
        payload = {
            "preset_id": preset_id,
            "name": name or preset_id,
            "output_node_id": output_node_id,
            "api_graph": graph(nodes),
            "workflow": workflow or {"version": 1, "nodes": []},
        }
        if expected_revision is not None:
            payload["expected_revision"] = expected_revision
        return self.module.save_preset(payload, user_id)

    def write_preset_without_runtime_validation(self, preset_id, nodes, user_id="default"):
        workflow = {"version": 1, "nodes": []}
        api_graph = graph(nodes)
        payload = {
            "schema_version": self.module.PRESET_SCHEMA_VERSION,
            "metadata": {
                "preset_id": preset_id,
                "name": preset_id,
                "revision": 1,
                "sha256": self.module._content_hash(api_graph, workflow),
            },
            "workflow": workflow,
            "api_graph": api_graph,
        }
        path = self.module._preset_path(preset_id, user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def selected_prompt_json(self):
        return json.dumps({
            "version": 1,
            "categories": {
                "Emotion": [{
                    "id": "fear",
                    "label": "怯え",
                    "prompt": "scared",
                    "category_path": ["Emotion"],
                    "category_key": "Emotion",
                    "category_label": "Emotion",
                }],
            },
        }, ensure_ascii=False)

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

    def test_save_rejects_a_stale_editor_revision_without_mutation(self):
        first = self.save("revision", basic_nodes("first"))
        second = self.save("revision", basic_nodes("second"), expected_revision=first["metadata"]["revision"])
        with self.assertRaisesRegex(self.module.ScenePresetConflictError, "別のタブ"):
            self.save("revision", basic_nodes("stale"), expected_revision=first["metadata"]["revision"])
        saved = self.module.load_preset("revision")
        self.assertEqual(saved["metadata"]["revision"], second["metadata"]["revision"])
        self.assertEqual(saved["api_graph"]["output"]["2"]["inputs"]["positive_base"], "second")

    def test_preset_requires_connected_input_and_single_output(self):
        missing_input = basic_nodes()
        del missing_input["1"]
        missing_input["2"]["inputs"].pop("scene_prompt")
        with self.assertRaisesRegex(self.module.ScenePresetError, "Input は1個だけ必要"):
            self.save("missing-input", missing_input)

        disconnected_input = basic_nodes()
        disconnected_input["2"]["inputs"].pop("scene_prompt")
        with self.assertRaisesRegex(self.module.ScenePresetError, "Output へ接続"):
            self.module._validate_preset_graph(disconnected_input)

        multiple_output = basic_nodes()
        multiple_output["4"] = {
            "class_type": "ScenePresetOutput",
            "inputs": {"scene_prompt": ["2", 0]},
        }
        with self.assertRaisesRegex(self.module.ScenePresetError, "Output は1個だけ必要"):
            self.module._validate_preset_graph(multiple_output)

    def test_save_selected_scene_prompt_does_not_require_a_generation_context(self):
        nodes = basic_nodes()
        nodes["2"]["inputs"]["positive_json"] = self.selected_prompt_json()

        saved = self.save("selected-prompt", nodes)

        self.assertEqual(saved["metadata"]["preset_id"], "selected-prompt")

    def test_save_selected_matrix_does_not_require_a_generation_context(self):
        nodes = basic_nodes()
        nodes["4"] = {
            "class_type": "SceneMatrix",
            "inputs": {
                "matrix_json": json.dumps({
                    "version": 1,
                    "sets": [matrix_line("Fear", positive_json=self.selected_prompt_json())],
                }, ensure_ascii=False),
                "scene_prompt": ["2", 0],
            },
        }
        nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]

        saved = self.save("selected-matrix", nodes)

        self.assertEqual(saved["metadata"]["preset_id"], "selected-matrix")

    def test_save_nested_selected_prompt_uses_only_the_stored_selection(self):
        inner = basic_nodes()
        inner["2"]["inputs"]["positive_json"] = self.selected_prompt_json()
        self.save("selected-inner", inner, user_id="alice")
        outer = basic_nodes()
        outer["2"] = {
            "class_type": "ScenePresetReference",
            "inputs": {"preset_id": "selected-inner", "scene_prompt": ["1", 0]},
        }

        saved = self.save("selected-outer", outer, user_id="alice")

        self.assertEqual(saved["metadata"]["preset_id"], "selected-outer")

    def test_selected_prompt_uses_the_value_stored_in_the_node(self):
        plan = self.module.ScenePrompt().build(
            "Prompt",
            "",
            self.selected_prompt_json(),
            "",
            '{"version":1,"categories":{}}',
            "",
            0,
            True,
        )[0]

        self.assertEqual(plan["rows"][0]["row"]["positive_parts"], ["scared"])

    def test_preset_paths_reject_untrusted_user_ids(self):
        for user_id in ("", "../outside", "/outside", "C:" + chr(92) + "outside", "__system"):
            with self.subTest(user_id=user_id):
                with self.assertRaises(self.module.ScenePresetError):
                    self.module.preset_directory(user_id)

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

    def test_validation_rejects_missing_output_and_ignores_disconnected_nodes(self):
        nodes = basic_nodes()
        del nodes["3"]
        with self.assertRaisesRegex(self.module.ScenePresetError, "保存元"):
            self.save("missing_output", nodes)

        nodes = basic_nodes()
        nodes["4"] = {"class_type": "ScenePrompter", "inputs": {}}
        saved = self.save("unused", nodes)
        self.assertSetEqual(set(saved["api_graph"]["output"]), {"1", "2", "3"})

    def test_save_prunes_disconnected_workflow_nodes_and_links(self):
        nodes = basic_nodes()
        nodes["12"] = {"class_type": "ScenePrompter", "inputs": {}}
        workflow = {
            "version": 1,
            "nodes": [
                {"id": 1, "type": "ScenePresetInput"},
                {"id": 2, "type": "ScenePrompter"},
                {"id": 3, "type": "ScenePresetOutput"},
                {"id": 12, "type": "ScenePrompter", "title": "パニック・恐怖"},
            ],
            "links": [
                [1, 1, 0, 2, 0, "SCENE_PROMPT"],
                [2, 2, 0, 3, 0, "SCENE_PROMPT"],
                [3, 12, 0, 12, 0, "SCENE_PROMPT"],
            ],
        }
        saved = self.save("connected_only", nodes, workflow=workflow)
        self.assertEqual([node["id"] for node in saved["workflow"]["nodes"]], [1, 2, 3])
        self.assertEqual([link[0] for link in saved["workflow"]["links"]], [1, 2])

    def test_save_uses_the_output_node_that_requested_the_save(self):
        nodes = basic_nodes("first")
        nodes["4"] = {
            "class_type": "ScenePrompter",
            "inputs": {
                **nodes["2"]["inputs"],
                "positive_base": "second",
                "scene_prompt": ["1", 0],
            },
        }
        nodes["5"] = {
            "class_type": "ScenePresetOutput",
            "inputs": {"scene_prompt": ["4", 0]},
        }
        saved = self.save("second_output", nodes, output_node_id="5")
        self.assertSetEqual(set(saved["api_graph"]["output"]), {"1", "4", "5"})
        self.assertEqual(saved["api_graph"]["output"]["4"]["inputs"]["positive_base"], "second")

    def test_validation_rejects_cycle_and_nonzero_output_index(self):
        nodes = basic_nodes()
        nodes["2"] = {
            "class_type": "ScenePrompterMerge",
            "inputs": {"scene_prompt1": ["1", 0], "scene_prompt2": ["4", 0]},
        }
        nodes["4"] = {"class_type": "ScenePath", "inputs": {"scene_prompt": ["2", 0]}}
        with self.assertRaisesRegex(self.module.ScenePresetError, "循環"):
            self.save("cycle", nodes)

        nodes = basic_nodes()
        nodes["3"]["inputs"]["scene_prompt"] = ["2", 1]
        with self.assertRaisesRegex(self.module.ScenePresetError, "出力0"):
            self.save("bad_output", nodes)

    def test_workflow_ignores_disconnected_execution_nodes_and_annotations(self):
        workflow = {
            "version": 1,
            "nodes": [
                {"id": 1, "type": "ScenePresetInput"},
                {"id": 2, "type": "ScenePrompter"},
                {"id": 3, "type": "ScenePresetOutput"},
                {"id": 90, "type": "Reroute"},
                {"id": 91, "type": "Note"},
                {"id": 92, "type": "KSampler"},
            ],
        }
        saved = self.save("workflow_side_effect", basic_nodes(), workflow=workflow)
        self.assertEqual([node["id"] for node in saved["workflow"]["nodes"]], [1, 2, 3])

    def test_node_expansion_keeps_existing_scene_nodes_and_links(self):
        nodes = basic_nodes()
        nodes["4"] = {
            "class_type": "ScenePrompterQueue",
            "inputs": {"scene_prompt1": ["2", 0]},
        }
        nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]
        self.save("expanded", nodes)
        result = self.module.expand_preset_reference(
            "expanded",
            ["outer", 0],
            "",
            source_node_id="reference_20",
        )
        self.assertIn("result", result)
        self.assertIn("expand", result)
        queue = next(value for value in result["expand"].values() if value["class_type"] == "ScenePrompterQueue")
        self.assertEqual(queue["inputs"]["scene_prompt1"][1], 0)
        prompt = next(value for value in result["expand"].values() if value["class_type"] == "ScenePrompter")
        self.assertEqual(prompt["inputs"]["scene_prompt"], ["outer", 0])
        marker = result["expand"]["__scene_preset_source"]
        self.assertEqual(marker["class_type"], "ScenePromptCounter")
        self.assertEqual(marker["inputs"]["source_node_id"], "reference_20")
        self.assertEqual(result["result"], (["__scene_preset_source", 0],))

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

    def test_preset_input_is_part_of_the_saved_preset_graph(self):
        nodes = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {
                "class_type": "SceneEmptyLatent",
                "inputs": {"scene_prompt": ["1", 0], "width": 832, "height": 1216, "batch_size": 2},
            },
            "3": {
                "class_type": "ScenePresetOutput",
                "inputs": {"scene_prompt": ["2", 0]},
            },
        }
        self.save("standalone", nodes)
        expanded = self.module.expand_preset_reference("standalone")
        self.assertTrue(any(
            node["class_type"] == "ScenePresetInput"
            for node in expanded["expand"].values()
        ))

        result = self.module.snapshot_presets_for_run("standalone-run", graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "standalone"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        }), "11")
        self.assertEqual(result["total_batches"], 1)
        self.assertEqual(result["total_images"], 2)

    def test_nested_cycle_is_rejected_when_snapshotting(self):
        a_nodes = basic_nodes()
        a_nodes["2"] = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "preset_b", "scene_prompt": ["1", 0]}}
        b_nodes = basic_nodes()
        b_nodes["2"] = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "preset_a", "scene_prompt": ["1", 0]}}
        for preset_id, nodes in (("preset_a", a_nodes), ("preset_b", b_nodes)):
            api_graph = graph(nodes)
            workflow = {"version": 1, "nodes": []}
            payload = {
                "schema_version": self.module.PRESET_SCHEMA_VERSION,
                "metadata": {
                    "preset_id": preset_id,
                    "name": preset_id,
                    "revision": 1,
                    "sha256": self.module._content_hash(api_graph, workflow),
                },
                "workflow": workflow,
                "api_graph": api_graph,
            }
            path = self.module._preset_path(preset_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(self.module.ScenePresetError, "循環"):
            self.module.snapshot_presets_for_run("run-cycle", graph({
                "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "preset_a"}},
                "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
            }), "11")

    def test_run_snapshot_is_fixed_after_later_save(self):
        self.save("fixed", basic_nodes("first"))
        self.module.snapshot_presets_for_run("run-fixed", graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        }), "11")
        self.save("fixed", basic_nodes("second"))
        result = self.module.expand_preset_reference("fixed", ["outer", 0], "run-fixed")
        prompt = next(value for value in result["expand"].values() if value["class_type"] == "ScenePrompter")
        self.assertEqual(prompt["inputs"]["positive_base"], "first")
        self.module.release_scene_preset_snapshot("run-fixed")
        fresh = self.module.expand_preset_reference("fixed", ["outer", 0], "")
        prompt = next(value for value in fresh["expand"].values() if value["class_type"] == "ScenePrompter")
        self.assertEqual(prompt["inputs"]["positive_base"], "second")

    def test_run_snapshot_never_falls_back_to_latest_preset(self):
        self.save("fixed", basic_nodes("first"))
        with self.assertRaisesRegex(self.module.ScenePresetError, "スナップショットがありません"):
            self.module.expand_preset_reference("fixed", ["outer", 0], "missing-run")

        self.module.snapshot_presets_for_run(
            "run-without-fixed",
            graph({
                "10": {"class_type": "ScenePresetInput", "inputs": {}},
                "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
            }),
            "11",
        )
        with self.assertRaisesRegex(self.module.ScenePresetError, "含まれていません"):
            self.module.expand_preset_reference("fixed", ["outer", 0], "run-without-fixed")

    def test_cancel_tombstone_rejects_snapshot_before_save(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        self.module.release_scene_preset_snapshot("cancelled-before-save")
        with self.assertRaisesRegex(self.module.ScenePresetError, "キャンセル"):
            self.module.snapshot_presets_for_run("cancelled-before-save", api_graph, "11")
        self.assertNotIn("cancelled-before-save", self.module._RUN_SNAPSHOTS)

    def test_cancel_race_releases_snapshot_after_resolve_has_started(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
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
            def resolve_snapshot():
                try:
                    result["value"] = self.module.snapshot_presets_for_run("race-run", api_graph, "11")
                except Exception as exc:
                    result["error"] = exc

            resolver = threading.Thread(target=resolve_snapshot)
            resolver.start()
            self.assertTrue(started.wait(2))
            releaser = threading.Thread(target=lambda: self.module.release_scene_preset_snapshot("race-run"))
            releaser.start()
            releaser.join(2)
            self.assertFalse(releaser.is_alive())
            continue_resolve.set()
            resolver.join(2)
        finally:
            self.module._resolve_preset_tree = original
        self.assertIsInstance(result.get("error"), self.module.ScenePresetError)
        self.assertNotIn("race-run", self.module._RUN_SNAPSHOTS)
        with self.assertRaisesRegex(self.module.ScenePresetError, "スナップショットがありません"):
            self.module.expand_preset_reference("fixed", ["outer", 0], "race-run")

    def test_cancelled_resolving_run_cannot_be_evicted_and_resurrected(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        started = threading.Event()
        continue_resolve = threading.Event()
        result = {}
        original = self.module._resolve_preset_tree
        original_limit = self.module._CANCELLED_RUNS_MAX_ENTRIES

        def delayed_resolve(*args, **kwargs):
            started.set()
            self.assertTrue(continue_resolve.wait(2))
            return original(*args, **kwargs)

        self.module._resolve_preset_tree = delayed_resolve
        self.module._CANCELLED_RUNS_MAX_ENTRIES = 1
        try:
            def resolve_snapshot():
                try:
                    result["value"] = self.module.snapshot_presets_for_run("protected-run", api_graph, "11")
                except Exception as exc:
                    result["error"] = exc

            resolver = threading.Thread(target=resolve_snapshot)
            resolver.start()
            self.assertTrue(started.wait(2))
            self.module.release_scene_preset_snapshot("protected-run")
            self.module.release_scene_preset_snapshot("other-run-1")
            self.module.release_scene_preset_snapshot("other-run-2")
            self.assertIn(("default", "protected-run"), self.module._CANCELLED_RUNS)
            continue_resolve.set()
            resolver.join(2)
        except Exception as exc:
            result["error"] = exc
        finally:
            self.module._resolve_preset_tree = original
            self.module._CANCELLED_RUNS_MAX_ENTRIES = original_limit
        self.assertFalse(resolver.is_alive())
        self.assertNotIn(("default", "protected-run"), self.module._RUN_SNAPSHOTS)
        self.assertNotIn("value", result)
        self.assertIsInstance(result.get("error"), self.module.ScenePresetError)

    def test_preset_reference_limit_counts_sibling_expansions(self):
        def sized_nodes(positive):
            nodes = basic_nodes(positive)
            previous = "2"
            for index in range(61):
                node_id = str(10 + index)
                nodes[node_id] = {
                    "class_type": "ScenePromptCounter",
                    "inputs": {"scene_prompt": [previous, 0], "count": 1},
                }
                previous = node_id
            nodes["3"]["inputs"]["scene_prompt"] = [previous, 0]
            return nodes

        self.save("left", sized_nodes("left"))
        self.save("right", sized_nodes("right"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "left"}},
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "right"}},
            "30": {
                "class_type": "ScenePrompterQueue",
                "inputs": {"scene_prompt1": ["10", 0], "scene_prompt2": ["20", 0]},
            },
            "40": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["30", 0]}},
        })
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "累積ノード数") as error:
            self.module.snapshot_presets_for_run("siblings-over-limit", api_graph, "40")
        self.assertEqual(error.exception.node_id, "20")

    def test_preset_output_link_rejects_boolean_and_float_indexes(self):
        for name, invalid_index in (("boolean", False), ("float", 0.0)):
            nodes = basic_nodes()
            nodes["2"]["inputs"]["scene_prompt"] = ["1", invalid_index]
            with self.subTest(invalid_index=invalid_index):
                with self.assertRaisesRegex(self.module.ScenePresetError, "出力0だけ"):
                    self.save(f"invalid-output-{name}", nodes)

    def test_concurrent_preset_saves_cannot_commit_a_reference_cycle(self):
        self.save("a", basic_nodes("a"))
        self.save("b", basic_nodes("b"))

        def nodes_referencing(preset_id):
            nodes = basic_nodes()
            nodes["4"] = {
                "class_type": "ScenePresetReference",
                "inputs": {"preset_id": preset_id, "scene_prompt": ["1", 0]},
            }
            nodes["2"]["inputs"]["scene_prompt"] = ["4", 0]
            return nodes

        barrier = threading.Barrier(2)
        results = []

        def save_after_barrier(preset_id, target_id):
            barrier.wait(2)
            try:
                self.save(preset_id, nodes_referencing(target_id))
                results.append((preset_id, "saved"))
            except self.module.ScenePresetError:
                results.append((preset_id, "rejected"))

        workers = [
            threading.Thread(target=save_after_barrier, args=("a", "b")),
            threading.Thread(target=save_after_barrier, args=("b", "a")),
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(2)
            self.assertFalse(worker.is_alive())

        self.assertEqual(sorted(status for _preset_id, status in results), ["rejected", "saved"])

    def test_snapshot_ignores_references_outside_selected_expand_closure(self):
        self.save("reachable", basic_nodes("reachable"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "reachable"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "missing_preset"}},
            "21": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["20", 0]}},
        })
        result = self.module.snapshot_presets_for_run("run-closure", api_graph, "11")
        self.assertEqual([item["preset_id"] for item in result["presets"]], ["reachable"])
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "missing_preset") as error:
            self.module.snapshot_presets_for_run("run-other-closure", api_graph, "21")
        self.assertEqual(error.exception.node_id, "20")

    def test_snapshot_includes_disconnected_workflow_references(self):
        self.save("workflow_only", basic_nodes("workflow only"))
        outer_nodes = basic_nodes("outer")
        outer_nodes.pop("3")
        outer_nodes["11"] = {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["2", 0]}}
        outer_nodes["12"] = {
            "class_type": "SceneSaveImage",
            "inputs": {
                "images": ["13", 0],
                "metadata_mode": "ワークフロー全体",
                "expand_preset_contents": True,
                "scene_info": ["11", 2],
            },
        }
        outer_nodes["13"] = {"class_type": "EmptyImage", "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0}}
        api_graph = graph(outer_nodes)
        workflow = {
            "nodes": [
                {"id": 50, "type": "ScenePresetReference", "widgets_values": ["workflow_only"]},
            ],
            "links": [],
            "groups": [],
        }
        result = self.module.snapshot_presets_for_run(
            "workflow-only-run", api_graph, "11", workflow=workflow
        )
        self.assertEqual([item["preset_id"] for item in result["presets"]], ["workflow_only"])
        snapshots = self.module.snapshot_presets_for_metadata("workflow-only-run")
        self.assertIn("workflow_only", snapshots)
        self.assertEqual(snapshots, self.module._RUN_SNAPSHOTS[("default", "workflow-only-run")]["presets"])
        with self.assertRaises(TypeError):
            snapshots["workflow_only"] = {}
        self.save("workflow_only", basic_nodes("updated"))
        self.assertEqual(
            snapshots["workflow_only"]["api_graph"]["output"]["2"]["inputs"]["positive_base"],
            "workflow only",
        )

    def test_one_shot_full_save_snapshots_canvas_references_without_scene_info(self):
        self.save("workflow_only", basic_nodes("workflow only"))
        nodes = basic_nodes("outer")
        nodes["12"] = {
            "class_type": "SceneSaveImage",
            "inputs": {
                "images": ["13", 0],
                "metadata_mode": "ワークフロー全体",
                "expand_preset_contents": True,
            },
        }
        nodes["13"] = {
            "class_type": "EmptyImage",
            "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0},
        }
        workflow = {
            "nodes": [
                {"id": 50, "type": "ScenePresetReference", "widgets_values": ["workflow_only"]},
            ],
            "links": [],
        }
        result = self.module.snapshot_presets_for_run(
            "one-shot-workflow-run", graph(nodes), workflow=workflow
        )
        self.assertEqual([item["preset_id"] for item in result["presets"]], ["workflow_only"])

    def test_snapshot_ignores_disconnected_workflow_references_without_connected_full_save(self):
        workflow = {
            "nodes": [
                {"id": 50, "type": "ScenePresetReference", "widgets_values": ["missing"]},
            ],
            "links": [],
            "groups": [],
        }
        for label, save_inputs, expand_id in (
            ("no save", None, "2"),
            ("off", {"metadata_mode": "ワークフロー全体", "expand_preset_contents": False, "scene_info": ["2", 2]}, "2"),
            ("prompt only", {"metadata_mode": "プロンプトのみ", "expand_preset_contents": True, "scene_info": ["2", 2]}, "2"),
            ("execution path", {"metadata_mode": "生成経路ノードのみ", "expand_preset_contents": True, "scene_info": ["2", 2]}, "2"),
            ("other expand", {"metadata_mode": "ワークフロー全体", "expand_preset_contents": True, "scene_info": ["4", 2]}, "2"),
        ):
            with self.subTest(label=label):
                current_inputs = {
                    name: value for name, value in basic_nodes("current")["2"]["inputs"].items()
                    if name != "scene_prompt"
                }
                other_inputs = {
                    name: value for name, value in basic_nodes("other")["2"]["inputs"].items()
                    if name != "scene_prompt"
                }
                nodes = {
                    "1": {"class_type": "ScenePrompter", "inputs": current_inputs},
                    "2": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["1", 0]}},
                    "3": {"class_type": "ScenePrompter", "inputs": other_inputs},
                    "4": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["3", 0]}},
                }
                if save_inputs is not None:
                    nodes["9"] = {"class_type": "SceneSaveImage", "inputs": save_inputs}
                result = self.module.snapshot_presets_for_run(
                    f"workflow-ignore-{label}", graph(nodes), expand_id, workflow=workflow
                )
                self.assertEqual(result["presets"], [])

    def test_standard_queue_snapshot_covers_every_expand_branch(self):
        self.save("first", basic_nodes("first branch"))
        self.save("second", basic_nodes("second branch"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "first"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "second"}},
            "21": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["20", 0]}},
        })

        snapshot = self.module.snapshot_presets_for_run("queue-run", api_graph)

        self.assertEqual({item["preset_id"] for item in snapshot["presets"]}, {"first", "second"})
        first = self.module.expand_preset_reference("first", ["outer", 0], "queue-run")
        second = self.module.expand_preset_reference("second", ["outer", 0], "queue-run")
        self.assertTrue(first["expand"])
        self.assertTrue(second["expand"])

    def test_nested_preset_failure_keeps_outer_reference_node_id(self):
        outer_nodes = basic_nodes()
        outer_nodes["2"] = {
            "class_type": "ScenePresetReference",
            "inputs": {"preset_id": "missing_nested", "scene_prompt": ["1", 0]},
        }
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "missing_nested") as error:
            self.save("outer", outer_nodes)
        self.assertEqual(error.exception.node_id, "2")

    def test_save_rejects_runtime_invalid_count_with_node_id(self):
        nodes = basic_nodes()
        nodes["4"] = {
            "class_type": "ScenePromptCounter",
            "inputs": {"scene_prompt": ["2", 0], "count": "not-an-int"},
        }
        nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]
        with self.assertRaisesRegex(self.module.ScenePresetResolutionError, "integer") as error:
            self.save("invalid_count", nodes)
        self.assertEqual(error.exception.node_id, "4")

    def test_save_accepts_only_current_scene_path_choices_and_valid_numeric_range(self):
        choices = self.nodes.ScenePath.INPUT_TYPES()["required"]["path_mode"][0]
        for index, path_mode in enumerate(choices):
            nodes = basic_nodes()
            nodes["4"] = {
                "class_type": "ScenePath",
                "inputs": {"scene_prompt": ["2", 0], "path_name": "chapter", "path_mode": path_mode},
            }
            nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]
            self.save(f"valid-path-mode-{index}", nodes)

        for path_mode in ("directory", "append", "broken"):
            nodes = basic_nodes()
            nodes["4"] = {
                "class_type": "ScenePath",
                "inputs": {"scene_prompt": ["2", 0], "path_name": "chapter", "path_mode": path_mode},
            }
            nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]
            with self.subTest(path_mode=path_mode), self.assertRaises(self.module.ScenePresetResolutionError) as error:
                self.save(f"invalid-path-mode-{path_mode}", nodes)
            self.assertEqual(error.exception.node_id, "4")

        nodes = basic_nodes()
        nodes["4"] = {
            "class_type": "SceneEmptyLatent",
            "inputs": {"scene_prompt": ["2", 0], "width": 1, "height": 1216, "batch_size": 1},
        }
        nodes["3"]["inputs"]["scene_prompt"] = ["4", 0]
        with self.assertRaises(self.module.ScenePresetResolutionError) as error:
            self.save("invalid-latent-width", nodes)
        self.assertEqual(error.exception.node_id, "4")

    def test_nested_counter_chain_has_a_controlled_resolution_limit(self):
        previous_preset_id = None
        def counter_preset_nodes(nested_preset_id, counter_count=20):
            nodes = {"1": {"class_type": "ScenePresetInput", "inputs": {}}}
            source = ["1", 0]
            if nested_preset_id is not None:
                nodes["2"] = {
                    "class_type": "ScenePresetReference",
                    "inputs": {"preset_id": nested_preset_id, "scene_prompt": source},
                }
                source = ["2", 0]
            for counter_index in range(counter_count):
                node_id = str(10 + counter_index)
                nodes[node_id] = {
                    "class_type": "ScenePromptCounter",
                    "inputs": {"scene_prompt": source, "count": 1},
                }
                source = [node_id, 0]
            nodes["3"] = {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": source}}
            return nodes

        self.assertEqual(self.module.MAX_PRESET_REFERENCE_NODE_DEPTH, self.module.MAX_PRESET_NODES)
        for preset_index in range(5):
            nodes = counter_preset_nodes(previous_preset_id)
            preset_id = f"nested-{preset_index}"
            self.write_preset_without_runtime_validation(preset_id, nodes)
            previous_preset_id = preset_id

        at_limit_nodes = counter_preset_nodes(previous_preset_id, counter_count=11)
        saved = self.save("nested-at-limit", at_limit_nodes)
        self.assertEqual(saved["metadata"]["preset_id"], "nested-at-limit")

        final_nodes = counter_preset_nodes("nested-at-limit", counter_count=1)
        with self.assertRaisesRegex(
            self.module.ScenePresetResolutionError,
            "累積ノード数",
        ) as error:
            self.save("nested-over-limit", final_nodes)
        self.assertEqual(error.exception.node_id, "2")

        self.write_preset_without_runtime_validation("nested-runtime-final", final_nodes)
        api_graph = graph({
            "100": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "nested-runtime-final"}},
            "101": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["100", 0]}},
        })
        with self.assertRaisesRegex(
            self.module.ScenePresetResolutionError,
            "累積ノード数",
        ) as error:
            self.module.snapshot_presets_for_run("too-deep-run", api_graph, "101")
        self.assertEqual(error.exception.node_id, "100")

    def test_snapshot_counts_outer_scene_nodes_with_nested_preset(self):
        self.save("nested-small", basic_nodes("nested"))

        def outer_graph(counter_count):
            nodes = {}
            previous = None
            for index in range(counter_count):
                node_id = f"outer-{index}"
                inputs = {"count": 1}
                if previous is not None:
                    inputs["scene_prompt"] = [previous, 0]
                nodes[node_id] = {"class_type": "ScenePromptCounter", "inputs": inputs}
                previous = node_id
            nodes["outer-reference"] = {
                "class_type": "ScenePresetReference",
                "inputs": {"preset_id": "nested-small", "scene_prompt": [previous, 0]},
            }
            nodes["outer-expand"] = {
                "class_type": "ScenePrompterExpand",
                "inputs": {"scene_prompt": ["outer-reference", 0]},
            }
            return graph(nodes)

        at_limit = self.module.snapshot_presets_for_run(
            "outer-at-limit", outer_graph(124), "outer-expand"
        )
        self.assertEqual([preset["preset_id"] for preset in at_limit["presets"]], ["nested-small"])

        with self.assertRaisesRegex(
            self.module.ScenePresetResolutionError,
            "累積ノード数",
        ) as error:
            self.module.snapshot_presets_for_run("outer-over-limit", outer_graph(125), "outer-expand")
        self.assertEqual(error.exception.node_id, "outer-reference")

    def test_nested_presets_resolve_with_the_request_user(self):
        inner = basic_nodes("alice-inner")
        outer = basic_nodes()
        outer["2"] = {
            "class_type": "ScenePresetReference",
            "inputs": {"preset_id": "inner", "scene_prompt": ["1", 0]},
        }
        self.save("inner", inner, user_id="alice")
        self.save("outer", outer, user_id="alice")
        self.save("inner", basic_nodes("bob-inner"), user_id="bob")
        self.save("outer", outer, user_id="bob")
        graph_data = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "outer"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        runs = sys.modules[f"{self.module.__package__}.runs"]
        handle = runs.create_run_context("alice")
        self.module.snapshot_presets_for_run(handle, graph_data, "11", "alice")
        resolved = self.module._RUN_SNAPSHOTS[("alice", handle)]["presets"]
        value = self.module._scene_node_value(
            graph_data["output"], "10", resolved, set(), user_id="alice", run_handle=handle
        )
        self.assertEqual(value["rows"][0]["row"]["positive_parts"], ["alice-inner"])
        runs.release_run_context(handle, "alice")
        self.module.release_scene_preset_snapshot(handle, "alice")

    def test_reference_is_changed_is_read_only_for_run_and_snapshot_state(self):
        self.save("fixed", basic_nodes("first"), user_id="alice")
        graph_data = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        runs = sys.modules[f"{self.module.__package__}.runs"]
        handle = runs.create_run_context("alice")
        try:
            self.module.snapshot_presets_for_run(handle, graph_data, "11", "alice")
            before_runs = copy.deepcopy(runs.RUN_CONTEXTS._entries)
            before_snapshots = copy.deepcopy(self.module._RUN_SNAPSHOTS)
            first = self.module.ScenePresetReference.IS_CHANGED("fixed", run_handle=handle)
            second = self.module.ScenePresetReference.IS_CHANGED("fixed", run_handle=handle)
            self.assertEqual(first, second)
            self.assertEqual(runs.RUN_CONTEXTS._entries, before_runs)
            self.assertEqual(self.module._RUN_SNAPSHOTS, before_snapshots)
        finally:
            runs.release_run_context(handle, "alice")
            self.module.release_scene_preset_snapshot(handle, "alice")

    def test_preset_graph_limit_is_a_controlled_error(self):
        nodes = basic_nodes()
        previous = "2"
        for index in range(self.module.MAX_PRESET_NODES - len(nodes) + 1):
            node_id = str(10 + index)
            nodes[node_id] = {
                "class_type": "ScenePromptCounter",
                "inputs": {"scene_prompt": [previous, 0], "count": 1},
            }
            previous = node_id
        nodes["3"]["inputs"]["scene_prompt"] = [previous, 0]
        with self.assertRaisesRegex(self.module.ScenePresetError, "ノード数"):
            self.save("too-deep", nodes)

    def test_long_linear_preset_at_limit_does_not_overflow_python_stack(self):
        self.assertEqual(self.module.MAX_PRESET_NODES, 128)
        nodes = basic_nodes()
        previous = "2"
        counter_count = self.module.MAX_PRESET_NODES - len(nodes)
        for index in range(counter_count):
            node_id = str(10 + index)
            nodes[node_id] = {
                "class_type": "ScenePromptCounter",
                "inputs": {"scene_prompt": [previous, 0], "count": 1},
            }
            previous = node_id
        nodes["3"]["inputs"]["scene_prompt"] = [previous, 0]

        saved = self.save("linear-at-limit", nodes)
        self.assertEqual(saved["metadata"]["preset_id"], "linear-at-limit")

    def test_repeated_resolve_keeps_the_first_snapshot_and_response(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        first = self.module.snapshot_presets_for_run("same-run", api_graph, "11")
        self.save("fixed", basic_nodes("second"))
        second = self.module.snapshot_presets_for_run("same-run", api_graph, "11")
        self.assertEqual(second, first)
        snapshot = self.module._snapshot_preset("same-run", "fixed")
        self.assertEqual(snapshot["metadata"]["revision"], 1)

    def test_concurrent_resolve_publishes_one_valid_snapshot(self):
        self.save("fixed", basic_nodes("first"))
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "fixed"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        barrier = threading.Barrier(2)
        original = self.module._resolve_preset_tree

        def delayed_resolve(*args, **kwargs):
            barrier.wait(2)
            return original(*args, **kwargs)

        self.module._resolve_preset_tree = delayed_resolve
        results = []
        errors = []

        def resolve_snapshot():
            try:
                results.append(self.module.snapshot_presets_for_run("concurrent-run", api_graph, "11"))
            except Exception as exc:
                errors.append(exc)

        try:
            workers = [threading.Thread(target=resolve_snapshot) for _ in range(2)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(2)
                self.assertFalse(worker.is_alive())
        finally:
            self.module._resolve_preset_tree = original

        self.assertEqual(errors, [])
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(self.module._RUN_SNAPSHOTS), 1)
        self.assertEqual(self.module._RUN_SNAPSHOTS[("default", "concurrent-run")]["response"], results[0])

    def test_unlinked_expand_run_is_snapshotted_and_cannot_be_reused_after_release(self):
        api_graph = graph({
            "11": {"class_type": "ScenePrompterExpand", "inputs": {}},
        })
        first = self.module.snapshot_presets_for_run("unlinked-run", api_graph, "11")
        second = self.module.snapshot_presets_for_run("unlinked-run", api_graph, "11")
        self.assertEqual(second, first)
        self.assertTrue(self.module.release_scene_preset_snapshot("unlinked-run"))
        with self.assertRaisesRegex(self.module.ScenePresetError, "キャンセル"):
            self.module.snapshot_presets_for_run("unlinked-run", api_graph, "11")

    def test_empty_top_level_reference_keeps_its_node_id(self):
        api_graph = graph({
            "51": {"class_type": "ScenePresetReference", "inputs": {"preset_id": ""}},
            "52": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["51", 0]}},
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
            "class_type": "ScenePrompter",
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
        nodes["6"] = {"class_type": "ScenePrompterMerge", "inputs": {"scene_prompt1": ["4", 0], "scene_prompt2": ["5", 0]}}
        nodes["7"] = {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["6", 0], "count": 2}}
        nodes["8"] = {"class_type": "ScenePath", "inputs": {"scene_prompt": ["7", 0], "path_name": "preset_path", "path_mode": self.nodes.PATH_DIRECTORY}}
        nodes["9"] = {"class_type": "SceneEmptyLatent", "inputs": {"scene_prompt": ["8", 0], "width": 832, "height": 1216, "batch_size": 1}}
        nodes["10"] = {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["9", 0], "scene_prompt2": ["4", 0]}}
        nodes["3"]["inputs"]["scene_prompt"] = ["10", 0]
        self.save("integrated", nodes)
        expanded = self.module.expand_preset_reference("integrated", ["outer", 0])
        expanded_classes = {node["class_type"] for node in expanded["expand"].values()}
        self.assertTrue({"SceneMatrix", "ScenePrompterMerge", "ScenePromptCounter", "ScenePath", "SceneEmptyLatent", "ScenePrompterQueue"}.issubset(expanded_classes))
        api_graph = graph({
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "integrated"}},
            "21": {"class_type": "PrimitiveInt", "inputs": {"value": 3}},
            "22": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["20", 0], "count": ["21", 0]}},
            "23": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["22", 0]}},
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

    def test_expanded_queue_matrix_lineage_drives_selected_save_path(self):
        nodes = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": "ScenePrompter", "inputs": {**basic_nodes("left")["2"]["inputs"], "prompt_name": "left", "scene_prompt": ["1", 0]}},
            "3": {"class_type": "ScenePrompter", "inputs": {**basic_nodes("right")["2"]["inputs"], "prompt_name": "right", "scene_prompt": ["1", 0]}},
            "4": {"class_type": "SceneMatrix", "inputs": {
                "scene_prompt": ["2", 0],
                "matrix_json": json.dumps({"version": 1, "sets": [matrix_line("A"), matrix_line("B")]})}},
            "5": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["4", 0], "scene_prompt2": ["3", 0]}},
            "6": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "lineage", "preset_name": "Lineage", "scene_prompt": ["5", 0]}},
        }
        preset_workflow = {
            "version": 1,
            "nodes": [
                {
                    "id": int(node_id),
                    "type": node["class_type"],
                    "pos": [int(node_id) * 100, 0],
                    "inputs": [],
                    "outputs": [],
                }
                for node_id, node in nodes.items()
            ],
            "links": [],
        }
        self.save("lineage", nodes, output_node_id="6", workflow=preset_workflow)
        outer_graph = graph({
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "lineage"}},
            "21": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["20", 0]}},
            "30": {"class_type": "EmptyImage", "inputs": {"width": 16, "height": 16, "batch_size": 1, "color": 0}},
            "9": {"class_type": "SceneSaveImage", "inputs": {
                "images": ["30", 0],
                "metadata_mode": self.nodes.SAVE_METADATA_EXECUTION_PATH,
                "expand_preset_contents": True,
                "scene_info": ["21", 2],
            }},
        })
        runs = sys.modules[f"{self.module.__package__}.runs"]
        run_handle = runs.create_run_context("default")
        self.module.snapshot_presets_for_run(run_handle, outer_graph, "21")
        expanded = self.module.expand_preset_reference("lineage", run_handle=run_handle, source_node_id="20")["expand"]
        plan = self.module._scene_node_value(expanded, "__scene_preset_source", {}, set(), run_handle=run_handle)
        info = self.nodes.ScenePromptExpand().expand(
            current_index=2,
            timestamp_dir=False,
            scene_prompt=plan,
            unique_id="21",
        )[2]
        self.assertIn("20/3", info["source_node_ids"])
        self.assertNotIn("20/2", info["source_node_ids"])
        self.assertNotIn("20/4", info["source_node_ids"])
        workflow = {
            "nodes": [
                {"id": 20, "type": "ScenePresetReference", "widgets_values": ["lineage"]},
                {"id": 21, "type": "ScenePrompterExpand", "widgets_values": []},
                {"id": 30, "type": "EmptyImage", "widgets_values": []},
                {"id": 9, "type": "SceneSaveImage", "widgets_values": []},
            ],
            "links": [],
        }
        _expanded_prompt, _expanded_workflow, aliases = self.preset_metadata.expand_preset_references(
            outer_graph["output"], workflow, self.module.snapshot_presets_for_metadata(run_handle)
        )
        selected_ids = {
            node_id for node_id, source_id in aliases.items()
            if source_id in info["source_node_ids"]
        }
        selected_sources = {aliases[node_id] for node_id in selected_ids}
        self.assertIn("20/3", selected_sources)
        self.assertNotIn("20/2", selected_sources)
        self.assertNotIn("20/4", selected_sources)

        matrix_info = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            timestamp_dir=False,
            scene_prompt=plan,
            unique_id="21",
        )[2]
        matrix_info["run_handle"] = run_handle
        self.assertIn("20/2", matrix_info["source_node_ids"])
        self.assertIn("20/4", matrix_info["source_node_ids"])
        self.assertNotIn("20/3", matrix_info["source_node_ids"])
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            outer_graph["output"],
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            matrix_info,
            True,
        )
        names = {
            node.get("inputs", {}).get("prompt_name")
            for node in saved_prompt.values()
            if node.get("class_type") == "ScenePrompter"
        }
        self.assertIn("left", names)
        self.assertNotIn("right", names)
        self.assertIn("SceneMatrix", {node["class_type"] for node in saved_prompt.values()})
        self.assertEqual(
            {str(node["id"]) for node in saved_extra["workflow"]["nodes"]},
            set(saved_prompt),
        )
        runs.release_run_context(run_handle, "default")
        self.module.release_scene_preset_snapshot(run_handle)

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
        self.save("total", nodes, output_node_id="5")
        api_graph = graph({
            "10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "total"}},
            "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}},
        })
        result = self.module.snapshot_presets_for_run("run-total", api_graph, "11")
        self.assertEqual(result["total_images"], 2)

    def test_presets_and_run_snapshots_are_isolated_by_user(self):
        self.save("shared", basic_nodes("alice"), user_id="alice")
        self.save("shared", basic_nodes("bob"), user_id="bob")
        self.assertEqual(self.module.load_preset("shared", "alice")["api_graph"]["output"]["2"]["inputs"]["positive_base"], "alice")
        self.assertEqual(self.module.load_preset("shared", "bob")["api_graph"]["output"]["2"]["inputs"]["positive_base"], "bob")

        graph_data = graph({"11": {"class_type": "ScenePrompterExpand", "inputs": {}}})
        self.module.snapshot_presets_for_run("same-run", graph_data, "11", "alice")
        self.module.snapshot_presets_for_run("same-run", graph_data, "11", "bob")
        self.assertIn(("alice", "same-run"), self.module._RUN_SNAPSHOTS)
        self.assertIn(("bob", "same-run"), self.module._RUN_SNAPSHOTS)

    def test_snapshot_cache_keeps_active_entries_until_release(self):
        self.module._RUN_SNAPSHOTS.clear()
        self.module._CANCELLED_RUNS.clear()
        original_cancel_limit = self.module._CANCELLED_RUNS_MAX_ENTRIES
        self.module._CANCELLED_RUNS_MAX_ENTRIES = 2
        try:
            graph_data = graph({"11": {"class_type": "ScenePrompterExpand", "inputs": {}}})
            self.module.snapshot_presets_for_run("one", graph_data, "11")
            self.module.snapshot_presets_for_run("two", graph_data, "11")
            self.module.snapshot_presets_for_run("one", graph_data, "11")
            self.module.snapshot_presets_for_run("three", graph_data, "11")
            self.assertIn(("default", "one"), self.module._RUN_SNAPSHOTS)
            self.assertIn(("default", "two"), self.module._RUN_SNAPSHOTS)
            self.assertIn(("default", "three"), self.module._RUN_SNAPSHOTS)
            for run_id in ("cancel-one", "cancel-two", "cancel-three"):
                self.module.release_scene_preset_snapshot(run_id)
            self.assertEqual(list(self.module._CANCELLED_RUNS), [("default", "cancel-two"), ("default", "cancel-three")])
        finally:
            self.module._CANCELLED_RUNS_MAX_ENTRIES = original_cancel_limit
            self.module._RUN_SNAPSHOTS.clear()
            self.module._CANCELLED_RUNS.clear()

    def test_preset_node_rejects_missing_run_handle(self):
        self.save("standalone", basic_nodes())
        with self.assertRaisesRegex(ValueError, "実行コンテキスト"):
            self.module.ScenePresetReference().expand("standalone")
        with self.assertRaisesRegex(ValueError, "実行コンテキスト"):
            self.module.ScenePresetReference().expand("standalone", run_handle="forged")


if __name__ == "__main__":
    unittest.main()
