import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

from comfy_stubs import install_torch_stub


torch = install_torch_stub()


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
        self.assertEqual(matrix["total_batches"], 1)
        self.assertEqual(path["total_batches"], 1)
        self.assertEqual(count["total_batches"], 2)
        self.assertEqual(latent["total_images"], 2)
        self.assertEqual(merged["total_batches"], 1)
        self.assertEqual(queued["total_batches"], 1)

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
        for invalid in ("2", True, -1, self.nodes.MAX_INPUT_COUNT + 1):
            with self.subTest(invalid=invalid):
                with self.assertRaises(self.nodes.ScenePlanError):
                    counter.count(count=invalid)
                with self.assertRaises(self.nodes.ScenePlanError):
                    counter.IS_CHANGED(count=invalid)

    def test_expand_uses_batches_but_reports_final_image_count(self):
        plan = self.nodes.SceneEmptyLatent().apply_latent(width=512, height=512, batch_size=3)[0]
        plan = self.nodes.ScenePromptCounter().count(plan, 2)[0]
        self.assertEqual(plan["total_batches"], 2)
        self.assertEqual(plan["total_images"], 6)
        output = self.nodes.ScenePromptExpand().expand(current_index=1, timestamp_dir=False, scene_prompt=plan)
        self.assertEqual(output[4]["samples"].shape[0], 3)
        with self.assertRaises(IndexError):
            self.nodes.ScenePromptExpand().expand(current_index=2, timestamp_dir=False, scene_prompt=plan)

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

    def test_maximum_total_images_are_preserved_in_expand_metadata(self):
        plan = self.nodes.SceneEmptyLatent().apply_latent(
            width=16,
            height=16,
            batch_size=self.nodes.MAX_BATCH_SIZE,
        )[0]
        counter = self.nodes.ScenePromptCounter()
        plan = counter.count(plan, 10_000)[0]
        plan = counter.count(plan, 10_000)[0]
        plan = counter.count(plan, 10)[0]
        self.assertEqual(plan["total_batches"], self.nodes.MAX_DERIVED_COUNT)
        self.assertEqual(plan["total_images"], self.nodes.MAX_TOTAL_IMAGES)

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

        self.assertEqual(info["repeat_count"], self.nodes.MAX_DERIVED_COUNT)
        self.assertEqual(info["total_count"], self.nodes.MAX_TOTAL_IMAGES)
        with self.assertRaises(self.nodes.ScenePlanError):
            self.nodes._normalize_scene_save_info({"total_count": self.nodes.MAX_TOTAL_IMAGES + 1})


if __name__ == "__main__":
    unittest.main()
