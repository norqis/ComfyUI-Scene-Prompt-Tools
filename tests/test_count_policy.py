"""Path-specific Count protection, compact selection and execution-path replay."""
import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scene_prompt_tools.plan import (
    MAX_SAFE_INTEGER, ScenePlanError, append_callback, empty_row, item_for_normalized_plan,
    make_plan, matrix_product, merge, multiply_count, normalize_plan, queue,
    replay_index_for_event, transform, with_source_node,
)
from scene_prompt_tools import schedule


def branch(name, count=1, batch_size=None):
    row = {**empty_row(), "labels": [name], "positive_parts": [name]}
    if batch_size is not None:
        row["latent"] = {"width": 16, "height": 16, "batch_size": batch_size}
    return with_source_node(make_plan([{"row": row, "count": count}]), name, name)


def hold(plan, factor=1):
    return multiply_count(plan, factor, enable_downstream_count=False)


def entries(plan, seed=0):
    return [item_for_normalized_plan(plan, index, seed) for index in range(plan["stats"]["total_batches"])]


def labels(plan, seed=0):
    return [item["label"] for item in entries(plan, seed)]


def choice(first, second):
    arms = [first, second] + [schedule._plan([]) for _ in range(8)]
    return schedule._plan([schedule._unit("random_choice", gate_id="fixture-random",
        weights=[5000, 5000] + [0] * 8, inputs=arms, selected_arm=None)])


class CountPolicyTests(unittest.TestCase):
    def test_long_fully_protected_count_chain_does_not_accumulate_depth(self):
        plan = hold(branch("A"), 3)
        depth, units = plan.depth, plan["units"]
        for index in range(200):
            plan = multiply_count(plan, 0 if index % 3 == 0 else 10, enable_downstream_count=bool(index % 2))
            self.assertEqual(plan.depth, depth)
            self.assertEqual(plan["units"], units)
        self.assertEqual(labels(plan), ["A"] * 3)
        self.assertEqual(replay_index_for_event(plan, entries(plan)[2]["event_ref"], ["A"], ["A"]), 2)

    def test_explicit_user_count_chains(self):
        seed = branch("A")
        self.assertEqual(multiply_count(multiply_count(seed, 10), 10)["total_batches"], 100)
        self.assertEqual(multiply_count(hold(seed, 10), 10)["total_batches"], 10)
        self.assertEqual(multiply_count(hold(multiply_count(seed, 10), 10), 10)["total_batches"], 100)
        self.assertEqual(multiply_count(multiply_count(hold(seed, 10), 10), 10)["total_batches"], 10)

    def test_explicit_mixed_queue_example(self):
        result = multiply_count(queue([hold(branch("A"), 3), multiply_count(branch("B"), 2)]), 10)
        self.assertEqual(labels(result), ["A"] * 3 + ["B"] * 20)
        self.assertEqual(result["stats"]["row_count"], 2)

    def test_input_order_finishes_each_row_before_the_next(self):
        original = queue([hold(branch("A"), 2), branch("B", 2), branch("C")])
        result = multiply_count(original, 3)
        self.assertEqual(labels(result), list("AA") + ["B"] * 6 + ["C"] * 3)
        self.assertEqual(result["stats"]["row_count"], 3)
        self.assertEqual(len(result["units"]), 3)

    def test_input_order_free_rows_before_and_after_nested_held_path(self):
        rows = [{**empty_row(), "name": name, "enabled": True} for name in ("x", "y")]
        first = matrix_product(branch("A"), rows, True)
        original = with_source_node(queue([first, queue([hold(branch("B"), 2), branch("C")])]), "outer")
        before = json.dumps(original)
        result = multiply_count(multiply_count(original, 2), 3)
        expected = ["A / x"] * 6 + ["A / y"] * 6 + ["B"] * 2 + ["C"] * 6
        self.assertEqual(labels(result), expected)
        self.assertEqual(json.dumps(original), before)
        for offset, (name, count) in enumerate((("A / x", 6), ("A / y", 6), ("B", 2), ("C", 6))):
            matching = [item for item in entries(result) if item["label"] == name]
            self.assertEqual([item["repeat_index"] for item in matching], list(range(1, count + 1)))
            self.assertEqual({item["count"] for item in matching}, {count})
            self.assertEqual({item["row_index"] for item in matching}, {offset})

    def test_composite_cycles_keep_their_boundaries_between_input_order_siblings(self):
        for mode, block, expected in (("alternate", 1, "ABB"), ("input_order", 2, "AABBBB")):
            with self.subTest(mode=mode):
                cycle = queue([hold(branch("A")), branch("B")], order_mode=mode, alternate_block_size=block)
                result = multiply_count(queue([branch("X"), cycle, branch("Y")]), 2)
                self.assertEqual(labels(result), list("XX" + expected + "YY"))

    def test_reported_1670_batch_shape_keeps_the_two_rows_contiguous(self):
        middle = queue([branch("A1"), branch("A2"), hold(branch("held"), 720), branch("other", 32)])
        result = queue([branch("prefix", 550), multiply_count(middle, 10), branch("suffix", 60)])
        self.assertEqual(result["total_batches"], 1670)
        self.assertEqual([item_for_normalized_plan(result, index)["label"] for index in range(550, 570)],
                         ["A1"] * 10 + ["A2"] * 10)
        self.assertEqual(item_for_normalized_plan(result, 549)["label"], "prefix")
        self.assertEqual(item_for_normalized_plan(result, 570)["label"], "held")

    def test_legacy_fixed_and_free_composite_beside_held_sibling(self):
        fixed = queue([branch("A")], downstream_count_mode="fixed")
        # A composite retains per-path legacy-fixed policy even without a hold inside it.
        composite = schedule._plan([schedule._unit("alternate", inputs=[fixed, branch("B")], block_size=1)])
        original = queue([hold(branch("X")), composite, branch("Y")])
        self.assertEqual(labels(multiply_count(original, 3)), list("XABBBYYY"))
        self.assertEqual(labels(multiply_count(original, 0)), ["X"])

    def test_legacy_whole_cycle_plan_and_event_refs_remain_replayable(self):
        original = queue([branch("A"), hold(branch("B"), 2), branch("C")])
        old_plan = schedule._plan([schedule._unit("count_scale",
            unit=schedule._unit("sequence", plan=original), factor=3)])
        rebuilt = normalize_plan(json.loads(json.dumps(old_plan)))
        self.assertEqual(labels(rebuilt), list("ABBCACAC"))
        ranks = {name: 0 for name in "ABC"}
        for index, item in enumerate(entries(rebuilt)):
            name = item["label"]
            ref = json.loads(json.dumps(item["event_ref"]))
            self.assertEqual(replay_index_for_event(rebuilt, ref, list("ABC"), list("ABC")), index)
            self.assertEqual(replay_index_for_event(rebuilt, ref, [name], list("ABC")), ranks[name])
            ranks[name] += 1

    def test_false_applies_current_count_then_protects_every_result_path(self):
        original = queue([hold(branch("A"), 2), branch("B", 2), branch("C")], order_mode="alternate")
        current = hold(original, 2)
        expected = labels(original) + [name for name in labels(original) if name != "A"]
        self.assertEqual(labels(current), expected)
        self.assertEqual(labels(multiply_count(current, 100)), expected)
        self.assertEqual(labels(multiply_count(current, 0)), expected)

    def test_zero_keeps_only_strict_and_legacy_fixed_zero_stays_cancelled(self):
        fixed = queue([branch("legacy", 2)], downstream_count_mode="fixed")
        original = queue([hold(branch("strict"), 3), fixed, branch("free", 2)])
        self.assertEqual(labels(multiply_count(original, 2)), ["strict"] * 3 + ["legacy"] * 2 + ["free"] * 4)
        self.assertEqual(labels(multiply_count(original, 0)), ["strict"] * 3)
        self.assertEqual(labels(multiply_count(fixed, 0)), [])
        self.assertEqual(labels(hold(branch("empty"), 0)), [])
        self.assertEqual(labels(multiply_count(hold(branch("empty"), 0), 10)), [])

    def test_strict_flag_does_not_lock_queue_row_repeat_or_order(self):
        first = hold(branch("A"), 3)
        self.assertFalse(first["contains_queue_boundary"])
        original = queue([first, branch("B", 2)], order_mode="alternate", alternate_block_size=2)
        self.assertEqual(labels(original), list("AABBAABBAA"))
        self.assertEqual(labels(multiply_count(original, 3)), list("AABBAABBAA") + list("BBBB") * 2)
        self.assertEqual(original["stats"]["row_count"], 2)

    def test_queue_fixed_can_wrap_strict_without_erasing_zero_protection(self):
        original = queue([hold(branch("A"), 2), branch("B", 2)], order_mode="alternate", downstream_count_mode="fixed")
        self.assertEqual(labels(multiply_count(original, 3)), list("ABAB"))
        self.assertEqual(labels(multiply_count(original, 0)), list("AA"))

    def test_maps_keep_policy_and_exact_selected_metadata(self):
        first = append_callback(hold(branch("A"), 2), "callback-A", {"url": "fixture"}, "毎回", 10, "続行")
        second = branch("B")
        source = queue([first, second], order_mode="alternate")
        source = transform(source, operation={"kind": "model_set", "payload": {
            "model": ["fixture-model", 0], "clip": ["fixture-model", 1], "vae": ["fixture-model", 2]}})
        lora = {"name": "fixture.safetensors", "model_mode": "Illustrious", "strength_model": 0.7,
                "strength_clip": 0.6, "positive_parts": ["trigger"], "negative_parts": []}
        source = transform(source, operation={"kind": "lora_add", "payload": lora})
        source = transform(source, operation={"kind": "delete", "payload": ["trigger", ""]})
        source = transform(source, latent={"width": 16, "height": 16, "batch_size": 4})
        result = multiply_count(source, 3)
        self.assertEqual(labels(result), list("ABABB"))
        self.assertEqual(result["stats"]["total_images"], 20)
        for item in entries(result):
            row = item["row"]
            self.assertEqual(row["model_links"]["model"], ["fixture-model", 0])
            self.assertEqual(row["loras"][0]["name"], "fixture.safetensors")
            self.assertNotIn("trigger", row["positive_parts"])
            self.assertEqual([callback["callback_node_id"] for callback in row["callbacks"]],
                             ["callback-A"] if "A" in row["source_node_ids"] else [])

    def test_latent_map_resolves_random_image_policy_without_losing_known_batch_counts(self):
        source = choice(queue([hold(branch("A", batch_size=2)), branch("B", batch_size=1)]),
                        queue([hold(branch("C", batch_size=1)), branch("D", batch_size=2)]))
        with self.assertRaisesRegex(ScenePlanError, "Count"):
            multiply_count(source, 2)
        mapped = transform(source, latent={"width": 16, "height": 16, "batch_size": 5})
        result = multiply_count(mapped, 2)
        self.assertEqual(result["stats"]["total_batches"], 3)
        self.assertEqual(result["stats"]["total_images"], 15)
        self.assertEqual(multiply_count(mapped, 0)["stats"]["total_images"], 5)
        for seed in range(5):
            self.assertEqual(sum(item["row"]["latent"]["batch_size"] for item in entries(result, seed)), 15)
        different_batches = transform(choice(hold(branch("A")), branch("B")),
                                      latent={"width": 16, "height": 16, "batch_size": 5})
        for factor in (0, 2):
            with self.assertRaisesRegex(ScenePlanError, "Count"):
                multiply_count(different_batches, factor)

    def test_matrix_keeps_existing_row_order_and_ignores_only_later_count(self):
        rows = [{**empty_row(), "name": name, "enabled": True} for name in ("x", "y")]
        strict = matrix_product(hold(branch("A"), 2), rows, True)
        self.assertEqual(labels(strict), ["A / x"] * 2 + ["A / y"] * 2)
        self.assertEqual(labels(multiply_count(strict, 10)), labels(strict))
        mixed = matrix_product(queue([hold(branch("A"), 2), branch("B")], order_mode="alternate"), rows, True)
        self.assertEqual(labels(multiply_count(mixed, 2)), labels(mixed) + ["B / x", "B / y"])

    def test_merge_union_protects_only_the_corresponding_combinations(self):
        left = queue([hold(branch("A")), branch("B")], order_mode="alternate")
        right = queue([hold(branch("X")), branch("Y")], order_mode="alternate")
        original = merge(left, right)
        result = multiply_count(original, 3)
        self.assertEqual(labels(result), ["A / X", "A / Y", "B / X", "B / Y", "B / Y", "B / Y"])
        self.assertEqual(labels(multiply_count(original, 0)), ["A / X", "A / Y", "B / X"])
        self.assertEqual(result["stats"]["row_count"], 4)

    def test_product_latent_preference_matches_selected_image_counts(self):
        left = queue([hold(branch("A", batch_size=2)), branch("B", batch_size=3)], order_mode="alternate")
        right = queue([hold(branch("X")), branch("Y", batch_size=4)], order_mode="alternate")
        for factor in (0, 1, 3):
            with self.subTest(factor=factor):
                result = multiply_count(merge(left, right), factor)
                selected = entries(result)
                self.assertEqual(result["stats"]["total_images"], sum(item["row"]["latent"]["batch_size"] for item in selected))
                self.assertEqual(result["stats"]["unset_batches"], 0)

    def test_sequence_repeat_and_repeat_each_keep_partial_protection(self):
        base = queue([hold(branch("A")), branch("B")], order_mode="alternate")
        unit = schedule._unit("sequence", plan=base)
        for kind, expected in (("repeat", list("ABAB") + list("BB") * 2),
                               ("repeat_each", list("AABB") + list("BB") * 2)):
            with self.subTest(kind=kind):
                source = schedule._plan([schedule._unit(kind, unit=unit, factor=2)])
                self.assertEqual(labels(multiply_count(source, 3)), expected)

    def test_random_same_original_total_different_policies_fail_preflight(self):
        original = choice(hold(branch("A")), branch("B"))
        self.assertEqual(original["total_batches"], 1)
        for factor in (0, 2):
            with self.subTest(factor=factor):
                with self.assertRaisesRegex(ScenePlanError, "Random|ランダム"):
                    multiply_count(original, factor)

    def test_random_equal_policy_different_positions_uses_seeded_arm(self):
        original = choice(queue([hold(branch("A")), branch("B")]), queue([branch("C"), hold(branch("D"))]))
        result = multiply_count(original, 2)
        seen = set()
        for seed in range(20):
            arm = schedule._random_arm([5000, 5000] + [0] * 8, "fixture-random", seed)
            seen.add(arm)
            self.assertEqual(labels(result, seed), list("ABB" if arm == 0 else "CDC"))
            for index, item in enumerate(entries(result, seed)):
                ref = json.loads(json.dumps(item["event_ref"]))
                self.assertEqual(replay_index_for_event(result, ref, ["A", "B", "C", "D"], ["A", "B", "C", "D"]), index)
        self.assertEqual(seen, {0, 1})

    def test_replay_rank_after_pruning_first_and_filtered_cycles(self):
        result = multiply_count(queue([hold(branch("A"), 2), branch("B", 2), branch("C")]), 3)
        ranks = {"A": 0, "B": 0, "C": 0}
        for item in entries(result):
            name = item["label"]
            ref = json.loads(json.dumps(item["event_ref"]))
            self.assertEqual(replay_index_for_event(result, ref, [name], ["A", "B", "C"]), ranks[name])
            ranks[name] += 1

    def test_nested_partial_scales_json_roundtrip_and_source_immutability(self):
        source = queue([hold(branch("A"), 2), branch("B", 2), branch("C")], order_mode="alternate")
        before = json.dumps(source)
        scaled = multiply_count(multiply_count(source, 2), 3)
        expected = labels(source) + [name for name in labels(source) if name != "A"] * 5
        self.assertEqual(labels(scaled), expected)
        rebuilt = normalize_plan(json.loads(json.dumps(scaled)))
        self.assertEqual(labels(rebuilt), expected)
        self.assertEqual(rebuilt["change_key"], scaled["change_key"])
        for index, item in enumerate(entries(rebuilt)):
            self.assertEqual(replay_index_for_event(rebuilt, item["event_ref"], ["A", "B", "C"], ["A", "B", "C"]), index)
        self.assertEqual(json.dumps(source), before)

    def test_huge_mixed_count_is_compact_and_selection_is_arithmetic(self):
        source = queue([hold(branch("A"), 2), branch("B", 10_000_000)], order_mode="alternate")
        result = multiply_count(source, 100_000_000)
        self.assertEqual(result["total_batches"], 1_000_000_000_000_002)
        self.assertEqual(result["stats"]["row_count"], 2)
        self.assertLess(len(json.dumps(result)), 20_000)
        with mock.patch.object(schedule, "_select_unit", wraps=schedule._select_unit) as select:
            item = item_for_normalized_plan(result, result["total_batches"] - 1, 19)
        self.assertEqual(item["label"], "B")
        self.assertLess(select.call_count, 20)
        self.assertEqual(item["row_index"], 1)
        self.assertEqual(replay_index_for_event(result, item["event_ref"], ["A", "B"], ["A", "B"]), result["total_batches"] - 1)

    def test_safe_integer_overflow_fails_before_selection(self):
        source = queue([hold(branch("A")), branch("B", MAX_SAFE_INTEGER // 2)])
        with self.assertRaisesRegex(ScenePlanError, "safe integer"):
            multiply_count(source, 3)

    def test_default_and_explicit_true_keep_the_exact_legacy_plan(self):
        for source in (branch("A", 2), queue([branch("A"), branch("B")], order_mode="alternate"),
                       queue([branch("A")], downstream_count_mode="fixed")):
            for factor in (0, 1, 3):
                with self.subTest(factor=factor):
                    self.assertEqual(multiply_count(source, factor), multiply_count(source, factor, enable_downstream_count=True))
                    self.assertFalse(any(unit["kind"] in ("count_hold", "count_scale") for unit in multiply_count(source, factor)["units"]))


class CountNodeAndPresetTests(unittest.TestCase):
    def setUp(self):
        from test_scene_presets import load_presets_module
        self.temp = tempfile.TemporaryDirectory()
        self.presets = load_presets_module(Path(self.temp.name))
        import sys
        self.nodes = sys.modules[f"{self.presets.__package__}.nodes"]

    def tearDown(self):
        self.temp.cleanup()

    def test_nested_preset_input_order_matches_compact_preview_and_expand(self):
        from test_scene_presets import matrix_line
        child = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                 "2": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["1", 0], "count": 2, "enable_downstream_count": False}},
                 "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}}}
        outer = {str(index): {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["7", 0],
                 "matrix_json": json.dumps({"version": 1, "sets": [matrix_line(name, positive_base=name)]})}}
                 for index, name in enumerate("ABC", 1)}
        outer.update({
            "7": {"class_type": "ScenePresetInput", "inputs": {}},
            "4": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "ordered-held", "scene_prompt": ["2", 0]}},
            "5": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["1", 0], "scene_prompt2": ["4", 0], "scene_prompt3": ["3", 0]}},
            "6": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["5", 0]}},
        })
        for name, nodes, output in (("ordered-held", child, "3"), ("ordered-outer", outer, "6")):
            self.presets.save_preset({"preset_id": name, "name": name, "output_node_id": output,
                "api_graph": {"output": nodes}, "workflow": {"version": 1, "nodes": []}})
        graph = {"reference": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "ordered-outer"}}}
        resolved = {}
        occurrences = self.presets.prepare_preset_occurrences(graph, resolved)
        plan = self.presets._scene_node_value(graph, "reference", {**resolved, "__occurrences__": occurrences}, set())
        cases = []
        for factor in (0, 2, 10):
            expected = ["A"] * factor + ["B"] * 2 + ["C"] * factor
            result = self.nodes.ScenePromptCounter().count(plan, factor)[0]
            actual = [self.nodes.ScenePromptExpand().expand(scene_prompt=result, current_index=index, timestamp_dir=False)[0]
                      for index in range(result["total_batches"])]
            self.assertEqual(actual, expected)
            cases.append({"preset_id": "ordered-outer", "factor": factor, "total": len(expected), "order": expected})
        checked = subprocess.run(["node", str(Path(__file__).with_name("test_scene_queue_schedule.cjs")), "--compact-count-response"],
            input=json.dumps({"response": self.presets.list_presets(), "cases": cases}), text=True, encoding="utf-8", capture_output=True, timeout=30)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)

    def test_count_node_schema_defaults_and_legacy_call_contract(self):
        counter = self.nodes.ScenePromptCounter()
        schema = counter.INPUT_TYPES()
        self.assertEqual(schema["optional"]["enable_downstream_count"], ("BOOLEAN", {"default": True, "display_name": "後続Countを有効化", "label": "後続Countを有効化"}))
        old = counter.count(None, 3, "uid", "source", "title")[0]
        self.assertEqual(counter.count(old, 10)[0]["total_batches"], 30)
        held = counter.count(count=3, enable_downstream_count=False)[0]
        self.assertEqual(counter.count(held, 0)[0]["total_batches"], 3)
        self.assertNotEqual(counter.IS_CHANGED(count=3), counter.IS_CHANGED(count=3, enable_downstream_count=False))

    def test_nested_preset_safe_evaluation_preserves_false_and_absent_true(self):
        child = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                 "2": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["1", 0], "count": 3, "enable_downstream_count": False}},
                 "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}}}
        outer = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                 "2": {"class_type": "ScenePresetReference", "inputs": {"scene_prompt": ["1", 0], "preset_id": "count-child"}},
                 "3": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["2", 0], "count": 10}},
                 "4": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["3", 0]}}}
        def save(name, nodes, output):
            return self.presets.save_preset({"preset_id": name, "name": name, "output_node_id": output,
                "api_graph": {"output": nodes}, "workflow": {"version": 1, "nodes": []}}, "default")
        saved_child = save("count-child", child, "3")
        saved_outer = save("count-outer", outer, "4")
        self.assertIs(saved_child["api_graph"]["output"]["2"]["inputs"]["enable_downstream_count"], False)
        result = self.presets._evaluate_preset_scene(saved_outer, {"count-child": saved_child}, None)
        self.assertEqual(result["total_batches"], 3)
        self.assertEqual(self.nodes.ScenePromptCounter().count(result, 0)[0]["total_batches"], 3)
        child["2"]["inputs"].pop("enable_downstream_count")
        legacy = save("count-legacy", child, "3")
        unprotected = self.presets._evaluate_preset_scene(legacy, {}, None)
        self.assertEqual(self.nodes.ScenePromptCounter().count(unprotected, 10)[0]["total_batches"], 30)

    def test_real_compact_list_matches_full_execution_and_frontend_count_composition(self):
        definitions = {}

        def save(name, nodes, output="3"):
            saved = self.presets.save_preset({"preset_id": name, "name": name, "output_node_id": output,
                "api_graph": {"output": nodes}, "workflow": {"version": 1, "nodes": []}})
            definitions[name] = saved
            return saved

        def count_nodes(count, enabled=None):
            inputs = {"scene_prompt": ["1", 0], "count": count}
            if enabled is not None:
                inputs["enable_downstream_count"] = enabled
            return {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                    "2": {"class_type": "ScenePromptCounter", "inputs": inputs},
                    "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}}}

        for name, count, enabled in (("held", 3, False), ("free", 3, True), ("legacy", 3, None),
                                     ("zero-held", 0, False), ("zero-free", 0, True)):
            save(name, count_nodes(count, enabled))
        nested = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                  "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "held", "scene_prompt": ["1", 0]}},
                  "4": {"class_type": "ScenePromptCounter", "inputs": {"scene_prompt": ["2", 0], "count": 10}},
                  "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["4", 0]}}}
        save("nested", nested)
        local_definition = copy.deepcopy(definitions["free"])
        local_definition["api_graph"]["output"]["2"]["inputs"]["enable_downstream_count"] = False
        local = copy.deepcopy(nested)
        local["2"]["inputs"].update({"preset_id": "free", "llm_presets_json": json.dumps({
            "version": 1, "presets": {".": local_definition},
        })})
        save("local", local)
        nested_local = copy.deepcopy(nested)
        nested_local["2"]["inputs"]["preset_id"] = "local"
        save("nested-local", nested_local)
        mixed = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
                 "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "held", "scene_prompt": ["1", 0]}},
                 "4": {"class_type": "ScenePromptCounter", "inputs": {"count": 2, "scene_prompt": ["1", 0]}},
                 "5": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["2", 0], "scene_prompt2": ["4", 0]}},
                 "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["5", 0]}}}
        save("mixed", mixed)
        mixed_local = copy.deepcopy(mixed)
        mixed_local["2"] = copy.deepcopy(local["2"])
        save("mixed-local", mixed_local)
        listed = self.presets.list_presets()
        self.assertEqual(listed["errors"], [])
        compact = {item["metadata"]["preset_id"]: item for item in listed["presets"]}
        self.assertIs(compact["held"]["api_graph"]["output"]["2"]["inputs"]["enable_downstream_count"], False)
        self.assertIs(compact["free"]["api_graph"]["output"]["2"]["inputs"]["enable_downstream_count"], True)
        self.assertNotIn("enable_downstream_count", compact["legacy"]["api_graph"]["output"]["2"]["inputs"])
        local_compact = json.loads(compact["local"]["api_graph"]["output"]["2"]["inputs"]["llm_presets_json"])["presets"]["."]
        self.assertIs(local_compact["api_graph"]["output"]["2"]["inputs"]["enable_downstream_count"], False)
        self.assertTrue(local_compact["scene_compact"])
        self.assertEqual(local_compact["workflow"], {"nodes": []})
        cases = []
        for name, factor, expected in (("held", 10, 3), ("held", 0, 3), ("free", 10, 30),
                                       ("legacy", 10, 30), ("legacy", 0, 0), ("zero-held", 10, 0),
                                       ("zero-free", 10, 0), ("nested", 10, 3), ("local", 10, 3),
                                       ("nested-local", 10, 3), ("mixed", 10, 23), ("mixed", 0, 3),
                                       ("mixed-local", 10, 23), ("mixed-local", 0, 3)):
            with self.subTest(name=name, factor=factor):
                outer = {"reference": {"class_type": "ScenePresetReference", "inputs": {"preset_id": name}}}
                resolved = {}
                occurrences = self.presets.prepare_preset_occurrences(outer, resolved)
                plan = self.presets._evaluate_preset_scene(definitions[name], {**resolved, "__occurrences__": occurrences},
                                                         None, reference_node_id="reference")
                plan = self.nodes.ScenePromptCounter().count(plan, factor)[0]
                self.assertEqual(plan["total_batches"], expected)
                with mock.patch.object(self.nodes, "dispatch_callback") as callback:
                    for index in range(expected):
                        expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=plan, current_index=index, timestamp_dir=False,
                                                                       callback_each={"kind": "fixture"})
                        self.assertEqual(expanded[2]["file_index"], index + 1)
                        self.assertEqual(callback.call_args.args[1]["exec_total_count"], expected)
                        self.assertEqual(callback.call_args.args[1]["exec_current_count"], index + 1)
                cases.append({"preset_id": name, "factor": factor, "total": expected})
        result = subprocess.run(["node", str(Path(__file__).with_name("test_scene_queue_schedule.cjs")), "--compact-count-response"],
                                input=json.dumps({"response": listed, "cases": cases}), text=True, encoding="utf-8",
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Real compact Preset response Count parity passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
