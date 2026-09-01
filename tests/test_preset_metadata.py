import copy
import importlib
import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

from PIL import Image

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()
ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"


def install_stubs(root):
    install_comfy_execution_stub()
    comfy = types.ModuleType("comfy")
    model_management = types.ModuleType("comfy.model_management")
    model_management.intermediate_device = lambda: "cpu"
    model_management.intermediate_dtype = lambda: torch.float32
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    comfy.model_management = model_management
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: str(root / "output")
    folder_paths.get_user_directory = lambda: str(root / "user")
    folder_paths.get_public_user_directory = lambda user_id: str(root / "user" / user_id)
    sys.modules.update({
        "comfy": comfy,
        "comfy.model_management": model_management,
        "comfy.cli_args": cli_args,
        "folder_paths": folder_paths,
    })


def load_modules(root):
    install_stubs(root)
    package_name = "scene_preset_metadata_test"
    for module_name in list(sys.modules):
        if module_name == package_name or module_name.startswith(f"{package_name}."):
            del sys.modules[module_name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return {
        name: importlib.import_module(f"{package_name}.{name}")
        for name in ("nodes", "presets", "runs", "preset_metadata")
    }


def scene_prompt(name, upstream=None):
    inputs = {
        "prompt_name": name,
        "positive_base": name,
        "positive_json": '{"version":1,"categories":{}}',
        "negative_base": "",
        "negative_json": '{"version":1,"categories":{}}',
        "category_order": "",
        "seed": 0,
        "randomize": True,
    }
    if upstream:
        inputs["scene_prompt"] = upstream
    return {"class_type": "ScenePrompter", "inputs": inputs}


def preset(preset_id, nodes, workflow_nodes):
    return {
        "schema_version": 1,
        "metadata": {"preset_id": preset_id, "name": preset_id, "revision": 1, "sha256": "snapshot"},
        "api_graph": {"output": nodes},
        "workflow": {"nodes": workflow_nodes, "links": [], "groups": [], "last_node_id": 30, "last_link_id": 20},
    }


def workflow_node(node_id, node_type, position, inputs=(), outputs=1):
    return {
        "id": int(node_id),
        "type": node_type,
        "pos": list(position),
        "size": [220, 120],
        "inputs": [{"name": name, "type": "SCENE_PROMPT", "link": None} for name in inputs],
        "outputs": [{"name": "scene_prompt", "type": "SCENE_PROMPT", "links": []} for _ in range(outputs)],
        "widgets_values": [node_type],
    }


def outer_workflow(prompt):
    result = []
    for index, (node_id, node) in enumerate(prompt.items()):
        inputs = tuple(node.get("inputs", {}))
        result.append(workflow_node(node_id, node["class_type"], [index * 150, index * 50], inputs))
    return {"nodes": result, "links": [], "groups": [], "last_node_id": 9, "last_link_id": 0}


def simple_preset(preset_id, prompt_id="11", output_id="12", input_id="10", name="inside"):
    nodes = {
        input_id: {"class_type": "ScenePresetInput", "inputs": {}},
        prompt_id: scene_prompt(name, [input_id, 0]),
        output_id: {
            "class_type": "ScenePresetOutput",
            "inputs": {"preset_id": preset_id, "preset_name": preset_id, "scene_prompt": [prompt_id, 0]},
        },
    }
    workflow = [
        workflow_node(input_id, "ScenePresetInput", [0, 0]),
        workflow_node(prompt_id, "ScenePrompter", [40, 60], ("scene_prompt",)),
        workflow_node(output_id, "ScenePresetOutput", [300, 60], ("scene_prompt",)),
    ]
    return preset(preset_id, nodes, workflow)


class PresetMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        modules = load_modules(self.root)
        self.nodes = modules["nodes"]
        self.presets = modules["presets"]
        self.runs = modules["runs"]
        self.metadata_module = modules["preset_metadata"]
        self.run_handle = self.runs.create_run_context("default")

    def tearDown(self):
        self.temp.cleanup()

    def put_snapshots(self, values):
        key = ("default", self.run_handle)
        self.presets._RUN_SNAPSHOTS[key] = {
            "presets": copy.deepcopy(values),
            "response": {},
            "last_access": time.monotonic(),
        }

    def metadata(self, prompt, mode, sources, expand=True):
        return self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": outer_workflow(prompt), "custom": {"kept": True}},
            "9",
            mode,
            {"run_handle": self.run_handle, "source_node_ids": sources},
            expand,
        )

    def test_off_returns_the_existing_metadata_objects(self):
        prompt = {"1": scene_prompt("outside"), "9": {"class_type": "SceneSaveImage", "inputs": {}}}
        extra = {"workflow": outer_workflow(prompt)}
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt, extra, "9", self.nodes.SAVE_METADATA_WORKFLOW, {"run_handle": self.run_handle}, False
        )
        self.assertIs(saved_prompt, prompt)
        self.assertIs(saved_extra, extra)

    def test_enabled_expansion_without_a_reference_does_not_require_a_snapshot(self):
        prompt = {"1": scene_prompt("outside"), "9": {"class_type": "SceneSaveImage", "inputs": {}}}
        extra = {"workflow": outer_workflow(prompt)}
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt, extra, "9", self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": "missing"}, True,
        )
        self.assertIs(saved_prompt, prompt)
        self.assertIs(saved_extra, extra)

    def test_full_expansion_rewires_graph_preserves_layout_and_rebuilds_links(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "3": scene_prompt("after", ["2", 0]),
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        saved_prompt, saved_extra = self.metadata(prompt, self.nodes.SAVE_METADATA_WORKFLOW, ["1", "2", "3"])
        self.assertNotIn("2", saved_prompt)
        self.assertNotIn("ScenePresetReference", {node["class_type"] for node in saved_prompt.values()})
        self.assertNotIn("ScenePresetInput", {node["class_type"] for node in saved_prompt.values()})
        self.assertNotIn("ScenePresetOutput", {node["class_type"] for node in saved_prompt.values()})
        inside_id = next(
            node_id
            for node_id, node in saved_prompt.items()
            if node.get("inputs", {}).get("prompt_name") == "inside"
        )
        self.assertEqual(saved_prompt[inside_id]["inputs"]["scene_prompt"], ["1", 0])
        self.assertEqual(saved_prompt["3"]["inputs"]["scene_prompt"], [inside_id, 0])
        workflow = saved_extra["workflow"]
        workflow_by_id = {str(node["id"]): node for node in workflow["nodes"]}
        self.assertEqual(workflow_by_id["1"]["pos"], [0, 0])
        self.assertEqual(workflow_by_id[inside_id]["pos"], [150.0, 50.0])
        self.assertEqual(workflow["last_node_id"], max(node["id"] for node in workflow["nodes"]))
        self.assertEqual(workflow["last_link_id"], len(workflow["links"]))
        self.assertTrue(all(str(link[1]) in workflow_by_id and str(link[3]) in workflow_by_id for link in workflow["links"]))

    def test_full_expansion_preserves_unrelated_workflow_branch_byte_for_byte(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "3": scene_prompt("after", ["2", 0]),
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        workflow = outer_workflow(prompt)
        unrelated_source = workflow_node("70", "UnrelatedSource", [900, 20])
        unrelated_target = workflow_node("71", "UnrelatedTarget", [1100, 20], ("scene_prompt",))
        unrelated_source["outputs"][0]["links"] = [501]
        unrelated_target["inputs"][0]["link"] = 501
        workflow["nodes"].extend([unrelated_source, unrelated_target])
        workflow["links"] = [[501, 70, 0, 71, 0, "SCENE_PROMPT"]]
        workflow["reroutes"] = [{"id": 44, "linkIds": [501], "pos": [1000, 70]}]
        workflow["groups"] = [{"title": "unchanged", "bounding": [880, 0, 300, 140]}]
        workflow["last_link_id"] = 501
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": self.run_handle, "source_node_ids": ["1", "2", "3"]},
            True,
        )
        saved_workflow = saved_extra["workflow"]
        self.assertNotIn("2", saved_prompt)
        self.assertIn([501, 70, 0, 71, 0, "SCENE_PROMPT"], saved_workflow["links"])
        saved_nodes = {str(node["id"]): node for node in saved_workflow["nodes"]}
        self.assertEqual(saved_nodes["70"], unrelated_source)
        self.assertEqual(saved_nodes["71"], unrelated_target)
        self.assertEqual(saved_workflow["reroutes"], workflow["reroutes"])
        self.assertEqual(saved_workflow["groups"], workflow["groups"])

    def test_full_expansion_rewires_reference_fanout_outside_api_prompt(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "3": scene_prompt("after", ["2", 0]),
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        workflow = outer_workflow(prompt)
        reference = next(node for node in workflow["nodes"] if node["id"] == 2)
        sibling = workflow_node("72", "WorkflowOnlySibling", [520, 90], ("scene_prompt",))
        reference["outputs"][0]["links"] = [601]
        sibling["inputs"][0]["link"] = 601
        workflow["nodes"].append(sibling)
        workflow["links"] = [[601, 2, 0, 72, 0, "SCENE_PROMPT"]]
        workflow["last_link_id"] = 601
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": self.run_handle, "source_node_ids": ["1", "2", "3"]},
            True,
        )
        inside_id = next(
            node_id for node_id, node in saved_prompt.items()
            if node.get("inputs", {}).get("prompt_name") == "inside"
        )
        fanout = next(link for link in saved_extra["workflow"]["links"] if str(link[3]) == "72")
        self.assertGreater(fanout[0], 601)
        self.assertEqual((str(fanout[1]), fanout[2], fanout[4]), (inside_id, 0, 0))
        sibling_after = next(node for node in saved_extra["workflow"]["nodes"] if node["id"] == 72)
        self.assertEqual(sibling_after["inputs"][0]["link"], fanout[0])

    def test_full_expansion_replaces_disconnected_workflow_reference_from_snapshot(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["1", 0]}},
        }
        workflow = outer_workflow(prompt)
        source = workflow_node("50", "ScenePrompter", [500, 0])
        reference = workflow_node("51", "ScenePresetReference", [700, 0], ("scene_prompt",))
        reference["widgets_values"] = ["one"]
        target = workflow_node("52", "ScenePromptCounter", [900, 0], ("scene_prompt",))
        source["outputs"][0]["links"] = [701]
        reference["inputs"][0]["link"] = 701
        reference["outputs"][0]["links"] = [702]
        target["inputs"][0]["link"] = 702
        workflow["nodes"].extend([source, reference, target])
        workflow["links"] = [
            [701, 50, 0, 51, 0, "SCENE_PROMPT"],
            [702, 51, 0, 52, 0, "SCENE_PROMPT"],
        ]
        workflow["last_link_id"] = 702
        _saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": self.run_handle},
            True,
        )
        saved_workflow = saved_extra["workflow"]
        self.assertNotIn("ScenePresetReference", {node["type"] for node in saved_workflow["nodes"]})
        self.assertNotIn("ScenePresetInput", {node["type"] for node in saved_workflow["nodes"]})
        self.assertNotIn("ScenePresetOutput", {node["type"] for node in saved_workflow["nodes"]})
        inside = next(node for node in saved_workflow["nodes"] if node["type"] == "ScenePrompter" and node["id"] not in {1, 50})
        self.assertTrue(any(str(link[1]) == "50" and str(link[3]) == str(inside["id"]) for link in saved_workflow["links"]))
        self.assertTrue(any(str(link[1]) == str(inside["id"]) and str(link[3]) == "52" for link in saved_workflow["links"]))

    def test_full_expansion_recurses_through_disconnected_workflow_references(self):
        child = simple_preset("child", name="child inside")
        parent_nodes = {
            "20": {"class_type": "ScenePresetInput", "inputs": {}},
            "21": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "child", "scene_prompt": ["20", 0]}},
            "22": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "parent", "preset_name": "parent", "scene_prompt": ["21", 0]}},
        }
        parent_workflow = [
            workflow_node("20", "ScenePresetInput", [0, 0]),
            workflow_node("21", "ScenePresetReference", [80, 0], ("scene_prompt",)),
            workflow_node("22", "ScenePresetOutput", [240, 0], ("scene_prompt",)),
        ]
        parent_workflow[1]["widgets_values"] = ["child"]
        self.put_snapshots({"child": child, "parent": preset("parent", parent_nodes, parent_workflow)})
        prompt = {"1": scene_prompt("outside"), "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["1", 0]}}}
        workflow = outer_workflow(prompt)
        reference = workflow_node("50", "ScenePresetReference", [500, 0])
        reference["widgets_values"] = ["parent"]
        workflow["nodes"].append(reference)

        _saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": self.run_handle},
            True,
        )
        types = {node["type"] for node in saved_extra["workflow"]["nodes"]}
        self.assertNotIn("ScenePresetReference", types)
        self.assertNotIn("ScenePresetInput", types)
        self.assertNotIn("ScenePresetOutput", types)
        self.assertIn("ScenePrompter", types)

    def test_full_expansion_removes_only_reroutes_for_replaced_reference_links(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "3": scene_prompt("after", ["2", 0]),
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        workflow = outer_workflow(prompt)
        nodes = {str(node["id"]): node for node in workflow["nodes"]}
        nodes["1"]["outputs"][0]["links"] = [101]
        nodes["2"]["inputs"][0]["link"] = 101
        nodes["2"]["outputs"][0]["links"] = [102]
        nodes["3"]["inputs"][0]["link"] = 102
        source = workflow_node("80", "UnrelatedSource", [700, 0])
        target = workflow_node("81", "UnrelatedTarget", [900, 0], ("scene_prompt",))
        source["outputs"][0]["links"] = [501]
        target["inputs"][0]["link"] = 501
        workflow["nodes"].extend([source, target])
        workflow["links"] = [
            [101, 1, 0, 2, 0, "SCENE_PROMPT"],
            [102, 2, 0, 3, 0, "SCENE_PROMPT"],
            [501, 80, 0, 81, 0, "SCENE_PROMPT"],
        ]
        unchanged_reroute = {"id": 3, "linkIds": [501], "pos": [800, 0]}
        workflow["reroutes"] = [
            {"id": 1, "linkIds": [101], "pos": [75, 0]},
            {"id": 2, "linkIds": [102], "pos": [225, 0]},
            unchanged_reroute,
            {"id": 4, "linkIds": [101, 501], "pos": [400, 0]},
        ]
        saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": self.run_handle, "source_node_ids": ["1", "2", "3"]},
            True,
        )
        self.assertNotIn("2", saved_prompt)
        reroutes = saved_extra["workflow"]["reroutes"]
        self.assertEqual(next(reroute for reroute in reroutes if reroute["id"] == 3), unchanged_reroute)
        self.assertEqual(next(reroute for reroute in reroutes if reroute["id"] == 4)["linkIds"], [501])
        self.assertEqual({reroute["id"] for reroute in reroutes}, {3, 4})
        link_ids = {link[0] for link in saved_extra["workflow"]["links"]}
        self.assertTrue(all(link_id in link_ids for reroute in reroutes for link_id in reroute["linkIds"]))
        for node in saved_extra["workflow"]["nodes"]:
            for slot in node.get("inputs", []):
                if isinstance(slot, dict) and slot.get("link") is not None:
                    self.assertIn(slot["link"], link_ids)
            for slot in node.get("outputs", []):
                if isinstance(slot, dict):
                    self.assertTrue(all(link_id in link_ids for link_id in slot.get("links", [])))

    def test_full_expansion_keeps_existing_reroute_link_ids(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["2", 0]}},
        }
        workflow = outer_workflow(prompt)
        source = workflow_node("80", "RerouteSource", [700, 0])
        target = workflow_node("81", "RerouteTarget", [900, 0], ("scene_prompt",))
        source["outputs"][0]["links"] = [812]
        target["inputs"][0]["link"] = 812
        workflow["nodes"].extend([source, target])
        workflow["links"] = [[812, 80, 0, 81, 0, "SCENE_PROMPT"]]
        workflow["reroutes"] = [{"id": 98, "linkIds": [812], "pos": [800, 0]}]
        workflow["last_link_id"] = 900
        _saved_prompt, saved_extra = self.nodes._metadata_for_save_mode(
            prompt,
            {"workflow": workflow},
            "9",
            self.nodes.SAVE_METADATA_WORKFLOW,
            {"run_handle": self.run_handle, "source_node_ids": ["1", "2"]},
            True,
        )
        self.assertIn([812, 80, 0, 81, 0, "SCENE_PROMPT"], saved_extra["workflow"]["links"])
        self.assertEqual(saved_extra["workflow"]["reroutes"], workflow["reroutes"])
        self.assertGreater(saved_extra["workflow"]["last_link_id"], 900)

    def test_execution_path_keeps_the_selected_queue_branch_inside_a_preset(self):
        preset_nodes = {
            "10": {"class_type": "ScenePresetInput", "inputs": {}},
            "11": scene_prompt("left", ["10", 0]),
            "12": scene_prompt("right", ["10", 0]),
            "13": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["11", 0], "scene_prompt2": ["12", 0]}},
            "14": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "queue", "preset_name": "queue", "scene_prompt": ["13", 0]}},
        }
        preset_workflow = [
            workflow_node("10", "ScenePresetInput", [0, 0]),
            workflow_node("11", "ScenePrompter", [10, 40], ("scene_prompt",)),
            workflow_node("12", "ScenePrompter", [10, 130], ("scene_prompt",)),
            workflow_node("13", "ScenePrompterQueue", [260, 80], ("scene_prompt1", "scene_prompt2")),
            workflow_node("14", "ScenePresetOutput", [450, 80], ("scene_prompt",)),
        ]
        self.put_snapshots({"queue": preset("queue", preset_nodes, preset_workflow)})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "queue", "scene_prompt": ["1", 0]}},
            "4": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["2", 0]}},
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["4", 0]}},
        }
        saved_prompt, saved_extra = self.metadata(
            prompt,
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            ["1", "2/11", "2/13", "2", "4"],
        )
        names = {node["inputs"].get("prompt_name") for node in saved_prompt.values() if node["class_type"] == "ScenePrompter"}
        self.assertEqual(names, {"outside", "left"})
        self.assertIn("ScenePrompterQueue", {node["class_type"] for node in saved_prompt.values()})
        self.assertNotIn("right", names)
        saved_ids = {str(node["id"]) for node in saved_extra["workflow"]["nodes"]}
        self.assertEqual(saved_ids, set(saved_prompt))

    def test_execution_path_keeps_the_selected_matrix_node_inside_a_preset(self):
        preset_nodes = {
            "10": {"class_type": "ScenePresetInput", "inputs": {}},
            "11": {"class_type": "SceneMatrix", "inputs": {"matrix_json": '{"version":1,"sets":[]}', "scene_prompt": ["10", 0]}},
            "12": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "matrix", "preset_name": "matrix", "scene_prompt": ["11", 0]}},
        }
        preset_workflow = [
            workflow_node("10", "ScenePresetInput", [0, 0]),
            workflow_node("11", "SceneMatrix", [60, 60], ("scene_prompt",)),
            workflow_node("12", "ScenePresetOutput", [300, 60], ("scene_prompt",)),
        ]
        self.put_snapshots({"matrix": preset("matrix", preset_nodes, preset_workflow)})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "matrix", "scene_prompt": ["1", 0]}},
            "4": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["2", 0]}},
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["4", 0]}},
        }
        saved_prompt, _ = self.metadata(
            prompt,
            self.nodes.SAVE_METADATA_EXECUTION_PATH,
            ["1", "2/11", "2", "4"],
        )
        self.assertEqual(sum(node["class_type"] == "SceneMatrix" for node in saved_prompt.values()), 1)

    def test_nested_and_repeated_references_have_distinct_nodes(self):
        child = simple_preset("child", name="child")
        parent_nodes = {
            "20": {"class_type": "ScenePresetInput", "inputs": {}},
            "21": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "child", "scene_prompt": ["20", 0]}},
            "22": {"class_type": "ScenePresetOutput", "inputs": {"preset_id": "parent", "preset_name": "parent", "scene_prompt": ["21", 0]}},
        }
        parent_workflow = [
            workflow_node("20", "ScenePresetInput", [0, 0]),
            workflow_node("21", "ScenePresetReference", [80, 30], ("scene_prompt",)),
            workflow_node("22", "ScenePresetOutput", [300, 30], ("scene_prompt",)),
        ]
        self.put_snapshots({"child": child, "parent": preset("parent", parent_nodes, parent_workflow)})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "parent", "scene_prompt": ["1", 0]}},
            "3": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "child", "scene_prompt": ["1", 0]}},
            "4": {"class_type": "ScenePrompterMerge", "inputs": {"scene_prompt1": ["2", 0], "scene_prompt2": ["3", 0]}},
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["4", 0]}},
        }
        saved_prompt, _ = self.metadata(prompt, self.nodes.SAVE_METADATA_WORKFLOW, ["1"])
        self.assertNotIn("ScenePresetReference", {node["class_type"] for node in saved_prompt.values()})
        child_nodes = [node_id for node_id, node in saved_prompt.items() if node.get("inputs", {}).get("prompt_name") == "child"]
        self.assertEqual(len(child_nodes), 2)
        self.assertEqual(len(set(child_nodes)), 2)

    def test_snapshot_is_used_and_prompt_only_ignores_expansion(self):
        snapshot = simple_preset("one", name="snapshot")
        self.put_snapshots({"one": snapshot})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["2", 0]}},
        }
        snapshot["api_graph"]["output"]["11"]["inputs"]["prompt_name"] = "changed later"
        saved_prompt, _ = self.metadata(prompt, self.nodes.SAVE_METADATA_WORKFLOW, ["1"])
        names = {node["inputs"].get("prompt_name") for node in saved_prompt.values() if node["class_type"] == "ScenePrompter"}
        self.assertIn("snapshot", names)
        prompt_only, prompt_only_extra = self.nodes._metadata_for_save_mode(
            prompt, {"workflow": outer_workflow(prompt)}, "9", self.nodes.SAVE_METADATA_PROMPT_ONLY,
            {"run_handle": "missing"}, True,
        )
        self.assertIsNone(prompt_only)
        self.assertNotIn("workflow", prompt_only_extra)

    def test_boolean_input_is_optional_and_default_false(self):
        input_types = self.nodes.SceneSaveImage.INPUT_TYPES()
        self.assertNotIn("expand_preset_contents", input_types["required"])
        optional = input_types["optional"]
        self.assertEqual(list(optional).index("expand_preset_contents"), 0)
        self.assertEqual(list(optional).index("scene_info"), 1)
        self.assertEqual(optional["expand_preset_contents"][0], "BOOLEAN")
        self.assertIs(optional["expand_preset_contents"][1]["default"], False)

    def test_runtime_preset_nodes_record_their_expanded_source_lineage(self):
        value = simple_preset("one")
        value["metadata"]["sha256"] = self.presets._content_hash(value["api_graph"], value["workflow"])
        self.put_snapshots({"one": value})
        expanded = self.presets.expand_preset_reference(
            "one", ["outer", 0], self.run_handle, source_node_id="2"
        )["expand"]
        self.assertEqual(expanded["11"]["inputs"]["source_node_id"], "2/11")
        self.assertEqual(expanded["__scene_preset_source"]["inputs"]["source_node_id"], "2")

    def test_png_metadata_contains_a_reloadable_expanded_graph(self):
        self.put_snapshots({"one": simple_preset("one")})
        prompt = {
            "1": scene_prompt("outside"),
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "one", "scene_prompt": ["1", 0]}},
            "3": scene_prompt("after", ["2", 0]),
            "9": {"class_type": "SceneSaveImage", "inputs": {"images": ["3", 0]}},
        }
        result = self.nodes.SceneSaveImage().save_images(
            [torch.zeros((8, 8, 3))],
            "metadata",
            metadata_mode=self.nodes.SAVE_METADATA_WORKFLOW,
            expand_preset_contents=True,
            scene_info={"use_run_dir": False, "file_index": 1, "run_handle": self.run_handle, "source_node_ids": ["1", "2/11", "2", "3"]},
            prompt=prompt,
            extra_pnginfo={"workflow": outer_workflow(prompt)},
            unique_id="9",
        )
        with Image.open(Path(result["result"][1])) as image:
            metadata = dict(image.text)
        saved_prompt = json.loads(metadata["prompt"])
        saved_workflow = json.loads(metadata["workflow"])
        self.assertNotIn("ScenePresetReference", {node["class_type"] for node in saved_prompt.values()})
        node_ids = {str(node["id"]) for node in saved_workflow["nodes"]}
        self.assertEqual(node_ids, set(saved_prompt))
        self.assertTrue(all(str(link[1]) in node_ids and str(link[3]) in node_ids for link in saved_workflow["links"]))


if __name__ == "__main__":
    unittest.main()
