"""Route-created, short-lived execution contexts for Scene Prompt graphs."""

from __future__ import annotations

import copy
import secrets
import threading
import time


PREPARED_TTL_SECONDS = 120
# Active contexts are touched by every Scene node evaluation. Twelve hours is
# intentionally much longer than ordinary image runs, while eventually
# recovering slots after a browser or ComfyUI client disappears.
ACTIVE_IDLE_TTL_SECONDS = 12 * 60 * 60


class SceneRunError(ValueError):
    pass


class RunContextStore:
    """Owns opaque handles created by authenticated HTTP requests.

    Ordinary prepared contexts expire quickly. Continuous contexts can wait in
    the browser FIFO, so they use the active idle timeout until claimed.
    """

    def __init__(
        self,
        prepared_ttl_seconds=PREPARED_TTL_SECONDS,
        active_idle_ttl_seconds=ACTIVE_IDLE_TTL_SECONDS,
        expiration_callback=None,
    ):
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
            timeout = self.active_idle_ttl_seconds if entry.get("continuous") else self.prepared_ttl_seconds
            return now - entry["last_access"] >= timeout
        return entry["state"] == "active" and now - entry["last_access"] >= self.active_idle_ttl_seconds

    def purge_expired(self):
        with self._lock:
            expired = self._purge_expired_locked(time.monotonic())
        self._notify_expired(expired)
        return expired

    @staticmethod
    def _touch_locked(entry, now):
        entry["last_access"] = now

    def create(self, user_id, continuous=False):
        now = time.monotonic()
        with self._lock:
            expired = self._purge_expired_locked(now)
            handle = secrets.token_urlsafe(32)
            while handle in self._entries:
                handle = secrets.token_urlsafe(32)
            self._entries[handle] = {
                "user_id": str(user_id),
                "plans": {},
                "state": "prepared",
                "prompt_id": "",
                "continuous": bool(continuous),
                "last_access": now,
            }
        self._notify_expired(expired)
        return handle

    def reconcile_active(self, live_prompt_ids):
        """Release ordinary active runs that are no longer in ComfyUI's queue."""
        live_ids = {str(prompt_id) for prompt_id in live_prompt_ids if str(prompt_id)}
        with self._lock:
            released = []
            for handle, entry in list(self._entries.items()):
                if entry["state"] != "active" or entry.get("continuous"):
                    continue
                if str(entry.get("prompt_id") or "") in live_ids:
                    continue
                self._entries.pop(handle, None)
                released.append((handle, entry["user_id"]))
        self._notify_expired(released)
        return released

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
            if entry is None:
                expired = []
            elif self._is_expired_locked(entry, time.monotonic()):
                self._entries.pop(value, None)
                expired = [(value, entry["user_id"])]
            else:
                expired = []
                result = copy.deepcopy(entry)
        self._notify_expired(expired)
        if entry is None or expired:
            raise SceneRunError("実行コンテキストが見つからないか、有効期限が切れました。画像生成を開始し直してください。")
        return result

    def get_user_id(self, handle):
        """Read an active context owner without copying plans or extending TTL."""
        value = str(handle or "").strip()
        if not value:
            raise SceneRunError("実行コンテキストがありません。画像生成を開始し直してください。")
        with self._lock:
            entry = self._entries.get(value)
            if entry is None:
                expired = []
            elif self._is_expired_locked(entry, time.monotonic()):
                self._entries.pop(value, None)
                expired = [(value, entry["user_id"])]
            else:
                expired = []
                user_id = entry["user_id"]
        self._notify_expired(expired)
        if entry is None or expired:
            raise SceneRunError("実行コンテキストが見つからないか、有効期限が切れました。画像生成を開始し直してください。")
        return user_id

    def get_plan(self, handle, expand_node_id):
        """Read a cached expand plan, refreshing the active context when present."""
        return copy.deepcopy(self.get_plan_reference(handle, expand_node_id))

    def get_plan_reference(self, handle, expand_node_id):
        """Read a cached plan for Scene-node execution without copying it.

        The cached plan is private to this store.  Scene node consumers treat
        it as read-only; callers that need an editable result use get_plan().
        """
        key = str(expand_node_id or "").strip()
        if not key:
            raise SceneRunError("Scene Prompt Expand のIDがありません。")
        value = str(handle or "").strip()
        if not value:
            raise SceneRunError("実行コンテキストがありません。画像生成を開始し直してください。")
        with self._lock:
            entry = self._entries.get(value)
            if entry is None:
                expired = []
            else:
                now = time.monotonic()
                if self._is_expired_locked(entry, now):
                    self._entries.pop(value, None)
                    expired = [(value, entry["user_id"])]
                else:
                    expired = []
                    self._touch_locked(entry, now)
                    result = entry["plans"].get(key)
        self._notify_expired(expired)
        if entry is None:
            raise SceneRunError("実行コンテキストが見つかりません。画像生成を開始し直してください。")
        if expired:
            raise SceneRunError("実行コンテキストの有効期限が切れました。画像生成を開始し直してください。")
        return result

    def set_plan(self, handle, expand_node_id, plan):
        return copy.deepcopy(self.set_plan_reference(handle, expand_node_id, plan))

    def set_plan_reference(self, handle, expand_node_id, plan):
        """Cache a plan once and return its private read-only reference."""
        key = str(expand_node_id or "").strip()
        if not key:
            raise SceneRunError("Scene Prompt Expand のIDがありません。")
        value = str(handle or "").strip()
        if not value:
            raise SceneRunError("実行コンテキストがありません。画像生成を開始し直してください。")
        with self._lock:
            entry = self._entries.get(value)
            if entry is None:
                expired = []
            else:
                now = time.monotonic()
                if self._is_expired_locked(entry, now):
                    self._entries.pop(value, None)
                    expired = [(value, entry["user_id"])]
                else:
                    expired = []
                    self._touch_locked(entry, now)
                    if key not in entry["plans"]:
                        entry["plans"][key] = copy.deepcopy(plan)
                    result = entry["plans"][key]
        self._notify_expired(expired)
        if entry is None:
            raise SceneRunError("実行コンテキストが見つかりません。画像生成を開始し直してください。")
        if expired:
            raise SceneRunError("実行コンテキストの有効期限が切れました。画像生成を開始し直してください。")
        return result

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


def create_run_context(user_id, continuous=False):
    return RUN_CONTEXTS.create(user_id, continuous)


def reconcile_active_run_contexts(live_prompt_ids):
    return RUN_CONTEXTS.reconcile_active(live_prompt_ids)


def require_run_context(handle):
    return RUN_CONTEXTS.require(handle)


def peek_run_context(handle):
    return RUN_CONTEXTS.peek(handle)


def get_run_user_id(handle):
    return RUN_CONTEXTS.get_user_id(handle)


def get_run_plan(handle, expand_node_id):
    return RUN_CONTEXTS.get_plan(handle, expand_node_id)


def get_run_plan_reference(handle, expand_node_id):
    return RUN_CONTEXTS.get_plan_reference(handle, expand_node_id)


def set_run_plan(handle, expand_node_id, plan):
    return RUN_CONTEXTS.set_plan(handle, expand_node_id, plan)


def set_run_plan_reference(handle, expand_node_id, plan):
    return RUN_CONTEXTS.set_plan_reference(handle, expand_node_id, plan)


def claim_run_context(handle, user_id, prompt_id):
    return RUN_CONTEXTS.claim(handle, user_id, prompt_id)


def release_run_context(handle, user_id):
    return RUN_CONTEXTS.release(handle, user_id)


def purge_expired_run_contexts():
    return RUN_CONTEXTS.purge_expired()
