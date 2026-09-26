"""Read selected LoRA metadata without loading model weights."""

import hashlib
import json
import os
import struct
import threading
from collections import OrderedDict

import folder_paths


MAX_HEADER_BYTES = 8 * 1024 * 1024
_CACHE = OrderedDict()
_TITLE_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()


def _trigger_phrases(metadata):
    phrases = []
    for key in ("modelspec.trigger_phrase", "civitai.trainedWords"):
        value = metadata.get(key)
        if key == "civitai.trainedWords" and isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            phrases.extend(item.strip() for item in value if isinstance(item, str) and item.strip())
    return list(dict.fromkeys(phrases))


def _read_metadata(stream):
    raw_length = stream.read(8)
    if len(raw_length) != 8:
        raise ValueError("LoRA safetensors header is incomplete.")
    length = struct.unpack("<Q", raw_length)[0]
    if not 2 <= length <= MAX_HEADER_BYTES:
        raise ValueError("LoRA safetensors header is invalid or too large.")
    header = stream.read(length)
    if len(header) != length:
        raise ValueError("LoRA safetensors header is incomplete.")
    parsed = json.loads(header)
    if not isinstance(parsed, dict):
        raise ValueError("LoRA safetensors header is invalid.")
    metadata = parsed.get("__metadata__", {})
    return metadata if isinstance(metadata, dict) else {}


def read_lora_info(name):
    """Resolve an actual ComfyUI LoRA selection, then read its header and hash."""
    if not name or name not in folder_paths.get_filename_list("loras"):
        raise ValueError("Select an available LoRA.")
    path = folder_paths.get_full_path("loras", name)
    if not path:
        raise FileNotFoundError("Selected LoRA was not found.")
    stat = os.stat(path)
    key = (path, stat.st_size, stat.st_mtime_ns)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            _CACHE.move_to_end(key)
            return dict(cached)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        phrases = _trigger_phrases(_read_metadata(stream)) if name.lower().endswith(".safetensors") else []
        stream.seek(0)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    result = {"name": name, "sha256": digest.hexdigest(), "trigger_phrases": phrases,
              "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    with _CACHE_LOCK:
        _CACHE[key] = result
        _CACHE.move_to_end(key)
        while len(_CACHE) > 32:
            _CACHE.popitem(last=False)
    return dict(result)


def list_loras():
    """List selectable LoRAs with local titles, without reading model weights."""
    result = []
    for name in folder_paths.get_filename_list("loras"):
        title = os.path.splitext(os.path.basename(name.replace("\\", "/")))[0]
        item = {"path": name, "title": title, "source": "filename", "size": None, "mtime_ns": None}
        path = folder_paths.get_full_path("loras", name)
        if path:
            try:
                stat = os.stat(path)
                item["size"], item["mtime_ns"] = stat.st_size, stat.st_mtime_ns
                if name.lower().endswith(".safetensors"):
                    key = (path, stat.st_size, stat.st_mtime_ns)
                    with _CACHE_LOCK:
                        cached = _TITLE_CACHE.get(key)
                        if cached is not None:
                            _TITLE_CACHE.move_to_end(key)
                    if cached is None:
                        try:
                            with open(path, "rb") as stream:
                                metadata = _read_metadata(stream)
                            local_title = next((value.strip() for field in ("modelspec.title", "ss_output_name")
                                                if isinstance((value := metadata.get(field)), str) and value.strip()), "")
                        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
                            local_title = ""
                        cached = (local_title, "local" if local_title else "filename")
                        with _CACHE_LOCK:
                            _TITLE_CACHE[key] = cached
                            _TITLE_CACHE.move_to_end(key)
                            while len(_TITLE_CACHE) > 256:
                                _TITLE_CACHE.popitem(last=False)
                    if cached[0]:
                        item["title"], item["source"] = cached
            except OSError:
                pass
        result.append(item)
    return result
