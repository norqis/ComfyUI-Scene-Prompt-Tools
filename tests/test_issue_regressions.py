import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()
ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"


def load_presets(root):
    install_comfy_execution_stub()
    comfy = types.ModuleType("comfy")
    management = types.ModuleType("comfy.model_management")
    management.intermediate_device = lambda: "cpu"
    management.intermediate_dtype = lambda: torch.float32
    comfy.model_management = management
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: str(root / "output")
    folder_paths.get_user_directory = lambda: str(root / "user")
    folder_paths.get_public_user_directory = lambda user_id: str(root / "user" / user_id)
    sys.modules.update({
        "comfy": comfy,
        "comfy.model_management": management,
        "comfy.cli_args": cli_args,
        "folder_paths": folder_paths,
    })
    package_name = "scene_issue_regression_test"
    for name in list(sys.modules):
        if name == package_name or name.startswith(f"{package_name}."):
            del sys.modules[name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return importlib.import_module(f"{package_name}.presets")


def prompt_inputs(upstream):
    return {
        "scene_prompt": upstream,
        "prompt_name": "Legacy",
        "positive_base": "alpha",
        "positive_json": '{"version":1,"categories":{}}',
        "negative_base": "",
        "negative_json": '{"version":1,"categories":{}}',
        "category_order": "",
        "seed": 0,
        "randomize": True,
    }


def workflow_for(nodes):
    return {
        "nodes": [
            {
                "id": int(node_id),
                "type": node["class_type"],
                "properties": {"Node name for S&R": node["class_type"]},
            }
            for node_id, node in nodes.items()
        ],
        "links": [],
        "groups": [],
    }


class OpenIssueRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.presets = load_presets(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def legacy_payload(self, middle_type="ScenePrompt"):
        nodes = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": middle_type, "inputs": prompt_inputs(["1", 0]) if middle_type == "ScenePrompt" else {"scene_prompt": ["1", 0]}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
        }
        workflow = workflow_for(nodes)
        api_graph = {"output": nodes}
        return {
            "schema_version": 1,
            "metadata": {
                "preset_id": "legacy",
                "name": "Legacy",
                "revision": 1,
                "sha256": self.presets._content_hash(api_graph, workflow),
            },
            "api_graph": api_graph,
            "workflow": workflow,
        }

    def test_legacy_ids_normalize_only_after_raw_hash_validation(self):
        payload = self.legacy_payload()
        original_hash = payload["metadata"]["sha256"]
        self.presets._validate_preset_payload(payload)
        self.assertEqual(payload["api_graph"]["output"]["2"]["class_type"], "ScenePrompter")
        self.assertEqual(payload["workflow"]["nodes"][1]["type"], "ScenePrompter")
        self.assertEqual(payload["workflow"]["nodes"][1]["properties"]["Node name for S&R"], "ScenePrompter")
        self.assertEqual(payload["metadata"]["sha256"], original_hash)

        corrupted = self.legacy_payload()
        corrupted["api_graph"]["output"]["2"]["inputs"]["positive_base"] = "tampered"
        with self.assertRaisesRegex(self.presets.ScenePresetError, "hash"):
            self.presets._validate_preset_payload(corrupted)

    def test_legacy_file_load_is_read_only_and_same_id_overwrite_bumps_revision(self):
        raw = self.legacy_payload()
        path = self.presets._preset_path("legacy", "default")
        path.parent.mkdir(parents=True, exist_ok=True)
        original_bytes = (json.dumps(raw, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        path.write_bytes(original_bytes)

        loaded = self.presets.load_preset("legacy", "default")
        self.assertEqual(loaded["api_graph"]["output"]["2"]["class_type"], "ScenePrompter")
        self.assertEqual(path.read_bytes(), original_bytes)

        current_graph = loaded["api_graph"]
        current_workflow = loaded["workflow"]
        saved = self.presets.save_preset({
            "preset_id": "legacy",
            "name": "Legacy",
            "expected_revision": 1,
            "output_node_id": "3",
            "api_graph": current_graph,
            "workflow": current_workflow,
        }, "default")
        self.assertEqual(saved["metadata"]["revision"], 2)
        on_disk = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["metadata"]["revision"], 2)
        self.assertEqual(on_disk["api_graph"]["output"]["2"]["class_type"], "ScenePrompter")
        self.assertEqual(on_disk["workflow"]["nodes"][1]["type"], "ScenePrompter")
        self.assertEqual(
            on_disk["metadata"]["sha256"],
            self.presets._content_hash(on_disk["api_graph"], on_disk["workflow"]),
        )

    def test_legacy_expand_remains_disallowed_after_normalization(self):
        payload = self.legacy_payload("ScenePromptExpand")
        with self.assertRaises(self.presets.ScenePresetError):
            self.presets._validate_preset_payload(payload)
        self.assertEqual(payload["api_graph"]["output"]["2"]["class_type"], "ScenePrompterExpand")

    def test_compact_preset_list_graph_removes_matrix_selection_payloads(self):
        matrix = {
            "version": 1,
            "sets": [
                {
                    "row_id": "r1",
                    "name": "one",
                    "path_label": "one",
                    "enabled": True,
                    "positive_json": "x" * 10000,
                },
                {
                    "row_id": "r2",
                    "name": "two",
                    "path_label": "two",
                    "enabled": False,
                    "negative_json": "y" * 10000,
                },
            ],
        }
        graph = {"output": {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["1", 0], "matrix_json": json.dumps(matrix)}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
        }}
        compact = self.presets._compact_preset_list_graph(graph)
        encoded = compact["output"]["2"]["inputs"]["matrix_json"]
        self.assertLess(len(encoded), 500)
        parsed = json.loads(encoded)
        self.assertEqual([line["enabled"] for line in parsed["sets"]], [True, False])


if __name__ == "__main__":
    unittest.main()
