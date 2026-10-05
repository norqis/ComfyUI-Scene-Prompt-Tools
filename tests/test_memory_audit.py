import copy
import importlib
import json
import sys
import tempfile
import threading
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from comfy_stubs import FakeTensor
from test_routes import load_routes
from test_scene_filename_prefix import _load_nodes
from test_scene_presets import basic_nodes, graph, load_presets_module


class PayloadCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        presets = load_presets_module(Path(self.temp.name))
        self.cache_module = importlib.import_module(presets.__package__ + ".payload_cache")

    def tearDown(self):
        self.temp.cleanup()

    def test_size_counts_aliases_once_and_handles_deep_cycles_iteratively(self):
        shared = ["payload" * 100]
        aliased = [shared, shared]
        self.assertEqual(self.cache_module.retained_size(aliased),
                         sys.getsizeof(aliased) + sys.getsizeof(shared) + sys.getsizeof(shared[0]))
        deep = []
        current = deep
        for _ in range(3000):
            child = []
            current.append(child)
            current = child
        current.append(deep)
        self.assertGreater(self.cache_module.retained_size(deep), 3000 * sys.getsizeof([]))

    def test_budget_lru_count_replacement_and_evicted_objects_remain_valid(self):
        cache = self.cache_module.PayloadCache(3, 10)
        active = {"value": "retained by caller"}
        cache.put("a", active, 4)
        cache.put("b", {}, 4)
        cache.move_to_end("a")
        cache.put("c", {}, 4)
        self.assertEqual(list(cache), ["a", "c"])
        self.assertEqual(cache.retained_bytes, 8)
        cache.put("a", {}, 2)
        self.assertEqual(list(cache), ["c", "a"])
        self.assertEqual(cache.retained_bytes, 6)
        cache.put("d", {}, 1)
        cache.put("e", {}, 1)
        self.assertEqual(list(cache), ["a", "d", "e"])
        self.assertEqual(active["value"], "retained by caller")

    def test_pop_delete_clear_and_oversize_replace_keep_accounting_correct(self):
        cache = self.cache_module.PayloadCache(3, 10)
        cache.put("a", [1], 3)
        cache.put("b", [2], 4)
        self.assertEqual(cache.pop("a"), [1])
        self.assertEqual(cache.retained_bytes, 4)
        self.assertEqual(cache.pop("missing", None), None)
        with self.assertRaises(KeyError):
            cache.pop("missing")
        self.assertFalse(cache.put("b", [99], 11))
        self.assertEqual(cache.retained_bytes, 0)
        self.assertNotIn("b", cache)
        cache.put("c", [], 3)
        cache.put("d", [], 2)
        self.assertEqual(cache.popitem(last=False), ("c", []))
        del cache["d"]
        self.assertEqual(cache.retained_bytes, 0)
        cache.put("e", [], 2)
        cache.clear()
        self.assertEqual(cache.retained_bytes, 0)
        self.assertEqual(cache._weights, {})

    def test_standard_assignment_update_and_setdefault_are_accounted(self):
        cache = self.cache_module.PayloadCache(3, 10000)
        cache["a"] = {"v": "a"}
        cache.update({"b": {"v": "b"}})
        cache.setdefault("c", {"v": "c"})
        self.assertEqual(cache.retained_bytes,
                         sum(self.cache_module.retained_size((key, value)) for key, value in cache.items()))


class PresetMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.presets = load_presets_module(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def save(self, preset_id, positive="first", name=None):
        return self.presets.save_preset({"preset_id": preset_id, "name": name or preset_id,
            "output_node_id": "3", "api_graph": graph(basic_nodes(positive)),
            "workflow": {"version": 1, "nodes": []}})

    def assert_unlocked(self, *locks):
        for lock in locks:
            self.assertFalse(lock._is_owned(), "large payload work must happen outside cache/global locks")

    def test_payload_size_and_copy_work_runs_outside_preset_locks(self):
        locks = (self.presets._PRESET_LOCK, self.presets._PRESET_FILE_CACHE_LOCK,
                 self.presets._PRESET_LIST_CACHE_LOCK)
        original_copy, original_size = copy.deepcopy, self.presets.retained_size

        def checked_copy(*args, **kwargs):
            self.assert_unlocked(*locks)
            return original_copy(*args, **kwargs)

        def checked_size(value):
            self.assert_unlocked(*locks)
            return original_size(value)

        with mock.patch.object(self.presets.copy, "deepcopy", side_effect=checked_copy), \
                mock.patch.object(self.presets, "retained_size", side_effect=checked_size):
            saved = self.save("lockcost")
            self.presets.load_preset("lockcost")
            self.presets.load_preset("lockcost")
            self.presets.list_presets()
            self.presets.list_presets()
            serialized = json.dumps({"version": 1, "presets": {".": saved}})
            self.presets.parse_llm_preset_overrides(serialized)
            self.presets.parse_llm_preset_overrides(serialized)
            nodes = {"10": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "lockcost"}},
                     "11": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["10", 0]}}}
            self.presets.snapshot_presets_for_run("lockcost", graph(nodes), "11")
            self.presets.snapshot_presets_for_run("lockcost", graph(nodes), "11")

    def test_file_ttl_refresh_reuses_weight_and_validated_payload(self):
        self.save("ttl")
        with mock.patch.object(self.presets.time, "monotonic", return_value=0):
            first = self.presets.load_preset("ttl")
        cache = self.presets._PRESET_FILE_CACHE
        key = ("default", "ttl")
        original_entry = cache[key]
        weight = cache.weight(key)
        with mock.patch.object(self.presets.time, "monotonic", return_value=3), \
                mock.patch.object(self.presets, "retained_size", side_effect=AssertionError("TTL must not walk payload")), \
                mock.patch.object(self.presets, "_read_json", side_effect=AssertionError("matching hash must not parse again")):
            self.assertEqual(self.presets.load_preset("ttl"), first)
        self.assertIs(cache[key][3], original_entry[3])
        self.assertEqual(cache.weight(key), weight)
        self.assertEqual(cache.retained_bytes, weight)
        self.assertEqual(original_entry[2], 2)
        self.assertEqual(cache[key][2], 5)

    def test_file_and_list_oversize_remain_valid_uncached_and_copies_are_isolated(self):
        self.presets._PRESET_FILE_CACHE.max_bytes = 1
        self.presets._PRESET_LIST_CACHE.max_bytes = 1
        self.save("oversize")
        first = self.presets.load_preset("oversize")
        first["metadata"]["name"] = "caller edit"
        self.assertEqual(self.presets.load_preset("oversize")["metadata"]["name"], "oversize")
        listed = self.presets.list_presets()
        self.assertEqual(listed["presets"][0]["metadata"]["name"], "oversize")
        self.assertEqual(len(self.presets._PRESET_FILE_CACHE), 0)
        self.assertEqual(len(self.presets._PRESET_LIST_CACHE), 0)

    def test_file_and_list_bytes_evict_lru_users_before_count_limit(self):
        for preset_id in ("a", "b", "c"):
            self.save(preset_id, "prompt" * 200)
        self.presets.load_preset("a")
        cache = self.presets._PRESET_FILE_CACHE
        cache.max_bytes = cache.retained_bytes * 2 + 100
        self.presets.load_preset("b")
        self.presets.load_preset("a")
        self.presets.load_preset("c")
        self.assertEqual(list(cache), [("default", "a"), ("default", "c")])
        self.assertLessEqual(cache.retained_bytes, cache.max_bytes)
        self.presets.list_presets()
        lists = self.presets._PRESET_LIST_CACHE
        lists.max_bytes = lists.retained_bytes + 500
        self.presets.list_presets("alice")
        self.presets.list_presets("bob")
        self.assertLessEqual(lists.retained_bytes, lists.max_bytes)
        self.assertNotIn("default", lists)

    def test_local_cache_budget_preserves_read_only_hit_and_oversize_validation(self):
        saved = self.save("local")
        cache = self.presets._LOCAL_PRESET_CACHE
        cache.clear()
        serialized = json.dumps({"version": 1, "presets": {".": saved}})
        first = self.presets.parse_llm_preset_overrides(serialized)
        with mock.patch.object(self.presets, "retained_size", side_effect=AssertionError("hit must not walk payload")):
            self.assertIs(self.presets.parse_llm_preset_overrides(serialized), first)
        cache.max_bytes = cache.retained_bytes + 10
        changed = copy.deepcopy(saved)
        changed["metadata"]["name"] = "second"
        newer = json.dumps({"version": 1, "presets": {".": changed}})
        self.presets.parse_llm_preset_overrides(newer)
        self.assertNotIn(serialized, cache)
        self.assertEqual(first["."]["metadata"]["name"], "local")
        cache.max_bytes = 1
        self.assertEqual(self.presets.parse_llm_preset_overrides(serialized)["."]["metadata"]["name"], "local")
        self.assertNotIn(serialized, cache)
        with self.assertRaises(self.presets.ScenePresetError):
            self.presets.parse_llm_preset_overrides('{"version":1,"presets":{".":{}}}')

    def test_file_read_invalidation_cannot_restore_old_payload(self):
        self.save("race", "old")
        started, resume = threading.Event(), threading.Event()
        original = self.presets._read_json
        reads = 0
        result, errors = {}, []

        def delayed_read(path):
            nonlocal reads
            value = original(path)
            if threading.current_thread().name == "cache-reader":
                reads += 1
                if reads == 1:
                    started.set()
                    if not resume.wait(5):
                        raise AssertionError("reader was not resumed")
            return value

        def worker():
            try:
                result["value"] = self.presets.load_preset("race")
            except Exception as exc:
                errors.append(exc)

        with mock.patch.object(self.presets, "_read_json", side_effect=delayed_read):
            thread = threading.Thread(target=worker, name="cache-reader")
            thread.start()
            self.assertTrue(started.wait(5))
            self.save("race", "new")
            resume.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(result["value"]["api_graph"]["output"]["2"]["inputs"]["positive_base"], "new")
        self.assertEqual(self.presets._PRESET_FILE_CACHE[("default", "race")][3], result["value"])

    def test_list_invalidation_after_weight_calculation_retries_publication(self):
        self.save("list-race", "old")
        original = self.presets.retained_size
        changed = False

        def invalidate_during_measure(value):
            nonlocal changed
            if not changed and value[0] == "default":
                changed = True
                self.assert_unlocked(self.presets._PRESET_LIST_CACHE_LOCK)
                self.save("list-race", "new")
            return original(value)

        with mock.patch.object(self.presets, "retained_size", side_effect=invalidate_during_measure):
            listed = self.presets.list_presets()
        latest = self.presets.load_preset("list-race")
        self.assertTrue(changed)
        self.assertEqual(listed["presets"][0]["metadata"]["sha256"], latest["metadata"]["sha256"])
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

    def test_route_weights_are_measured_outside_lock_and_ttl_has_no_size_walk(self):
        self.write_items()
        self.write_saved()
        original = self.routes.retained_size

        def checked_size(value):
            self.assertFalse(self.routes.DATA_CACHE_LOCK._is_owned())
            return original(value)

        with mock.patch.object(self.routes, "retained_size", side_effect=checked_size), \
                mock.patch.object(self.routes.time, "monotonic", return_value=0):
            first_items = self.routes._load_items()
            first_saved = self.routes._load_saved_prompts()
        item_entry = self.routes._ITEMS_CACHE["default"]
        saved_entry = self.routes._SAVED_PROMPTS_CACHE["default"]
        with mock.patch.object(self.routes, "retained_size", side_effect=AssertionError("TTL must not walk payload")), \
                mock.patch.object(self.routes, "_read_items", side_effect=AssertionError("TTL must not parse payload")), \
                mock.patch.object(self.routes, "_read_saved_prompt", side_effect=AssertionError("TTL must not parse payload")), \
                mock.patch.object(self.routes.time, "monotonic", return_value=3):
            self.assertIs(self.routes._load_items(), first_items)
            self.assertIs(self.routes._load_saved_prompts(), first_saved)
        self.assertEqual(item_entry["expires"], 2)
        self.assertEqual(saved_entry["expires"], 2)
        for cache in (self.routes._ITEMS_CACHE, self.routes._SAVED_PROMPTS_CACHE):
            self.assertEqual(cache["default"]["expires"], 5)
            self.assertEqual(cache.retained_bytes, original(("default", cache["default"])))

    def test_route_oversize_payloads_are_valid_and_do_not_fill_empty_records(self):
        self.write_items()
        self.write_saved()
        for cache in (self.routes._ITEMS_CACHE, self.routes._SAVED_PROMPTS_CACHE):
            cache.max_bytes = 1
        self.assertEqual(self.routes._load_items()[0]["prompt"], "cached")
        self.assertEqual(self.routes._load_saved_prompts()[0]["items"][0]["prompt"], "cached")
        self.assertEqual(len(self.routes._ITEMS_CACHE), 0)
        self.assertEqual(len(self.routes._SAVED_PROMPTS_CACHE), 0)

    def test_route_byte_eviction_preserves_user_isolation_and_live_values(self):
        for user in ("a", "b", "c"):
            self.write_items(user, user * 10000)
        first = self.routes._load_items("a")
        cache = self.routes._ITEMS_CACHE
        cache.max_bytes = cache.retained_bytes * 2 + 100
        self.routes._load_items("b")
        self.routes._load_items("a")
        self.routes._load_items("c")
        self.assertEqual(list(cache), ["a", "c"])
        self.assertLessEqual(cache.retained_bytes, cache.max_bytes)
        self.assertEqual(first[0]["prompt"], "a" * 10000)
        self.assertEqual(self.routes._load_items("b")[0]["prompt"], "b" * 10000)

    def test_route_invalidation_during_weight_calculation_cannot_restore_old_record(self):
        self.write_items(prompt="old")
        original = self.routes.retained_size
        changed = False

        def invalidate_during_measure(value):
            nonlocal changed
            if not changed:
                changed = True
                self.assertFalse(self.routes.DATA_CACHE_LOCK._is_owned())
                self.write_items(prompt="new")
                self.routes._clear_prompt_caches()
            return original(value)

        with mock.patch.object(self.routes, "retained_size", side_effect=invalidate_during_measure):
            loaded = self.routes._load_items()
        self.assertEqual(loaded[0]["prompt"], "new")
        self.assertEqual(self.routes._ITEMS_CACHE["default"]["value"]["items"][0]["prompt"], "new")


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
