import importlib
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_scene_prompt_reverse import add_prompt, load_modules


class SceneLoraPromptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        modules = load_modules(self.root)
        sys.modules["folder_paths"].get_filename_list = lambda category: ["lora"]
        self.plan = modules["plan"]
        self.prompt = modules["prompt"]
        self.nodes = modules["nodes"]

    def tearDown(self):
        self.temp.cleanup()

    def expand(self, plan, mode="Illustrious", seed=7):
        return self.nodes.ScenePromptExpand().expand(scene_prompt=plan, model_mode=mode,
                                                     seed_base=seed, seed_base_literal=True,
                                                     timestamp_dir=False)

    def test_matching_modes_and_path_order_include_text_and_model(self):
        plan = add_prompt(self.prompt, "base", "base", "", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora("a", scene_prompt=plan, positive="first", negative="bad", source_node_id="2")[0]
        plan = self.nodes.SceneApplyLora().apply_lora("skip", scene_prompt=plan, model_mode="Anima", positive="wrong", negative="base", source_node_id="3")[0]
        plan = self.nodes.SceneApplyLora().apply_lora("b", scene_prompt=plan, positive="second", negative="first", source_node_id="4")[0]
        plan = self.nodes.SceneApplyModel().apply_model(["model", 0], ["clip", 0], ["vae", 0], plan)[0]
        result = self.expand(plan)
        self.assertEqual(result["result"][:2], ("base, second", "bad, first"))
        self.assertEqual([node["inputs"]["lora_name"] for node in result["expand"].values()], ["a", "b"])
        self.assertEqual(self.expand(plan, "Anima")["result"][:2], ("wrong", "base"))

    def test_previous_to_text_and_legacy_defaults(self):
        plan = add_prompt(self.prompt, "base", "base", "", node_id="1")
        node = self.nodes.SceneApplyLora()
        self.assertEqual(node.INPUT_TYPES()["optional"]["positive"][1]["default"], "")
        self.assertEqual(node.INPUT_TYPES()["optional"]["negative"][1]["default"], "")
        changed = node.apply_lora("lora", scene_prompt=plan, positive="one, two", negative="bad")[0]
        self.assertEqual(self.nodes.ScenePromptToText().to_text(changed, scope=self.nodes.TEXT_SCOPE_PREVIOUS,
                                                                 seed_base=7, seed_base_literal=True), ("one, two", "bad"))
        self.assertEqual(self.nodes.ScenePromptToText().to_text(changed, seed_base=7,
                                                                 seed_base_literal=True), ("base", ""))
        self.assertNotEqual(node.IS_CHANGED("lora", positive="one"), node.IS_CHANGED("lora", positive="two"))
        legacy = node.apply_lora("lora", scene_prompt=plan)[0]
        self.assertEqual(legacy["rows"][0]["row"]["loras"][0]["positive_parts"], [])
        self.assertEqual(self.expand(legacy)[:2], ("base", ""))
        self.assertEqual(self.plan.normalize_plan(json.loads(json.dumps(changed)))["rows"][0]["row"]["loras"][0]["positive_parts"], ["one", "two"])

    def test_callback_snapshot_sees_only_prior_matching_lora_text(self):
        plan = add_prompt(self.prompt, "base", "base", "", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora("a", scene_prompt=plan, positive="first")[0]
        plan = self.plan.append_callback(plan, "cb", {"type": "dummy"}, "every", 1, "continue")
        plan = self.nodes.SceneApplyLora().apply_lora("b", scene_prompt=plan, positive="later")[0]
        plan = self.nodes.SceneApplyLora().apply_lora("skip", scene_prompt=plan, model_mode="Anima", positive="wrong")[0]
        row = self.plan.normalize_plan(json.loads(json.dumps(plan)))["rows"][0]["row"]
        calls = []
        with patch.object(self.nodes, "dispatch_callback", side_effect=lambda config, values, timeout, **kw: calls.append(values)):
            self.nodes._dispatch_row_callbacks(row, {"global_index": 0, "total_batches": 1}, 7,
                                               "Illustrious", "", "base, first, later", "")
        self.assertEqual(calls[0]["current_positive"], "base, first")
        self.assertEqual(calls[0]["all_positive"], "base, first, later")

    def test_callback_before_lora_excludes_later_text(self):
        plan = add_prompt(self.prompt, "base", "base", "", node_id="1")
        plan = self.plan.append_callback(plan, "before", {"type": "dummy"}, "every", 1, "continue")
        plan = self.nodes.SceneApplyLora().apply_lora("later", scene_prompt=plan, positive="later")[0]
        row = plan["rows"][0]["row"]
        calls = []
        with patch.object(self.nodes, "dispatch_callback", side_effect=lambda config, values, timeout, **kw: calls.append(values)):
            self.nodes._dispatch_row_callbacks(row, {"global_index": 0, "total_batches": 1}, 7,
                                               "Illustrious", "", "base, later", "")
        self.assertEqual(calls[0]["current_positive"], "base")

    def test_negative_choice_blocks_matching_positive_after_expansion(self):
        plan = add_prompt(self.prompt, "base", "red, blue", "", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora("lora", scene_prompt=plan,
                                                      positive="{red|green}", negative="red")[0]
        for seed in range(10):
            positive, negative = self.expand(plan, seed=seed)[:2]
            self.assertNotIn("red", positive)
            self.assertIn("red", negative)

    def test_duplicate_choices_merge_before_expansion_and_negative_weight_wins(self):
        plan = add_prompt(self.prompt, "base", "{red|blue}, blocked", "weak", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora(
            "lora", scene_prompt=plan, positive="{red|blue}", negative="blocked, (weak:1.2)",
        )[0]
        row = plan["rows"][0]["row"]
        for seed in range(20):
            expected_choice = self.prompt._expand_prompt_parts(["{red|blue}"], seed, "positive")[0]
            positive, negative = self.expand(plan, seed=seed)[:2]
            self.assertEqual((positive, negative), (expected_choice, "(weak:1.2), blocked"))
            self.assertEqual(
                self.nodes._callback_prompts(row["positive_parts"], row["negative_parts"], seed,
                                             "Illustrious", loras=row["loras"]),
                (expected_choice, "(weak:1.2), blocked"),
            )


class LoraMetadataTests(unittest.TestCase):
    def test_header_only_metadata_and_cached_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "test.safetensors"
            header = json.dumps({"__metadata__": {"modelspec.trigger_phrase": "local trigger",
                                                  "civitai.trainedWords": '["trained word"]'}}).encode()
            path.write_bytes(struct.pack("<Q", len(header)) + header + b"weights")
            from comfy_stubs import install_torch_stub
            install_torch_stub()
            import types
            folder_paths = types.ModuleType("folder_paths")
            sys.modules["folder_paths"] = folder_paths
            folder_paths.get_filename_list = lambda category: [path.name]
            folder_paths.get_full_path = lambda category, name: str(path)
            package_name = "scene_lora_metadata_test"
            package = type(sys)(package_name)
            package.__path__ = [str(Path(__file__).resolve().parents[1] / "scene_prompt_tools")]
            sys.modules[package_name] = package
            metadata = importlib.import_module(f"{package_name}.lora_metadata")
            info = metadata.read_lora_info(path.name)
            self.assertEqual(info["trigger_phrases"], ["local trigger", "trained word"])
            self.assertEqual(len(info["sha256"]), 64)
            self.assertEqual(metadata.read_lora_info(path.name), info)
            with self.assertRaises(ValueError):
                metadata.read_lora_info("missing.safetensors")


if __name__ == "__main__":
    unittest.main()
