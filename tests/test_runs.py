import importlib.util
import unittest
from unittest import mock
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

    def test_claim_is_idempotent_and_active_contexts_stay_until_idle_ttl(self):
        store = RUNS.RunContextStore(maximum=3, prepared_limit=2, active_limit=1, prepared_ttl_seconds=999)
        handle = store.create("alice", {"by_key": {}, "by_id": {}})
        self.assertTrue(store.claim(handle, "alice", "prompt-1"))
        self.assertTrue(store.claim(handle, "alice", "prompt-1"))
        self.assertFalse(store.claim(handle, "alice", "prompt-2"))
        self.assertEqual(store.purge_expired(), [])
        self.assertEqual(store.require(handle)["state"], "active")
        with self.assertRaisesRegex(RUNS.SceneRunError, "実行中または準備済み"):
            store.create("alice", {"by_key": {}, "by_id": {}})

    def test_idle_active_contexts_expire_but_recently_used_contexts_do_not(self):
        expiring = RUNS.RunContextStore(maximum=4, active_idle_ttl_seconds=0)
        old = expiring.create("alice", {"by_key": {}, "by_id": {}})
        self.assertTrue(expiring.claim(old, "alice", "prompt-old"))
        self.assertEqual(expiring.purge_expired(), [(old, "alice")])
        self.assertTrue(expiring.create("alice", {"by_key": {}, "by_id": {}}))

        live = RUNS.RunContextStore(maximum=4, active_idle_ttl_seconds=999)
        handle = live.create("alice", {"by_key": {}, "by_id": {}})
        self.assertTrue(live.claim(handle, "alice", "prompt-live"))
        live.require(handle)
        self.assertEqual(live.purge_expired(), [])

    def test_scene_node_access_refreshes_the_active_idle_deadline(self):
        store = RUNS.RunContextStore(maximum=4, active_idle_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 3, 6, 9, 18]):
            handle = store.create("alice", {"by_key": {}, "by_id": {}})
            store.require(handle)
            self.assertTrue(store.claim(handle, "alice", "prompt-1"))
            store.set_plan(handle, "expand-1", {"rows": []})
            self.assertEqual(store.purge_expired(), [])

    def test_require_rejects_expired_context_before_touching_it(self):
        prepared = RUNS.RunContextStore(maximum=4, prepared_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 11]):
            handle = prepared.create("alice", {"by_key": {}, "by_id": {}})
            with self.assertRaisesRegex(RUNS.SceneRunError, "有効期限"):
                prepared.require(handle)
        with self.assertRaises(RUNS.SceneRunError):
            prepared.require(handle)

        active = RUNS.RunContextStore(maximum=4, active_idle_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 1, 12]):
            handle = active.create("alice", {"by_key": {}, "by_id": {}})
            self.assertTrue(active.claim(handle, "alice", "prompt-1"))
            with self.assertRaisesRegex(RUNS.SceneRunError, "有効期限"):
                active.require(handle)

    def test_claim_cannot_revive_an_expired_prepared_context(self):
        store = RUNS.RunContextStore(maximum=4, prepared_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 11]):
            handle = store.create("alice", {"by_key": {}, "by_id": {}})
            self.assertFalse(store.claim(handle, "alice", "prompt-late"))
        with self.assertRaises(RUNS.SceneRunError):
            store.require(handle)

    def test_prepared_contexts_expire_and_plans_are_expand_specific(self):
        expiring = RUNS.RunContextStore(maximum=4, prepared_ttl_seconds=0)
        old = expiring.create("alice", {"by_key": {}, "by_id": {}})
        self.assertEqual(expiring.purge_expired()[0][0], old)
        store = RUNS.RunContextStore(maximum=4, prepared_ttl_seconds=999)
        handle = store.create("alice", {"by_key": {}, "by_id": {}})
        first = {"rows": [{"row": {"positive_parts": ["A"]}}]}
        second = {"rows": [{"row": {"positive_parts": ["B"]}}]}
        self.assertEqual(store.set_plan(handle, "11", first), first)
        self.assertEqual(store.set_plan(handle, "22", second), second)
        self.assertEqual(store.set_plan(handle, "11", second), first)

    def test_nodes_do_not_expose_user_id_inputs(self):
        source = "\n".join(
            (ROOT / "scene_prompt_tools" / filename).read_text(encoding="utf-8")
            for filename in ("prompt.py", "nodes.py", "presets.py")
        )
        self.assertNotIn('"user_id": ("STRING"', source)
        self.assertIn('"run_handle": ("STRING"', source)


if __name__ == "__main__":
    unittest.main()
