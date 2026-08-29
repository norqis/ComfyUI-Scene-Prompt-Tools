import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("scene_prompt_runs_test", ROOT / "scene_prompt_tools" / "runs.py")
RUNS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNS)


class RunContextTests(unittest.TestCase):
    def test_handle_is_opaque_and_released_handles_are_rejected(self):
        store = RUNS.RunContextStore()
        handle = store.create("alice", {"by_key": {"a": {"label": "Alice"}}, "by_id": {}})
        self.assertNotEqual(handle, "alice")
        self.assertEqual(store.require(handle)["prompt_data_index"]["by_key"]["a"]["label"], "Alice")
        self.assertFalse(store.release(handle, "bob"))
        self.assertTrue(store.release(handle, "alice"))
        with self.assertRaises(RUNS.SceneRunError):
            store.require(handle)

    def test_capacity_never_evicts_active_contexts(self):
        store = RUNS.RunContextStore(maximum=2)
        first = store.create("alice", {"by_key": {}, "by_id": {}})
        second = store.create("bob", {"by_key": {}, "by_id": {}})
        with self.assertRaisesRegex(RUNS.SceneRunError, "上限"):
            store.create("charlie", {"by_key": {}, "by_id": {}})
        self.assertEqual(store.require(first)["user_id"], "alice")
        self.assertEqual(store.require(second)["user_id"], "bob")

    def test_nodes_do_not_expose_user_id_inputs(self):
        source = "\n".join(
            (ROOT / "scene_prompt_tools" / filename).read_text(encoding="utf-8")
            for filename in ("prompt.py", "nodes.py", "presets.py")
        )
        self.assertNotIn('"user_id": ("STRING"', source)
        self.assertIn('"run_handle": ("STRING"', source)


if __name__ == "__main__":
    unittest.main()
