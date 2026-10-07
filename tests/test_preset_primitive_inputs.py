import json
import importlib
import tempfile
import unittest
from pathlib import Path

from test_scene_presets import basic_nodes, load_presets_module


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


class PresetPrimitiveInputs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.module = load_presets_module(Path(self.temp.name))

    def save(self, nodes):
        return self.module.save_preset({"preset_id": "linked", "name": "Linked", "output_node_id": "3",
                                       "api_graph": {"output": nodes}, "workflow": {"version": 1, "nodes": []}})

    def test_all_literal_provider_types_survive_save_load_and_execute(self):
        nodes = basic_nodes()
        nodes.update({
            "10": node("PrimitiveStringMultiline", value="linked positive"),
            "11": node("PrimitiveString", value="linked negative"),
            "12": node("PrimitiveFloat", value=0.75),
            "13": node("PrimitiveInt", value=3),
            "14": node("PrimitiveBoolean", value=False),
            "15": node("PrimitiveString", value="alternate"),
            "16": node("PrimitiveString", value="multiply"),
            "4": node("SceneApplyLora", scene_prompt=["2", 0], lora_name="style/example.safetensors",
                      strength_model=["12", 0], strength_clip=["12", 0]),
            "5": node("ScenePrompterQueue", scene_prompt1=["4", 0], scene_prompt2=["2", 0],
                      order_mode=["15", 0], alternate_block_size=["13", 0], downstream_count_mode=["16", 0]),
            "6": node("ScenePromptCounter", scene_prompt=["5", 0], count=["13", 0], enable_downstream_count=["14", 0]),
            "7": node("ScenePromptCounter", scene_prompt=["6", 0], count=10),
        })
        nodes["2"]["inputs"].update(positive_base=["10", 0], negative_base=["11", 0], filename_enabled=["14", 0])
        nodes["3"]["inputs"]["scene_prompt"] = ["7", 0]
        saved = self.save(nodes)
        plan = self.module._evaluate_preset_scene(saved, {}, None)
        self.assertEqual(plan["total_batches"], 18)
        schedule = importlib.import_module(f"{self.module.__package__}.schedule")
        row = schedule.item_for_index(plan, 0)["row"]
        self.assertEqual(row["positive_parts"], ["linked positive"])
        self.assertEqual(row["negative_parts"], ["linked negative"])
        self.assertEqual(row["loras"][0]["strength_model"], 0.75)
        self.assertEqual(row["loras"][0]["strength_clip"], 0.75)
        nodes["16"]["inputs"]["value"] = "fixed"
        fixed = self.module._evaluate_preset_scene(self.save(nodes), {}, None)
        self.assertEqual(fixed["total_batches"], 6)

    def test_compact_keeps_linked_controls_but_omits_large_private_strings(self):
        nodes = basic_nodes()
        nodes.update({
            "4": node("PrimitiveStringMultiline", value="private prompt " * 100000),
            "5": node("PrimitiveString", value="alternate"),
            "6": node("PrimitiveInt", value=3),
            "7": node("ScenePrompterQueue", scene_prompt1=["2", 0], order_mode=["5", 0], alternate_block_size=["6", 0]),
            "8": node("ScenePromptLLM", scene_prompt=["7", 0], description=["4", 0]),
            "9": node("ScenePromptCallbackRequest", url=["4", 0], text=["4", 0]),
        })
        nodes["2"]["inputs"]["positive_base"] = ["4", 0]
        for description, has_input in [("private prompt " * 100000, True), ("  ", False), ("", False)]:
            nodes["4"]["inputs"]["value"] = description
            compact = self.module._compact_preset_list_graph({"output": nodes})
            self.assertLess(len(json.dumps(compact)), 3000)
            self.assertNotIn("value", compact["output"]["4"]["inputs"])
            self.assertEqual(compact["output"]["5"]["inputs"]["value"], "alternate")
            self.assertEqual(compact["output"]["6"]["inputs"]["value"], 3)
            self.assertIs(compact["output"]["8"]["has_llm_input"], has_input)

    def test_invalid_provider_type_and_chained_provider_are_rejected(self):
        nodes = basic_nodes()
        nodes["4"] = node("PrimitiveInt", value=3)
        nodes["2"]["inputs"]["positive_base"] = ["4", 0]
        with self.assertRaisesRegex(ValueError, "接続型"):
            self.save(nodes)
        nodes["4"] = node("PrimitiveString", value=["5", 0])
        nodes["5"] = node("PrimitiveString", value="text")
        with self.assertRaisesRegex(ValueError, "直接入力|接続型"):
            self.save(nodes)


if __name__ == "__main__":
    unittest.main()
