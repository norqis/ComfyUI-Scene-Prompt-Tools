import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()
ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"
EMPTY = '{"version":1,"categories":{}}'


def load_modules(root):
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
    package_name = "scene_reverse_test"
    for name in list(sys.modules):
        if name == package_name or name.startswith(f"{package_name}."):
            del sys.modules[name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return {
        name: importlib.import_module(f"{package_name}.{name}")
        for name in ("plan", "prompt", "nodes", "presets")
    }


def add_prompt(prompt_module, name, positive, negative, upstream=None, node_id=None):
    return prompt_module.ScenePrompt().build(
        prompt_name=name,
        positive_base=positive,
        positive_json=EMPTY,
        negative_base=negative,
        negative_json=EMPTY,
        category_order="",
        seed=0,
        randomize=True,
        scene_prompt=upstream,
        source_node_id=node_id or name,
        source_node_name=name,
    )[0]


class ScenePromptReverseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.modules = load_modules(Path(self.temp.name))
        self.plan = self.modules["plan"]
        self.prompt = self.modules["prompt"]
        self.nodes = self.modules["nodes"]
        self.presets = self.modules["presets"]

    def tearDown(self):
        self.temp.cleanup()

    def row(self, plan):
        return self.plan.normalize_plan(plan)["rows"][0]["row"]

    def test_node_contract_and_preset_support(self):
        inputs = self.nodes.ScenePromptReverse.INPUT_TYPES()
        self.assertIn("scene_prompt", inputs["required"])
        scope_values, scope_options = inputs["required"]["reverse_scope"]
        self.assertEqual(scope_values, ["全てのノード", "直前のノード"])
        self.assertEqual(scope_options["default"], "全てのノード")
        self.assertIs(self.presets.SAFE_NODE_CLASSES["ScenePromptReverse"], self.nodes.ScenePromptReverse)

    def test_reverse_all_swaps_complete_prompt_without_changing_plan_shape(self):
        first = add_prompt(self.prompt, "A", "a_pos", "a_neg", node_id="1")
        second = add_prompt(self.prompt, "B", "b_pos", "b_neg", first, node_id="2")
        latent = self.nodes.SceneEmptyLatent().apply_latent(second, 832, 1216, 2, source_node_id="3")[0]
        counted = self.nodes.ScenePromptCounter().count(latent, 3, source_node_id="4")[0]

        reversed_plan = self.nodes.ScenePromptReverse().reverse(
            counted, "全てのノード", source_node_id="5", source_node_name="Reverse"
        )[0]
        source = self.plan.normalize_plan(counted)
        result = self.plan.normalize_plan(reversed_plan)
        row = result["rows"][0]["row"]

        self.assertEqual(row["positive_parts"], ["a_neg", "b_neg"])
        self.assertEqual(row["negative_parts"], ["a_pos", "b_pos"])
        self.assertEqual(result["total_batches"], source["total_batches"])
        self.assertEqual(result["total_images"], source["total_images"])
        self.assertEqual(row["latent"], source["rows"][0]["row"]["latent"])
        self.assertIn("5", row["source_node_ids"])

    def test_reverse_previous_only_swaps_immediate_prompt_additions(self):
        first = add_prompt(self.prompt, "A", "a_pos", "a_neg", node_id="1")
        second = add_prompt(self.prompt, "B", "b_pos", "b_neg", first, node_id="2")
        result = self.nodes.ScenePromptReverse().reverse(
            second, "直前のノード", source_node_id="3"
        )[0]
        row = self.row(result)

        self.assertEqual(row["positive_parts"], ["a_pos", "b_neg"])
        self.assertEqual(row["negative_parts"], ["a_neg", "b_pos"])

    def test_reverse_previous_after_non_prompt_node_is_noop(self):
        first = add_prompt(self.prompt, "A", "a_pos", "a_neg", node_id="1")
        second = add_prompt(self.prompt, "B", "b_pos", "b_neg", first, node_id="2")
        counted = self.nodes.ScenePromptCounter().count(second, 2, source_node_id="3")[0]
        result = self.nodes.ScenePromptReverse().reverse(
            counted, "直前のノード", source_node_id="4"
        )[0]

        self.assertEqual(self.row(result)["positive_parts"], self.row(counted)["positive_parts"])
        self.assertEqual(self.row(result)["negative_parts"], self.row(counted)["negative_parts"])
        self.assertEqual(self.plan.normalize_plan(result)["total_batches"], 2)

    def test_reverse_previous_preserves_baseline_when_previous_negative_overrode_it(self):
        first = add_prompt(self.prompt, "A", "shared, keep_pos", "keep_neg", node_id="1")
        second = add_prompt(self.prompt, "B", "b_pos", "shared", first, node_id="2")
        result = self.nodes.ScenePromptReverse().reverse(second, "直前のノード", source_node_id="3")[0]
        row = self.row(result)

        self.assertIn("shared", row["positive_parts"])
        self.assertIn("keep_pos", row["positive_parts"])
        self.assertIn("b_pos", row["negative_parts"])
        self.assertIn("keep_neg", row["negative_parts"])
        self.assertNotIn("shared", row["negative_parts"])

    def test_merge_and_queue_can_be_reversed_as_immediate_structural_output(self):
        left = add_prompt(self.prompt, "A", "left_pos", "left_neg", node_id="1")
        right = add_prompt(self.prompt, "B", "right_pos", "right_neg", node_id="2")
        merged = self.nodes.ScenePromptMerge().merge(left, right, source_node_id="3")[0]
        queued = self.nodes.ScenePromptQueue().queue(scene_prompt1=left, scene_prompt2=right, source_node_id="4")[0]

        merged_reversed = self.nodes.ScenePromptReverse().reverse(merged, "直前のノード", source_node_id="5")[0]
        self.assertEqual(self.row(merged_reversed)["positive_parts"], ["left_neg", "right_neg"])
        self.assertEqual(self.row(merged_reversed)["negative_parts"], ["left_pos", "right_pos"])

        queued_reversed = self.nodes.ScenePromptReverse().reverse(queued, "直前のノード", source_node_id="6")[0]
        rows = self.plan.normalize_plan(queued_reversed)["rows"]
        self.assertEqual(rows[0]["row"]["positive_parts"], ["left_neg"])
        self.assertEqual(rows[0]["row"]["negative_parts"], ["left_pos"])
        self.assertEqual(rows[1]["row"]["positive_parts"], ["right_neg"])
        self.assertEqual(rows[1]["row"]["negative_parts"], ["right_pos"])

    def test_previous_structural_reverse_matches_full_reverse_with_weighted_conflicts(self):
        left = add_prompt(self.prompt, "A", "(shared:1.2)", "", node_id="1")
        right = add_prompt(self.prompt, "B", "", "shared", node_id="2")
        merged = self.nodes.ScenePromptMerge().merge(left, right, source_node_id="3")[0]

        reverse_all = self.nodes.ScenePromptReverse().reverse(
            merged, "全てのノード", source_node_id="4"
        )[0]
        reverse_previous = self.nodes.ScenePromptReverse().reverse(
            merged, "直前のノード", source_node_id="5"
        )[0]

        self.assertEqual(
            self.row(reverse_previous)["positive_parts"],
            self.row(reverse_all)["positive_parts"],
        )
        self.assertEqual(
            self.row(reverse_previous)["negative_parts"],
            self.row(reverse_all)["negative_parts"],
        )


if __name__ == "__main__":
    unittest.main()
