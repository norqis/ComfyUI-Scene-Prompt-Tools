"""Per-public-user connection settings; secrets never leave this module in public views."""
import json
import os
import tempfile
import threading
from urllib.parse import urlsplit

from .storage import storage_directory

DEFAULTS = {"base_url": "http://127.0.0.1:8080/v1", "model": "", "api_key": "",
            "response_format": "json_object", "timeout_seconds": 120,
            "civitai_api_key": "", "civitai_host": "civitai.com", "reasoning_effort": "", "max_tokens": 8192}
_LOCK = threading.Lock()


def load_settings(user_id="default"):
    path = storage_directory(user_id) / "llm_settings.json"
    return {**DEFAULTS, **(json.loads(path.read_text(encoding="utf-8")) if path.exists() else {})}


def public_settings(settings):
    result = {key: value for key, value in settings.items() if key not in ("api_key", "civitai_api_key")}
    result.update(api_key_set=bool(settings["api_key"]), civitai_api_key_set=bool(settings["civitai_api_key"]))
    result["template_version"] = "scene-llm-v1"
    return result


def merge_settings(saved, changes):
    if not isinstance(changes, dict):
        raise ValueError("Settings must be a JSON object.")
    settings = dict(saved)
    for key in DEFAULTS:
        if key in changes:
            if key.endswith("api_key") and not changes[key]:
                continue
            settings[key] = changes[key]
    for key in ("api_key", "civitai_api_key"):
        if changes.get("clear_" + key) is True:
            settings[key] = ""
    for key in DEFAULTS.keys() - {"timeout_seconds", "max_tokens"}:
        if not isinstance(settings[key], str):
            raise ValueError(f"{key} must be text.")
    settings["base_url"] = settings["base_url"].strip().rstrip("/")
    url = urlsplit(settings["base_url"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("base_url must be an HTTP(S) URL without credentials or query.")
    if settings["response_format"] not in ("json_object", "json_schema", "instructions"):
        raise ValueError("Unsupported response_format.")
    if settings["reasoning_effort"] not in ("", "none", "low", "medium", "high"):
        raise ValueError("Unsupported reasoning_effort.")
    if type(settings["max_tokens"]) is not int or not 64 <= settings["max_tokens"] <= 32768:
        raise ValueError("max_tokens must be an integer between 64 and 32768.")
    if settings["civitai_host"] not in ("civitai.com", "civitai.red"):
        raise ValueError("Unsupported Civitai host.")
    timeout = settings["timeout_seconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 600:
        raise ValueError("timeout_seconds must be between 1 and 600.")
    return settings


def save_settings(user_id, changes):
    with _LOCK:
        settings = merge_settings(load_settings(user_id), changes)
        path = storage_directory(user_id) / "llm_settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".settings-")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(settings, stream, ensure_ascii=False)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return public_settings(settings)
