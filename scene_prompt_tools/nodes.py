import copy
import errno
import hashlib
import json
import os
import re
import threading
import time
import tempfile
import unicodedata
from collections import OrderedDict
from datetime import datetime

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import comfy.model_management
import folder_paths
from comfy.cli_args import args

from .prompt import (
    DEFAULT_SELECTED_JSON,
    SCENE_PROMPT_TYPE,
    _compose_prompt_parts,
    _expand_prompt_parts,
    _join_unique,
    _merge_positive_negative_parts,
    _parse_selection_json,
    _scene_prompt_change_key,
    _split_prompt,
)
from .plan import (
    MAX_BATCH_SIZE,
    MAX_SAFE_INTEGER,
    MAX_DIMENSION,
    MIN_BATCH_SIZE,
    MIN_DIMENSION,
    ScenePlanError,
    empty_row,
    item_for_normalized_plan,
    matrix_product,
    merge,
    multiply_count,
    normalize_plan,
    queue,
    transform,
    with_source_node,
)
from .runs import get_run_plan_reference, require_run_context, set_run_plan_reference


MATRIX_LINE_TYPE = "SCENE_MATRIX_LINE"
MATRIX_LINE_KEYS = {
    "type", "version", "row_id", "node_id", "category", "name", "path_label", "enabled", "filename_enabled",
    "positive_base", "positive_json", "negative_base", "negative_json", "category_order",
    "positive_parts", "negative_parts", "display_labels", "display_label_groups",
}
MATRIX_LINE_REQUIRED_LEGACY_KEYS = {"row_id", "name", "path_label"}
SCENE_SAVE_INFO_TYPE = "SCENE_SAVE_INFO"
SAVE_METADATA_WORKFLOW = "ワークフロー全体"
SAVE_METADATA_PROMPT_ONLY = "プロンプトのみ"
SAVE_METADATA_EXECUTION_PATH = "生成経路ノードのみ"
SAVE_METADATA_CHOICES = (
    SAVE_METADATA_WORKFLOW,
    SAVE_METADATA_EXECUTION_PATH,
    SAVE_METADATA_PROMPT_ONLY,
)
DEFAULT_LATENT = {"width": 512, "height": 512, "batch_size": 1}
MAX_RESOLUTION = MAX_DIMENSION

PATH_DIRECTORY = "フォルダに分ける"
PATH_APPEND_TO_PREVIOUS = "前のフォルダ名に結合"
MODEL_MODE_ILLUSTRIOUS = "Illustrious"
MODEL_MODE_ANIMA = "Anima"
MODEL_MODE_CHOICES = (MODEL_MODE_ILLUSTRIOUS, MODEL_MODE_ANIMA)

DEFAULT_MATRIX_JSON = "{\"version\":1,\"sets\":[]}"
SCENE_PROMPT_INPUT_NAMES = tuple(f"scene_prompt{index}" for index in range(1, 11))
BAD_PATH_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
BAD_FILENAME_PREFIX_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]+')
WINDOWS_RESERVED_PREFIX_RE = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", re.IGNORECASE)
SEED_MODULO = 18446744073709551616
SEED_MAX = SEED_MODULO - 1
def _clean_string_list(values):
    return [str(value).strip() for value in values if str(value).strip()] if isinstance(values, list) else []


def _require_string_list(value, name):
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{name} must be a list of strings.")
    return value


def _clean_label_groups(values):
    if not isinstance(values, list):
        return []
    groups = []
    for group in values:
        items = group if isinstance(group, list) else [group]
        labels = _clean_string_list(items)
        if labels:
            groups.append(labels)
    return groups


def _normalize_path_mode(value):
    text = str(value or "").strip()
    if text == PATH_APPEND_TO_PREVIOUS:
        return PATH_APPEND_TO_PREVIOUS
    return PATH_DIRECTORY


def _normalize_model_mode(value):
    return MODEL_MODE_ANIMA if str(value or "").strip() == MODEL_MODE_ANIMA else MODEL_MODE_ILLUSTRIOUS


def _scene_bool(value, default=True):
    if value is None:
        return bool(default)
    if isinstance(value, str):
        return value.strip().lower() not in ("0", "false", "no", "off", "なし")
    return bool(value)


def _prompt_link_source(value, node_id, input_name):
    if not isinstance(value, (list, tuple)) or len(value) != 2 or not isinstance(value[0], str):
        return None
    source_id, output_index = value
    if isinstance(output_index, bool) or not isinstance(output_index, int) or output_index < 0:
        raise ValueError(
            f"Scene Save Image の生成経路を保存できません: ノード {node_id} の入力 {input_name} の接続先が不正です。"
        )
    return source_id


def _prompt_ancestor_ids(prompt, target_id):
    if not isinstance(prompt, dict):
        raise ValueError("Scene Save Image の生成経路を保存できません: prompt がノード辞書ではありません。")
    target_id = str(target_id or "")
    if not target_id or target_id not in prompt:
        raise ValueError(
            "Scene Save Image の生成経路を保存できません: 保存対象のノードIDが prompt にありません。"
        )

    ancestors = set()
    pending = [target_id]
    while pending:
        node_id = pending.pop()
        if node_id in ancestors:
            continue
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            raise ValueError(
                f"Scene Save Image の生成経路を保存できません: ノード {node_id} の定義が不正です。"
            )
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            raise ValueError(
                f"Scene Save Image の生成経路を保存できません: ノード {node_id} の inputs が不正です。"
            )
        ancestors.add(node_id)
        for input_name, value in inputs.items():
            source_id = _prompt_link_source(value, node_id, input_name)
            if source_id is None:
                continue
            if source_id not in prompt:
                raise ValueError(
                    f"Scene Save Image の生成経路を保存できません: ノード {node_id} の入力 {input_name} が存在しないノード {source_id} を参照しています。"
                )
            pending.append(source_id)
    return ancestors


def _slice_prompt_for_output(prompt, target_id):
    ancestor_ids = _prompt_ancestor_ids(prompt, target_id)
    return _slice_prompt_to_ids(prompt, ancestor_ids)


def _slice_prompt_to_ids(prompt, included_ids):
    saved = {}
    for node_id, node in prompt.items():
        if node_id not in included_ids:
            continue
        copied = copy.deepcopy(node)
        inputs = copied.get("inputs", {})
        if isinstance(inputs, dict):
            copied["inputs"] = {
                name: value
                for name, value in inputs.items()
                if (source_id := _prompt_link_source(value, node_id, name)) is None or source_id in included_ids
            }
        saved[node_id] = copied
    return saved


def _workflow_node_id(node):
    if not isinstance(node, dict) or "id" not in node:
        return None
    return str(node["id"])


def _workflow_link_endpoint_ids(link):
    if isinstance(link, (list, tuple)) and len(link) >= 4:
        return str(link[1]), str(link[3])
    if isinstance(link, dict) and "origin_id" in link and "target_id" in link:
        return str(link["origin_id"]), str(link["target_id"])
    return None


def _workflow_link_id(link):
    if isinstance(link, (list, tuple)) and link:
        return link[0]
    if isinstance(link, dict):
        return link.get("id")
    return None


def _prune_workflow_node_links(nodes, link_ids):
    for node in nodes:
        for input_slot in node.get("inputs", []) if isinstance(node, dict) else []:
            if isinstance(input_slot, dict) and input_slot.get("link") not in link_ids:
                input_slot["link"] = None
        for output_slot in node.get("outputs", []) if isinstance(node, dict) else []:
            if not isinstance(output_slot, dict) or not isinstance(output_slot.get("links"), list):
                continue
            output_slot["links"] = [link_id for link_id in output_slot["links"] if link_id in link_ids]


def _workflow_group_intersects_node(group, node):
    if not isinstance(group, dict) or not isinstance(node, dict):
        return False
    bounding = group.get("bounding")
    position = node.get("pos")
    size = node.get("size")
    if (
        not isinstance(bounding, (list, tuple)) or len(bounding) != 4
        or not isinstance(position, (list, tuple)) or len(position) != 2
        or not isinstance(size, (list, tuple)) or len(size) != 2
    ):
        return False
    try:
        group_x, group_y, group_width, group_height = (float(value) for value in bounding)
        node_x, node_y = (float(value) for value in position)
        node_width, node_height = (float(value) for value in size)
    except (TypeError, ValueError):
        return False
    return (
        node_x < group_x + group_width
        and node_x + node_width > group_x
        and node_y < group_y + group_height
        and node_y + node_height > group_y
    )


def _slice_workflow_for_output(workflow, ancestor_ids):
    if not isinstance(workflow, dict):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow がノード定義ではありません。")
    workflow_nodes = workflow.get("nodes")
    if not isinstance(workflow_nodes, list):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow の nodes が不正です。")

    included_nodes = [
        node
        for node in workflow_nodes
        if _workflow_node_id(node) in ancestor_ids
    ]
    included_ids = {_workflow_node_id(node) for node in included_nodes}
    if included_ids != ancestor_ids:
        missing = ", ".join(sorted(ancestor_ids - included_ids))
        raise ValueError(
            "Scene Save Image の生成経路を保存できません: workflow にノードIDがありません: " + missing
        )

    result = copy.deepcopy({
        key: value
        for key, value in workflow.items()
        if key not in {"nodes", "links", "groups", "reroutes"}
    })
    result["nodes"] = copy.deepcopy(included_nodes)

    workflow_links = workflow.get("links", [])
    if not isinstance(workflow_links, list):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow の links が不正です。")
    result["links"] = [
        copy.deepcopy(link)
        for link in workflow_links
        if (endpoint_ids := _workflow_link_endpoint_ids(link)) is not None
        and endpoint_ids[0] in included_ids
        and endpoint_ids[1] in included_ids
    ]
    link_ids = {_workflow_link_id(link) for link in result["links"]}
    _prune_workflow_node_links(result["nodes"], link_ids)

    workflow_groups = workflow.get("groups", [])
    if not isinstance(workflow_groups, list):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow の groups が不正です。")
    result["groups"] = [
        copy.deepcopy(group)
        for group in workflow_groups
        if any(_workflow_group_intersects_node(group, node) for node in included_nodes)
    ]
    if "reroutes" in workflow:
        result["reroutes"] = []
    return result


SCENE_NODE_TYPES = {
    "ScenePrompter", "ScenePrompterMerge", "ScenePrompterQueue", "ScenePrompterExpand",
    "ScenePromptCounter", "SceneMatrix", "ScenePath", "SceneEmptyLatent",
    "ScenePresetInput", "ScenePresetOutput", "ScenePresetReference",
}


def _scene_source_ids(scene_info):
    if not isinstance(scene_info, dict):
        return set()
    values = scene_info.get("source_node_ids", [])
    return {str(value) for value in values if str(value).strip()} if isinstance(values, list) else set()


def _selected_ancestor_ids(prompt, target_id, scene_info, selected_scene_ids=None):
    """Keep ordinary image ancestors, but only selected Scene-plan branches."""
    selected_scene_ids = _scene_source_ids(scene_info) if selected_scene_ids is None else selected_scene_ids
    if not selected_scene_ids:
        return _prompt_ancestor_ids(prompt, target_id)

    included = set()
    pending = [str(target_id)]
    while pending:
        node_id = pending.pop()
        if node_id in included:
            continue
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            raise ValueError(f"Scene Save Image の生成経路を保存できません: ノード {node_id} の定義が不正です。")
        class_type = str(node.get("class_type") or "")
        if class_type in SCENE_NODE_TYPES and node_id not in selected_scene_ids:
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            raise ValueError(f"Scene Save Image の生成経路を保存できません: ノード {node_id} の inputs が不正です。")
        included.add(node_id)
        for input_name, value in inputs.items():
            source_id = _prompt_link_source(value, node_id, input_name)
            if source_id is not None:
                if source_id not in prompt:
                    raise ValueError(
                        f"Scene Save Image の生成経路を保存できません: ノード {node_id} の入力 {input_name} が存在しないノード {source_id} を参照しています。"
                    )
                pending.append(source_id)
    return included


def _metadata_for_save_mode(
    prompt,
    extra_pnginfo,
    unique_id,
    metadata_mode,
    scene_info=None,
    expand_preset_contents=False,
):
    if metadata_mode not in SAVE_METADATA_CHOICES:
        raise ValueError("Scene Save Image のメタデータ保存モードが不正です。")
    if extra_pnginfo is not None and not isinstance(extra_pnginfo, dict):
        raise ValueError("Scene Save Image の extra_pnginfo が不正です。")

    if metadata_mode == SAVE_METADATA_WORKFLOW and not expand_preset_contents:
        return prompt, extra_pnginfo

    if metadata_mode == SAVE_METADATA_PROMPT_ONLY:
        saved_prompt = None
        saved_extra = (
            None
            if extra_pnginfo is None
            else {
                key: value
                for key, value in extra_pnginfo.items()
                if key not in {"prompt", "workflow"}
            }
        )
        return saved_prompt, saved_extra

    if expand_preset_contents and isinstance(prompt, dict):
        has_prompt_reference = any(
            isinstance(node, dict) and node.get("class_type") == "ScenePresetReference"
            for node in prompt.values()
        )
        workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
        has_workflow_reference = (
            metadata_mode == SAVE_METADATA_WORKFLOW
            and isinstance(workflow, dict)
            and any(
                isinstance(node, dict) and node.get("type") == "ScenePresetReference"
                for node in workflow.get("nodes", [])
            )
        )
        expand_preset_contents = has_prompt_reference or has_workflow_reference

    if expand_preset_contents:
        if not isinstance(prompt, dict):
            raise ValueError("Scene Save Image のPreset展開には prompt が必要です。")
        workflow = extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
        if not isinstance(workflow, dict):
            raise ValueError("Scene Save Image のPreset展開には workflow が必要です。")
        run_handle = str((scene_info or {}).get("run_handle") or "").strip()
        context = require_run_context(run_handle)
        from .preset_metadata import expand_preset_references
        from .presets import snapshot_presets_for_metadata

        snapshots = snapshot_presets_for_metadata(run_handle, context["user_id"])
        expanded_prompt, expanded_workflow, source_aliases = expand_preset_references(
            prompt,
            workflow,
            snapshots,
            expand_workflow_references=metadata_mode == SAVE_METADATA_WORKFLOW,
        )
        expanded_extra = {
            key: copy.deepcopy(value)
            for key, value in extra_pnginfo.items()
        }
        expanded_extra["workflow"] = expanded_workflow
        if metadata_mode == SAVE_METADATA_WORKFLOW:
            return expanded_prompt, expanded_extra
        selected_sources = _scene_source_ids(scene_info)
        selected_ids = {
            node_id
            for node_id, source_id in source_aliases.items()
            if source_id in selected_sources
        }
        ancestor_ids = _selected_ancestor_ids(
            expanded_prompt, unique_id, scene_info, selected_ids
        )
        saved_prompt = _slice_prompt_to_ids(expanded_prompt, ancestor_ids)
        saved_extra = {
            key: value
            for key, value in expanded_extra.items()
            if key not in {"prompt", "workflow"}
        }
        saved_extra["workflow"] = _slice_workflow_for_output(expanded_workflow, ancestor_ids)
        return saved_prompt, saved_extra

    if metadata_mode == SAVE_METADATA_WORKFLOW:
        return prompt, extra_pnginfo

    ancestor_ids = _selected_ancestor_ids(prompt, unique_id, scene_info)
    saved_prompt = _slice_prompt_to_ids(prompt, ancestor_ids)
    saved_extra = None
    if extra_pnginfo is not None:
        saved_extra = {
            key: value
            for key, value in extra_pnginfo.items()
            if key not in {"prompt", "workflow"}
        }
        if "workflow" in extra_pnginfo:
            saved_extra["workflow"] = _slice_workflow_for_output(
                extra_pnginfo["workflow"], ancestor_ids
            )
    return saved_prompt, saved_extra


def _latent_dimension(value, default=512):
    number = default if value is None else value
    if type(number) is not int:
        raise ScenePlanError("Scene Empty Latent width and height must be integers.")
    if not MIN_DIMENSION <= number <= MAX_RESOLUTION or number % 8:
        raise ScenePlanError(
            f"Scene Empty Latent width and height must be multiples of 8 between {MIN_DIMENSION} and {MAX_RESOLUTION}."
        )
    return number


def _latent_batch_size(value, default=1):
    number = default if value is None else value
    if type(number) is not int or not MIN_BATCH_SIZE <= number <= MAX_BATCH_SIZE:
        raise ScenePlanError(
            f"Scene Empty Latent batch_size must be an integer between {MIN_BATCH_SIZE} and {MAX_BATCH_SIZE}."
        )
    return number


def _normalize_latent_config(value=None):
    if value is None:
        data = DEFAULT_LATENT
    elif isinstance(value, dict) and set(value) == {"width", "height", "batch_size"}:
        data = value
    else:
        raise ScenePlanError("Scene Empty Latent settings require width, height, and batch_size.")
    return {
        "width": _latent_dimension(data.get("width"), DEFAULT_LATENT["width"]),
        "height": _latent_dimension(data.get("height"), DEFAULT_LATENT["height"]),
        "batch_size": _latent_batch_size(data.get("batch_size"), DEFAULT_LATENT["batch_size"]),
    }


def _row_latent(row):
    return _normalize_latent_config(row.get("latent") if isinstance(row, dict) else None)


def _empty_latent(config):
    latent_config = _normalize_latent_config(config)
    latent = torch.zeros(
        [
            latent_config["batch_size"],
            4,
            latent_config["height"] // 8,
            latent_config["width"] // 8,
        ],
        device=comfy.model_management.intermediate_device(),
        dtype=comfy.model_management.intermediate_dtype(),
    )
    return {"samples": latent, "downscale_ratio_spacial": 8}


def _selection_json_has_items(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return False
    if not isinstance(value, str):
        return True
    try:
        data = json.loads(value)
    except json.JSONDecodeError:
        return True
    return isinstance(data, dict) and any(data.get("categories", {}).values())


def _normalize_matrix_line_set(value):
    if not isinstance(value, dict):
        raise ValueError("Scene Matrix entries must be objects.")
    if not MATRIX_LINE_REQUIRED_LEGACY_KEYS.issubset(value) or set(value) - MATRIX_LINE_KEYS:
        raise ValueError("Scene Matrix entry has unsupported or missing fields.")
    if value.get("type", MATRIX_LINE_TYPE) != MATRIX_LINE_TYPE or value.get("version", 1) != 1:
        raise ValueError("Unsupported Scene Matrix entry schema.")

    required_string_fields = (
        "row_id",
        "node_id",
        "category",
        "name",
        "path_label",
        "positive_base",
        "positive_json",
        "negative_base",
        "negative_json",
        "category_order",
    )
    for field in required_string_fields:
        if not isinstance(value.get(field, ""), str):
            raise ValueError(f"Scene Matrix {field} must be a string.")
    for field in ("row_id", "name", "path_label"):
        if not value[field].strip():
            raise ValueError(f"Scene Matrix {field} must be a non-empty string.")
    if not isinstance(value.get("enabled", True), bool):
        raise ValueError("Scene Matrix entry enabled must be a boolean.")
    if not isinstance(value.get("filename_enabled", False), bool):
        raise ValueError("Scene Matrix entry filename_enabled must be a boolean.")

    node_id = value.get("node_id", "").strip()
    category = value.get("category", "").strip()
    name = value["name"].strip()
    path_label = value["path_label"].strip()
    positive_base = value.get("positive_base", "")
    positive_json = value.get("positive_json", DEFAULT_SELECTED_JSON)
    negative_base = value.get("negative_base", "")
    negative_json = value.get("negative_json", DEFAULT_SELECTED_JSON)
    category_order = value.get("category_order", "")
    display_labels = _clean_string_list(_require_string_list(value.get("display_labels", []), "Scene Matrix display_labels"))
    raw_label_groups = value.get("display_label_groups", [])
    if not isinstance(raw_label_groups, list) or any(
        not isinstance(group, list) or not all(isinstance(item, str) for item in group)
        for group in raw_label_groups
    ):
        raise ValueError("Scene Matrix display_label_groups must be a list of string lists.")
    display_label_groups = _clean_label_groups(raw_label_groups)
    raw_positive_parts = _require_string_list(value.get("positive_parts", []), "Scene Matrix positive_parts")
    raw_negative_parts = _require_string_list(value.get("negative_parts", []), "Scene Matrix negative_parts")
    _parse_selection_json(positive_json)
    _parse_selection_json(negative_json)

    if positive_base.strip() or _selection_json_has_items(positive_json):
        raw_positive_parts = _compose_prompt_parts(
            positive_base,
            positive_json,
            category_order,
            True,
            0,
        )
    if negative_base.strip() or _selection_json_has_items(negative_json):
        raw_negative_parts = _compose_prompt_parts(
            negative_base,
            negative_json,
            category_order,
            True,
            0,
        )

    positive_parts, negative_parts = _merge_positive_negative_parts(
        raw_positive_parts,
        raw_negative_parts,
        [],
        [],
    )

    return {
        "type": MATRIX_LINE_TYPE,
        "version": 1,
        "row_id": value["row_id"].strip(),
        "node_id": node_id,
        "category": category,
        "name": name,
        "path_label": path_label,
        "enabled": value.get("enabled", True),
        "filename_enabled": value.get("filename_enabled", False),
        "positive_parts": positive_parts,
        "negative_parts": negative_parts,
        "display_labels": display_labels,
        "display_label_groups": display_label_groups,
        "set_refs": [
            {
                "category": category,
                "name": name,
                "path_label": path_label,
                "node_id": node_id,
            }
        ],
        "labels": [name],
        "path_parts": [],
        "filename_parts": [name] if value.get("filename_enabled", False) else [],
    }


def _parse_matrix_data(matrix_json):
    if matrix_json is None or (isinstance(matrix_json, str) and not matrix_json.strip()):
        return {"version": 1, "sets": []}
    if not isinstance(matrix_json, str):
        raise ValueError("Scene Matrix JSON must be a string.")
    try:
        data = json.loads(matrix_json)
    except json.JSONDecodeError as exc:
        raise ValueError("Scene Matrix JSON is invalid.") from exc
    if not isinstance(data, dict) or set(data) != {"version", "sets"}:
        raise ValueError("Scene Matrix JSON must be an object.")
    if data.get("version") != 1:
        raise ValueError("Unsupported Scene Matrix schema version.")
    if not isinstance(data.get("sets"), list):
        raise ValueError("Scene Matrix sets must be a list.")
    return data


def _normalize_matrix_sets(raw_sets):
    sets = []
    row_ids = set()
    for raw_set in raw_sets:
        matrix_line = _normalize_matrix_line_set(raw_set)
        if matrix_line["row_id"] in row_ids:
            raise ValueError("Scene Matrix row_id values must be unique.")
        row_ids.add(matrix_line["row_id"])
        sets.append(matrix_line)
    return sets


def _parse_matrix_sets(matrix_json):
    return _normalize_matrix_sets(_parse_matrix_data(matrix_json).get("sets", []))


def _matrix_has_configured_sets(matrix_json):
    data = _parse_matrix_data(matrix_json)
    raw_sets = data.get("sets")
    return isinstance(raw_sets, list) and len(raw_sets) > 0


def _append_path_part(path_parts, label, path_mode):
    mode = _normalize_path_mode(path_mode)
    clean_label = str(label or "").strip()
    if not clean_label:
        return list(path_parts)

    next_parts = list(path_parts)
    if mode == PATH_APPEND_TO_PREVIOUS and next_parts:
        next_parts[-1] = f"{next_parts[-1]}_{clean_label}"
    else:
        next_parts.append(clean_label)
    return next_parts


def _matrix_line_output_label(matrix_row):
    return str(matrix_row.get("name") or "Matrix 行").strip()


def _row_path(row):
    return "/".join(str(part).strip() for part in row.get("path_parts", []) if str(part).strip())


def _row_label(row):
    labels = [str(item).strip() for item in row.get("labels", []) if str(item).strip()]
    return " / ".join(labels) or _row_path(row) or "Scene"


def _metadata_count(value, label, maximum, default=0):
    if value is None:
        return default
    if type(value) is not int or not 0 <= value <= maximum:
        raise ScenePlanError(f"Scene metadata {label} must be an integer between 0 and {maximum}.")
    return value


def _scene_count(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ScenePlanError("Scene Prompt count must be a nonnegative JavaScript-safe integer.")
    return value


def _scene_run_plan(run_handle, scene_prompt=None, unique_id=None):
    if not str(run_handle or "").strip():
        return normalize_plan(scene_prompt)
    cached = get_run_plan_reference(run_handle, unique_id)
    if cached is not None:
        return cached
    return set_run_plan_reference(run_handle, unique_id, normalize_plan(scene_prompt))


def _scene_prompt_item_for_index(scene_prompt, current_index, normalized=None, strict=False):
    plan = normalized if normalized is not None else normalize_plan(scene_prompt)
    try:
        return item_for_normalized_plan(plan, current_index)
    except IndexError:
        if strict:
            raise IndexError("生成計画に生成対象がありません。") from None
        return {"row": {}, "count": 0, "total_batches": 0, "total_images": 0}


def _safe_path_part(value, default_name="untitled"):
    reserved_names = {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    }
    text = str(value or "").strip().strip(". ")
    text = BAD_PATH_CHARS_RE.sub("_", text)
    text = re.sub(r"\s+", " ", text).strip().strip(". ")
    if text in ("", ".", ".."):
        return default_name
    if text.upper() in reserved_names:
        text = f"{text}_"
    return text[:80].rstrip(" .") or default_name


def _safe_relative_parts(value):
    parts = []
    for raw_part in re.split(r"[\\/]+", str(value or "")):
        stripped = raw_part.strip()
        if not stripped or stripped in (".", ".."):
            continue
        parts.append(_safe_path_part(stripped))
    return parts


def _safe_filename_prefix(value):
    prefix = unicodedata.normalize("NFC", str(value or ""))
    prefix = BAD_FILENAME_PREFIX_CHARS_RE.sub("_", prefix)
    first_component = prefix.split(".", 1)[0].rstrip(" ")
    if WINDOWS_RESERVED_PREFIX_RE.match(first_component):
        prefix = f"_{prefix}"
    if sum(2 if ord(character) > 0xFFFF else 1 for character in prefix) <= 240:
        return prefix
    digest = hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:8]
    kept = []
    units = 0
    for character in prefix:
        width = 2 if ord(character) > 0xFFFF else 1
        if units + width > 231:
            break
        kept.append(character)
        units += width
    return f"{''.join(kept)}~{digest}"


def _filename_units(value):
    text = str(value)
    return len(text.encode("utf-8")), len(text.encode("utf-16-le")) // 2


def _output_filename_prefix(value, extension, padding, counter=None):
    """Keep final PNG and its reservation sidecar within Windows component limits."""
    prefix = _safe_filename_prefix(value)
    # SceneSaveImage only accepts file indices up to MAX_SAFE_INTEGER. Reserve
    # that full width up front so a long prefix does not change while a valid
    # counter grows during collision handling.
    counter_width = max(
        int(padding),
        len(str(MAX_SAFE_INTEGER)),
        len(str(counter)) if counter is not None else 0,
    )
    suffix = f"{'9' * counter_width}.{extension}.scene-save-reservation"
    suffix_utf8, suffix_utf16 = _filename_units(suffix)
    if suffix_utf8 > 255 or suffix_utf16 > 255:
        raise ValueError("画像ファイル名の拡張子または連番が長すぎます。")
    max_utf8 = 255 - suffix_utf8
    max_utf16 = 255 - suffix_utf16
    utf8, utf16 = _filename_units(prefix)
    if utf8 <= max_utf8 and utf16 <= max_utf16:
        return prefix
    digest = hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:8]
    kept = []
    used_utf8 = used_utf16 = 0
    for character in prefix:
        char_utf8, char_utf16 = _filename_units(character)
        if used_utf8 + char_utf8 + 9 > max_utf8 or used_utf16 + char_utf16 + 9 > max_utf16:
            break
        kept.append(character)
        used_utf8 += char_utf8
        used_utf16 += char_utf16
    return f"{''.join(kept)}~{digest}"


def _resolve_run_dir(run_dir):
    value = str(run_dir or "").strip().strip('"')
    if not value or value.lower() == "auto":
        value = datetime.now().strftime("%Y_%m%d_%H%M%S")
    safe_parts = _safe_relative_parts(value)
    if not safe_parts:
        safe_parts = [datetime.now().strftime("%Y_%m%d_%H%M%S")]
    return safe_parts


def _is_relative_to(path, root):
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(root)]) == os.path.abspath(root)
    except ValueError:
        return False


def _subfolder_for_preview(directory, output_dir):
    if not _is_relative_to(directory, output_dir):
        return None
    rel = os.path.relpath(directory, output_dir)
    return "" if rel == "." else rel.replace(os.sep, "/")


def _find_next_index(run_root, extension, padding, filename_prefix=""):
    prefix = _output_filename_prefix(filename_prefix, extension, padding)
    pattern = re.compile(
        rf"^{re.escape(prefix)}(\d{{{padding},}})\.{re.escape(extension)}$",
        re.IGNORECASE,
    )
    highest = 0
    if os.path.isdir(run_root):
        for root, _dirs, files in os.walk(run_root):
            for filename in files:
                match = pattern.match(filename)
                if match:
                    highest = max(highest, int(match.group(1)))
    return highest + 1


_RUN_DIR_CACHE = {}
_NEXT_INDEX_CACHE = OrderedDict()
_NEXT_INDEX_CACHE_LOCK = threading.RLock()
_FILENAME_RESERVATION_LOCK = threading.Lock()


def _next_index_cache_key(run_root, extension, padding, filename_prefix=""):
    return (
        os.path.abspath(run_root),
        str(extension).lower(),
        int(padding),
        _output_filename_prefix(filename_prefix, extension, padding),
    )


def _cached_next_index(run_root, extension, padding, filename_prefix=""):
    key = _next_index_cache_key(run_root, extension, padding, filename_prefix)
    with _NEXT_INDEX_CACHE_LOCK:
        cached = _NEXT_INDEX_CACHE.get(key)
        if cached is not None:
            _NEXT_INDEX_CACHE.move_to_end(key)
            return cached
        value = _find_next_index(run_root, extension, padding, filename_prefix)
        _NEXT_INDEX_CACHE[key] = value
        if len(_NEXT_INDEX_CACHE) > 256:
            _NEXT_INDEX_CACHE.popitem(last=False)
        return value


def _remember_next_index(run_root, extension, padding, next_index, filename_prefix=""):
    key = _next_index_cache_key(run_root, extension, padding, filename_prefix)
    with _NEXT_INDEX_CACHE_LOCK:
        current = _NEXT_INDEX_CACHE.get(key, 0)
        _NEXT_INDEX_CACHE[key] = max(int(current or 0), int(next_index or 0))
        _NEXT_INDEX_CACHE.move_to_end(key)
        if len(_NEXT_INDEX_CACHE) > 256:
            _NEXT_INDEX_CACHE.popitem(last=False)


def _reserve_output_path(directory, extension, padding, counter, filename_prefix=""):
    """Reserve a unique output name without exposing an unfinished PNG."""
    while True:
        prefix = _output_filename_prefix(filename_prefix, extension, padding, counter)
        filename = f"{prefix}{counter:0{padding}d}.{extension}"
        path = os.path.join(directory, filename)
        reservation_path = f"{path}.scene-save-reservation"
        if os.path.exists(path):
            counter += 1
            continue
        try:
            descriptor = os.open(reservation_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            counter += 1
            continue
        except PermissionError as exc:
            if exc.errno == errno.EACCES and os.path.lexists(reservation_path):
                counter += 1
                continue
            raise
        else:
            os.close(descriptor)
            if os.path.exists(path):
                try:
                    os.unlink(reservation_path)
                except OSError:
                    pass
                counter += 1
                continue
            return path, reservation_path, filename, counter


def _remove_output_reservation(reservation_path):
    with _FILENAME_RESERVATION_LOCK:
        try:
            os.unlink(reservation_path)
        except FileNotFoundError:
            pass


def _auto_seed_base(seed_base):
    seed = int(seed_base or 0)
    if seed > 0:
        return seed
    return time.time_ns() % SEED_MODULO


def _seed_change_key(seed_base):
    seed = int(seed_base or 0)
    if seed > 0:
        return str(seed)
    return str(time.time_ns())


def _cached_run_parts(base_dir, run_dir, prompt=None, unique_id=None):
    value = str(run_dir or "").strip().strip('"')
    if value and value.lower() != "auto":
        return _resolve_run_dir(value)

    prompt_key = ""
    if isinstance(prompt, dict):
        prompt_key = hashlib.sha256(
            json.dumps(prompt, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()
    key = (str(unique_id or ""), prompt_key, os.path.abspath(base_dir))
    cached = _RUN_DIR_CACHE.get(key)
    if cached:
        return cached

    parts = _resolve_run_dir("auto")
    _RUN_DIR_CACHE[key] = parts
    if len(_RUN_DIR_CACHE) > 256:
        for expired_key in list(_RUN_DIR_CACHE)[:128]:
            _RUN_DIR_CACHE.pop(expired_key, None)
    return parts


def _normalize_scene_save_info(value):
    if not isinstance(value, dict):
        return {}
    use_run_dir = value.get("use_run_dir", True)
    return {
        "run_dir": str(value.get("run_dir") or "").strip(),
        "use_run_dir": _scene_bool(use_run_dir),
        "path": str(value.get("path") or "").strip(),
        "filename_prefix": _safe_filename_prefix(value.get("filename_prefix")),
        "file_index": _metadata_count(value.get("file_index"), "file_index", MAX_SAFE_INTEGER, 0),
        "positive": str(value.get("positive") or ""),
        "negative": str(value.get("negative") or ""),
        "seed": int(value.get("seed") or 0),
        "label": str(value.get("label") or ""),
        "row_index": _metadata_count(value.get("row_index"), "row_index", MAX_SAFE_INTEGER, 0),
        "repeat_index": _metadata_count(value.get("repeat_index"), "repeat_index", MAX_SAFE_INTEGER, 0),
        "repeat_count": _metadata_count(value.get("repeat_count"), "repeat_count", MAX_SAFE_INTEGER, 0),
        "total_count": _metadata_count(value.get("total_count"), "total_count", MAX_SAFE_INTEGER, 0),
        "source_node_ids": [str(node_id) for node_id in value.get("source_node_ids", []) if str(node_id).strip()] if isinstance(value.get("source_node_ids"), list) else [],
        "run_handle": str(value.get("run_handle") or "").strip(),
    }

class SceneMatrix:
    DESCRIPTION = """複数のプロンプト行を作り、入力された scene_prompt と組み合わせて生成計画を展開します。\n有効なMatrix行ごとにポジティブ・ネガティブ候補が追加され、入力行との全組み合わせが出力されます。\nMatrix行が未設定なら入力をそのまま通し、設定済みの行がすべて無効なら生成対象は0件になります。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt", "label": "scene_prompt"}),
        }

        return {
            "required": {
                "matrix_json": (
                    "STRING",
                    {"multiline": True, "default": DEFAULT_MATRIX_JSON, "hidden": True},
                ),
                "run_handle": ("STRING", {"default": "", "hidden": True}),
            },
            "optional": optional,
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        matrix_json,
        run_handle="",
        **kwargs,
    ):
        parts = [
            matrix_json or "",
            str(run_handle or ""),
        ]
        scene_prompt = kwargs.get("scene_prompt")
        if isinstance(scene_prompt, dict):
            parts.append(_scene_prompt_change_key(scene_prompt))
        return "|".join(parts)

    def build(
        self,
        matrix_json,
        run_handle="",
        scene_prompt=None,
        unique_id=None,
        source_node_id="",
        **kwargs,
    ):
        del kwargs
        matrix_data = _parse_matrix_data(matrix_json)
        matrix_sets = _normalize_matrix_sets(matrix_data["sets"])
        return (
            with_source_node(matrix_product(
                scene_prompt,
                matrix_sets,
                bool(matrix_data["sets"]),
            ), source_node_id or unique_id),
        )


class ScenePath:
    DESCRIPTION = """入力された scene_prompt の各行へ、画像保存用のパス要素を追加します。ノード名がフォルダ名として使われます。\n「フォルダに分ける」は新しい階層を追加し、「前のフォルダ名に結合」は直前の名前へアンダースコアで結合します。プロンプト本文は変更しません。\nこのノード自身はフォルダを作成しません。実際のフォルダ作成は、後段の Scene Save Image が画像を保存するときに行われます。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "apply_path"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path_name": ("STRING", {"default": "", "hidden": True}),
                "path_mode": (
                    [PATH_DIRECTORY, PATH_APPEND_TO_PREVIOUS],
                    {"default": PATH_DIRECTORY, "display_name": "保存パスの扱い", "label": "保存パスの扱い"},
                ),
            },
            "optional": {"scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt", "label": "scene_prompt"})},
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, path_name, scene_prompt=None, path_mode=PATH_DIRECTORY, **kwargs):
        del kwargs
        return "|".join(
            [
                str(path_name or ""),
                _scene_prompt_change_key(scene_prompt),
                _normalize_path_mode(path_mode),
            ]
        )

    def apply_path(self, path_name, scene_prompt=None, path_mode=PATH_DIRECTORY, unique_id=None, source_node_id=""):
        label = str(path_name or "").strip() or "Scene Path"
        return (
            with_source_node(transform(
                scene_prompt,
                lambda row, _item: {**row, "path_parts": _append_path_part(row.get("path_parts", []), label, path_mode)},
            ), source_node_id or unique_id),
        )


class ScenePromptQueue:
    DESCRIPTION = """最大10個の scene_prompt を scene_prompt1 から番号順に、1つの生成計画へ連結します。\nMerge と異なり入力同士の組み合わせは作らず、各入力の行・順序・生成回数を維持したまま後ろへ追加します。\nこれはScene生成計画の並び順を作るノードであり、ComfyUI標準の実行Queueそのものではありません。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "queue"

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for index, name in enumerate(SCENE_PROMPT_INPUT_NAMES, start=1):
            optional[name] = (
                SCENE_PROMPT_TYPE,
                {"display_name": f"scene_prompt{index}", "label": f"scene_prompt{index}"},
            )

        return {
            "required": {},
            "optional": optional,
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        parts = []
        for name in SCENE_PROMPT_INPUT_NAMES:
            value = kwargs.get(name)
            if isinstance(value, dict):
                parts.append(_scene_prompt_change_key(value))
        return "|".join(parts)

    def queue(self, unique_id=None, source_node_id="", **kwargs):
        return (with_source_node(queue([kwargs.get(name) for name in SCENE_PROMPT_INPUT_NAMES]), source_node_id or unique_id),)


class ScenePromptMerge:
    DESCRIPTION = """2つの scene_prompt を組み合わせ、両方の全組み合わせを生成計画として出力します。\nポジティブ、ネガティブ、ラベル、保存パスが結合されます。潜在画像設定は scene_prompt2 側を優先し、未設定なら scene_prompt1 を継承します。\n生成回数は両方の行の値を掛け合わせます。未接続側は1行の空計画として扱われます。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "merge"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "scene_prompt1": (
                    SCENE_PROMPT_TYPE,
                    {"display_name": "scene_prompt1", "label": "scene_prompt1"},
                ),
                "scene_prompt2": (
                    SCENE_PROMPT_TYPE,
                    {"display_name": "scene_prompt2", "label": "scene_prompt2"},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, scene_prompt1=None, scene_prompt2=None, **kwargs):
        return "|".join(
            [
                _scene_prompt_change_key(scene_prompt1),
                _scene_prompt_change_key(scene_prompt2),
            ]
        )

    def merge(self, scene_prompt1=None, scene_prompt2=None, unique_id=None, source_node_id=""):
        return (with_source_node(merge(scene_prompt1, scene_prompt2), source_node_id or unique_id),)


class ScenePromptCounter:
    DESCRIPTION = """入力された scene_prompt の全行の生成回数へ、指定値を掛けます。\nCountを直列につなぐと値は積算されます。0を指定すると生成対象は0件になります。\n未接続なら1行の空計画から開始します。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "count"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "count": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_SAFE_INTEGER,
                        "display_name": "生成回数",
                        "label": "生成回数",
                    },
                ),
            },
            "optional": {"scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt", "label": "scene_prompt"})},
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, scene_prompt=None, count=1, **kwargs):
        return "|".join(
            [
                _scene_prompt_change_key(scene_prompt),
                str(_scene_count(count)),
            ]
        )

    def count(self, scene_prompt=None, count=1, unique_id=None, source_node_id=""):
        return (with_source_node(multiply_count(scene_prompt, count), source_node_id or unique_id),)


class SceneEmptyLatent:
    DESCRIPTION = """scene_prompt の各行へ、空の潜在画像の幅・高さ・バッチサイズを設定します。\nこのノードでは潜在画像の実体はまだ生成せず、設定だけを生成計画へ記録します。実際の空潜在画像は Scene Prompt Expand が生成します。\n幅と高さは8の倍数で指定してください。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "apply_latent"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": DEFAULT_LATENT["width"],
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "width",
                        "label": "width",
                        "tooltip": "The width of the latent images in pixels.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": DEFAULT_LATENT["height"],
                        "min": 16,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "display_name": "height",
                        "label": "height",
                        "tooltip": "The height of the latent images in pixels.",
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": DEFAULT_LATENT["batch_size"],
                        "min": 1,
                        "max": 4096,
                        "display_name": "batch_size",
                        "label": "batch_size",
                        "tooltip": "The number of latent images in the batch.",
                    },
                ),
            },
            "optional": {"scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt", "label": "scene_prompt"})},
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, scene_prompt=None, width=512, height=512, batch_size=1, **kwargs):
        latent = _normalize_latent_config({"width": width, "height": height, "batch_size": batch_size})
        return "|".join(
            [
                _scene_prompt_change_key(scene_prompt),
                str(latent["width"]),
                str(latent["height"]),
                str(latent["batch_size"]),
            ]
        )

    def apply_latent(self, scene_prompt=None, width=512, height=512, batch_size=1, unique_id=None, source_node_id=""):
        latent = _normalize_latent_config({"width": width, "height": height, "batch_size": batch_size})
        return (with_source_node(transform(scene_prompt, lambda row, _item: {**row, "latent": dict(latent)}), source_node_id or unique_id),)


class ScenePromptExpand:
    DESCRIPTION = """Scene生成計画から、生成番号に対応する1件を取り出して展開します。\nポジティブ、ネガティブ、保存用メタ情報、シード、空の潜在画像を出力し、{A|B|C} 形式の候補もこの段階で開始シードを基準に確定します。\n連続生成では計画全体を1枚ずつ処理し、複数の実行要求は順番に実行されます。このノード自身は画像を保存しません。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = ("STRING", "STRING", SCENE_SAVE_INFO_TYPE, "INT", "LATENT")
    RETURN_NAMES = ("ポジティブ", "ネガティブ", "メタ情報", "シード", "潜在画像")
    FUNCTION = "expand"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "current_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_SAFE_INTEGER,
                        "display_name": "生成番号",
                        "label": "生成番号",
                    },
                ),
                "run_id": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "実行ID",
                        "label": "実行ID",
                    },
                ),
                "seed_base": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": SEED_MAX,
                        "display_name": "開始シード",
                        "label": "開始シード",
                    },
                ),
                "timestamp_dir": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "display_name": "タイムスタンプディレクトリ",
                        "label": "タイムスタンプディレクトリ",
                    },
                ),
            },
            "optional": {
                "prefix": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "display_name": "ファイル名プレフィックス",
                        "label": "ファイル名プレフィックス",
                    },
                ),
                "scene_prompt": (
                    SCENE_PROMPT_TYPE,
                    {"display_name": "scene_prompt", "label": "scene_prompt"},
                ),
                "model_mode": (
                    list(MODEL_MODE_CHOICES),
                    {
                        "default": MODEL_MODE_ILLUSTRIOUS,
                        "display_name": "モデル",
                        "label": "モデル",
                    },
                ),
            },
            "hidden": {
                "run_handle": ("STRING", {"default": "", "hidden": True}),
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        current_index=0,
        run_id="",
        seed_base=0,
        timestamp_dir=True,
        prefix="",
        scene_prompt=None,
        model_mode=MODEL_MODE_ILLUSTRIOUS,
        run_handle="",
        unique_id=None,
    ):
        return "|".join(
            [
                _scene_prompt_change_key(scene_prompt),
                str(current_index),
                str(run_id or ""),
                _seed_change_key(seed_base),
                str(_scene_bool(timestamp_dir)),
                _safe_filename_prefix(prefix),
                _normalize_model_mode(model_mode),
            ]
        )

    def expand(
        self,
        current_index=0,
        run_id="",
        seed_base=0,
        timestamp_dir=True,
        prefix="",
        scene_prompt=None,
        model_mode=MODEL_MODE_ILLUSTRIOUS,
        run_handle="",
        unique_id=None,
    ):
        separator = ", "
        plan = _scene_run_plan(run_handle, scene_prompt, unique_id)
        item = _scene_prompt_item_for_index(None, current_index, normalized=plan, strict=True)
        row = item["row"]
        global_index = int(item.get("global_index", 0) or 0)
        seed = (_auto_seed_base(seed_base) + global_index) % SEED_MODULO
        positive_parts = _expand_prompt_parts(row.get("positive_parts", []), seed, "positive")
        negative_parts = _expand_prompt_parts(row.get("negative_parts", []), seed, "negative")
        positive_parts, negative_parts = _merge_positive_negative_parts(
            positive_parts,
            negative_parts,
            [],
            [],
        )
        positive = _join_unique(positive_parts, separator)
        negative = _join_unique(negative_parts, separator)
        if _normalize_model_mode(model_mode) == MODEL_MODE_ANIMA:
            positive = positive.replace("_", " ")
            negative = negative.replace("_", " ")
        latent_config = _row_latent(row)
        latent = _empty_latent(latent_config)
        use_run_dir = _scene_bool(timestamp_dir)
        directory_run_id = str(run_id or "auto").split("__", 1)[0]
        run_dir = "/".join(_resolve_run_dir(directory_run_id)) if use_run_dir else ""
        repeat_count = _metadata_count(item["count"], "repeat_count", MAX_SAFE_INTEGER)

        save_info = {
            "type": SCENE_SAVE_INFO_TYPE,
            "version": 1,
            "run_dir": run_dir,
            "use_run_dir": use_run_dir,
            "path": _row_path(row),
            "filename_prefix": _safe_filename_prefix("".join(row.get("filename_parts", [])) + str(prefix or "")),
            "file_index": global_index + 1,
            "positive": positive,
            "negative": negative,
            "seed": seed,
            "label": item["label"],
            "row_index": _metadata_count(item["row_index"], "row_index", MAX_SAFE_INTEGER),
            "repeat_index": _metadata_count(item["repeat_index"], "repeat_index", MAX_SAFE_INTEGER),
            "repeat_count": repeat_count,
            "total_count": _metadata_count(item["total_images"], "total_count", MAX_SAFE_INTEGER),
            "latent": latent_config,
            "source_node_ids": [*row.get("source_node_ids", []), str(unique_id)] if unique_id is not None else list(row.get("source_node_ids", [])),
            "run_handle": str(run_handle or ""),
        }

        return (positive, negative, save_info, seed, latent)



class SceneSaveImage:
    DESCRIPTION = """生成画像をComfyUIのoutputディレクトリ配下へPNGで保存します。\n保存パス、タイムスタンプディレクトリ、Scene Path で追加された階層を組み合わせ、必要なフォルダは保存時に作成されます。\nファイル名はプレフィックスと5桁の連番で構成され、既存ファイルは上書きせず次の番号を使います。\nメタデータ保存は「ワークフロー全体」「生成経路ノードのみ」「プロンプトのみ」から選べます。プロンプトのみはドラッグでワークフローを復元できません。Presetの中身を展開すると、保存時に固定されたPresetを実ノードと接続へ置き換えます。"""
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"display_name": "画像", "label": "画像"}),
                "path": ("STRING", {"default": "", "display_name": "保存パス", "label": "保存パス"}),
                "metadata_mode": (
                    SAVE_METADATA_CHOICES,
                    {
                        "default": SAVE_METADATA_WORKFLOW,
                        "display_name": "メタデータ保存",
                        "label": "メタデータ保存",
                        "tooltip": "ワークフロー全体: 配置を含む全体を保存。生成経路ノードのみ: 今回の画像に使われたScene枝と画像生成ノードだけを保存。プロンプトのみ: ワークフローは保存しない。",
                    },
                ),
            },
            "optional": {
                "expand_preset_contents": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "Presetの中身を展開",
                        "label": "Presetの中身を展開",
                        "tooltip": "ONにすると、保存されるメタデータ内のScene Preset ReferenceをPresetの実ノードと接続へ置き換えます。",
                    },
                ),
                "scene_info": (SCENE_SAVE_INFO_TYPE, {"display_name": "メタ情報", "label": "メタ情報"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("画像", "保存先")
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "Scene/output"

    def save_images(
        self,
        images,
        path,
        metadata_mode=SAVE_METADATA_WORKFLOW,
        expand_preset_contents=False,
        scene_info=None,
        prompt=None,
        extra_pnginfo=None,
        unique_id=None,
    ):
        extension = "png"
        padding = 5
        info = _normalize_scene_save_info(scene_info)
        filename_prefix = _output_filename_prefix(info.get("filename_prefix", ""), extension, padding)
        base_root = folder_paths.get_output_directory()
        base_path_parts = _safe_relative_parts(path)
        scene_path_parts = _safe_relative_parts(info.get("path"))
        run_base_root = os.path.join(base_root, *base_path_parts)
        if info and not info.get("use_run_dir", True):
            run_parts = []
        else:
            run_parts = _safe_relative_parts(info.get("run_dir")) or _cached_run_parts(
                run_base_root, "auto", prompt, unique_id
            )
        run_root = os.path.join(run_base_root, *run_parts)
        output_dir = os.path.join(run_root, *scene_path_parts)
        os.makedirs(output_dir, exist_ok=True)

        if info.get("file_index"):
            counter = max(1, int(info["file_index"]))
        else:
            counter = _cached_next_index(run_root, extension, padding, filename_prefix)

        results = []
        saved_paths = []
        reservation_paths = []
        temp_paths = []
        preview_subfolder = _subfolder_for_preview(output_dir, self.output_dir)
        prompt_metadata = None
        extra_pnginfo_metadata = []
        if not args.disable_metadata:
            saved_prompt, saved_extra_pnginfo = _metadata_for_save_mode(
                prompt,
                extra_pnginfo,
                unique_id,
                metadata_mode,
                info,
                _scene_bool(expand_preset_contents, False),
            )
            if saved_prompt is not None:
                prompt_metadata = json.dumps(saved_prompt, separators=(",", ":"))
            if saved_extra_pnginfo is not None:
                extra_pnginfo_metadata = [
                    (key, json.dumps(value, separators=(",", ":")))
                    for key, value in saved_extra_pnginfo.items()
                    if key != "prompt" or prompt_metadata is None
                ]

        try:
            for image in images:
                image_array = 255.0 * image.cpu().numpy()
                img = Image.fromarray(np.clip(image_array, 0, 255).astype(np.uint8))

                with _FILENAME_RESERVATION_LOCK:
                    output_path, reservation_path, filename, counter = _reserve_output_path(
                        output_dir, extension, padding, counter, filename_prefix
                    )
                reservation_paths.append(reservation_path)
                descriptor, temp_path = tempfile.mkstemp(prefix=".scene-save-", suffix=".tmp", dir=output_dir)
                os.close(descriptor)
                temp_paths.append(temp_path)
                metadata = None
                if not args.disable_metadata:
                    metadata = PngInfo()
                    if prompt_metadata is not None:
                        metadata.add_text("prompt", prompt_metadata)
                    for key, value in extra_pnginfo_metadata:
                        metadata.add_text(key, value)
                    if info:
                        relative_path = "/".join([*base_path_parts, *run_parts, *scene_path_parts])
                        scene_metadata = {
                            "positive": info.get("positive", ""),
                            "negative": info.get("negative", ""),
                            "seed": info.get("seed", 0),
                            "base_path": "/".join(base_path_parts),
                            "path": "/".join(scene_path_parts),
                            "run_relative_path": relative_path,
                            "full_path": relative_path,
                            "run_dir": "/".join(run_parts),
                            "filename_prefix": filename_prefix,
                            "file_index": counter,
                            "label": info.get("label", ""),
                            "row_index": info.get("row_index", 0),
                            "repeat_index": info.get("repeat_index", 0),
                            "repeat_count": info.get("repeat_count", 0),
                            "total_count": info.get("total_count", 0),
                        }
                        metadata.add_text("scene_info", json.dumps(scene_metadata, ensure_ascii=False, separators=(",", ":")))
                        if scene_metadata["positive"]:
                            metadata.add_text("scene_positive", scene_metadata["positive"])
                        if scene_metadata["negative"]:
                            metadata.add_text("scene_negative", scene_metadata["negative"])
                        metadata.add_text("scene_seed", str(scene_metadata["seed"]))
                img.save(temp_path, format="PNG", pnginfo=metadata, compress_level=self.compress_level)
                with Image.open(temp_path) as check:
                    check.verify()
                os.link(temp_path, output_path)
                os.unlink(temp_path)
                temp_paths.remove(temp_path)
                saved_paths.append(output_path)
                _remove_output_reservation(reservation_path)
                reservation_paths.remove(reservation_path)
                if preview_subfolder is not None:
                    preview_ref = {"filename": filename, "subfolder": preview_subfolder, "type": self.type}
                    results.append(preview_ref)
                counter += 1
        except Exception:
            for candidate in temp_paths:
                try:
                    os.unlink(candidate)
                except OSError:
                    pass
            for reservation_path in reservation_paths:
                _remove_output_reservation(reservation_path)
            for candidate in saved_paths:
                try:
                    os.unlink(candidate)
                except OSError:
                    pass
            raise

        _remember_next_index(run_root, extension, padding, counter, filename_prefix)

        return {"ui": {"images": results}, "result": (images, "\n".join(saved_paths))}
