import importlib.util
import json
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
RETIRED_NODE_DIRECTORY = "ComfyUI-" + "Scene" + "-Promp" + "ter"
MODULE_PATH = ROOT / "tools" / "migrate_installed_scene_prompt.py"


def retired_node_type(suffix: str = "") -> str:
    return "Scene" + "Promp" + "ter" + suffix


def load_migrator():
    spec = importlib.util.spec_from_file_location("scene_prompt_migrator_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def prompt_runtime_stub():
    def validate(item, _label):
        allowed = {"id", "label", "prompt", "description"}
        if not isinstance(item, dict) or set(item) - allowed or not {"label", "prompt"}.issubset(item):
            raise ValueError("invalid prompt item")
        return item

    def item_key(item, category):
        return f"{category}::id::{item['id']}" if item.get("id") else f"{category}::item::{item['label']}::{item['prompt']}"

    def selection(value, index):
        for category, items in json.loads(value)["categories"].items():
            for item in items:
                if item.get("id"):
                    assert (category, item["id"]) in index["by_id"]
                else:
                    assert item_key(item, category) in index["by_key"]
        return value

    return types.SimpleNamespace(
        validate_prompt_data_item=validate,
        _selection_item_key=item_key,
        _parse_selection_json=selection,
    )


def node_runtime_stub():
    def parse(value):
        result = json.loads(value)
        assert set(result) == {"version", "sets"}
        return result

    def normalize(line, _index):
        expected = {
            "type", "version", "row_id", "node_id", "category", "name", "path_label", "enabled",
            "positive_base", "positive_json", "negative_base", "negative_json", "category_order",
            "positive_parts", "negative_parts", "display_labels", "display_label_groups",
        }
        assert set(line) == expected
        assert isinstance(line["enabled"], bool)
        assert isinstance(line["display_label_groups"], list)
        return line

    return types.SimpleNamespace(_parse_matrix_data=parse, _normalize_matrix_line_set=normalize)


class InstalledScenePromptMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.comfy = self.root / "ComfyUI"
        self.old = self.comfy / "custom_nodes" / RETIRED_NODE_DIRECTORY
        self.data = self.old / "data"
        self.workflows = self.comfy / "user" / "default" / "workflows"
        self.module = load_migrator()
        self.runtime = (prompt_runtime_stub(), node_runtime_stub())
        self._write_fixture()

    def tearDown(self):
        self.temp.cleanup()

    def _json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def _write_fixture(self):
        self._json(self.data / "A" / "prompt.json", {"items": [{
            "id": "same", "label": "A", "prompt": "a", "description": "first", "legacy_keys": ["A::old-a"],
        }]})
        self._json(self.data / "B" / "prompt.json", [{
            "id": "same", "label": "B", "prompt": "b", "description": "second",
        }])
        selection = {
            "version": 1,
            "categories": {"A": [{
                "label": "old-a", "prompt": "old-a", "category_path": ["A"],
                "category_key": "A", "category_label": "A",
            }]},
        }
        saved_item = {
            "label": "A", "prompt": "a", "category_path": ["A"], "category_key": "A", "category_label": "A", "id": "same",
        }
        self._json(self.data / "保存済みプロンプト" / "preset" / "prompt.json", {
            "name": "preset", "description": "saved", "items": [saved_item],
        })
        matrix = {
            "version": 1,
            "sets": [{
                "type": "SCENE_MATRIX_LINE", "version": 1, "row_id": "row-1", "node_id": "", "category": "",
                "name": "Matrix", "path_label": "Matrix", "positive_base": "", "positive_json": json.dumps(selection),
                "negative_base": "", "negative_json": json.dumps({"version": 1, "categories": {}}), "category_order": "",
                "positive_parts": [], "negative_parts": [], "display_labels": [],
            }],
        }
        workflow = {
            "version": 0.4,
            "nodes": [
                {
                    "id": 1, "type": retired_node_type(), "pos": [10, 20], "size": [300, 400], "title": "Prompt",
                    "properties": {"Node name for S&R": retired_node_type()},
                    "inputs": [{"name": "scene_prompt", "link": None}], "outputs": [{"name": "scene_prompt", "links": [5]}],
                    "widgets_values_named": {"prompt_name": "Prompt", "positive_base": "base", "positive_json": json.dumps(selection), "negative_base": "", "negative_json": json.dumps({"version": 1, "categories": {}}), "category_order": "", "seed": 4, "control_after_generate": True, "randomize": False, "reroll_each_queue": True},
                    "widgets_values": ["Prompt", "base", json.dumps(selection), "", json.dumps({"version": 1, "categories": {}}), "", 4, True, False, True],
                },
                {
                    "id": 2, "type": "SceneMatrix", "pos": [50, 20], "size": [300, 400],
                    "properties": {"Node name for S&R": "SceneMatrix"},
                    "inputs": [{"name": "scene_prompt", "link": 5}], "outputs": [{"name": "scene_prompt", "links": [6]}],
                    "widgets_values_named": {"matrix_json": json.dumps(matrix)}, "widgets_values": [json.dumps(matrix)],
                },
                {
                    "id": 3, "type": retired_node_type("Expand"), "pos": [80, 20], "size": [300, 400],
                    "properties": {"Node name for S&R": retired_node_type("Expand")},
                    "inputs": [{"name": "scene_prompt", "link": 6}], "outputs": [{"name": "ポジティブ", "links": []}, {"name": "ネガティブ", "links": []}, {"name": "メタ情報", "links": [7]}, {"name": "シード", "links": []}, {"name": "潜在画像", "links": []}],
                    "widgets_values": [0, "", 0, True, ""], "widgets_values_named": {},
                },
                {
                    "id": 4, "type": "SceneSaveImage", "pos": [120, 20], "size": [300, 400],
                    "properties": {"Node name for S&R": "SceneSaveImage"},
                    "inputs": [{"name": "images", "link": None}, {"name": "scene_info", "link": 7}], "outputs": [{"name": "画像", "links": []}, {"name": "保存先", "links": []}],
                    "widgets_values": ["out"], "widgets_values_named": {"path": "out"},
                },
                {"id": 9, "type": "KSampler", "pos": [1000, 1000], "size": [100, 100], "inputs": [], "outputs": []},
            ],
            "links": [[5, 1, 0, 2, 0, "SCENE_PROMPT"], [6, 2, 0, 3, 0, "SCENE_PROMPT"], [7, 3, 2, 4, 1, "SCENE_SAVE_INFO"]],
            "groups": [{"title": "Keep"}],
        }
        for name in ("one.json", "two.json", "three.json"):
            self._json(self.workflows / name, workflow)

    def test_stage_converts_data_and_workflows_without_legacy_runtime(self):
        stage = self.root / "stage"
        with mock.patch.object(self.module, "_runtime_modules", return_value=self.runtime):
            self.module.build_stage(self.data, self.workflows, stage)

        first = json.loads((stage / "data" / "A" / "prompt.json").read_text(encoding="utf-8"))
        second = json.loads((stage / "data" / "B" / "prompt.json").read_text(encoding="utf-8"))
        self.assertEqual(first[0]["id"], "same")
        self.assertEqual(second[0]["id"], "same_2")
        self.assertNotIn("legacy_keys", json.dumps(first, ensure_ascii=False))
        self.assertFalse((stage / "data" / "A" / "prompt.json").read_bytes().startswith(b"\xef\xbb\xbf"))
        saved = json.loads((stage / "data" / "保存済みプロンプト" / "preset" / "prompt.json").read_text(encoding="utf-8"))
        self.assertEqual(set(saved), {"name", "description", "items"})
        self.assertEqual(saved["items"][0]["id"], "same")

        workflow = json.loads((stage / "workflows" / "one.json").read_text(encoding="utf-8"))
        nodes = {node["id"]: node for node in workflow["nodes"]}
        self.assertEqual(nodes[1]["type"], "ScenePrompt")
        self.assertEqual(nodes[3]["type"], "ScenePromptExpand")
        self.assertEqual(nodes[1]["properties"]["Node name for S&R"], "ScenePrompt")
        self.assertEqual(nodes[1]["widgets_values_named"]["run_handle"], "")
        self.assertNotIn("reroll_each_queue", nodes[1]["widgets_values_named"])
        self.assertEqual(nodes[4]["widgets_values_named"]["metadata_mode"], "ワークフロー全体")
        line = json.loads(nodes[2]["widgets_values_named"]["matrix_json"])["sets"][0]
        self.assertTrue(line["enabled"])
        self.assertEqual(line["display_label_groups"], [])
        self.assertEqual(nodes[2]["properties"]["scene_matrix_json"], nodes[2]["widgets_values_named"]["matrix_json"])
        self.assertEqual(workflow["groups"], [{"title": "Keep"}])
        self.assertEqual(workflow["links"], [[5, 1, 0, 2, 0, "SCENE_PROMPT"], [6, 2, 0, 3, 0, "SCENE_PROMPT"], [7, 3, 2, 4, 1, "SCENE_SAVE_INFO"]])

    def test_apply_installs_staged_node_and_moves_old_node_outside_custom_nodes(self):
        stage = self.root / "stage"
        source_node = self.root / "source-node"
        (source_node / "scene_prompt_tools").mkdir(parents=True)
        (source_node / "scene_prompt_tools" / "marker.py").write_text("marker", encoding="utf-8")
        with mock.patch.object(self.module, "_runtime_modules", return_value=self.runtime):
            self.module.build_stage(self.data, self.workflows, stage)
            self.module.apply_stage(stage, self.comfy, source_node)

        self.assertTrue((self.comfy / "custom_nodes" / "ComfyUI-Scene-Prompt-Tools" / "scene_prompt_tools" / "marker.py").exists())
        self.assertFalse(self.old.exists())
        self.assertTrue((self.comfy / "user" / "default" / "scene_prompt_tools" / "migration_backup" / RETIRED_NODE_DIRECTORY).exists())
        self.assertTrue((self.comfy / "user" / "default" / "scene_prompt_tools" / "data" / "A" / "prompt.json").exists())

    def test_unresolved_selection_aborts_before_workflow_output(self):
        workflow = self.workflows / "one.json"
        value = json.loads(workflow.read_text(encoding="utf-8"))
        value["nodes"][0]["widgets_values_named"]["positive_json"] = json.dumps({"version": 1, "categories": {"A": [{"label": "missing", "prompt": "missing"}]}})
        workflow.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(self.module.MigrationError, "no longer exists"):
            self.module.build_stage(self.data, self.workflows, self.root / "stage")


if __name__ == "__main__":
    unittest.main()
