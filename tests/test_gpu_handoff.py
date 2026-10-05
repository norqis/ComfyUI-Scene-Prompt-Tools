"""Ownership, worker boundaries and ON/OFF coordination without GPU access."""
import asyncio
import gc
import heapq
import importlib
import sys
import threading
import types
import unittest
import weakref
from pathlib import Path
from unittest import mock


PACKAGE = "scene_gpu_handoff_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(Path(__file__).resolve().parents[1] / "scene_prompt_tools")]
sys.modules[PACKAGE] = package
gpu = importlib.import_module(PACKAGE + ".gpu_handoff")


class Socket:
    closed = False


def coordinator():
    server = types.SimpleNamespace()
    result = gpu.get_coordinator(server)
    server.sockets = gpu._Sockets({}, result)
    token = gpu._REQUEST_OWNER.set("alice")
    try:
        server.sockets["a"] = Socket()
        server.sockets["b"] = Socket()
    finally:
        gpu._REQUEST_OWNER.reset(token)
    return result


async def until(predicate):
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("The coordinated operation did not reach its expected state.")


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_off_requests_are_shared_no_control_and_epoch_changes_only_at_actual_completion(self):
        owner = coordinator()
        async with owner.llm_request("alice"):
            self.assertEqual(owner.gate.shared, 1)
            self.assertFalse(owner.gate.exclusive)
            self.assertEqual(owner.epoch, 0)
            gpu.note_llm_request()
            self.assertEqual(owner.epoch, 1)
        self.assertEqual(owner.gate.shared, 0)
        self.assertFalse(owner.controls)

    async def test_writer_priority_blocks_new_off_requests_until_operation_ends(self):
        owner = coordinator()
        await owner.gate.acquire_async()
        begin = asyncio.create_task(owner.gate.acquire_async(True))
        await until(lambda: owner.gate.writers == 1)
        off = asyncio.create_task(owner.gate.acquire_async())
        await asyncio.sleep(0)
        self.assertFalse(off.done())
        owner.gate.release(False)
        await begin
        self.assertFalse(off.done())
        owner.gate.release(True)
        await off
        owner.gate.release(False)
        self.assertFalse(owner.gate.waiters)

    async def test_exclusive_owners_keep_fifo_order_and_cancellation_removes_waiters(self):
        gate = gpu.Gate()
        await gate.acquire_async()
        first = asyncio.create_task(gate.acquire_async(True))
        await until(lambda: gate.writers == 1)
        cancelled = asyncio.create_task(gate.acquire_async(True))
        second = asyncio.create_task(gate.acquire_async(True))
        await until(lambda: gate.writers == 3)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        gate.release(False)
        await first
        self.assertFalse(second.done())
        gate.release(True)
        await second
        gate.release(True)
        self.assertFalse(gate.writer_queue)
        self.assertFalse(gate.waiters)

    async def test_begin_waits_image_then_worker_ack_and_session_covers_multiple_requests(self):
        owner = coordinator()
        events = []
        queue = types.SimpleNamespace(set_flag=lambda *_args: events.append("wake"))
        owner.server.prompt_queue = queue
        class Executor:
            def reset(self):
                events.append("reset")
        executor = Executor()
        owner.executors.add(executor)
        await owner.gate.acquire_async()
        begin = asyncio.create_task(owner.begin_session("alice", "a", {"model": "snapshot"}, object()))
        await until(lambda: owner.gate.writers == 1)
        self.assertFalse(events)
        owner.gate.release(False)
        await until(lambda: bool(owner.controls))
        self.assertEqual(events, ["wake"])
        management = types.ModuleType("comfy.model_management")
        management.unload_all_models = lambda: events.append("unload")
        management.soft_empty_cache = lambda: events.append("empty")
        comfy = types.ModuleType("comfy")
        comfy.model_management = management
        with mock.patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": management}), mock.patch.object(gpu.gc, "collect", side_effect=lambda: events.append("gc")):
            owner.service_controls()
        session_id = await begin
        self.assertEqual(events, ["wake", "reset", "unload", "gc", "empty"])
        images = asyncio.create_task(owner.gate.acquire_async())
        async with owner.llm_request("alice", session_id, "a") as session:
            self.assertEqual(session.settings["model"], "snapshot")
            gpu.note_llm_request()
        async with owner.llm_request("alice", session_id, "a"):
            self.assertTrue(owner.gate.exclusive)
        self.assertFalse(images.done())
        owner.end_session(session_id, "alice", client_id="a")
        await images
        owner.gate.release(False)
        self.assertFalse(owner.sessions)

    async def test_disconnect_cancels_pending_begin_and_releases_socket_references(self):
        owner = coordinator()
        socket = owner.server.sockets["a"]
        reference = weakref.ref(socket)
        policy_id = owner.prepare("alice", "a", {"api_key": "private"})
        await owner.gate.acquire_async()
        begin = asyncio.create_task(owner.begin_session("alice", "a", {}, object()))
        await until(lambda: owner.gate.writers == 1)
        owner.server.sockets.pop("a")
        with self.assertRaises(asyncio.CancelledError):
            await begin
        owner.gate.release(False)
        self.assertNotIn(policy_id, owner.policies)
        self.assertFalse(owner.sessions)
        self.assertNotIn("a", owner.socket_owners)
        del socket, begin
        # Older asyncio retains the completed task until its wakeup callback retires.
        await asyncio.sleep(0)
        gc.collect()
        self.assertIsNone(reference())

    async def test_repeated_end_and_disconnect_during_worker_release_keep_exclusive_until_real_completion(self):
        class CountingTask(asyncio.Task):
            cancel_requests = 0

            def cancel(self, *args, **kwargs):
                self.cancel_requests += 1
                return super().cancel(*args, **kwargs)

        owner = coordinator()
        owner.server.prompt_queue = types.SimpleNamespace(set_flag=lambda *_args: None)
        started, finish = threading.Event(), threading.Event()
        management = types.ModuleType("comfy.model_management")
        def unload():
            started.set()
            if not finish.wait(5):
                raise AssertionError("The test did not finish its worker control")
        management.unload_all_models = unload
        management.soft_empty_cache = lambda: None
        comfy = types.ModuleType("comfy")
        comfy.model_management = management
        with mock.patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": management}):
            begin = CountingTask(owner.begin_session("alice", "a", {}, None))
            await until(lambda: bool(owner.controls))
            worker = asyncio.create_task(asyncio.to_thread(owner.service_controls))
            await until(started.is_set)
            session_id = next(iter(owner.sessions))
            owner.end_session(session_id, "alice", client_id="a")
            await asyncio.sleep(0)
            owner.end_session(session_id, "alice", client_id="a")
            owner.server.sockets.pop("a")
            await asyncio.sleep(0)
            self.assertEqual(begin.cancel_requests, 1)
            self.assertTrue(owner.gate.exclusive)
            off = asyncio.create_task(owner.gate.acquire_async())
            await asyncio.sleep(0)
            self.assertFalse(off.done())
            finish.set()
            await worker
            with self.assertRaises(asyncio.CancelledError):
                await begin
            await off
            owner.gate.release(False)
        self.assertFalse(owner.sessions)
        self.assertFalse(owner.controls)

    async def test_policy_ownership_snapshot_and_queued_retirement(self):
        owner = coordinator()
        settings = {"model": "first", "api_key": "secret"}
        policy_id = owner.prepare("alice", "a", settings, continuous=True)
        settings["model"] = "changed"
        self.assertEqual(owner.policy(policy_id, "alice", "a").settings["model"], "first")
        for user, client in (("bob", "a"), ("alice", "b")):
            with self.assertRaises(gpu.HandoffError) as caught:
                owner.policy(policy_id, user, client)
            self.assertEqual(caught.exception.status, 403)
        owner.admit("queued", policy_id, "alice", "a")
        owner.server.sockets.pop("a")
        self.assertIn(policy_id, owner.policies)
        self.assertTrue(owner.policies[policy_id].retired)
        owner.finish_prompt("queued")
        self.assertFalse(owner.policies)
        self.assertFalse(owner.prompt_policies)

    async def test_continuous_release_reuses_epoch_and_actual_request_invalidates_it(self):
        owner = coordinator()
        policy_id = owner.prepare("alice", "a", {"model": "first"}, continuous=True)
        unload = mock.AsyncMock(return_value={"released": True})
        resource = types.ModuleType(PACKAGE + ".llm_resources")
        resource.unload_llm = unload
        with mock.patch.dict(sys.modules, {PACKAGE + ".llm_resources": resource}):
            for prompt_id in ("first", "second"):
                owner.admit(prompt_id, policy_id, "alice", "a")
                await asyncio.to_thread(owner.start_image, (0, prompt_id, {}, {}, []), prompt_id)
                self.assertTrue(owner.gate.exclusive)
                owner.finish_image(prompt_id)
            self.assertEqual(unload.await_count, 1)
            async with owner.llm_request("alice"):
                gpu.note_llm_request()
            owner.admit("third", policy_id, "alice", "a")
            await asyncio.to_thread(owner.start_image, (0, "third", {}, {}, []), "third")
            owner.finish_image("third")
            self.assertEqual(unload.await_count, 2)
        owner.retire_policy(policy_id)
        self.assertFalse(owner.policies)

    async def test_false_release_and_provider_failure_are_execution_failures(self):
        owner = coordinator()
        for result in ({"released": False, "already_unloaded": False}, RuntimeError("busy")):
            policy_id = owner.prepare("alice", "a", {})
            owner.admit("failure", policy_id, "alice", "a")
            resource = types.ModuleType(PACKAGE + ".llm_resources")
            resource.unload_llm = mock.AsyncMock(side_effect=result) if isinstance(result, Exception) else mock.AsyncMock(return_value=result)
            with mock.patch.dict(sys.modules, {PACKAGE + ".llm_resources": resource}):
                await asyncio.to_thread(owner.start_image, (0, "failure", {}, {}, []), "failure")
            self.assertIn("failure", owner.failures)
            owner.finish_image("failure")
            self.assertFalse(owner.gate.exclusive)
            self.assertFalse(owner.policies)

    async def test_interrupt_pending_image_unblocks_without_nodes_or_exclusive_release(self):
        owner = coordinator()
        await owner.gate.acquire_async(True)
        image = asyncio.create_task(asyncio.to_thread(owner.start_image, (0, "image", {}, {}, []), 1))
        await until(lambda: "image" in owner.waiting_images)
        owner.interrupt_waiting_images()
        await image
        self.assertIs(owner.failures["image"], False)
        owner.finish_image(1)
        self.assertTrue(owner.gate.exclusive)
        owner.gate.release(True)
        self.assertFalse(owner.image_leases)

    async def test_interrupt_cancels_provider_unload_and_keeps_worker_alive(self):
        owner = coordinator()
        policy_id = owner.prepare("alice", "a", {})
        owner.admit("image", policy_id, "alice", "a")
        resource = types.ModuleType(PACKAGE + ".llm_resources")
        async def unload(_settings):
            await asyncio.Event().wait()
        resource.unload_llm = unload
        with mock.patch.dict(sys.modules, {PACKAGE + ".llm_resources": resource}):
            image = asyncio.create_task(asyncio.to_thread(owner.start_image, (0, "image", {}, {}, []), 1))
            await until(lambda: bool(owner.unload_tasks))
            owner.interrupt_waiting_images()
            await image
        self.assertIs(owner.failures["image"], False)
        owner.finish_image(1)
        self.assertFalse(owner.gate.exclusive)
        self.assertFalse(owner.unload_tasks)

    async def test_end_cancels_inflight_and_holds_lease_until_request_finally(self):
        owner = coordinator()
        await owner.gate.acquire_async(True)
        socket = owner.server.sockets["a"]
        owner.sessions["session"] = gpu.Session("alice", "a", socket, {}, None, None, active=True)
        entered = asyncio.Event()
        async def request():
            async with owner.llm_request("alice", "session", "a"):
                entered.set()
                await asyncio.Event().wait()
        operation = asyncio.create_task(request())
        await entered.wait()
        with self.assertRaises(gpu.HandoffError):
            owner.require_session("session", "alice", "b")
        owner.end_session("session", "alice", client_id="a")
        self.assertTrue(owner.gate.exclusive)
        with self.assertRaises(asyncio.CancelledError):
            await operation
        self.assertFalse(owner.gate.exclusive)
        self.assertFalse(owner.sessions)

    async def test_request_failure_ends_operation_and_release_failure_cannot_leak_exclusive(self):
        owner = coordinator()
        with mock.patch.object(owner, "release_comfy", new=mock.AsyncMock(side_effect=gpu.HandoffError("unload failed", 502))):
            with self.assertRaises(gpu.HandoffError):
                await owner.begin_session("alice", "a", {}, None)
        self.assertFalse(owner.sessions)
        self.assertFalse(owner.gate.exclusive)
        with mock.patch.object(owner, "release_comfy", new=mock.AsyncMock()):
            session_id = await owner.begin_session("alice", "a", {}, None)
        with self.assertRaises(ValueError):
            async with owner.llm_request("alice", session_id, "a"):
                raise ValueError("service failed")
        self.assertFalse(owner.sessions)
        self.assertFalse(owner.gate.exclusive)


class WorkerHookTests(unittest.TestCase):
    def setUp(self):
        self.owner = coordinator()
        self.execution = types.ModuleType("execution")
        events = self.events = []
        class Executor:
            def __init__(self, server):
                self.server = server
                self.reset()
            def reset(self):
                events.append("reset")
                self.success = True
                self.status_messages = []
            def execute(self, prompt, prompt_id, extra_data, outputs):
                events.append("node")
                self.history_result = {"outputs": {}}
            def add_message(self, event, data, broadcast):
                self.status_messages.append((event, data))
        class Queue:
            def __init__(self, server):
                self.server = server
                self.mutex = threading.RLock()
                self.queue, self.history = [], {}
            def put(self, item):
                heapq.heappush(self.queue, item)
            def get(self, timeout=None):
                if getattr(self, "fail_if_get", False):
                    raise AssertionError("A pending worker control must be serviced before the native get can sleep")
                return (heapq.heappop(self.queue), 1) if self.queue else None
            def task_done(self, item_id, result, status=None):
                events.append("task_done")
                self.history[item_id] = (result, status)
            def wipe_queue(self):
                self.queue.clear()
            def delete_queue_item(self, function):
                for index, item in enumerate(self.queue):
                    if function(item):
                        self.queue.pop(index)
                        return True
                return False
        self.execution.PromptExecutor = Executor
        self.execution.PromptQueue = Queue
        self.nodes = types.ModuleType("nodes")
        self.nodes.interrupt_processing = lambda value=True: None
        self.modules = mock.patch.dict(sys.modules, {"execution": self.execution, "nodes": self.nodes,
            "server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=self.owner.server))})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        gpu._install_execution_hooks()
        self.executor = Executor(self.owner.server)
        self.queue = self.owner.server.prompt_queue = Queue(self.owner.server)
        self.events.clear()

    def test_off_worker_retains_lease_through_task_done_and_uses_weak_executor_refs(self):
        self.queue.put((0, "off", {}, {}, []))
        item, item_id = self.queue.get()
        self.executor.execute(item[2], item[1], item[3], item[4])
        self.assertEqual(self.owner.gate.shared, 1)
        self.queue.task_done(item_id, self.executor.history_result)
        self.assertEqual(self.events, ["node", "task_done"])
        self.assertEqual(self.owner.gate.shared, 0)
        reference = weakref.ref(self.executor)
        self.executor = None
        gc.collect()
        self.assertIsNone(reference())
        self.assertFalse(self.owner.executors)

    def test_unbound_off_submission_does_not_iterate_existing_queue_or_running_items(self):
        class QueueWithoutIteration(list):
            def __iter__(self):
                raise AssertionError("An unbound OFF submission must not scan the pending queue")
        class RunningWithoutIteration(dict):
            def values(self):
                raise AssertionError("An unbound OFF submission must not scan running items")
        self.queue.queue = QueueWithoutIteration([(0, "existing", {}, {}, [])])
        self.queue.currently_running = RunningWithoutIteration()
        self.queue.put((1, "off", {}, {}, []))
        self.assertEqual(len(self.queue.queue), 2)
        self.assertFalse(self.owner.prompt_policies)

    def test_pending_control_is_serviced_even_after_native_flags_consumed_its_wake(self):
        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)
        future = loop.create_future()
        self.owner.controls.append(future)
        self.queue.fail_if_get = True
        management = types.ModuleType("comfy.model_management")
        management.unload_all_models = lambda: self.events.append("unload")
        management.soft_empty_cache = lambda: self.events.append("empty")
        comfy = types.ModuleType("comfy")
        comfy.model_management = management
        with mock.patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": management}), mock.patch.object(gpu.gc, "collect", side_effect=lambda: self.events.append("gc")):
            self.assertIsNone(self.queue.get(timeout=1000))
        loop.run_until_complete(asyncio.sleep(0))
        self.assertIsNone(future.result())
        self.assertEqual(self.events, ["reset", "unload", "gc", "empty"])
        self.assertFalse(self.owner.controls)

    def test_duplicate_prompt_id_cannot_steal_private_binding(self):
        policy_id = self.owner.prepare("alice", "a", {})
        token = gpu._ADMISSION.set((policy_id, "alice", "a"))
        try:
            self.queue.put((0, "same", {}, {gpu.POLICY_KEY: policy_id}, []))
        finally:
            gpu._ADMISSION.reset(token)
        with self.assertRaises(gpu.HandoffError):
            self.queue.put((1, "same", {}, {}, []))
        self.assertEqual(len(self.queue.queue), 1)
        self.queue.wipe_queue()
        self.assertFalse(self.owner.policies)

    def test_token_removed_before_queue_and_deleted_or_wiped_policy_reclaimed(self):
        for delete in (True, False):
            policy_id = self.owner.prepare("alice", "a", {"api_key": "secret"})
            item = (0, "private", {}, {gpu.POLICY_KEY: policy_id}, [])
            token = gpu._ADMISSION.set((policy_id, "alice", "a"))
            try:
                self.queue.put(item)
            finally:
                gpu._ADMISSION.reset(token)
            self.assertNotIn(policy_id, str(self.queue.queue))
            self.assertNotIn("secret", str(self.queue.queue))
            if delete:
                self.queue.delete_queue_item(lambda queued: queued[1] == "private")
            else:
                self.queue.wipe_queue()
            self.assertFalse(self.owner.policies)
            self.assertFalse(self.owner.prompt_policies)

    def test_failure_writes_status_without_nodes_and_next_worker_job_succeeds(self):
        self.owner.failures["bad"] = "busy"
        self.queue.put((0, "bad", {"node": {"class_type": "Loader"}}, {"client_id": "a"}, []))
        item, item_id = self.queue.get()
        self.executor.execute(item[2], item[1], item[3], item[4])
        self.assertFalse(self.executor.success)
        self.assertEqual([message[0] for message in self.executor.status_messages], ["execution_start", "execution_error"])
        self.assertNotIn("node", self.events)
        self.queue.task_done(item_id, self.executor.history_result)
        self.queue.put((0, "good", {}, {}, []))
        item, item_id = self.queue.get()
        self.executor.execute(item[2], item[1], item[3], item[4])
        self.queue.task_done(item_id, self.executor.history_result)
        self.assertIn("node", self.events)
        self.assertFalse(self.owner.failures)


if __name__ == "__main__":
    unittest.main()
