"""Immutable helpers for current Scene Prompt generation plans."""

from __future__ import annotations

import copy


SCENE_PROMPT_TYPE = "SCENE_PROMPT"
PLAN_VERSION = 7
MODEL_MODE_ILLUSTRIOUS = "Illustrious"
MODEL_MODE_ANIMA = "Anima"
MODEL_MODE_CHOICES = (MODEL_MODE_ILLUSTRIOUS, MODEL_MODE_ANIMA)
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MIN_DIMENSION = 16
MIN_BATCH_SIZE = 1

PLAN_KEYS = {"type", "version", "units", "sources", "contains_queue_boundary", "stats", "change_key"}
PLAN_BUILD_ITEM_KEYS = {"row", "count"}
ROW_KEYS = {
    "labels", "positive_parts", "negative_parts", "path_parts", "filename_parts", "display_labels", "display_label_groups", "set_refs", "source_node_ids", "source_node_names", "callbacks",
}
LATENT_KEYS = {"width", "height", "batch_size"}
SOURCE_KEYS = {"index", "row_count", "total_images", "total_batches"}
SET_REF_KEYS = {"category", "name", "path_label", "node_id"}
CALLBACK_KEYS = {
    "callback_node_id", "config", "frequency", "timeout_seconds", "failure_mode",
    "current_positive_parts", "current_negative_parts", "current_source_node_ids", "current_loras",
}
MODEL_LINK_KEYS = {"model", "clip", "vae"}
LORA_KEYS = {"name", "strength_model", "strength_clip", "model_mode", "positive_parts", "negative_parts"}
PROMPT_TRACE_KEYS = {
    "kind", "before_positive_parts", "before_negative_parts", "added_positive_parts", "added_negative_parts",
    "lora_index",
}
PROMPT_TRACE_KINDS = {"delta", "passthrough", "whole"}


class ScenePlanError(ValueError):
    """Raised when a value is not a current Scene Prompt plan."""


class ScenePlan(dict):
    """Validated process-local plan; callers treat instances as immutable."""

    def __getitem__(self, key):
        if key in ("total_batches", "total_images") and dict.get(self, "version") == 7:
            return dict.__getitem__(self, "stats")[key]
        if key == "rows" and dict.get(self, "version") == 7:
            from .schedule import legacy_rows
            return legacy_rows(self)
        return dict.__getitem__(self, key)

    def get(self, key, default=None):
        if key in ("total_batches", "total_images", "rows") and dict.get(self, "version") == 7:
            return self[key]
        return dict.get(self, key, default)


def _require_exact_keys(value, keys, label):
    if set(value) != keys:
        raise ScenePlanError(f"{label} has unsupported or missing fields.")


def _require_int(value, label, minimum, maximum=None):
    if type(value) is not int:
        raise ScenePlanError(f"{label} must be an integer.")
    if value < minimum or (maximum is not None and value > maximum):
        if maximum is None:
            raise ScenePlanError(f"{label} must be at least {minimum}.")
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
    width = _require_int(value["width"], "Scene Prompt latent width", MIN_DIMENSION)
    height = _require_int(value["height"], "Scene Prompt latent height", MIN_DIMENSION)
    batch_size = _require_int(value["batch_size"], "Scene Prompt latent batch_size", MIN_BATCH_SIZE)
    if width % 8 or height % 8:
        raise ScenePlanError("Scene Prompt latent width and height must be divisible by 8.")
    return {"width": width, "height": height, "batch_size": batch_size}


def _clone_prompt_trace(value):
    if not isinstance(value, dict):
        raise ScenePlanError("Scene Prompt row prompt_trace must be an object.")
    _require_exact_keys(value, PROMPT_TRACE_KEYS, "Scene Prompt row prompt_trace")
    kind = _require_string(value["kind"], "Scene Prompt row prompt_trace kind", allow_empty=False)
    if kind not in PROMPT_TRACE_KINDS:
        raise ScenePlanError("Scene Prompt row prompt_trace kind is invalid.")
    cloned = {"kind": kind}
    cloned.update({
        key: _require_string_list(value[key], f"Scene Prompt row prompt_trace {key}")
        for key in PROMPT_TRACE_KEYS - {"kind", "lora_index"}
    })
    index = value["lora_index"]
    if index is not None and (type(index) is not int or index < 0):
        raise ScenePlanError("Scene Prompt row prompt_trace lora_index is invalid.")
    cloned["lora_index"] = index
    return cloned


def _clone_link(value, label):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ScenePlanError(f"{label} must be a node link.")
    node_id, output_index = value
    if not isinstance(node_id, (str, int)) or type(output_index) is not int or output_index < 0:
        raise ScenePlanError(f"{label} must be a node link.")
    return [str(node_id), output_index]


def _clone_model_links(value):
    if not isinstance(value, dict):
        raise ScenePlanError("Scene Prompt row model_links must be an object.")
    _require_exact_keys(value, MODEL_LINK_KEYS, "Scene Prompt row model_links")
    return {key: _clone_link(value[key], f"Scene Prompt row model_links {key}") for key in MODEL_LINK_KEYS}


def _clone_loras(value):
    if not isinstance(value, list):
        raise ScenePlanError("Scene Prompt row loras must be a list.")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ScenePlanError("Scene Prompt row loras must contain objects.")
        _require_exact_keys(item, LORA_KEYS, "Scene Prompt row lora")
        name = _require_string(item["name"], "Scene Prompt row lora name", allow_empty=False)
        model_mode = item["model_mode"]
        if model_mode not in MODEL_MODE_CHOICES:
            raise ScenePlanError("Scene Prompt row lora model_mode is invalid.")
        strengths = {}
        for key in ("strength_model", "strength_clip"):
            strength = item[key]
            if not isinstance(strength, (int, float)) or isinstance(strength, bool):
                raise ScenePlanError(f"Scene Prompt row lora {key} must be a number.")
            strengths[key] = float(strength)
        result.append({
            "name": name, **strengths, "model_mode": model_mode,
            "positive_parts": _require_string_list(item["positive_parts"], "Scene Prompt row lora positive_parts"),
            "negative_parts": _require_string_list(item["negative_parts"], "Scene Prompt row lora negative_parts"),
        })
    return result


def _clone_row(row):
    if not isinstance(row, dict):
        raise ScenePlanError("Scene Prompt plan row must be an object.")
    allowed_keys = ROW_KEYS | {"latent", "prompt_trace", "model_links", "loras"}
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
    source_node_names = row["source_node_names"]
    if not isinstance(source_node_names, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in source_node_names.items()
    ):
        raise ScenePlanError("Scene Prompt row source_node_names must be an object of strings.")
    callbacks = row["callbacks"]
    if not isinstance(callbacks, list):
        raise ScenePlanError("Scene Prompt row callbacks must be a list.")
    cloned_callbacks = []
    for callback in callbacks:
        if not isinstance(callback, dict):
            raise ScenePlanError("Scene Prompt row callbacks must contain objects.")
        _require_exact_keys(callback, CALLBACK_KEYS, "Scene Prompt row callback")
        config = callback["config"]
        if not isinstance(config, dict):
            raise ScenePlanError("Scene Prompt callback config must be an object.")
        cloned_callbacks.append({
            "callback_node_id": _require_string(callback["callback_node_id"], "Scene Prompt callback node id", allow_empty=False),
            "config": copy.deepcopy(config),
            "frequency": _require_string(callback["frequency"], "Scene Prompt callback frequency", allow_empty=False),
            "timeout_seconds": _require_int(callback["timeout_seconds"], "Scene Prompt callback timeout_seconds", 1),
            "failure_mode": _require_string(callback["failure_mode"], "Scene Prompt callback failure_mode", allow_empty=False),
            "current_positive_parts": _require_string_list(callback["current_positive_parts"], "Scene Prompt callback current_positive_parts"),
            "current_negative_parts": _require_string_list(callback["current_negative_parts"], "Scene Prompt callback current_negative_parts"),
            "current_source_node_ids": _require_string_list(callback["current_source_node_ids"], "Scene Prompt callback current_source_node_ids"),
            "current_loras": _clone_loras(callback["current_loras"]),
        })
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
        "source_node_names": dict(source_node_names),
        "callbacks": cloned_callbacks,
    }
    if "latent" in row:
        cloned["latent"] = _clone_latent(row["latent"])
    if "prompt_trace" in row:
        cloned["prompt_trace"] = _clone_prompt_trace(row["prompt_trace"])
    if "model_links" in row:
        cloned["model_links"] = _clone_model_links(row["model_links"])
    if "loras" in row:
        cloned["loras"] = _clone_loras(row["loras"])
    if "prompt_trace" in cloned and cloned["prompt_trace"]["lora_index"] is not None:
        if cloned["prompt_trace"]["lora_index"] >= len(cloned.get("loras", [])):
            raise ScenePlanError("Scene Prompt row prompt_trace lora_index is invalid.")
    return cloned


def empty_row():
    return {
        "labels": [], "positive_parts": [], "negative_parts": [], "path_parts": [], "filename_parts": [],
        "display_labels": [], "display_label_groups": [], "set_refs": [], "source_node_ids": [],
        "source_node_names": {}, "callbacks": [],
    }


def row_label(row):
    labels = [item.strip() for item in row["labels"] if item.strip()]
    path_parts = [item.strip() for item in row["path_parts"] if item.strip()]
    return " / ".join(labels) or "/".join(path_parts) or "Scene"


def _clone_sources(sources):
    if not isinstance(sources, list):
        raise ScenePlanError("Scene Prompt plan sources must be a list.")
    cloned = []
    for source in sources:
        if not isinstance(source, dict):
            raise ScenePlanError("Scene Prompt plan sources must contain objects.")
        _require_exact_keys(source, SOURCE_KEYS, "Scene Prompt plan source")
        cloned.append({
            "index": _require_int(source["index"], "Scene Prompt source index", 1, MAX_SAFE_INTEGER),
            "row_count": _require_int(source["row_count"], "Scene Prompt source row_count", 0, MAX_SAFE_INTEGER),
            "total_images": _require_int(source["total_images"], "Scene Prompt source total_images", 0, MAX_SAFE_INTEGER),
            "total_batches": _require_int(source["total_batches"], "Scene Prompt source total_batches", 0, MAX_SAFE_INTEGER),
        })
    return cloned


def with_prompt_trace(
    row,
    before_row=None,
    added_positive_parts=None,
    added_negative_parts=None,
    kind="delta",
    lora_index=None,
):
    """Attach runtime-only prompt provenance for the immediately preceding Scene node."""
    current = _clone_row(row)
    before = _clone_row(before_row if before_row is not None else empty_row())
    if kind not in PROMPT_TRACE_KINDS:
        raise ScenePlanError("Scene Prompt row prompt_trace kind is invalid.")
    if lora_index is not None and (type(lora_index) is not int or lora_index < 0):
        raise ScenePlanError("Scene Prompt row prompt_trace lora_index is invalid.")
    current["prompt_trace"] = {
        "kind": kind,
        "lora_index": lora_index,
        "before_positive_parts": list(before["positive_parts"]),
        "before_negative_parts": list(before["negative_parts"]),
        "added_positive_parts": _require_string_list(
            [] if added_positive_parts is None else list(added_positive_parts),
            "Scene Prompt trace added_positive_parts",
        ),
        "added_negative_parts": _require_string_list(
            [] if added_negative_parts is None else list(added_negative_parts),
            "Scene Prompt trace added_negative_parts",
        ),
    }
    return current


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
        "source_node_names": {**left_row["source_node_names"], **right_row["source_node_names"]},
        "callbacks": _merge_callbacks(left_row["callbacks"], right_row["callbacks"]),
    }
    latent = right_row.get("latent") or left_row.get("latent")
    if latent is not None:
        row["latent"] = latent
    model_links = right_row.get("model_links") or left_row.get("model_links")
    if model_links is not None:
        row["model_links"] = model_links
    loras = [*left_row.get("loras", []), *right_row.get("loras", [])]
    if loras:
        row["loras"] = loras
    return row


def _merge_callbacks(left, right):
    result = []
    seen = set()
    for callback in [*left, *right]:
        key = callback["callback_node_id"]
        if key in seen:
            continue
        seen.add(key)
        result.append(copy.deepcopy(callback))
    return result


# Runtime plans use the v7 lazy schedule. Row and field validators above remain
# the single source of truth for leaf data shared by each schedule operation.
from .schedule import (  # noqa: E402
    make_plan, seed_plan, normalize_plan, transform, mark_prompt_passthrough,
    mark_prompt_whole, with_source_node, append_callback, multiply_count, merge,
    queue, matrix_product, item_for_normalized_plan, item_for_index,
    replay_index_for_event, _validate_queue_controls,
)
