import importlib
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_scene_prompt_reverse import add_prompt, load_modules
from test_prompt_choices import selection_item


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
                                                                 seed_base_literal=True), ("base, one, two", "bad"))
        self.assertNotEqual(node.IS_CHANGED("lora", positive="one"), node.IS_CHANGED("lora", positive="two"))
        legacy = node.apply_lora("lora", scene_prompt=plan)[0]
        self.assertEqual(legacy["rows"][0]["row"]["loras"][0]["positive_parts"], [])
        self.assertEqual(self.expand(legacy)[:2], ("base", ""))
        self.assertEqual(self.plan.normalize_plan(json.loads(json.dumps(changed)))["rows"][0]["row"]["loras"][0]["positive_parts"], ["one", "two"])

    def test_selected_candidates_follow_model_and_existing_text(self):
        selected = lambda category, prompt: json.dumps({"version": 1, "categories": {
            category: [selection_item(prompt, category_key=category, category_label=category,
                                      category_path=[category])],
        }})
        plan = add_prompt(self.prompt, "base", "base", "", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora(
            "anima", scene_prompt=plan, model_mode="Anima", positive="typed", negative="typed-negative",
            positive_json=selected("Positive", "chosen"), negative_json=selected("Negative", "blocked"),
            category_order="Positive,Negative",
        )[0]
        row = plan["rows"][0]["row"]
        self.assertEqual(row["loras"][0]["positive_parts"], ["typed", "chosen"])
        self.assertEqual(row["loras"][0]["negative_parts"], ["typed-negative", "blocked"])
        self.assertEqual(self.expand(plan, "Anima")[:2], ("base, typed, chosen", "typed-negative, blocked"))
        self.assertEqual(self.expand(plan, "Illustrious")[:2], ("base", ""))
        self.assertEqual(self.nodes.ScenePromptToText().to_text(plan, model_mode="Anima"),
                         ("base, typed, chosen", "typed-negative, blocked"))
        reversed_plan = self.nodes.ScenePromptReverse().reverse(plan)[0]
        self.assertEqual(self.nodes.ScenePromptToText().to_text(reversed_plan, model_mode="Anima"),
                         ("typed-negative, blocked", "base, typed, chosen"))
        deleted = self.nodes.ScenePromptDelete().delete("chosen", "blocked", plan)[0]
        self.assertEqual(self.nodes.ScenePromptToText().to_text(deleted, model_mode="Anima"),
                         ("base, typed", "typed-negative"))
        changed = self.nodes.SceneApplyLora.IS_CHANGED
        self.assertNotEqual(changed("anima", positive_json=selected("Positive", "chosen")),
                            changed("anima", positive_json=selected("Positive", "different")))
        self.assertNotEqual(changed("anima", category_order="A,B"), changed("anima", category_order="B,A"))

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

    def test_to_text_model_filter_and_delete_modify_descriptors(self):
        schema = self.nodes.ScenePromptToText.INPUT_TYPES()
        self.assertEqual(list(schema["optional"]), [
            "scene_prompt", "current_index", "seed_base", "seed_base_literal", "model_mode",
        ])
        legacy_widgets_values = [self.nodes.TEXT_SCOPE_ALL, 2, 100, False]
        widget_names = ["scope", *[name for name in schema["optional"] if name != "scene_prompt"]]
        self.assertEqual(dict(zip(widget_names, legacy_widgets_values)), {
            "scope": self.nodes.TEXT_SCOPE_ALL, "current_index": 2,
            "seed_base": 100, "seed_base_literal": False,
        })
        self.assertEqual(schema["optional"]["model_mode"][1]["default"], "Illustrious")
        plan = add_prompt(self.prompt, "base", "base", "base-negative", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora("ill", scene_prompt=plan, positive="ill-text", negative="ill-negative")[0]
        plan = self.nodes.SceneApplyLora().apply_lora("anima", scene_prompt=plan, model_mode="Anima",
                                                      positive="anima-text", negative="anima-negative")[0]
        text = self.nodes.ScenePromptToText()
        self.assertEqual(text.to_text(plan), ("base, ill-text", "base-negative, ill-negative"))
        self.assertEqual(text.to_text(plan, model_mode="Anima"), ("base, anima-text", "base-negative, anima-negative"))
        self.assertEqual(text.to_text(plan, scope=self.nodes.TEXT_SCOPE_PREVIOUS), ("", ""))
        self.assertEqual(text.to_text(plan, scope=self.nodes.TEXT_SCOPE_PREVIOUS, model_mode="Anima"),
                         ("anima-text", "anima-negative"))
        self.assertNotEqual(text.IS_CHANGED(plan, model_mode="Anima"), text.IS_CHANGED(plan))
        deleted = self.nodes.ScenePromptDelete().delete(
            "base, ill-text, anima-text", "ill-negative, anima-negative", plan,
        )[0]
        self.assertEqual(text.to_text(deleted), ("", "base-negative"))
        self.assertEqual(text.to_text(deleted, model_mode="Anima"), ("", "base-negative"))
        self.assertEqual(deleted["rows"][0]["row"]["loras"][0]["positive_parts"], [])
        self.assertEqual(deleted["rows"][0]["row"]["loras"][1]["negative_parts"], [])

    def test_reverse_all_and_previous_keep_model_filter_and_chain(self):
        plan = add_prompt(self.prompt, "base", "base-pos", "base-neg", node_id="1")
        plan = self.nodes.SceneApplyLora().apply_lora("ill", scene_prompt=plan,
                                                      positive="ill-pos", negative="ill-neg")[0]
        plan = self.nodes.SceneApplyLora().apply_lora("anima", scene_prompt=plan, model_mode="Anima",
                                                      positive="anima-pos", negative="anima-neg")[0]
        text = self.nodes.ScenePromptToText()
        reverse = self.nodes.ScenePromptReverse()
        previous = reverse.reverse(plan, self.nodes.REVERSE_SCOPE_PREVIOUS)[0]
        self.assertEqual(text.to_text(previous), ("base-pos, ill-pos", "base-neg, ill-neg"))
        self.assertEqual(text.to_text(previous, model_mode="Anima"), ("base-pos, anima-neg", "base-neg, anima-pos"))
        self.assertEqual(text.to_text(previous, scope=self.nodes.TEXT_SCOPE_PREVIOUS, model_mode="Anima"),
                         ("anima-neg", "anima-pos"))
        self.assertEqual(text.to_text(previous, scope=self.nodes.TEXT_SCOPE_PREVIOUS), ("", ""))
        self.assertEqual(previous["rows"][0]["row"]["prompt_trace"]["lora_index"], 1)
        again = reverse.reverse(previous, self.nodes.REVERSE_SCOPE_PREVIOUS)[0]
        self.assertEqual(text.to_text(again, model_mode="Anima"), text.to_text(plan, model_mode="Anima"))
        all_reversed = reverse.reverse(plan)[0]
        self.assertEqual(text.to_text(all_reversed), ("base-neg, ill-neg", "base-pos, ill-pos"))
        self.assertEqual(text.to_text(all_reversed, model_mode="Anima"),
                         ("base-neg, anima-neg", "base-pos, anima-pos"))
        whole_previous = reverse.reverse(all_reversed, self.nodes.REVERSE_SCOPE_PREVIOUS)[0]
        self.assertEqual(text.to_text(whole_previous, model_mode="Anima"), text.to_text(plan, model_mode="Anima"))

    def test_callback_snapshot_stays_fixed_when_later_delete_edits_lora(self):
        plan = self.nodes.SceneApplyLora().apply_lora("ill", positive="trigger")[0]
        plan = self.plan.append_callback(plan, "cb", {"type": "dummy"}, "every", 1, "continue")
        deleted = self.nodes.ScenePromptDelete().delete("trigger", "", plan)[0]
        row = deleted["rows"][0]["row"]
        self.assertEqual(row["loras"][0]["positive_parts"], [])
        self.assertEqual(row["callbacks"][0]["current_loras"][0]["positive_parts"], ["trigger"])
        calls = []
        with patch.object(self.nodes, "dispatch_callback", side_effect=lambda config, values, timeout, **kw: calls.append(values)):
            self.nodes._dispatch_row_callbacks(row, {"global_index": 0, "total_batches": 1}, 7,
                                               "Illustrious", "", "", "")
        self.assertEqual(calls[0]["current_positive"], "trigger")
        self.assertEqual(calls[0]["all_positive"], "")

    def test_trace_lora_index_is_strict(self):
        plan = self.nodes.SceneApplyLora().apply_lora("ill", positive="trigger")[0]
        for invalid in (-1, True, "0", 1):
            broken = json.loads(json.dumps(plan))
            broken["rows"][0]["row"]["prompt_trace"]["lora_index"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(self.plan.ScenePlanError):
                self.plan.normalize_plan(broken)

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
    def test_catalog_reads_local_titles_without_hashing_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            titled = root / "titled.safetensors"
            malformed = root / "malformed.safetensors"
            output_only = root / "output.safetensors"
            header = json.dumps({"__metadata__": {"modelspec.title": "Display Title",
                                                  "ss_output_name": "Secondary"}}).encode()
            titled.write_bytes(struct.pack("<Q", len(header)) + header + b"weights")
            header = json.dumps({"__metadata__": {"ss_output_name": "Output Name"}}).encode()
            output_only.write_bytes(struct.pack("<Q", len(header)) + header + b"weights")
            malformed.write_bytes(b"invalid")
            from comfy_stubs import install_torch_stub
            install_torch_stub()
            import types
            folder_paths = types.ModuleType("folder_paths")
            sys.modules["folder_paths"] = folder_paths
            folder_paths.get_filename_list = lambda category: [
                "folder/titled.safetensors", "output.safetensors", "malformed.safetensors", "missing.safetensors",
            ]
            folder_paths.get_full_path = lambda category, name: str(root / name.split("/")[-1])
            package_name = "scene_lora_catalog_test"
            package = type(sys)(package_name)
            package.__path__ = [str(Path(__file__).resolve().parents[1] / "scene_prompt_tools")]
            sys.modules[package_name] = package
            metadata = importlib.import_module(f"{package_name}.lora_metadata")
            with patch.object(metadata.hashlib, "sha256", side_effect=AssertionError("catalog hashed a model")):
                catalog = metadata.list_loras()
                self.assertEqual(metadata.list_loras(), catalog)
            self.assertEqual([(item["path"], item["title"], item["source"]) for item in catalog], [
                ("folder/titled.safetensors", "Display Title", "local"),
                ("output.safetensors", "Output Name", "local"),
                ("malformed.safetensors", "malformed", "filename"),
                ("missing.safetensors", "missing", "filename"),
            ])
            self.assertEqual(catalog[0]["size"], titled.stat().st_size)
            self.assertEqual(catalog[0]["mtime_ns"], titled.stat().st_mtime_ns)
            self.assertIsNone(catalog[-1]["size"])

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
            self.assertEqual((info["size"], info["mtime_ns"]), (path.stat().st_size, path.stat().st_mtime_ns))
            self.assertEqual(metadata.read_lora_info(path.name), info)
            with self.assertRaises(ValueError):
                metadata.read_lora_info("missing.safetensors")


if __name__ == "__main__":
    unittest.main()
