import importlib
import json
import tempfile
import unittest
from pathlib import Path

from test_scene_presets import load_presets_module, basic_nodes, graph


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
        self.presets.save_preset({"preset_id": "child", "name": "Child", "output_node_id": "3", "api_graph": graph(child), "workflow": {"version": 1, "nodes": []}})

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

    def test_more_than_ten_rows_keep_order_without_extra_queue_boundary(self):
        rows = [row(str(index), row_kind="preset", preset_id="child") for index in range(12)]
        actual = self.nodes.SceneMatrix().build(self.state(rows), unique_id="matrix")[0]
        self.assertEqual(actual["stats"]["total_batches"], 24)
        self.assertFalse(actual["contains_queue_boundary"])
        self.assertEqual([item["row"]["labels"][-1] for item in actual["rows"]], [str(index) for index in range(12) for _ in range(2)])
