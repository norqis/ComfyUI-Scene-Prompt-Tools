"""Immutable helpers for current Scene Prompt generation plans."""

from __future__ import annotations

import copy
import hashlib
import json


SCENE_PROMPT_TYPE = "SCENE_PROMPT"
PLAN_VERSION = 2
MAX_INPUT_COUNT = 10_000
MAX_DERIVED_COUNT = 1_000_000_000
MAX_PLAN_ROWS = 100_000
MIN_DIMENSION = 16
MAX_DIMENSION = 16_384
MIN_BATCH_SIZE = 1
MAX_BATCH_SIZE = 4_096
MAX_TOTAL_IMAGES = MAX_DERIVED_COUNT * MAX_BATCH_SIZE

PLAN_KEYS = {"type", "version", "rows", "total_batches", "total_images", "sources", "change_key"}
PLAN_BUILD_ITEM_KEYS = {"row", "count"}
PLAN_ITEM_KEYS = {
    "row", "count", "start_index", "row_index", "label", "queue_index", "source_id", "source_title",
}
ROW_KEYS = {
    "labels", "positive_parts", "negative_parts", "path_parts", "filename_parts", "display_labels", "display_label_groups", "set_refs", "source_node_ids",
}
LATENT_KEYS = {"width", "height", "batch_size"}
SOURCE_KEYS = {"index", "row_count", "total_images", "total_batches"}
SET_REF_KEYS = {"category", "name", "path_label", "node_id"}


class ScenePlanError(ValueError):
    """Raised when a value is not a current Scene Prompt plan."""


def _require_exact_keys(value, keys, label):
    if set(value) != keys:
        raise ScenePlanError(f"{label} has unsupported or missing fields.")


def _require_int(value, label, minimum, maximum):
    if type(value) is not int:
        raise ScenePlanError(f"{label} must be an integer.")
    if not minimum <= value <= maximum:
        raise ScenePlanError(f"{label} must be between {minimum} and {maximum}.")
    return value


def _require_string(value, label, allow_empty=True):
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ScenePlanError(f"{label} must be{' a non-empty' if not allow_empty else ''} string.")
    return value


def _require_string_list(value, label):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ScenePlanError(f"{label} must be a list of strings.")
    return list(value)


def _require_string_groups(value, label):
    if not isinstance(value, list) or any(
        not isinstance(group, list) or any(not isinstance(item, str) for item in group)
        for group in value
    ):
        raise ScenePlanError(f"{label} must be a list of string lists.")
    return [list(group) for group in value]


def _clone_latent(value):
    if not isinstance(value, dict):
        raise ScenePlanError("Scene Prompt row latent must be an object.")
    _require_exact_keys(value, LATENT_KEYS, "Scene Prompt row latent")
    width = _require_int(value["width"], "Scene Prompt latent width", MIN_DIMENSION, MAX_DIMENSION)
    height = _require_int(value["height"], "Scene Prompt latent height", MIN_DIMENSION, MAX_DIMENSION)
    batch_size = _require_int(value["batch_size"], "Scene Prompt latent batch_size", MIN_BATCH_SIZE, MAX_BATCH_SIZE)
    if width % 8 or height % 8:
        raise ScenePlanError("Scene Prompt latent width and height must be divisible by 8.")
    return {"width": width, "height": height, "batch_size": batch_size}


def _clone_row(row):
    if not isinstance(row, dict):
        raise ScenePlanError("Scene Prompt plan row must be an object.")
    allowed_keys = ROW_KEYS | {"latent"}
    if not ROW_KEYS.issubset(row) or set(row) - allowed_keys:
        raise ScenePlanError("Scene Prompt plan row has unsupported or missing fields.")
    set_refs = row["set_refs"]
    if not isinstance(set_refs, list):
        raise ScenePlanError("Scene Prompt row set_refs must be a list of objects.")
    cloned_refs = []
    for ref in set_refs:
        if not isinstance(ref, dict):
            raise ScenePlanError("Scene Prompt row set_refs must be a list of objects.")
        _require_exact_keys(ref, SET_REF_KEYS, "Scene Prompt row set_ref")
        cloned_refs.append({key: _require_string(ref[key], f"Scene Prompt row set_ref {key}") for key in SET_REF_KEYS})
    cloned = {
        "labels": _require_string_list(row["labels"], "Scene Prompt row labels"),
        "positive_parts": _require_string_list(row["positive_parts"], "Scene Prompt row positive_parts"),
        "negative_parts": _require_string_list(row["negative_parts"], "Scene Prompt row negative_parts"),
        "path_parts": _require_string_list(row["path_parts"], "Scene Prompt row path_parts"),
        "filename_parts": _require_string_list(row["filename_parts"], "Scene Prompt row filename_parts"),
        "display_labels": _require_string_list(row["display_labels"], "Scene Prompt row display_labels"),
        "display_label_groups": _require_string_groups(row["display_label_groups"], "Scene Prompt row display_label_groups"),
        "set_refs": cloned_refs,
        "source_node_ids": _require_string_list(row["source_node_ids"], "Scene Prompt row source_node_ids"),
    }
    if "latent" in row:
        cloned["latent"] = _clone_latent(row["latent"])
    return cloned


def empty_row():
    return {
        "labels": [], "positive_parts": [], "negative_parts": [], "path_parts": [], "filename_parts": [],
        "display_labels": [], "display_label_groups": [], "set_refs": [], "source_node_ids": [],
    }


def row_label(row):
    labels = [item.strip() for item in row["labels"] if item.strip()]
    path_parts = [item.strip() for item in row["path_parts"] if item.strip()]
    return " / ".join(labels) or "/".join(path_parts) or "Scene"


def _row_batch_size(row):
    latent = row.get("latent")
    return latent["batch_size"] if latent else 1


def _fingerprint(rows):
    digest = hashlib.blake2b(digest_size=16)
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest.update(payload.encode("utf-8"))
    return f"scene-prompt:v{PLAN_VERSION}:{digest.hexdigest()}"


def _clone_sources(sources):
    if not isinstance(sources, list):
        raise ScenePlanError("Scene Prompt plan sources must be a list.")
    cloned = []
    for source in sources:
        if not isinstance(source, dict):
            raise ScenePlanError("Scene Prompt plan sources must contain objects.")
        _require_exact_keys(source, SOURCE_KEYS, "Scene Prompt plan source")
        cloned.append({
            "index": _require_int(source["index"], "Scene Prompt source index", 1, MAX_DERIVED_COUNT),
            "row_count": _require_int(source["row_count"], "Scene Prompt source row_count", 0, MAX_DERIVED_COUNT),
            "total_images": _require_int(source["total_images"], "Scene Prompt source total_images", 0, MAX_TOTAL_IMAGES),
            "total_batches": _require_int(source["total_batches"], "Scene Prompt source total_batches", 0, MAX_DERIVED_COUNT),
        })
    return cloned


def _build_plan(items, sources):
    if len(items) > MAX_PLAN_ROWS:
        raise ScenePlanError(f"Scene Prompt plan cannot contain more than {MAX_PLAN_ROWS} rows.")
    batch_cursor = 0
    total_images = 0
    rows = []
    for index, item in enumerate(items):
        row = _clone_row(item["row"])
        count = _require_int(item["count"], "Scene Prompt plan count", 0, MAX_DERIVED_COUNT)
        batch_cursor += count
        total_images += count * _row_batch_size(row)
        if batch_cursor > MAX_DERIVED_COUNT or total_images > MAX_TOTAL_IMAGES:
            raise ScenePlanError("Scene Prompt derived total is too large.")
        rows.append({
            "row": row, "count": count, "start_index": batch_cursor - count, "row_index": index,
            "label": row_label(row), "queue_index": 0, "source_id": "", "source_title": "",
        })
    return {
        "type": SCENE_PROMPT_TYPE, "version": PLAN_VERSION, "rows": rows,
        "total_batches": batch_cursor, "total_images": total_images,
        "sources": _clone_sources(sources), "change_key": _fingerprint(rows),
    }


def make_plan(rows, *, sources=None):
    """Build a current plan from exact internal ``row``/``count`` specifications."""
    if not isinstance(rows, list):
        raise ScenePlanError("Scene Prompt plan rows must be a list.")
    items = []
    for item in rows:
        if not isinstance(item, dict):
            raise ScenePlanError("Scene Prompt plan items must be objects.")
        _require_exact_keys(item, PLAN_BUILD_ITEM_KEYS, "Scene Prompt plan item")
        items.append({
            "row": _clone_row(item["row"]),
            "count": _require_int(item["count"], "Scene Prompt plan count", 0, MAX_DERIVED_COUNT),
        })
    return _build_plan(items, [] if sources is None else sources)


def seed_plan():
    return make_plan([{"row": empty_row(), "count": 1}])


def normalize_plan(value):
    """Validate a connected current-schema plan without rewriting it."""
    if value is None:
        return seed_plan()
    if not isinstance(value, dict):
        raise ScenePlanError("A Scene Prompt input must receive a current Scene Prompt plan.")
    _require_exact_keys(value, PLAN_KEYS, "Scene Prompt plan")
    if value["type"] != SCENE_PROMPT_TYPE:
        raise ScenePlanError("A Scene Prompt input must receive a current Scene Prompt plan.")
    if value["version"] != PLAN_VERSION:
        raise ScenePlanError("Unsupported Scene Prompt plan version.")
    if not isinstance(value["rows"], list):
        raise ScenePlanError("Scene Prompt plan rows must be a list.")
    if len(value["rows"]) > MAX_PLAN_ROWS:
        raise ScenePlanError(f"Scene Prompt plan cannot contain more than {MAX_PLAN_ROWS} rows.")
    items = []
    start_index = 0
    for index, item in enumerate(value["rows"]):
        if not isinstance(item, dict):
            raise ScenePlanError("Scene Prompt plan items must be objects.")
        _require_exact_keys(item, PLAN_ITEM_KEYS, "Scene Prompt plan item")
        row = _clone_row(item["row"])
        count = _require_int(item["count"], "Scene Prompt plan count", 0, MAX_DERIVED_COUNT)
        expected = {
            "start_index": start_index, "row_index": index,
            "label": row_label(row), "queue_index": 0, "source_id": "", "source_title": "",
        }
        for key, expected_value in expected.items():
            if item[key] != expected_value or (key != "label" and type(item[key]) is not type(expected_value)):
                raise ScenePlanError(f"Scene Prompt plan {key} is invalid.")
        items.append({"row": row, "count": count})
        start_index += count
    expected_plan = _build_plan(items, value["sources"])
    for key in ("total_batches", "total_images", "change_key", "sources"):
        expected_type = int if key in {"total_batches", "total_images"} else type(expected_plan[key])
        if value[key] != expected_plan[key] or type(value[key]) is not expected_type:
            raise ScenePlanError(f"Scene Prompt plan {key} is invalid.")
    return expected_plan


def transform(plan, transform_row):
    source = normalize_plan(plan)
    rows = []
    for item in source["rows"]:
        next_row = transform_row(copy.deepcopy(item["row"]), copy.deepcopy(item))
        if not isinstance(next_row, dict):
            raise ScenePlanError("Scene Prompt transform returned an invalid row.")
        rows.append({"row": next_row, "count": item["count"]})
    return make_plan(rows, sources=source["sources"])


def with_source_node(plan, node_id):
    """Record the Scene node that contributed to every output row."""
    source_id = str(node_id or "").strip()
    if not source_id:
        return normalize_plan(plan)
    return transform(
        plan,
        lambda row, _item: {
            **row,
            "source_node_ids": _unique_strings([*row["source_node_ids"], source_id]),
        },
    )


def multiply_count(plan, factor):
    amount = _require_int(factor, "Scene Prompt count factor", 0, MAX_INPUT_COUNT)
    source = normalize_plan(plan)
    rows = []
    for item in source["rows"]:
        count = item["count"] * amount
        if count > MAX_DERIVED_COUNT:
            raise ScenePlanError(f"Scene Prompt derived count must be between 0 and {MAX_DERIVED_COUNT}.")
        rows.append({"row": item["row"], "count": count})
    return make_plan(rows, sources=source["sources"])


def _unique_strings(values):
    result = []
    seen = set()
    for value in values:
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def merge_rows(left, right):
    left_row = _clone_row(left if left is not None else empty_row())
    right_row = _clone_row(right if right is not None else empty_row())
    negative_parts = _unique_strings([*left_row["negative_parts"], *right_row["negative_parts"]])
    negative_keys = {value.casefold() for value in negative_parts}
    positive_parts = [
        value for value in _unique_strings([*left_row["positive_parts"], *right_row["positive_parts"]])
        if value.casefold() not in negative_keys
    ]
    row = {
        "labels": _unique_strings([*left_row["labels"], *right_row["labels"]]),
        "positive_parts": positive_parts, "negative_parts": negative_parts,
        "path_parts": [*left_row["path_parts"], *right_row["path_parts"]],
        "filename_parts": [*left_row["filename_parts"], *right_row["filename_parts"]],
        "display_labels": [*left_row["display_labels"], *right_row["display_labels"]],
        "display_label_groups": [*left_row["display_label_groups"], *right_row["display_label_groups"]],
        "set_refs": [*left_row["set_refs"], *right_row["set_refs"]],
        "source_node_ids": _unique_strings([*left_row["source_node_ids"], *right_row["source_node_ids"]]),
    }
    latent = right_row.get("latent") or left_row.get("latent")
    if latent is not None:
        row["latent"] = latent
    return row


def merge(left, right):
    first = normalize_plan(left)
    second = normalize_plan(right)
    row_count = len(first["rows"]) * len(second["rows"])
    if row_count > MAX_PLAN_ROWS:
        raise ScenePlanError(f"Scene Prompt merge would create more than {MAX_PLAN_ROWS} rows.")
    rows = []
    for left_item in first["rows"]:
        for right_item in second["rows"]:
            count = left_item["count"] * right_item["count"]
            if count > MAX_DERIVED_COUNT:
                raise ScenePlanError(f"Scene Prompt derived count must be between 0 and {MAX_DERIVED_COUNT}.")
            rows.append({"row": merge_rows(left_item["row"], right_item["row"]), "count": count})
    return make_plan(rows)


def queue(values):
    connected = [normalize_plan(value) for value in values if value is not None]
    if not connected:
        return seed_plan()
    row_count = sum(len(plan["rows"]) for plan in connected)
    if row_count > MAX_PLAN_ROWS:
        raise ScenePlanError(f"Scene Prompt queue cannot contain more than {MAX_PLAN_ROWS} rows.")
    rows = []
    sources = []
    for index, plan in enumerate(connected, start=1):
        sources.append({
            "index": index, "row_count": len(plan["rows"]),
            "total_images": plan["total_images"], "total_batches": plan["total_batches"],
        })
        rows.extend({"row": item["row"], "count": item["count"]} for item in plan["rows"])
    return make_plan(rows, sources=sources)


def matrix_product(plan, matrix_rows, configured):
    source = normalize_plan(plan)
    if not isinstance(matrix_rows, list):
        raise ScenePlanError("Scene Matrix rows must be a list.")
    if not isinstance(configured, bool):
        raise ScenePlanError("Scene Matrix configured must be a boolean.")
    for row in matrix_rows:
        if not isinstance(row, dict) or type(row.get("enabled")) is not bool:
            raise ScenePlanError("Scene Matrix rows must be current validated objects.")
    active = [row for row in matrix_rows if row["enabled"]]
    if not configured:
        return source
    if not active:
        return make_plan([])
    row_count = len(source["rows"]) * len(active)
    if row_count > MAX_PLAN_ROWS:
        raise ScenePlanError(f"Scene Matrix would create more than {MAX_PLAN_ROWS} rows.")
    rows = []
    for base in source["rows"]:
        for matrix_row in active:
            matrix_plan_row = {
                key: matrix_row[key]
                for key in ROW_KEYS
                if key in matrix_row
            }
            matrix_plan_row["source_node_ids"] = []
            row = merge_rows(base["row"], matrix_plan_row)
            name = _require_string(matrix_row.get("name"), "Scene Matrix row name", allow_empty=False).strip()
            row["labels"] = [*base["row"]["labels"], name]
            rows.append({"row": row, "count": base["count"]})
    return make_plan(rows)


def item_for_normalized_plan(plan, index):
    """Look up an item in a plan already validated by ``normalize_plan``."""
    source = plan
    if type(index) is not int or not 0 <= index < source["total_batches"]:
        raise IndexError("Generation index is outside the plan.")
    rows = source["rows"]
    lower = 0
    upper = len(rows)
    while lower < upper:
        middle = (lower + upper) // 2
        if rows[middle]["start_index"] <= index:
            lower = middle + 1
        else:
            upper = middle
    item = copy.deepcopy(rows[lower - 1])
    item["repeat_index"] = index - item["start_index"] + 1
    item["global_index"] = index
    item["total_batches"] = source["total_batches"]
    item["total_images"] = source["total_images"]
    return item


def item_for_index(plan, index):
    return item_for_normalized_plan(normalize_plan(plan), index)
