import json
import asyncio
import hashlib
import os
import re
import tempfile
import threading
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .prompt import (
    _validate_selection_item,
)
from .runs import (
    SceneRunError,
    begin_last_callback,
    claim_run_context,
    create_run_context,
    finish_last_callback,
    purge_expired_run_contexts,
    reconcile_active_run_contexts,
    release_run_context,
    set_run_expiration_callback,
)
from .callbacks import CALLBACK_FAILURE_STOP, SceneCallbackError, acknowledge_desktop_callback, dispatch_callback
from .presets import (
    ScenePresetError,
    ScenePresetNotFoundError,
    ScenePresetResolutionError,
    load_preset,
    list_presets,
    release_scene_preset_snapshot,
    save_preset,
    snapshot_presets_for_run,
)
from .storage import prompt_data_directory, is_windows_reserved_name
from .lora_metadata import list_loras, read_lora_info
from .resource_info import connected_resources, read_model_hash


set_run_expiration_callback(release_scene_preset_snapshot)


PROMPT_FILE_NAME = "prompt.json"
SAVED_PROMPTS_FOLDER = "保存済みプロンプト"
DATA_WRITE_LOCK = threading.Lock()
DATA_CACHE_LOCK = threading.RLock()
_ROUTES_DEFINED = False
_CACHE_TTL_SECONDS = 2.0
_ITEMS_CACHE = {}
_SAVED_PROMPTS_CACHE = {}
_CACHE_GENERATION = 0


def _request_user_id(request):
    return PromptServer.instance.user_manager.get_request_user_id(request)


def _queued_prompt_ids():
    prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
    if prompt_queue is None:
        return None
    running, pending = prompt_queue.get_current_queue_volatile()
    return {
        str(item[1])
        for item in (*running, *pending)
        if isinstance(item, (tuple, list)) and len(item) > 1 and str(item[1])
    }


def _completed_prompt_status(prompt_id):
    prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
    history = prompt_queue.get_history(prompt_id=str(prompt_id)) if prompt_queue is not None else {}
    entry = history.get(str(prompt_id)) if isinstance(history, dict) else None
    status = entry.get("status") if isinstance(entry, dict) else None
    if not isinstance(status, dict):
        return "pending"
    status_str = status.get("status_str")
    if status_str == "error":
        return "failed"
    if not status.get("completed"):
        return "pending"
    return "success" if status_str == "success" else "failed"


def _is_continuous_scene_run(api_graph, expand_node_id):
    node = ((api_graph or {}).get("output") or {}).get(str(expand_node_id or ""))
    return bool(
        isinstance(node, dict)
        and node.get("class_type") == "ScenePrompterExpand"
        and str((node.get("inputs") or {}).get("run_id") or "").strip()
    )


def _data_dir(user_id="default"):
    return prompt_data_directory(user_id)


def _saved_prompts_dir(user_id="default"):
    return _data_dir(user_id) / SAVED_PROMPTS_FOLDER


def _cache_for(caches, user_id):
    user_key = str(user_id or "default")
    now = time.monotonic()
    for key, entry in list(caches.items()):
        if key != user_key and entry["expires"] <= now:
            caches.pop(key)
    return caches.get(user_key)


def _cache_generation(user_id):
    return _CACHE_GENERATION


def _read_prompt_bytes(path):
    try:
        return path.read_bytes()
    except OSError:
        return None


def _prompt_file_snapshot(root):
    signature = []
    digest = hashlib.sha256()
    files = []
    if not root.exists():
        return (), digest.hexdigest(), files
    for prompt_file in sorted(root.rglob(PROMPT_FILE_NAME)):
        relative_path = str(prompt_file.relative_to(root))
        try:
            stat = prompt_file.stat()
        except OSError:
            signature.append((relative_path, None, None))
            content = None
        else:
            signature.append((relative_path, stat.st_mtime_ns, stat.st_size))
            content = _read_prompt_bytes(prompt_file)
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(b"\0" if content is None else b"\1")
        if content is not None:
            digest.update(content)
        files.append((prompt_file, content))
    return tuple(signature), digest.hexdigest(), files


def _cache_get(caches, user_id, signature, content_hash):
    user_key = str(user_id or "default")
    cache = _cache_for(caches, user_id)
    if cache is not None and cache.get("signature") == signature and cache.get("content_hash") == content_hash:
        value = cache.get("value")
        if value is not None:
            refreshed = {**cache, "expires": time.monotonic() + _CACHE_TTL_SECONDS}
            caches[user_key] = refreshed
            return value
    return None


def _cache_get_unexpired(cache):
    if cache is None or cache.get("expires", 0.0) <= time.monotonic():
        return None
    value = cache.get("value")
    return value if value is not None else None


def _cache_entry(user_id, signature, content_hash, value):
    entry = {"signature": signature, "content_hash": content_hash, "value": value,
             "expires": time.monotonic() + _CACHE_TTL_SECONDS}
    return entry


def _clear_prompt_caches(user_id="default"):
    global _CACHE_GENERATION
    user_key = str(user_id or "default")
    with DATA_CACHE_LOCK:
        _CACHE_GENERATION += 1
        _ITEMS_CACHE.pop(user_key, None)
        _SAVED_PROMPTS_CACHE.pop(user_key, None)


def _validate_prompt_data_item(item, label="Prompt data item"):
    if not isinstance(item, dict) or not {"label", "prompt"}.issubset(item) or set(item) - {"id", "label", "prompt", "description"}:
        raise ValueError(f"{label} has unsupported or missing fields.")
    result = {}
    for key in ("label", "prompt"):
        value = item[key]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} {key} must be a non-empty string.")
        result[key] = value
    if "id" in item:
        if not isinstance(item["id"], str) or not item["id"].strip():
            raise ValueError(f"{label} id must be a non-empty string.")
        result["id"] = item["id"]
    if "description" in item:
        if not isinstance(item["description"], str):
            raise ValueError(f"{label} description must be a string.")
        result["description"] = item["description"]
    return result


def _parse_prompt_json(content, path, label):
    if content is None:
        raise ValueError(f"{label} file '{path.name}' cannot be read.")
    try:
        return json.loads(content.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} file '{path.name}' is invalid JSON.") from exc


def _normalize_prompt_data(data, path):
    if not isinstance(data, list):
        raise ValueError(f"Prompt data file '{path.name}' must be a JSON array.")
    return [
        _validate_prompt_data_item(item, f"Prompt data file '{path.name}' item {index}")
        for index, item in enumerate(data)
    ]


def _parse_items(content, path, category_path):
    data = _parse_prompt_json(content, path, "Prompt data")
    normalized = _normalize_prompt_data(data, path)
    for normalized_item in normalized:
        normalized_item["category_path"] = category_path
        normalized_item["category_key"] = " > ".join(category_path)
        normalized_item["category_label"] = " > ".join(category_path)
    return normalized


def _read_items(path, category_path):
    return _parse_items(_read_prompt_bytes(path), path, category_path)


def _cache_value(value, key, with_errors):
    return value if with_errors else value[key]


def _load_items(user_id="default", force=False, with_errors=False):
    data_dir = _data_dir(user_id)
    saved_prompts_dir = _saved_prompts_dir(user_id)
    while True:
        with DATA_CACHE_LOCK:
            generation = _cache_generation(user_id)
            cache = _cache_for(_ITEMS_CACHE, user_id)
            cached = None if force else _cache_get_unexpired(cache)
            if cached is not None:
                return _cache_value(cached, "items", with_errors)

        signature, content_hash, files = _prompt_file_snapshot(data_dir)
        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            cached = None if force else _cache_get(_ITEMS_CACHE, user_id, signature, content_hash)
            if cached is not None:
                return _cache_value(cached, "items", with_errors)

        items = []
        errors = []
        for prompt_file, content in files:
            category_path = list(prompt_file.parent.relative_to(data_dir).parts)
            if category_path and category_path[0] != saved_prompts_dir.name:
                try:
                    items.extend(_parse_items(content, prompt_file, category_path))
                except ValueError as exc:
                    errors.append({"file": prompt_file.relative_to(data_dir).as_posix(), "error": str(exc)})

        refreshed_signature, refreshed_content_hash, _ = _prompt_file_snapshot(data_dir)
        value = {"items": items, "errors": errors}
        entry = _cache_entry(user_id, refreshed_signature, refreshed_content_hash, value)
        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            if signature != refreshed_signature or content_hash != refreshed_content_hash:
                continue
            _ITEMS_CACHE[str(user_id or "default")] = entry
        return _cache_value(value, "items", with_errors)


def _folder_component(value, field):
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required")
    if text in {".", ".."} or re.search(r'[<>:"/\\|?*\x00-\x1f]', text):
        raise ValueError(f"{field} contains unsupported path characters")
    if text != text.strip(" ."):
        raise ValueError(f"{field} cannot start or end with a dot or space")
    if os.name == "nt" and is_windows_reserved_name(text):
        raise ValueError(f"{field}: Windowsの予約名「{text}」は保存先に使えません。")
    return text


def _safe_id(name):
    value = re.sub(r"\s+", "_", str(name or "").strip().lower())
    value = re.sub(r"[^0-9a-zA-Z_\-\u3040-\u30ff\u3400-\u9fff]+", "_", value)
    value = value.strip("_")
    return value or "prompt"


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
    data = _parse_prompt_json(_read_prompt_bytes(path), path, "Prompt data")
    return _normalize_prompt_data(data, path)


def _write_prompt_payload(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        with open(temp_name, "r", encoding="utf-8") as handle:
            json.load(handle)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


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

    category = _folder_component(category, "category")
    if subcategory:
        subcategory = _folder_component(subcategory, "subcategory")
    data_dir = _data_dir(user_id)
    saved_prompts_dir = _saved_prompts_dir(user_id)
    if category == saved_prompts_dir.name:
        raise ValueError("reserved category name")
    if not label:
        raise ValueError("name is required")
    if not prompt:
        raise ValueError("prompt is required")

    with DATA_WRITE_LOCK:
        parts = [category]
        if subcategory:
            parts.append(subcategory)
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
    safe_parts = [_folder_component(part, "category_path") for part in category_path if str(part or "").strip()]
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


def _parse_saved_prompt(content, prompt_file, saved_prompts_dir):
    data = _parse_prompt_json(content, prompt_file, "Saved prompt")
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


def _read_saved_prompt(prompt_file, saved_prompts_dir):
    return _parse_saved_prompt(_read_prompt_bytes(prompt_file), prompt_file, saved_prompts_dir)


def _load_saved_prompts(user_id="default", force=False, with_errors=False):
    saved_prompts_dir = _saved_prompts_dir(user_id)
    while True:
        with DATA_CACHE_LOCK:
            generation = _cache_generation(user_id)
            cache = _cache_for(_SAVED_PROMPTS_CACHE, user_id)
            cached = None if force else _cache_get_unexpired(cache)
            if cached is not None:
                return _cache_value(cached, "saved_prompts", with_errors)

        signature, content_hash, files = _prompt_file_snapshot(saved_prompts_dir)
        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            cached = None if force else _cache_get(_SAVED_PROMPTS_CACHE, user_id, signature, content_hash)
            if cached is not None:
                return _cache_value(cached, "saved_prompts", with_errors)

        saved = []
        errors = []
        for prompt_file, content in files:
            try:
                saved.append(_parse_saved_prompt(content, prompt_file, saved_prompts_dir))
            except ValueError as exc:
                errors.append({"file": prompt_file.relative_to(saved_prompts_dir).as_posix(), "error": str(exc)})

        refreshed_signature, refreshed_content_hash, _ = _prompt_file_snapshot(saved_prompts_dir)
        value = {"saved_prompts": saved, "errors": errors}
        entry = _cache_entry(user_id, refreshed_signature, refreshed_content_hash, value)
        with DATA_CACHE_LOCK:
            if generation != _cache_generation(user_id):
                continue
            if signature != refreshed_signature or content_hash != refreshed_content_hash:
                continue
            _SAVED_PROMPTS_CACHE[str(user_id or "default")] = entry
        return _cache_value(value, "saved_prompts", with_errors)


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
        folder_name = _folder_component(name, "name")
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
    from .gpu_handoff import HandoffError, install
    gpu = install(PromptServer.instance)

    async def gpu_operation(request, operation):
        from .llm_settings import request_settings
        from .llm_service import ServiceError
        try:
            user_id = _request_user_id(request)
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
            client_id = str(payload.get("client_id") or "")
            if operation in ("prepare", "begin"):
                # Calling this endpoint explicitly requests the operation's
                # snapshotted policy. The UI may have waited in its FIFO while
                # the user's currently saved settings changed.
                settings, state = await asyncio.to_thread(request_settings, user_id)
                if operation == "prepare":
                    result = {"policy_id": gpu.prepare(user_id, client_id, settings,
                        continuous=payload.get("continuous") is True,
                        run_handle=str(payload.get("run_handle") or ""))}
                else:
                    result = {"session_id": await gpu.begin_session(user_id, client_id, settings, state)}
            elif operation == "release":
                policy_id = str(payload.get("policy_id") or "")
                result = {"released": gpu.retire_policy(policy_id, user_id, client_id=client_id)}
            else:
                result = {"ended": gpu.end_session(str(payload.get("session_id") or ""), user_id, client_id=client_id)}
            return web.json_response(result)
        except (HandoffError, ServiceError) as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        except (ValueError, TypeError, KeyError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response({"error": "Unable to access Scene Prompt LLM settings."}, status=500)

    @PromptServer.instance.routes.post("/scene_prompt/gpu/prepare")
    async def scene_gpu_prepare(request):
        return await gpu_operation(request, "prepare")

    @PromptServer.instance.routes.post("/scene_prompt/gpu/release")
    async def scene_gpu_release(request):
        return await gpu_operation(request, "release")

    @PromptServer.instance.routes.post("/scene_prompt/llm/begin")
    async def scene_llm_begin(request):
        return await gpu_operation(request, "begin")

    @PromptServer.instance.routes.post("/scene_prompt/llm/end")
    async def scene_llm_end(request):
        return await gpu_operation(request, "end")

    async def llm_operation(request, operation):
        # Lazy imports retain compatibility with lightweight Comfy/aiohttp route loaders.
        from .llm_settings import load_settings, request_settings, merge_settings, public_settings, save_settings
        from .llm_service import ServiceError, generate, select_loras, test_connection
        try:
            user_id = _request_user_id(request)
            if operation not in ("settings_post", "generate", "select"):
                settings = await asyncio.to_thread(load_settings, user_id)
            if operation == "settings_get":
                result = public_settings(settings)
            else:
                payload = await request.json()
                if not isinstance(payload, dict):
                    raise ValueError("Request body must be a JSON object.")
                if operation == "settings_post":
                    result = await asyncio.to_thread(save_settings, user_id, payload)
                elif operation == "test":
                    async with gpu.llm_request(user_id):
                        result = await test_connection(merge_settings(settings, payload))
                else:
                    session_id = payload.get("session_id")
                    async with gpu.llm_request(user_id, session_id, str(payload.get("client_id") or "") if session_id else None) as session:
                        if session is None:
                            settings, state = await asyncio.to_thread(request_settings, user_id)
                        else:
                            settings, state = session.settings, session.state
                        if operation == "generate":
                            result = await generate(settings, payload.get("description"), payload.get("model_mode"), state)
                        else:
                            result = await select_loras(settings, payload.get("description"), payload.get("model_mode"), payload.get("query", ""), payload.get("candidates"), state)
            return web.json_response(result)
        except (HandoffError, ServiceError) as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        except (ValueError, TypeError, KeyError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response({"error": "Unable to access Scene Prompt LLM settings."}, status=500)

    async def civitai_operation(request, operation):
        from .civitai import ServiceError, search, download, by_hash, descriptions
        try:
            if operation == "search":
                result = await search(request.query.get("query", ""), request.query.get("model_mode", "Illustrious"), request.query.get("sort", "Most Downloaded"), host=request.query.get("host", "civitai.red"))
            elif operation == "by_hash":
                result = await by_hash(request.query.get("sha256", ""))
            elif operation == "descriptions":
                result = await descriptions(int(request.query.get("model_id", "0")), int(request.query.get("version_id", "0")))
            else:
                payload = await request.json()
                if not isinstance(payload, dict):
                    raise ValueError("Request body must be a JSON object.")
                result = await download(payload, payload.get("model_mode"), host=payload.get("host", "civitai.red"))
            return web.json_response(result)
        except ServiceError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
        except (ValueError, TypeError, KeyError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response({"error": "Unable to access the configured LoRA folder."}, status=500)

    @PromptServer.instance.routes.get("/scene_prompt/llm/settings")
    async def scene_llm_settings_get(request):
        return await llm_operation(request, "settings_get")

    @PromptServer.instance.routes.post("/scene_prompt/llm/settings")
    async def scene_llm_settings_post(request):
        return await llm_operation(request, "settings_post")

    @PromptServer.instance.routes.post("/scene_prompt/llm/test")
    async def scene_llm_test(request):
        return await llm_operation(request, "test")

    @PromptServer.instance.routes.post("/scene_prompt/llm/generate")
    async def scene_llm_generate(request):
        return await llm_operation(request, "generate")

    @PromptServer.instance.routes.post("/scene_prompt/llm/select_loras")
    async def scene_llm_select(request):
        return await llm_operation(request, "select")

    @PromptServer.instance.routes.get("/scene_prompt/civitai/search")
    async def scene_civitai_search(request):
        return await civitai_operation(request, "search")

    @PromptServer.instance.routes.get("/scene_prompt/civitai/by-hash")
    async def scene_civitai_by_hash(request):
        return await civitai_operation(request, "by_hash")

    @PromptServer.instance.routes.post("/scene_prompt/civitai/download")
    async def scene_civitai_download(request):
        return await civitai_operation(request, "download")

    @PromptServer.instance.routes.get("/scene_prompt/civitai/descriptions")
    async def scene_civitai_descriptions(request):
        return await civitai_operation(request, "descriptions")

    @PromptServer.instance.routes.get("/scene_prompt/loras/list")
    async def scene_prompt_lora_list(request):
        del request
        try:
            return web.json_response(await asyncio.to_thread(list_loras))
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/scene_prompt/loras/info")
    async def scene_prompt_lora_info(request):
        try:
            payload = await asyncio.to_thread(read_lora_info, request.query.get("name", ""))
            return web.json_response(payload)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except (OSError, json.JSONDecodeError) as exc:
            return web.json_response({"error": str(exc)}, status=422)

    @PromptServer.instance.routes.post("/scene_prompt/expand/resources")
    async def scene_prompt_expand_resources(request):
        try:
            body = await request.json()
            payload = await asyncio.to_thread(
                connected_resources, body.get("api_graph"), body.get("expand_node_id"), _request_user_id(request)
            )
            return web.json_response(payload)
        except (ScenePresetError, ValueError, TypeError, AttributeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.get("/scene_prompt/models/hash")
    async def scene_prompt_model_hash(request):
        try:
            payload = await asyncio.to_thread(read_model_hash, request.query.get("kind", ""), request.query.get("name", ""))
            return web.json_response(payload)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=422)

    @PromptServer.instance.routes.get("/scene_prompt/items")
    async def scene_prompt_items(request):
        try:
            user_id = _request_user_id(request)
            force = request.query.get("reload") == "1"
            if force:
                await asyncio.to_thread(_clear_prompt_caches, user_id)
            payload = await asyncio.to_thread(_load_items, user_id, force, True)
            return web.json_response(payload)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/scene_prompt/saved_prompts")
    async def scene_prompt_saved_prompts(request):
        try:
            user_id = _request_user_id(request)
            force = request.query.get("reload") == "1"
            if force:
                await asyncio.to_thread(_clear_prompt_caches, user_id)
            payload = await asyncio.to_thread(_load_saved_prompts, user_id, force, True)
            return web.json_response(payload)
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
            saved_prompts = await asyncio.to_thread(_load_saved_prompts, user_id, True, True)
        except Exception as exc:
            return web.json_response({"saved_prompt": saved, "warning": "保存後の一覧再読込に失敗しました。"})

        return web.json_response({"saved_prompt": saved, **saved_prompts})

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
            items = await asyncio.to_thread(_load_items, user_id, True, True)
        except Exception as exc:
            return web.json_response({"item": item, "warning": "保存後の一覧再読込に失敗しました。"})

        return web.json_response({"item": item, **items})

    @PromptServer.instance.routes.post("/scene_prompt/runs/prepare")
    async def scene_prompt_prepare_run(request):
        handle = ""
        user_id = ""
        try:
            purge_expired_run_contexts()
            payload = await request.json()
            api_graph = payload.get("api_graph") if isinstance(payload, dict) else None
            expand_node_id = payload.get("expand_node_id") if isinstance(payload, dict) else None
            workflow = payload.get("workflow") if isinstance(payload, dict) else None
            user_id = _request_user_id(request)
            live_prompt_ids = _queued_prompt_ids()
            if live_prompt_ids is not None:
                reconcile_active_run_contexts(live_prompt_ids)
            client_id = payload.get("client_id", "") if isinstance(payload, dict) else ""
            handle = create_run_context(user_id, _is_continuous_scene_run(api_graph, expand_node_id), client_id)
            snapshot = await asyncio.to_thread(
                snapshot_presets_for_run, handle, api_graph, expand_node_id, user_id, workflow
            )
            return web.json_response({"run_handle": handle, **snapshot})
        except asyncio.CancelledError:
            if handle:
                release_run_context(handle, user_id)
                release_scene_preset_snapshot(handle, user_id)
            raise
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

    @PromptServer.instance.routes.post("/scene_prompt/runs/finalize")
    async def scene_prompt_finalize_run(request):
        try:
            payload = await request.json()
            run_handle = payload.get("run_handle") if isinstance(payload, dict) else ""
            expand_node_id = payload.get("expand_node_id") if isinstance(payload, dict) else ""
            prompt_id = payload.get("prompt_id") if isinstance(payload, dict) else ""
            if not str(run_handle or "").strip() or not str(expand_node_id or "").strip() or not str(prompt_id or "").strip():
                return web.json_response({"state": "invalid"}, status=400)
            status = _completed_prompt_status(prompt_id)
            if status == "pending":
                return web.json_response({"state": "pending"}, status=202)
            if status != "success":
                return web.json_response({"state": "not_success"}, status=409)
            user_id = _request_user_id(request)
            state, callback = begin_last_callback(run_handle, user_id, expand_node_id, prompt_id)
            if state == "noop":
                return web.json_response({"state": "finalized"})
            if state in {"missing", "wrong_prompt"}:
                return web.json_response({"state": state}, status=409)
            if state == "in_progress":
                return web.json_response({"state": state}, status=202)
            if state == "finalized":
                return web.json_response({"state": state})
            if state == "failed":
                return web.json_response({"state": "error"}, status=502)
            def finalize_callback():
                try:
                    dispatch_callback(
                        callback["config"],
                        callback["values"],
                        callback["timeout_seconds"],
                        desktop_context=callback.get("delivery_context"),
                    )
                except SceneCallbackError as exc:
                    if callback["failure_mode"] == CALLBACK_FAILURE_STOP:
                        finish_last_callback(run_handle, expand_node_id, False)
                        return {"state": "error", "error": str(exc)}, 502
                    finish_last_callback(run_handle, expand_node_id, True)
                    return {"state": "finalized", "warning": str(exc)}, 200
                except Exception:
                    finish_last_callback(run_handle, expand_node_id, False)
                    raise
                finish_last_callback(run_handle, expand_node_id, True)
                return {"state": "finalized"}, 200

            worker = asyncio.create_task(asyncio.to_thread(finalize_callback))
            cancelled = False
            # Retain queued/running work through repeated HTTP cancellation.
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    cancelled = True
                except Exception:
                    break
            try:
                result, status = worker.result()
            finally:
                if cancelled:
                    raise asyncio.CancelledError
            return web.json_response(result, status=status)
        except (SceneRunError, ValueError, TypeError):
            return web.json_response({"state": "invalid"}, status=400)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/scene_prompt/callbacks/desktop/ack")
    async def scene_prompt_desktop_callback_ack(request):
        try:
            payload = await request.json()
            request_id = payload.get("request_id") if isinstance(payload, dict) else ""
            success = payload.get("success") if isinstance(payload, dict) else None
            error = payload.get("error") if isinstance(payload, dict) else ""
            state = acknowledge_desktop_callback(request_id, _request_user_id(request), success, error)
            if state == "acknowledged":
                return web.json_response({"acknowledged": True})
            if state == "forbidden":
                return web.json_response({"error": "forbidden"}, status=403)
            if state == "missing":
                return web.json_response({"error": "missing"}, status=404)
            return web.json_response({"error": "invalid"}, status=400)
        except Exception:
            return web.json_response({"error": "invalid"}, status=400)

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

    @PromptServer.instance.routes.get("/scene_presets/load")
    async def scene_presets_load(request):
        try:
            preset_id = request.query.get("preset_id")
            preset = await asyncio.to_thread(load_preset, preset_id, _request_user_id(request))
            response = {
                "metadata": preset["metadata"],
                "workflow": preset["workflow"],
            }
            if request.query.get("include_api_graph") == "1":
                response["schema_version"] = preset["schema_version"]
                response["api_graph"] = preset["api_graph"]
            return web.json_response(response)
        except ScenePresetNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except ScenePresetError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Presetを読み込めませんでした: {exc}"}, status=500)
