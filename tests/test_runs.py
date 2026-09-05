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
        handle = store.create("alice")
        self.assertNotEqual(handle, "alice")
        self.assertEqual(store.require(handle)["user_id"], "alice")
        self.assertFalse(store.release(handle, "bob"))
        self.assertTrue(store.release(handle, "alice"))
        with self.assertRaises(RUNS.SceneRunError):
            store.require(handle)

    def test_create_has_no_plugin_imposed_context_limit(self):
        store = RUNS.RunContextStore()
        handles = [store.create("alice") for _ in range(300)]
        for handle in handles:
            self.assertEqual(store.require(handle)["user_id"], "alice")

    def test_create_purges_expired_entries(self):
        expired = []
        store = RUNS.RunContextStore(
            prepared_ttl_seconds=10,
            expiration_callback=lambda handle, user_id: expired.append((handle, user_id)),
        )
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 11, 11]):
            old = store.create("alice")
            fresh = store.create("alice")
        self.assertNotEqual(old, fresh)
        self.assertEqual(expired, [(old, "alice")])
        self.assertEqual(store._entries[fresh]["user_id"], "alice")

    def test_claim_is_idempotent_and_active_contexts_stay_until_idle_ttl(self):
        store = RUNS.RunContextStore(prepared_ttl_seconds=999)
        handle = store.create("alice")
        self.assertTrue(store.claim(handle, "alice", "prompt-1"))
        self.assertTrue(store.claim(handle, "alice", "prompt-1"))
        self.assertFalse(store.claim(handle, "alice", "prompt-2"))
        self.assertEqual(store.purge_expired(), [])
        self.assertEqual(store.require(handle)["state"], "active")
        self.assertTrue(store.create("alice"))

    def test_reconcile_releases_stale_ordinary_active_contexts(self):
        store = RUNS.RunContextStore()
        stale = store.create("alice")
        self.assertTrue(store.claim(stale, "alice", "finished-prompt"))

        self.assertEqual(store.reconcile_active(set()), [(stale, "alice")])
        self.assertTrue(store.create("alice"))
        with self.assertRaises(RUNS.SceneRunError):
            store.require(stale)

    def test_reconcile_preserves_live_running_and_pending_contexts(self):
        store = RUNS.RunContextStore()
        running = store.create("alice")
        pending = store.create("alice")
        self.assertTrue(store.claim(running, "alice", "running-prompt"))
        self.assertTrue(store.claim(pending, "alice", "pending-prompt"))

        self.assertEqual(store.reconcile_active({"running-prompt", "pending-prompt"}), [])
        self.assertEqual(store.require(running)["state"], "active")
        self.assertEqual(store.require(pending)["state"], "active")

    def test_reconcile_preserves_continuous_contexts_between_jobs(self):
        store = RUNS.RunContextStore()
        handle = store.create("alice", continuous=True)
        self.assertTrue(store.claim(handle, "alice", "completed-batch-item"))

        self.assertEqual(store.reconcile_active(set()), [])
        self.assertEqual(store.require(handle)["state"], "active")

    def test_reconcile_keeps_live_contexts_without_limit_errors(self):
        store = RUNS.RunContextStore()
        first = store.create("alice")
        second = store.create("alice")
        self.assertTrue(store.claim(first, "alice", "running"))
        self.assertTrue(store.claim(second, "alice", "pending"))

        self.assertEqual(store.reconcile_active({"running", "pending"}), [])
        self.assertTrue(store.create("alice"))

    def test_idle_active_contexts_expire_but_recently_used_contexts_do_not(self):
        expiring = RUNS.RunContextStore(active_idle_ttl_seconds=0)
        old = expiring.create("alice")
        self.assertTrue(expiring.claim(old, "alice", "prompt-old"))
        self.assertEqual(expiring.purge_expired(), [(old, "alice")])
        self.assertTrue(expiring.create("alice"))

        live = RUNS.RunContextStore(active_idle_ttl_seconds=999)
        handle = live.create("alice")
        self.assertTrue(live.claim(handle, "alice", "prompt-live"))
        live.require(handle)
        self.assertEqual(live.purge_expired(), [])

    def test_scene_node_access_refreshes_the_active_idle_deadline(self):
        store = RUNS.RunContextStore(active_idle_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 3, 6, 9, 18]):
            handle = store.create("alice")
            store.require(handle)
            self.assertTrue(store.claim(handle, "alice", "prompt-1"))
            store.set_plan(handle, "expand-1", {"rows": []})
            self.assertEqual(store.purge_expired(), [])

    def test_require_rejects_expired_context_before_touching_it(self):
        prepared = RUNS.RunContextStore(prepared_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 11]):
            handle = prepared.create("alice")
            with self.assertRaisesRegex(RUNS.SceneRunError, "有効期限"):
                prepared.require(handle)
        with self.assertRaises(RUNS.SceneRunError):
            prepared.require(handle)

    def test_continuous_prepared_context_can_wait_past_the_ordinary_ttl(self):
        store = RUNS.RunContextStore(prepared_ttl_seconds=10, active_idle_ttl_seconds=100)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 11]):
            handle = store.create("alice", continuous=True)
            self.assertEqual(store.require(handle)["state"], "prepared")

        active = RUNS.RunContextStore(active_idle_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 1, 12]):
            handle = active.create("alice")
            self.assertTrue(active.claim(handle, "alice", "prompt-1"))
            with self.assertRaisesRegex(RUNS.SceneRunError, "有効期限"):
                active.require(handle)

    def test_claim_cannot_revive_an_expired_prepared_context(self):
        store = RUNS.RunContextStore(prepared_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 11]):
            handle = store.create("alice")
            self.assertFalse(store.claim(handle, "alice", "prompt-late"))
        with self.assertRaises(RUNS.SceneRunError):
            store.require(handle)

    def test_every_expiration_path_notifies_exactly_once(self):
        expired = []
        store = RUNS.RunContextStore(
            prepared_ttl_seconds=10,
            expiration_callback=lambda handle, user_id: expired.append((handle, user_id)),
        )
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 0, 0, 11, 11, 11]):
            required = store.create("alice")
            claimed = store.create("bob")
            purged = store.create("carol")
            with self.assertRaisesRegex(RUNS.SceneRunError, "有効期限"):
                store.require(required)
            self.assertFalse(store.claim(claimed, "bob", "prompt-late"))
            self.assertEqual(store.purge_expired(), [(purged, "carol")])

        self.assertCountEqual(expired, [(required, "alice"), (claimed, "bob"), (purged, "carol")])
        with self.assertRaises(RUNS.SceneRunError):
            store.require(required)
        self.assertFalse(store.claim(claimed, "bob", "prompt-late"))
        self.assertEqual(store.purge_expired(), [])
        self.assertEqual(len(expired), 3)

    def test_prepared_contexts_expire_and_plans_are_expand_specific(self):
        expiring = RUNS.RunContextStore(prepared_ttl_seconds=0)
        old = expiring.create("alice")
        self.assertEqual(expiring.purge_expired()[0][0], old)
        store = RUNS.RunContextStore(prepared_ttl_seconds=999)
        handle = store.create("alice")
        first = {"rows": [{"row": {"positive_parts": ["A"]}}]}
        second = {"rows": [{"row": {"positive_parts": ["B"]}}]}
        self.assertEqual(store.set_plan(handle, "11", first), first)
        self.assertEqual(store.set_plan(handle, "22", second), second)
        self.assertEqual(store.set_plan(handle, "11", second), first)

    def test_get_plan_touches_and_copies_while_peek_expires_once(self):
        expired = []
        store = RUNS.RunContextStore(
            prepared_ttl_seconds=10,
            expiration_callback=lambda handle, user_id: expired.append((handle, user_id)),
        )
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 5, 5, 16]):
            handle = store.create("alice")
            source = {"rows": [{"row": {"positive_parts": ["A"]}}]}
            store.set_plan(handle, "expand", source)
            source["rows"][0]["row"]["positive_parts"].append("changed")
            cached = store.get_plan(handle, "expand")
            cached["rows"][0]["row"]["positive_parts"].append("returned")
            self.assertEqual(store._entries[handle]["plans"]["expand"]["rows"][0]["row"]["positive_parts"], ["A"])
            with self.assertRaisesRegex(RUNS.SceneRunError, "有効期限"):
                store.peek(handle)
        self.assertEqual(expired, [(handle, "alice")])
        with self.assertRaises(RUNS.SceneRunError):
            store.peek(handle)
        self.assertEqual(expired, [(handle, "alice")])

    def test_get_run_user_id_does_not_touch_or_copy_plans(self):
        store = RUNS.RunContextStore(prepared_ttl_seconds=10)
        with mock.patch.object(RUNS.time, "monotonic", side_effect=[0, 1, 5]):
            handle = store.create("alice")
            store.set_plan(handle, "expand", {"rows": [{"row": {"positive_parts": ["A"]}}]})
            before_access = store._entries[handle]["last_access"]
            with mock.patch.object(RUNS.copy, "deepcopy", side_effect=AssertionError("must not copy")):
                self.assertEqual(store.get_user_id(handle), "alice")
        self.assertEqual(store._entries[handle]["last_access"], before_access)

    def test_internal_plan_reference_is_read_only_for_scene_node_consumers(self):
        store = RUNS.RunContextStore(prepared_ttl_seconds=999)
        handle = store.create("alice")
        stored = store.set_plan_reference(handle, "expand", {"rows": [{"row": {"positive_parts": ["A"]}}]})
        with mock.patch.object(RUNS.copy, "deepcopy", side_effect=AssertionError("must not copy")):
            self.assertIs(store.get_plan_reference(handle, "expand"), stored)
        editable = store.get_plan(handle, "expand")
        editable["rows"][0]["row"]["positive_parts"].append("changed")
        self.assertEqual(stored["rows"][0]["row"]["positive_parts"], ["A"])

    def test_nodes_do_not_expose_user_id_inputs(self):
        source = "\n".join(
            (ROOT / "scene_prompt_tools" / filename).read_text(encoding="utf-8")
            for filename in ("prompt.py", "nodes.py", "presets.py")
        )
        self.assertNotIn('"user_id": ("STRING"', source)
        self.assertIn('"run_handle": ("STRING"', source)


if __name__ == "__main__":
    unittest.main()
