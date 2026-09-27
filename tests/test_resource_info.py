import hashlib
import importlib
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_routes import load_routes


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


class ResourceInfoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.routes = load_routes(Path(self.temp.name))
        self.info = importlib.import_module(f"{self.routes.__package__}.resource_info")

    def tearDown(self):
        self.temp.cleanup()

    def test_connected_models_and_loras_are_deduplicated_without_unrelated_nodes(self):
        graph = {"output": {
            "1": node("ScenePrompter"),
            "2": node("SceneApplyModel", scene_prompt=["1", 0], model=["8", 0], clip=["8", 1], vae=["8", 2]),
            "3": node("SceneApplyLora", scene_prompt=["2", 0], lora_name="style.safetensors",
                      strength_model=["9", 0], strength_clip=0.7, model_mode="Anima"),
            "4": node("SceneApplyLora", scene_prompt=["3", 0], lora_name="style.safetensors",
                      strength_model=0.8, strength_clip=0.7, model_mode="Anima"),
            "5": node("ScenePrompterExpand", scene_prompt=["4", 0], model_mode="Anima"),
            "8": node("CheckpointLoaderSimple", ckpt_name="base.safetensors"),
            "9": node("PrimitiveFloat", value=0.9),
            "99": node("SceneApplyLora", lora_name="unrelated.safetensors", strength_model=2.0),
        }}
        result = self.info.connected_resources(graph, "5")
        self.assertEqual(result["models"], [{"kind": "checkpoint", "name": "base.safetensors",
                                              "roles": ["model", "clip", "vae"], "source_class": "CheckpointLoaderSimple"}])
        self.assertEqual(result["loras"], [{"name": "style.safetensors", "unresolved": False, "variants": [
            {"model_mode": "Anima", "strength_model": 0.9, "strength_clip": 0.7,
             "roles": ["model", "clip"], "applies": True},
            {"model_mode": "Anima", "strength_model": 0.8, "strength_clip": 0.7,
             "roles": ["model", "clip"], "applies": True},
        ]}])

    def test_separate_anima_files_and_standard_lora_chain(self):
        graph = {"output": {
            "1": node("ScenePrompter"),
            "2": node("SceneApplyModel", scene_prompt=["1", 0], model=["6", 0], clip=["7", 1], vae=["8", 0]),
            "3": node("ScenePrompterExpand", scene_prompt=["2", 0], model_mode="Illustrious"),
            "4": node("UNETLoader", unet_name="anima.safetensors"),
            "5": node("LoraLoader", model=["4", 0], clip=["9", 0], lora_name="first.safetensors",
                      strength_model=1.1, strength_clip=0.6),
            "6": node("LoraLoaderModelOnly", model=["5", 0], lora_name="second.safetensors", strength_model=0.5),
            "7": node("LoraLoader", model=["4", 0], clip=["9", 0], lora_name="first.safetensors",
                      strength_model=1.1, strength_clip=0.6),
            "8": node("VAELoader", vae_name="vae.safetensors"),
            "9": node("CLIPLoader", clip_name="clip.safetensors"),
        }}
        result = self.info.connected_resources(graph, "3")
        self.assertEqual({(item["kind"], item["name"]) for item in result["models"]},
                         {("diffusion_model", "anima.safetensors"), ("clip", "clip.safetensors"),
                          ("vae", "vae.safetensors")})
        self.assertEqual({item["name"] for item in result["loras"]}, {"first.safetensors", "second.safetensors"})
        self.assertEqual(next(item for item in result["loras"] if item["name"] == "first.safetensors")["variants"][0]["roles"],
                         ["model", "clip"])
        self.assertEqual(next(item for item in result["loras"] if item["name"] == "second.safetensors")["variants"][0]["roles"],
                         ["model"])
        self.assertIsNone(result["loras"][0]["variants"][0]["model_mode"])
        self.assertTrue(result["loras"][0]["variants"][0]["applies"])

    def test_all_connected_model_candidates_remain_visible_after_override(self):
        graph = {"output": {
            "1": node("ScenePrompter"),
            "2": node("SceneApplyModel", scene_prompt=["1", 0], model=["6", 0], clip=["6", 1], vae=["6", 2]),
            "3": node("SceneApplyModel", scene_prompt=["2", 0], model=["7", 0], clip=["7", 1], vae=["7", 2]),
            "4": node("ScenePrompterExpand", scene_prompt=["3", 0]),
            "6": node("CheckpointLoaderSimple", ckpt_name="first.safetensors"),
            "7": node("CheckpointLoaderSimple", ckpt_name="second.safetensors"),
        }}
        result = self.info.connected_resources(graph, "4")
        self.assertEqual({item["name"] for item in result["models"]},
                         {"first.safetensors", "second.safetensors"})

    def test_nested_reused_preset_is_loaded_once(self):
        preset_graph = {"output": {
            "1": node("ScenePresetInput"),
            "2": node("SceneApplyLora", scene_prompt=["1", 0], lora_name="nested.safetensors",
                      strength_model=1.0, strength_clip=1.0, model_mode="Illustrious"),
            "3": node("ScenePresetOutput", scene_prompt=["2", 0]),
        }}
        graph = {"output": {
            "1": node("ScenePrompter"),
            "2": node("ScenePresetReference", scene_prompt=["1", 0], preset_id="nested"),
            "3": node("ScenePresetReference", scene_prompt=["2", 0], preset_id="nested"),
            "4": node("ScenePrompterExpand", scene_prompt=["3", 0]),
        }}
        preset = {"schema_version": 1, "api_graph": preset_graph}
        with mock.patch.object(self.info, "load_preset", return_value=preset) as loaded:
            result = self.info.connected_resources(graph, "4")
        loaded.assert_called_once_with("nested", "default")
        self.assertEqual([item["name"] for item in result["loras"]], ["nested.safetensors"])

    def test_nested_preset_cycle_is_rejected(self):
        def preset(reference_id):
            return {"schema_version": 1, "api_graph": {"output": {
                "1": node("ScenePresetInput"),
                "2": node("ScenePresetReference", scene_prompt=["1", 0], preset_id=reference_id),
                "3": node("ScenePresetOutput", scene_prompt=["2", 0]),
            }}}

        graph = {"output": {
            "1": node("ScenePresetReference", preset_id="a"),
            "2": node("ScenePrompterExpand", scene_prompt=["1", 0]),
        }}
        with mock.patch.object(self.info, "load_preset", side_effect=lambda name, _user: preset("b" if name == "a" else "a")):
            with self.assertRaisesRegex(self.info.ScenePresetError, "循環"):
                self.info.connected_resources(graph, "2")

    def test_windows_path_spelling_deduplicates_resources(self):
        graph = {"output": {
            "1": node("SceneApplyLora", lora_name=r"Folder\Style.safetensors"),
            "2": node("SceneApplyLora", scene_prompt=["1", 0], lora_name="folder/style.safetensors"),
            "3": node("ScenePrompterExpand", scene_prompt=["2", 0]),
        }}
        result = self.info.connected_resources(graph, "3")
        self.assertEqual(len(result["loras"]), 1)

    def test_unsupported_linked_strength_and_mode_do_not_invent_values(self):
        graph = {"output": {
            "1": node("SceneApplyLora", lora_name="style.safetensors",
                      strength_model=["8", 0], strength_clip=1.0, model_mode="Anima"),
            "2": node("ScenePrompterExpand", scene_prompt=["1", 0], model_mode="Anima"),
            "8": node("MathFloat", value=0.25),
        }}
        result = self.info.connected_resources(graph, "2")
        self.assertIsNone(result["loras"][0]["variants"][0]["strength_model"])
        self.assertTrue(result["loras"][0]["variants"][0]["applies"])
        graph["output"]["1"]["inputs"]["strength_model"] = 1.0
        graph["output"]["2"]["inputs"]["model_mode"] = ["8", 0]
        result = self.info.connected_resources(graph, "2")
        self.assertIsNone(result["model_mode"])
        self.assertIsNone(result["loras"][0]["variants"][0]["applies"])
        graph["output"]["2"]["inputs"]["model_mode"] = "Anima"
        graph["output"]["1"]["inputs"]["model_mode"] = ["8", 0]
        result = self.info.connected_resources(graph, "2")
        self.assertIsNone(result["loras"][0]["variants"][0]["model_mode"])
        self.assertIsNone(result["loras"][0]["variants"][0]["applies"])

    def test_malformed_or_missing_linked_primitive_is_reported(self):
        graph = {"output": {
            "1": node("SceneApplyLora", lora_name="style.safetensors", strength_model=["8", 0]),
            "2": node("ScenePrompterExpand", scene_prompt=["1", 0]),
            "8": node("PrimitiveFloat", value="not-a-number"),
        }}
        result = self.info.connected_resources(graph, "2")
        self.assertIsNone(result["loras"][0]["variants"][0]["strength_model"])
        del graph["output"]["8"]
        with self.assertRaisesRegex(self.info.ScenePresetError, "見つかりません"):
            self.info.connected_resources(graph, "2")

    def test_hash_is_opt_in_and_uses_selected_folder_only(self):
        model = Path(self.temp.name) / "model.safetensors"
        model.write_bytes(b"test model")
        folder_paths = importlib.import_module("folder_paths")
        with mock.patch.object(folder_paths, "get_filename_list", create=True, return_value=[model.name]), \
             mock.patch.object(folder_paths, "get_full_path", create=True, return_value=str(model)):
            result = self.info.read_model_hash("diffusion_model", model.name)
            self.assertEqual(result["sha256"], hashlib.sha256(b"test model").hexdigest())
            self.assertEqual(self.info.read_model_hash("diffusion_model", model.name), result)
            with self.assertRaises(ValueError):
                self.info.read_model_hash("vae", model.name)
            with self.assertRaises(ValueError):
                self.info.read_model_hash("checkpoint", "../model.safetensors")

    def test_routes_keep_model_hash_separate_from_graph_summary(self):
        class Request:
            user_id = "default"
            query = {"kind": "checkpoint", "name": "base.safetensors"}

            async def json(self):
                return {"api_graph": {"output": {
                    "1": node("ScenePrompterExpand", model_mode="Anima"),
                }}, "expand_node_id": "1"}

        request = Request()
        summary = self.routes._test_routes[("POST", "/scene_prompt/expand/resources")]
        hashed = self.routes._test_routes[("GET", "/scene_prompt/models/hash")]
        with mock.patch.object(self.routes, "read_model_hash") as read_hash:
            self.assertEqual(asyncio.run(summary(request))["payload"],
                             {"model_mode": "Anima", "models": [], "loras": []})
            read_hash.assert_not_called()
            read_hash.return_value = {"sha256": "abc"}
            self.assertEqual(asyncio.run(hashed(request))["payload"], {"sha256": "abc"})


if __name__ == "__main__":
    unittest.main()
