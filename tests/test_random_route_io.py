"""Random Input/Output joins reuse the shared compact planning semantics."""
import copy
import importlib
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_scene_prompt_reverse import add_prompt, load_modules
from test_preset_metadata import outer_workflow, scene_prompt


class RandomRouteIOTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        modules = load_modules(Path(self.temp.name))
        self.nodes, self.plan = modules["nodes"], modules["plan"]
        self.prompt, self.presets = modules["prompt"], modules["presets"]
        self.runs = importlib.import_module(self.nodes.__package__ + ".runs")
        self.metadata = importlib.import_module(self.nodes.__package__ + ".preset_metadata")

    def route(self, upstream=None, weights=None, gate="input", preserve=True):
        return self.nodes.ScenePromptRandomRoute().route(
            weights_json=json.dumps(weights or [5000, 5000] + [0] * 8),
            scene_prompt=upstream, preserve_join=preserve,
            unique_id=gate, source_node_name="Input " + gate)

    def branch(self, upstream, name):
        return add_prompt(self.prompt, name, name, "", upstream, name)

    def join(self, *plans, node_id="output"):
        return self.nodes.ScenePromptRandomRouteOutput().join(unique_id=node_id, source_node_name="Output " + node_id,
            **{f"scene_prompt{index}": value for index, value in enumerate(plans, 1)})[0]

    def api(self):
        return {
            "1": scene_prompt("base"),
            "2": {"class_type": "ScenePromptRandomRoute", "inputs": {
                "scene_prompt": ["1", 0], "weights_json": json.dumps([5000, 5000] + [0] * 8), "preserve_join": True}},
            "3": {**scene_prompt("A"), "inputs": {**scene_prompt("A")["inputs"], "scene_prompt": ["2", 0]}},
            "4": {**scene_prompt("B"), "inputs": {**scene_prompt("B")["inputs"], "scene_prompt": ["2", 1]}},
            "5": {"class_type": "ScenePromptRandomRouteOutput", "inputs": {
                "scene_prompt1": ["3", 0], "scene_prompt2": ["4", 0]}},
            "6": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["5", 0], "count": 10}},
            "7": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["6", 0]}},
        }

    def prepare(self, api):
        handle = self.runs.create_run_context("default")
        return self.presets.snapshot_presets_for_run(handle, {"output": api}, "7")

    def test_input_schema_new_default_and_omitted_legacy_method_and_cache_defaults(self):
        cls = self.nodes.ScenePromptRandomRoute
        self.assertEqual(list(cls.INPUT_TYPES()["required"]), ["weights_json"])
        self.assertEqual(list(cls.INPUT_TYPES()["optional"]), ["scene_prompt", "preserve_join"])
        self.assertIs(cls.INPUT_TYPES()["optional"]["preserve_join"][1]["default"], True)
        self.assertIs(inspect.signature(cls.route).parameters["preserve_join"].default, False)
        self.assertIs(inspect.signature(cls.IS_CHANGED).parameters["preserve_join"].default, False)
        self.assertEqual(cls.IS_CHANGED(), cls.IS_CHANGED(preserve_join=False))
        self.assertNotEqual(cls.IS_CHANGED(), cls.IS_CHANGED(preserve_join=True))
        legacy = cls().route(weights_json=json.dumps([10000] + [0] * 9), unique_id="legacy")[0]
        self.assertFalse(legacy["random_guards"])
        self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=legacy)[:2], ("", ""))
        legacy_joined = self.join(self.branch(legacy, "legacy"))
        self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=legacy_joined)[0], "legacy")
        fresh = self.route(weights=[10000] + [0] * 9)[0]
        self.assertEqual(fresh["random_guards"][-1]["gate_id"], "input")
        self.assertEqual(self.join(fresh)["random_guards"], [])

    def test_output_schema_registry_and_cache_have_ten_scene_inputs_no_controls(self):
        cls = self.nodes.ScenePromptRandomRouteOutput
        schema = cls.INPUT_TYPES()
        self.assertEqual(schema["required"], {})
        self.assertEqual(list(schema["optional"]), [f"scene_prompt{index}" for index in range(1, 11)])
        self.assertTrue(all(value[0] == "SCENE_PROMPT" for value in schema["optional"].values()))
        self.assertEqual(cls.RETURN_TYPES, ("SCENE_PROMPT",))
        self.assertIs(self.presets.SAFE_NODE_CLASSES["ScenePromptRandomRouteOutput"], cls)
        self.assertIn("ScenePromptRandomRouteOutput", self.nodes.SCENE_NODE_TYPES)
        self.assertEqual(self.nodes._scene_prompt_input_names({"class_type": "ScenePromptRandomRouteOutput"}),
            self.nodes.SCENE_PROMPT_INPUT_NAMES)
        a, b, *_ = self.route()
        self.assertNotEqual(cls.IS_CHANGED(scene_prompt1=a, scene_prompt2=b), cls.IS_CHANGED(scene_prompt1=b, scene_prompt2=a))
        self.assertEqual(cls.IS_CHANGED(scene_prompt1=a, scene_prompt10=b), cls.IS_CHANGED(scene_prompt1=a, scene_prompt10=copy.deepcopy(b)))

    def test_empty_output_errors_before_shared_queue_and_unused_output_is_irrelevant(self):
        with mock.patch.object(self.nodes, "queue", side_effect=AssertionError("Do not create a seed for an empty Output")) as shared:
            with self.assertRaisesRegex(self.plan.ScenePlanError, "Output.*接続"):
                self.join(None, None)
            shared.assert_not_called()
        api = self.api()
        api["unused"] = {"class_type": "ScenePromptRandomRouteOutput", "inputs": {}}
        self.assertEqual(self.prepare(api)["total_batches"], 10)
        api["6"]["inputs"]["scene_prompt"] = ["unused", 0]
        with self.assertRaisesRegex(self.presets.ScenePresetResolutionError, "Output.*接続"):
            self.prepare(api)

    def test_fifty_fifty_count_ten_uses_independent_seeded_draws_and_input_arm_order(self):
        a, b, *zero = self.route()
        a, b = self.branch(a, "A"), self.branch(b, "B")
        plan = self.nodes.ScenePromptCounter().count(scene_prompt=self.join(b, zero[0], a), count=10)[0]
        self.assertEqual((plan["stats"]["total_batches"], plan["stats"]["total_images"]), (10, 10))
        # The shared deterministic draw is keyed by Input id and per-image seed.
        from hashlib import blake2b
        expected = ["A" if int.from_bytes(blake2b(json.dumps([123 + index, "input"], separators=(",", ":")).encode(), digest_size=8).digest(), "big") % 10000 < 5000 else "B"
                    for index in range(10)]
        actual = [self.nodes.ScenePromptExpand().expand(scene_prompt=plan, current_index=index, seed_base=123)[0] for index in range(10)]
        self.assertEqual(actual, expected)
        self.assertEqual(set(actual), {"A", "B"})
        canonical = self.nodes.ScenePromptCounter().count(scene_prompt=self.join(a, b), count=10)[0]
        self.assertEqual([self.nodes.ScenePromptToText().to_text(scene_prompt=canonical, current_index=index, seed_base=123)[0] for index in range(10)], expected)

    def test_latent_batch_shares_one_draw_and_million_count_remains_compact(self):
        base = self.nodes.SceneEmptyLatent().apply_latent(width=512, height=512, batch_size=3)[0]
        a, b, *_ = self.route(base)
        joined = self.join(self.branch(a, "A"), self.branch(b, "B"))
        plan = self.nodes.ScenePromptCounter().count(scene_prompt=joined, count=1_000_000)[0]
        self.assertEqual((plan["stats"]["total_batches"], plan["stats"]["total_images"]), (1_000_000, 3_000_000))
        self.assertLess(len(json.dumps(plan)), 30_000)
        self.assertEqual(len(plan["units"]), 1)
        selected = self.plan.item_for_normalized_plan(plan, 999_999, 999_999)["row"]
        self.assertEqual(selected["latent"]["batch_size"], 3)
        self.assertIn(selected["positive_parts"], (["A"], ["B"]))

    def test_nested_inner_hundred_percent_closes_only_its_own_guard(self):
        for inner_arm in (0, 6):
            with self.subTest(inner_arm=inner_arm):
                outer_a, outer_b, *_ = self.route(gate="outer")
                weights = [0] * 10
                weights[inner_arm] = 10000
                inner = self.route(outer_a, weights, "inner")
                resolved = self.join(self.branch(inner[inner_arm], "inner"), node_id="inner-output")
                self.assertEqual([guard["gate_id"] for guard in resolved["random_guards"]], ["outer"])
                final = self.join(self.branch(resolved, "A"), self.branch(outer_b, "B"), node_id="outer-output")
                self.assertFalse(final["random_guards"])
                rows = [self.plan.item_for_normalized_plan(final, 0, seed)["row"] for seed in range(30)]
                self.assertEqual({tuple(row["positive_parts"]) for row in rows}, {("inner", "A"), ("B",)})
                for row in rows:
                    ids = row["source_node_ids"]
                    self.assertIn("outer-output", ids)
                    self.assertEqual("inner-output" in ids, "A" in row["positive_parts"])

    def test_nested_random_pairs_keep_lifo_and_same_seed_is_reproducible(self):
        outer_a, outer_b, *_ = self.route(gate="outer")
        inner_a, inner_b, *_ = self.route(outer_a, gate="inner")
        resolved = self.join(self.branch(inner_a, "IA"), self.branch(inner_b, "IB"), node_id="inner-output")
        final = self.join(self.branch(resolved, "OA"), self.branch(outer_b, "OB"))
        self.assertEqual(final["stats"]["total_batches"], 1)
        self.assertFalse(final["random_guards"])
        for seed in range(20):
            first = self.plan.item_for_normalized_plan(final, 0, seed)
            self.assertEqual(first, self.plan.item_for_normalized_plan(final, 0, seed))
            self.assertIn(first["row"]["positive_parts"], (["IA", "OA"], ["IB", "OA"], ["OB"]))

    def test_zero_missing_duplicate_crossed_and_unrelated_inputs_reuse_join_validation(self):
        a, b, zero, *_ = self.route()
        self.assertEqual(self.join(a, b, zero)["stats"]["total_batches"], 1)
        other = self.route(gate="different")[1]
        cases = [((a,), "出力2"), ((a, b, a), "複数"), ((a, other), "交差"),
                 ((a, self.plan.seed_plan()), "無関係"), ((zero,), "出力1, 2")]
        for values, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(self.plan.ScenePlanError, error):
                self.join(*values)

    def test_preflight_rejects_missing_duplicate_crossed_and_empty_output(self):
        for kind in ("missing", "duplicate", "crossed", "empty"):
            api = self.api()
            if kind == "missing":
                api["5"]["inputs"].pop("scene_prompt2")
            elif kind == "duplicate":
                api["5"]["inputs"]["scene_prompt3"] = ["3", 0]
            elif kind == "crossed":
                api["8"] = copy.deepcopy(api["2"])
                api["4"]["inputs"]["scene_prompt"] = ["8", 1]
                # Both Inputs have all nonzero slots connected somewhere, so
                # only the shared guard join can detect the crossed pairing.
                api["9"] = {**scene_prompt("unused"), "inputs": {**scene_prompt("unused")["inputs"], "scene_prompt": ["2", 1]}}
                api["10"] = {**scene_prompt("unused"), "inputs": {**scene_prompt("unused")["inputs"], "scene_prompt": ["8", 0]}}
            else:
                api["5"]["inputs"] = {}
            with self.subTest(kind=kind), self.assertRaises(self.presets.ScenePresetResolutionError):
                self.prepare(api)

    def test_only_winning_model_lora_callback_llm_delete_and_source_names_survive(self):
        branches = []
        for index, arm in enumerate(self.route()[:2]):
            name = ("A", "B")[index]
            branch = self.branch(arm, name)
            branch = self.presets.ScenePromptLLM().build("Illustrious", "no inference", f"llm_{name}, remove_{name}", "", scene_prompt=branch,
                source_node_id=f"llm-{name}", source_node_name=f"LLM {name}")[0]
            branch = self.nodes.ScenePromptDelete().delete(f"remove_{name}", "", branch, source_node_id=f"delete-{name}", source_node_name=f"Delete {name}")[0]
            branch = self.nodes.SceneApplyModel().apply_model([name, 0], [name, 1], [name, 2], branch,
                source_node_id=f"model-{name}", source_node_name=f"Model {name}")[0]
            branch = self.nodes.SceneApplyLora().apply_lora(f"{name}.safetensors", scene_prompt=branch,
                source_node_id=f"lora-{name}", source_node_name=f"LoRA {name}")[0]
            callback = self.nodes.ScenePromptCallbackDesktop().build(title=name)[0]
            branch = self.nodes.ScenePromptCallback().apply_callback(callback=callback, scene_prompt=branch, unique_id=f"callback-{name}")[0]
            branches.append(branch)
        joined = self.join(*branches)
        for seed in range(30):
            row = self.plan.item_for_normalized_plan(joined, 0, seed)["row"]
            name = row["positive_parts"][0]
            other = "B" if name == "A" else "A"
            self.assertEqual(row["positive_parts"], [name, f"llm_{name}"])
            self.assertEqual(row["model_links"]["model"], [name, 0])
            self.assertEqual([item["name"] for item in row["loras"]], [f"{name}.safetensors"])
            self.assertEqual([item["callback_node_id"] for item in row["callbacks"]], [f"callback-{name}"])
            self.assertEqual(row["source_node_names"]["output"], "Output output")
            self.assertEqual(row["source_node_names"][f"model-{name}"], f"Model {name}")
            self.assertNotIn(f"model-{other}", row["source_node_ids"])
            self.assertNotIn(f"llm-{other}", row["source_node_names"])
            self.assertEqual(self.nodes.ScenePromptToText().to_text(scene_prompt=joined, seed_base=seed, seed_base_literal=True)[0], f"{name}, llm_{name}")

    def test_expanded_nested_presets_keep_draws_with_current_source_ids(self):
        for preserved_seed in ('', 'previous/2'):
            with self.subTest(preserved_seed=preserved_seed):
                inner = self.api()
                inner['1'] = {'class_type': 'ScenePresetInput', 'inputs': {}}
                inner['7'] = {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['6', 0]}}
                if preserved_seed:
                    inner['2']['inputs']['seed_source_id'] = preserved_seed
                saved = self.presets.save_preset({'preset_id': 'seed-inner', 'name': 'seed-inner', 'output_node_id': '7',
                    'api_graph': {'output': inner}, 'workflow': outer_workflow(inner)})
                outer = {'1': {'class_type': 'ScenePresetInput', 'inputs': {}},
                         '2': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'seed-inner', 'scene_prompt': ['1', 0]}},
                         '3': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['2', 0]}}}
                outer_visual = outer_workflow(outer)
                next(node for node in outer_visual['nodes'] if node['id'] == 2)['widgets_values'] = ['seed-inner']
                nested = self.presets.save_preset({'preset_id': 'seed-outer', 'name': 'seed-outer', 'output_node_id': '3',
                    'api_graph': {'output': outer}, 'workflow': outer_visual})
                snapshots = {'seed-inner': saved, 'seed-outer': nested}
                sequences = []
                for reference_id in ('10', '11'):
                    api = {reference_id: {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'seed-outer'}},
                           '7': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': [reference_id, 0]}}}
                    original = self.presets._scene_node_value(api, reference_id, snapshots, set())
                    replay, workflow, _ = self.metadata.expand_preset_references(copy.deepcopy(api), outer_workflow(api), snapshots)
                    gate_id, gate = next((key, node) for key, node in replay.items() if node['class_type'] == 'ScenePromptRandomRoute')
                    self.assertNotIn('source_node_id', gate['inputs'])
                    self.assertEqual(gate['inputs']['seed_source_id'], f'{reference_id}/2/{preserved_seed or "2"}')
                    visual = next(node for node in workflow['nodes'] if str(node['id']) == gate_id)
                    self.assertEqual(visual['properties']['scene_random_seed'], {'node_id': gate_id, 'seed_source_id': gate['inputs']['seed_source_id']})
                    canvas = outer_workflow(api)
                    next(node for node in canvas['nodes'] if str(node['id']) == reference_id)['widgets_values'] = ['seed-outer']
                    _, canvas, _ = self.metadata.expand_preset_references({}, canvas, snapshots, True)
                    canvas_gate = next(node for node in canvas['nodes'] if node['type'] == 'ScenePromptRandomRoute')
                    self.assertEqual(canvas_gate['properties']['scene_random_seed'], {
                        'node_id': str(canvas_gate['id']), 'seed_source_id': gate['inputs']['seed_source_id']})
                    restored = self.presets._scene_node_value(replay, replay['7']['inputs']['scene_prompt'][0], {}, set())
                    sequence = []
                    for seed in range(1, 33):
                        before = self.plan.item_for_normalized_plan(original, seed % 10, seed)
                        after = self.plan.item_for_normalized_plan(restored, seed % 10, seed)
                        self.assertEqual(after['row']['positive_parts'], before['row']['positive_parts'])
                        self.assertIn(gate_id, after['row']['source_node_ids'])
                        self.assertNotIn(f'{reference_id}/2/2', after['row']['source_node_ids'])
                        sequence.append(after['row']['positive_parts'])
                    sequences.append(sequence)
                self.assertNotEqual(*sequences, 'separate Reference instances keep independent draws')
                runtime = self.presets.expand_preset_reference('seed-inner', source_node_id='30')['expand']
                runtime_gate = next(node for node in runtime.values() if node['class_type'] == 'ScenePromptRandomRoute')
                self.assertEqual(runtime_gate['inputs']['seed_source_id'], f'30/{preserved_seed or "2"}')

    def test_preset_save_reference_nested_namespace_and_frozen_replay_keep_output(self):
        preset = self.api()
        preset["1"] = {"class_type": "ScenePresetInput", "inputs": {}}
        preset["7"] = {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["6", 0]}}
        saved = self.presets.save_preset({"preset_id": "io", "name": "IO", "output_node_id": "7",
            "api_graph": {"output": preset}, "workflow": outer_workflow(preset)})
        self.assertIn("ScenePromptRandomRouteOutput", {node["class_type"] for node in saved["api_graph"]["output"].values()})
        outer = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                 "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "io", "scene_prompt": ["1", 0]}},
                 "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}}}
        nested = self.presets.save_preset({"preset_id": "nested_io", "name": "Nested IO", "output_node_id": "3",
            "api_graph": {"output": outer}, "workflow": outer_workflow(outer)})
        api = {"10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "nested_io"}},
               "7": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}}}
        summary = self.prepare(api)
        self.assertEqual((summary["total_batches"], summary["total_images"]), (10, 10))
        plan = self.presets._scene_node_value(api, "10", {"io": saved, "nested_io": nested}, set())
        item = self.plan.item_for_normalized_plan(plan, 0, 123)
        choice = next(part for part in item["event_ref"] if part[0] == "random_choice")
        self.assertEqual(choice[1:], ("10/2/2", 0 if item["row"]["positive_parts"] == ["A"] else 1))
        self.assertIn("10/2/5", item["row"]["source_node_ids"])
        expanded = self.presets.expand_preset_reference("io", source_node_id="10")
        output = next(node for node in expanded["expand"].values() if node["class_type"] == "ScenePromptRandomRouteOutput")
        self.assertEqual(output["inputs"]["source_node_id"], "10/5")
        self.assertEqual(output["inputs"]["source_node_name"], "Scene Prompt Random Route Output")
        snapshot = {"nested_io": nested, "io": saved}
        replay, workflow, aliases = self.metadata.expand_preset_references(copy.deepcopy(api), outer_workflow(api), snapshot)
        self.nodes._freeze_random_routes(replay, workflow, [{"_event_ref": item["event_ref"]}], aliases)
        input_node = next(node for node in replay.values() if node["class_type"] == "ScenePromptRandomRoute")
        self.assertTrue(input_node["inputs"]["preserve_join"])
        self.assertEqual(json.loads(input_node["inputs"]["weights_json"]).count(10000), 1)
        self.assertIn("ScenePromptRandomRouteOutput", {node["class_type"] for node in replay.values()})


if __name__ == "__main__":
    unittest.main()
