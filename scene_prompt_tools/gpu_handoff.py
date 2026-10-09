"""Server-wide GPU handoff at ComfyUI's worker boundary.

Private policies never enter Comfy's queue/history. The worker owns executor
cache resets, and keeps image leases until task_done has consumed its result.
"""
from __future__ import annotations

import asyncio
import contextvars
import copy
import gc
import secrets
import threading
import weakref
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from itertools import chain


RELEASE_COMFY = "ScenePrompt.ReleaseComfyBeforeLLM"
RELEASE_LLM = "ScenePrompt.ReleaseLLMBeforeImage"
POLICY_KEY = "scene_gpu_policy"
_REQUEST_OWNER = contextvars.ContextVar("scene_gpu_request_owner", default=None)
_ADMISSION = contextvars.ContextVar("scene_gpu_admission", default=None)


class HandoffError(ValueError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


class Gate:
    """Shared work proceeds immediately until an exclusive owner is waiting."""
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.shared = 0
        self.exclusive = False
        self.writers = 0
        self.writer_queue = deque()
        self.waiters = set()
        self.revision = 0

    def _available(self, exclusive, ticket=None):
        return not self.exclusive and (self.shared == 0 and self.writer_queue[0] is ticket if exclusive else self.writers == 0)

    def _wake(self):
        self.revision += 1
        self.condition.notify_all()
        for future in tuple(self.waiters):
            future.get_loop().call_soon_threadsafe(self._signal, future)

    @staticmethod
    def _signal(future):
        if not future.done():
            future.set_result(None)

    def notify(self):
        with self.condition:
            self._wake()

    def release(self, exclusive):
        with self.condition:
            if exclusive:
                self.exclusive = False
            else:
                self.shared -= 1
            self._wake()

    async def acquire_async(self, exclusive=False):
        ticket = object() if exclusive else None
        with self.condition:
            self.writers += int(exclusive)
            if exclusive:
                self.writer_queue.append(ticket)
        try:
            while True:
                with self.condition:
                    if self._available(exclusive, ticket):
                        if exclusive:
                            self.exclusive = True
                        else:
                            self.shared += 1
                        return
                    future = asyncio.get_running_loop().create_future()
                    self.waiters.add(future)
                try:
                    await future
                finally:
                    with self.condition:
                        self.waiters.discard(future)
        finally:
            with self.condition:
                self.writers -= int(exclusive)
                if exclusive:
                    self.writer_queue.remove(ticket)
                self._wake()

    def acquire_worker(self, exclusive=False, service_controls=None, cancelled=None):
        ticket = object() if exclusive else None
        with self.condition:
            self.writers += int(exclusive)
            if exclusive:
                self.writer_queue.append(ticket)
        try:
            while True:
                with self.condition:
                    revision = self.revision
                if service_controls is not None:
                    service_controls()
                with self.condition:
                    if cancelled is not None and cancelled():
                        return False
                    if self._available(exclusive, ticket):
                        if exclusive:
                            self.exclusive = True
                        else:
                            self.shared += 1
                        return True
                    if revision != self.revision:
                        continue
                    self.condition.wait()
        finally:
            with self.condition:
                self.writers -= int(exclusive)
                if exclusive:
                    self.writer_queue.remove(ticket)
                self._wake()


@dataclass
class Policy:
    user_id: str
    client_id: str
    socket: object
    settings: dict
    continuous: bool = False
    run_handle: str = ""
    prompts: set = field(default_factory=set)
    retired: bool = False


@dataclass
class Session:
    user_id: str
    client_id: str
    socket: object
    settings: dict
    state: object
    begin_task: object
    active: bool = False
    closing: bool = False
    requests: set = field(default_factory=set)


class _Sockets(dict):
    def __init__(self, values, coordinator):
        super().__init__(values)
        self.coordinator = coordinator

    def __setitem__(self, key, socket):
        old = self.get(key)
        if old is not None and old is not socket:
            self.coordinator.disconnect_socket(old)
        super().__setitem__(key, socket)
        self.coordinator.socket_owners[key] = (_REQUEST_OWNER.get(), socket)

    def pop(self, key, *default):
        result = super().pop(key, *default)
        self.coordinator.socket_owners.pop(key, None)
        if result is not None:
            self.coordinator.disconnect_socket(result)
        return result

    def __delitem__(self, key):
        self.pop(key)

    def clear(self):
        for key in list(self):
            self.pop(key)


class Coordinator:
    def __init__(self, server):
        self.server = server
        self.gate = Gate()
        self.lock = threading.RLock()
        self.executors = weakref.WeakSet()
        self.policies = {}
        self.sessions = {}
        self.socket_owners = {}
        self.prompt_policies = {}
        self.image_leases = {}
        self.failures = {}
        self.controls = deque()
        self.waiting_images = set()
        self.unload_tasks = {}

    def owner_socket(self, user_id, client_id):
        owner = self.socket_owners.get(client_id)
        if not client_id or owner is None or owner[0] != user_id or owner[1].closed:
            raise HandoffError("The ComfyUI client connection is missing or belongs to another user.", 403)
        return owner[1]

    def disconnect_socket(self, socket):
        # Comfy's native websocket finally/reconnect paths remove the actual
        # socket from this dictionary. No additional polling task is needed.
        with self.lock:
            policies = [key for key, value in self.policies.items() if value.socket is socket]
            sessions = [key for key, value in self.sessions.items() if value.socket is socket]
        for key in policies:
            self.retire_policy(key)
        for key in sessions:
            self.end_session(key)

    def prepare(self, user_id, client_id, settings, *, continuous=False, run_handle=""):
        socket = self.owner_socket(user_id, client_id)
        if run_handle:
            from .runs import get_run_delivery_context, get_run_user_id
            if get_run_user_id(run_handle) != user_id or (get_run_delivery_context(run_handle) or {}).get("client_id") != client_id:
                raise HandoffError("The run context belongs to another client.", 403)
        policy_id = secrets.token_urlsafe(24)
        with self.lock:
            self.policies[policy_id] = Policy(user_id, client_id, socket, copy.deepcopy(settings), bool(continuous), run_handle)
        return policy_id

    def policy(self, policy_id, user_id, client_id=None):
        if not isinstance(policy_id, str) or not policy_id:
            raise HandoffError("The GPU policy is missing or has been released.", 404)
        with self.lock:
            policy = self.policies.get(policy_id)
            if policy is None or policy.retired:
                raise HandoffError("The GPU policy is missing or has been released.", 404)
            if policy.user_id != user_id or (client_id is not None and policy.client_id != client_id):
                raise HandoffError("The GPU policy belongs to another client.", 403)
            if policy.socket.closed or self.owner_socket(user_id, policy.client_id) is not policy.socket:
                raise HandoffError("The GPU policy client has disconnected.", 409)
            return policy

    def retire_policy(self, policy_id, user_id=None, *, client_id=None):
        with self.lock:
            policy = self.policies.get(policy_id)
            if policy is None:
                return False
            if user_id is not None and policy.user_id != user_id:
                raise HandoffError("The GPU policy belongs to another client.", 403)
            if client_id is not None and policy.client_id != client_id:
                raise HandoffError("The GPU policy belongs to another client.", 403)
            policy.retired = True
            if not policy.prompts:
                self.policies.pop(policy_id, None)
            return True

    def admit(self, prompt_id, policy_id, user_id, client_id):
        policy = self.policy(policy_id, user_id, client_id)
        with self.lock:
            if not policy.continuous and policy.prompts:
                raise HandoffError("This GPU policy already belongs to a submitted prompt.")
            if prompt_id in self.prompt_policies:
                raise HandoffError("The prompt already has a GPU policy.")
            policy.prompts.add(prompt_id)
            self.prompt_policies[prompt_id] = policy_id

    def finish_prompt(self, prompt_id):
        with self.lock:
            policy_id = self.prompt_policies.pop(prompt_id, None)
            policy = self.policies.get(policy_id)
            if policy is not None:
                policy.prompts.discard(prompt_id)
                if not policy.continuous or policy.retired:
                    if not policy.prompts:
                        self.policies.pop(policy_id, None)
            self.failures.pop(prompt_id, None)
            self.waiting_images.discard(prompt_id)

    async def begin_session(self, user_id, client_id, settings, state):
        socket = self.owner_socket(user_id, client_id)
        with self.lock:
            if any(value.user_id == user_id and value.client_id == client_id for value in self.sessions.values()):
                raise HandoffError("This client already has a prompt-generation operation.")
            session_id = secrets.token_urlsafe(24)
            session = Session(user_id, client_id, socket, copy.deepcopy(settings), state, asyncio.current_task())
            self.sessions[session_id] = session
        acquired = False
        try:
            await self.gate.acquire_async(exclusive=True)
            acquired = True
            await self.release_comfy()
            session.active = True
            session.begin_task = None
            return session_id
        except BaseException:
            with self.lock:
                self.sessions.pop(session_id, None)
            if acquired:
                self.gate.release(True)
            raise

    async def release_comfy(self):
        future = asyncio.get_running_loop().create_future()
        with self.lock:
            self.controls.append(future)
        self.gate.notify()
        self.server.prompt_queue.set_flag("scene_prompt_gpu_control", True)
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            with self.lock:
                if future in self.controls:
                    self.controls.remove(future)
                    future.cancel()
            if not future.cancelled():
                # Once the worker starts a release, retain the exclusive lease
                # until its real completion, even if the browser disconnects.
                try:
                    await asyncio.shield(future)
                except Exception:
                    pass
            raise
        finally:
            with self.lock:
                if future in self.controls:
                    self.controls.remove(future)

    def service_controls(self):
        """Called only by the ComfyUI worker, including while an item waits."""
        with self.lock:
            pending = list(self.controls)
            self.controls.clear()
        for future in pending:
            if future.cancelled():
                continue
            error = None
            try:
                import comfy.model_management as management
                for executor in list(self.executors):
                    executor.reset()
                management.unload_all_models()
                gc.collect()
                management.soft_empty_cache()
            except Exception:
                error = HandoffError("ComfyUI could not release its models and caches.", 502)
            future.get_loop().call_soon_threadsafe(self._complete_control, future, error)

    @staticmethod
    def _complete_control(future, error):
        if not future.done():
            if error is None:
                future.set_result(None)
            else:
                future.set_exception(error)

    def require_session(self, session_id, user_id, client_id=None):
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None or session.closing or not session.active:
                raise HandoffError("The prompt-generation operation is missing or has ended.", 404)
            if session.user_id != user_id:
                raise HandoffError("The prompt-generation operation belongs to another user.", 403)
            if client_id is not None and session.client_id != client_id:
                raise HandoffError("The prompt-generation operation belongs to another client.", 403)
            if session.socket.closed or self.owner_socket(user_id, session.client_id) is not session.socket:
                raise HandoffError("The prompt-generation client has disconnected.", 409)
            return session

    def end_session(self, session_id, user_id=None, *, client_id=None, current_task=None):
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None:
                return False
            if user_id is not None and session.user_id != user_id:
                raise HandoffError("The prompt-generation operation belongs to another user.", 403)
            if client_id is not None and session.client_id != client_id:
                raise HandoffError("The prompt-generation operation belongs to another client.", 403)
            if not session.closing:
                session.closing = True
                tasks = set(session.requests)
                if session.begin_task is not None:
                    tasks.add(session.begin_task)
                for task in tasks:
                    if task is not current_task:
                        task.cancel()
            if session.active and not session.requests:
                self.sessions.pop(session_id, None)
                session.active = False
                self.gate.release(True)
        return True

    @asynccontextmanager
    async def llm_request(self, user_id, session_id=None, client_id=None):
        session = self.require_session(session_id, user_id, client_id) if session_id else None
        task = asyncio.current_task()
        if session is None:
            await self.gate.acquire_async()
        else:
            session.requests.add(task)
        failed = False
        try:
            yield session
        except BaseException:
            failed = True
            raise
        finally:
            if session is None:
                self.gate.release(False)
            else:
                session.requests.discard(task)
                if failed or session.closing:
                    self.end_session(session_id, current_task=task)

    def start_image(self, item, item_id):
        prompt_id = item[1]
        with self.lock:
            policy = self.policies.get(self.prompt_policies.get(prompt_id))
        exclusive = policy is not None
        with self.lock:
            self.waiting_images.add(prompt_id)
        acquired = self.gate.acquire_worker(exclusive, self.service_controls, lambda: self.failures.get(prompt_id) is False)
        with self.lock:
            self.image_leases[item_id] = (prompt_id, exclusive if acquired else None)
        if policy is not None and acquired:
            try:
                from .llm_resources import unload_llm

                # Another LLM client can reload weights between images. Only
                # the provider's current state can confirm they remain freed.
                async def unload():
                    task = asyncio.current_task()
                    with self.lock:
                        self.unload_tasks[prompt_id] = task
                        cancelled = self.failures.get(prompt_id) is False
                    try:
                        if cancelled:
                            raise asyncio.CancelledError
                        return await unload_llm(copy.deepcopy(policy.settings))
                    finally:
                        with self.lock:
                            self.unload_tasks.pop(prompt_id, None)

                result = asyncio.run(unload())
                if not isinstance(result, dict) or not (result.get("released") or result.get("already_unloaded")):
                    raise HandoffError("The LLM provider did not confirm that its model was released.", 502)
            except asyncio.CancelledError:
                with self.lock:
                    self.failures[prompt_id] = False
            except Exception as exc:
                # Provider errors are sanitized by the resource adapter. No
                # exception may escape the worker's unguarded execute loop.
                with self.lock:
                    self.failures[prompt_id] = str(exc)

    def interrupt_waiting_images(self):
        with self.lock:
            for prompt_id in self.waiting_images:
                self.failures[prompt_id] = False
            for task in list(self.unload_tasks.values()):
                task.get_loop().call_soon_threadsafe(task.cancel)
        self.gate.notify()

    def finish_image(self, item_id):
        with self.lock:
            lease = self.image_leases.pop(item_id, None)
        if lease is not None:
            prompt_id, exclusive = lease
            self.finish_prompt(prompt_id)
            if exclusive is not None:
                self.gate.release(exclusive)


def get_coordinator(server):
    coordinator = getattr(server, "_scene_gpu_handoff", None)
    if coordinator is None:
        coordinator = server._scene_gpu_handoff = Coordinator(server)
    return coordinator


def _failure(executor, prompt, prompt_id, extra_data, message):
    executor.server.client_id = extra_data.get("client_id")
    executor.status_messages = []
    executor.history_result = {"outputs": {}, "meta": {}}
    executor.success = False
    executor._scene_gpu_failed = True
    node_id = next(iter(prompt), "")
    executor.add_message("execution_start", {"prompt_id": prompt_id}, broadcast=False)
    if message is False:
        executor.add_message("execution_interrupted", {"prompt_id": prompt_id, "node_id": node_id,
            "node_type": prompt.get(node_id, {}).get("class_type", ""), "executed": []}, broadcast=True)
        return
    executor.add_message("execution_error", {
        "prompt_id": prompt_id, "node_id": node_id,
        "node_type": prompt.get(node_id, {}).get("class_type", ""),
        "executed": [], "exception_message": message,
        "exception_type": "SceneGPUHandoffError", "traceback": [],
        "current_inputs": {}, "current_outputs": [],
    }, broadcast=False)


def _install_execution_hooks():
    import execution
    if getattr(execution.PromptQueue, "_scene_gpu_hooks", False):
        return
    executor_type = execution.PromptExecutor
    queue_type = execution.PromptQueue
    old_init, old_execute = executor_type.__init__, executor_type.execute
    old_get, old_put, old_done = queue_type.get, queue_type.put, queue_type.task_done
    old_wipe, old_delete = queue_type.wipe_queue, queue_type.delete_queue_item

    def executor_init(executor, server, *args, **kwargs):
        old_init(executor, server, *args, **kwargs)
        coordinator = getattr(server, "_scene_gpu_handoff", None)
        if coordinator is not None:
            coordinator.executors.add(executor)

    def execute(executor, prompt, prompt_id, extra_data=None, execute_outputs=None):
        extra_data = extra_data or {}
        execute_outputs = execute_outputs or []
        coordinator = getattr(executor.server, "_scene_gpu_handoff", None)
        if coordinator is None:
            return old_execute(executor, prompt, prompt_id, extra_data, execute_outputs)
        with coordinator.lock:
            message = coordinator.failures.get(prompt_id)
            queued = any(value[0] == prompt_id for value in coordinator.image_leases.values())
            coordinator.waiting_images.discard(prompt_id)
        if message is not None:
            return _failure(executor, prompt, prompt_id, extra_data, message)
        if getattr(executor, "_scene_gpu_failed", False):
            executor.success = True
            executor._scene_gpu_failed = False
        if queued:
            return old_execute(executor, prompt, prompt_id, extra_data, execute_outputs)
        coordinator.gate.acquire_worker()
        try:
            return old_execute(executor, prompt, prompt_id, extra_data, execute_outputs)
        finally:
            coordinator.gate.release(False)

    def get(queue, *args, **kwargs):
        coordinator = getattr(queue.server, "_scene_gpu_handoff", None)
        if coordinator is None:
            return old_get(queue, *args, **kwargs)
        # A wake flag may have been consumed by main's get_flags after the
        # previous task_done. Check pending work before sleeping. Holding the
        # queue's RLock until Condition.wait atomically releases it also avoids
        # losing a new set_flag between this check and the native wait.
        with queue.mutex:
            with coordinator.lock:
                pending = bool(coordinator.controls)
            item = None if pending else old_get(queue, *args, **kwargs)
        coordinator.service_controls()
        if item is not None:
            coordinator.start_image(*item)
        return item

    def put(queue, item):
        coordinator = getattr(queue.server, "_scene_gpu_handoff", None)
        policy_id = item[3].pop(POLICY_KEY, None)
        admission = _ADMISSION.get()
        with queue.mutex:
            if coordinator is not None:
                with coordinator.lock:
                    bound = item[1] in coordinator.prompt_policies
                if policy_id is not None or bound:
                    live_items = chain(queue.queue, getattr(queue, "currently_running", {}).values())
                    if any(queued[1] == item[1] for queued in live_items):
                        raise HandoffError("This prompt ID already belongs to a queued or running GPU policy.")
            if policy_id is not None:
                if coordinator is None or admission is None or admission[0] != policy_id:
                    raise HandoffError("A GPU policy requires authenticated prompt admission.", 403)
                coordinator.admit(item[1], policy_id, admission[1], admission[2])
            try:
                return old_put(queue, item)
            except BaseException:
                if policy_id is not None:
                    coordinator.finish_prompt(item[1])
                raise

    def done(queue, item_id, *args, **kwargs):
        try:
            return old_done(queue, item_id, *args, **kwargs)
        finally:
            coordinator = getattr(queue.server, "_scene_gpu_handoff", None)
            if coordinator is not None:
                coordinator.finish_image(item_id)

    def queue_edit(queue, operation, *args, **kwargs):
        with queue.mutex:
            # Native deletion of the final pending item calls wipe_queue.
            if getattr(queue, "_scene_queue_editing", False):
                return operation(queue, *args, **kwargs)
            queue._scene_queue_editing = True
            try:
                before = {item[1]: item[3].get("client_id") for item in queue.queue}
                result = operation(queue, *args, **kwargs)
                after = {item[1] for item in queue.queue}
            finally:
                queue._scene_queue_editing = False
        coordinator = getattr(queue.server, "_scene_gpu_handoff", None)
        for prompt_id in before.keys() - after:
            if coordinator is not None:
                with coordinator.lock:
                    policy_id = coordinator.prompt_policies.get(prompt_id)
                if policy_id is not None:
                    coordinator.retire_policy(policy_id)
                coordinator.finish_prompt(prompt_id)
            client_id = before[prompt_id]
            if client_id:
                queue.server.send_sync("scene_prompt_queue_removed", {"prompt_id": prompt_id}, client_id)
        return result

    executor_type.__init__, executor_type.execute = executor_init, execute
    queue_type.get, queue_type.put, queue_type.task_done = get, put, done
    queue_type.wipe_queue = lambda queue: queue_edit(queue, old_wipe)
    queue_type.delete_queue_item = lambda queue, function: queue_edit(queue, old_delete, function)
    queue_type._scene_gpu_hooks = True

    import nodes
    old_interrupt = nodes.interrupt_processing

    def interrupt(value=True):
        old_interrupt(value)
        if value:
            from server import PromptServer
            coordinator = getattr(PromptServer.instance, "_scene_gpu_handoff", None)
            if coordinator is not None:
                coordinator.interrupt_waiting_images()

    nodes.interrupt_processing = interrupt


def install(server):
    """Install once before ComfyUI starts its worker or accepts WebSockets."""
    coordinator = get_coordinator(server)
    if not hasattr(server, "app") or getattr(server, "_scene_gpu_installed", False):
        return coordinator
    from aiohttp import web
    server._scene_gpu_installed = True
    server.sockets = _Sockets(server.sockets, coordinator)

    @web.middleware
    async def admission(request, handler):
        path = request.path.removeprefix("/api")
        if path == "/ws":
            token = _REQUEST_OWNER.set(server.user_manager.get_request_user_id(request))
            try:
                return await handler(request)
            finally:
                _REQUEST_OWNER.reset(token)
        if path != "/prompt" or request.method != "POST":
            return await handler(request)
        payload = await request.json()
        policy_id = (payload.get("extra_data") or {}).get(POLICY_KEY) if isinstance(payload, dict) else None
        if policy_id is None:
            try:
                return await handler(request)
            except HandoffError as exc:
                return web.json_response({"error": str(exc), "node_errors": {}}, status=exc.status)
        token = None
        authorized = False
        try:
            user_id = server.user_manager.get_request_user_id(request)
            client_id = str(payload.get("client_id") or "")
            coordinator.policy(policy_id, user_id, client_id)
            authorized = True
            token = _ADMISSION.set((policy_id, user_id, client_id))
            response = await handler(request)
            if response.status >= 400:
                coordinator.retire_policy(policy_id)
            return response
        except HandoffError as exc:
            if authorized:
                coordinator.retire_policy(policy_id)
            return web.json_response({"error": str(exc), "node_errors": {}}, status=exc.status)
        finally:
            if token is not None:
                _ADMISSION.reset(token)

    server.app.middlewares.append(admission)
    _install_execution_hooks()
    return coordinator
