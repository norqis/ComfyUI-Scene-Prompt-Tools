import copy
import json
import unittest

from scene_prompt_tools.plan import (
    ScenePlanError, append_callback, item_for_normalized_plan, make_plan, multiply_count, normalize_plan,
    queue, random_route, replay_index_for_event, seed_plan, transform,
)


def add(plan, label):
    return transform(plan, operation={"kind": "prompt_add", "payload": [label, [label], [], False]})


class RandomRouteScheduleTests(unittest.TestCase):
    def route(self, plan=None, weights=None, gate="gate"):
        return random_route(plan if plan is not None else seed_plan(), weights or [5000, 5000] + [0] * 8, gate)

    def test_each_count_event_draws_independently_without_count_inflation(self):
        a, b, *zero = self.route()
        joined = queue([add(a, "A"), add(b, "B"), zero[0]], order_mode="alternate", alternate_block_size=9,
                       downstream_count_mode="fixed")
        plan = multiply_count(joined, 10)
        # A closing Queue ignores its ordinary controls; Count schedules ten draws.
        self.assertEqual(plan["stats"]["total_batches"], 10)
        self.assertEqual(plan["stats"]["total_images"], 10)
        labels = [item_for_normalized_plan(plan, index, 123 + index)["row"]["positive_parts"] for index in range(10)]
        self.assertEqual(labels, [["A"], ["B"], ["B"], ["A"], ["A"], ["A"], ["A"], ["A"], ["B"], ["A"]])
        self.assertEqual(labels, [item_for_normalized_plan(plan, index, 123 + index)["row"]["positive_parts"] for index in range(10)])

    def test_positive_missing_or_wrong_join_and_open_guard_rejected(self):
        a, b, *_ = self.route()
        with self.assertRaisesRegex(ScenePlanError, "出力2"):
            queue([a])
        with self.assertRaisesRegex(ScenePlanError, "無関係"):
            queue([a, seed_plan()])
        with self.assertRaisesRegex(ScenePlanError, "分岐"):
            item_for_normalized_plan(a, 0, 100)
        with self.assertRaisesRegex(ScenePlanError, "分岐"):
            _ = a["rows"]
        with self.assertRaisesRegex(ScenePlanError, "Count"):
            multiply_count(a, 2)
        with self.assertRaisesRegex(ScenePlanError, "Matrix"):
            from scene_prompt_tools.plan import matrix_product
            matrix_product(a, [], True)
        with self.assertRaisesRegex(ScenePlanError, "Merge"):
            from scene_prompt_tools.plan import merge
            merge(a, b)

    def test_single_positive_passes_without_join_and_zero_is_inert(self):
        weights = [0, 10000] + [0] * 8
        outputs = self.route(add(seed_plan(), "base"), weights)
        self.assertEqual(outputs[0]["stats"]["total_batches"], 0)
        self.assertEqual(outputs[1]["random_guards"], [])
        self.assertEqual(item_for_normalized_plan(outputs[1], 0, 5)["row"]["positive_parts"], ["base"])
        self.assertEqual(queue([outputs[1], outputs[0]])["stats"]["total_batches"], 1)

    def test_nested_stack_lifo_and_crossed_gate_error(self):
        outer_a, outer_b, *_ = self.route(gate="outer")
        inner_a, inner_b, *_ = self.route(outer_a, gate="inner")
        resolved = queue([add(inner_a, "innerA"), add(inner_b, "innerB")])
        final = queue([add(resolved, "outerA"), add(outer_b, "outerB")])
        self.assertEqual(final["stats"]["total_batches"], 1)
        self.assertEqual(final["random_guards"], [])
        self.assertEqual(len(item_for_normalized_plan(final, 0, 7)["row"]["positive_parts"]), 2)
        with self.assertRaisesRegex(ScenePlanError, "交差"):
            queue([inner_a, outer_b])

    def test_million_count_lazy_and_guard_is_immutable_copy(self):
        weights = [5000, 5000] + [0] * 8
        a, b, *_ = self.route(weights=weights)
        weights[0] = 0
        self.assertEqual(a["random_guards"][0]["weights"][0], 5000)
        result = multiply_count(queue([add(a, "A"), add(b, "B")]), 1_000_000)
        self.assertEqual(len(result["units"]), 1)
        self.assertEqual(result["stats"]["total_batches"], 1_000_000)
        self.assertIn(item_for_normalized_plan(result, 999_999, 1_000_000)["row"]["positive_parts"], (["A"], ["B"]))
        self.assertEqual(normalize_plan(copy.deepcopy(result))["change_key"], result["change_key"])

    def test_only_winning_model_lora_and_callback_survive_selection(self):
        arms = self.route()
        branches = []
        for index, name in enumerate(("A", "B")):
            branch = add(arms[index], name)
            branch = transform(branch, operation={"kind": "model_set", "payload": {
                "model": [name, 0], "clip": [name, 1], "vae": [name, 2],
            }})
            branch = transform(branch, operation={"kind": "lora_add", "payload": {
                "name": f"{name}.safetensors", "model_mode": "Illustrious", "strength_model": 1.0,
                "strength_clip": 1.0, "positive_parts": [name], "negative_parts": [],
            }})
            branch = append_callback(branch, f"callback_{name}", {"kind": "test"}, "every", 10, "continue")
            branches.append(branch)
        plan = queue(branches)
        for seed in range(50):
            row = item_for_normalized_plan(plan, 0, seed)["row"]
            name = row["positive_parts"][0]
            self.assertEqual(row["model_links"]["model"][0], name)
            self.assertEqual([entry["name"] for entry in row["loras"]], [f"{name}.safetensors"])
            self.assertEqual([entry["callback_node_id"] for entry in row["callbacks"]], [f"callback_{name}"])

    def test_replay_prunes_to_selected_branch_and_rebases_prior_rows(self):
        a, b, *_ = self.route(gate="route")
        branch = queue([add(a, "A"), add(b, "B")])
        plan = queue([add(seed_plan(), "before"), branch])
        selected = item_for_normalized_plan(plan, 1, 321)
        index = replay_index_for_event(plan, selected["event_ref"], set(), set())
        self.assertEqual(index, 1)
        markers = [marker for marker in selected["event_ref"] if marker[0] == "random_choice"]
        self.assertEqual(markers[0][1], "route")

    def test_replay_nested_choices_and_unrelated_prior_gate(self):
        earlier_a, earlier_b, *_ = self.route(gate="earlier")
        earlier = queue([add(earlier_a, "oldA"), add(earlier_b, "oldB")])
        outer_a, outer_b, *_ = self.route(gate="outer")
        inner_a, inner_b, *_ = self.route(outer_a, gate="inner")
        inner = queue([add(inner_a, "IA"), add(inner_b, "IB")])
        nested = queue([inner, add(outer_b, "OB")])
        plan = queue([earlier, nested])
        item = item_for_normalized_plan(plan, 1, 123)
        self.assertEqual(replay_index_for_event(plan, item["event_ref"], set(), set()), 0)
        gate_ids = [part[1] for part in item["event_ref"] if part[0] == "random_choice"]
        self.assertEqual(gate_ids[0], "outer")


if __name__ == "__main__":
    unittest.main()
