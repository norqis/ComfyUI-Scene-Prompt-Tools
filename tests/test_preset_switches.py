import copy
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_scene_presets import load_presets_module, basic_nodes
from test_preset_metadata import workflow_node, outer_workflow


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def switched_nodes(control=None):
    nodes = basic_nodes("false branch")
    nodes["1"]["inputs"]["switch_names_json"] = '["選択"]'
    nodes["4"] = copy.deepcopy(nodes["2"])
    nodes["4"]["inputs"]["positive_base"] = "true branch"
    nodes["5"] = node("ScenePromptCounter", scene_prompt=["2", 0], count=3)
    nodes["6"] = node("ScenePromptCounter", scene_prompt=["4", 0], count=7)
    nodes["7"] = node("ComfySwitchNode", switch=control if control is not None else ["1", 1],
                      on_false=["5", 0], on_true=["6", 0])
    nodes["3"]["inputs"]["scene_prompt"] = ["7", 0]
    return nodes


class PresetSwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.module = load_presets_module(Path(self.temp.name))
        self.switches = importlib.import_module(f"{self.module.__package__}.switches")
        self.metadata = importlib.import_module(f"{self.module.__package__}.preset_metadata")
        self.info = importlib.import_module(f"{self.module.__package__}.resource_info")

    def tearDown(self):
        self.temp.cleanup()

    def preset(self, preset_id, nodes):
        workflow_nodes = []
        links = []
        for node_id, value in nodes.items():
            inputs = tuple(name for name, raw in value["inputs"].items() if isinstance(raw, list) and len(raw) == 2 and isinstance(raw[0], str))
            template = workflow_node(node_id, value["class_type"], [0, 0], inputs,
                                     outputs=12 if value["class_type"] == "ScenePresetInput" else 1)
            if value["class_type"] == "ScenePresetInput":
                template["widgets_values"] = [value["inputs"].get("switch_names_json", "[]")]
            for slot, name in enumerate(inputs):
                source, source_slot = value["inputs"][name]
                links.append([len(links) + 1, int(source), source_slot, int(node_id), slot,
                              "BOOLEAN" if name == "switch" else "SCENE_SWITCHES" if name == "switches" else "SCENE_PROMPT"])
            workflow_nodes.append(template)
        return {"schema_version": 1, "metadata": {"preset_id": preset_id, "name": preset_id, "sha256": "hash"},
                "api_graph": {"output": nodes}, "workflow": {"nodes": workflow_nodes, "links": links}}

    def evaluate(self, preset, vector=None, resolved=None, memo=None):
        return self.module._evaluate_preset_scene(preset, resolved or {}, None, switches=vector, preset_value_memo=memo)

    def test_fixed_ports_strict_vectors_names_and_simultaneous_mapping(self):
        result = self.module.ScenePresetInput().build()
        self.assertEqual(len(result), 12)
        self.assertEqual(result[1:11], (False,) * 10)
        self.assertEqual(result[11], (False,) * 10)
        self.assertEqual(self.module.ScenePresetInput.RETURN_NAMES[1:11], tuple(f"switch_{n}" for n in range(1, 11)))
        vector = tuple(n % 2 == 0 for n in range(10))
        settings = [2, 1, 1, True, False, 10, 9, 8, 7, 6]
        self.assertEqual(self.switches.resolve_switches(vector, json.dumps(settings)),
                         (vector[1], vector[0], vector[0], True, False, vector[9], vector[8], vector[7], vector[6], vector[5]))
        self.assertEqual(self.switches.resolve_switches(vector), vector)
        self.assertEqual(self.switches.resolve_switches(), (False,) * 10)
        self.assertEqual(self.switches.switch_names('["日本語","","日本語"]')[:4], ("日本語", "スイッチ2", "日本語", "スイッチ4"))
        for invalid in ([True] * 9, [1] * 10, "false", [False] * 11):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.switches.switch_values(invalid)
        for invalid in ([0] * 10, [11] * 10, [1.0] * 10, ["ON"] * 10, [True] * 9, {}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.switches.switch_settings(json.dumps(invalid))

    def test_all_ten_input_slots_choose_only_one_branch_and_memo_distinguishes_vectors(self):
        memo = {}
        for slot in range(1, 11):
            preset = self.preset("choice", switched_nodes(["1", slot]))
            for enabled, total in ((False, 3), (True, 7)):
                vector = tuple(enabled if index == slot - 1 else False for index in range(10))
                plan = self.evaluate(preset, vector, memo=memo)
                self.assertEqual(plan["stats"]["total_images"], total)
                sources = self.module._scene_node_value(preset["api_graph"]["output"], "7", {}, set(),
                    input_values={"1": (self.module.seed_plan(), *vector, vector)})
                self.assertEqual(sources["stats"]["total_images"], total)
            memo.clear()

    def test_unselected_branch_is_never_evaluated_and_unknown_boolean_fails_before_branches(self):
        nodes = switched_nodes(False)
        nodes["6"] = node("UnknownModelProvider", model="must never run")
        plan = self.module._scene_node_value(nodes, "7", {}, set())
        self.assertEqual(plan["stats"]["total_images"], 3)
        nodes["7"]["inputs"]["switch"] = ["8", 0]
        nodes["8"] = node("UnknownBooleanProvider")
        with mock.patch.object(self.module.ScenePrompt, "build", side_effect=AssertionError("branch was evaluated")):
            with self.assertRaisesRegex(self.module.ScenePresetError, "安全"):
                self.module._scene_node_value(nodes, "7", {}, set())

    def test_primitive_boolean_literal_and_long_iterative_chain(self):
        nodes = switched_nodes(["8", 0])
        nodes["8"] = node("PrimitiveBoolean", value=True)
        self.module._validate_preset_runtime(nodes)
        for index in range(1000, 2200):
            nodes[str(index)] = node("ComfySwitchNode", switch=True, on_true=["7" if index == 1000 else str(index - 1), 0], on_false=["6", 0])
        self.assertEqual(self.module._scene_node_value(nodes, "2199", {}, set())["stats"]["total_images"], 7)
        nodes["8"]["inputs"]["value"] = "true"
        with self.assertRaises(self.module.ScenePresetError):
            self.module._validate_preset_runtime(nodes)

    def test_bundle_only_three_levels_and_siblings_do_not_implicitly_inherit(self):
        child = self.preset("child", switched_nodes())
        middle_nodes = {"1": node("ScenePresetInput"), "2": node("ScenePresetReference", preset_id="child", switches=["1", 11]),
                        "3": node("ScenePresetOutput", scene_prompt=["2", 0])}
        middle = self.preset("middle", middle_nodes)
        parent_nodes = {"1": node("ScenePresetInput"), "2": node("ScenePresetReference", preset_id="middle", switches=["1", 11]),
                        "4": node("ScenePresetReference", preset_id="child"),
                        "5": node("ScenePrompterQueue", scene_prompt1=["2", 0], scene_prompt2=["4", 0]),
                        "3": node("ScenePresetOutput", scene_prompt=["5", 0])}
        parent = self.preset("parent", parent_nodes)
        resolved = {"child": child, "middle": middle, "__switch_values__": {}}
        self.assertEqual(self.evaluate(parent, (True,) * 10, resolved)["stats"]["total_images"], 10)
        self.assertEqual(resolved["__switch_values__"]["2/2"], (True,) * 10)
        self.assertEqual(resolved["__switch_values__"]["4"], (False,) * 10)

    def test_two_references_same_preset_map_independently_and_compact_keeps_only_controls(self):
        choice = self.preset("choice", switched_nodes())
        nodes = {"1": node("ScenePresetInput", switch_values={"values": [True] * 10}),
                 "2": node("ScenePresetReference", preset_id="choice", switches=["1", 11]),
                 "4": node("ScenePresetReference", preset_id="choice", switches=["1", 11], switch_settings_json=json.dumps([False] * 10)),
                 "5": node("ScenePrompterQueue", scene_prompt1=["2", 0], scene_prompt2=["4", 0])}
        plan = self.module._scene_node_value(nodes, "5", {"choice": choice}, set(), preset_value_memo={})
        self.assertEqual(plan["stats"]["total_images"], 10)
        compact = self.module._compact_preset_list_graph(choice["api_graph"])["output"]
        self.assertEqual(compact["1"]["inputs"]["switch_names_json"], '["選択"]')
        self.assertEqual(compact["7"]["inputs"]["switch"], ["1", 1])
        self.assertNotIn("positive_base", compact["2"]["inputs"])

    def test_graph_expansion_replaces_only_scene_slot_and_never_injects_standard_node_hidden_args(self):
        choice = self.preset("choice", switched_nodes())
        with mock.patch.object(self.module, "prepare_preset_occurrences", return_value={"ref": choice}):
            expanded = self.module.expand_preset_reference("choice", ["outside", 0], source_node_id="ref", switches=[True] * 10)
        graph = expanded["expand"]
        input_id = next(key for key, item in graph.items() if item["class_type"] == "ScenePresetInput")
        standard = next(item for item in graph.values() if item["class_type"] == "ComfySwitchNode")
        self.assertEqual(standard["inputs"]["switch"], [input_id, 1])
        self.assertEqual(set(standard["inputs"]), {"switch", "on_false", "on_true"})
        self.assertEqual(graph[input_id]["inputs"]["switch_values"], {"values": [True] * 10})
        scenes = [item for item in graph.values() if item["class_type"] == "ScenePrompter"]
        self.assertTrue(all(item["inputs"]["scene_prompt"] == ["outside", 0] for item in scenes))

    def test_snapshot_freezes_effective_vector_and_release_removes_it(self):
        choice = self.preset("choice", switched_nodes())
        nodes = {"20": node("ScenePresetReference", preset_id="choice", switch_settings_json=json.dumps([True] * 10)),
                 "21": node("ScenePrompterExpand", scene_prompt=["20", 0])}
        with mock.patch.object(self.module, "prepare_preset_occurrences", return_value={"20": choice}):
            response = self.module.snapshot_presets_for_run("frozen", {"output": nodes}, "21")
        self.assertEqual(response["total_images"], 7)
        expanded = self.module.expand_preset_reference("choice", run_handle="frozen", source_node_id="20",
                                                       switch_settings_json=json.dumps([False] * 10))
        values = next(item["inputs"]["switch_values"] for item in expanded["expand"].values() if item["class_type"] == "ScenePresetInput")
        self.assertEqual(values, {"values": [True] * 10})
        self.module.release_scene_preset_snapshot("frozen")
        self.assertFalse(self.module._RUN_SNAPSHOTS)

    def test_resources_select_branch_without_evaluating_models_or_loras(self):
        nodes = {"1": node("ScenePresetInput", switch_values={"values": [True] * 10}),
                 "2": node("SceneApplyLora", scene_prompt=["1", 0], lora_name="false.safetensors"),
                 "3": node("SceneApplyLora", scene_prompt=["1", 0], lora_name="true.safetensors"),
                 "4": node("ComfySwitchNode", switch=["1", 1], on_false=["2", 0], on_true=["3", 0]),
                 "5": node("ScenePrompterExpand", scene_prompt=["4", 0])}
        with mock.patch.object(self.module.SceneApplyLora, "apply_lora", side_effect=AssertionError("resource traversal evaluated LoRA")):
            result = self.info.connected_resources({"output": nodes}, "5")
        self.assertEqual([item["name"] for item in result["loras"]], ["true.safetensors"])

    def test_png_expansion_keeps_bool_ports_names_and_both_branches_with_scene_upstream(self):
        choice = self.preset("choice", switched_nodes())
        prompt = {"10": node("ScenePrompter"), "20": node("ScenePresetReference", preset_id="choice", scene_prompt=["10", 0], switch_settings_json=json.dumps([True] * 10)),
                  "30": node("ScenePrompterExpand", scene_prompt=["20", 0])}
        expanded, workflow, aliases = self.metadata.expand_preset_references(prompt, outer_workflow(prompt), {"choice": choice})
        input_id = next(key for key, item in expanded.items() if item["class_type"] == "ScenePresetInput")
        standard = next(item for item in expanded.values() if item["class_type"] == "ComfySwitchNode")
        self.assertEqual(standard["inputs"]["switch"], [input_id, 1])
        self.assertEqual(expanded[input_id]["inputs"]["switch_values"], {"values": [True] * 10})
        self.assertEqual(expanded[input_id]["inputs"]["switch_names_json"], '["選択"]')
        self.assertEqual(len([item for item in expanded.values() if item["class_type"] == "ScenePrompter"]), 3)
        copied_input = next(item for item in workflow["nodes"] if str(item["id"]) == input_id)
        self.assertEqual(copied_input["properties"]["scene_switch_values"], [True] * 10)
        self.assertTrue(any(str(edge[1]) == input_id and edge[2] == 1 and edge[5] == "BOOLEAN" for edge in workflow["links"]))

    def test_png_keeps_input_boolean_wired_only_to_bypassed_switch(self):
        nodes = basic_nodes()
        choice = self.preset("bypassed", nodes)
        switch = workflow_node("8", "ComfySwitchNode", [100, 0], ("switch", "on_false", "on_true"))
        switch["mode"] = 4
        choice["workflow"]["nodes"].append(switch)
        choice["workflow"]["links"].extend([[50, 1, 4, 8, 0, "BOOLEAN"], [51, 2, 0, 8, 1, "SCENE_PROMPT"], [52, 2, 0, 8, 2, "SCENE_PROMPT"]])
        prompt = {"10": node("ScenePrompter"), "20": node("ScenePresetReference", preset_id="bypassed", scene_prompt=["10", 0])}
        expanded, workflow, aliases = self.metadata.expand_preset_references(prompt, outer_workflow(prompt), {"bypassed": choice})
        input_id = next(key for key, item in expanded.items() if item["class_type"] == "ScenePresetInput")
        copied_switch = next(item for item in workflow["nodes"] if item["type"] == "ComfySwitchNode")
        self.assertEqual(copied_switch["mode"], 4)
        self.assertTrue(any(str(edge[1]) == input_id and edge[2] == 4 and edge[3] == copied_switch["id"] for edge in workflow["links"]))

    def test_execution_path_png_contracts_scene_switch_and_long_chain_visits_each_once(self):
        module_nodes = sys.modules[f"{self.module.__package__}.nodes"]
        graph = {"1": node("ScenePrompter"), "2": node("ScenePrompter"),
                 "3": node("ComfySwitchNode", switch=True, on_true=["1", 0], on_false=["2", 0]),
                 "4": node("ScenePrompterExpand", scene_prompt=["3", 0])}
        contracted, selected, replacements = module_nodes._contract_superseded_model_sources(graph, ["1", "4"])
        self.assertEqual(contracted["4"]["inputs"]["scene_prompt"], ["1", 0])
        retained = module_nodes._selected_ancestor_ids(contracted, "4", {}, selected)
        sliced = module_nodes._slice_prompt_to_ids(contracted, retained)
        self.assertEqual(set(sliced), {"1", "4"})
        # Reverse insertion forces the first traversal to encounter the whole
        # chain; operation-local memo must share that work with every suffix.
        chain = {str(index): node("ComfySwitchNode", switch=True,
                                on_true=["1" if index == 1000 else str(index - 1), 0], on_false=["2", 0])
                 for index in range(2199, 999, -1)}
        chain.update({"1": graph["1"], "2": graph["2"], "4": node("ScenePrompterExpand", scene_prompt=["2199", 0])})
        with mock.patch.object(module_nodes, "selected_switch_input", wraps=module_nodes.selected_switch_input) as choose:
            _, _, replacements = module_nodes._contract_superseded_model_sources(chain, ["1", "4"])
        self.assertEqual(choose.call_count, 1200)
        self.assertEqual(len(replacements), 1200)
        self.assertTrue(all(value == ["1", 0] for value in replacements.values()))

    def test_validation_preserves_callback_and_boolean_count_links_and_outer_boolean_strings(self):
        nodes = switched_nodes()
        nodes["8"] = node("PrimitiveBoolean", value=False)
        nodes["5"]["inputs"]["enable_downstream_count"] = ["8", 0]
        nodes["9"] = node("ScenePromptCallbackDesktop", title="selected", text="message")
        nodes["10"] = node("ScenePromptCallback", scene_prompt=["7", 0], callback=["9", 0])
        nodes["3"]["inputs"]["scene_prompt"] = ["10", 0]
        self.module._validate_preset_runtime(nodes)
        plan = self.evaluate(self.preset("callback", nodes))
        self.assertEqual(plan["stats"]["total_images"], 3)
        outer = {"8": node("PrimitiveBoolean", value="true"), "1": node("ScenePromptCounter", count=1), "2": node("ScenePromptCounter", count=1),
                 "7": node("ComfySwitchNode", switch=["8", 0], on_true=["1", 0], on_false=["2", 0])}
        self.assertEqual(self.module._scene_node_value(outer, "7", {}, set())["stats"]["total_images"], 1)
        self.assertTrue(self.module._scene_node_value(outer, "8", {}, set()))
        nodes["7"]["inputs"]["switch"] = ["1", 0]
        with self.assertRaisesRegex(self.module.ScenePresetError, "接続型"):
            self.module._validate_preset_graph(nodes)
        nodes["7"]["inputs"]["switch"] = ["1", 1]
        nodes["1"]["inputs"]["switch_names_json"] = ["8", 0]
        with self.assertRaisesRegex(self.module.ScenePresetError, "入力を接続"):
            self.module._validate_preset_graph(nodes)

    def test_compact_primitive_controls_settings_bundle_slots_and_million_count_stay_small(self):
        nodes = switched_nodes(["8", 0])
        nodes["2"] = node("SceneEmptyLatent", scene_prompt=["1", 0])
        nodes["4"] = node("SceneEmptyLatent", scene_prompt=["1", 0])
        nodes["8"] = node("PrimitiveBoolean", value=True)
        nodes["9"] = node("ScenePromptCounter", scene_prompt=["7", 0], count=1000000)
        nodes["3"]["inputs"]["scene_prompt"] = ["9", 0]
        full = self.preset("large", nodes)
        compact = self.module._compact_preset_list_graph(full["api_graph"])
        full_plan = self.evaluate(full)
        compact_plan = self.evaluate({**full, "api_graph": compact})
        self.assertEqual(full_plan["stats"]["total_images"], 7000000)
        self.assertEqual(full_plan["stats"], compact_plan["stats"])
        self.assertIs(compact["output"]["8"]["inputs"]["value"], True)
        self.assertLess(len(json.dumps(compact)), 3000)

    def test_nested_png_bundle_ports_and_sibling_vectors_stay_separate(self):
        child = self.preset("child", switched_nodes())
        parent_nodes = {"1": node("ScenePresetInput"),
                        "2": node("ScenePresetReference", preset_id="child", switches=["1", 11]),
                        "4": node("ScenePresetReference", preset_id="child", switches=["1", 11], switch_settings_json=json.dumps([False] * 10)),
                        "5": node("ScenePrompterQueue", scene_prompt1=["2", 0], scene_prompt2=["4", 0]),
                        "3": node("ScenePresetOutput", scene_prompt=["5", 0])}
        parent = self.preset("parent", parent_nodes)
        prompt = {"20": node("ScenePresetReference", preset_id="parent", switch_settings_json=json.dumps([True] * 10))}
        expanded, workflow, aliases = self.metadata.expand_preset_references(prompt, outer_workflow(prompt), {"parent": parent, "child": child})
        vectors = {aliases[key]: item["inputs"]["switch_values"]["values"] for key, item in expanded.items() if item["class_type"] == "ScenePresetInput"}
        self.assertEqual(vectors["20/1"], [True] * 10)
        self.assertEqual(vectors["20/2/1"], [True] * 10)
        self.assertEqual(vectors["20/4/1"], [False] * 10)
        for item in expanded.values():
            for value in item["inputs"].values():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    self.assertIn(value[0], expanded)

    def test_empty_input_scene_identity_png_is_replayable_without_contracting_other_switches(self):
        module_nodes = sys.modules[f"{self.module.__package__}.nodes"]
        graph = {"1": node("ScenePresetInput", switch_values={"values": [False] * 10}),
                 "2": basic_nodes()["2"],
                 "3": node("ComfySwitchNode", switch=["1", 1], on_false=["1", 0], on_true=["2", 0]),
                 "4": node("ScenePrompterExpand", scene_prompt=["3", 0]),
                 "8": node("ComfySwitchNode", switch=["1", 1], on_false=["1", 2], on_true=["1", 3]),
                 "9": node("ComfySwitchNode", switch=False, on_false=["1", 0], on_true=["2", 0])}
        contracted, selected, replacements = module_nodes._contract_superseded_model_sources(graph, ["4"])
        self.assertEqual(replacements, {"3": ["1", 0]})
        self.assertEqual(contracted["4"]["inputs"]["scene_prompt"], ["1", 0])
        included = module_nodes._selected_ancestor_ids(contracted, "4", {}, selected)
        replay = module_nodes._slice_prompt_to_ids(contracted, included)
        self.assertEqual(set(replay), {"1", "4"})
        self.assertEqual(self.module._scene_node_value(replay, "1", {}, set())[0]["stats"]["total_images"], 1)

    def test_saved_input_binding_never_overrides_new_reference_mapping(self):
        choice = self.preset("replayed", switched_nodes())
        choice["api_graph"]["output"]["1"]["inputs"]["switch_values"] = {"values": [True] * 10}
        self.assertEqual(self.evaluate(choice)["stats"]["total_images"], 3)
        self.assertEqual(self.evaluate(choice, (True,) * 10)["stats"]["total_images"], 7)
        with mock.patch.object(self.module, "prepare_preset_occurrences", return_value={"ref": choice}):
            graph = self.module.expand_preset_reference("replayed", source_node_id="ref", switch_settings_json=json.dumps([False] * 10))["expand"]
        binding = next(value["inputs"]["switch_values"] for value in graph.values() if value["class_type"] == "ScenePresetInput")
        self.assertEqual(binding, {"values": [False] * 10})

    def test_workflow_only_bundle_resolves_known_reroute_and_bypassed_nodes(self):
        choice = self.preset("choice", switched_nodes())
        for kind, mode in (("Reroute", 0), ("ComfySwitchNode", 4)):
            with self.subTest(kind=kind):
                source = workflow_node("10", "ScenePresetInput", [0, 0], outputs=12)
                source["properties"] = {"scene_switch_values": [True] * 10}
                reference = workflow_node("20", "ScenePresetReference", [200, 0], ("scene_prompt", "switches"))
                reference["widgets_values"] = ["choice", "", "{}", "[]"]
                relay = workflow_node("30", kind, [100, 0], ("bundle",))
                relay["mode"] = mode
                relay["inputs"][0]["type"] = "SCENE_SWITCHES"
                workflow = {"nodes": [source, reference, relay],
                            "links": [[1, 10, 11, 30, 0, "SCENE_SWITCHES"], [2, 30, 0, 20, 1, "SCENE_SWITCHES"]]}
                _, expanded, aliases = self.metadata.expand_preset_references({"10": node("ScenePresetInput")}, workflow, {"choice": choice}, True)
                copies = [item for item in expanded["nodes"] if item["type"] == "ScenePresetInput" and item["id"] != 10]
                self.assertEqual(copies[0]["properties"]["scene_switch_values"], [True] * 10)
                self.assertFalse(any(item["type"] == "ScenePresetReference" for item in expanded["nodes"]))

    def test_selected_queue_png_drops_other_scene_switch_but_keeps_image_model_switches(self):
        module_nodes = sys.modules[f"{self.module.__package__}.nodes"]
        graph = {"1": node("ScenePromptCounter", count=2), "2": node("ScenePromptCounter", count=3),
                 "3": node("ScenePromptCounter", count=4), "4": node("ScenePromptCounter", count=5),
                 "6": node("ComfySwitchNode", switch=False, on_false=["1", 0], on_true=["2", 0]),
                 "7": node("ComfySwitchNode", switch=True, on_false=["3", 0], on_true=["4", 0]),
                 "8": node("ScenePrompterQueue", scene_prompt1=["6", 0], scene_prompt2=["7", 0]),
                 "9": node("ScenePrompterExpand", scene_prompt=["8", 0]),
                 "10": node("SceneSaveImage", images=["20", 0], scene_info=["9", 2]),
                 "20": node("ComfySwitchNode", switch=True, on_false=["21", 0], on_true=["22", 0]),
                 "21": node("ImageFixture", model=["30", 0]), "22": node("ImageFixture", model=["30", 0]),
                 "30": node("ComfySwitchNode", switch=False, on_false=["31", 0], on_true=["32", 0]),
                 "31": node("ModelFixture"), "32": node("ModelFixture")}
        contracted, selected, replacements = module_nodes._contract_superseded_model_sources(graph, ["1", "8", "9"])
        self.assertEqual(replacements, {"6": ["1", 0]})
        replay = module_nodes._slice_prompt_to_ids(contracted, module_nodes._selected_ancestor_ids(contracted, "10", {}, selected))
        self.assertEqual(replay["8"]["inputs"], {"scene_prompt1": ["1", 0]})
        self.assertNotIn("7", replay)
        self.assertEqual(replay["20"]["inputs"], graph["20"]["inputs"])
        self.assertEqual(replay["30"]["inputs"], graph["30"]["inputs"])
        self.assertEqual(self.module._scene_node_value(replay, "8", {}, set())["stats"]["total_images"], 2)

    def test_independent_to_text_scene_consumer_keeps_its_selected_switch_path(self):
        module_nodes = sys.modules[f"{self.module.__package__}.nodes"]
        graph = {"1": node("ScenePromptCounter", count=2), "2": node("ScenePromptCounter", count=3),
                 "3": node("ScenePromptCounter", count=4),
                 "4": node("ComfySwitchNode", switch=True, on_false=["2", 0], on_true=["3", 0]),
                 "5": node("ScenePromptToText", scene_prompt=["4", 0]),
                 "6": node("ScenePrompterExpand", scene_prompt=["1", 0]),
                 "7": node("ImageFixture", text=["5", 0]),
                 "8": node("SceneSaveImage", images=["7", 0], scene_info=["6", 2])}
        contracted, selected, replacements = module_nodes._contract_superseded_model_sources(graph, ["1", "6"], ["3"], ["5"])
        self.assertEqual(replacements, {"4": ["3", 0]})
        replay = module_nodes._slice_prompt_to_ids(contracted, module_nodes._selected_ancestor_ids(contracted, "8", {}, selected))
        self.assertEqual(replay["5"]["inputs"]["scene_prompt"], ["3", 0])
        self.assertIn("3", replay)


if __name__ == "__main__":
    unittest.main()
