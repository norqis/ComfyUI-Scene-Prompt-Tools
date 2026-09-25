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
from contextlib import contextmanager
from datetime import datetime

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import comfy.model_management
import folder_paths
from comfy.cli_args import args
from comfy_execution.graph_utils import GraphBuilder, is_link

from .prompt import (
    DEFAULT_SELECTED_JSON,
    SCENE_PROMPT_TYPE,
    _compose_prompt_parts,
    _delete_prompt_parts,
    _expand_prompt_parts,
    _join_unique,
    _merge_positive_negative_parts,
    _parse_selection_json,
    _prompt_override_key,
    _scene_prompt_change_key,
    _split_prompt,
)
from .plan import (
    MAX_SAFE_INTEGER,
    MIN_BATCH_SIZE,
    MIN_DIMENSION,
    MODEL_MODE_ILLUSTRIOUS,
    MODEL_MODE_ANIMA,
    MODEL_MODE_CHOICES,
    ScenePlanError,
    empty_row,
    item_for_normalized_plan,
    matrix_product,
    merge,
    multiply_count,
    normalize_plan,
    queue,
    transform,
    mark_prompt_passthrough,
    mark_prompt_whole,
    with_prompt_trace,
    with_source_node,
    append_callback,
)
from .runs import (
    claim_callback_attempt,
    get_run_plan_reference,
    get_run_delivery_context,
    get_run_prompt_reference,
    register_last_callback,
    require_run_context,
    set_run_plan_reference,
    set_run_prompt_reference,
)
from .callbacks import (
    CALLBACK_FAILURE_CONTINUE,
    CALLBACK_FAILURE_STOP,
    CALLBACK_FREQUENCY_EVERY,
    CALLBACK_FREQUENCY_FIRST,
    SCENE_CALLBACK_TYPE,
    SceneCallbackError,
    discord_callback,
    desktop_callback,
    dispatch_callback,
    request_callback,
)


MATRIX_LINE_TYPE = "SCENE_MATRIX_LINE"
COUNTER_POSITION_FIRST = "先頭"
COUNTER_POSITION_LAST = "最後"
COUNTER_POSITION_CHOICES = (COUNTER_POSITION_FIRST, COUNTER_POSITION_LAST)
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

PATH_DIRECTORY = "フォルダに分ける"
PATH_APPEND_TO_PREVIOUS = "前のフォルダ名に結合"
EXPAND_CALLBACK_TIMEOUT_SECONDS = 10
REVERSE_SCOPE_ALL = "全てのノード"
REVERSE_SCOPE_PREVIOUS = "直前のノード"
REVERSE_SCOPE_CHOICES = (REVERSE_SCOPE_ALL, REVERSE_SCOPE_PREVIOUS)
TEXT_SCOPE_ALL = "全てのノード"
TEXT_SCOPE_PREVIOUS = "直前のノードのみ"
TEXT_SCOPE_CHOICES = (TEXT_SCOPE_ALL, TEXT_SCOPE_PREVIOUS)
MODEL_WEIGHT_RE = re.compile(r"(:\s*)([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?=\s*\))")

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


def _expand_conversion_options(replace_underscores=None, convert_anima_weights=None):
    return (
        _scene_bool(replace_underscores, default=False),
        _scene_bool(convert_anima_weights, default=False),
    )


def _model_prompt_weight(weight):
    # Anima's forward conversion scales Illustrious 1.0..1.5 weights by 5x
    # around 1.0 and clamps at 3.0. Turning the option off never reverses text.
    value = float(weight)
    if 1.0 <= value <= 1.5:
        return min(3.0, 1.0 + ((value - 1.0) * 5.0))
    return value


def _convert_anima_prompt_weights(text):
    def replace(match):
        raw = float(match.group(2))
        converted = _model_prompt_weight(raw)
        if abs(converted - raw) < 0.0005:
            return match.group(0)
        return f"{match.group(1)}{converted:.3f}".rstrip("0").rstrip(".")

    return MODEL_WEIGHT_RE.sub(replace, str(text or ""))


def _format_expand_prompt(text, replace_underscores, convert_anima_weights):
    result = str(text or "")
    if convert_anima_weights:
        result = _convert_anima_prompt_weights(result)
    if replace_underscores:
        result = result.replace("_", " ")
    return result


def _normalize_reverse_scope(value):
    return REVERSE_SCOPE_PREVIOUS if str(value or "").strip() == REVERSE_SCOPE_PREVIOUS else REVERSE_SCOPE_ALL


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


def _workflow_link_parts(link):
    if isinstance(link, (list, tuple)) and len(link) >= 6:
        return link[0], str(link[1]), link[2], str(link[3]), link[4], link[5]
    if isinstance(link, dict):
        required = {"id", "origin_id", "origin_slot", "target_id", "target_slot", "type"}
        if required.issubset(link):
            return (
                link["id"], str(link["origin_id"]), link["origin_slot"],
                str(link["target_id"]), link["target_slot"], link["type"],
            )
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


def _prune_workflow_reroutes(workflow):
    """Remove reroute metadata that refers to links excluded from a workflow slice."""
    link_ids = {_workflow_link_id(link) for link in workflow.get("links", [])}
    extra = workflow.get("extra")
    link_extensions = extra.get("linkExtensions") if isinstance(extra, dict) else None
    valid_extensions = [
        extension for extension in link_extensions
        if isinstance(extension, dict) and extension.get("id") in link_ids
    ] if isinstance(link_extensions, list) else []

    reroute_lists = []
    if isinstance(workflow.get("reroutes"), list):
        reroute_lists.append((workflow, "reroutes"))
    if isinstance(extra, dict) and isinstance(extra.get("reroutes"), list):
        reroute_lists.append((extra, "reroutes"))

    retained_reroute_ids = set()
    for container, key in reroute_lists:
        reroutes = copy.deepcopy(container[key])
        by_id = {
            reroute.get("id"): reroute
            for reroute in reroutes
            if isinstance(reroute, dict) and reroute.get("id") is not None
        }
        needed = {
            extension.get("parentId")
            for extension in valid_extensions
            if extension.get("parentId") in by_id
        }
        for reroute in by_id.values():
            if isinstance(reroute.get("linkIds"), list):
                reroute["linkIds"] = [link_id for link_id in reroute["linkIds"] if link_id in link_ids]
                if reroute["linkIds"]:
                    needed.add(reroute["id"])
        pending = list(needed)
        while pending:
            parent_id = by_id[pending.pop()].get("parentId")
            if parent_id in by_id and parent_id not in needed:
                needed.add(parent_id)
                pending.append(parent_id)
        container[key] = [reroute for reroute in reroutes if reroute.get("id") in needed]
        retained_reroute_ids.update(needed)

    if isinstance(link_extensions, list):
        extra["linkExtensions"] = [
            extension for extension in valid_extensions
            if extension.get("parentId") in retained_reroute_ids
        ]


def _rewire_workflow_links_from_prompt(workflow, prompt):
    """Restore execution links that ComfyUI rewired around bypassed nodes."""
    if not isinstance(prompt, dict):
        return
    nodes = workflow["nodes"]
    links = workflow["links"]
    nodes_by_id = {_workflow_node_id(node): node for node in nodes}
    existing = {
        (parts[1], parts[2], parts[3], parts[4])
        for link in links
        if (parts := _workflow_link_parts(link)) is not None
    }
    numeric_link_ids = [
        link_id for link in links
        if isinstance((link_id := _workflow_link_id(link)), int) and not isinstance(link_id, bool)
    ]
    if isinstance(workflow.get("last_link_id"), int) and not isinstance(workflow["last_link_id"], bool):
        numeric_link_ids.append(workflow["last_link_id"])
    next_link_id = max(numeric_link_ids, default=0) + 1

    for target_id, prompt_node in prompt.items():
        target = nodes_by_id.get(str(target_id))
        if not isinstance(target, dict) or not isinstance(prompt_node, dict):
            continue
        target_inputs = target.get("inputs", [])
        if not isinstance(target_inputs, list):
            continue
        for input_name, value in prompt_node.get("inputs", {}).items():
            source_id = _prompt_link_source(value, target_id, input_name)
            if source_id is None or source_id not in nodes_by_id:
                continue
            source_slot = value[1]
            target_slot = next((
                index for index, slot in enumerate(target_inputs)
                if isinstance(slot, dict) and slot.get("name") == input_name
            ), None)
            if target_slot is None:
                continue
            key = (source_id, source_slot, str(target_id), target_slot)
            if key in existing:
                continue

            source = nodes_by_id[source_id]
            source_outputs = source.get("outputs", [])
            if not isinstance(source_outputs, list) or source_slot >= len(source_outputs):
                continue
            source_output = source_outputs[source_slot]
            target_input = target_inputs[target_slot]
            if not isinstance(source_output, dict) or not isinstance(target_input, dict):
                continue
            link_type = target_input.get("type") or source_output.get("type") or "*"
            links.append([
                next_link_id, source.get("id"), source_slot,
                target.get("id"), target_slot, link_type,
            ])
            if not isinstance(source_output.get("links"), list):
                source_output["links"] = []
            source_output["links"].append(next_link_id)
            target_input["link"] = next_link_id
            existing.add(key)
            next_link_id += 1
    previous_last_link_id = workflow.get("last_link_id", 0)
    if not isinstance(previous_last_link_id, int) or isinstance(previous_last_link_id, bool):
        previous_last_link_id = 0
    workflow["last_link_id"] = max(next_link_id - 1, previous_last_link_id)


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


def _slice_workflow_for_output(
    workflow, ancestor_ids, prompt=None, preserve_physical_ancestors=False, physical_prompt_ids=None,
):
    if not isinstance(workflow, dict):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow がノード定義ではありません。")
    workflow_nodes = workflow.get("nodes")
    if not isinstance(workflow_nodes, list):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow の nodes が不正です。")

    included_ids = set(ancestor_ids)
    if preserve_physical_ancestors:
        reverse_links = {}
        for link in workflow.get("links", []):
            parts = _workflow_link_parts(link)
            if parts is not None:
                reverse_links.setdefault(parts[3], []).append(parts[1])
        known_prompt_ids = set(physical_prompt_ids) if physical_prompt_ids is not None else set(ancestor_ids)
        pending = [(node_id, False) for node_id in included_ids]
        visited = set()
        while pending:
            node_id, through_physical_only = pending.pop()
            if (node_id, through_physical_only) in visited:
                continue
            visited.add((node_id, through_physical_only))
            for source_id in reverse_links.get(node_id, []):
                source_is_physical_only = source_id not in known_prompt_ids
                if source_is_physical_only:
                    if source_id not in included_ids:
                        included_ids.add(source_id)
                    pending.append((source_id, True))
                elif through_physical_only:
                    included_ids.add(source_id)

    included_nodes = [
        node
        for node in workflow_nodes
        if _workflow_node_id(node) in included_ids
    ]
    found_ids = {_workflow_node_id(node) for node in included_nodes}
    if not set(ancestor_ids).issubset(found_ids):
        missing = ", ".join(sorted(set(ancestor_ids) - found_ids))
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
    if not preserve_physical_ancestors:
        _rewire_workflow_links_from_prompt(result, prompt)
    if "reroutes" in workflow:
        result["reroutes"] = copy.deepcopy(workflow["reroutes"]) if isinstance(workflow["reroutes"], list) else []
    _prune_workflow_reroutes(result)

    workflow_groups = workflow.get("groups", [])
    if not isinstance(workflow_groups, list):
        raise ValueError("Scene Save Image の生成経路を保存できません: workflow の groups が不正です。")
    result["groups"] = [
        copy.deepcopy(group)
        for group in workflow_groups
        if any(_workflow_group_intersects_node(group, node) for node in included_nodes)
    ]
    return result


SCENE_NODE_TYPES = {
    "ScenePrompter", "ScenePrompterMerge", "ScenePrompterQueue", "ScenePrompterExpand",
    "ScenePromptCounter", "ScenePromptReverse", "ScenePromptDelete", "SceneMatrix", "ScenePath", "SceneEmptyLatent",
    "SceneApplyModel", "SceneApplyLora",
    "ScenePromptCallback",
    "ScenePresetInput", "ScenePresetOutput", "ScenePresetReference",
}


def _scene_source_id_list(scene_info):
    if not isinstance(scene_info, dict):
        return []
    values = scene_info.get("source_node_ids", [])
    return list(dict.fromkeys(str(value) for value in values if str(value).strip())) if isinstance(values, list) else []


def _scene_source_ids(scene_info):
    return set(_scene_source_id_list(scene_info))


_EXPAND_WORKFLOW_WIDGET_INDEX = {
    "current_index": 0,
    "seed_base": 2,
}


def _visible_scene_source_ids(prompt, source_aliases=None):
    """Return source ids represented by the complete prompt before slicing."""
    if not isinstance(prompt, dict):
        return set()
    aliases = source_aliases if isinstance(source_aliases, dict) else {}
    return {
        str(aliases.get(str(node_id), node_id))
        for node_id, node in prompt.items()
        if isinstance(node, dict) and node.get("class_type") in SCENE_NODE_TYPES
    }


def _replay_expand_values(scene_info, full_prompt, source_aliases=None, retained_source_ids=None):
    """Rebase an execution-path replay onto just the rows saved in the PNG."""
    if not isinstance(scene_info, dict):
        return None
    plan = scene_info.get("_plan_ref")
    rows = plan.get("rows") if isinstance(plan, dict) else None
    if not isinstance(rows, list):
        return None
    row_index = scene_info.get("row_index")
    repeat_index = scene_info.get("repeat_index")
    if type(row_index) is not int or type(repeat_index) is not int or row_index < 0 or repeat_index < 1:
        return None
    selected_sources = _scene_source_ids(scene_info) if retained_source_ids is None else retained_source_ids
    visible_sources = _visible_scene_source_ids(full_prompt, source_aliases)

    def is_retained(item):
        row = item.get("row") if isinstance(item, dict) else None
        source_ids = row.get("source_node_ids", []) if isinstance(row, dict) else []
        row_visible = {str(source_id) for source_id in source_ids if str(source_id) in visible_sources}
        return row_visible.issubset(selected_sources)

    if row_index >= len(rows) or not is_retained(rows[row_index]):
        return None
    new_index = repeat_index - 1
    for index, item in enumerate(rows):
        if index >= row_index:
            break
        if isinstance(item, dict) and is_retained(item):
            new_index += int(item.get("count", 0))
    seed_base = (int(scene_info.get("seed", 0)) - new_index) % SEED_MODULO
    return {
        "current_index": new_index,
        "seed_base": seed_base,
        "seed_base_literal": seed_base == 0,
    }


def _apply_replay_expand_values(prompt, workflow, scene_info, values, source_aliases=None):
    """Apply replay widgets only to the Expand that produced this image."""
    if not values or not isinstance(prompt, dict):
        return prompt, workflow
    aliases = source_aliases if isinstance(source_aliases, dict) else {}
    selected_sources = _scene_source_ids(scene_info)
    expand_ids = {
        str(node_id)
        for node_id, node in prompt.items()
        if isinstance(node, dict)
        and node.get("class_type") == "ScenePrompterExpand"
        and str(aliases.get(str(node_id), node_id)) in selected_sources
    }
    if not expand_ids:
        return prompt, workflow
    for node_id in expand_ids:
        inputs = prompt[node_id].setdefault("inputs", {})
        inputs.update(values)
    if not isinstance(workflow, dict):
        return prompt, workflow
    for node in workflow.get("nodes", []):
        if not isinstance(node, dict) or str(node.get("id")) not in expand_ids:
            continue
        if node.get("type") != "ScenePrompterExpand":
            continue
        widgets = node.get("widgets_values")
        if not isinstance(widgets, list):
            continue
        indexes = dict(_EXPAND_WORKFLOW_WIDGET_INDEX)
        # Preserve the saved layout: old model selector, conversion booleans,
        # counter position with a timeout, or the current fixed-timeout layout.
        if len(widgets) > 8 and (
            widgets[5] in COUNTER_POSITION_CHOICES
            or (widgets[5] is None and any(input.get("name") == "counter_position" for input in node.get("inputs", [])))
        ):
            # v0.5.9/10 has 10 widgets; the restored model selector, like the
            # older timeout widget, places the literal seed flag at index 10.
            indexes["seed_base_literal"] = 10 if len(widgets) > 10 else 9
        elif len(widgets) > 5 and (
            widgets[5] in (MODEL_MODE_ILLUSTRIOUS, MODEL_MODE_ANIMA)
            or (widgets[5] is None and any(input.get("name") == "model_mode" for input in node.get("inputs", [])))
        ):
            indexes["seed_base_literal"] = 8
        elif len(widgets) > 6 and type(widgets[5]) is bool and type(widgets[6]) is bool:
            indexes["seed_base_literal"] = 9
        for name, index in indexes.items():
            if index < len(widgets):
                widgets[index] = values[name]
    return prompt, workflow


def _text_replay_items(prompt, save_id, scene_info):
    """Resolve each executed text consumer against its own original plan."""
    result = {}
    for node_id in _prompt_ancestor_ids(prompt, save_id):
        node = prompt[node_id]
        if node.get("class_type") != "ScenePromptToText":
            continue
        run_handle = str((scene_info or {}).get("run_handle") or "")
        plan = get_run_plan_reference(run_handle, node_id) if run_handle else None
        if plan is None:
            raise ValueError(f"Scene Save Image の生成経路を保存できません: Scene Prompt To Text {node_id} の実行済み計画がありません。")
        item = _scene_prompt_item_for_index(None, int(scene_info["file_index"]) - 1, normalized=plan, strict=True)
        result[node_id] = {
            "_plan_ref": plan, "row_index": item["row_index"], "repeat_index": item["repeat_index"],
            "source_node_ids": item["row"].get("source_node_ids", []), "seed": scene_info["seed"],
        }
    return result


def _apply_text_replay_values(prompt, workflow, items, full_prompt, source_aliases=None):
    retained = _visible_scene_source_ids(prompt, source_aliases)
    workflow_nodes = {str(node.get("id")): node for node in (workflow or {}).get("nodes", [])}
    for node_id, info in items.items():
        if node_id not in prompt:
            continue
        values = _replay_expand_values(info, full_prompt, source_aliases, retained)
        if values is None:
            raise ValueError(f"Scene Prompt To Text {node_id} の再現用生成番号を算出できません。")
        prompt[node_id].setdefault("inputs", {}).update(values)
        widgets = workflow_nodes.get(node_id, {}).get("widgets_values")
        if isinstance(widgets, list):
            for name, index in (("current_index", 1), ("seed_base", 2), ("seed_base_literal", 3)):
                if index < len(widgets):
                    widgets[index] = values[name]


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


def _scene_prompt_input_names(node):
    class_type = node.get("class_type") if isinstance(node, dict) else ""
    if class_type == "ScenePrompterQueue":
        return SCENE_PROMPT_INPUT_NAMES
    if class_type == "ScenePrompterMerge":
        return ("scene_prompt1", "scene_prompt2")
    return ("scene_prompt",)


def _scene_prompt_input_links(prompt, node_id):
    node = prompt.get(str(node_id)) if isinstance(prompt, dict) else None
    inputs = node.get("inputs") if isinstance(node, dict) else None
    if not isinstance(inputs, dict):
        return ()
    return tuple(
        (name, source_id, value[1])
        for name in _scene_prompt_input_names(node)
        if (source_id := _prompt_link_source(inputs.get(name), str(node_id), name)) is not None
        for value in (inputs[name],)
    )


def _contract_superseded_model_sources(prompt, selected_scene_ids, protected_source_ids=()):
    """Keep the row-order effective Apply Model while preserving Scene routes."""
    selected_order = list(dict.fromkeys(str(node_id) for node_id in selected_scene_ids if str(node_id).strip()))
    selected = set(selected_order)
    if not isinstance(prompt, dict):
        return prompt, selected, {}

    model_ids = [
        node_id for node_id in selected_order
        if isinstance(prompt.get(node_id), dict) and prompt[node_id].get("class_type") == "SceneApplyModel"
    ]
    superseded = set(model_ids[:-1]) - set(protected_source_ids)

    replacements = {}

    def upstream_link(node_id, seen=None):
        if node_id in replacements:
            return replacements[node_id]
        seen = set() if seen is None else seen
        if node_id in seen:
            return None
        seen.add(node_id)
        links = _scene_prompt_input_links(prompt, node_id)
        if not links:
            replacements[node_id] = None
            return None
        _name, source_id, output_index = links[0]
        replacement = upstream_link(source_id, seen) if source_id in superseded else [source_id, output_index]
        replacements[node_id] = replacement
        return replacement

    for node_id in superseded:
        upstream_link(node_id)

    contracted = copy.deepcopy(prompt)
    for node_id, node in contracted.items():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for name in _scene_prompt_input_names(node):
            source_id = _prompt_link_source(inputs.get(name), node_id, name)
            if source_id not in replacements:
                continue
            replacement = replacements[source_id]
            if replacement is None:
                inputs.pop(name, None)
            else:
                inputs[name] = replacement
    return contracted, selected - superseded, replacements


def _sync_workflow_node_links(workflow):
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    links = workflow.get("links") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list) or not isinstance(links, list):
        return
    sources = {}
    targets = {}
    for link in links:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        link_id, source_id, source_slot, target_id, target_slot, _type = parts
        sources.setdefault((source_id, source_slot), []).append(link_id)
        targets[(target_id, target_slot)] = link_id
    for node in nodes:
        node_id = _workflow_node_id(node)
        if node_id is None:
            continue
        for index, slot in enumerate(node.get("inputs", []) if isinstance(node.get("inputs"), list) else []):
            if isinstance(slot, dict):
                slot["link"] = targets.get((node_id, index))
        for index, slot in enumerate(node.get("outputs", []) if isinstance(node.get("outputs"), list) else []):
            if isinstance(slot, dict) and isinstance(slot.get("links"), list):
                slot["links"] = list(sources.get((node_id, index), ()))


def _contract_superseded_model_workflow(workflow, replacements):
    if not replacements or not isinstance(workflow, dict):
        return workflow
    contracted = copy.deepcopy(workflow)
    links = contracted.get("links")
    if not isinstance(links, list):
        return contracted
    for link in links:
        parts = _workflow_link_parts(link)
        if parts is None or parts[1] not in replacements:
            continue
        replacement = replacements[parts[1]]
        if replacement is None:
            continue
        source_id, source_slot = replacement
        if isinstance(link, list):
            link[1], link[2] = source_id, source_slot
        elif isinstance(link, dict):
            link["origin_id"], link["origin_slot"] = source_id, source_slot
    _sync_workflow_node_links(contracted)
    return contracted


def _connected_expand_resource_outputs(prompt, unique_id):
    """Return connected MODEL, CLIP, and VAE outputs for an Expand node."""
    if not isinstance(prompt, dict) or unique_id is None:
        return set()
    source_id = str(unique_id)
    outputs = set()
    for node in prompt.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for value in inputs.values():
            if (
                isinstance(value, (list, tuple))
                and len(value) == 2
                and str(value[0]) == source_id
                and type(value[1]) is int
                and 5 <= value[1] <= 7
            ):
                outputs.add(value[1])
    return outputs


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

    if metadata_mode != SAVE_METADATA_PROMPT_ONLY and isinstance(scene_info, dict):
        run_handle = str(scene_info.get("run_handle") or "").strip()
        for expand_id in reversed(scene_info.get("source_node_ids", [])):
            cached_prompt = get_run_prompt_reference(run_handle, expand_id) if run_handle else None
            if cached_prompt is not None:
                prompt = _merge_cached_prompt(cached_prompt, prompt)
                break

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

    if metadata_mode == SAVE_METADATA_WORKFLOW and not expand_preset_contents:
        return prompt, extra_pnginfo

    text_replay_items = _text_replay_items(prompt, unique_id, scene_info) if metadata_mode == SAVE_METADATA_EXECUTION_PATH else {}
    text_source_ids = {source_id for info in text_replay_items.values() for source_id in _scene_source_ids(info)}

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
                (
                    isinstance(node, dict)
                    and node.get("type") == "ScenePresetReference"
                    and node.get("mode") not in {2, 4}
                )
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
        selected_source_ids = _scene_source_id_list(scene_info)
        selected_ids = [
            node_id
            for source_id in selected_source_ids
            for node_id, alias in source_aliases.items()
            if alias == source_id
        ]
        text_ids = {node_id for node_id, alias in source_aliases.items() if alias in text_source_ids}
        contracted_prompt, selected_ids, replacements = _contract_superseded_model_sources(
            expanded_prompt, selected_ids, text_ids,
        )
        selected_ids.update(text_ids)
        contracted_workflow = _contract_superseded_model_workflow(expanded_workflow, replacements)
        ancestor_ids = _selected_ancestor_ids(
            contracted_prompt, unique_id, scene_info, selected_ids
        )
        saved_prompt = _slice_prompt_to_ids(contracted_prompt, ancestor_ids)
        replay_values = _replay_expand_values(scene_info, expanded_prompt, source_aliases,
            _visible_scene_source_ids(saved_prompt, source_aliases) if text_replay_items else None)
        saved_extra = {
            key: value
            for key, value in expanded_extra.items()
            if key not in {"prompt", "workflow"}
        }
        saved_extra["workflow"] = _slice_workflow_for_output(
            contracted_workflow,
            ancestor_ids,
            saved_prompt,
            preserve_physical_ancestors=True,
            physical_prompt_ids=set(contracted_prompt),
        )
        _apply_replay_expand_values(
            saved_prompt, saved_extra["workflow"], scene_info, replay_values, source_aliases
        )
        _apply_text_replay_values(saved_prompt, saved_extra["workflow"], text_replay_items, expanded_prompt, source_aliases)
        return saved_prompt, saved_extra

    if metadata_mode == SAVE_METADATA_WORKFLOW:
        return prompt, extra_pnginfo

    selected_source_ids = _scene_source_id_list(scene_info)
    contracted_prompt, selected_sources, replacements = _contract_superseded_model_sources(
        prompt, selected_source_ids, text_source_ids,
    )
    selected_sources.update(text_source_ids)
    ancestor_ids = _selected_ancestor_ids(contracted_prompt, unique_id, scene_info, selected_sources)
    saved_prompt = _slice_prompt_to_ids(contracted_prompt, ancestor_ids)
    replay_values = _replay_expand_values(scene_info, prompt, retained_source_ids=
        _visible_scene_source_ids(saved_prompt) if text_replay_items else None)
    saved_extra = None
    if extra_pnginfo is not None:
        saved_extra = {
            key: value
            for key, value in extra_pnginfo.items()
            if key not in {"prompt", "workflow"}
        }
        if "workflow" in extra_pnginfo:
            saved_extra["workflow"] = _slice_workflow_for_output(
                _contract_superseded_model_workflow(extra_pnginfo["workflow"], replacements), ancestor_ids, saved_prompt
            )
    _apply_replay_expand_values(
        saved_prompt,
        saved_extra.get("workflow") if isinstance(saved_extra, dict) else None,
        scene_info,
        replay_values,
    )
    _apply_text_replay_values(saved_prompt, saved_extra.get("workflow") if isinstance(saved_extra, dict) else None,
                              text_replay_items, prompt)
    return saved_prompt, saved_extra


def _merge_cached_prompt(cached_prompt, current_prompt):
    """Restore cached upstream nodes without reverting this iteration's widgets."""
    if not isinstance(cached_prompt, dict):
        return current_prompt
    restored = copy.deepcopy(cached_prompt)
    if not isinstance(current_prompt, dict):
        return restored
    for node_id, current_node in current_prompt.items():
        previous = restored.get(node_id)
        if not isinstance(previous, dict) or not isinstance(current_node, dict):
            restored[node_id] = copy.deepcopy(current_node)
            continue
        merged = {**previous, **copy.deepcopy(current_node)}
        previous_inputs = previous.get("inputs") if isinstance(previous.get("inputs"), dict) else {}
        current_inputs = current_node.get("inputs") if isinstance(current_node.get("inputs"), dict) else {}
        merged["inputs"] = {**copy.deepcopy(previous_inputs), **copy.deepcopy(current_inputs)}
        restored[node_id] = merged
    return restored


def _latent_dimension(value, default=512):
    number = default if value is None else value
    if type(number) is not int:
        raise ScenePlanError("Scene Empty Latent width and height must be integers.")
    if number < MIN_DIMENSION or number % 8:
        raise ScenePlanError(f"Scene Empty Latent width and height must be multiples of 8 at least {MIN_DIMENSION}.")
    return number


def _latent_batch_size(value, default=1):
    number = default if value is None else value
    if type(number) is not int or number < MIN_BATCH_SIZE:
        raise ScenePlanError(f"Scene Empty Latent batch_size must be an integer at least {MIN_BATCH_SIZE}.")
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
            if plan["total_batches"] == 0:
                raise IndexError("生成計画に生成対象がありません。") from None
            raise IndexError(
                f"生成番号 {current_index} は生成計画の範囲外です。"
                "停止後の状態が残っている場合は、ワークフローを再実行してください。"
            ) from None
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
    prefix = _sanitize_filename_text(value)
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


def _counter_position(value):
    return value if value in COUNTER_POSITION_CHOICES else COUNTER_POSITION_LAST


def _sanitize_filename_text(value):
    return BAD_FILENAME_PREFIX_CHARS_RE.sub("_", unicodedata.normalize("NFC", str(value or "")))


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


def _output_filename_suffix(value, filename_prefix, extension, padding, counter=None):
    """Fit a Scene filename suffix after its already-stable prefix and counter."""
    raw_suffix = _sanitize_filename_text(value)
    if not raw_suffix:
        return ""
    counter_width = max(
        int(padding),
        len(str(MAX_SAFE_INTEGER)),
        len(str(counter)) if counter is not None else 0,
    )
    tail = f"{'9' * counter_width}.{extension}.scene-save-reservation"
    used_utf8, used_utf16 = _filename_units(f"{filename_prefix}{tail}")
    available_utf8 = 255 - used_utf8
    available_utf16 = 255 - used_utf16
    if available_utf8 <= 0 or available_utf16 <= 0:
        return ""
    candidate = raw_suffix
    candidate_utf8, candidate_utf16 = _filename_units(candidate)
    if candidate_utf8 <= available_utf8 and candidate_utf16 <= available_utf16:
        return raw_suffix

    digest = hashlib.sha256(raw_suffix.encode("utf-8")).hexdigest()[:8]
    kept = []
    used_utf8 = used_utf16 = 0
    for character in raw_suffix:
        char_utf8, char_utf16 = _filename_units(character)
        if used_utf8 + char_utf8 + 9 > available_utf8 or used_utf16 + char_utf16 + 9 > available_utf16:
            break
        kept.append(character)
        used_utf8 += char_utf8
        used_utf16 += char_utf16
    if not kept and 9 > available_utf8:
        return ""
    if not kept and 9 > available_utf16:
        return ""
    return f"{''.join(kept)}~{digest}"


def _output_filename_parts(filename_prefix, filename_suffix, extension, padding, counter, counter_position):
    prefix = _output_filename_prefix(filename_prefix, extension, padding, counter)
    suffix = _output_filename_suffix(filename_suffix, prefix, extension, padding, counter)
    counter_text = f"{counter:0{padding}d}"
    if _counter_position(counter_position) == COUNTER_POSITION_FIRST:
        return prefix, suffix, f"{prefix}{counter_text}{suffix}.{extension}"
    return prefix, suffix, f"{prefix}{suffix}{counter_text}.{extension}"


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


def _metadata_file_index(path, filename_prefix, counter_position):
    try:
        with Image.open(path) as image:
            scene_info = json.loads(image.text.get("scene_info", ""))
    except (OSError, ValueError, TypeError):
        return None
    value = scene_info.get("file_index") if isinstance(scene_info, dict) else None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_SAFE_INTEGER:
        return None
    stored_prefix = scene_info.get("filename_prefix")
    if (
        isinstance(stored_prefix, str)
        and stored_prefix.casefold() == filename_prefix.casefold()
        and scene_info.get("counter_position") == counter_position
    ):
        return value
    if (
        counter_position == COUNTER_POSITION_LAST
        and "filename_suffix" not in scene_info
        and "counter_position" not in scene_info
        and isinstance(stored_prefix, str)
        and stored_prefix.casefold().endswith(filename_prefix.casefold())
    ):
        return value
    return None


def _find_next_index(run_root, extension, padding, filename_prefix="", counter_position=COUNTER_POSITION_LAST):
    prefix = _output_filename_prefix(filename_prefix, extension, padding)
    counter_position = _counter_position(counter_position)
    extension_pattern = re.escape(extension)
    prefix_pattern = re.escape(prefix)
    if counter_position == COUNTER_POSITION_FIRST:
        patterns = [re.compile(rf"^{prefix_pattern}(\d{{5}}).*\.{extension_pattern}$", re.IGNORECASE)]
    else:
        patterns = [re.compile(rf"^.*(\d{{5}})\.{extension_pattern}$", re.IGNORECASE)]
    current_candidate = re.compile(rf"^{prefix_pattern}.*\.{extension_pattern}$", re.IGNORECASE)
    legacy_last_candidate = re.compile(rf"^.*{prefix_pattern}\d+\.{extension_pattern}$", re.IGNORECASE)
    highest = 0
    if os.path.isdir(run_root):
        for root, _dirs, files in os.walk(run_root):
            for filename in files:
                if not filename.lower().endswith(f".{extension.lower()}"):
                    continue
                if not current_candidate.match(filename) and (
                    counter_position != COUNTER_POSITION_LAST or not legacy_last_candidate.match(filename)
                ):
                    continue
                path = os.path.join(root, filename)
                metadata_index = _metadata_file_index(path, prefix, counter_position)
                if metadata_index is not None:
                    highest = max(highest, metadata_index)
                    continue
                for pattern in patterns:
                    match = pattern.match(filename)
                    if match:
                        value = int(match.group(1))
                        if 1 <= value <= MAX_SAFE_INTEGER:
                            highest = max(highest, value)
                        break
    return highest + 1


_RUN_DIR_CACHE = {}
_FILENAME_RESERVATION_LOCK = threading.Lock()


def _counter_state_paths(run_root, extension, padding, filename_prefix, counter_position=COUNTER_POSITION_LAST):
    components = (str(extension).lower(), str(int(padding)), str(filename_prefix).casefold())
    key = "\0".join((*components, _counter_position(counter_position)))
    # Existing output-side state must keep sharing the old version's lock.
    # A lone lock or state is sufficient to retain that namespace.
    legacy_digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    lock_path = os.path.join(run_root, f".scene-save-{legacy_digest}.lock")
    state_path = os.path.join(run_root, f".scene-save-{legacy_digest}.state")
    if os.path.exists(lock_path) or os.path.exists(state_path):
        return lock_path, state_path, (os.path.abspath(run_root), key)

    canonical_root = os.path.normcase(os.path.realpath(run_root))
    digest = hashlib.sha256(f"{canonical_root}\0{key}".encode("utf-8")).hexdigest()
    state_root = os.path.join(folder_paths.get_system_user_directory("scene_prompt_tools"), "output_counters")
    return (
        os.path.join(state_root, f".scene-save-{digest}.lock"),
        os.path.join(state_root, f".scene-save-{digest}.state"),
        (canonical_root, key),
    )


@contextmanager
def _counter_state_lock(lock_path):
    """Use a stable, one-byte advisory lock shared by independent ComfyUI processes."""
    with open(lock_path, "a+b") as lock_file:
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            lock_file.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _read_counter_state(state_path):
    try:
        with open(state_path, "r", encoding="ascii") as state_file:
            next_index = int(state_file.read().strip())
    except (FileNotFoundError, ValueError, OSError):
        return None
    return next_index if 1 <= next_index <= MAX_SAFE_INTEGER else None


def _counter_state_is_exhausted(state_path):
    try:
        with open(state_path, "r", encoding="ascii") as state_file:
            return int(state_file.read().strip()) == MAX_SAFE_INTEGER + 1
    except (FileNotFoundError, ValueError, OSError):
        return False


def _write_counter_state(state_path, next_index):
    descriptor, temp_path = tempfile.mkstemp(prefix=".scene-save-state-", suffix=".tmp", dir=os.path.dirname(state_path))
    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as state_file:
            state_file.write(str(next_index))
            state_file.flush()
            os.fsync(state_file.fileno())
        os.replace(temp_path, state_path)
    except Exception:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise


def _allocate_output_index(run_root, extension, padding, filename_prefix, requested_index=1, counter_position=COUNTER_POSITION_LAST):
    """Allocate a prefix-wide counter, independent of filename suffixes."""
    counter_position = _counter_position(counter_position)
    lock_path, state_path, _key = _counter_state_paths(run_root, extension, padding, filename_prefix, counter_position)
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    with _counter_state_lock(lock_path):
        state_index = _read_counter_state(state_path)
        if state_index is not None:
            counter = max(1, int(requested_index or 1), state_index)
            if counter > MAX_SAFE_INTEGER:
                raise ValueError("画像連番が上限に達しました。")
            _write_counter_state(state_path, counter + 1)
            return counter
        if _counter_state_is_exhausted(state_path):
            raise ValueError("画像連番が上限に達しました。")

    scanned_index = _find_next_index(run_root, extension, padding, filename_prefix, counter_position)
    with _counter_state_lock(lock_path):
        state_index = _read_counter_state(state_path)
        counter = max(1, int(requested_index or 1), scanned_index, state_index or 1)
        if counter > MAX_SAFE_INTEGER or _counter_state_is_exhausted(state_path):
            raise ValueError("画像連番が上限に達しました。")
        _write_counter_state(state_path, counter + 1)
        return counter


def _reserve_output_path(directory, extension, padding, counter, filename_prefix="", filename_suffix="", counter_position=COUNTER_POSITION_LAST):
    """Reserve one exact output name; callers allocate a fresh persistent counter on collision."""
    prefix, suffix, filename = _output_filename_parts(
        filename_prefix, filename_suffix, extension, padding, counter, counter_position,
    )
    path = os.path.join(directory, filename)
    reservation_path = f"{path}.scene-save-reservation"
    if os.path.exists(path):
        return None
    try:
        descriptor = os.open(reservation_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None
    except PermissionError as exc:
        if exc.errno == errno.EACCES and os.path.lexists(reservation_path):
            return None
        raise
    os.close(descriptor)
    if os.path.exists(path):
        try:
            os.unlink(reservation_path)
        except FileNotFoundError:
            pass
        return None
    return path, reservation_path, filename, counter, prefix, suffix


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
    info = {
        "run_dir": str(value.get("run_dir") or "").strip(),
        "use_run_dir": _scene_bool(use_run_dir),
        "path": str(value.get("path") or "").strip(),
        "filename_prefix": _safe_filename_prefix(value.get("filename_prefix")),
        "counter_position": _counter_position(value.get("counter_position")),
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
    # Old PNG metadata did not include a suffix. Keep that representation
    # intact so loading existing workflows remains byte-for-byte compatible.
    if "filename_suffix" in value:
        info["filename_suffix"] = _sanitize_filename_text(value.get("filename_suffix"))
    # The plan reference is process-local provenance for metadata slicing. It
    # must stay by reference here and is intentionally absent from PNG JSON.
    if isinstance(value.get("_plan_ref"), dict):
        info["_plan_ref"] = value["_plan_ref"]
    return info

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
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
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
        source_node_name="",
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
            ), source_node_id or unique_id, source_node_name),
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
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
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

    def apply_path(self, path_name, scene_prompt=None, path_mode=PATH_DIRECTORY, unique_id=None, source_node_id="", source_node_name=""):
        label = str(path_name or "").strip() or "Scene Path"
        plan = transform(
            scene_prompt,
            lambda row, _item: {**row, "path_parts": _append_path_part(row.get("path_parts", []), label, path_mode)},
        )
        return (with_source_node(mark_prompt_passthrough(plan), source_node_id or unique_id, source_node_name),)


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
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
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

    def queue(self, unique_id=None, source_node_id="", source_node_name="", **kwargs):
        return (with_source_node(queue([kwargs.get(name) for name in SCENE_PROMPT_INPUT_NAMES]), source_node_id or unique_id, source_node_name),)


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
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
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

    def merge(self, scene_prompt1=None, scene_prompt2=None, unique_id=None, source_node_id="", source_node_name=""):
        return (with_source_node(merge(scene_prompt1, scene_prompt2), source_node_id or unique_id, source_node_name),)


class ScenePromptReverse:
    DESCRIPTION = """scene_prompt のポジティブとネガティブを入れ替えます。
「全てのノード」は入力された最終prompt全体を反転し、「直前のノード」は直前のSceneノードが追加したprompt部分だけを反転します。Path、Count、Empty Latentなどpromptを変更しないノードが直前の場合はpromptを変更しません。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "reverse"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt", "label": "scene_prompt"}),
                "reverse_scope": (
                    list(REVERSE_SCOPE_CHOICES),
                    {"default": REVERSE_SCOPE_ALL, "display_name": "対象", "label": "対象"},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, scene_prompt, reverse_scope=REVERSE_SCOPE_ALL, **kwargs):
        del kwargs
        return "|".join([_scene_prompt_change_key(scene_prompt), _normalize_reverse_scope(reverse_scope)])

    def reverse(
        self,
        scene_prompt,
        reverse_scope=REVERSE_SCOPE_ALL,
        unique_id=None,
        source_node_id="",
        source_node_name="",
    ):
        scope = _normalize_reverse_scope(reverse_scope)

        def reverse_row(row, _item):
            input_positive = list(row.get("positive_parts", []))
            input_negative = list(row.get("negative_parts", []))
            if scope == REVERSE_SCOPE_PREVIOUS and isinstance(row.get("prompt_trace"), dict):
                trace = row["prompt_trace"]
                if trace.get("kind") == "passthrough":
                    positive_parts, negative_parts = input_positive, input_negative
                elif trace.get("kind") == "whole":
                    positive_parts, negative_parts = input_negative, input_positive
                else:
                    positive_parts, negative_parts = _merge_positive_negative_parts(
                        trace.get("before_positive_parts", []),
                        trace.get("before_negative_parts", []),
                        trace.get("added_negative_parts", []),
                        trace.get("added_positive_parts", []),
                    )
            else:
                positive_parts = input_negative
                negative_parts = input_positive
            next_row = {
                **row,
                "positive_parts": positive_parts,
                "negative_parts": negative_parts,
            }
            return with_prompt_trace(next_row, row, positive_parts, negative_parts, kind="whole")

        plan = transform(scene_prompt, reverse_row)
        return (with_source_node(plan, source_node_id or unique_id, source_node_name),)


class ScenePromptDelete:
    DESCRIPTION = "入力されたpromptから、指定したタグだけを削除します。ポジティブとネガティブは各側だけに適用し、重みや大文字小文字を無視して完全一致で削除します。候補の空欄と順序は保持します。"
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "delete"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("STRING", {"default": "", "multiline": True, "display_name": "ポジティブから削除"}),
                "negative": ("STRING", {"default": "", "multiline": True, "display_name": "ネガティブから削除"}),
            },
            "optional": {"scene_prompt": (SCENE_PROMPT_TYPE,)},
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
        }

    def delete(self, positive="", negative="", scene_prompt=None, unique_id=None, source_node_id="", source_node_name=""):
        keys = {
            "positive_parts": {_prompt_override_key(part) for part in _split_prompt(positive)},
            "negative_parts": {_prompt_override_key(part) for part in _split_prompt(negative)},
        }

        def delete_row(row, _item):
            return {**row, **{side: _delete_prompt_parts(row[side], values) for side, values in keys.items()}}

        plan = mark_prompt_passthrough(transform(scene_prompt, delete_row))
        return (with_source_node(plan, source_node_id or unique_id, source_node_name),)


class ScenePromptToText:
    DESCRIPTION = "現在の生成番号のpromptを通常の文字列として取り出します。対象を直前のノードの追加分だけに限定でき、候補はExpandと同じシードで確定します。"
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "to_text"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"scope": (TEXT_SCOPE_CHOICES, {"default": TEXT_SCOPE_ALL, "display_name": "対象"})},
            "optional": {
                "scene_prompt": (SCENE_PROMPT_TYPE,),
                "current_index": ("INT", {"default": 0, "min": 0, "max": MAX_SAFE_INTEGER, "hidden": True}),
                "seed_base": ("INT", {"default": 0, "min": 0, "max": SEED_MAX, "hidden": True}),
                "seed_base_literal": ("BOOLEAN", {"default": False, "hidden": True}),
            },
            "hidden": {
                "run_handle": ("STRING", {"default": "", "hidden": True}),
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, scene_prompt=None, scope=TEXT_SCOPE_ALL, current_index=0, seed_base=0, seed_base_literal=False, run_handle="", **kwargs):
        return "|".join([_scene_prompt_change_key(scene_prompt), scope, str(current_index),
                         _seed_change_key(seed_base), str(_scene_bool(seed_base_literal)), str(run_handle)])

    def to_text(self, scene_prompt=None, scope=TEXT_SCOPE_ALL, current_index=0, seed_base=0, seed_base_literal=False, run_handle="", unique_id=None):
        if scope not in TEXT_SCOPE_CHOICES:
            raise ValueError("Scene Prompt To Text の対象が不正です。")
        plan = _scene_run_plan(run_handle, scene_prompt, unique_id)
        item = _scene_prompt_item_for_index(None, current_index, normalized=plan, strict=True)
        row = item["row"]
        positive, negative = row.get("positive_parts", []), row.get("negative_parts", [])
        trace = row.get("prompt_trace")
        if scope == TEXT_SCOPE_PREVIOUS and isinstance(trace, dict):
            if trace["kind"] == "passthrough":
                positive, negative = [], []
            elif trace["kind"] == "delta":
                positive, negative = trace["added_positive_parts"], trace["added_negative_parts"]
        base_seed = int(seed_base) % SEED_MODULO if _scene_bool(seed_base_literal) else _auto_seed_base(seed_base)
        seed = (base_seed + item["global_index"]) % SEED_MODULO
        positive, negative = _merge_positive_negative_parts(
            _expand_prompt_parts(positive, seed, "positive"),
            _expand_prompt_parts(negative, seed, "negative"), [], [],
        )
        return _join_unique(positive, ", "), _join_unique(negative, ", ")


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
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
                "prompt_trace_kind": ("STRING", {"default": "", "hidden": True}),
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

    def count(
        self,
        scene_prompt=None,
        count=1,
        unique_id=None,
        source_node_id="",
        source_node_name="",
        prompt_trace_kind="",
    ):
        plan = multiply_count(scene_prompt, count)
        if prompt_trace_kind == "whole":
            plan = mark_prompt_whole(plan)
        return (with_source_node(plan, source_node_id or unique_id, source_node_name),)


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
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
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

    def apply_latent(self, scene_prompt=None, width=512, height=512, batch_size=1, unique_id=None, source_node_id="", source_node_name=""):
        latent = _normalize_latent_config({"width": width, "height": height, "batch_size": batch_size})
        plan = transform(scene_prompt, lambda row, _item: {**row, "latent": dict(latent)})
        return (with_source_node(mark_prompt_passthrough(plan), source_node_id or unique_id, source_node_name),)


class SceneApplyModel:
    DESCRIPTION = """接続されたMODEL、CLIP、VAEをScene経路へ設定します。scene_promptが未接続なら空のSceneから開始します。実体は選択されたSceneをExpandするときにだけ評価されます。同じ経路に複数ある場合は後段の設定を使います。"""
    CATEGORY = "Scene/model"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "apply_model"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"rawLink": True, "lazy": True}),
                "clip": ("CLIP", {"rawLink": True, "lazy": True}),
                "vae": ("VAE", {"rawLink": True, "lazy": True}),
            },
            "optional": {"scene_prompt": (SCENE_PROMPT_TYPE,)},
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, model, clip, vae, scene_prompt=None, **kwargs):
        del kwargs
        return "|".join([_scene_prompt_change_key(scene_prompt), repr(model), repr(clip), repr(vae)])

    def apply_model(self, model, clip, vae, scene_prompt=None, unique_id=None, source_node_id="", source_node_name=""):
        links = {"model": model, "clip": clip, "vae": vae}
        if not all(is_link(value) for value in links.values()):
            raise ValueError("Scene Apply ModelのMODEL、CLIP、VAEをすべて接続してください。")
        plan = transform(scene_prompt, lambda row, _item: {**row, "model_links": {key: list(value) for key, value in links.items()}})
        return (with_source_node(mark_prompt_passthrough(plan), source_node_id or unique_id, source_node_name),)


class SceneApplyLora:
    DESCRIPTION = """ComfyUIのmodels/lorasからLoRAを選び、対象のモデル種別を指定してScene経路へ追加します。Expandで選んだモデル種別に一致するLoRAだけが、経路の上流から順に適用されます。"""
    CATEGORY = "Scene/model"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "apply_lora"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_name": (folder_paths.get_filename_list("loras"),),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
                "strength_clip": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}),
            },
            "optional": {
                "scene_prompt": (SCENE_PROMPT_TYPE,),
                "model_mode": (MODEL_MODE_CHOICES, {"default": MODEL_MODE_ILLUSTRIOUS, "display_name": "モデル種別", "label": "モデル種別"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, lora_name, strength_model=1.0, strength_clip=1.0, scene_prompt=None, model_mode=MODEL_MODE_ILLUSTRIOUS, **kwargs):
        del kwargs
        return "|".join([_scene_prompt_change_key(scene_prompt), str(lora_name), str(float(strength_model)), str(float(strength_clip)), _normalize_model_mode(model_mode)])

    def apply_lora(self, lora_name, strength_model=1.0, strength_clip=1.0, scene_prompt=None, unique_id=None, source_node_id="", source_node_name="", model_mode=MODEL_MODE_ILLUSTRIOUS):
        name = str(lora_name or "").strip()
        if not name:
            raise ValueError("LoRAを選択してください。")
        descriptor = {"name": name, "strength_model": float(strength_model), "strength_clip": float(strength_clip), "model_mode": _normalize_model_mode(model_mode)}
        plan = transform(scene_prompt, lambda row, _item: {**row, "loras": [*row.get("loras", []), descriptor]})
        return (with_source_node(mark_prompt_passthrough(plan), source_node_id or unique_id, source_node_name),)


class ScenePromptCallbackDiscord:
    """Discord通知の設定を作ります。このノード単体では送信しません。"""
    DESCRIPTION = """Discord Webhook用の通知設定です。このノードは送信せず、Scene Prompt CallbackまたはScene Prompt Expandのcallback_*へ接続した実行時だけ通知されます。"""
    CATEGORY = "Scene/callback"
    RETURN_TYPES = (SCENE_CALLBACK_TYPE,)
    RETURN_NAMES = ("callback",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "webhook_url": ("STRING", {"default": "", "multiline": False, "display_name": "Webhook URL"}),
            "text": ("STRING", {"default": "", "multiline": True, "display_name": "本文"}),
        }, "optional": {
            "username": ("STRING", {"default": "", "multiline": False, "display_name": "ユーザー名"}),
        }}

    def build(self, webhook_url="", text="", username=""):
        return discord_callback(webhook_url, text, username)


class ScenePromptCallbackRequest:
    """HTTP通知の設定を作ります。このノード単体では送信しません。"""
    DESCRIPTION = """GETまたはPOSTのHTTP通知設定です。このノードは送信せず、Scene Prompt CallbackまたはScene Prompt Expandのcallback_*へ接続した実行時だけ通知されます。"""
    CATEGORY = "Scene/callback"
    RETURN_TYPES = (SCENE_CALLBACK_TYPE,)
    RETURN_NAMES = ("callback",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "method": (["GET", "POST"], {"default": "GET", "display_name": "Method"}),
            "url": ("STRING", {"default": "", "multiline": False, "display_name": "URL"}),
            "text": ("STRING", {"default": "", "multiline": True, "display_name": "本文"}),
            "body_type": (["text", "json"], {"default": "text", "display_name": "本文形式"}),
            "headers_json": ("STRING", {"default": "", "multiline": True, "display_name": "Headers JSON"}),
        }}

    def build(self, method="GET", url="", text="", body_type="text", headers_json=""):
        return request_callback(method, url, text, body_type, headers_json)


class ScenePromptCallbackDesktop:
    """デスクトップ通知の設定を作ります。このノード単体では表示しません。"""
    DESCRIPTION = """ComfyUIを開いているデスクトップへ通知する設定です。このノードは表示せず、Scene Prompt CallbackまたはScene Prompt Expandのcallback_*へ接続した実行時だけ通知を待ちます。"""
    CATEGORY = "Scene/callback"
    RETURN_TYPES = (SCENE_CALLBACK_TYPE,)
    RETURN_NAMES = ("callback",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "title": ("STRING", {"default": "", "multiline": False, "display_name": "タイトル"}),
            "text": ("STRING", {"default": "", "multiline": True, "display_name": "本文"}),
        }}

    def build(self, title="", text=""):
        return desktop_callback(title, text)


class ScenePromptCallback:
    """通知をScene計画へ記録し、Expandで送信します。"""
    DESCRIPTION = """Callback設定をScene計画へ追加します。Preview、計画作成、Preset保存では送信せず、Scene Prompt Expandが最終プロンプトを確定した後、画像生成前にだけ送信します。"""
    CATEGORY = "Scene/callback"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "apply_callback"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frequency": ([CALLBACK_FREQUENCY_FIRST, CALLBACK_FREQUENCY_EVERY], {"default": CALLBACK_FREQUENCY_FIRST, "display_name": "送信頻度"}),
            "timeout_seconds": ("INT", {"default": 10, "min": 1, "display_name": "タイムアウト秒"}),
            "failure_mode": ([CALLBACK_FAILURE_CONTINUE, CALLBACK_FAILURE_STOP], {"default": CALLBACK_FAILURE_CONTINUE, "display_name": "失敗時"}),
        }, "optional": {
            "callback": (SCENE_CALLBACK_TYPE, {"display_name": "callback"}),
            "scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt"}),
        }, "hidden": {
            "unique_id": "UNIQUE_ID",
            "source_node_id": ("STRING", {"default": "", "hidden": True}),
        }}

    def apply_callback(
        self,
        callback=None,
        frequency=CALLBACK_FREQUENCY_FIRST,
        timeout_seconds=10,
        failure_mode=CALLBACK_FAILURE_CONTINUE,
        scene_prompt=None,
        unique_id=None,
        source_node_id="",
    ):
        if callback is None:
            return (with_source_node(mark_prompt_passthrough(normalize_plan(scene_prompt)), source_node_id or unique_id),)
        if not isinstance(callback, dict):
            raise ValueError("Scene callback setting is invalid.")
        if frequency not in {CALLBACK_FREQUENCY_FIRST, CALLBACK_FREQUENCY_EVERY}:
            raise ValueError("Scene callback frequency is invalid.")
        if failure_mode not in {CALLBACK_FAILURE_CONTINUE, CALLBACK_FAILURE_STOP}:
            raise ValueError("Scene callback failure mode is invalid.")
        plan = append_callback(
            scene_prompt,
            source_node_id or unique_id,
            callback,
            frequency,
            timeout_seconds,
            failure_mode,
        )
        return (with_source_node(plan, source_node_id or unique_id),)


def _callback_prompts(positive_parts, negative_parts, seed, model_mode=None, replace_underscores=None, convert_anima_weights=None):
    positive_parts, negative_parts = _merge_positive_negative_parts(
        _expand_prompt_parts(positive_parts, seed, "positive"),
        _expand_prompt_parts(negative_parts, seed, "negative"),
        [], [],
    )
    positive = _join_unique(positive_parts, ", ")
    negative = _join_unique(negative_parts, ", ")
    replace_underscores, convert_anima_weights = _expand_conversion_options(
        replace_underscores, convert_anima_weights,
    )
    return (
        _format_expand_prompt(positive, replace_underscores, convert_anima_weights),
        _format_expand_prompt(negative, replace_underscores, convert_anima_weights),
    )


def _callback_names(row, source_ids):
    names = row.get("source_node_names", {})
    if not isinstance(names, dict):
        return ""
    return "_".join(str(names.get(str(node_id), "")).strip() for node_id in source_ids if str(names.get(str(node_id), "")).strip())


def _dispatch_row_callbacks(
    row, item, seed, model_mode, run_handle, all_positive, all_negative,
    desktop_context=None, replace_underscores=None, convert_anima_weights=None,
):
    replace_underscores, convert_anima_weights = _expand_conversion_options(
        replace_underscores, convert_anima_weights,
    )
    callbacks = row.get("callbacks", [])
    seen = set()
    for descriptor in callbacks if isinstance(callbacks, list) else []:
        if not isinstance(descriptor, dict):
            continue
        callback_id = str(descriptor.get("callback_node_id") or "").strip()
        if not callback_id or callback_id in seen:
            continue
        seen.add(callback_id)
        frequency = descriptor.get("frequency")
        if frequency == CALLBACK_FREQUENCY_FIRST and not claim_callback_attempt(run_handle, callback_id):
            continue
        current_ids = descriptor.get("current_source_node_ids", [])
        current_positive, current_negative = _callback_prompts(
            descriptor.get("current_positive_parts", []),
            descriptor.get("current_negative_parts", []),
            seed,
            model_mode,
            replace_underscores,
            convert_anima_weights,
        )
        values = {
            "current_positive": current_positive,
            "current_negative": current_negative,
            "all_positive": all_positive,
            "all_negative": all_negative,
            "current_node_names": _callback_names(row, current_ids),
            "all_node_names": _callback_names(row, row.get("source_node_ids", [])),
            "exec_current_count": int(item.get("global_index", 0)) + 1,
            "exec_total_count": int(item.get("total_batches", 0)),
            "exec_model": _normalize_model_mode(model_mode),
            "exec_replace_underscores": str(replace_underscores).lower(),
            "exec_anima_weights": str(convert_anima_weights).lower(),
            "exec_seed": seed,
        }
        try:
            dispatch_callback(descriptor.get("config"), values, descriptor.get("timeout_seconds", 10), desktop_context=desktop_context)
        except SceneCallbackError as exc:
            if descriptor.get("failure_mode") == CALLBACK_FAILURE_STOP:
                raise RuntimeError(f"Scene Callback failed: {exc}") from exc
            print(f"Scene Callback warning: {exc}")


def _dispatch_expand_callback(config, callback_id, timeout_seconds, failure_mode, values, run_handle, once=False, desktop_context=None):
    if config is None:
        return
    if not isinstance(config, dict):
        raise ValueError("Scene callback setting is invalid.")
    if once and not claim_callback_attempt(run_handle, callback_id):
        return
    try:
        dispatch_callback(config, values, timeout_seconds, desktop_context=desktop_context)
    except SceneCallbackError as exc:
        if failure_mode == CALLBACK_FAILURE_STOP:
            raise RuntimeError(f"Scene Callback failed: {exc}") from exc
        print(f"Scene Callback warning: {exc}")


def _current_prompt_id():
    try:
        from server import PromptServer
        return str(getattr(PromptServer.instance, "last_prompt_id", "") or "")
    except Exception:
        return ""


class ScenePromptExpand:
    DESCRIPTION = """Scene生成計画から、生成番号に対応する1件を取り出して展開します。\nポジティブ、ネガティブ、保存用メタ情報、シード、空の潜在画像を出力し、{A|B|C} 形式の候補もこの段階で開始シードを基準に確定します。\n連続生成では計画全体を1枚ずつ処理し、複数の実行要求は順番に実行されます。このノード自身は画像を保存しません。"""
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = ("STRING", "STRING", SCENE_SAVE_INFO_TYPE, "INT", "LATENT", "MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("ポジティブ", "ネガティブ", "メタ情報", "シード", "潜在画像", "MODEL", "CLIP", "VAE")
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
                "counter_position": (
                    COUNTER_POSITION_CHOICES,
                    {
                        "default": COUNTER_POSITION_LAST,
                        "display_name": "連番の位置",
                        "label": "連番の位置",
                    },
                ),
                "model_mode": (MODEL_MODE_CHOICES, {"default": MODEL_MODE_ILLUSTRIOUS, "display_name": "モデル種別", "label": "モデル種別"}),
                "scene_prompt": (
                    SCENE_PROMPT_TYPE,
                    {"display_name": "scene_prompt", "label": "scene_prompt"},
                ),
                "replace_underscores": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "_を空白に変換",
                        "label": "_を空白に変換",
                    },
                ),
                "convert_anima_weights": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "強調値をAnima向けに変換",
                        "label": "強調値をAnima向けに変換",
                    },
                ),
                "callback_first": (SCENE_CALLBACK_TYPE, {"display_name": "callback_first"}),
                "callback_each": (SCENE_CALLBACK_TYPE, {"display_name": "callback_each"}),
                "callback_last": (SCENE_CALLBACK_TYPE, {"display_name": "callback_last"}),
                "callback_failure_mode": ([CALLBACK_FAILURE_CONTINUE, CALLBACK_FAILURE_STOP], {"default": CALLBACK_FAILURE_CONTINUE, "display_name": "callback_failure_mode"}),
                "seed_base_literal": ("BOOLEAN", {"default": False, "hidden": True}),
            },
            "hidden": {
                "run_handle": ("STRING", {"default": "", "hidden": True}),
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
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
        counter_position=COUNTER_POSITION_LAST,
        scene_prompt=None,
        model_mode=MODEL_MODE_ILLUSTRIOUS,
        replace_underscores=None,
        convert_anima_weights=None,
        run_handle="",
        unique_id=None,
        prompt=None,
        callback_first=None,
        callback_each=None,
        callback_last=None,
        callback_timeout_seconds=10,
        callback_failure_mode=CALLBACK_FAILURE_CONTINUE,
        seed_base_literal=False,
    ):
        model_mode = _normalize_model_mode(model_mode)
        return "|".join(
            [
                _scene_prompt_change_key(scene_prompt),
                str(current_index),
                str(run_id or ""),
                _seed_change_key(seed_base),
                str(_scene_bool(seed_base_literal)),
                str(_scene_bool(timestamp_dir)),
                _safe_filename_prefix(prefix),
                _counter_position(counter_position),
                model_mode,
                str(_expand_conversion_options(replace_underscores, convert_anima_weights)),
            ]
        )

    def expand(
        self,
        current_index=0,
        run_id="",
        seed_base=0,
        timestamp_dir=True,
        prefix="",
        counter_position=COUNTER_POSITION_LAST,
        scene_prompt=None,
        model_mode=MODEL_MODE_ILLUSTRIOUS,
        replace_underscores=None,
        convert_anima_weights=None,
        run_handle="",
        unique_id=None,
        prompt=None,
        callback_first=None,
        callback_each=None,
        callback_last=None,
        callback_timeout_seconds=10,
        callback_failure_mode=CALLBACK_FAILURE_CONTINUE,
        seed_base_literal=False,
    ):
        model_mode = _normalize_model_mode(model_mode)
        separator = ", "
        if run_handle and unique_id is not None and isinstance(prompt, dict):
            set_run_prompt_reference(run_handle, unique_id, prompt)
        plan = _scene_run_plan(run_handle, scene_prompt, unique_id)
        item = _scene_prompt_item_for_index(None, current_index, normalized=plan, strict=True)
        row = item["row"]
        if row.get("model_links") is None and _connected_expand_resource_outputs(prompt, unique_id):
            raise ValueError(
                "Scene Prompt ExpandのMODEL、CLIP、VAE出力を使うには、同じScene経路にScene Apply Modelを接続してください。"
            )
        global_index = int(item.get("global_index", 0) or 0)
        base_seed = int(seed_base) % SEED_MODULO if _scene_bool(seed_base_literal) else _auto_seed_base(seed_base)
        seed = (base_seed + global_index) % SEED_MODULO
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
        replace_underscores, convert_anima_weights = _expand_conversion_options(
            replace_underscores, convert_anima_weights,
        )
        positive = _format_expand_prompt(positive, replace_underscores, convert_anima_weights)
        negative = _format_expand_prompt(negative, replace_underscores, convert_anima_weights)
        callback_values = {
            "current_positive": positive, "current_negative": negative,
            "all_positive": positive, "all_negative": negative,
            "current_node_names": _callback_names(row, row.get("source_node_ids", [])),
            "all_node_names": _callback_names(row, row.get("source_node_ids", [])),
            "exec_current_count": global_index + 1,
            "exec_total_count": int(item.get("total_batches", 0)),
            "exec_model": model_mode,
            "exec_replace_underscores": str(replace_underscores).lower(),
            "exec_anima_weights": str(convert_anima_weights).lower(),
            "exec_seed": seed,
        }
        callback_id = str(unique_id or "")
        desktop_context = get_run_delivery_context(run_handle)
        _dispatch_expand_callback(callback_first, f"{callback_id}:first", EXPAND_CALLBACK_TIMEOUT_SECONDS, callback_failure_mode, callback_values, run_handle, once=True, desktop_context=desktop_context)
        _dispatch_expand_callback(callback_each, f"{callback_id}:each", EXPAND_CALLBACK_TIMEOUT_SECONDS, callback_failure_mode, callback_values, run_handle, desktop_context=desktop_context)
        _dispatch_row_callbacks(
            row, item, seed, model_mode, run_handle, positive, negative,
            desktop_context=desktop_context,
            replace_underscores=replace_underscores,
            convert_anima_weights=convert_anima_weights,
        )
        if callback_last is not None and run_handle and global_index + 1 == int(item.get("total_batches", 0)):
            prompt_id = _current_prompt_id()
            register_last_callback(run_handle, callback_id, callback_last, callback_values, EXPAND_CALLBACK_TIMEOUT_SECONDS, callback_failure_mode, prompt_id, desktop_context)
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
            "filename_prefix": str(prefix or ""),
            "filename_suffix": "".join(str(part) for part in row.get("filename_parts", []) if str(part)),
            "counter_position": _counter_position(counter_position),
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
            "_plan_ref": plan,
        }

        model_links = row.get("model_links")
        if model_links is None:
            return (positive, negative, save_info, seed, latent, None, None, None)
        model = model_links["model"]
        clip = model_links["clip"]
        graph = GraphBuilder()
        selected_loras = [descriptor for descriptor in row.get("loras", []) if descriptor["model_mode"] == model_mode]
        for descriptor in selected_loras:
            loader = graph.node(
                "LoraLoader",
                model=model,
                clip=clip,
                lora_name=descriptor["name"],
                strength_model=descriptor["strength_model"],
                strength_clip=descriptor["strength_clip"],
            )
            model = loader.out(0)
            clip = loader.out(1)
        return {
            "result": (positive, negative, save_info, seed, latent, model, clip, model_links["vae"]),
            "expand": graph.finalize(),
        }



class SceneSaveImage:
    DESCRIPTION = """生成画像をComfyUIのoutputディレクトリ配下へPNGで保存します。\n保存パス、タイムスタンプディレクトリ、Scene Path で追加された階層を組み合わせ、必要なフォルダは保存時に作成されます。\nファイル名はExpandのプレフィックスを先頭に置き、5桁の連番とScene Prompt／Matrix名はExpandで選んだ順序で連結します。既存ファイルは上書きせず次の番号を使います。\nメタデータ保存は「ワークフロー全体」「生成経路ノードのみ」「プロンプトのみ」から選べます。プロンプトのみはドラッグでワークフローを復元できません。Presetの中身を展開すると、保存時に固定されたPresetを実ノードと接続へ置き換えます。"""
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
        filename_suffix = info.get("filename_suffix", "")
        counter_position = _counter_position(info.get("counter_position"))
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

        requested_index = max(1, int(info.get("file_index") or 1))

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
                while True:
                    counter = _allocate_output_index(
                        run_root, extension, padding, filename_prefix, requested_index, counter_position,
                    )
                    requested_index = counter + 1
                    with _FILENAME_RESERVATION_LOCK:
                        reserved = _reserve_output_path(
                            output_dir, extension, padding, counter, filename_prefix, filename_suffix, counter_position,
                        )
                    if reserved is None:
                        continue
                    output_path, reservation_path, filename, counter, effective_prefix, effective_suffix = reserved
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
                                "filename_prefix": effective_prefix,
                                "filename_suffix": effective_suffix,
                                "counter_position": counter_position,
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
                    try:
                        img.save(temp_path, format="PNG", pnginfo=metadata, compress_level=self.compress_level)
                        with Image.open(temp_path) as check:
                            check.verify()
                        os.link(temp_path, output_path)
                    except FileExistsError:
                        _remove_output_reservation(reservation_path)
                        reservation_paths.remove(reservation_path)
                        os.unlink(temp_path)
                        temp_paths.remove(temp_path)
                        continue
                    os.unlink(temp_path)
                    temp_paths.remove(temp_path)
                    saved_paths.append(output_path)
                    _remove_output_reservation(reservation_path)
                    reservation_paths.remove(reservation_path)
                    if preview_subfolder is not None:
                        preview_ref = {"filename": filename, "subfolder": preview_subfolder, "type": self.type}
                        results.append(preview_ref)
                    break
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

        return {"ui": {"images": results}, "result": (images, "\n".join(saved_paths))}
