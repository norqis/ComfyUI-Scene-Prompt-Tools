"""Per-user Civitai API keys, validated explicitly and used only for downloads."""
import asyncio
import json
import os
import tempfile
import threading

import aiohttp

from .storage import storage_directory
from .llm_service import ServiceError

_LOCK = threading.Lock()
_PENDING = {}


def _load(user_id):
    path = storage_directory(user_id) / "civitai_auth.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def public_status(user_id):
    with _LOCK:
        saved = _load(user_id)
        return {"configured": bool(saved.get("api_key")), "username": saved.get("username", "")}


def token_snapshot(user_id):
    with _LOCK:
        return _load(user_id).get("api_key", "")


def clear(user_id):
    with _LOCK:
        _PENDING.pop(user_id, None)
        (storage_directory(user_id) / "civitai_auth.json").unlink(missing_ok=True)
    return {"configured": False, "username": ""}


def _begin(user_id, api_key):
    with _LOCK:
        saved = _load(user_id)
        key = api_key or saved.get("api_key", "")
        if not key:
            raise ValueError("Civitai APIキーを入力してください。")
        owner = object()
        _PENDING[user_id] = owner
        return key, owner


def _save(user_id, owner, api_key, username):
    with _LOCK:
        if _PENDING.get(user_id) is not owner:
            raise ServiceError("認証設定が変更されました。もう一度認証してください。")
        path = storage_directory(user_id) / "civitai_auth.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".civitai-auth-")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"api_key": api_key, "username": username}, stream, ensure_ascii=False)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"configured": True, "username": username}


def _finish(user_id, owner):
    with _LOCK:
        if _PENDING.get(user_id) is owner:
            _PENDING.pop(user_id)


async def authenticate(user_id, api_key="", host="civitai.red"):
    from .civitai import api_origin, validate_host, _file_io
    origin = api_origin(validate_host(host))
    if not isinstance(api_key, str):
        raise ValueError("Civitai APIキーは文字列で指定してください。")
    key = api_key.strip()
    if "\r" in key or "\n" in key:
        raise ValueError("Civitai APIキーに改行は含められません。")
    key, owner = await _file_io(_begin, user_id, key, cancel_cleanup=lambda result: _finish(user_id, result[1]))
    try:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None), cookie_jar=aiohttp.DummyCookieJar()) as session:
                async with session.get(origin + "/api/v1/me", headers={"Authorization": "Bearer " + key}, allow_redirects=False) as response:
                    if response.status != 200:
                        raise ServiceError(f"Civitai APIキーを確認できませんでした（HTTP {response.status}）。")
                    try:
                        data = await response.json(content_type=None)
                    except ValueError as exc:
                        raise ServiceError("Civitai認証の応答が不正です。") from exc
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise ServiceError("Civitaiに接続できませんでした。") from exc
        if not isinstance(data, dict) or type(data.get("id")) is not int or data["id"] <= 0 or not isinstance(data.get("username"), str) or not data["username"].strip():
            raise ServiceError("Civitai認証の応答が不正です。")
        return await _file_io(_save, user_id, owner, key, data["username"].strip())
    finally:
        await _file_io(_finish, user_id, owner)
