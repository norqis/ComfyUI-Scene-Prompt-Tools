import json
import hashlib
import random
import re
import time
from collections import OrderedDict
from .plan import make_plan, normalize_plan
from .storage import prompt_data_directory


DEFAULT_CATEGORY_ORDER = ""
SCENE_PROMPT_TYPE = "SCENE_PROMPT"
DEFAULT_SELECTED_JSON = "{\"version\":1,\"categories\":{}}"
PROMPT_FILE_NAME = "prompt.json"
SAVED_PROMPTS_FOLDER = "保存済みプロンプト"
PROMPT_ITEM_REQUIRED_KEYS = {"label", "prompt"}
PROMPT_ITEM_OPTIONAL_KEYS = {"id", "description"}
SELECTION_ITEM_REQUIRED_KEYS = {
    "label", "prompt", "category_path", "category_key", "category_label",
}
SELECTION_ITEM_OPTIONAL_KEYS = {"id", "description", "weight", "selected_parts"}
SELECTED_PART_REQUIRED_KEYS = {"index", "text"}
SELECTED_PART_OPTIONAL_KEYS = {"weight"}
MIN_WEIGHT = 0.05
MAX_WEIGHT = 3.0

CHOICE_RE = re.compile(r"\{([^{}]+)\}")
WEIGHTED_PART_RE = re.compile(r"^\((.*):\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\)$")
_PROMPT_DATA_INDEX_CACHE = {}
_PROMPT_FILE_SIGNATURE_CACHE = {}
_PROMPT_SIGNATURE_TTL_SECONDS = 0.5


def _split_prompt(text):
    parts = []
    current = []
    brace_depth = 0
    for char in text or "":
        if char == "{":
            brace_depth += 1
        elif char == "}" and brace_depth:
            brace_depth -= 1

        if char in ",\n" and brace_depth == 0:
            value = "".join(current).strip()
            if value:
                parts.append(value)
            current = []
            continue
        current.append(char)

    value = "".join(current).strip()
    if value:
        parts.append(value)
    return parts


def _prompt_key(part):
    return re.sub(r"\s+", " ", str(part).strip()).lower()


def _prompt_override_key(part):
    text = str(part or "").strip()
    for _index in range(8):
        match = WEIGHTED_PART_RE.match(text)
        if not match:
            break
        text = match.group(1).strip()
    return _prompt_key(text)


def _item_weight(item):
    if "weight" not in item:
        return 1.0
    weight = item["weight"]
    if type(weight) not in (int, float) or isinstance(weight, bool) or not MIN_WEIGHT <= weight <= MAX_WEIGHT:
        raise ValueError("Scene Prompt selection weight must be a number between 0.05 and 3.")
    return float(weight)


def _format_weight(weight):
    return f"{weight:.3f}".rstrip("0").rstrip(".")


def _apply_weight(part, weight):
    if abs(weight - 1.0) < 0.0005:
        return part
    return f"({part}:{_format_weight(weight)})"


def _join_unique(parts, separator, seen_keys=None):
    seen = set(seen_keys or [])
    out = []
    for part in parts:
        key = _prompt_key(part)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(part.strip())
    return separator.join(out)


def _selected_prompt_parts(categories, order, rng, randomize, preserve_choices=False):
    ordered_categories = []
    seen_categories = set()
    for category in order:
        if category in categories:
            ordered_categories.append(category)
            seen_categories.add(category)
    for category in categories.keys():
        if category not in seen_categories:
            ordered_categories.append(category)

    parts = []
    for category in ordered_categories:
        for item in categories.get(category, []):
            prompt = item["prompt"]
            selected_parts = item.get("selected_parts")
            if selected_parts is not None:
                for selected_part in selected_parts:
                    part_text = _expand_choices(
                        selected_part["text"], rng, randomize, preserve_choices
                    )
                    weight = _item_weight(selected_part)
                    parts.extend(_apply_weight(part, weight) for part in _split_prompt(part_text))
                continue

            prompt = _expand_choices(prompt, rng, randomize, preserve_choices)
            weight = _item_weight(item)
            parts.extend(_apply_weight(part, weight) for part in _split_prompt(prompt))
    return parts


def _expand_choices(text, rng, randomize, preserve_choices=False):
    if not text:
        return ""

    if randomize and preserve_choices:
        return str(text)

    result = text
    guard = 0
    while guard < 100:
        guard += 1
        match = CHOICE_RE.search(result)
        if not match:
            break

        options = [option.strip() for option in match.group(1).split("|")]
        if not options:
            replacement = ""
        elif randomize:
            replacement = rng.choice(options)
        else:
            replacement = options[0]

        result = result[: match.start()] + replacement + result[match.end() :]

    return result


def _choice_rng(seed, stream):
    stream_salt = 0x2F6E2B1 if stream == "positive" else 0x6B8B4567
    return random.Random((int(seed or 0) ^ stream_salt) % (1 << 64))


def _is_empty_weighted_part(text):
    value = str(text or "").strip()
    while value:
        match = WEIGHTED_PART_RE.match(value)
        if not match:
            return False
        value = match.group(1).strip()
    return True


def _expand_prompt_parts(parts, seed, stream):
    rng = _choice_rng(seed, stream)
    expanded = []
    for part in parts or []:
        text = _expand_choices(part, rng, True)
        for candidate in _split_prompt(text):
            if not _is_empty_weighted_part(candidate):
                expanded.append(candidate)
    return _unique_parts(expanded)


def _parse_order(category_order):
    return [part.strip() for part in re.split(r"[,、\n]", category_order or "") if part.strip()]


def _category_key(item):
    key = item.get("category_key")
    if isinstance(key, str) and key.strip():
        return key.strip()

    path = item.get("category_path")
    if isinstance(path, list):
        parts = [str(part).strip() for part in path if str(part).strip()]
        if parts:
            return " > ".join(parts)

    return ""


def _prompt_data_directory_for_user(user_id="default"):
    return prompt_data_directory(user_id)


def _prompt_file_signature(user_id="default"):
    user_key = str(user_id or "default")
    now = time.monotonic()
    cache = _PROMPT_FILE_SIGNATURE_CACHE.setdefault(user_key, {"expires": 0.0, "signature": None})
    cached = cache.get("signature")
    if cached is not None and cache.get("expires", 0.0) > now:
        return cached

    data_dir = _prompt_data_directory_for_user(user_key)

    if not data_dir.exists():
        signature = ()
        cache["signature"] = signature
        cache["expires"] = now + _PROMPT_SIGNATURE_TTL_SECONDS
        return signature

    signature = []
    for prompt_file in sorted(data_dir.rglob(PROMPT_FILE_NAME)):
        try:
            category_path = prompt_file.parent.relative_to(data_dir).parts
        except ValueError:
            continue
        if category_path and category_path[0] == SAVED_PROMPTS_FOLDER:
            continue
        try:
            stat = prompt_file.stat()
        except OSError:
            continue
        signature.append(("/".join(category_path), stat.st_mtime_ns, stat.st_size))
    signature = tuple(signature)
    cache["signature"] = signature
    cache["expires"] = now + _PROMPT_SIGNATURE_TTL_SECONDS
    return signature


def _clear_prompt_data_cache(user_id=None):
    keys = [str(user_id or "default")] if user_id is not None else set(_PROMPT_FILE_SIGNATURE_CACHE) | set(_PROMPT_DATA_INDEX_CACHE)
    for key in keys:
        _PROMPT_FILE_SIGNATURE_CACHE.pop(key, None)
        _PROMPT_DATA_INDEX_CACHE.pop(key, None)


def _prompt_data_change_key(user_id="default"):
    payload = json.dumps(_prompt_file_signature(user_id), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _read_prompt_items(path, category_path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prompt data file '{path.name}' is invalid JSON.") from exc
    except OSError as exc:
        raise ValueError(f"Prompt data file '{path.name}' cannot be read.") from exc

    if not isinstance(data, list):
        raise ValueError(f"Prompt data file '{path.name}' must be a JSON array.")

    category_key = " > ".join(category_path)
    normalized = []
    for index, item in enumerate(data):
        normalized_item = validate_prompt_data_item(item, f"Prompt data file '{path.name}' item {index}")
        normalized_item["category_path"] = list(category_path)
        normalized_item["category_key"] = category_key
        normalized_item["category_label"] = category_key
        normalized.append(normalized_item)
    return normalized


def _require_exact_keys(item, required, optional, label):
    if not isinstance(item, dict):
        raise ValueError(f"{label} must be an object.")
    keys = set(item)
    if not required.issubset(keys) or keys - required - optional:
        raise ValueError(f"{label} has unsupported or missing fields.")


def _require_nonempty_string(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string.")
    return value


def _validate_weight(value, label):
    if type(value) not in (int, float) or isinstance(value, bool) or not MIN_WEIGHT <= value <= MAX_WEIGHT:
        raise ValueError(f"{label} must be a number between 0.05 and 3.")
    return float(value)


def validate_prompt_data_item(item, label="Prompt data item"):
    """Validate one on-disk current-schema prompt item without adding fields."""
    _require_exact_keys(item, PROMPT_ITEM_REQUIRED_KEYS, PROMPT_ITEM_OPTIONAL_KEYS, label)
    result = {
        "label": _require_nonempty_string(item["label"], f"{label} label"),
        "prompt": _require_nonempty_string(item["prompt"], f"{label} prompt"),
    }
    if "id" in item:
        result["id"] = _require_nonempty_string(item["id"], f"{label} id")
    if "description" in item:
        if not isinstance(item["description"], str):
            raise ValueError(f"{label} description must be a string.")
        result["description"] = item["description"]
    return result


def _validate_selected_part(part, prompt_parts, label):
    _require_exact_keys(part, SELECTED_PART_REQUIRED_KEYS, SELECTED_PART_OPTIONAL_KEYS, label)
    if type(part["index"]) is not int or not 0 <= part["index"] < len(prompt_parts):
        raise ValueError(f"{label} index is invalid.")
    text = _require_nonempty_string(part["text"], f"{label} text")
    if prompt_parts[part["index"]] != text:
        raise ValueError(f"{label} does not match its prompt part.")
    result = {"index": part["index"], "text": text}
    if "weight" in part:
        result["weight"] = _validate_weight(part["weight"], f"{label} weight")
    return result


def _validate_selection_item(item, category, label):
    _require_exact_keys(item, SELECTION_ITEM_REQUIRED_KEYS, SELECTION_ITEM_OPTIONAL_KEYS, label)
    result = {
        "label": _require_nonempty_string(item["label"], f"{label} label"),
        "prompt": _require_nonempty_string(item["prompt"], f"{label} prompt"),
        "category_path": item["category_path"],
        "category_key": _require_nonempty_string(item["category_key"], f"{label} category_key"),
        "category_label": _require_nonempty_string(item["category_label"], f"{label} category_label"),
    }
    if not isinstance(result["category_path"], list) or not result["category_path"] or any(
        not isinstance(part, str) or not part.strip() for part in result["category_path"]
    ):
        raise ValueError(f"{label} category_path must be a non-empty list of strings.")
    if result["category_key"] != category or result["category_key"] != " > ".join(result["category_path"]):
        raise ValueError(f"{label} category fields are inconsistent.")
    if result["category_label"] != result["category_key"]:
        raise ValueError(f"{label} category_label is inconsistent.")
    if "id" in item:
        result["id"] = _require_nonempty_string(item["id"], f"{label} id")
    if "description" in item:
        if not isinstance(item["description"], str):
            raise ValueError(f"{label} description must be a string.")
        result["description"] = item["description"]
    if "weight" in item and "selected_parts" in item:
        raise ValueError(f"{label} cannot contain both weight and selected_parts.")
    if "weight" in item:
        result["weight"] = _validate_weight(item["weight"], f"{label} weight")
    if "selected_parts" in item:
        if not isinstance(item["selected_parts"], list) or not item["selected_parts"]:
            raise ValueError(f"{label} selected_parts must be a non-empty list.")
        prompt_parts = _split_prompt(result["prompt"])
        parts = [
            _validate_selected_part(part, prompt_parts, f"{label} selected_parts[{index}]")
            for index, part in enumerate(item["selected_parts"])
        ]
        if len({part["index"] for part in parts}) != len(parts):
            raise ValueError(f"{label} selected_parts must not repeat an index.")
        result["selected_parts"] = parts
    return result


def _selection_item_key(item, default_category=""):
    category = _category_key(item) or str(default_category or "").strip()
    if not category:
        return ""
    if item.get("id"):
        return f"{category}::id::{item['id']}"
    return f"{category}::item::{item['label']}::{item['prompt']}"


def _prompt_data_index(user_id="default"):
    user_key = str(user_id or "default")
    signature = _prompt_file_signature(user_key)
    cache = _PROMPT_DATA_INDEX_CACHE.get(user_key)
    cached = cache.get("index") if cache else None
    if cache and cache.get("signature") == signature and cached is not None:
        return cached

    by_key = {}
    by_id = {}
    data_dir = _prompt_data_directory_for_user(user_key)
    if data_dir.exists():
        for prompt_file in sorted(data_dir.rglob(PROMPT_FILE_NAME)):
            try:
                category_path = list(prompt_file.parent.relative_to(data_dir).parts)
            except ValueError:
                continue
            if category_path and category_path[0] == SAVED_PROMPTS_FOLDER:
                continue
            items = _read_prompt_items(prompt_file, category_path)

            for item in items:
                category = _category_key(item)
                key = _selection_item_key(item, category)
                if key:
                    by_key[key] = item
                item_id = str(item.get("id") or "").strip()
                if item_id:
                    by_id[(category, item_id)] = item

    index = {
        "by_key": by_key,
        "by_id": by_id,
    }
    _PROMPT_DATA_INDEX_CACHE[user_key] = {"signature": signature, "index": index}
    return index


def _prompt_parts_with_index(prompt):
    return [{"index": index, "text": part} for index, part in enumerate(_split_prompt(prompt))]


def _remap_selected_parts(previous_item, latest_item):
    """Map an explicit partial selection onto the latest item without guessing."""
    previous_parts = previous_item.get("selected_parts")
    if previous_parts is None:
        return None

    latest_parts = _split_prompt(latest_item["prompt"])
    used_indexes = set()
    remapped = []
    for part in previous_parts:
        old_index = part["index"]
        text = part["text"]
        candidates = [
            index for index, value in enumerate(latest_parts)
            if value == text and index not in used_indexes
        ]
        if old_index in candidates:
            new_index = old_index
        elif len(candidates) == 1:
            new_index = candidates[0]
        else:
            raise ValueError(
                "Scene Prompt partial selection can no longer be mapped to the current prompt item."
            )
        selected = {"index": new_index, "text": text}
        if "weight" in part:
            selected["weight"] = part["weight"]
        remapped.append(selected)
        used_indexes.add(new_index)
    return remapped


def _selection_item_with_latest_prompt(previous_item, default_category, data_index):
    category = previous_item["category_key"]
    if "id" in previous_item:
        latest = data_index["by_id"].get((category, previous_item["id"]))
        if latest is None:
            raise ValueError("Scene Prompt selected item no longer exists in the current prompt data.")
    else:
        latest = data_index["by_key"].get(_selection_item_key(previous_item, category))
        if latest is None:
            raise ValueError(
                "Scene Prompt selected item has no stable id and no longer matches the current prompt data."
            )

    selected = dict(latest)
    if "weight" in previous_item:
        selected["weight"] = previous_item["weight"]
    remapped_parts = _remap_selected_parts(previous_item, latest)
    if remapped_parts is not None:
        selected["selected_parts"] = remapped_parts
    return _validate_selection_item(selected, category, "Scene Prompt selection entry")


def _parse_selection_json(selection_json, data_index=None):
    """Read only the current selection-state schema.

    An empty widget is intentionally an empty selection. Any supplied value must
    be valid current-schema JSON so malformed saved workflow data cannot quietly
    remove prompt choices.
    """
    if data_index is None:
        data_index = _prompt_data_index()
    if selection_json is None or (isinstance(selection_json, str) and not selection_json.strip()):
        return OrderedDict()
    if not isinstance(selection_json, str):
        raise ValueError("Scene Prompt selection JSON must be a string.")

    try:
        data = json.loads(selection_json)
    except json.JSONDecodeError as exc:
        raise ValueError("Scene Prompt selection JSON is invalid.") from exc

    if not isinstance(data, dict) or set(data) != {"version", "categories"}:
        raise ValueError("Scene Prompt selection JSON must be an object.")
    if data["version"] != 1:
        raise ValueError("Unsupported Scene Prompt selection schema version.")

    raw_categories = data.get("categories")
    if not isinstance(raw_categories, dict):
        raise ValueError("Scene Prompt selection categories must be an object.")

    categories = OrderedDict()
    for category, items in raw_categories.items():
        if not isinstance(category, str) or not category.strip():
            raise ValueError("Scene Prompt selection category names must be non-empty strings.")
        if not isinstance(items, list):
            raise ValueError("Scene Prompt selection category entries must be lists.")
        categories[category] = []
        for index, item in enumerate(items):
            normalized = _validate_selection_item(item, category, f"Scene Prompt selection entry {index}")
            categories[category].append(
                _selection_item_with_latest_prompt(normalized, category, data_index)
            )

    return categories


def _scene_prompt_change_key(value):
    if not isinstance(value, dict) or value.get("type") != SCENE_PROMPT_TYPE:
        return ""
    return str(value.get("change_key") or "")


def _compose_prompt_parts(base_text, selection_json, category_order, randomize, seed, data_index=None):
    rng = random.Random(int(seed or 0))
    categories = _parse_selection_json(selection_json, data_index or _prompt_data_index())
    order = _parse_order(category_order)
    parts = _split_prompt(_expand_choices(base_text or "", rng, randomize, bool(randomize)))
    parts.extend(_selected_prompt_parts(categories, order, rng, randomize, bool(randomize)))
    return parts


def _override_keys(parts):
    return {_prompt_override_key(part) for part in parts or [] if _prompt_override_key(part)}


def _unique_parts(parts, blocked_override_keys=None):
    seen = set()
    blocked = set(blocked_override_keys or [])
    out = []
    for part in parts or []:
        text = str(part or "").strip()
        key = _prompt_key(text)
        override_key = _prompt_override_key(text)
        if not key or key in seen or override_key in blocked:
            continue
        seen.add(key)
        out.append(text)
    return out


def _merge_positive_negative_parts(base_positive, base_negative, added_positive, added_negative):
    negative_parts = _unique_parts([*(base_negative or []), *(added_negative or [])])
    positive_parts = _unique_parts(
        [*(base_positive or []), *(added_positive or [])],
        blocked_override_keys=_override_keys(negative_parts),
    )
    return positive_parts, negative_parts


def _normalize_scene_prompt_rows(value):
    return normalize_plan(value)["rows"]


class _ScenePromptBase:
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_name": ("STRING", {"default": "", "hidden": True}),
                "positive_base": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "display_name": "ポジティブ基本文",
                        "label": "ポジティブ基本文",
                    },
                ),
                "positive_json": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": DEFAULT_SELECTED_JSON,
                        "hidden": True,
                    },
                ),
                "negative_base": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "display_name": "ネガティブ基本文",
                        "label": "ネガティブ基本文",
                    },
                ),
                "negative_json": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": DEFAULT_SELECTED_JSON,
                        "hidden": True,
                    },
                ),
                "category_order": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": DEFAULT_CATEGORY_ORDER,
                        "hidden": True,
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 18446744073709551615,
                        "hidden": True,
                    },
                ),
                "randomize": ("BOOLEAN", {"default": True, "hidden": True}),
                "user_id": ("STRING", {"default": "default", "hidden": True}),
            },
            "optional": {
                "scene_prompt": (
                    SCENE_PROMPT_TYPE,
                    {"forceInput": True, "display_name": "scene_prompt", "label": "scene_prompt"},
                ),
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        prompt_name,
        positive_base,
        positive_json,
        negative_base,
        negative_json,
        category_order,
        seed,
        randomize,
        scene_prompt=None,
        user_id="default",
        **kwargs,
    ):
        return "|".join(
            [
                prompt_name or "",
                positive_base or "",
                positive_json or "",
                negative_base or "",
                negative_json or "",
                category_order or "",
                str(randomize),
                str(seed),
                _scene_prompt_change_key(scene_prompt),
                _prompt_data_change_key(user_id),
            ]
        )

    def build(
        self,
        prompt_name,
        positive_base,
        positive_json,
        negative_base,
        negative_json,
        category_order,
        seed,
        randomize,
        scene_prompt=None,
        user_id="default",
        **kwargs,
    ):
        del kwargs
        label = str(prompt_name or "").strip() or "Scene Prompt"
        prompt_data_index = _prompt_data_index(user_id)
        positive_parts = _compose_prompt_parts(
            positive_base,
            positive_json,
            category_order,
            bool(randomize),
            int(seed or 0),
            prompt_data_index,
        )
        negative_parts = _compose_prompt_parts(
            negative_base,
            negative_json,
            category_order,
            bool(randomize),
            int(seed or 0) ^ 0x5F3759DF,
            prompt_data_index,
        )

        rows = []
        for item in _normalize_scene_prompt_rows(scene_prompt):
            row = item["row"]
            merged_positive_parts, merged_negative_parts = _merge_positive_negative_parts(
                row.get("positive_parts", []),
                row.get("negative_parts", []),
                positive_parts,
                negative_parts,
            )
            output_row = {
                "labels": [*row.get("labels", []), label],
                "positive_parts": merged_positive_parts,
                "negative_parts": merged_negative_parts,
                "path_parts": list(row.get("path_parts", [])),
                "display_labels": list(row.get("display_labels", [])),
                "display_label_groups": list(row.get("display_label_groups", [])),
                "set_refs": list(row.get("set_refs", [])),
            }
            if "latent" in row:
                output_row["latent"] = dict(row["latent"])
            rows.append({"row": output_row, "count": item["count"]})

        return (make_plan(rows),)


class ScenePrompt(_ScenePromptBase):
    DESCRIPTION = """ポジティブ・ネガティブの基本文と候補画面で選んだプロンプトをまとめ、Scene用の生成計画を出力します。\nscene_prompt を入力すると、入力済みの各生成行へこのノードの内容を追加します。重複するタグはまとめられ、ネガティブ側にも同じタグがある場合、そのポジティブタグは除外されます。\n{A|B|C} 形式の候補は Scene Prompt Expand でシードに基づいて確定します。ノード名は生成計画のラベルとして使われます。"""
