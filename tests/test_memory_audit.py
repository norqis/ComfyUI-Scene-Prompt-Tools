import copy
import hashlib
import importlib
import json
import struct
import tempfile
import tracemalloc
import unittest
import weakref
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from comfy_stubs import FakeTensor
from test_routes import load_routes
from test_scene_filename_prefix import _load_nodes
from test_scene_presets import basic_nodes, graph, load_presets_module


class PresetMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.presets = load_presets_module(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def save(self, preset_id, positive="first"):
        return self.presets.save_preset({"preset_id": preset_id, "name": preset_id,
            "output_node_id": "3", "api_graph": graph(basic_nodes(positive)),
            "workflow": {"version": 1, "nodes": []}})

    def test_copy_work_runs_outside_cache_snapshot_and_own_save_locks(self):
        original = copy.deepcopy
        def checked_copy(*args, **kwargs):
            self.assertFalse(self.presets._PRESET_LOCK._is_owned())
            self.assertFalse(self.presets._PRESET_LIST_CACHE_LOCK._is_owned())
            return original(*args, **kwargs)
        with mock.patch.object(self.presets.copy, "deepcopy", side_effect=checked_copy):
            saved = self.save("lockcost")
            self.presets.load_preset("lockcost")
            self.presets.list_presets()
            self.presets.list_presets()
            memo = {}
            serialized = json.dumps({"version": 1, "presets": {".": saved}})
            self.presets.parse_llm_preset_overrides(serialized, memo)
            self.presets.parse_llm_preset_overrides(serialized, memo)
            nodes = {"10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "lockcost"}},
                     "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}}}
            self.presets.snapshot_presets_for_run("lockcost", graph(nodes), "11")
            self.presets.snapshot_presets_for_run("lockcost", graph(nodes), "11")

    def test_local_memo_shares_only_the_current_operation(self):
        saved = self.save("memo")
        serialized = json.dumps({"version": 1, "presets": {".": saved}})
        memo = {}
        with mock.patch.object(self.presets, "_validate_preset_payload", wraps=self.presets._validate_preset_payload) as validate:
            first = self.presets.parse_llm_preset_overrides(serialized, memo)
            self.assertIs(self.presets.parse_llm_preset_overrides(serialized, memo), first)
            self.assertEqual(validate.call_count, 1)
            separate = self.presets.parse_llm_preset_overrides(serialized)
            self.assertIsNot(first, separate)
            self.assertEqual(validate.call_count, 2)
        first["."]["metadata"]["name"] = "local edit"
        self.assertEqual(separate["."]["metadata"]["name"], "memo")
        self.assertFalse(hasattr(self.presets, "_LOCAL_PRESET_CACHE"))
        self.assertFalse(hasattr(self.presets, "_PRESET_FILE_CACHE"))

    def test_seventy_large_local_revisions_release_completed_operation_payloads(self):
        saved = self.save("revisions", "x" * 65536)
        serialized = None
        tracemalloc.start()
        try:
            for index in range(70):
                local = copy.deepcopy(saved)
                local["metadata"]["name"] = "revision-" + str(index)
                serialized = json.dumps({"version": 1, "presets": {".": local}})
                self.presets.parse_llm_preset_overrides(serialized)
            del local, serialized
            import gc
            gc.collect()
            retained = tracemalloc.get_traced_memory()[0]
        finally:
            tracemalloc.stop()
        self.assertLess(retained, 1024 * 1024)
        self.assertFalse(hasattr(self.presets, "_LOCAL_PRESET_CACHE"))

    def test_repeated_nested_references_read_and_validate_each_file_once_per_snapshot(self):
        self.save("leaf")
        parent = {"1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "leaf", "scene_prompt": ["1", 0]}},
            "4": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "leaf", "scene_prompt": ["1", 0]}},
            "5": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["2", 0], "scene_prompt2": ["4", 0]}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["5", 0]}}}
        self.presets.save_preset({"preset_id": "parent", "name": "parent", "output_node_id": "3",
            "api_graph": graph(parent), "workflow": {"nodes": []}})
        nodes = {"10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "parent"}},
            "20": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "parent"}},
            "30": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["10", 0], "scene_prompt2": ["20", 0]}},
            "40": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["30", 0]}}}
        with mock.patch.object(self.presets, "_read_json", wraps=self.presets._read_json) as read, \
                mock.patch.object(self.presets, "_validate_preset_payload", wraps=self.presets._validate_preset_payload) as validate:
            result = self.presets.snapshot_presets_for_run("nested-memo", graph(nodes), "40")
            self.assertEqual(read.call_count, 2)
            self.assertEqual(validate.call_count, 2)
        self.assertEqual(result["total_images"], 4)
        snapshot = self.presets._RUN_SNAPSHOTS[("default", "nested-memo")]
        self.assertIs(snapshot["occurrences"]["10/2"], snapshot["occurrences"]["20/4"])
        self.save("leaf", "changed source")
        self.assertEqual(snapshot["presets"]["leaf"]["api_graph"]["output"]["2"]["inputs"]["positive_base"], "first")
        self.assertTrue(self.presets.release_scene_preset_snapshot("nested-memo"))
        self.assertNotIn(("default", "nested-memo"), self.presets._RUN_SNAPSHOTS)

    def test_equal_local_json_across_references_validates_once_in_snapshot(self):
        saved = self.save("shared")
        serialized = json.dumps({"version": 1, "presets": {".": saved}})
        reference = {"class_type": "ScenePresetReference", "inputs": {"preset_id": "shared", "llm_presets_json": serialized}}
        nodes = {"10": copy.deepcopy(reference), "20": copy.deepcopy(reference),
            "30": {"class_type": "ScenePrompterQueue", "inputs": {"scene_prompt1": ["10", 0], "scene_prompt2": ["20", 0]}},
            "40": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["30", 0]}}}
        with mock.patch.object(self.presets, "_validate_preset_payload", wraps=self.presets._validate_preset_payload) as validate:
            self.presets.snapshot_presets_for_run("local-memo", graph(nodes), "40")
            self.assertEqual(validate.call_count, 1)
        self.assertIs(self.presets._RUN_SNAPSHOTS[("default", "local-memo")]["occurrences"]["10"],
                      self.presets._RUN_SNAPSHOTS[("default", "local-memo")]["occurrences"]["20"])

    def test_current_operation_can_keep_more_than_previous_file_limit(self):
        template = self.save("template")
        def read_definition(path):
            definition = copy.deepcopy(template)
            definition["metadata"]["preset_id"] = path.stem
            definition["metadata"]["name"] = path.stem
            return definition
        resolved = {}
        with mock.patch.object(self.presets, "_read_json", side_effect=read_definition) as read:
            references = {str(index): {"class_type": "ScenePresetReference", "inputs": {"preset_id": "p" + str(index)}}
                          for index in range(520)}
            occurrences = self.presets.prepare_preset_occurrences(references, resolved)
            self.assertEqual(read.call_count, 520)
        self.assertEqual(len(resolved), 520)
        self.assertEqual(len(occurrences), 520)
        self.assertIs(occurrences["0"], resolved["p0"])

    def test_compact_response_users_have_no_count_limit_and_inactive_ttl_cleanup(self):
        with mock.patch.object(self.presets.time, "monotonic", return_value=0):
            for index in range(70):
                self.presets.list_presets("user-" + str(index))
        self.assertEqual(len(self.presets._PRESET_LIST_CACHE), 70)
        self.assertIn("user-0", self.presets._PRESET_LIST_CACHE)
        with mock.patch.object(self.presets.time, "monotonic", return_value=3):
            self.presets.list_presets("user-0")
        self.assertEqual(list(self.presets._PRESET_LIST_CACHE), ["user-0"])

    def test_list_invalidation_during_compaction_cannot_publish_old_response(self):
        self.save("list-race", "old")
        original = self.presets._compact_preset_list_graph
        changed = False
        def invalidate_during_compaction(*args):
            nonlocal changed
            value = original(*args)
            if not changed:
                changed = True
                self.assertFalse(self.presets._PRESET_LIST_CACHE_LOCK._is_owned())
                self.save("list-race", "new")
            return value
        with mock.patch.object(self.presets, "_compact_preset_list_graph", side_effect=invalidate_during_compaction):
            listed = self.presets.list_presets()
        self.assertEqual(listed["presets"][0]["metadata"]["sha256"], self.presets.load_preset("list-race")["metadata"]["sha256"])
        self.assertEqual(self.presets._PRESET_LIST_CACHE["default"]["value"], listed)

    def test_snapshot_copies_shared_and_customized_occurrences_once_with_aliases(self):
        saved = self.save("shared", "source")
        custom = copy.deepcopy(saved)
        custom["api_graph"]["output"]["2"]["inputs"]["positive_base"] = "custom"
        custom_json = json.dumps({"version": 1, "presets": {".": custom}})
        nodes = {str(index): {"class_type": "ScenePresetReference", "inputs": {"preset_id": "shared"}}
                 for index in (10, 20, 30)}
        nodes["30"]["inputs"]["llm_presets_json"] = custom_json
        nodes["40"] = {"class_type": "ScenePrompterQueue", "inputs": {
            "scene_prompt1": ["10", 0], "scene_prompt2": ["20", 0], "scene_prompt3": ["30", 0]}}
        nodes["50"] = {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["40", 0]}}
        sources = []
        original = self.presets.prepare_preset_occurrences

        def track_sources(*args, **kwargs):
            occurrences = original(*args, **kwargs)
            sources.extend(occurrences.values())
            return occurrences

        with mock.patch.object(self.presets, "prepare_preset_occurrences", side_effect=track_sources):
            response = self.presets.snapshot_presets_for_run("aliases", graph(nodes), "50")
        self.assertEqual(response["total_images"], 3)
        entry = self.presets._RUN_SNAPSHOTS[("default", "aliases")]
        self.assertIs(entry["presets"]["shared"], entry["occurrences"]["10"])
        self.assertIs(entry["occurrences"]["10"], entry["occurrences"]["20"])
        self.assertIsNot(entry["occurrences"]["10"], entry["occurrences"]["30"])
        self.assertIsNot(entry["occurrences"]["10"], sources[0])
        self.assertIsNot(entry["occurrences"]["30"], sources[2])
        for source in sources:
            source["metadata"]["name"] = "later mutation"
        response["presets"][0]["name"] = "caller mutation"
        self.assertEqual(entry["presets"]["shared"]["metadata"]["name"], "shared")
        self.assertEqual(entry["response"]["presets"][0]["name"], "shared")
        self.assertEqual(entry["occurrences"]["30"]["api_graph"]["output"]["2"]["inputs"]["positive_base"], "custom")


class RouteMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.routes = load_routes(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def write_items(self, user="default", prompt="cached"):
        path = self.routes._data_dir(user) / "Category" / "prompt.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([{"label": "Cached", "prompt": prompt}]), encoding="utf-8")

    def write_saved(self, user="default", prompt="cached"):
        path = self.routes._saved_prompts_dir(user) / "Saved" / "prompt.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"name": "Saved", "description": "", "items": [
            {"label": "Saved", "prompt": prompt, "category_key": "Saved"}]}), encoding="utf-8")

    def test_inactive_users_expire_but_requested_user_revalidates_without_parsing(self):
        for user in ("a", "b"):
            self.write_items(user)
            self.write_saved(user)
        with mock.patch.object(self.routes.time, "monotonic", return_value=0):
            first_items = self.routes._load_items("a")
            first_saved = self.routes._load_saved_prompts("a")
            self.routes._load_items("b")
            self.routes._load_saved_prompts("b")
        with mock.patch.object(self.routes.time, "monotonic", return_value=3), \
                mock.patch.object(self.routes, "_read_items", side_effect=AssertionError("unchanged revalidation must not parse")), \
                mock.patch.object(self.routes, "_read_saved_prompt", side_effect=AssertionError("unchanged revalidation must not parse")):
            self.assertIs(self.routes._load_items("a"), first_items)
            self.assertIs(self.routes._load_saved_prompts("a"), first_saved)
        self.assertEqual(list(self.routes._ITEMS_CACHE), ["a"])
        self.assertEqual(list(self.routes._SAVED_PROMPTS_CACHE), ["a"])

    def test_latest_response_replaces_previous_without_revision_history(self):
        class TrackedDict(dict):
            pass
        references = []
        original = self.routes._cache_entry
        def track_response(*args):
            entry = original(*args)
            entry["value"] = TrackedDict(entry["value"])
            references.append(weakref.ref(entry["value"]))
            return entry
        with mock.patch.object(self.routes, "_cache_entry", side_effect=track_response):
            for index in range(70):
                self.write_items(prompt=("x" * 65536) + str(index))
                self.routes._load_items(force=True)
        import gc
        gc.collect()
        self.assertEqual(sum(reference() is not None for reference in references), 1)
        self.assertEqual(len(self.routes._ITEMS_CACHE), 1)
        self.assertTrue(self.routes._ITEMS_CACHE["default"]["value"]["items"][0]["prompt"].endswith("69"))

    def test_invalidation_during_entry_construction_cannot_restore_old_response(self):
        self.write_items(prompt="old")
        original = self.routes._cache_entry
        changed = False
        def invalidate_during_entry(*args):
            nonlocal changed
            entry = original(*args)
            self.assertFalse(self.routes.DATA_CACHE_LOCK._is_owned())
            if not changed:
                changed = True
                self.write_items(prompt="new")
                self.routes._clear_prompt_caches()
            return entry
        with mock.patch.object(self.routes, "_cache_entry", side_effect=invalidate_during_entry):
            loaded = self.routes._load_items()
        self.assertEqual(loaded[0]["prompt"], "new")
        self.assertEqual(self.routes._ITEMS_CACHE["default"]["value"]["items"][0]["prompt"], "new")


class FileMetadataMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.routes = load_routes(self.root)
        package = self.routes.__package__
        self.metadata = importlib.import_module(package + ".lora_metadata")
        self.info = importlib.import_module(package + ".resource_info")
        self.acquisition = importlib.import_module(package + ".civitai")
        self.catalogs = {"loras": {}, "checkpoints": {}, "diffusion_models": {}}
        self.metadata.folder_paths.get_filename_list = lambda kind: list(self.catalogs[kind])
        self.metadata.folder_paths.get_full_path = lambda kind, name: self.catalogs[kind].get(name)

    def tearDown(self):
        self.temp.cleanup()

    def write_lora(self, name, trigger="trigger"):
        path = self.root / name
        header = json.dumps({"__metadata__": {"modelspec.trigger_phrase": trigger}}).encode()
        path.write_bytes(struct.pack("<Q", len(header)) + header + b"weights")
        self.catalogs["loras"][name] = str(path)
        return path

    def test_all_current_metadata_and_model_hashes_survive_previous_count_thresholds(self):
        for index in range(40):
            name = "file-" + str(index) + ".safetensors"
            path = self.write_lora(name)
            self.catalogs["checkpoints"][name] = str(path)
            self.metadata.read_lora_info(name)
            self.info.read_model_hash("checkpoint", name)
        self.assertEqual(len(self.metadata._CACHE), 40)
        self.assertEqual(len(self.info._MODEL_HASH_CACHE), 40)
        with mock.patch.object(self.metadata.hashlib, "sha256", side_effect=AssertionError("current file was evicted")):
            self.metadata.read_lora_info("file-0.safetensors")
            self.info.read_model_hash("checkpoint", "file-0.safetensors")

    def test_acquired_hashes_survive_previous_count_threshold(self):
        first = None
        for index in range(140):
            path = self.root / ("acquired-" + str(index) + ".safetensors")
            path.write_bytes(str(index).encode())
            first = path if first is None else first
            self.acquisition._sha256(path)
        self.assertEqual(len(self.acquisition._HASH_CACHE), 140)
        with mock.patch.object(self.acquisition.hashlib, "sha256", side_effect=AssertionError("current file was evicted")):
            self.assertEqual(self.acquisition._sha256(first), hashlib.new("sha256", b"0").hexdigest())

    def test_same_file_alias_hits_return_requested_names_and_model_kind(self):
        path = self.write_lora("original.safetensors")
        self.catalogs["loras"]["ALIAS.safetensors"] = str(path)
        self.catalogs["checkpoints"]["base-A.safetensors"] = str(path)
        self.catalogs["diffusion_models"]["base-B.safetensors"] = str(path)
        self.metadata.read_lora_info("original.safetensors")
        self.info.read_model_hash("checkpoint", "base-A.safetensors")
        with mock.patch.object(self.metadata.hashlib, "sha256", side_effect=AssertionError("alias must reuse file data")):
            self.assertEqual(self.metadata.read_lora_info("ALIAS.safetensors")["name"], "ALIAS.safetensors")
            result = self.info.read_model_hash("diffusion_model", "base-B.safetensors")
        self.assertEqual((result["kind"], result["name"]), ("diffusion_model", "base-B.safetensors"))
        self.assertEqual(len(self.info._MODEL_HASH_CACHE), 1)
        self.assertEqual(len(self.metadata._CACHE), 1)

    def test_seventy_revisions_replace_same_path_without_history(self):
        path = self.write_lora("revised.safetensors")
        self.catalogs["checkpoints"][path.name] = str(path)
        for index in range(70):
            self.write_lora(path.name, "revision-" + str(index))
            self.metadata.read_lora_info(path.name)
            self.info.read_model_hash("checkpoint", path.name)
            self.acquisition._sha256(path)
        self.assertEqual(len(self.metadata._CACHE), 1)
        self.assertEqual(len(self.info._MODEL_HASH_CACHE), 1)
        self.assertEqual(len(self.acquisition._HASH_CACHE), 1)
        self.assertEqual(self.metadata.read_lora_info(path.name)["trigger_phrases"], ["revision-69"])

    def test_existing_catalog_inventory_retires_deleted_and_changed_lora_revisions(self):
        removed = self.write_lora("removed.safetensors")
        changed = self.write_lora("changed.safetensors")
        retained = self.write_lora("retained.safetensors")
        for path in (removed, changed, retained):
            self.metadata.read_lora_info(path.name)
            self.acquisition._sha256(path)
        removed.unlink()
        self.write_lora(changed.name, "new revision")
        self.metadata.list_loras()
        retained_key = self.metadata.file_identity(retained)
        self.assertEqual(set(self.metadata._CACHE), {retained_key})
        self.assertEqual(set(self.acquisition._HASH_CACHE), {retained_key})
        self.assertEqual(set(self.acquisition._HASH_CATALOG), {
            self.metadata.file_identity(changed), retained_key})

    def test_model_catalog_removal_and_same_name_path_replacement_release_old_owners(self):
        first = self.write_lora("first.safetensors")
        second = self.write_lora("second.safetensors")
        self.catalogs["checkpoints"]["selected"] = str(first)
        self.info.read_model_hash("checkpoint", "selected")
        self.catalogs["checkpoints"]["selected"] = str(second)
        self.info.read_model_hash("checkpoint", "selected")
        self.assertEqual(set(self.info._MODEL_HASH_CACHE), {self.metadata.file_identity(second)})
        self.catalogs["checkpoints"].clear()
        with self.assertRaises(ValueError):
            self.info.read_model_hash("checkpoint", "selected")
        self.assertEqual(self.info._MODEL_HASH_CACHE, {})
        self.assertEqual(self.info._MODEL_HASH_SELECTIONS, {})

    def test_hashing_revision_changed_before_publication_returns_only_current_file(self):
        path = self.write_lora("during-hash.safetensors", "old")
        self.catalogs["checkpoints"][path.name] = str(path)
        real_hash = hashlib.sha256
        for kind in ("metadata", "model", "acquired"):
            with self.subTest(kind=kind):
                self.write_lora(path.name, "old-" + kind)
                changed = False
                case = self
                class ChangingDigest:
                    def __init__(self):
                        self.digest = real_hash()
                    def update(self, chunk):
                        self.digest.update(chunk)
                    def hexdigest(self):
                        nonlocal changed
                        if not changed:
                            changed = True
                            case.write_lora(path.name, "new-" + kind)
                            if kind == "metadata":
                                case.metadata.list_loras()
                        return self.digest.hexdigest()
                with mock.patch.object(self.metadata.hashlib, "sha256", side_effect=ChangingDigest):
                    if kind == "metadata":
                        result = self.metadata.read_lora_info(path.name)
                        value = result["sha256"]
                        self.assertEqual(result["trigger_phrases"], ["new-metadata"])
                    elif kind == "model":
                        value = self.info.read_model_hash("checkpoint", path.name)["sha256"]
                    else:
                        value = self.acquisition._sha256(path)
                self.assertTrue(changed)
                self.assertEqual(value, real_hash(path.read_bytes()).hexdigest())

    def test_late_hash_cannot_repopulate_a_removed_catalog_identity(self):
        path = self.write_lora("catalog-race.safetensors")
        real_hash = hashlib.sha256
        case = self
        class RemovingDigest:
            def __init__(self):
                self.digest = real_hash()
            def update(self, chunk):
                self.digest.update(chunk)
            def hexdigest(self):
                case.catalogs["loras"].clear()
                case.metadata.list_loras()
                return self.digest.hexdigest()
        with mock.patch.object(self.metadata.hashlib, "sha256", side_effect=RemovingDigest):
            with self.assertRaises(ValueError):
                self.metadata.read_lora_info(path.name)
        self.assertEqual(self.metadata._CACHE, {})
        # A physical-file verification may still finish, but cannot restore a
        # hash record discarded by the catalog while that verification ran.
        with mock.patch.object(self.acquisition.hashlib, "sha256", side_effect=RemovingDigest):
            self.assertEqual(self.acquisition._sha256(path), real_hash(path.read_bytes()).hexdigest())
        self.assertEqual(self.acquisition._HASH_CACHE, {})

    def test_cached_metadata_rechecks_revision_before_presenting(self):
        path = self.write_lora("cached-race.safetensors", "old")
        self.metadata.read_lora_info(path.name)
        original = self.metadata.file_signature
        calls = 0
        def replace_after_acquiring_signature(selected):
            nonlocal calls
            calls += 1
            signature = original(selected)
            if calls == 1:
                self.write_lora(path.name, "new")
            return signature
        with mock.patch.object(self.metadata, "file_signature", side_effect=replace_after_acquiring_signature):
            result = self.metadata.read_lora_info(path.name)
        self.assertEqual(result["trigger_phrases"], ["new"])
        self.assertEqual(result["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())


class SaveDirectoryMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.nodes = _load_nodes(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_revisions_replace_current_prompt_and_keep_batch_directory_stable(self):
        with mock.patch.object(self.nodes, "_resolve_run_dir", side_effect=lambda _value: ["run-" + str(len(self.nodes._RUN_DIR_CACHE))]) as resolve:
            for index in range(70):
                prompt = {"prompt": index}
                first = self.nodes._cached_run_parts(self.temp.name, "auto", prompt, "save")
                self.assertIs(self.nodes._cached_run_parts(self.temp.name, "auto", prompt, "save"), first)
            self.assertEqual(resolve.call_count, 70)
        self.assertEqual(len(self.nodes._RUN_DIR_CACHE), 1)

    def test_independent_current_nodes_and_roots_are_not_count_evicted(self):
        with mock.patch.object(self.nodes, "_resolve_run_dir", return_value=["current"]) as resolve:
            for index in range(300):
                self.nodes._cached_run_parts(self.temp.name, "auto", {}, "save-" + str(index))
            self.nodes._cached_run_parts(str(Path(self.temp.name) / "other"), "auto", {}, "save-0")
            self.nodes._cached_run_parts(self.temp.name, "auto", {}, "save-0")
        self.assertEqual(resolve.call_count, 301)
        self.assertEqual(len(self.nodes._RUN_DIR_CACHE), 301)


class ImageMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.nodes = _load_nodes(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_saved_pixels_clipping_metadata_input_and_return_identity_are_preserved(self):
        for dtype in (np.float32, np.float64):
            with self.subTest(dtype=dtype):
                source = FakeTensor((2, 2, 3))
                source._array = np.array([-0.1, 0, 0.1, 0.5, 0.999, 1, 1.1, 0.25, 0.75, 0.01, 0.9, 0.6], dtype=dtype).reshape(2, 2, 3)
                original = source._array.copy()
                expected = np.clip(255.0 * original, 0, 255).astype(np.uint8)
                images = [source]
                info = {"positive": "test", "negative": "blur", "seed": 42, "use_run_dir": False,
                        "filename_prefix": "prefix_", "filename_suffix": "scene", "file_index": 1}
                result = self.nodes.SceneSaveImage().save_images(images, "", scene_info=info,
                    prompt={"1": {"class_type": "Saved"}}, extra_pnginfo={"workflow": {"nodes": []}})
                self.assertIs(result["result"][0], images)
                path = Path(result["result"][1])
                with Image.open(path) as image:
                    np.testing.assert_array_equal(np.asarray(image), expected)
                    self.assertEqual(json.loads(image.info["scene_info"])["seed"], 42)
                    self.assertEqual(json.loads(image.info["workflow"]), {"nodes": []})
                    self.assertEqual(json.loads(image.info["prompt"]), {"1": {"class_type": "Saved"}})
                np.testing.assert_array_equal(source._array, original)
                self.assertTrue(path.name.startswith("prefix_"))
                self.assertFalse(list(Path(self.temp.name).rglob(".scene-save-*.tmp")))

    def test_real_save_peak_avoids_an_extra_float_clip_buffer(self):
        source = FakeTensor((2048, 2048, 3))
        source._array = np.linspace(-0.1, 1.1, 2048 * 2048 * 3, dtype=np.float32).reshape(2048, 2048, 3)
        original = source._array.copy()
        expected = np.clip(255.0 * original, 0, 255).astype(np.uint8)
        original_fromarray = self.nodes.Image.fromarray
        measured = []

        def measure_conversion(array, *args, **kwargs):
            measured.append(tracemalloc.get_traced_memory()[1])
            return original_fromarray(array, *args, **kwargs)

        tracemalloc.start()
        try:
            with mock.patch.object(self.nodes.Image, "fromarray", side_effect=measure_conversion):
                result = self.nodes.SceneSaveImage().save_images([source], "", scene_info={"use_run_dir": False})
        finally:
            tracemalloc.stop()
        self.assertEqual(len(measured), 1)
        # The previous scaled + clipped float arrays plus uint8 peaked at 108 MiB.
        self.assertLess(measured[0], 85 * 1024 * 1024)
        with Image.open(result["result"][1]) as image:
            np.testing.assert_array_equal(np.asarray(image), expected)
        np.testing.assert_array_equal(source._array, original)


if __name__ == "__main__":
    unittest.main()
