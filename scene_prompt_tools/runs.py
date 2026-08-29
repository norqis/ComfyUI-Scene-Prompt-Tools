"""Route-created immutable execution contexts for Scene Prompt graphs."""

from __future__ import annotations

import copy
import secrets
import threading
import time
from collections import OrderedDict


MAX_ACTIVE_RUN_CONTEXTS = 256
RUN_CONTEXT_TTL_SECONDS = 12 * 60 * 60


class SceneRunError(ValueError):
    pass


class RunContextStore:
    """Keeps per-request data out of executable graph inputs.

    A handle is deliberately opaque.  The only code allowed to create one is
    the HTTP route which has access to ComfyUI's request user manager.
    """

    def __init__(self, maximum=MAX_ACTIVE_RUN_CONTEXTS, ttl_seconds=RUN_CONTEXT_TTL_SECONDS):
        self.maximum = maximum
        self.ttl_seconds = ttl_seconds
        self._entries = OrderedDict()
        self._lock = threading.RLock()

    def _purge_locked(self, now):
        expired = [
            handle for handle, entry in self._entries.items()
            if now - entry["last_access"] >= self.ttl_seconds
        ]
        for handle in expired:
            self._entries.pop(handle, None)

    def create(self, user_id, prompt_data_index):
        now = time.monotonic()
        with self._lock:
            self._purge_locked(now)
            if len(self._entries) >= self.maximum:
                raise SceneRunError("実行コンテキストが上限に達しています。実行中の生成が終わってから再試行してください。")
            handle = secrets.token_urlsafe(32)
            while handle in self._entries:
                handle = secrets.token_urlsafe(32)
            self._entries[handle] = {
                "user_id": str(user_id),
                "prompt_data_index": copy.deepcopy(prompt_data_index),
                "plan": None,
                "last_access": now,
            }
            return handle

    def require(self, handle):
        value = str(handle or "").strip()
        if not value:
            raise SceneRunError("実行コンテキストがありません。画像生成を開始し直してください。")
        now = time.monotonic()
        with self._lock:
            self._purge_locked(now)
            entry = self._entries.get(value)
            if entry is None:
                raise SceneRunError("実行コンテキストが見つかりません。画像生成を開始し直してください。")
            entry["last_access"] = now
            self._entries.move_to_end(value)
            return entry

    def set_plan(self, handle, plan):
        with self._lock:
            entry = self.require(handle)
            if entry["plan"] is None:
                entry["plan"] = copy.deepcopy(plan)
            return copy.deepcopy(entry["plan"])

    def release(self, handle, user_id):
        value = str(handle or "").strip()
        if not value:
            return False
        with self._lock:
            entry = self._entries.get(value)
            if entry is None or entry["user_id"] != str(user_id):
                return False
            self._entries.pop(value, None)
            return True

    def clear(self):
        with self._lock:
            self._entries.clear()


RUN_CONTEXTS = RunContextStore()


def create_run_context(user_id, prompt_data_index):
    return RUN_CONTEXTS.create(user_id, prompt_data_index)


def require_run_context(handle):
    return RUN_CONTEXTS.require(handle)


def set_run_plan(handle, plan):
    return RUN_CONTEXTS.set_plan(handle, plan)


def release_run_context(handle, user_id):
    return RUN_CONTEXTS.release(handle, user_id)
