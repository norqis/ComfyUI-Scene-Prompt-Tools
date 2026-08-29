import json
import asyncio
import re
import threading
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .prompt import (
    SAVED_PROMPTS_FOLDER,
    _clear_prompt_data_cache,
    _prompt_data_index,
    project_prompt_data_index,
    _validate_selection_item,
    validate_prompt_data_item,
)
from .runs import (
    SceneRunError,
    claim_run_context,
    create_run_context,
    purge_expired_run_contexts,
    release_run_context,
    replace_run_prompt_data_index,
    set_run_expiration_callback,
)
from .presets import (
    ScenePresetError,
    ScenePresetResolutionError,
    list_presets,
    release_scene_preset_snapshot,
    save_preset,
    snapshot_presets_for_run,
)
from .storage import prompt_data_directory


set_run_expiration_callback(release_scene_preset_snapshot)


PROMPT_FILE_NAME = "prompt.json"
DATA_WRITE_LOCK = threading.Lock()
DATA_CACHE_LOCK = threading.RLock()
_ROUTES_DEFINED = False
_CACHE_TTL_SECONDS = 2.0
_ITEMS_CACHE = {}
_SAVED_PROMPTS_CACHE = {}
_CACHE_GENERATIONS = {}


def _request_user_id(request):
    return PromptServer.instance.user_manager.get_request_user_id(request)


def _data_dir(user_id="default"):
    return prompt_data_directory(user_id)


def _saved_prompts_dir(user_id="default"):
    return _data_dir(user_id) / SAVED_PROMPTS_FOLDER


def _cache_for(caches, user_id):
    return caches.setdefault(str(user_id or "default"), {"expires": 0.0, "signature": None, "value": None})


def _cache_generation(user_id):
    return _CACHE_GENERATIONS.get(str(user_id or "default"), 0)


def _prompt_file_signature(root):
    if not root.exists():
        return ()
    signature = []
    for prompt_file in sorted(root.rglob(PROMPT_FILE_NAME)):
        try:
            stat = prompt_file.stat()
        except OSError:
            continue
        signature.append((str(prompt_file.relative_to(root)), stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


def _cache_get(cache, signature):
    if cache.get("signature") == signature and cache.get("expires", 0.0) > time.monotonic():
        value = cache.get("value")
        if value is not None:
            return value
    return None


def _cache_get_unexpired(cache):
    if cache.get("expires", 0.0) <= time.monotonic():
        return None
    value = cache.get("value")
    return value if value is not None else None


def _cache_set(cache, signature, value):
    cache["signature"] = signature
    cache["value"] = value
    cache["expires"] = time.monotonic() + _CACHE_TTL_SECONDS
    return value


def _clear_prompt_caches(user_id="default"):
    user_key = str(user_id or "default")
    with DATA_CACHE_LOCK:
        _CACHE_GENERATIONS[user_key] = _cache_generation(user_key) + 1
        _ITEMS_CACHE.pop(user_key, None)
        _SAVED_PROMPTS_CACHE.pop(user_key, None)
        _clear_prompt_data_cache(user_id)


def _read_items(path, category_path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prompt data file '{path.name}' is invalid JSON.") from exc
    except OSError as exc:
        raise ValueError(f"Prompt data file '{path.name}' cannot be read.") from exc

    if not isinstance(data, list):
        raise ValueError(f"Prompt data file '{path.name}' must be a JSON array.")

    normalized = []
    for index, item in enumerate(data):
        normalized_item = validate_prompt_data_item(item, f"Prompt data file '{path.name}' item {index}")
        normalized_item["category_path"] = category_path
        normalized_item["category_key"] = " > ".join(category_path)
        normalized_item["category_label"] = " > ".join(category_path)
        normalized.append(normalized_item)
    return normalized


def _load_items(user_id="default"):
    data_dir = _data_dir(user_id)
    saved_prompts_dir = _saved_prompts_dir(user_id)
    while True:
        with DATA_CACHE_LOCK:
            generation = _cache_generation(user_id)
            cache = _cache_for(_ITEMS_CACHE, user_id)
            cached = _cache_get_unexpired(cache)
            if cached is not None:
                return cached

        signature = _prompt_file_signature(data_dir)
        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            cached = _cache_get(cache, signature)
            if cached is not None:
                return cached

        items = []
        if data_dir.exists():
            for prompt_file in sorted(data_dir.rglob(PROMPT_FILE_NAME)):
                category_path = list(prompt_file.parent.relative_to(data_dir).parts)
                if category_path and category_path[0] != saved_prompts_dir.name:
                    items.extend(_read_items(prompt_file, category_path))

        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            return _cache_set(cache, signature, items)


def _safe_folder_name(name):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name or "").strip())
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:80] or "untitled"


def _safe_id(name):
    value = re.sub(r"\s+", "_", str(name or "").strip().lower())
    value = re.sub(r"[^0-9a-zA-Z_\-\u3040-\u30ff\u3400-\u9fff]+", "_", value)
    value = value.strip("_")
    return value[:80] or "prompt"


def _existing_ids(data, exclude_index=None):
    ids = set()
    for index, item in enumerate(data):
        if index == exclude_index or not isinstance(item, dict):
            continue
        if item.get("id"):
            ids.add(str(item.get("id")))
    return ids


def _unique_item_id(data, base, exclude_index=None):
    existing = _existing_ids(data, exclude_index)
    base_id = _safe_id(base)
    item_id = base_id
    suffix = 2
    while item_id in existing:
        item_id = f"{base_id}_{suffix}"
        suffix += 1
    return item_id


def _read_prompt_payload(path):
    if not path.exists():
        return []

    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prompt data file '{path.name}' is invalid JSON.") from exc
    except OSError as exc:
        raise ValueError(f"Prompt data file '{path.name}' cannot be read.") from exc

    if not isinstance(data, list):
        raise ValueError(f"Prompt data file '{path.name}' must be a JSON array.")
    return [
        validate_prompt_data_item(item, f"Prompt data file '{path.name}' item {index}")
        for index, item in enumerate(data)
    ]


def _write_prompt_payload(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temp.replace(path)


def _unique_child_dir(parent, folder_name):
    candidate = parent / folder_name
    if not candidate.exists():
        return candidate

    index = 2
    while True:
        candidate = parent / f"{folder_name}_{index}"
        if not candidate.exists():
            return candidate
        index += 1


def _create_prompt_item(payload, user_id="default"):
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")

    category = str(payload.get("category") or "").strip()
    subcategory = str(payload.get("subcategory") or "").strip()
    label = str(payload.get("label") or payload.get("name") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    description = str(payload.get("description") or "").strip()

    if not category:
        raise ValueError("category is required")
    data_dir = _data_dir(user_id)
    saved_prompts_dir = _saved_prompts_dir(user_id)
    if _safe_folder_name(category) == saved_prompts_dir.name:
        raise ValueError("reserved category name")
    if not label:
        raise ValueError("name is required")
    if not prompt:
        raise ValueError("prompt is required")

    with DATA_WRITE_LOCK:
        parts = [_safe_folder_name(category)]
        if subcategory:
            parts.append(_safe_folder_name(subcategory))
        target_dir = data_dir.joinpath(*parts)
        target = target_dir / PROMPT_FILE_NAME
        data = _read_prompt_payload(target)

        base_id = _safe_id(label)
        existing_ids = {
            str(item.get("id"))
            for item in data
            if isinstance(item, dict) and item.get("id")
        }

        item_id = base_id
        suffix = 2
        while item_id in existing_ids:
            item_id = f"{base_id}_{suffix}"
            suffix += 1

        item = {
            "id": item_id,
            "label": label,
            "prompt": prompt,
        }
        if description:
            item["description"] = description

        data.append(item)
        _write_prompt_payload(target, data)
        _clear_prompt_caches(user_id)

        category_path = list(target.parent.relative_to(data_dir).parts)
        normalized = dict(item)
        normalized["category_path"] = category_path
        normalized["category_key"] = " > ".join(category_path)
        normalized["category_label"] = " > ".join(category_path)
        return normalized


def _item_matches_update_target(item, target):
    if not isinstance(item, dict) or not isinstance(target, dict):
        return False

    item_id = str(item.get("id") or "").strip()
    target_id = str(target.get("id") or "").strip()
    if item_id and target_id:
        return item_id == target_id

    for key in ("label", "prompt", "description"):
        if str(item.get(key) or "").strip() != str(target.get(key) or "").strip():
            return False
    return True


def _update_prompt_item(payload, user_id="default"):
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")

    category_path = payload.get("category_path")
    if not isinstance(category_path, list):
        raise ValueError("category_path is required")
    safe_parts = [_safe_folder_name(part) for part in category_path if str(part or "").strip()]
    data_dir = _data_dir(user_id)
    if not safe_parts or safe_parts[0] == _saved_prompts_dir(user_id).name:
        raise ValueError("invalid category_path")

    label = str(payload.get("label") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    description = str(payload.get("description") or "").strip()
    target_item = payload.get("original")
    if not isinstance(target_item, dict):
        raise ValueError("original item is required")
    if not label:
        raise ValueError("name is required")
    if not prompt:
        raise ValueError("prompt is required")

    with DATA_WRITE_LOCK:
        target = data_dir.joinpath(*safe_parts) / PROMPT_FILE_NAME
        data = _read_prompt_payload(target)

        updated = None
        for index, item in enumerate(data):
            if not _item_matches_update_target(item, target_item):
                continue
            next_item = dict(item)
            if not str(next_item.get("id") or "").strip():
                next_item["id"] = _unique_item_id(
                    data,
                    item.get("label") or target_item.get("label") or label or item.get("prompt") or target_item.get("prompt"),
                    exclude_index=index,
                )
            next_item["label"] = label
            next_item["prompt"] = prompt
            if description:
                next_item["description"] = description
            else:
                next_item.pop("description", None)
            data[index] = next_item
            updated = next_item
            break

        if updated is None:
            raise ValueError("item not found")

        _write_prompt_payload(target, data)
        _clear_prompt_caches(user_id)

        normalized = dict(updated)
        normalized["category_path"] = safe_parts
        normalized["category_key"] = " > ".join(safe_parts)
        normalized["category_label"] = " > ".join(safe_parts)
        return normalized


def _normalize_saved_item(item, prompt_file, index):
    category = item.get("category_key") if isinstance(item, dict) else ""
    try:
        return _validate_selection_item(
            item,
            category,
            f"Saved prompt file '{prompt_file.name}' item {index}",
        )
    except ValueError as exc:
        raise ValueError(str(exc)) from exc


def _read_saved_prompt(prompt_file, saved_prompts_dir):
    try:
        with prompt_file.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' is invalid JSON.") from exc
    except OSError as exc:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' cannot be read.") from exc

    if not isinstance(data, dict) or set(data) != {"name", "description", "items"}:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' must be an object.")
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError(f"Saved prompt file '{prompt_file.name}' requires a non-empty name.")
    if "description" in data and not isinstance(data["description"], str):
        raise ValueError(f"Saved prompt file '{prompt_file.name}' has an invalid description.")
    if not isinstance(data.get("items"), list) or not data["items"]:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' requires a non-empty items list.")

    items = [_normalize_saved_item(item, prompt_file, index) for index, item in enumerate(data["items"])]

    category_path = list(prompt_file.parent.relative_to(saved_prompts_dir).parts)
    folder_name = prompt_file.parent.name
    name = data["name"].strip()
    return {
        "id": folder_name,
        "name": name,
        "description": str(data.get("description") or ""),
        "category_path": category_path or [folder_name],
        "items": items,
    }


def _load_saved_prompts(user_id="default"):
    saved_prompts_dir = _saved_prompts_dir(user_id)
    while True:
        with DATA_CACHE_LOCK:
            generation = _cache_generation(user_id)
            cache = _cache_for(_SAVED_PROMPTS_CACHE, user_id)
            cached = _cache_get_unexpired(cache)
            if cached is not None:
                return cached

        signature = _prompt_file_signature(saved_prompts_dir)
        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            cached = _cache_get(cache, signature)
            if cached is not None:
                return cached

        saved = []
        if saved_prompts_dir.exists():
            for prompt_file in sorted(saved_prompts_dir.rglob(PROMPT_FILE_NAME)):
                saved.append(_read_saved_prompt(prompt_file, saved_prompts_dir))

        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            return _cache_set(cache, signature, saved)


def _save_prompt_payload(payload, user_id="default"):
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")

    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")

    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("items are required")
    items = [_normalize_saved_item(item, Path("request"), index) for index, item in enumerate(raw_items)]

    with DATA_WRITE_LOCK:
        folder_name = _safe_folder_name(name)
        target_dir = _unique_child_dir(_saved_prompts_dir(user_id), folder_name)
        target = target_dir / PROMPT_FILE_NAME
        data = {
            "name": name,
            "description": str(payload.get("description") or "").strip(),
            "items": items,
        }
        _write_prompt_payload(target, data)
        _clear_prompt_caches(user_id)

        return _read_saved_prompt(target, _saved_prompts_dir(user_id))


def define_routes():
    global _ROUTES_DEFINED
    if _ROUTES_DEFINED or getattr(PromptServer.instance, "_scene_prompt_routes_defined", False):
        return
    _ROUTES_DEFINED = True
    setattr(PromptServer.instance, "_scene_prompt_routes_defined", True)

    @PromptServer.instance.routes.get("/scene_prompt/items")
    async def scene_prompt_items(request):
        try:
            user_id = _request_user_id(request)
            return web.json_response({"items": await asyncio.to_thread(_load_items, user_id)})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/scene_prompt/saved_prompts")
    async def scene_prompt_saved_prompts(request):
        try:
            user_id = _request_user_id(request)
            return web.json_response({"saved_prompts": await asyncio.to_thread(_load_saved_prompts, user_id)})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/scene_prompt/saved_prompts")
    async def scene_prompt_save_prompt(request):
        try:
            payload = await request.json()
            user_id = _request_user_id(request)
            saved = await asyncio.to_thread(_save_prompt_payload, payload, user_id)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        try:
            saved_prompts = await asyncio.to_thread(_load_saved_prompts, user_id)
        except Exception as exc:
            return web.json_response({"error": f"Saved prompt was written, but reload failed: {exc}"}, status=500)

        return web.json_response({"saved_prompt": saved, "saved_prompts": saved_prompts})

    @PromptServer.instance.routes.post("/scene_prompt/items")
    async def scene_prompt_create_item(request):
        try:
            payload = await request.json()
            user_id = _request_user_id(request)
            if isinstance(payload, dict) and payload.get("mode") == "update":
                item = await asyncio.to_thread(_update_prompt_item, payload, user_id)
            else:
                item = await asyncio.to_thread(_create_prompt_item, payload, user_id)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        try:
            items = await asyncio.to_thread(_load_items, user_id)
        except Exception as exc:
            return web.json_response({"error": f"Prompt item was written, but reload failed: {exc}"}, status=500)

        return web.json_response({"item": item, "items": items})

    @PromptServer.instance.routes.post("/scene_prompt/runs/prepare")
    async def scene_prompt_prepare_run(request):
        handle = ""
        user_id = ""
        try:
            purge_expired_run_contexts()
            payload = await request.json()
            api_graph = payload.get("api_graph") if isinstance(payload, dict) else None
            expand_node_id = payload.get("expand_node_id") if isinstance(payload, dict) else None
            user_id = _request_user_id(request)
            prompt_index = await asyncio.to_thread(_prompt_data_index, user_id)
            handle = create_run_context(user_id, prompt_index)
            snapshot = await asyncio.to_thread(snapshot_presets_for_run, handle, api_graph, expand_node_id, user_id)
            projection = await asyncio.to_thread(
                project_prompt_data_index,
                api_graph,
                prompt_index,
                snapshot.get("preset_graphs", {}),
                expand_node_id,
            )
            replace_run_prompt_data_index(handle, projection)
            return web.json_response({"run_handle": handle, **snapshot})
        except ScenePresetResolutionError as exc:
            if handle:
                release_run_context(handle, user_id)
                release_scene_preset_snapshot(handle, user_id)
            return web.json_response({"error": str(exc), "node_id": exc.node_id}, status=400)
        except Exception as exc:
            if handle:
                release_run_context(handle, user_id)
                release_scene_preset_snapshot(handle, user_id)
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/scene_prompt/runs/claim")
    async def scene_prompt_claim_run(request):
        try:
            purge_expired_run_contexts()
            payload = await request.json()
            handle = payload.get("run_handle") if isinstance(payload, dict) else ""
            prompt_id = payload.get("prompt_id") if isinstance(payload, dict) else ""
            claimed = claim_run_context(handle, _request_user_id(request), prompt_id)
            return web.json_response({"claimed": claimed})
        except SceneRunError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/scene_prompt/runs/release")
    async def scene_prompt_release_run(request):
        try:
            payload = await request.json()
            run_handle = payload.get("run_handle") if isinstance(payload, dict) else ""
            user_id = _request_user_id(request)
            released = release_run_context(run_handle, user_id)
            preset_released = release_scene_preset_snapshot(run_handle, user_id)
            return web.json_response({"released": released or preset_released})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/scene_presets/save")
    async def scene_presets_save(request):
        try:
            saved = await asyncio.to_thread(save_preset, await request.json(), _request_user_id(request))
            return web.json_response({"metadata": saved["metadata"]})
        except ScenePresetResolutionError as exc:
            return web.json_response({"error": str(exc), "node_id": exc.node_id}, status=400)
        except ScenePresetError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Presetを保存できませんでした: {exc}"}, status=500)

    @PromptServer.instance.routes.get("/scene_presets/list")
    async def scene_presets_list(request):
        try:
            return web.json_response(await asyncio.to_thread(list_presets, _request_user_id(request)))
        except ScenePresetError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Preset一覧を取得できませんでした: {exc}"}, status=500)
