import json
import random
import re
from collections import OrderedDict
from .plan import make_plan, normalize_plan, with_source_node


DEFAULT_CATEGORY_ORDER = ""
SCENE_PROMPT_TYPE = "SCENE_PROMPT"
DEFAULT_SELECTED_JSON = "{\"version\":1,\"categories\":{}}"
SELECTION_ITEM_REQUIRED_KEYS = {
    "label", "prompt", "category_path", "category_key", "category_label",
}
SELECTION_ITEM_OPTIONAL_KEYS = {"id", "description", "weight", "selected_parts"}
SELECTION_ITEM_LEGACY_OPTIONAL_KEYS = {"legacy_keys"}
SELECTION_ITEM_KNOWN_KEYS = (
    SELECTION_ITEM_REQUIRED_KEYS | SELECTION_ITEM_OPTIONAL_KEYS | SELECTION_ITEM_LEGACY_OPTIONAL_KEYS
)
SELECTED_PART_REQUIRED_KEYS = {"index", "text"}
SELECTED_PART_OPTIONAL_KEYS = {"weight"}
MIN_WEIGHT = 0.05
MAX_WEIGHT = 3.0

CHOICE_RE = re.compile(r"\{([^{}]+)\}")
WEIGHTED_PART_RE = re.compile(r"^\((.*):\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\)$")


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
    if not isinstance(item, dict):
        raise ValueError(f"{label} must be an object.")
    unknown_keys = set(item) - SELECTION_ITEM_KNOWN_KEYS
    if unknown_keys or not {"label", "prompt"}.issubset(item):
        raise ValueError(f"{label} has unsupported or missing fields.")

    category_path = _legacy_category_path(category, label)
    for field in ("category_path", "category_key", "category_label"):
        if field not in item:
            continue
        if field == "category_path":
            value = item[field]
            if not isinstance(value, list) or not value or any(
                not isinstance(part, str) or not part.strip() for part in value
            ):
                raise ValueError(f"{label} category_path must be a non-empty list of strings.")
            if value != category_path:
                raise ValueError(f"{label} category fields are inconsistent.")
        elif _require_nonempty_string(item[field], f"{label} {field}") != category:
            raise ValueError(f"{label} category fields are inconsistent.")

    result = {
        "label": _require_nonempty_string(item["label"], f"{label} label"),
        "prompt": _require_nonempty_string(item["prompt"], f"{label} prompt"),
        "category_path": category_path,
        "category_key": category,
        "category_label": category,
    }
    if "id" in item:
        result["id"] = _require_nonempty_string(item["id"], f"{label} id")
    if "legacy_keys" in item:
        legacy_keys = item["legacy_keys"]
        if not isinstance(legacy_keys, list) or any(
            not isinstance(value, str) or not value.strip() for value in legacy_keys
        ):
            raise ValueError(f"{label} legacy_keys must be a list of non-empty strings.")
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


def _legacy_category_path(category, label):
    if not isinstance(category, str) or not category.strip():
        raise ValueError(f"{label} category must be a non-empty string.")
    path = category.split(" > ")
    if any(not part.strip() for part in path):
        raise ValueError(f"{label} category is invalid.")
    return path


def _parse_selection_json(selection_json):
    """Read only the current selection-state schema.

    An empty widget is intentionally an empty selection. Any supplied value must
    be valid current-schema JSON so malformed saved workflow data cannot quietly
    remove prompt choices.
    """
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
            categories[category].append(_validate_selection_item(item, category, f"Scene Prompt selection entry {index}"))

    return categories


def _scene_prompt_change_key(value):
    if not isinstance(value, dict) or value.get("type") != SCENE_PROMPT_TYPE:
        return ""
    return str(value.get("change_key") or "")


def _compose_prompt_parts(base_text, selection_json, category_order, randomize, seed):
    rng = random.Random(int(seed or 0))
    categories = _parse_selection_json(selection_json)
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
                "run_handle": ("STRING", {"default": "", "hidden": True}),
            },
            "optional": {
                "filename_enabled": ("BOOLEAN", {"default": False, "display_name": "ファイル名付与", "label": "ファイル名付与"}),
                "scene_prompt": (
                    SCENE_PROMPT_TYPE,
                    {"forceInput": True, "display_name": "scene_prompt", "label": "scene_prompt"},
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
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
        run_handle="",
        unique_id=None,
        filename_enabled=False,
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
                str(bool(filename_enabled)),
                _scene_prompt_change_key(scene_prompt),
                str(run_handle or ""),
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
        run_handle="",
        unique_id=None,
        filename_enabled=False,
        **kwargs,
    ):
        del kwargs
        label = str(prompt_name or "").strip() or "Scene Prompt"
        positive_parts = _compose_prompt_parts(
            positive_base,
            positive_json,
            category_order,
            bool(randomize),
            int(seed or 0),
        )
        negative_parts = _compose_prompt_parts(
            negative_base,
            negative_json,
            category_order,
            bool(randomize),
            int(seed or 0) ^ 0x5F3759DF,
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
                "filename_parts": [*row.get("filename_parts", []), *([label] if filename_enabled else [])],
                "display_labels": list(row.get("display_labels", [])),
                "display_label_groups": list(row.get("display_label_groups", [])),
                "set_refs": list(row.get("set_refs", [])),
                "source_node_ids": list(row.get("source_node_ids", [])),
            }
            if "latent" in row:
                output_row["latent"] = dict(row["latent"])
            rows.append({"row": output_row, "count": item["count"]})

        return (with_source_node(make_plan(rows), unique_id),)


class ScenePrompt(_ScenePromptBase):
    DESCRIPTION = """ポジティブ・ネガティブの基本文と候補画面で選んだプロンプトをまとめ、Scene用の生成計画を出力します。\nscene_prompt を入力すると、入力済みの各生成行へこのノードの内容を追加します。重複するタグはまとめられ、ネガティブ側にも同じタグがある場合、そのポジティブタグは除外されます。\n{A|B|C} 形式の候補は Scene Prompt Expand でシードに基づいて確定します。ノード名は生成計画のラベルとして使われます。"""
