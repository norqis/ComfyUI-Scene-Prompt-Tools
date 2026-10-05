"""Read selected LoRA metadata without loading model weights."""

import hashlib
import json
import os
import struct
import sys
import threading
import weakref
from contextlib import contextmanager

import folder_paths


MAX_HEADER_BYTES = 8 * 1024 * 1024
_CACHE = {}
_CACHE_LOCK = threading.Lock()
_CATALOG = {}
_CATALOG_GENERATION = 0
_FILE_OPERATIONS = weakref.WeakValueDictionary()
_FILE_OPERATIONS_LOCK = threading.Lock()


@contextmanager
def file_operation(key):
    """Share one operation lock while callers own or wait for a physical file."""
    with _FILE_OPERATIONS_LOCK:
        lock = _FILE_OPERATIONS.get(key)
        if lock is None:
            lock = threading.Lock()
            _FILE_OPERATIONS[key] = lock
    with lock:
        yield


def file_identity(path):
    return os.path.normcase(os.path.realpath(path))


def file_signature(path):
    stat = os.stat(path)
    return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_dev, stat.st_ino


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
    while True:
        if not name or name not in folder_paths.get_filename_list("loras"):
            raise ValueError("Select an available LoRA.")
        path = folder_paths.get_full_path("loras", name)
        if not path:
            raise FileNotFoundError("Selected LoRA was not found.")
        key = file_identity(path)
        with file_operation(key):
            current_path = folder_paths.get_full_path("loras", name)
            if not current_path or file_identity(current_path) != key:
                continue
            try:
                signature = file_signature(path)
            except OSError:
                with _CACHE_LOCK:
                    _CACHE.pop(key, None)
                raise
            with _CACHE_LOCK:
                generation = _CATALOG_GENERATION
                cached = _CACHE.get(key)
                if cached is not None and cached[0] != signature:
                    _CACHE.pop(key)
                    cached = None
            if cached is not None:
                result = cached[1]
            else:
                digest = hashlib.sha256()
                with open(path, "rb") as stream:
                    phrases = _trigger_phrases(_read_metadata(stream)) if name.lower().endswith(".safetensors") else []
                    stream.seek(0)
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                result = {"sha256": digest.hexdigest(), "trigger_phrases": phrases,
                          "size": signature[0], "mtime_ns": signature[1]}
            # A catalog refresh or file replacement during hashing cannot publish
            # an obsolete result, including the cached-result presentation path.
            if name not in folder_paths.get_filename_list("loras"):
                with _CACHE_LOCK:
                    _CACHE.pop(key, None)
                raise ValueError("Select an available LoRA.")
            current_path = folder_paths.get_full_path("loras", name)
            if not current_path or file_identity(current_path) != key:
                continue
            with _CACHE_LOCK:
                try:
                    current_signature = file_signature(current_path)
                except OSError:
                    _CACHE.pop(key, None)
                    raise
                if current_signature != signature:
                    continue
                if generation != _CATALOG_GENERATION and _CATALOG.get(key) != signature:
                    continue
                _CACHE[key] = (signature, result)
            return {**result, "name": name, "trigger_phrases": list(result["trigger_phrases"])}


def list_loras():
    """List selectable LoRA paths and file identity without opening model files."""
    global _CATALOG, _CATALOG_GENERATION
    result = []
    identities = {}
    for name in folder_paths.get_filename_list("loras"):
        item = {"path": name, "size": None, "mtime_ns": None}
        path = folder_paths.get_full_path("loras", name)
        if path:
            try:
                stat = os.stat(path)
                item["size"], item["mtime_ns"] = stat.st_size, stat.st_mtime_ns
                identities[file_identity(path)] = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_dev, stat.st_ino)
            except OSError:
                pass
        result.append(item)
    with _CACHE_LOCK:
        _CATALOG = identities
        _CATALOG_GENERATION += 1
        for key, entry in list(_CACHE.items()):
            if identities.get(key) != entry[0]:
                _CACHE.pop(key)
    # Reuse the already-read inventory; do not import the acquisition service
    # solely for a local picker or scan the catalog during individual hashes.
    acquisition = sys.modules.get(__package__ + ".civitai")
    if acquisition is not None:
        from .civitai import reconcile_lora_hashes
        reconcile_lora_hashes(identities)
    return result
