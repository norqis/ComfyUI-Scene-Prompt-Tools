import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scene_prompt_tools.plan import (
    SCENE_PROMPT_TYPE,
    ScenePlanError,
    empty_row,
    item_for_index,
    make_plan,
    matrix_product,
    merge,
    multiply_count,
    normalize_plan,
    queue,
    seed_plan,
    transform,
)


def prompt_plan(label, count=1):
    return make_plan([{"row": {**empty_row(), "labels": [label], "positive_parts": [label]}, "count": count}])


def prompt_row(label):
    return {**empty_row(), "labels": [label]}


class ScenePlanTests(unittest.TestCase):
    def test_unconnected_input_starts_with_one_seed_row(self):
        plan = normalize_plan(None)
        self.assertEqual(plan["total_batches"], 1)
        self.assertEqual(plan["total_images"], 1)
        self.assertEqual(len(plan["rows"]), 1)

    def test_explicit_empty_plan_stays_empty(self):
        plan = make_plan([])
        self.assertEqual(normalize_plan(plan)["total_batches"], 0)
        self.assertEqual(normalize_plan(plan)["total_images"], 0)

    def test_invalid_plan_is_rejected(self):
        with self.assertRaises(ScenePlanError):
            normalize_plan({"type": "WRONG", "version": 1, "rows": []})

    def test_plan_items_require_current_wrapper_and_integer_count(self):
        invalid_rows = (
            [{"positive_parts": ["flat"], "count": 1}],
            [{"row": {**empty_row(), "positive_parts": ["missing"]}}],
            [{"row": {**empty_row(), "positive_parts": ["bad-count"]}, "count": "bad"}],
            [{"row": {**empty_row(), "positive_parts": ["boolean-count"]}, "count": True}],
            [{"row": {**empty_row(), "positive_parts": ["negative-count"]}, "count": -1}],
            [{"row": {**empty_row(), "positive_parts": ["large-count"]}, "count": 1_000_000_001}],
        )
        for rows in invalid_rows:
            with self.subTest(rows=rows):
                with self.assertRaises(ScenePlanError):
                    make_plan(rows)

    def test_latent_requires_complete_integer_current_schema(self):
        invalid_latents = (
            {"width": 512, "height": 512},
            {"width": "512", "height": 512, "batch_size": 1},
            {"width": True, "height": 512, "batch_size": 1},
            {"width": 510, "height": 512, "batch_size": 1},
            {"width": 512, "height": 512, "batch_size": 0},
        )
        for latent in invalid_latents:
            with self.subTest(latent=latent):
                with self.assertRaises(ScenePlanError):
                    make_plan([{"row": {**empty_row(), "latent": latent}, "count": 1}])

    def test_count_is_multiplicative(self):
        plan = multiply_count(multiply_count(prompt_plan("A"), 10), 2)
        self.assertEqual(plan["rows"][0]["count"], 20)
        self.assertEqual(plan["total_batches"], 20)

    def test_branching_does_not_mutate_the_input_plan(self):
        base = multiply_count(prompt_plan("A"), 10)
        branch_b = multiply_count(transform(base, lambda row, _item: {**row, "labels": [*row["labels"], "B"]}), 2)
        branch_c = multiply_count(transform(base, lambda row, _item: {**row, "labels": [*row["labels"], "C"]}), 3)
        self.assertEqual(base["rows"][0]["count"], 10)
        self.assertEqual(branch_b["total_batches"], 20)
        self.assertEqual(branch_c["total_batches"], 30)
        self.assertEqual(queue([branch_b, branch_c])["total_batches"], 50)

    def test_merge_is_a_cartesian_product_with_multiplied_counts(self):
        left = make_plan([
            {"row": prompt_row("A"), "count": 10},
            {"row": prompt_row("B"), "count": 2},
        ])
        right = make_plan([
            {"row": prompt_row("C"), "count": 3},
            {"row": prompt_row("D"), "count": 4},
        ])
        combined = merge(left, right)
        self.assertEqual(len(combined["rows"]), 4)
        self.assertEqual([item["count"] for item in combined["rows"]], [30, 40, 6, 8])
        self.assertEqual(combined["total_batches"], 84)

    def test_merge_can_expand_to_six_hundred_batches(self):
        left = prompt_plan("A", 10)
        right = make_plan([
            {"row": prompt_row("B"), "count": 30},
            {"row": prompt_row("C"), "count": 30},
        ])
        self.assertEqual(merge(left, right)["total_batches"], 600)

    def test_queue_with_no_inputs_uses_the_seed_plan(self):
        self.assertEqual(queue([])["total_batches"], 1)
        self.assertEqual(queue([make_plan([])])["total_batches"], 0)

    def test_matrix_without_rows_is_identity_and_all_disabled_is_empty(self):
        base = prompt_plan("A", 2)
        self.assertEqual(matrix_product(base, [], False)["total_batches"], 2)
        self.assertEqual(matrix_product(base, [{**prompt_row("off"), "name": "off", "enabled": False}], True)["total_batches"], 0)

    def test_matrix_is_a_product_and_preserves_count(self):
        result = matrix_product(
            prompt_plan("A", 10),
            [
                {**prompt_row("B"), "name": "B", "enabled": True, "positive_parts": ["b"]},
                {**prompt_row("C"), "name": "C", "enabled": True, "positive_parts": ["c"]},
            ],
            True,
        )
        self.assertEqual(result["total_batches"], 20)
        self.assertEqual([item["count"] for item in result["rows"]], [10, 10])

    def test_transform_preserves_count_and_batch_size_affects_final_images(self):
        plan = transform(
            multiply_count(seed_plan(), 2),
            lambda row, _item: {**row, "latent": {"width": 832, "height": 1216, "batch_size": 4}},
        )
        self.assertEqual(plan["total_batches"], 2)
        self.assertEqual(plan["total_images"], 8)
        self.assertEqual(item_for_index(plan, 1)["repeat_index"], 2)
        with self.assertRaises(IndexError):
            item_for_index(plan, 2)

    def test_plan_type_is_current_schema_only(self):
        self.assertEqual(seed_plan()["type"], SCENE_PROMPT_TYPE)
        with self.assertRaises(ScenePlanError):
            normalize_plan({"type": SCENE_PROMPT_TYPE, "version": 0, "rows": []})

    def test_current_serialized_plan_rejects_unknown_and_missing_fields(self):
        plan = prompt_plan("A")
        with self.assertRaises(ScenePlanError):
            normalize_plan({**plan, "legacy": True})
        broken = {**plan, "rows": [{**plan["rows"][0], "row": {**plan["rows"][0]["row"], "legacy": True}}]}
        with self.assertRaises(ScenePlanError):
            normalize_plan(broken)


if __name__ == "__main__":
    unittest.main()
