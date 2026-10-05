"""Per-public-user LLM connections, with atomic saves and private secrets."""
import json
import os
import tempfile
import threading
from urllib.parse import urlsplit, urlunsplit

from .storage import storage_directory

DEFAULTS = {"base_url": "http://127.0.0.1/v1", "port": 8080, "model": "", "api_key": ""}
_LOCK = threading.Lock()


def _port(value):
    if value is None or value == "":
        return None
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError("port must be an integer between 1 and 65535, or blank for the protocol default.")
    return value


def normalize_url(base_url, port=None, *, infer_port=False):
    if not isinstance(base_url, str):
        raise ValueError("base_url must be text.")
    url = urlsplit(base_url.strip().rstrip("/"))
    if url.scheme not in ("http", "https") or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment:
        raise ValueError("base_url must be an HTTP(S) URL without credentials, query or fragment.")
    embedded_port = url.port
    host = "[" + url.hostname + "]" if ":" in url.hostname else url.hostname
    return urlunsplit((url.scheme, host, url.path, "", "")), _port(embedded_port if infer_port else port)


def merge_settings(saved, changes):
    if not isinstance(changes, dict):
        raise ValueError("Settings must be a JSON object.")
    settings = {key: saved.get(key, default) for key, default in DEFAULTS.items()}
    for key in DEFAULTS:
        if key in changes and not (key == "api_key" and changes[key] == ""):
            settings[key] = changes[key]
    for key in ("model", "api_key"):
        if not isinstance(settings[key], str):
            raise ValueError(f"{key} must be text.")
    settings["model"] = settings["model"].strip()
    infer = "base_url" in changes and "port" not in changes
    settings["base_url"], settings["port"] = normalize_url(settings["base_url"], settings["port"], infer_port=infer)
    return settings


def load_settings(user_id="default"):
    path = storage_directory(user_id) / "llm_settings.json"
    if not path.exists():
        return dict(DEFAULTS)
    saved = json.loads(path.read_text(encoding="utf-8"))
    # Legacy URLs without a port mean protocol default, not the new-install 8080.
    migrated = {**DEFAULTS, **saved}
    migrated["base_url"], migrated["port"] = normalize_url(migrated["base_url"], saved.get("port"), infer_port="port" not in saved)
    return merge_settings(migrated, {})


def endpoint(settings):
    base_url, port = normalize_url(settings["base_url"], settings.get("port"), infer_port="port" not in settings)
    url = urlsplit(base_url)
    return urlunsplit((url.scheme, url.netloc + (":" + str(port) if port is not None else ""), url.path, "", ""))


def public_settings(settings):
    return {**{key: settings[key] for key in ("base_url", "port", "model")},
            "api_key_set": bool(settings["api_key"]), "template_version": "scene-llm-v1"}


def request_settings(user_id):
    from .llm_service import negotiation_state
    # Snapshot and ownership share the save lock; a delayed read cannot restore an old identity.
    with _LOCK:
        settings = load_settings(user_id)
        return settings, negotiation_state(user_id, settings)


def save_settings(user_id, changes):
    from .llm_service import invalidate_negotiation
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
        invalidate_negotiation(user_id)
        return public_settings(settings)
