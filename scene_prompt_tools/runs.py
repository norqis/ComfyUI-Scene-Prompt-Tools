"""Route-created, short-lived execution contexts for Scene Prompt graphs."""

from __future__ import annotations

import copy
import secrets
import threading
import time
from collections import Counter


MAX_RUN_CONTEXTS = 256
MAX_PREPARED_PER_USER = 8
MAX_ACTIVE_PER_USER = 32
PREPARED_TTL_SECONDS = 120
# Active contexts are touched by every Scene node evaluation. Twelve hours is
# intentionally much longer than ordinary image runs, while eventually
# recovering slots after a browser or ComfyUI client disappears.
ACTIVE_IDLE_TTL_SECONDS = 12 * 60 * 60


class SceneRunError(ValueError):
    pass


class RunContextStore:
    """Owns opaque handles created by authenticated HTTP requests.

    Prepared contexts expire quickly. Active contexts stay alive while Scene
    nodes use them and expire only after a conservative idle interval.
    """

    def __init__(
        self,
        maximum=MAX_RUN_CONTEXTS,
        prepared_limit=MAX_PREPARED_PER_USER,
        active_limit=MAX_ACTIVE_PER_USER,
        prepared_ttl_seconds=PREPARED_TTL_SECONDS,
        active_idle_ttl_seconds=ACTIVE_IDLE_TTL_SECONDS,
        expiration_callback=None,
    ):
        self.maximum = maximum
        self.prepared_limit = prepared_limit
        self.active_limit = active_limit
        self.prepared_ttl_seconds = prepared_ttl_seconds
        self.active_idle_ttl_seconds = active_idle_ttl_seconds
        self._expiration_callback = expiration_callback
        self._entries = {}
        self._lock = threading.RLock()

    def set_expiration_callback(self, callback):
        with self._lock:
            self._expiration_callback = callback

    def _notify_expired(self, expired):
        callback = self._expiration_callback
        if callback is None:
            return
        for handle, user_id in expired:
            callback(handle, user_id)

    def _purge_expired_locked(self, now):
        expired = []
        for handle, entry in list(self._entries.items()):
            if self._is_expired_locked(entry, now):
                self._entries.pop(handle, None)
                expired.append((handle, entry["user_id"]))
        return expired

    def _is_expired_locked(self, entry, now):
        if entry["state"] == "prepared":
            return now - entry["created_at"] >= self.prepared_ttl_seconds
        return entry["state"] == "active" and now - entry["last_access"] >= self.active_idle_ttl_seconds

    def purge_expired(self):
        with self._lock:
            expired = self._purge_expired_locked(time.monotonic())
        self._notify_expired(expired)
        return expired

    @staticmethod
    def _touch_locked(entry, now):
        entry["last_access"] = now

    def _counts_locked(self, user_id):
        states = Counter(entry["state"] for entry in self._entries.values() if entry["user_id"] == str(user_id))
        return states["prepared"], states["active"]

    def create(self, user_id):
        now = time.monotonic()
        with self._lock:
            expired = self._purge_expired_locked(now)
            prepared, active = self._counts_locked(user_id)
            error = None
            if len(self._entries) >= self.maximum:
                error = "実行コンテキストが上限に達しています。実行中の生成が終わってから再試行してください。"
            elif prepared >= self.prepared_limit:
                error = "実行準備が上限に達しています。開始していない生成を減らしてから再試行してください。"
            elif prepared + active >= self.active_limit:
                error = "実行中または準備済みのScene Promptが上限に達しています。完了を待ってから再試行してください。"
            else:
                handle = secrets.token_urlsafe(32)
                while handle in self._entries:
                    handle = secrets.token_urlsafe(32)
                self._entries[handle] = {
                    "user_id": str(user_id),
                    "plans": {},
                    "state": "prepared",
                    "prompt_id": "",
                    "created_at": now,
                    "last_access": now,
                }
        self._notify_expired(expired)
        if error:
            raise SceneRunError(error)
        return handle

    def require(self, handle):
        value = str(handle or "").strip()
        if not value:
            raise SceneRunError("実行コンテキストがありません。画像生成を開始し直してください。")
        with self._lock:
            entry = self._entries.get(value)
            if entry is None:
                raise SceneRunError("実行コンテキストが見つかりません。画像生成を開始し直してください。")
            now = time.monotonic()
            if self._is_expired_locked(entry, now):
                self._entries.pop(value, None)
                expired = [(value, entry["user_id"])]
            else:
                expired = []
                self._touch_locked(entry, now)
        self._notify_expired(expired)
        if expired:
            raise SceneRunError("実行コンテキストの有効期限が切れました。画像生成を開始し直してください。")
        return entry

    def peek(self, handle):
        """Return a copy for cache inspection without touching run state."""
        value = str(handle or "").strip()
        if not value:
            raise SceneRunError("実行コンテキストがありません。画像生成を開始し直してください。")
        with self._lock:
            entry = self._entries.get(value)
            if entry is None or self._is_expired_locked(entry, time.monotonic()):
                raise SceneRunError("実行コンテキストが見つからないか、有効期限が切れました。画像生成を開始し直してください。")
            return copy.deepcopy(entry)

    def set_plan(self, handle, expand_node_id, plan):
        key = str(expand_node_id or "").strip()
        if not key:
            raise SceneRunError("Scene Prompt Expand のIDがありません。")
        entry = self.require(handle)
        with self._lock:
            if self._entries.get(str(handle)) is not entry:
                raise SceneRunError("実行コンテキストが見つかりません。画像生成を開始し直してください。")
            if key not in entry["plans"]:
                entry["plans"][key] = copy.deepcopy(plan)
            return copy.deepcopy(entry["plans"][key])

    def claim(self, handle, user_id, prompt_id):
        value = str(handle or "").strip()
        prompt_value = str(prompt_id or "").strip()
        if not value or not prompt_value:
            return False
        with self._lock:
            entry = self._entries.get(value)
            if entry is None or entry["user_id"] != str(user_id):
                return False
            now = time.monotonic()
            if self._is_expired_locked(entry, now):
                self._entries.pop(value, None)
                expired = [(value, entry["user_id"])]
            else:
                expired = []
            if expired:
                claimed = False
            elif entry["state"] == "active":
                self._touch_locked(entry, now)
                claimed = entry["prompt_id"] == prompt_value
            else:
                entry["state"] = "active"
                entry["prompt_id"] = prompt_value
                self._touch_locked(entry, now)
                claimed = True
        self._notify_expired(expired)
        return claimed

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


def set_run_expiration_callback(callback):
    RUN_CONTEXTS.set_expiration_callback(callback)


def create_run_context(user_id):
    return RUN_CONTEXTS.create(user_id)


def require_run_context(handle):
    return RUN_CONTEXTS.require(handle)


def peek_run_context(handle):
    return RUN_CONTEXTS.peek(handle)


def set_run_plan(handle, expand_node_id, plan):
    return RUN_CONTEXTS.set_plan(handle, expand_node_id, plan)


def claim_run_context(handle, user_id, prompt_id):
    return RUN_CONTEXTS.claim(handle, user_id, prompt_id)


def release_run_context(handle, user_id):
    return RUN_CONTEXTS.release(handle, user_id)


def purge_expired_run_contexts():
    return RUN_CONTEXTS.purge_expired()
