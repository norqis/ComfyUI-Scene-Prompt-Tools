import importlib
import json
import tempfile
import unittest
from pathlib import Path

from test_scene_presets import load_presets_module, basic_nodes, graph
from test_preset_metadata import outer_workflow


def row(name, **fields):
    return {"row_id": name, "name": name, "path_label": name, **fields}


class MatrixPresetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.presets = load_presets_module(Path(self.temp.name))
        self.nodes = importlib.import_module(self.presets.__package__ + ".nodes")
        self.runs = importlib.import_module(self.presets.__package__ + ".runs")
        child = basic_nodes()
        child["2"] = {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["1", 0], "matrix_json": self.state([
            row("Y", positive_base="Y"), row("Z", positive_base="Z")])}}
        self.presets.save_preset({"preset_id": "child", "name": "Child", "output_node_id": "3", "api_graph": graph(child), "workflow": outer_workflow(child)})

    @staticmethod
    def state(rows):
        return json.dumps({"version": 1, "sets": rows})

    def test_all_preset_scenes_follow_each_upstream_scene_and_snapshot(self):
        upstream = self.nodes.SceneMatrix().build(self.state([row("A", positive_base="A"), row("B", positive_base="B")]))[0]
        state = self.state([row("X", positive_base="X"), row("P", row_kind="preset", preset_id="child")])
        actual = self.nodes.SceneMatrix().build(state, scene_prompt=upstream, unique_id="matrix")[0]
        expand = self.nodes.ScenePromptExpand()
        self.assertEqual([expand.expand(scene_prompt=actual, current_index=index)[0] for index in range(6)],
                         ["A, X", "A, Y", "A, Z", "B, X", "B, Y", "B, Z"])
        handle = self.runs.create_run_context("default")
        nodes = {"matrix": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}},
                 "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["matrix", 0]}}}
        prepared = self.presets.snapshot_presets_for_run(handle, graph(nodes), "expand")
        self.assertEqual(prepared["total_batches"], 3)
        runtime = self.nodes.SceneMatrix().build(state, run_handle=handle, unique_id="matrix")[0]
        self.assertEqual(runtime["stats"]["total_batches"], 3)

    def test_disabled_unselected_row_is_ignored_and_all_disabled_is_empty(self):
        state = self.state([row("Pending", row_kind="preset", preset_id="", enabled=False)])
        actual = self.nodes.SceneMatrix().build(state)[0]
        self.assertEqual(actual["stats"]["total_batches"], 0)
        self.assertEqual(self.presets._find_references({"matrix": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}}}), [])
        with self.assertRaisesRegex(ValueError, "Pending.*Preset"):
            self.nodes.SceneMatrix().build(self.state([row("Pending", row_kind="preset", preset_id="")]))

    def test_preset_row_prompts_keep_weights_and_both_sides_in_expanded_metadata(self):
        state = self.state([row("P", row_kind="preset", preset_id="child", positive_base="(extra:1.3)", negative_base="blocked")])
        nodes = {"4": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}}}
        loaded = {"child": self.presets.load_preset("child")}
        runtime = self.presets._scene_node_value(nodes, "4", loaded, set())
        metadata = importlib.import_module(self.presets.__package__ + ".preset_metadata")
        expanded, _workflow, _aliases = metadata.expand_preset_references(nodes, outer_workflow(nodes), loaded)
        replay = self.presets._scene_node_value(expanded, "4", {}, set())
        for plan in (runtime, replay):
            self.assertEqual([self.nodes.ScenePromptExpand().expand(scene_prompt=plan, current_index=index)[:2] for index in range(2)],
                             [("Y, (extra:1.3)", "blocked"), ("Z, (extra:1.3)", "blocked")])

    def test_more_than_ten_rows_keep_order_without_extra_queue_boundary(self):
        rows = [row(str(index), row_kind="preset", preset_id="child") for index in range(12)]
        actual = self.nodes.SceneMatrix().build(self.state(rows), unique_id="matrix")[0]
        self.assertEqual(actual["stats"]["total_batches"], 24)
        self.assertFalse(actual["contains_queue_boundary"])
        self.assertEqual([item["row"]["labels"][-1] for item in actual["rows"]], [str(index) for index in range(12) for _ in range(2)])

    def test_rows_use_independent_switch_settings_and_a_fixed_run_snapshot(self):
        child = basic_nodes()
        child["4"] = {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["1", 0], "matrix_json": self.state([row("Y", positive_base="Y"), row("Z", positive_base="Z")])}}
        child["5"] = {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["4", 0], "count": 2}}
        child["6"] = {"class_type": "ComfySwitchNode", "inputs": {"switch": ["1", 1], "on_false": ["4", 0], "on_true": ["5", 0]}}
        child["3"]["inputs"]["scene_prompt"] = ["6", 0]
        payload = {"preset_id": "switched", "output_node_id": "3", "api_graph": graph(child), "workflow": {"nodes": []}}
        self.presets.save_preset(payload)
        state = self.state([row("ON", row_kind="preset", preset_id="switched", switch_settings_json=json.dumps([True, *range(2, 11)])),
                            row("OFF", row_kind="preset", preset_id="switched", switch_settings_json=json.dumps([False, *range(2, 11)]))])
        nodes = {"matrix": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}},
                 "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["matrix", 0]}}}
        handle = self.runs.create_run_context("default")
        self.assertEqual(self.presets.snapshot_presets_for_run(handle, graph(nodes), "expand")["total_batches"], 6)
        child["5"]["inputs"]["count"] = 3
        self.presets.save_preset(payload)
        self.assertEqual(self.nodes.SceneMatrix().build(state, run_handle=handle, unique_id="matrix")[0]["stats"]["total_batches"], 6)
        self.assertEqual(self.nodes.SceneMatrix().build(state, unique_id="matrix")[0]["stats"]["total_batches"], 8)

    def test_nested_matrix_presets_validate_cycles_and_keep_their_source_paths(self):
        parent = basic_nodes()
        parent["2"] = {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["1", 0], "matrix_json": self.state([row("P", row_kind="preset", preset_id="child")])}}
        payload = {"preset_id": "parent", "output_node_id": "3", "api_graph": graph(parent), "workflow": {"nodes": []}}
        self.presets.save_preset(payload)
        state = self.state([row("Outer", row_kind="preset", preset_id="parent")])
        plan = self.nodes.SceneMatrix().build(state, unique_id="matrix")[0]
        self.assertEqual(plan["stats"]["total_batches"], 2)
        self.assertTrue(any(source.startswith("matrix/rows/Outer/2/rows/P/") for source in plan["rows"][0]["row"]["source_node_ids"]))
        parent["2"]["inputs"]["matrix_json"] = self.state([row("Cycle", row_kind="preset", preset_id="parent")])
        with self.assertRaisesRegex(self.presets.ScenePresetError, "循環"):
            self.presets.save_preset(payload)

    def test_huge_counts_remain_compact_and_count_hold_survives_merge(self):
        source = self.nodes.ScenePromptCounter().count(count=100_000_000)[0]
        state = self.state([row("X", positive_base="X"), row("P", row_kind="preset", preset_id="child")])
        actual = self.nodes.SceneMatrix().build(state, scene_prompt=source, unique_id="matrix")[0]
        self.assertEqual(actual["stats"]["total_batches"], 300_000_000)
        self.assertLess(len(json.dumps(actual)), 25_000)
        self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=actual, current_index=299_999_999)[0], "Z")
        held = self.nodes.ScenePromptCounter().count(count=3, enable_downstream_count=False)[0]
        plan = self.nodes.SceneMatrix().build(state, scene_prompt=held, unique_id="matrix")[0]
        self.assertEqual(self.nodes.ScenePromptCounter().count(plan, 10)[0]["stats"]["total_batches"], 9)

    def test_inline_matrix_metadata_matches_the_runtime_order(self):
        state = self.state([row("X", positive_base="X"), row("P", row_kind="preset", preset_id="child", filename_enabled=True)])
        nodes = {"4": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}},
                 "8": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["4", 0]}}}
        handle = self.runs.create_run_context("default")
        self.presets.snapshot_presets_for_run(handle, graph(nodes), "8")
        snapshots = self.presets.snapshot_presets_for_metadata(handle)
        metadata = importlib.import_module(self.presets.__package__ + ".preset_metadata")
        expanded, workflow, _aliases = metadata.expand_preset_references(nodes, outer_workflow(nodes), snapshots)
        plan = self.presets._scene_node_value(expanded, "4", {}, set())
        self.assertEqual([item["row"]["positive_parts"] for item in plan["rows"]], [["X"], ["Y"], ["Z"]])
        self.assertFalse(any(node["class_type"] == "ScenePresetReference" for node in expanded.values()))
        self.assertEqual(len({node["id"] for node in workflow["nodes"]}), len(workflow["nodes"]))

    def test_full_workflow_expands_unexecuted_matrix_preset_rows(self):
        state = self.state([row("P", row_kind="preset", preset_id="child")])
        nodes = {"4": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}}}
        workflow = outer_workflow(nodes)
        workflow["nodes"][0]["widgets_values"] = [state, ""]
        workflow["nodes"][0]["inputs"].append({"name": "switches", "type": "SCENE_SWITCHES", "link": 1})
        workflow["nodes"].append({"id": 5, "type": "ScenePromptMakeSwitch", "widgets_values": ["[]", "[true,false,false,false,false,false,false,false,false,false]"],
                                  "outputs": [{"name": "switches", "type": "SCENE_SWITCHES", "links": [1]}]})
        workflow["links"] = [[1, 5, 0, 4, 1, "SCENE_SWITCHES"]]
        metadata = importlib.import_module(self.presets.__package__ + ".preset_metadata")
        child = self.presets.load_preset("child")
        expanded, workflow, aliases = metadata.expand_preset_references({}, workflow, {"child": child}, True)
        self.assertEqual(expanded, {})
        self.assertFalse(any(node["type"] == "ScenePresetReference" for node in workflow["nodes"]))
        self.assertEqual(next(node["type"] for node in workflow["nodes"] if str(node["id"]) == "4"), "ScenePrompterMerge")
        self.assertTrue(any(value.startswith("4/rows/P/") for value in aliases.values()))

    def test_delete_and_callback_only_see_the_preset_local_prompt(self):
        child = basic_nodes("inside")
        child["4"] = {"class_type": "ScenePromptDelete", "inputs": {"positive": "outside", "scene_prompt": ["2", 0]}}
        child["5"] = {"class_type": "ScenePromptCallbackDesktop", "inputs": {"title": "Ready", "text": "{current_positive}"}}
        child["6"] = {"class_type": "ScenePromptCallback", "inputs": {"scene_prompt": ["4", 0], "callback": ["5", 0]}}
        child["3"]["inputs"]["scene_prompt"] = ["6", 0]
        self.presets.save_preset({"preset_id": "local", "output_node_id": "3", "api_graph": graph(child), "workflow": outer_workflow(child)})
        upstream = self.nodes.SceneMatrix().build(self.state([row("Outside", positive_base="outside")]))[0]
        plan = self.nodes.SceneMatrix().build(self.state([row("P", row_kind="preset", preset_id="local")]), scene_prompt=upstream, unique_id="matrix")[0]
        item = plan["rows"][0]["row"]
        self.assertEqual(item["positive_parts"], ["outside", "inside"])
        self.assertEqual(item["callbacks"][0]["current_positive_parts"], ["inside"])

    def test_generation_info_includes_preset_row_loras_without_loading_them(self):
        child = basic_nodes()
        child["4"] = {"class_type": "SceneApplyLora", "inputs": {"scene_prompt": ["2", 0], "lora_name": "style/example.safetensors"}}
        child["3"]["inputs"]["scene_prompt"] = ["4", 0]
        self.presets.save_preset({"preset_id": "lora", "output_node_id": "3", "api_graph": graph(child), "workflow": outer_workflow(child)})
        info = importlib.import_module(self.presets.__package__ + ".resource_info")
        state = self.state([row("P", row_kind="preset", preset_id="lora")])
        nodes = {"4": {"class_type": "SceneMatrix", "inputs": {"matrix_json": state}},
                 "8": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["4", 0]}}}
        self.assertEqual([item["name"] for item in info.connected_resources(graph(nodes), "8")["loras"]], ["style/example.safetensors"])

    def test_zero_percent_random_arm_stays_inert_in_runtime_and_expanded_metadata(self):
        state = self.state([row("P", row_kind="preset", preset_id="child")])
        weights = json.dumps([10000, *([0] * 9)])
        nodes = {"1": {"class_type": "ScenePromptRandomRoute", "inputs": {"weights_json": weights}},
                 "2": {"class_type": "ScenePromptDelete", "inputs": {"scene_prompt": ["1", 0]}},
                 "4": {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["1", 1], "matrix_json": state}}}
        loaded = {"child": self.presets.load_preset("child")}
        plan = self.presets._scene_node_value(nodes, "4", loaded, set())
        self.assertEqual(plan["stats"]["total_batches"], 0)
        self.assertEqual(plan["random_guards"][-1]["arm_index"], 1)
        metadata = importlib.import_module(self.presets.__package__ + ".preset_metadata")
        expanded, _workflow, _aliases = metadata.expand_preset_references(nodes, outer_workflow(nodes), loaded)
        restored = self.presets._scene_node_value(expanded, "4", {}, set())
        self.assertEqual(restored["stats"]["total_batches"], 0)
        self.assertEqual(restored["random_guards"], plan["random_guards"])
