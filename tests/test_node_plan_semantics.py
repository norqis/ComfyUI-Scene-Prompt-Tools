import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()
install_comfy_execution_stub()


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"


def load_nodes(output_dir):
    comfy = types.ModuleType("comfy")
    management = types.ModuleType("comfy.model_management")
    management.intermediate_device = lambda: "cpu"
    management.intermediate_dtype = lambda: torch.float32
    comfy.model_management = management
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: str(output_dir)
    folder_paths.get_user_directory = lambda: str(output_dir / "user")
    folder_paths.get_public_user_directory = lambda user_id: str(output_dir / "user" / user_id)
    folder_paths.get_filename_list = lambda category: ["style/example.safetensors"] if category == "loras" else []
    sys.modules.update({
        "comfy": comfy,
        "comfy.model_management": management,
        "comfy.cli_args": cli_args,
        "folder_paths": folder_paths,
    })
    package_name = "scene_plan_node_test"
    for name in list(sys.modules):
        if name == package_name or name.startswith(f"{package_name}."):
            del sys.modules[name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return (
        importlib.import_module(f"{package_name}.nodes"),
        importlib.import_module(f"{package_name}.prompt"),
    )


class SceneNodePlanSemanticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.nodes, self.prompt = load_nodes(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_every_transform_node_can_start_a_plan(self):
        matrix = self.nodes.SceneMatrix().build('{"version":1,"sets":[]}')[0]
        path = self.nodes.ScenePath().apply_path("folder")[0]
        count = self.nodes.ScenePromptCounter().count(count=2)[0]
        latent = self.nodes.SceneEmptyLatent().apply_latent(width=832, height=1216, batch_size=2)[0]
        merged = self.nodes.ScenePromptMerge().merge()[0]
        queued = self.nodes.ScenePromptQueue().queue()[0]
        model = self.nodes.SceneApplyModel().apply_model(["checkpoint", 0], ["checkpoint", 1], ["checkpoint", 2])[0]
        lora = self.nodes.SceneApplyLora().apply_lora("style/example.safetensors")[0]
        self.assertEqual(matrix["total_batches"], 1)
        self.assertEqual(path["total_batches"], 1)
        self.assertEqual(count["total_batches"], 2)
        self.assertEqual(latent["total_images"], 2)
        self.assertEqual(merged["total_batches"], 1)
        self.assertEqual(queued["total_batches"], 1)
        self.assertEqual(model["rows"][0]["row"]["model_links"]["model"], ["checkpoint", 0])
        self.assertEqual(lora["rows"][0]["row"]["loras"][0]["name"], "style/example.safetensors")

    def test_expand_uses_last_model_bundle_then_all_route_loras_in_path_order(self):
        first = self.nodes.SceneApplyModel().apply_model(
            ["checkpoint-a", 0], ["checkpoint-a", 1], ["checkpoint-a", 2],
        )[0]
        first = self.nodes.SceneApplyLora().apply_lora(
            "style/first.safetensors", 0.7, 0.8, first,
        )[0]
        second = self.nodes.SceneApplyModel().apply_model(
            ["checkpoint-b", 0], ["checkpoint-b", 1], ["vae-b", 0], first,
        )[0]
        second = self.nodes.SceneApplyLora().apply_lora(
            "style/second.safetensors", 1.1, 1.2, second,
        )[0]

        expanded = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, scene_prompt=second,
        )

        self.assertIsInstance(expanded, dict)
        graph = expanded["expand"]
        self.assertEqual(list(graph), ["1", "2"])
        self.assertEqual(graph["1"]["inputs"], {
            "model": ["checkpoint-b", 0],
            "clip": ["checkpoint-b", 1],
            "lora_name": "style/first.safetensors",
            "strength_model": 0.7,
            "strength_clip": 0.8,
        })
        self.assertEqual(graph["2"]["inputs"]["model"], ["1", 0])
        self.assertEqual(graph["2"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(graph["2"]["inputs"]["lora_name"], "style/second.safetensors")
        self.assertEqual(expanded["result"][5:], (["2", 0], ["2", 1], ["vae-b", 0]))

    def test_lora_before_model_is_applied_after_the_final_model(self):
        plan = self.nodes.SceneApplyLora().apply_lora("style/example.safetensors")[0]
        plan = self.nodes.SceneApplyModel().apply_model(
            ["checkpoint", 0], ["checkpoint", 1], ["checkpoint", 2], plan,
        )[0]
        expanded = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, scene_prompt=plan,
        )
        self.assertEqual(expanded["expand"]["1"]["inputs"]["model"], ["checkpoint", 0])
        self.assertEqual(expanded["result"][7], ["checkpoint", 2])

    def test_apply_model_requires_three_raw_links(self):
        inputs = self.nodes.SceneApplyModel.INPUT_TYPES()["required"]
        for name in ("model", "clip", "vae"):
            self.assertTrue(inputs[name][1]["rawLink"])
            self.assertTrue(inputs[name][1]["lazy"])
        with self.assertRaisesRegex(ValueError, "すべて接続"):
            self.nodes.SceneApplyModel().apply_model(["checkpoint", 0], None, ["checkpoint", 2])

    def test_empty_latent_then_scene_prompt_keeps_one_row(self):
        latent = self.nodes.SceneEmptyLatent().apply_latent(width=832, height=1216, batch_size=1)[0]
        result = self.prompt.ScenePrompt().build(
            "A", "alpha", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True, latent,
        )[0]
        self.assertEqual(result["total_batches"], 1)
        self.assertEqual(result["rows"][0]["row"]["latent"]["width"], 832)

    def test_scene_prompt_and_expand_can_start_without_an_input_plan(self):
        plan = self.prompt.ScenePrompt().build(
            "A", "alpha", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True,
        )[0]
        self.assertEqual(plan["total_batches"], 1)
        result = self.nodes.ScenePromptExpand().expand(current_index=0, timestamp_dir=False, scene_prompt=plan)
        self.assertEqual(result[0], "alpha")

    def test_expand_conversion_options_are_independent_and_do_not_mutate_the_plan(self):
        plan = self.prompt.ScenePrompt().build(
            "A", "blue_hair, score_7", '{"version":1,"categories":{}}', "bad_hands", '{"version":1,"categories":{}}', "", 0, True,
        )[0]
        expander = self.nodes.ScenePromptExpand()

        expected = {
            (False, False): ("blue_hair, score_7", "bad_hands"),
            (True, False): ("blue hair, score 7", "bad hands"),
            (False, True): ("blue_hair, score_7", "bad_hands"),
            (True, True): ("blue hair, score 7", "bad hands"),
        }
        for flags, prompts in expected.items():
            with self.subTest(flags=flags):
                expanded = expander.expand(
                    current_index=0, seed_base=7, timestamp_dir=False, scene_prompt=plan,
                    replace_underscores=flags[0], convert_anima_weights=flags[1],
                )
                self.assertEqual(expanded[:2], prompts)
                self.assertEqual(expanded[2]["positive"], expanded[0])
                self.assertEqual(expanded[2]["negative"], expanded[1])

        weighted = self.prompt.ScenePrompt().build(
            "W", "(one:1), (one_one:1.1), (blue_hair:1.4), (one_five:1.5), ((eyes:1.2):0.8), (already:2), (three:3), (four:4), (negative:-1.2), (low:0.8), version 2.0",
            '{"version":1,"categories":{}}', "(bad_hands:1.2), (bad_keep:3)", '{"version":1,"categories":{}}', "", 0, True,
        )[0]
        expected_weighted = {
            (False, False): "(one:1), (one_one:1.1), (blue_hair:1.4), (one_five:1.5), ((eyes:1.2):0.8), (already:2), (three:3), (four:4), (negative:-1.2), (low:0.8), version 2.0",
            (True, False): "(one:1), (one one:1.1), (blue hair:1.4), (one five:1.5), ((eyes:1.2):0.8), (already:2), (three:3), (four:4), (negative:-1.2), (low:0.8), version 2.0",
            (False, True): "(one:1), (one_one:1.5), (blue_hair:3), (one_five:3), ((eyes:2):0.8), (already:2), (three:3), (four:4), (negative:-1.2), (low:0.8), version 2.0",
            (True, True): "(one:1), (one one:1.5), (blue hair:3), (one five:3), ((eyes:2):0.8), (already:2), (three:3), (four:4), (negative:-1.2), (low:0.8), version 2.0",
        }
        for flags, positive in expected_weighted.items():
            with self.subTest(weighted_flags=flags):
                expanded = expander.expand(
                    current_index=0, seed_base=7, timestamp_dir=False, scene_prompt=weighted,
                    replace_underscores=flags[0], convert_anima_weights=flags[1],
                )
                self.assertEqual(expanded[0], positive)
                expected_negative = "(bad_hands:2), (bad_keep:3)" if flags[1] else "(bad_hands:1.2), (bad_keep:3)"
                self.assertEqual(expanded[1], expected_negative.replace("_", " ") if flags[0] else expected_negative)

        self.assertEqual(plan["rows"][0]["row"]["positive_parts"], ["blue_hair", "score_7"])
        self.assertEqual(plan["rows"][0]["row"]["negative_parts"], ["bad_hands"])

    def test_expand_conversion_options_are_optional_widgets_and_change_cache_key(self):
        input_types = self.nodes.ScenePromptExpand.INPUT_TYPES()
        self.assertEqual(input_types["optional"]["replace_underscores"][0], "BOOLEAN")
        self.assertFalse(input_types["optional"]["replace_underscores"][1]["default"])
        self.assertEqual(input_types["optional"]["convert_anima_weights"][0], "BOOLEAN")
        self.assertFalse(input_types["optional"]["convert_anima_weights"][1]["default"])
        self.assertNotIn("model_mode", input_types["optional"])
        plan = self.prompt.ScenePrompt().build(
            "A", "blue_hair", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True,
        )[0]
        self.assertNotEqual(
            self.nodes.ScenePromptExpand.IS_CHANGED(scene_prompt=plan, replace_underscores=False, convert_anima_weights=False),
            self.nodes.ScenePromptExpand.IS_CHANGED(scene_prompt=plan, replace_underscores=True, convert_anima_weights=False),
        )
        cache_keys = {
            self.nodes.ScenePromptExpand.IS_CHANGED(
                scene_prompt=plan, replace_underscores=replace_underscores,
                convert_anima_weights=convert_anima_weights,
            )
            for replace_underscores, convert_anima_weights in ((False, False), (True, False), (False, True), (True, True))
        }
        self.assertEqual(len(cache_keys), 4)

        legacy_anima = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, scene_prompt=plan, model_mode="Anima",
        )
        explicit_off = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, scene_prompt=plan, model_mode="Anima",
            replace_underscores=False, convert_anima_weights=False,
        )
        legacy_prompt_input = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, scene_prompt=plan, unique_id="expand",
            prompt={"expand": {"inputs": {"model_mode": "Anima"}}},
        )
        self.assertEqual(legacy_anima[0], "blue hair")
        self.assertEqual(explicit_off[0], "blue_hair")
        self.assertEqual(legacy_prompt_input[0], "blue hair")

    def test_expand_conversion_options_transform_matrix_parts_without_mutating_the_plan(self):
        source = self.prompt.ScenePrompt().build(
            "Source", "source_hair", '{"version":1,"categories":{}}', "source_hands", '{"version":1,"categories":{}}', "", 0, True,
        )[0]
        matrix = self.nodes.SceneMatrix().build(json.dumps({
            "version": 1,
            "sets": [{
                "row_id": "matrix-row",
                "name": "Matrix",
                "path_label": "Matrix",
                "positive_parts": ["matrix_hair"],
                "negative_parts": ["matrix_hands"],
            }],
        }), scene_prompt=source)[0]

        expanded = self.nodes.ScenePromptExpand().expand(
            current_index=0,
            seed_base=7,
            timestamp_dir=False,
            scene_prompt=matrix,
            replace_underscores=True,
        )

        self.assertEqual(expanded[0], "source hair, matrix hair")
        self.assertEqual(expanded[1], "source hands, matrix hands")
        self.assertEqual(expanded[2]["positive"], expanded[0])
        self.assertEqual(expanded[2]["negative"], expanded[1])
        self.assertEqual(matrix["rows"][0]["row"]["positive_parts"], ["source_hair", "matrix_hair"])
        self.assertEqual(matrix["rows"][0]["row"]["negative_parts"], ["source_hands", "matrix_hands"])

    def test_randomize_false_choices_expand_with_consecutive_seeds(self):
        plan = self.prompt.ScenePrompt().build(
            "A", "{A|B}", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, False,
        )[0]
        plan = self.nodes.ScenePromptCounter().count(plan, 2)[0]

        first = self.nodes.ScenePromptExpand().expand(
            current_index=0, seed_base=4, timestamp_dir=False, scene_prompt=plan,
        )
        second = self.nodes.ScenePromptExpand().expand(
            current_index=1, seed_base=4, timestamp_dir=False, scene_prompt=plan,
        )

        self.assertEqual(plan["rows"][0]["row"]["positive_parts"], ["{A|B}"])
        self.assertEqual((first[0], second[0]), ("B", "A"))

    def test_filename_parts_follow_prompt_matrix_merge_and_queue_order(self):
        prompt = self.prompt.ScenePrompt()
        first = prompt.build(
            "A", "", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True,
            filename_enabled=True,
        )[0]
        matrix = self.nodes.SceneMatrix().build(json.dumps({
            "version": 1,
            "sets": [
                {"row_id": "b", "name": "B", "path_label": "B", "filename_enabled": True},
                {"row_id": "c", "name": "C", "path_label": "C", "filename_enabled": True},
            ],
        }), scene_prompt=first)[0]
        right = prompt.build(
            "D", "", '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True,
            filename_enabled=True,
        )[0]
        merged = self.nodes.ScenePromptMerge().merge(matrix, right)[0]
        queued = self.nodes.ScenePromptQueue().queue(scene_prompt1=merged, scene_prompt2=first)[0]

        self.assertEqual(
            [item["row"]["filename_parts"] for item in queued["rows"]],
            [["A", "B", "D"], ["A", "C", "D"], ["A"]],
        )
        first_info = self.nodes.ScenePromptExpand().expand(
            current_index=0, timestamp_dir=False, prefix="_base", scene_prompt=queued,
        )[2]
        second_info = self.nodes.ScenePromptExpand().expand(
            current_index=1, timestamp_dir=False, prefix="_base", scene_prompt=queued,
        )[2]
        self.assertEqual(first_info["filename_prefix"], "ABD_base")
        self.assertEqual(second_info["filename_prefix"], "ACD_base")

    def test_optional_inputs_do_not_raise_in_is_changed(self):
        self.nodes.SceneMatrix.IS_CHANGED('{"version":1,"sets":[]}')
        self.nodes.ScenePath.IS_CHANGED("folder", unexpected_input=True)
        self.nodes.ScenePromptQueue.IS_CHANGED()
        self.nodes.ScenePromptMerge.IS_CHANGED()
        self.nodes.ScenePromptCounter.IS_CHANGED()
        self.nodes.SceneEmptyLatent.IS_CHANGED()
        self.nodes.ScenePromptExpand.IS_CHANGED()

    def test_two_count_nodes_multiply(self):
        first = self.nodes.ScenePromptCounter().count(count=10)[0]
        second = self.nodes.ScenePromptCounter().count(first, 2)[0]
        self.assertEqual(second["total_batches"], 20)

    def test_counter_rejects_non_integer_or_out_of_range_counts(self):
        counter = self.nodes.ScenePromptCounter()
        for invalid in ("2", True, -1, self.nodes.MAX_SAFE_INTEGER + 1):
            with self.subTest(invalid=invalid):
                with self.assertRaises(self.nodes.ScenePlanError):
                    counter.count(count=invalid)
                with self.assertRaises(self.nodes.ScenePlanError):
                    counter.IS_CHANGED(count=invalid)
        self.assertEqual(counter.count(count=1_000_000_001)[0]["total_batches"], 1_000_000_001)

    def test_expand_uses_batches_but_reports_final_image_count(self):
        plan = self.nodes.SceneEmptyLatent().apply_latent(width=512, height=512, batch_size=3)[0]
        plan = self.nodes.ScenePromptCounter().count(plan, 2)[0]
        self.assertEqual(plan["total_batches"], 2)
        self.assertEqual(plan["total_images"], 6)
        output = self.nodes.ScenePromptExpand().expand(current_index=1, timestamp_dir=False, scene_prompt=plan)
        self.assertEqual(output[4]["samples"].shape[0], 3)
        with self.assertRaisesRegex(IndexError, "生成番号 2 は生成計画の範囲外"):
            self.nodes.ScenePromptExpand().expand(current_index=2, timestamp_dir=False, scene_prompt=plan)

    def test_expand_distinguishes_an_empty_plan_from_a_stale_index(self):
        empty = self.nodes.SceneMatrix().build(json.dumps({
            "version": 1,
            "sets": [{
                "row_id": "disabled",
                "name": "Disabled",
                "path_label": "Disabled",
                "enabled": False,
            }],
        }))[0]
        with self.assertRaisesRegex(IndexError, "生成計画に生成対象がありません"):
            self.nodes.ScenePromptExpand().expand(current_index=0, timestamp_dir=False, scene_prompt=empty)

    def test_nested_maximum_counts_keep_the_exact_derived_total(self):
        first = self.nodes.ScenePromptCounter().count(count=10_000)[0]
        plan = self.nodes.ScenePromptCounter().count(first, 10_000)[0]
        self.assertEqual(plan["total_batches"], 100_000_000)
        self.assertEqual(plan["total_images"], 100_000_000)
        expanded = self.nodes.ScenePromptExpand().expand(
            current_index=99_999_999,
            timestamp_dir=False,
            scene_prompt=plan,
        )
        self.assertEqual(expanded[2]["repeat_count"], 100_000_000)
        self.assertEqual(expanded[2]["total_count"], 100_000_000)

    def test_javascript_safe_totals_are_preserved_in_expand_metadata(self):
        plan = self.nodes.SceneEmptyLatent().apply_latent(
            width=16,
            height=16,
            batch_size=1,
        )[0]
        counter = self.nodes.ScenePromptCounter()
        plan = counter.count(plan, self.nodes.MAX_SAFE_INTEGER)[0]
        self.assertEqual(plan["total_batches"], self.nodes.MAX_SAFE_INTEGER)
        self.assertEqual(plan["total_images"], self.nodes.MAX_SAFE_INTEGER)

        original_empty_latent = self.nodes._empty_latent
        self.nodes._empty_latent = lambda _config: {"samples": None}
        try:
            info = self.nodes.ScenePromptExpand().expand(
                current_index=0,
                timestamp_dir=False,
                scene_prompt=plan,
            )[2]
        finally:
            self.nodes._empty_latent = original_empty_latent

        self.assertEqual(info["repeat_count"], self.nodes.MAX_SAFE_INTEGER)
        self.assertEqual(info["total_count"], self.nodes.MAX_SAFE_INTEGER)
        with self.assertRaises(self.nodes.ScenePlanError):
            self.nodes._normalize_scene_save_info({"total_count": self.nodes.MAX_SAFE_INTEGER + 1})


if __name__ == "__main__":
    unittest.main()
