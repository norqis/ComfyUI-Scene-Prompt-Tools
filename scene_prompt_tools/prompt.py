import json
import math
import random
import re
from collections import OrderedDict
from .plan import transform, with_source_node


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
SELECTED_PART_OPTIONAL_KEYS = {"weight", "missing"}
CHOICE_TOKEN_RE = re.compile(r"[{}|]")


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


def _explicit_prompt_weight(text, start=0, end=None):
    end = len(text) if end is None else end
    if end - start < 2 or text[start] != "(" or text[end - 1] != ")":
        return None
    colon = text.rfind(":", start + 1, end - 1)
    if colon < 0:
        return None
    try:
        weight = float(text[colon + 1:end - 1])
    except ValueError:
        return None
    if not math.isfinite(weight):
        return None
    start += 1
    while start < colon and text[start].isspace():
        start += 1
    while colon > start and text[colon - 1].isspace():
        colon -= 1
    return start, colon, weight


def _prompt_identity(part):
    text = str(part or "").strip()
    start, end = 0, len(text)
    weight = 1.0
    explicit = _explicit_prompt_weight(text, start, end)
    while explicit is not None:
        start, end, weight = explicit
        explicit = _explicit_prompt_weight(text, start, end)
    return _prompt_key(text[start:end]), weight


def _prompt_override_key(part):
    return _prompt_identity(part)[0]


def _delete_prompt_parts(parts, delete_keys):
    """Delete exact tags inside choice slots without changing their positions."""
    result = []
    tasks = [("part", part, result) for part in reversed(parts)]
    while tasks:
        kind, value, target = tasks.pop()
        if kind == "slot_done":
            slot, original, remaining = value
            target.append(slot if remaining == original else ", ".join(remaining))
            continue
        if kind == "part_done":
            rewritten = "".join("".join(chunk) if isinstance(chunk, list) else chunk for chunk in value)
            if _prompt_override_key(rewritten) not in delete_keys:
                target.append(rewritten)
            continue
        if kind == "slot":
            original = _split_prompt(value)
            remaining = []
            tasks.append(("slot_done", (value, original, remaining), target))
            tasks.extend(("part", part, remaining) for part in reversed(original))
            continue
        text = value
        if _prompt_override_key(text) in delete_keys:
            continue
        chunks = []
        children = []
        start = 0
        depth = 0
        slots = []
        slot_start = 0
        for index, char in enumerate(text):
            if char == "{":
                if depth == 0:
                    choice_start = index
                    slot_start = index + 1
                    slots = []
                depth += 1
            elif char == "|" and depth == 1:
                slots.append(text[slot_start:index])
                slot_start = index + 1
            elif char == "}" and depth:
                depth -= 1
                if depth == 0:
                    slots.append(text[slot_start:index])
                    chunks.extend((text[start:choice_start], "{"))
                    for slot_index, slot in enumerate(slots):
                        if slot_index:
                            chunks.append("|")
                        rewritten_slot = []
                        chunks.append(rewritten_slot)
                        children.append(("slot", slot, rewritten_slot))
                    chunks.append("}")
                    start = index + 1
        chunks.append(text[start:])
        tasks.append(("part_done", chunks, target))
        tasks.extend(reversed(children))
    return result


def _item_weight(item):
    if "weight" not in item:
        return 1.0
    weight = item["weight"]
    if type(weight) not in (int, float) or isinstance(weight, bool) or not math.isfinite(weight):
        raise ValueError("Scene Prompt selection weight must be a finite number.")
    return float(weight)


def _format_weight(weight):
    return f"{weight:.3f}".rstrip("0").rstrip(".")


def _apply_weight(part, weight):
    if abs(weight - 1.0) < 0.0005:
        return part
    return f"({part}:{_format_weight(weight)})"


def _join_unique(parts, separator, seen_keys=None):
    if seen_keys:
        seen = set(seen_keys)
        parts = (part for part in parts if _prompt_key(part) not in seen)
    return separator.join(_unique_parts(parts))


def _selected_prompt_parts(categories, order):
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
                    if selected_part.get("missing") is True:
                        continue
                    part_text = selected_part["text"]
                    weight = _item_weight(selected_part)
                    parts.extend(_apply_weight(part, weight) for part in _split_prompt(part_text))
                continue

            weight = _item_weight(item)
            parts.extend(_apply_weight(part, weight) for part in _split_prompt(prompt))
    return parts


def _choice_slot_text(fragments):
    # Trim before joining so whitespace around a single nested choice does not
    # copy its entire selected payload at every enclosing brace.
    first = 0
    while first < len(fragments):
        value = fragments[first].lstrip()
        if value:
            fragments[first] = value
            break
        first += 1
    if first == len(fragments):
        return ""
    last = len(fragments) - 1
    while last > first and not fragments[last].rstrip():
        last -= 1
    fragments[last] = fragments[last].rstrip()
    return "".join(fragments[first:last + 1])


def _expand_choices(text, rng):
    if not text:
        return ""
    if "{" not in text:
        return text

    # Each frame holds choice slots, each slot holds literal/selected fragments.
    # Closing braces resolve innermost-leftmost, including single/empty choices.
    frames = [[[]]]
    start = 0
    for match in CHOICE_TOKEN_RE.finditer(text):
        frame = frames[-1]
        if match.start() > start:
            frame[-1].append(text[start:match.start()])
        token = match.group()
        if token == "{":
            frames.append([[]])
        elif token == "|" and len(frames) > 1:
            frame.append([])
        elif token == "}" and len(frames) > 1:
            options = [_choice_slot_text(slot) for slot in frames.pop()]
            frames[-1][-1].append(rng.choice(options))
        else:
            frame[-1].append(token)
        start = match.end()
    if start < len(text):
        frames[-1][-1].append(text[start:])

    # Unclosed outer braces stay literal; completed inner choices are expanded.
    fragments = []
    for index, frame in enumerate(frames):
        if index:
            fragments.append("{")
        for slot_index, slot in enumerate(frame):
            if slot_index:
                fragments.append("|")
            fragments.extend(slot)
    return "".join(fragments)


def _choice_rng(seed, stream):
    stream_salt = 0x2F6E2B1 if stream == "positive" else 0x6B8B4567
    return random.Random((int(seed or 0) ^ stream_salt) % (1 << 64))


def _is_empty_weighted_part(text):
    value = str(text or "").strip()
    start, end = 0, len(value)
    while start < end:
        explicit = _explicit_prompt_weight(value, start, end)
        if explicit is None:
            return False
        start, end, _ = explicit
    return True


def _expand_prompt_parts(parts, seed, stream):
    rng = _choice_rng(seed, stream)
    expanded = []
    for part in parts or []:
        text = _expand_choices(part, rng)
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
    if type(value) not in (int, float) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number.")
    return float(value)


def _validate_selected_part(part, prompt_parts, label):
    _require_exact_keys(part, SELECTED_PART_REQUIRED_KEYS, SELECTED_PART_OPTIONAL_KEYS, label)
    if type(part["index"]) is not int or part["index"] < 0:
        raise ValueError(f"{label} index is invalid.")
    text = _require_nonempty_string(part["text"], f"{label} text")
    missing = part.get("missing", False)
    if "missing" in part and not isinstance(missing, bool):
        raise ValueError(f"{label} missing must be a boolean.")
    if not missing and (part["index"] >= len(prompt_parts) or prompt_parts[part["index"]] != text):
        missing = True
    result = {"index": part["index"], "text": text}
    if missing:
        result["missing"] = True
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
        used = {part["index"] for part in parts if not part.get("missing")}
        next_index = len(prompt_parts)
        for part in parts:
            if not part.get("missing"):
                continue
            if part["index"] in used:
                while next_index in used:
                    next_index += 1
                part["index"] = next_index
                next_index += 1
            used.add(part["index"])
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
    del randomize, seed
    categories = _parse_selection_json(selection_json)
    order = _parse_order(category_order)
    parts = _split_prompt(base_text or "")
    parts.extend(_selected_prompt_parts(categories, order))
    return parts


def _override_keys(parts):
    return {_prompt_override_key(part) for part in parts or [] if _prompt_override_key(part)}


def _unique_parts(parts, blocked_override_keys=None):
    winners = {}
    blocked = set(blocked_override_keys or [])
    out = []
    for part in parts or []:
        text = str(part or "").strip()
        key, weight = _prompt_identity(text)
        if not key or key in blocked:
            continue
        if key not in winners:
            winners[key] = (len(out), weight)
            out.append(text)
        elif weight > winners[key][1]:
            index = winners[key][0]
            winners[key] = (index, weight)
            out[index] = text
    return out


def _merge_positive_negative_parts(base_positive, base_negative, added_positive, added_negative):
    negative_parts = _unique_parts([*(base_negative or []), *(added_negative or [])])
    positive_parts = _unique_parts(
        [*(base_positive or []), *(added_positive or [])],
        blocked_override_keys=_override_keys(negative_parts),
    )
    return positive_parts, negative_parts


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
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
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
        source_node_id="",
        source_node_name="",
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

        plan = transform(scene_prompt, operation={
            "kind": "prompt_add", "payload": [label, positive_parts, negative_parts, bool(filename_enabled)],
        })
        return (with_source_node(plan, source_node_id or unique_id, source_node_name),)


class ScenePrompt(_ScenePromptBase):
    DESCRIPTION = """ポジティブ・ネガティブの基本文と候補画面で選んだプロンプトをまとめ、Scene用の生成計画を出力します。\nscene_prompt を入力すると、入力済みの各生成行へこのノードの内容を追加します。重複するタグはまとめられ、ネガティブ側にも同じタグがある場合、そのポジティブタグは除外されます。\n{A|B|C} 形式の候補は Scene Prompt Expand でシードに基づいて確定します。ノード名は生成計画のラベルとして使われます。"""
