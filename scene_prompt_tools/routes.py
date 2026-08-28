import json
import re
import threading
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .nodes import release_scene_run_plan
from .prompt import (
    SAVED_PROMPTS_FOLDER,
    _clear_prompt_data_cache,
    _validate_selection_item,
    validate_prompt_data_item,
)
from .presets import (
    ScenePresetError,
    ScenePresetResolutionError,
    list_presets,
    release_scene_preset_snapshot,
    save_preset,
    snapshot_presets_for_run,
)


NODE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = NODE_DIR / "data"
SAVED_PROMPTS_DIR = DATA_DIR / SAVED_PROMPTS_FOLDER
PROMPT_FILE_NAME = "prompt.json"
DATA_WRITE_LOCK = threading.Lock()
_ROUTES_DEFINED = False
_CACHE_TTL_SECONDS = 2.0
_ITEMS_CACHE = {"expires": 0.0, "signature": None, "value": None}
_SAVED_PROMPTS_CACHE = {"expires": 0.0, "signature": None, "value": None}


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


def _clear_prompt_caches():
    _ITEMS_CACHE["expires"] = 0.0
    _SAVED_PROMPTS_CACHE["expires"] = 0.0
    _clear_prompt_data_cache()


def _read_items(path, category_path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prompt data file '{path.name}' is invalid JSON: {path}") from exc
    except OSError as exc:
        raise ValueError(f"Prompt data file '{path.name}' cannot be read: {path}") from exc

    if not isinstance(data, list):
        raise ValueError(f"Prompt data file '{path.name}' must be a JSON array: {path}")

    normalized = []
    for index, item in enumerate(data):
        normalized_item = validate_prompt_data_item(item, f"Prompt data file '{path.name}' item {index}")
        normalized_item["category_path"] = category_path
        normalized_item["category_key"] = " > ".join(category_path)
        normalized_item["category_label"] = " > ".join(category_path)
        normalized.append(normalized_item)
    return normalized


def _load_items():
    cached = _cache_get_unexpired(_ITEMS_CACHE)
    if cached is not None:
        return cached

    signature = _prompt_file_signature(DATA_DIR)
    cached = _cache_get(_ITEMS_CACHE, signature)
    if cached is not None:
        return cached

    items = []

    if not DATA_DIR.exists():
        return _cache_set(_ITEMS_CACHE, signature, items)

    for prompt_file in sorted(DATA_DIR.rglob(PROMPT_FILE_NAME)):
        category_path = list(prompt_file.parent.relative_to(DATA_DIR).parts)
        if category_path and category_path[0] != SAVED_PROMPTS_DIR.name:
            items.extend(_read_items(prompt_file, category_path))

    return _cache_set(_ITEMS_CACHE, signature, items)


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
        raise ValueError(f"Prompt data file '{path.name}' is invalid JSON: {path}") from exc
    except OSError as exc:
        raise ValueError(f"Prompt data file '{path.name}' cannot be read: {path}") from exc

    if not isinstance(data, list):
        raise ValueError(f"Prompt data file '{path.name}' must be a JSON array: {path}")
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


def _create_prompt_item(payload):
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")

    category = str(payload.get("category") or "").strip()
    subcategory = str(payload.get("subcategory") or "").strip()
    label = str(payload.get("label") or payload.get("name") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    description = str(payload.get("description") or "").strip()

    if not category:
        raise ValueError("category is required")
    if _safe_folder_name(category) == SAVED_PROMPTS_DIR.name:
        raise ValueError("reserved category name")
    if not label:
        raise ValueError("name is required")
    if not prompt:
        raise ValueError("prompt is required")

    with DATA_WRITE_LOCK:
        parts = [_safe_folder_name(category)]
        if subcategory:
            parts.append(_safe_folder_name(subcategory))
        target_dir = DATA_DIR.joinpath(*parts)
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
        _clear_prompt_caches()

        category_path = list(target.parent.relative_to(DATA_DIR).parts)
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


def _update_prompt_item(payload):
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")

    category_path = payload.get("category_path")
    if not isinstance(category_path, list):
        raise ValueError("category_path is required")
    safe_parts = [_safe_folder_name(part) for part in category_path if str(part or "").strip()]
    if not safe_parts or safe_parts[0] == SAVED_PROMPTS_DIR.name:
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
        target = DATA_DIR.joinpath(*safe_parts) / PROMPT_FILE_NAME
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
        _clear_prompt_caches()

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
        raise ValueError(f"{exc}: {prompt_file}") from exc


def _read_saved_prompt(prompt_file):
    try:
        with prompt_file.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' is invalid JSON: {prompt_file}") from exc
    except OSError as exc:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' cannot be read: {prompt_file}") from exc

    if not isinstance(data, dict) or set(data) != {"name", "description", "items"}:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' must be an object: {prompt_file}")
    if not isinstance(data.get("name"), str) or not data["name"].strip():
        raise ValueError(f"Saved prompt file '{prompt_file.name}' requires a non-empty name: {prompt_file}")
    if "description" in data and not isinstance(data["description"], str):
        raise ValueError(f"Saved prompt file '{prompt_file.name}' has an invalid description: {prompt_file}")
    if not isinstance(data.get("items"), list) or not data["items"]:
        raise ValueError(f"Saved prompt file '{prompt_file.name}' requires a non-empty items list: {prompt_file}")

    items = [_normalize_saved_item(item, prompt_file, index) for index, item in enumerate(data["items"])]

    category_path = list(prompt_file.parent.relative_to(SAVED_PROMPTS_DIR).parts)
    folder_name = prompt_file.parent.name
    name = data["name"].strip()
    return {
        "id": folder_name,
        "name": name,
        "description": str(data.get("description") or ""),
        "category_path": category_path or [folder_name],
        "items": items,
    }


def _load_saved_prompts():
    cached = _cache_get_unexpired(_SAVED_PROMPTS_CACHE)
    if cached is not None:
        return cached

    signature = _prompt_file_signature(SAVED_PROMPTS_DIR)
    cached = _cache_get(_SAVED_PROMPTS_CACHE, signature)
    if cached is not None:
        return cached

    saved = []
    if not SAVED_PROMPTS_DIR.exists():
        return _cache_set(_SAVED_PROMPTS_CACHE, signature, saved)

    for prompt_file in sorted(SAVED_PROMPTS_DIR.rglob(PROMPT_FILE_NAME)):
        saved.append(_read_saved_prompt(prompt_file))
    return _cache_set(_SAVED_PROMPTS_CACHE, signature, saved)


def _save_prompt_payload(payload):
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
        target_dir = _unique_child_dir(SAVED_PROMPTS_DIR, folder_name)
        target = target_dir / PROMPT_FILE_NAME
        data = {
            "name": name,
            "description": str(payload.get("description") or "").strip(),
            "items": items,
        }
        _write_prompt_payload(target, data)
        _clear_prompt_caches()

        return _read_saved_prompt(target)


def define_routes():
    global _ROUTES_DEFINED
    if _ROUTES_DEFINED or getattr(PromptServer.instance, "_scene_prompt_routes_defined", False):
        return
    _ROUTES_DEFINED = True
    setattr(PromptServer.instance, "_scene_prompt_routes_defined", True)

    @PromptServer.instance.routes.get("/scene_prompt/items")
    async def scene_prompt_items(_request):
        try:
            return web.json_response({"items": _load_items()})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/scene_prompt/saved_prompts")
    async def scene_prompt_saved_prompts(_request):
        try:
            return web.json_response({"saved_prompts": _load_saved_prompts()})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/scene_prompt/saved_prompts")
    async def scene_prompt_save_prompt(request):
        try:
            payload = await request.json()
            saved = _save_prompt_payload(payload)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        try:
            saved_prompts = _load_saved_prompts()
        except Exception as exc:
            return web.json_response({"error": f"Saved prompt was written, but reload failed: {exc}"}, status=500)

        return web.json_response({"saved_prompt": saved, "saved_prompts": saved_prompts})

    @PromptServer.instance.routes.post("/scene_prompt/items")
    async def scene_prompt_create_item(request):
        try:
            payload = await request.json()
            if isinstance(payload, dict) and payload.get("mode") == "update":
                item = _update_prompt_item(payload)
            else:
                item = _create_prompt_item(payload)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        try:
            items = _load_items()
        except Exception as exc:
            return web.json_response({"error": f"Prompt item was written, but reload failed: {exc}"}, status=500)

        return web.json_response({"item": item, "items": items})

    @PromptServer.instance.routes.post("/scene_prompt/run_plan/release")
    async def scene_prompt_release_run_plan(request):
        try:
            payload = await request.json()
            run_id = payload.get("run_id") if isinstance(payload, dict) else ""
            released = release_scene_run_plan(run_id)
            preset_released = release_scene_preset_snapshot(run_id)
            return web.json_response({"released": released or preset_released})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/scene_presets/save")
    async def scene_presets_save(request):
        try:
            saved = save_preset(await request.json())
            return web.json_response({"metadata": saved["metadata"]})
        except ScenePresetError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Presetを保存できませんでした: {exc}"}, status=500)

    @PromptServer.instance.routes.get("/scene_presets/list")
    async def scene_presets_list(_request):
        try:
            return web.json_response(list_presets())
        except ScenePresetError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Preset一覧を取得できませんでした: {exc}"}, status=500)

    @PromptServer.instance.routes.post("/scene_presets/resolve")
    async def scene_presets_resolve(request):
        try:
            payload = await request.json()
            run_id = payload.get("run_id") if isinstance(payload, dict) else ""
            api_graph = payload.get("api_graph") if isinstance(payload, dict) else None
            expand_node_id = payload.get("expand_node_id") if isinstance(payload, dict) else None
            return web.json_response(snapshot_presets_for_run(run_id, api_graph, expand_node_id))
        except ScenePresetResolutionError as exc:
            return web.json_response({"error": str(exc), "node_id": exc.node_id}, status=400)
        except ScenePresetError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Presetを検証できませんでした: {exc}"}, status=500)
