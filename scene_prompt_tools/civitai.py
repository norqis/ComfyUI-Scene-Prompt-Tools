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
from .lora_metadata import file_identity, file_signature

SORTS = ("Most Downloaded", "Most Liked", "Most Collected", "Highest Rated")
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


def api_origin():
    return "https://civitai.red"


async def api_get(path, params=None, *, missing_ok=False):
    url = api_origin() + path
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None), cookie_jar=aiohttp.DummyCookieJar()) as session:
            async with session.get(url, params=params, allow_redirects=False) as response:
                if missing_ok and response.status == 404:
                    return _NOT_FOUND
                if response.status != 200:
                    raise ServiceError(f"Civitai API returned HTTP {response.status}.")
                return await response.json()
    except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
        raise ServiceError("Civitai connection failed, timed out, or returned invalid JSON.") from exc


async def by_hash(sha256):
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise ValueError("SHA256 must contain exactly 64 hexadecimal digits.")
    version = await api_get("/api/v1/model-versions/by-hash/" + sha256.lower(), missing_ok=True)
    if version is _NOT_FOUND:
        return {"found": False, "version": None}
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


def normalize(model, mode):
    if not isinstance(model, dict) or not isinstance(model.get("modelVersions", []), list):
        raise ServiceError("Civitai returned an invalid model response.")
    if model.get("type") != "LORA" or model.get("mode") or model.get("availability", "Public") != "Public":
        return []
    result = []
    for version in model.get("modelVersions", []):
        if not isinstance(version, dict):
            raise ServiceError("Civitai returned an invalid version response.")
        if not compatible(version.get("baseModel"), mode) or version.get("availability", "Public") != "Public":
            continue
        images = version.get("images", [])
        image_url = next((image.get("url", "") for image in images if not image.get("nsfw") and image.get("nsfwLevel", 1) <= 1), "")
        for file in version.get("files", []):
            if not isinstance(file, dict):
                raise ServiceError("Civitai returned an invalid file response.")
            sha256 = str(file.get("hashes", {}).get("SHA256", "")).lower()
            if file.get("type") != "Model" or not str(file.get("name", "")).lower().endswith(".safetensors") or not re.fullmatch(r"[0-9a-f]{64}", sha256) or not file.get("downloadUrl"):
                continue
            candidate = {"model_id": model["id"], "version_id": version["id"], "file_id": file["id"],
                "name": model.get("name", ""), "version_name": version.get("name", ""), "base_model": version.get("baseModel", ""),
                "file_name": file["name"], "size_kb": file.get("sizeKB", 0), "sha256": sha256,
                "triggers": version.get("trainedWords", []), "image_url": image_url,
                "model_url": f"https://civitai.red/models/{model['id']}?modelVersionId={version['id']}",
                "stats": model.get("stats", {}), "acquired": False, "lora_name": ""}
            candidate_identity(candidate)
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
    key = file_identity(path)
    while True:
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


async def search(query, model_mode, sort="Most Downloaded"):
    if sort not in SORTS:
        raise ValueError("Unsupported Civitai sort.")
    if model_mode not in MODES:
        raise ValueError("Unsupported model_mode.")
    data = await api_get("/api/v1/models", {"query": query, "types": "LORA", "limit": 30, "period": "AllTime", "sort": sort,
        "baseModels": ["Illustrious", "NoobAI"] if model_mode == "Illustrious" else ["Anima"], "nsfw": "false"})
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ServiceError("Civitai returned an invalid search response.")
    items = []
    for model in data["items"][:30]:
        candidates = normalize(model, model_mode)
        if candidates:
            first_version = candidates[0]["version_id"]
            version = next(item for item in model["modelVersions"] if item["id"] == first_version)
            primary_ids = {file["id"] for file in version.get("files", []) if file.get("primary")}
            items.append(next((candidate for candidate in candidates if candidate["version_id"] == first_version and candidate["file_id"] in primary_ids), candidates[0]))
    root = lora_root()
    def mark_acquired():
        manifest = _manifest(root)
        for item in items:
            item["lora_name"] = _existing(item, root, manifest)
            item["acquired"] = bool(item["lora_name"])
    await asyncio.to_thread(mark_acquired)
    return {"items": items, "query": query, "sort": sort}


async def download(identity, model_mode):
    global _DOWNLOAD_LOCK
    ids = candidate_identity(identity)
    if _DOWNLOAD_LOCK is None:
        _DOWNLOAD_LOCK = asyncio.Lock()
    async with _DOWNLOAD_LOCK:
        model = await api_get(f"/api/v1/models/{ids[0]}")
        candidate = next((item for item in normalize(model, model_mode) if candidate_identity(item) == ids), None)
        if candidate is None:
            raise ValueError("Selected LoRA is unavailable or incompatible with this model mode.")
        root = lora_root()
        name = await _file_io(_existing, candidate, root)
        if not name:
            version = next(item for item in model["modelVersions"] if item["id"] == ids[1])
            file = next(item for item in version["files"] if item["id"] == ids[2])
            url = file["downloadUrl"]
            if not url.startswith(api_origin() + "/api/download/"):
                raise ValueError("Civitai did not provide a trusted API download URL.")
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
