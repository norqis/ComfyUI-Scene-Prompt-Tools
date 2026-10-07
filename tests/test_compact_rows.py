"""Ordinary Matrix/Merge plans must retain row-major semantics without expanding."""

import json
import random
import unittest
from unittest import mock

from scene_prompt_tools import plan as p


def row(name, batch=None):
    result = {**p.empty_row(), "labels": [name], "positive_parts": [name],
              "source_node_ids": [name], "source_node_names": {name: name}}
    if batch:
        result["latent"] = {"width": 512, "height": 512, "batch_size": batch}
    return result


def matrix_rows(*names):
    return [{**p.empty_row(), "positive_parts": [name], "name": name, "enabled": True} for name in names]


def eager_matrix(entries, additions):
    result = []
    for entry in entries:
        for addition in additions:
            base = entry["row"]
            extra = {key: addition[key] for key in p.ROW_KEYS if key in addition}
            merged = p.merge_rows(base, extra)
            merged = p.with_prompt_trace(merged, base, extra["positive_parts"], extra["negative_parts"])
            merged["labels"] = [*base["labels"], addition["name"]]
            result.append({"row": merged, "count": entry["count"]})
    return result


def eager_count(entries, factor):
    # Count is a prompt passthrough node.
    return [{"row": p.with_prompt_trace(item["row"], item["row"], kind="passthrough"),
             "count": item["count"] * factor} for item in entries]


def eager_merge(left, right):
    result = []
    for first in left:
        for second in right:
            merged = p.merge_rows(first["row"], second["row"])
            merged = p.with_prompt_trace(merged, p.empty_row(), merged["positive_parts"], merged["negative_parts"], kind="whole")
            result.append({"row": merged, "count": first["count"] * second["count"]})
    return result


class CompactRowTests(unittest.TestCase):
    def assert_eager(self, actual, entries):
        expected = p.make_plan([{"row": entry["row"], "count": entry["count"]} for entry in entries])
        self.assertEqual(actual["stats"], expected["stats"])
        self.assertEqual(actual["rows"], expected["rows"])
        for index in range(expected["stats"]["total_batches"]):
            first, second = p.item_for_index(actual, index), p.item_for_index(expected, index)
            event = first.pop("event_ref")
            second.pop("event_ref")
            self.assertEqual(first, second, f"event {index}")
            self.assertEqual(p.replay_index_for_event(actual, event, set(), set()), index)

    def test_variable_count_matrix_merge_matches_eager_row_major_reference(self):
        rng = random.Random(581)
        for case in range(30):
            left = [{"row": row(f"a{i}", rng.choice([None, 2, 3])), "count": rng.randrange(4)}
                    for i in range(rng.randrange(1, 4))]
            right = [{"row": row(f"b{i}", rng.choice([None, 2])), "count": rng.randrange(3)}
                     for i in range(rng.randrange(1, 4))]
            first_rows, second_rows = matrix_rows("x", "y"), matrix_rows("u", "v")
            factor = rng.randrange(3)
            with self.subTest(case=case, factor=factor):
                actual = p.matrix_product(p.make_plan(left), first_rows, True)
                actual = p.multiply_count(actual, factor)
                actual = p.merge(actual, p.make_plan(right))
                actual = p.matrix_product(actual, second_rows, True)
                expected = eager_matrix(eager_merge(eager_count(eager_matrix(left, first_rows), factor), right), second_rows)
                self.assert_eager(actual, expected)
                restored = p.normalize_plan(json.loads(json.dumps(actual)))
                self.assertEqual(restored["change_key"], actual["change_key"])
                self.assert_eager(restored, expected)

    def test_replay_prunes_ordinary_branches_without_losing_repetition(self):
        left = p.make_plan([{"row": row("a"), "count": 2}, {"row": row("b"), "count": 3}])
        right = p.make_plan([{"row": row("c"), "count": 1}, {"row": row("d"), "count": 2}])
        result = p.with_source_node(p.multiply_count(p.matrix_product(p.merge(left, right), matrix_rows("x", "y"), True), 2), "tail")
        visible, selected = {"a", "b", "c", "d", "tail"}, {"b", "d", "tail"}
        expected = 0
        for index in range(result["stats"]["total_batches"]):
            event = p.item_for_index(result, index)
            if set(event["row"]["source_node_ids"]) <= selected:
                self.assertEqual(p.replay_index_for_event(result, event["event_ref"], selected, visible), expected)
                expected += 1
        self.assertEqual(expected, 24)

    def test_fixed_and_strict_count_policies_survive_matrix_and_merge(self):
        base = p.matrix_product(p.make_plan([{"row": row("a"), "count": 2}]), matrix_rows("x", "y"), True)
        fixed = p.queue([base], downstream_count_mode="fixed")
        mapped = p.matrix_product(fixed, matrix_rows("u", "v"), True)
        self.assertEqual(p.multiply_count(mapped, 10)["stats"]["total_batches"], 8)
        self.assertEqual(p.multiply_count(mapped, 0)["stats"]["total_batches"], 0)
        # Ordinary Merge historically clears legacy Queue fixedness.
        merged = p.merge(mapped, p.make_plan([{"row": row("z"), "count": 2}]))
        self.assertEqual(p.multiply_count(merged, 3)["stats"]["total_batches"], 48)
        held = p.multiply_count(base, 3, enable_downstream_count=False)
        mixed = p.queue([held, mapped])
        self.assertEqual(p.multiply_count(mixed, 10)["stats"]["total_batches"], 20)
        self.assertEqual(p.multiply_count(mixed, 0)["stats"]["total_batches"], 12)
        strict_merge = p.merge(held, base)
        self.assertEqual(p.multiply_count(strict_merge, 10)["stats"], strict_merge["stats"])

    def test_named_operations_and_callback_snapshots_remain_lazy(self):
        base = p.make_plan([{"row": row("a"), "count": 2}])
        compact = p.matrix_product(base, matrix_rows("x", "y"), True)
        eager = p.make_plan(eager_matrix(base["rows"], matrix_rows("x", "y")))
        operations = [
            {"kind": "prompt_add", "payload": ["tail", ["(detail:1.3)"], ["blur"], True]},
            {"kind": "delete", "payload": ["x", "blur"]},
            {"kind": "latent_set", "payload": {"width": 512, "height": 512, "batch_size": 3}},
        ]
        for operation in operations:
            compact = p.transform(compact, operation=operation)
            eager = p.transform(eager, operation=operation)
        compact = p.append_callback(compact, "callback", {"text": "{current_positive}"}, "毎回", 10, "続行")
        eager = p.append_callback(eager, "callback", {"text": "{current_positive}"}, "毎回", 10, "続行")
        self.assert_eager(compact, eager["rows"])
        self.assertEqual(len(compact["units"]), 1)

    def test_callable_compatibility_transform_accepts_compact_ordinary_rows(self):
        compact = p.matrix_product(p.seed_plan(), matrix_rows("x", "y"), True)
        transformed = p.transform(compact, lambda value, _entry: {**value, "labels": [*value["labels"], "custom"]})
        self.assertEqual([item["label"] for item in transformed["rows"]], ["x / custom", "y / custom"])

    def test_preparation_retains_only_input_rows_and_huge_count_selects_directly(self):
        compact = p.seed_plan()
        rows = matrix_rows(*(str(index) for index in range(30)))
        with mock.patch.object(p, "merge_rows", wraps=p.merge_rows) as merge_rows:
            for _ in range(3):
                compact = p.with_source_node(p.matrix_product(compact, rows, True), "matrix")
            self.assertEqual(merge_rows.call_count, 0, "preparation must not build the 27,000 combinations")
        self.assertEqual(compact["stats"]["row_count"], 27_000)
        self.assertLess(len(json.dumps(compact)), 70_000)
        compact = p.multiply_count(compact, 100_000_000)
        last = p.item_for_index(compact, compact["stats"]["total_batches"] - 1)
        self.assertEqual(last["row"]["labels"], ["29", "29", "29"])
        self.assertEqual(last["repeat_index"], 100_000_000)
        self.assertEqual(last["row_index"], 26_999)

    def test_single_row_shared_merge_chain_does_not_build_a_recursive_product(self):
        compact = p.make_plan([{"row": row("a"), "count": 1}])
        for _ in range(40):
            compact = p.merge(compact, compact)
        self.assertLess(compact.depth, 3)
        self.assertEqual(p.item_for_index(compact, 0)["row"]["positive_parts"], ["a"])


if __name__ == "__main__":
    unittest.main()
