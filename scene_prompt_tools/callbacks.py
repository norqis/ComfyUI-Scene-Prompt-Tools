"""Pure callback settings and the small synchronous HTTP dispatcher."""

from __future__ import annotations

import json
import re
import secrets
import threading
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


SCENE_CALLBACK_TYPE = "SCENE_CALLBACK"
CALLBACK_FREQUENCY_FIRST = "初回"
CALLBACK_FREQUENCY_EVERY = "毎回"
CALLBACK_FAILURE_CONTINUE = "続行"
CALLBACK_FAILURE_STOP = "停止"
_PLACEHOLDER = re.compile(r"\{\{?([a-z_]+)\}?\}")
_MAX_RESPONSE_BYTES = 65_536
_DESKTOP_ACK_ERRORS = {"unavailable", "permission_denied", "display_failed", "timeout"}
_DESKTOP_PENDING = {}
_DESKTOP_PENDING_LOCK = threading.RLock()


class SceneCallbackError(RuntimeError):
    """A callback request failed without exposing its private request data."""


def discord_callback(webhook_url, text, username=""):
    return ({
        "kind": "discord",
        "webhook_url": str(webhook_url or ""),
        "text": str(text or ""),
        "username": str(username or ""),
    },)


def request_callback(method, url, text="", body_type="text", headers_json=""):
    method = str(method or "GET").upper()
    if method not in {"GET", "POST"}:
        raise ValueError("Request method must be GET or POST.")
    body_type = str(body_type or "text").lower()
    if body_type not in {"text", "json"}:
        raise ValueError("Request body_type must be text or json.")
    return ({
        "kind": "request", "method": method, "url": str(url or ""),
        "text": str(text or ""), "body_type": body_type,
        "headers_json": str(headers_json or ""),
    },)


def desktop_callback(title, text):
    return ({"kind": "desktop", "title": str(title or ""), "text": str(text or "")},)


def _replace_text(value, values, *, url=False):
    def replace(match):
        key = match.group(1)
        if key not in values:
            return match.group(0)
        item = str(values[key])
        return quote(item, safe="") if url else item
    return _PLACEHOLDER.sub(replace, str(value))


def _replace_json(value, values):
    if isinstance(value, str):
        return _replace_text(value, values)
    if isinstance(value, list):
        return [_replace_json(item, values) for item in value]
    if isinstance(value, dict):
        return {str(key): _replace_json(item, values) for key, item in value.items()}
    return value


def _headers(raw, values):
    if not str(raw or "").strip():
        return {}
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SceneCallbackError("Callback headers_json is not valid JSON.") from exc
    if not isinstance(decoded, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in decoded.items()):
        raise SceneCallbackError("Callback headers_json must be an object of string values.")
    return {key: _replace_text(value, values) for key, value in decoded.items()}


def _open(request, timeout_seconds):
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            response.read(_MAX_RESPONSE_BYTES)
    except HTTPError as exc:
        raise SceneCallbackError(f"Callback request returned HTTP {exc.code}.") from exc
    except (HTTPException, URLError, OSError, ValueError) as exc:
        raise SceneCallbackError(f"Callback request failed: {type(exc).__name__}.") from exc


def dispatch_callback(config, values, timeout_seconds, *, desktop_context=None):
    try:
        return _dispatch_callback(config, values, timeout_seconds, desktop_context=desktop_context)
    except SceneCallbackError:
        raise
    except (TypeError, ValueError) as exc:
        raise SceneCallbackError(f"Callback request is invalid: {type(exc).__name__}.") from exc


def acknowledge_desktop_callback(request_id, user_id, success, error=""):
    """Resolve one browser notification acknowledgement without broadcasting."""
    key = str(request_id or "").strip()
    with _DESKTOP_PENDING_LOCK:
        pending = _DESKTOP_PENDING.get(key)
        if pending is None or pending.get("result") is not None:
            return "missing"
        if pending["user_id"] != str(user_id):
            return "forbidden"
        if type(success) is not bool:
            return "invalid"
        reason = str(error or "").strip()
        if not success:
            reason = reason if reason in _DESKTOP_ACK_ERRORS else "display_failed"
        pending["result"] = {"success": success, "error": reason}
        pending["event"].set()
    return "acknowledged"


def _dispatch_desktop(config, values, timeout, desktop_context):
    context = desktop_context if isinstance(desktop_context, dict) else {}
    client_id = str(context.get("client_id") or "").strip()
    user_id = str(context.get("user_id") or "").strip()
    if not client_id or not user_id:
        raise SceneCallbackError("Desktop callback failed: unavailable.")
    request_id = secrets.token_urlsafe(32)
    pending = {"event": threading.Event(), "user_id": user_id, "result": None}
    with _DESKTOP_PENDING_LOCK:
        _DESKTOP_PENDING[request_id] = pending
    try:
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "scene_prompt_desktop_notification",
                {
                    "request_id": request_id,
                    "title": _replace_text(config.get("title", ""), values),
                    "text": _replace_text(config.get("text", ""), values),
                    "timeout_seconds": timeout,
                },
                sid=client_id,
            )
        except Exception as exc:
            raise SceneCallbackError("Desktop callback failed: unavailable.") from exc
        if not pending["event"].wait(timeout):
            raise SceneCallbackError("Desktop callback failed: timeout.")
        result = pending["result"]
        if not result or not result["success"]:
            raise SceneCallbackError(f"Desktop callback failed: {result.get('error', 'display_failed') if result else 'display_failed'}.")
    finally:
        with _DESKTOP_PENDING_LOCK:
            if _DESKTOP_PENDING.get(request_id) is pending:
                _DESKTOP_PENDING.pop(request_id, None)


def _dispatch_callback(config, values, timeout_seconds, *, desktop_context=None):
    """Render one descriptor and send it.  Callers decide failure policy."""
    if not isinstance(config, dict):
        raise SceneCallbackError("Callback configuration is invalid.")
    try:
        timeout = int(timeout_seconds)
    except (TypeError, ValueError) as exc:
        raise SceneCallbackError("Callback timeout is invalid.") from exc
    if not 1 <= timeout <= 120:
        raise SceneCallbackError("Callback timeout is invalid.")
    kind = config.get("kind")
    if kind == "discord":
        url = _replace_text(config.get("webhook_url", ""), values, url=True)
        if re.search(r"([?&])wait=[^&]*", url):
            url = re.sub(r"([?&])wait=[^&]*", r"\1wait=true", url, count=1)
        else:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}wait=true"
        payload = {"content": _replace_text(config.get("text", ""), values)}
        username = _replace_text(config.get("username", ""), values)
        if username:
            payload["username"] = username
        request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
        _open(request, timeout)
        return
    if kind == "request":
        method = str(config.get("method") or "GET").upper()
        if method not in {"GET", "POST"}:
            raise SceneCallbackError("Callback method is invalid.")
        url = _replace_text(config.get("url", ""), values, url=True)
        headers = _headers(config.get("headers_json", ""), values)
        data = None
        if method == "POST":
            body_type = str(config.get("body_type") or "text").lower()
            if body_type == "json":
                try:
                    template = json.loads(str(config.get("text") or ""))
                except json.JSONDecodeError as exc:
                    raise SceneCallbackError("Callback JSON body is not valid JSON.") from exc
                data = json.dumps(_replace_json(template, values), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                if not any(key.lower() == "content-type" for key in headers):
                    headers["Content-Type"] = "application/json; charset=utf-8"
            elif body_type == "text":
                data = _replace_text(config.get("text", ""), values).encode("utf-8")
                if not any(key.lower() == "content-type" for key in headers):
                    headers["Content-Type"] = "text/plain; charset=utf-8"
            else:
                raise SceneCallbackError("Callback body_type is invalid.")
        _open(Request(url, data=data, headers=headers, method=method), timeout)
        return
    if kind == "desktop":
        _dispatch_desktop(config, values, timeout, desktop_context)
        return
    raise SceneCallbackError("Callback kind is invalid.")
