import unittest
import copy
import json
import subprocess
import sys

from scene_prompt_tools.plan import (
    MAX_SAFE_INTEGER, ScenePlanError, append_callback, empty_row, item_for_index, make_plan, matrix_product,
    merge, multiply_count, normalize_plan, queue, replay_index_for_event, transform,
    with_source_node,
)


def branch(name, count=1):
    row = {**empty_row(), "labels": [name], "positive_parts": [name]}
    return with_source_node(make_plan([{"row": row, "count": count}]), name, name)


def labels(plan):
    return [item_for_index(plan, index)["label"] for index in range(plan["stats"]["total_batches"])]


class LazyScheduleTests(unittest.TestCase):
    def test_target_mixed_queue_composition_and_locked_controls(self):
        alternate = queue([branch("b1"), branch("b2")], order_mode="alternate")
        ordinary = queue([branch("b3"), branch("b4")])
        combined = queue([alternate, ordinary], order_mode="alternate", alternate_block_size=7,
                         input_repeats_json='{"scene_prompt1":9}', downstream_count_mode="fixed")
        self.assertEqual(labels(combined), ["b1", "b2", "b3", "b4"])
        self.assertEqual(labels(multiply_count(combined, 3)), ["b1", "b2"] * 3 + ["b3"] * 3 + ["b4"] * 3)

    def test_default_queue_keeps_legacy_row_metadata(self):
        result = multiply_count(queue([branch("a", 2), branch("b", 3)]), 2)
        self.assertEqual(labels(result), ["a"] * 4 + ["b"] * 6)
        items = [item_for_index(result, index) for index in range(10)]
        self.assertEqual([item["row_index"] for item in items], [0] * 4 + [1] * 6)
        self.assertEqual([item["repeat_index"] for item in items], list(range(1, 5)) + list(range(1, 7)))
        self.assertEqual([item["start_index"] for item in items], [0] * 4 + [4] * 6)

    def test_socket_repeats_and_block_sizes(self):
        left, right = branch("A"), branch("B")
        settings = '{"scene_prompt1":3,"scene_prompt2":2}'
        self.assertEqual(labels(queue([left, right], input_repeats_json=settings)), list("AAABB"))
        self.assertEqual(labels(queue([left, right], order_mode="alternate", input_repeats_json=settings)), list("ABABA"))
        self.assertEqual(labels(queue([left, right], order_mode="alternate", alternate_block_size=2,
                                      input_repeats_json=settings)), list("AABBA"))
        self.assertEqual(labels(queue([left, right], order_mode="alternate", alternate_block_size=3,
                                      input_repeats_json=settings)), list("AAABB"))
        self.assertEqual(labels(queue([left, right], order_mode="alternate", alternate_block_size=MAX_SAFE_INTEGER,
                                      input_repeats_json=settings)), list("AAABB"))

    def test_whole_socket_plan_repeats_and_count_repeats_cycle(self):
        multi = make_plan([{"row": {**empty_row(), "labels": [name]}, "count": 1} for name in ("a1", "a2")])
        result = queue([multi, branch("b")], order_mode="alternate", input_repeats_json='{"scene_prompt1":3}')
        self.assertEqual(labels(result), ["a1", "b", "a2", "a1", "a2", "a1", "a2"])
        self.assertEqual(labels(multiply_count(result, 2)), labels(result) * 2)

    def test_count_placement_and_uneven_streams(self):
        source = queue([branch("a", 2), branch("b", 3)], order_mode="alternate")
        self.assertEqual(labels(source), ["a", "b", "a", "b", "b"])
        self.assertEqual(labels(multiply_count(source, 2)), ["a", "b", "a", "b", "b"] * 2)
        before = queue([multiply_count(branch("a"), 2), branch("b")], order_mode="alternate")
        self.assertEqual(labels(before), ["a", "b", "a"])

    def test_fixed_count_and_locked_queue_inherits_protection(self):
        fixed = queue([branch("f")], downstream_count_mode="fixed")
        self.assertEqual(labels(multiply_count(fixed, 100)), ["f"])
        combined = queue([fixed, branch("b")], downstream_count_mode="fixed",
                         input_repeats_json='{"scene_prompt1":3}')
        self.assertEqual(labels(multiply_count(combined, 3)), ["f", "b", "b", "b"])
        self.assertEqual(multiply_count(fixed, 0)["stats"]["total_batches"], 0)
        self.assertEqual(labels(multiply_count(queue([], downstream_count_mode="fixed"), 3)), ["Scene"])
        self.assertEqual(labels(multiply_count(multiply_count(fixed, 2), 3)), ["f"])
        through_prompt = transform(fixed, operation={"kind": "prompt_add", "payload": ["after", ["word"], [], False]})
        self.assertEqual(labels(multiply_count(queue([through_prompt, branch("b")]), 3)),
                         ["f / after", "b", "b", "b"])

    def test_empty_queue_still_locks_downstream(self):
        empty = queue([multiply_count(branch("a"), 0)])
        self.assertTrue(empty["contains_queue_boundary"])
        downstream = queue([empty, branch("b")], order_mode="alternate",
                           input_repeats_json='{"scene_prompt2":5}', downstream_count_mode="fixed")
        self.assertEqual(labels(multiply_count(downstream, 3)), ["b", "b", "b"])

    def test_matrix_mixed_runs_and_alternate(self):
        mixed = queue([queue([branch("b1"), branch("b2")], order_mode="alternate"), branch("b3", 2)])
        rows = [{**empty_row(), "name": name, "enabled": True} for name in ("x", "y")]
        mapped = matrix_product(mixed, rows, True)
        self.assertEqual(labels(multiply_count(mapped, 2)),
                         ["b1 / x", "b1 / y", "b2 / x", "b2 / y"] * 2 +
                         ["b3 / x"] * 4 + ["b3 / y"] * 4)

    def test_product_uses_right_preferred_latent(self):
        def latent(name, size=None):
            row = {**empty_row(), "labels": [name]}
            if size:
                row["latent"] = {"width": 512, "height": 512, "batch_size": size}
            return row
        left = queue([make_plan([{"row": latent("a", 2), "count": 1}]),
                      make_plan([{"row": latent("b", 3), "count": 1}])], order_mode="alternate")
        right = make_plan([{"row": latent("x"), "count": 1}, {"row": latent("y", 4), "count": 1}])
        product = merge(left, right)
        self.assertEqual(labels(product), ["a / x", "a / y", "b / x", "b / y"])
        self.assertEqual(product["stats"]["total_images"], 13)
        self.assertEqual(product["stats"]["unset_batches"], 0)

    def test_latent_setting_on_alternate_updates_exact_image_totals(self):
        plan = queue([branch("a", 2), branch("b", 3)], order_mode="alternate")
        latent = {"width": 512, "height": 512, "batch_size": 4}
        updated = transform(plan, latent=latent)
        self.assertEqual(updated["stats"]["total_batches"], 5)
        self.assertEqual(updated["stats"]["total_images"], 20)
        self.assertEqual(updated["stats"]["unset_batches"], 0)
        self.assertEqual(item_for_index(updated, 4)["row"]["latent"], latent)

    def test_callback_snapshots_follow_selected_path(self):
        first = append_callback(branch("a"), "callback-a", {"text": "{current_positive}"}, "毎回", 10, "続行")
        second = append_callback(branch("b"), "callback-b", {"text": "{current_positive}"}, "毎回", 10, "続行")
        plan = queue([first, second], order_mode="alternate")
        left = item_for_index(plan, 0)["row"]
        right = item_for_index(plan, 1)["row"]
        self.assertEqual([callback["callback_node_id"] for callback in left["callbacks"]], ["callback-a"])
        self.assertEqual([callback["callback_node_id"] for callback in right["callbacks"]], ["callback-b"])
        self.assertEqual(left["callbacks"][0]["current_positive_parts"], ["a"])
        self.assertEqual(right["callbacks"][0]["current_source_node_ids"], ["b"])

    def test_replay_ranks_selected_branch_after_pruning(self):
        result = queue([branch("a"), branch("b")], order_mode="alternate")
        selected = item_for_index(result, 1)
        self.assertEqual(replay_index_for_event(result, selected["event_ref"], {"b"}, {"a", "b"}), 0)
        duplicate = queue([branch("a"), branch("a")], order_mode="alternate")
        selected = item_for_index(duplicate, 1)
        self.assertEqual(replay_index_for_event(duplicate, selected["event_ref"], {"a"}, {"a"}), 1)

    def test_closed_operations_are_serializable_and_hash_stable(self):
        result = transform(queue([branch("a"), branch("b")], order_mode="alternate"), operation={
            "kind": "prompt_add", "payload": ["tail", ["foo"], [], False],
        })
        self.assertEqual(normalize_plan(json.loads(json.dumps(result)))["change_key"], result["change_key"])
        code = ("import json; from scene_prompt_tools.plan import *; "
                "r=lambda x:make_plan([{'row':{**empty_row(),'labels':[x]},'count':1}]); "
                "p=transform(queue([r('a'),r('b')],order_mode='alternate'),"
                "operation={'kind':'prompt_add','payload':['tail',['foo'],[],False]}); "
                "print(p['change_key'])")
        first = subprocess.check_output([sys.executable, "-c", code], text=True).strip()
        second = subprocess.check_output([sys.executable, "-c", code], text=True).strip()
        self.assertEqual(first, second)
        broken = json.loads(json.dumps(result))
        broken["units"][0]["operations"][0]["kind"] = "arbitrary"
        with self.assertRaises(ScenePlanError):
            normalize_plan(broken)

    def test_huge_alternate_is_lazy(self):
        result = multiply_count(queue([branch("a"), branch("b")], order_mode="alternate"), 100_000_000)
        self.assertLess(len(result["units"]), 4)
        self.assertEqual(result["stats"]["total_batches"], 200_000_000)
        self.assertEqual(item_for_index(result, 199_999_999)["label"], "b")

    def test_schedule_depth_limit_accepts_256_and_rejects_257(self):
        from scene_prompt_tools.schedule import _plan, _unit
        unit = _unit("run", row=empty_row(), count=1)
        for _ in range(255):
            unit = _unit("count_fixed", unit=unit)
        accepted = _plan([unit])
        self.assertEqual(accepted.depth, 256)
        with self.assertRaises(ScenePlanError):
            _plan([_unit("count_fixed", unit=unit)])

    def test_controls_validate_even_if_locked(self):
        locked_input = queue([branch("a")])
        with self.assertRaises(ScenePlanError):
            queue([locked_input], order_mode="bogus")
        with self.assertRaises(ScenePlanError):
            queue([locked_input], input_repeats_json='{"unknown":2}')
        for invalid in ('[]', '{"scene_prompt1":true}', '{"scene_prompt1":-1}', '{"scene_prompt11":2}'):
            with self.subTest(invalid=invalid), self.assertRaises(ScenePlanError):
                queue([branch("a")], input_repeats_json=invalid)
        with self.assertRaises(ScenePlanError):
            queue([branch("a")], alternate_block_size=0)
        with self.assertRaises(ScenePlanError):
            queue([branch("a")], downstream_count_mode="other")

    def test_ten_sockets_and_zero_length_inputs(self):
        streams = [branch(str(index), 0 if index % 3 == 0 else 1) for index in range(10)]
        plan = queue(streams, order_mode="alternate")
        self.assertEqual(labels(plan), [str(index) for index in range(10) if index % 3 != 0])
        self.assertEqual(plan["stats"]["row_count"], 10)

    def test_schema_rejects_wrong_statistics_fingerprint_and_cycles(self):
        plan = queue([branch("a"), branch("b")], order_mode="alternate")
        for broken in (
            {**json.loads(json.dumps(plan)), "stats": {**plan["stats"], "total_batches": True}},
            {**json.loads(json.dumps(plan)), "change_key": "wrong"},
            {**json.loads(json.dumps(plan)), "extra": 1},
        ):
            with self.assertRaises(ScenePlanError):
                normalize_plan(broken)
        cyclic = json.loads(json.dumps(plan))
        cyclic["units"][0]["unit"]["inputs"][0] = cyclic
        with self.assertRaises(ScenePlanError):
            normalize_plan(cyclic)

    def test_consistently_fingerprinted_malformed_lazy_payloads_are_rejected(self):
        from scene_prompt_tools.schedule import ScheduleUnit, _plan
        base = queue([branch("a"), branch("b")], order_mode="alternate")
        matrix_rows = [{**empty_row(), "name": "x", "enabled": True}]
        matrix = matrix_product(base, matrix_rows, True)
        malformed_matrix = {**matrix["units"][0], "matrix_rows": copy.deepcopy(matrix["units"][0]["matrix_rows"])}
        malformed_matrix["matrix_rows"][0]["positive_parts"] = "not a list"
        forged_matrix = _plan([ScheduleUnit(malformed_matrix)], boundary=True)
        with self.assertRaises(ScenePlanError):
            normalize_plan(json.loads(json.dumps(forged_matrix)))

        mapped = transform(base, operation={"kind": "prompt_add", "payload": ["tail", [], [], False]})
        malformed_map = {**mapped["units"][0], "operations": copy.deepcopy(mapped["units"][0]["operations"])}
        malformed_map["operations"] = [{"kind": "callback", "payload": ["cb", {}, "never", 10, "続行"]}]
        forged_map = _plan([ScheduleUnit(malformed_map)], boundary=True)
        with self.assertRaises(ScenePlanError):
            normalize_plan(json.loads(json.dumps(forged_map)))
        malformed_map["operations"][0]["payload"] = ["cb", {}, "毎回", 10, "ignore"]
        forged_map = _plan([ScheduleUnit(malformed_map)], boundary=True)
        with self.assertRaises(ScenePlanError):
            normalize_plan(json.loads(json.dumps(forged_map)))

    def test_lazy_matrix_and_operation_copy_caller_payload(self):
        base = queue([branch("a"), branch("b")], order_mode="alternate")
        rows = [{**empty_row(), "name": "x", "enabled": True, "positive_parts": ["matrix-word"]}]
        matrix = matrix_product(base, rows, True)
        rows[0]["positive_parts"][0] = "mutated"
        self.assertEqual(item_for_index(matrix, 0)["row"]["positive_parts"], ["a", "matrix-word"])

        payload = ["tail", ["original"], [], False]
        plan = transform(base, operation={"kind": "prompt_add", "payload": payload})
        payload[1][0] = "mutated"
        self.assertIn("original", item_for_index(plan, 0)["row"]["positive_parts"])
        self.assertNotIn("mutated", item_for_index(plan, 0)["row"]["positive_parts"])

    def test_small_alternating_schedules_match_eager_reference(self):
        for a_count in range(4):
            for b_count in range(4):
                for a_repeat in range(3):
                    for block in (1, 2, 4):
                        streams = [["a"] * a_count * a_repeat, ["b"] * b_count]
                        expected = []
                        position = [0, 0]
                        while any(position[index] < len(stream) for index, stream in enumerate(streams)):
                            for index, stream in enumerate(streams):
                                expected.extend(stream[position[index]:position[index] + block])
                                position[index] += block
                        plan = queue([branch("a", a_count), branch("b", b_count)], order_mode="alternate",
                                     alternate_block_size=block,
                                     input_repeats_json=json.dumps({"scene_prompt1": a_repeat}))
                        with self.subTest(a=a_count, b=b_count, repeat=a_repeat, block=block):
                            self.assertEqual(labels(plan), expected)
                            self.assertEqual(plan["stats"]["total_batches"], len(expected))
                            self.assertEqual(plan["stats"]["total_images"], len(expected))


if __name__ == "__main__":
    unittest.main()
