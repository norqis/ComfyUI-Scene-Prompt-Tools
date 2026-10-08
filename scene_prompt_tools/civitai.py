"""Civitai candidate normalization and verified, streamed LoRA acquisition."""
import asyncio
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
import folder_paths

from .llm_service import ServiceError, candidate_identity, MODES
from .lora_metadata import file_identity, file_signature, file_operation

SORTS = ("Most Downloaded", "Most Liked", "Most Collected", "Highest Rated")
STAT_FIELDS = ("downloadCount", "thumbsUpCount", "favoriteCount", "collectedCount", "rating", "ratingCount", "commentCount", "tippedAmountCount")
_NOT_FOUND = object()
_DOWNLOAD_LOCK = None
_HASH_CACHE = {}
_HASH_LOCK = threading.Lock()
_HASH_CATALOG = {}
_HASH_CATALOG_GENERATION = 0


def compatible(base_model, mode):
    if mode not in MODES:
        raise ValueError("model_mode must be Illustrious or Anima.")
    base = str(base_model).lower()
    return base in ("illustrious", "illustrious xl", "noobai", "noobai xl") if mode == "Illustrious" else base == "anima"


HOSTS = ("civitai.red", "civitai.com")


def validate_host(host):
    if host not in HOSTS:
        raise ValueError("Civitai host must be civitai.red or civitai.com.")
    return host


def api_origin(host="civitai.red"):
    return "https://" + validate_host(host)


async def api_get(path, params=None, *, missing_ok=False, host="civitai.red"):
    url = api_origin(validate_host(host)) + path
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None), cookie_jar=aiohttp.DummyCookieJar()) as session:
            async with session.get(url, params=params, allow_redirects=False) as response:
                if missing_ok and response.status == 404:
                    return _NOT_FOUND
                if response.status != 200:
                    raise ServiceError(f"Civitai API returned HTTP {response.status}.")
                try:
                    return json.loads(await response.text())
                except json.JSONDecodeError as exc:
                    raise ServiceError(f"Civitai API {path} returned invalid JSON (HTTP {response.status}).") from exc
    except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
        raise ServiceError("Civitai connection failed, timed out, or returned invalid JSON.") from exc


def _hash_version(version):
    if (not isinstance(version, dict)
            or type(version.get("id")) is not int or version["id"] <= 0
            or type(version.get("modelId")) is not int or version["modelId"] <= 0
            or not isinstance(version.get("name"), str)
            or not isinstance(version.get("model"), dict) or not isinstance(version["model"].get("name"), str)
            or not isinstance(version.get("trainedWords", []), list)
            or any(not isinstance(word, str) for word in version.get("trainedWords", []))):
        raise ServiceError("Civitai returned an invalid version response.")
    return {"found": True, "version": {"id": version["id"], "modelId": version["modelId"],
        "name": version["name"], "model": {"name": version["model"]["name"]}, "trainedWords": version.get("trainedWords", [])}}


async def by_hash(sha256):
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise ValueError("SHA256 must contain exactly 64 hexadecimal digits.")
    error = None
    for host in HOSTS:
        try:
            version = await api_get("/api/v1/model-versions/by-hash/" + sha256.lower(), missing_ok=True, host=host)
            if version is not _NOT_FOUND:
                return _hash_version(version)
        except ServiceError as exc:
            error = exc
    if error is not None:
        raise error
    return {"found": False, "version": None}


def _field(data, key, expected, default):
    value = data.get(key, default)
    if value is None:
        return default
    if not isinstance(value, expected) or isinstance(value, bool) and expected != bool:
        raise ServiceError(f"Civitai returned an invalid {key} field.")
    return value


async def descriptions(model_id, version_id):
    """Fetch display text only when a local LoRA's details are opened."""
    if any(type(value) is not int or value <= 0 for value in (model_id, version_id)):
        raise ValueError("Civitai model_id and version_id must be positive integers.")
    for host in HOSTS:
        try:
            model = await api_get(f"/api/v1/models/{model_id}", host=host)
            if not isinstance(model, dict) or type(model.get("id")) is not int or model["id"] != model_id:
                raise ServiceError("Civitai returned an invalid model response.")
            versions = _field(model, "modelVersions", list, [])
            version = next((entry for entry in versions if isinstance(entry, dict)
                            and type(entry.get("id")) is int and entry["id"] == version_id), None)
            if version is None:
                raise ServiceError("Selected Civitai version was not found.")
            return {"description": _field(model, "description", str, ""),
                    "version_description": _field(version, "description", str, "")}
        except ServiceError:
            if host == HOSTS[-1]:
                raise


def normalize(model, mode, host="civitai.red"):
    host = validate_host(host)
    if not isinstance(model, dict) or not isinstance(model.get("modelVersions", []), list):
        raise ServiceError("Civitai returned an invalid model response.")
    if _field(model, "type", str, "") != "LORA" or _field(model, "mode", str, "") or _field(model, "availability", str, "Public") != "Public":
        return []
    result = []
    for version in model.get("modelVersions", []):
        if not isinstance(version, dict):
            raise ServiceError("Civitai returned an invalid version response.")
        if not compatible(_field(version, "baseModel", str, ""), mode) or _field(version, "availability", str, "Public") != "Public":
            continue
        gallery = []
        for image in _field(version, "images", list, []):
            if not isinstance(image, dict):
                raise ServiceError("Civitai returned an invalid image response.")
            if _field(image, "type", str, "image") != "image":
                continue
            nsfw = _field(image, "nsfw", bool, False)
            level = _field(image, "nsfwLevel", (int, float), 1)
            url = _field(image, "url", str, "")
            if url and not nsfw and level <= 1:
                gallery.append({"url": url, "width": _field(image, "width", (int, float), None),
                                "height": _field(image, "height", (int, float), None)})
        triggers = _field(version, "trainedWords", list, [])
        if any(not isinstance(word, str) for word in triggers):
            raise ServiceError("Civitai returned invalid trainedWords.")
        model_stats = _field(model, "stats", dict, {})
        version_stats = _field(version, "stats", dict, {})
        if any(not isinstance(stats[key], (int, float)) or isinstance(stats[key], bool)
               for stats in (model_stats, version_stats) for key in STAT_FIELDS if stats.get(key) is not None):
            raise ServiceError("Civitai returned invalid stats.")
        for file in _field(version, "files", list, []):
            if not isinstance(file, dict):
                raise ServiceError("Civitai returned an invalid file response.")
            sha256 = _field(_field(file, "hashes", dict, {}), "SHA256", str, "").lower()
            file_name = _field(file, "name", str, "")
            if _field(file, "type", str, "") != "Model" or not file_name.lower().endswith(".safetensors") or not re.fullmatch(r"[0-9a-f]{64}", sha256) or not _field(file, "downloadUrl", str, ""):
                continue
            candidate = {"model_id": model.get("id"), "version_id": version.get("id"), "file_id": file.get("id"),
                "name": _field(model, "name", str, ""), "version_name": _field(version, "name", str, ""), "base_model": _field(version, "baseModel", str, ""),
                "file_name": file_name, "size_kb": _field(file, "sizeKB", (int, float), 0), "sha256": sha256,
                "triggers": triggers, "image_url": gallery[0]["url"] if gallery else "", "gallery": gallery,
                "description": _field(model, "description", str, ""), "version_description": _field(version, "description", str, ""),
                "published_at": _field(version, "publishedAt", str, "") or _field(version, "createdAt", str, ""),
                "model_url": f"https://{host}/models/{model.get('id')}?modelVersionId={version.get('id')}",
                "stats": model_stats, "model_stats": model_stats, "version_stats": version_stats, "acquired": False, "lora_name": ""}
            try:
                candidate_identity(candidate)
            except ValueError as exc:
                raise ServiceError("Civitai returned invalid candidate identifiers.") from exc
            result.append(candidate)
    return result


def lora_root():
    paths = folder_paths.get_folder_paths("loras")
    if not paths:
        raise ValueError("No configured LoRA folder is available.")
    return Path(paths[0]).resolve()


def _filename(candidate):
    return "civitai-{}-{}-{}.safetensors".format(*candidate_identity(candidate))


def _sha256(path):
    while True:
        key = file_identity(path)
        with file_operation(key):
            if file_identity(path) != key:
                continue
            try:
                signature = file_signature(path)
            except OSError:
                with _HASH_LOCK:
                    _HASH_CACHE.pop(key, None)
                raise
            with _HASH_LOCK:
                generation = _HASH_CATALOG_GENERATION
                cached = _HASH_CACHE.get(key)
                if cached is not None and cached[0] != signature:
                    _HASH_CACHE.pop(key)
                    cached = None
            if cached is not None:
                value = cached[1]
            else:
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                value = digest.hexdigest()
            with _HASH_LOCK:
                try:
                    current_signature = file_signature(path)
                except OSError:
                    _HASH_CACHE.pop(key, None)
                    raise
                if current_signature != signature:
                    continue
                if generation == _HASH_CATALOG_GENERATION or _HASH_CATALOG.get(key) == signature:
                    _HASH_CACHE[key] = (signature, value)
            return value


def reconcile_lora_hashes(identities):
    """Drop removed/replaced files using an inventory the picker already read."""
    global _HASH_CATALOG, _HASH_CATALOG_GENERATION
    with _HASH_LOCK:
        _HASH_CATALOG = identities
        _HASH_CATALOG_GENERATION += 1
        for key, entry in list(_HASH_CACHE.items()):
            if identities.get(key) != entry[0]:
                _HASH_CACHE.pop(key)


def _manifest(root):
    path = root / "llm" / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _existing(candidate, root, manifest=None):
    path = root / "llm" / _filename(candidate)
    if path.is_file() and _sha256(path) == candidate["sha256"]:
        return path.relative_to(root).as_posix()
    if manifest is None:
        manifest = _manifest(root)
    if manifest:
        for entry in manifest.values():
            name = entry.get("lora_name", "")
            if entry.get("sha256") != candidate["sha256"] or not name.startswith("llm/"):
                continue
            path = (root / name).resolve()
            if root in path.parents and path.is_file() and _sha256(path) == candidate["sha256"]:
                return name
    return ""


def _record(root, candidate, name):
    path = root / "llm" / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    manifest["-".join(map(str, candidate_identity(candidate)))] = {"sha256": candidate["sha256"], "lora_name": name}
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".manifest-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(manifest, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


async def _file_io(function, *args, cancel_cleanup=None, **kwargs):
    """Settle the worker before cancellation can release its file ownership."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    cancellation = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            cancellation = exc
        except Exception:
            if cancellation is None:
                raise
            break
    if cancellation is not None:
        if not task.cancelled() and task.exception() is None and cancel_cleanup is not None:
            await _file_io(cancel_cleanup, task.result())
        raise cancellation
    return task.result()


def _create_download(folder):
    descriptor, temporary = tempfile.mkstemp(dir=folder, prefix=".download-", suffix=".part")
    try:
        return os.fdopen(descriptor, "wb"), temporary
    except Exception:
        os.close(descriptor)
        os.unlink(temporary)
        raise


def _discard_download(download):
    stream, temporary = download
    try:
        stream.close()
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


async def search(query, model_mode, sort="Most Downloaded", host="civitai.red"):
    host = validate_host(host)
    if sort not in SORTS:
        raise ValueError("Unsupported Civitai sort.")
    if model_mode not in MODES:
        raise ValueError("Unsupported model_mode.")
    data = await api_get("/api/v1/models", {"query": query, "types": "LORA", "limit": 30, "period": "AllTime", "sort": sort,
        "baseModels": ["Illustrious", "NoobAI"] if model_mode == "Illustrious" else ["Anima"], "nsfw": "false"}, host=host)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ServiceError("Civitai returned an invalid search response.")
    items = []
    for model in data["items"][:30]:
        candidates = normalize(model, model_mode, host)
        if candidates:
            first_version = candidates[0]["version_id"]
            version = next(item for item in model["modelVersions"] if item["id"] == first_version)
            primary_ids = {file.get("id") for file in version.get("files", []) if _field(file, "primary", bool, False)}
            items.append(next((candidate for candidate in candidates if candidate["version_id"] == first_version and candidate["file_id"] in primary_ids), candidates[0]))
    root = lora_root()
    def mark_acquired():
        manifest = _manifest(root)
        for item in items:
            item["lora_name"] = _existing(item, root, manifest)
            item["acquired"] = bool(item["lora_name"])
    await asyncio.to_thread(mark_acquired)
    return {"items": items, "query": query, "sort": sort}


async def download(identity, model_mode, host="civitai.red"):
    global _DOWNLOAD_LOCK
    host = validate_host(host)
    ids = candidate_identity(identity)
    if _DOWNLOAD_LOCK is None:
        _DOWNLOAD_LOCK = asyncio.Lock()
    async with _DOWNLOAD_LOCK:
        model = await api_get(f"/api/v1/models/{ids[0]}", host=host)
        candidate = next((item for item in normalize(model, model_mode, host) if candidate_identity(item) == ids), None)
        if candidate is None:
            raise ValueError("Selected LoRA is unavailable or incompatible with this model mode.")
        root = lora_root()
        name = await _file_io(_existing, candidate, root)
        if not name:
            version = next(item for item in model["modelVersions"] if item["id"] == ids[1])
            file = next(item for item in version["files"] if item["id"] == ids[2])
            url = file["downloadUrl"]
            parsed = urlsplit(url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            selected_origin = api_origin(host)
            if origin not in (selected_origin, "https://civitai.red", "https://civitai.com") or not parsed.path.startswith("/api/download/") or parsed.fragment:
                raise ValueError("Civitai did not provide a trusted API download URL.")
            url = selected_origin + parsed.path + ("?" + parsed.query if parsed.query else "")
            folder = root / "llm"
            await _file_io(folder.mkdir, parents=True, exist_ok=True)
            stream, temporary = await _file_io(_create_download, folder, cancel_cleanup=_discard_download)
            digest = hashlib.sha256()
            def write_chunk(chunk):
                stream.write(chunk)
                digest.update(chunk)
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None), cookie_jar=aiohttp.DummyCookieJar()) as session:
                    for _ in range(6):
                        response = await session.get(url, allow_redirects=False)
                        if response.status not in (301, 302, 303, 307, 308):
                            break
                        from urllib.parse import urljoin
                        location = response.headers.get("Location")
                        response.release()
                        if not location:
                            raise ServiceError("Civitai download redirect has no location.")
                        url = urljoin(url, location)
                        if urlsplit(url).scheme not in ("http", "https"):
                            raise ServiceError("Civitai download redirect is invalid.")
                    async with response:
                        if response.status != 200:
                            raise ServiceError(f"Civitai download returned HTTP {response.status}.")
                        async for chunk in response.content.iter_chunked(1024 * 1024):
                            await _file_io(write_chunk, chunk)
                await _file_io(stream.close)
                if digest.hexdigest() != candidate["sha256"]:
                    raise ServiceError("Downloaded LoRA SHA256 does not match the published file.")
                destination = folder / _filename(candidate)
                await _file_io(os.replace, temporary, destination)
                name = destination.relative_to(root).as_posix()
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                raise ServiceError("Civitai download failed or timed out.") from exc
            finally:
                await _file_io(_discard_download, (stream, temporary))
        await _file_io(_record, root, candidate, name)
        cache = getattr(folder_paths, "filename_list_cache", None)
        if isinstance(cache, dict):
            cache.pop("loras", None)
        candidate.update(acquired=True, lora_name=name)
        return {"lora_name": name, "candidate": candidate}
