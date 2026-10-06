import copy
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from types import MappingProxyType

from comfy_execution.graph_utils import GraphBuilder, is_link

from .llm_node import ScenePromptLLM
from .prompt import SCENE_PROMPT_TYPE, ScenePrompt
from .plan import mark_prompt_whole, seed_plan
from .storage import public_user_directory
from .nodes import (
    SceneEmptyLatent,
    SceneApplyModel,
    SceneApplyLora,
    SceneMatrix,
    ScenePath,
    ScenePromptMerge,
    ScenePromptQueue,
    ScenePromptCounter,
    ScenePromptReverse,
    ScenePromptDelete,
    ScenePromptToText,
    ScenePromptRandomRoute,
    ScenePromptRandomRouteOutput,
    ScenePromptCallback,
    ScenePromptCallbackDiscord,
    ScenePromptCallbackRequest,
    ScenePromptCallbackDesktop,
    _prune_workflow_reroutes,
)
from .runs import get_run_user_id, require_run_context
from .switches import (SCENE_SWITCHES_TYPE, switch_values as normalize_switch_values,
                       switch_binding, switch_names, switch_settings, resolve_switches,
                       selected_switch_input)


PRESET_SCHEMA_VERSION = 1
PRESET_FILE_SUFFIX = ".json"
PRESET_DIRECTORY_NAME = "scene_presets"
SAVE_METADATA_WORKFLOW = "ワークフロー全体"
PRESET_ID_RE = re.compile(r"^[0-9A-Za-z_-]+$")
_PRESET_LOCK = threading.RLock()
_PRESET_LIST_CACHE_LOCK = threading.RLock()
_PRESET_LIST_CACHE = {}
_PRESET_LIST_CACHE_GENERATION = 0
_PRESET_LIST_CACHE_TTL_SECONDS = 2.0
_RUN_SNAPSHOTS = OrderedDict()
_CANCELLED_RUNS = OrderedDict()
_RESOLVING_RUNS = {}
_CANCELLED_RUNS_TTL_SECONDS = 5 * 60

SAFE_NODE_CLASSES = {
    "ScenePrompter": ScenePrompt,
    "ScenePromptLLM": ScenePromptLLM,
    "SceneMatrix": SceneMatrix,
    "ScenePath": ScenePath,
    "ScenePrompterMerge": ScenePromptMerge,
    "ScenePromptCounter": ScenePromptCounter,
    "ScenePromptReverse": ScenePromptReverse,
    "ScenePromptDelete": ScenePromptDelete,
    "ScenePrompterQueue": ScenePromptQueue,
    "ScenePromptRandomRoute": ScenePromptRandomRoute,
    "ScenePromptRandomRouteOutput": ScenePromptRandomRouteOutput,
    "SceneEmptyLatent": SceneEmptyLatent,
    "SceneApplyLora": SceneApplyLora,
    "ScenePromptCallback": ScenePromptCallback,
    "ScenePromptCallbackDiscord": ScenePromptCallbackDiscord,
    "ScenePromptCallbackRequest": ScenePromptCallbackRequest,
    "ScenePromptCallbackDesktop": ScenePromptCallbackDesktop,
    "ScenePresetReference": None,
}
# ComfyUI serializes widget-input Primitive nodes as executable API nodes.  They
# are literal value sources for safe Scene inputs. Only PrimitiveBoolean is
# additionally allowed inside a saved Preset, for standard Switch controls.
SAFE_VALUE_NODE_CLASSES = {
    "PrimitiveInt": int,
    "PrimitiveFloat": float,
    "PrimitiveString": str,
    "PrimitiveStringMultiline": str,
    "PrimitiveBoolean": bool,
}
BOUNDARY_INPUT = "ScenePresetInput"
BOUNDARY_OUTPUT = "ScenePresetOutput"
BOUNDARY_CLASSES = {BOUNDARY_INPUT, BOUNDARY_OUTPUT}
WORKFLOW_NON_EXECUTION_TYPES = {"reroute", "note", "markdownnote", "comment", "group"}
LEGACY_PRESET_CLASS_TYPES = {
    "ScenePrompt": "ScenePrompter",
    "ScenePromptMerge": "ScenePrompterMerge",
    "ScenePromptQueue": "ScenePrompterQueue",
    "ScenePromptExpand": "ScenePrompterExpand",
}

DEFAULT_SOURCE_NODE_NAMES = {
    "ScenePrompter": "Scene Prompt",
    "ScenePromptLLM": "Scene Prompt (LLM)",
    "SceneMatrix": "Scene Matrix",
    "ScenePath": "Scene Path",
    "ScenePrompterMerge": "Scene Prompt Merge",
    "ScenePromptCounter": "Scene Prompt Count",
    "ScenePromptReverse": "Scene Prompt Reverse",
    "ScenePromptDelete": "Scene Prompt Delete",
    "ScenePrompterQueue": "Scene Prompt Queue",
    "ScenePromptRandomRoute": "Scene Prompt Random Route Input",
    "ScenePromptRandomRouteOutput": "Scene Prompt Random Route Output",
    "SceneEmptyLatent": "Scene Empty Latent",
    "SceneApplyModel": "Scene Apply Model",
    "SceneApplyLora": "Scene Apply LoRA",
    "ScenePresetReference": "Scene Preset Reference",
    "ScenePromptCallbackDesktop": "Scene Prompt Callback (Desktop)",
}


class ScenePresetError(ValueError):
    pass


class ScenePresetNotFoundError(ScenePresetError):
    pass


class ScenePresetResolutionError(ScenePresetError):
    def __init__(self, message, node_id=None):
        super().__init__(message)
        self.node_id = str(node_id) if node_id is not None else None


def preset_directory(user_id="default"):
    try:
        return public_user_directory(user_id) / PRESET_DIRECTORY_NAME
    except ValueError as exc:
        raise ScenePresetError("Preset保存先を利用できません。") from exc


def _clean_preset_id(value):
    preset_id = str(value or "").strip()
    if not PRESET_ID_RE.fullmatch(preset_id):
        raise ScenePresetError("preset_id は英数字、_、- だけで入力してください。")
    return preset_id


def _preset_path(preset_id, user_id="default"):
    return preset_directory(user_id) / f"{_clean_preset_id(preset_id)}{PRESET_FILE_SUFFIX}"


def _normalize_legacy_preset_ids(preset):
    normalized = copy.deepcopy(preset)
    graph = normalized.get("api_graph") if isinstance(normalized, dict) else None
    nodes = graph.get("output") if isinstance(graph, dict) else None
    if isinstance(nodes, dict):
        normalized["api_graph"] = {"output": nodes}
        for node in nodes.values():
            if not isinstance(node, dict):
                continue
            class_type = node.get("class_type")
            if class_type in LEGACY_PRESET_CLASS_TYPES:
                node["class_type"] = LEGACY_PRESET_CLASS_TYPES[class_type]

    workflow_nodes = ((normalized.get("workflow") or {}).get("nodes") if isinstance(normalized, dict) else None)
    if isinstance(workflow_nodes, list):
        for node in workflow_nodes:
            if not isinstance(node, dict):
                continue
            node_type = node.get("type")
            if node_type in LEGACY_PRESET_CLASS_TYPES:
                node["type"] = LEGACY_PRESET_CLASS_TYPES[node_type]
            properties = node.get("properties")
            if isinstance(properties, dict):
                search_name = properties.get("Node name for S&R")
                if search_name in LEGACY_PRESET_CLASS_TYPES:
                    properties["Node name for S&R"] = LEGACY_PRESET_CLASS_TYPES[search_name]
    return normalized


def _preset_directory_signature(directory):
    if not directory.exists():
        return ()
    signature = []
    for path in sorted(directory.glob(f"*{PRESET_FILE_SUFFIX}"), key=lambda item: item.name.lower()):
        try:
            stat = path.stat()
        except OSError:
            continue
        signature.append((path.name, stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


def _invalidate_preset_list_cache(user_id="default"):
    global _PRESET_LIST_CACHE_GENERATION
    with _PRESET_LIST_CACHE_LOCK:
        _PRESET_LIST_CACHE_GENERATION += 1
        _PRESET_LIST_CACHE.pop(str(user_id or "default"), None)


def _compact_matrix_json(value):
    if not isinstance(value, str):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return value
    sets = parsed.get("sets") if isinstance(parsed, dict) else None
    if not isinstance(sets, list):
        return value
    compact = []
    for index, line in enumerate(sets):
        if not isinstance(line, dict):
            return value
        name = str(line.get("name") or f"row-{index + 1}")
        compact.append({
            "row_id": str(line.get("row_id") or f"row-{index + 1}"),
            "name": name,
            "path_label": str(line.get("path_label") or name),
            "enabled": line.get("enabled", True) is not False,
        })
    return json.dumps({"version": 1, "sets": compact}, ensure_ascii=False, separators=(",", ":"))


def _compact_local_preset_json(serialized, local_memo=None):
    """Keep local occurrence schedules without transferring saved prompt text."""
    definitions = parse_llm_preset_overrides(serialized, local_memo)
    if not definitions:
        return "{}"
    compact = {}
    for path, definition in definitions.items():
        workflow = definition.get("workflow") or {}
        compact[path] = {
            "schema_version": definition.get("schema_version"),
            "scene_compact": True,
            "metadata": copy.deepcopy(definition["metadata"]),
            "api_graph": _compact_preset_list_graph(definition["api_graph"], local_memo),
            "workflow": {"nodes": [
                {key: node[key] for key in ("id", "mode") if key in node}
                for node in workflow.get("nodes", []) if isinstance(node, dict)
            ]},
        }
    return _canonical_json({"version": 1, "presets": compact})


def _compact_preset_list_graph(api_graph, local_memo=None):
    local_memo = {} if local_memo is None else local_memo
    nodes = api_graph.get("output") if isinstance(api_graph, dict) else None
    if not isinstance(nodes, dict):
        return copy.deepcopy(api_graph)
    compact_nodes = {}
    scalar_inputs = {
        "matrix_json", "batch_size", "count", "enable_downstream_count", "preset_id", "reverse_scope",
        "order_mode", "alternate_block_size", "downstream_count_mode",
        "weights_json", "preserve_join", "llm_presets_json",
        "switch_names_json", "switch_settings_json", "switch_values", "switch",
    }
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        inputs = {}
        for name, value in _node_inputs(node).items():
            if is_link(value):
                inputs[name] = copy.deepcopy(value)
            elif name in scalar_inputs or (name == "value" and node.get("class_type") == "PrimitiveBoolean"):
                if name == "matrix_json":
                    inputs[name] = _compact_matrix_json(value)
                elif name == "llm_presets_json":
                    inputs[name] = _compact_local_preset_json(value, local_memo)
                else:
                    inputs[name] = copy.deepcopy(value)
        compact_nodes[str(node_id)] = {"class_type": node.get("class_type"), "inputs": inputs}
        if node.get("class_type") == "ScenePromptLLM":
            compact_nodes[str(node_id)]["has_llm_input"] = bool(str(_node_inputs(node).get("description") or "").strip())
    return {"output": compact_nodes}


def _canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _content_hash(api_graph, workflow):
    content = {"api_graph": api_graph, "workflow": workflow}
    return hashlib.sha256(_canonical_json(content).encode("utf-8")).hexdigest()


def _api_graph_with_titles(api_graph, workflow):
    graph = copy.deepcopy(api_graph)
    titles = {
        str(node.get("id")): str(node.get("title") or "").strip()
        for node in workflow.get("nodes", [])
        if isinstance(node, dict) and node.get("id") is not None
    }
    for node_id, node in graph.get("output", {}).items():
        if isinstance(node, dict) and titles.get(str(node_id)):
            node["_meta"] = {"title": titles[str(node_id)]}
    return graph


def _read_json(path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise ScenePresetNotFoundError(f"Presetが見つかりません: {path.stem}") from None
    except json.JSONDecodeError as exc:
        raise ScenePresetError(f"Presetファイルを読み込めません: {path.stem}") from exc
    except OSError as exc:
        raise ScenePresetError(f"Presetファイルを読み込めません: {path.stem}") from exc


def _node_label(node_id, node):
    title = str(node.get("_meta", {}).get("title") or node.get("title") or "").strip()
    class_type = str(node.get("class_type") or "不明なノード")
    return f"{title or class_type} #{node_id}"


def _node_inputs(node):
    inputs = node.get("inputs")
    return inputs if isinstance(inputs, dict) else {}


def _source_node_name(node):
    inputs = _node_inputs(node)
    stored = inputs.get("source_node_name")
    if isinstance(stored, str) and stored.strip():
        return stored.strip()
    title = str(node.get("_meta", {}).get("title") or "").strip()
    if title:
        return title
    return DEFAULT_SOURCE_NODE_NAMES.get(str(node.get("class_type") or ""), "")


def _linked_nodes(node):
    for value in _node_inputs(node).values():
        if is_link(value):
            yield str(value[0])


def _linked_scene_nodes(node):
    raw_inputs = {"model", "clip", "vae"} if node.get("class_type") == "SceneApplyModel" else set()
    for name, value in _node_inputs(node).items():
        if name not in raw_inputs and is_link(value):
            yield str(value[0])


def _is_non_execution_workflow_node(node):
    node_type = str(node.get("type") or "").strip().lower()
    return node_type in WORKFLOW_NON_EXECUTION_TYPES


def _validate_workflow_nodes(workflow, api_nodes):
    workflow_nodes = workflow.get("nodes")
    if not isinstance(workflow_nodes, list):
        raise ScenePresetError("Presetの編集用ワークフローが不正です。")
    api_by_id = {}
    for node_id, api_node in api_nodes.items():
        normalized_id = str(node_id)
        if normalized_id in api_by_id:
            raise ScenePresetError(f"実行グラフのノードID #{normalized_id} が重複しています。")
        api_by_id[normalized_id] = api_node
    workflow_by_id = set()
    for node in workflow_nodes:
        if not isinstance(node, dict):
            raise ScenePresetError("編集用ワークフローのノード形式が不正です。")
        if _is_non_execution_workflow_node(node):
            continue
        node_id = node.get("id")
        node_type = str(node.get("type") or "不明なノード")
        normalized_id = str(node_id)
        if node_id is None:
            raise ScenePresetError(
                f"編集用ワークフローの {node_type} #{node_id} のIDが不正です。"
            )
        if normalized_id in workflow_by_id:
            raise ScenePresetError(f"編集用ワークフローのノードID #{normalized_id} が重複しています。")
        workflow_by_id.add(normalized_id)
        if normalized_id not in api_by_id:
            if node_type not in SAFE_NODE_CLASSES and node_type not in BOUNDARY_CLASSES:
                raise ScenePresetError(
                    f"編集用ワークフローの {node_type} #{node_id} はPreset内で使えません。"
                )
            continue
        api_type = str(api_by_id[normalized_id].get("class_type") or "不明なノード")
        if node_type != api_type:
            raise ScenePresetError(
                f"編集用ワークフローの {node_type} #{node_id} と実行グラフの {api_type} の種類が一致しません。"
            )


def _connected_preset_nodes(nodes, output_node_id):
    if not isinstance(nodes, dict) or not nodes:
        raise ScenePresetError("Presetの実行グラフがありません。")
    output_id = str(output_node_id or "").strip()
    output_node = nodes.get(output_id)
    if not isinstance(output_node, dict) or output_node.get("class_type") != BOUNDARY_OUTPUT:
        raise ScenePresetError("保存元のScene Preset Outputが見つかりません。")

    connected = set()
    stack = [output_id]
    while stack:
        node_id = stack.pop()
        if node_id in connected:
            continue
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            raise ScenePresetError(f"接続先 #{node_id} がありません。")
        connected.add(node_id)
        stack.extend(_linked_nodes(node))
    return {node_id: copy.deepcopy(node) for node_id, node in nodes.items() if str(node_id) in connected}


def _workflow_link_parts(link):
    if not isinstance(link, list) or len(link) < 4:
        return None
    return str(link[1]), str(link[3])


def _workflow_physical_ancestors(workflow, output_node_id):
    links = workflow.get("links")
    if not isinstance(links, list):
        return set()
    reverse_links = {}
    for link in links:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        source_id, target_id = parts
        reverse_links.setdefault(target_id, []).append(source_id)
    connected = set()
    stack = [str(output_node_id)]
    while stack:
        node_id = stack.pop()
        if node_id in connected:
            continue
        connected.add(node_id)
        stack.extend(reverse_links.get(node_id, ()))
    return connected


def _prune_workflow_node_links(nodes, links):
    link_ids = {link[0] for link in links if isinstance(link, list) and link}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for slot in node.get("inputs", []) if isinstance(node.get("inputs"), list) else []:
            if isinstance(slot, dict) and slot.get("link") not in link_ids:
                slot["link"] = None
        for slot in node.get("outputs", []) if isinstance(node.get("outputs"), list) else []:
            if isinstance(slot, dict) and isinstance(slot.get("links"), list):
                slot["links"] = [link_id for link_id in slot["links"] if link_id in link_ids]


def _connected_preset_workflow(workflow, node_ids, output_node_id):
    result = copy.deepcopy(workflow)
    if not isinstance(result.get("nodes"), list):
        raise ScenePresetError("Presetの編集用ワークフローが不正です。")
    connected = {str(node_id) for node_id in node_ids}
    connected.update(_workflow_physical_ancestors(result, output_node_id))
    result["nodes"] = [
        node for node in result["nodes"]
        if isinstance(node, dict) and (
            _is_non_execution_workflow_node(node) or str(node.get("id")) in connected
        )
    ]
    links = result.get("links")
    if isinstance(links, list):
        result["links"] = [
            link for link in links
            if isinstance(link, list)
            and len(link) >= 4
            and str(link[1]) in connected
            and str(link[3]) in connected
        ]
        _prune_workflow_node_links(result["nodes"], result["links"])
        _prune_workflow_reroutes(result)
    return result


def _validate_preset_graph(nodes):
    if not isinstance(nodes, dict) or not nodes:
        raise ScenePresetError("Presetの実行グラフがありません。")

    inputs = [(node_id, node) for node_id, node in nodes.items()
              if isinstance(node, dict) and node.get("class_type") == BOUNDARY_INPUT]
    outputs = [(node_id, node) for node_id, node in nodes.items()
               if isinstance(node, dict) and node.get("class_type") == BOUNDARY_OUTPUT]
    if len(inputs) != 1:
        raise ScenePresetError("Scene Preset Input は1個だけ必要です。")
    if len(outputs) != 1:
        raise ScenePresetError("Scene Preset Output は1個だけ必要です。")

    input_id, input_node = inputs[0]
    output_id, output_node = outputs[0]
    if any(is_link(value) for value in _node_inputs(input_node).values()):
        raise ScenePresetError(f"{_node_label(input_id, input_node)} に入力を接続しないでください。")
    output_link = _node_inputs(output_node).get("scene_prompt")
    if not is_link(output_link):
        raise ScenePresetError(f"{_node_label(output_id, output_node)} の scene_prompt が未接続です。")

    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            raise ScenePresetError(f"ノード #{node_id} の形式が不正です。")
        class_type = node.get("class_type")
        if class_type not in SAFE_NODE_CLASSES and class_type not in BOUNDARY_CLASSES and class_type not in {"ComfySwitchNode", "PrimitiveBoolean"}:
            raise ScenePresetError(f"{_node_label(node_id, node)} はPreset内で使えません。")
        for input_name, input_value in _node_inputs(node).items():
            if not is_link(input_value):
                continue
            source_id = str(input_value[0])
            source_type = nodes.get(source_id, {}).get("class_type")
            source_cls = ScenePresetInput if source_type == BOUNDARY_INPUT else SAFE_NODE_CLASSES.get(source_type)
            source_types = source_cls.RETURN_TYPES if source_cls else ("BOOLEAN",) if source_type == "PrimitiveBoolean" else (SCENE_PROMPT_TYPE,)
            allowed_slots = range(len(source_types))
            if type(input_value[1]) is not int or input_value[1] not in allowed_slots:
                message = "出力番号が不正です。" if nodes.get(source_id, {}).get("class_type") == "ScenePromptRandomRoute" else "出力0だけを接続してください。"
                raise ScenePresetError(
                    f"{_node_label(node_id, node)} の {input_name} は{message}"
                )
            if source_id not in nodes:
                raise ScenePresetError(f"{_node_label(node_id, node)} の接続先 #{source_id} がありません。")
            source_kind = source_types[input_value[1]]
            if source_kind in {"BOOLEAN", SCENE_SWITCHES_TYPE} or class_type == "ComfySwitchNode" or input_name == "enable_downstream_count" or class_type == "ScenePresetReference" and input_name == "switches":
                target_cls = ScenePresetReference if class_type == "ScenePresetReference" else SAFE_NODE_CLASSES.get(class_type)
                if target_cls and class_type != "SceneApplyLora":
                    schema = target_cls.INPUT_TYPES()
                    definition = next((fields[input_name] for fields in schema.values() if input_name in fields), (None,))
                    expected = definition[0] if isinstance(definition, tuple) else definition
                else:
                    expected = "BOOLEAN" if class_type == "ComfySwitchNode" and input_name == "switch" else SCENE_PROMPT_TYPE
                if source_kind != expected:
                    raise ScenePresetError(f"{_node_label(node_id, node)} の {input_name} の接続型が不正です。")

    ancestors = set()
    visiting = []
    visiting_set = set()
    stack = [(str(output_id), False)]
    while stack:
        node_id, leaving = stack.pop()
        if leaving:
            visiting.pop()
            visiting_set.remove(node_id)
            ancestors.add(node_id)
            continue
        if node_id in ancestors:
            continue
        if node_id in visiting_set:
            start = visiting.index(node_id)
            cycle = " -> ".join([*(f"#{item}" for item in visiting[start:]), f"#{node_id}"])
            raise ScenePresetError(f"Presetの接続が循環しています: {cycle}")
        visiting.append(node_id)
        visiting_set.add(node_id)
        stack.append((node_id, True))
        linked = list(_linked_nodes(nodes[node_id]))
        for source_id in reversed(linked):
            stack.append((source_id, False))
    if str(input_id) not in ancestors:
        raise ScenePresetError(
            f"{_node_label(input_id, input_node)} は Scene Preset Output へ接続されていません。"
        )
    return {
        "input_id": str(input_id),
        "output_id": str(output_id),
        "output_link": output_link,
    }


def _validate_literal_input(node_id, node, input_name, value, definition):
    declared_type, options = definition[0], definition[1] if len(definition) > 1 else {}
    label = f"{_node_label(node_id, node)} の {input_name}"
    if isinstance(declared_type, (list, tuple)):
        if value not in declared_type:
            raise ScenePresetResolutionError(f"{label} の値が不正です。", node_id)
        return
    if declared_type == "STRING":
        valid = isinstance(value, str)
    elif declared_type == "BOOLEAN":
        valid = isinstance(value, bool)
    elif declared_type == "INT":
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif declared_type == "FLOAT":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    else:
        return
    if not valid:
        if declared_type == "INT":
            raise ScenePresetResolutionError(f"{label} must be an integer.", node_id)
        raise ScenePresetResolutionError(f"{label} の型が不正です。", node_id)
    if declared_type in {"INT", "FLOAT"}:
        if "min" in options and value < options["min"]:
            raise ScenePresetResolutionError(f"{label} は最小値未満です。", node_id)
        if "max" in options and value > options["max"]:
            raise ScenePresetResolutionError(f"{label} は最大値を超えています。", node_id)


def _validate_preset_input_values(nodes):
    for node_id, node in nodes.items():
        class_type = node.get("class_type") if isinstance(node, dict) else None
        if class_type in {BOUNDARY_INPUT, "ComfySwitchNode", "PrimitiveBoolean"}:
            definitions = ({"switch_names_json": ("STRING",), "switch_values": (SCENE_SWITCHES_TYPE,)} if class_type == BOUNDARY_INPUT
                           else {"switch": ("BOOLEAN",), "on_true": (SCENE_PROMPT_TYPE,), "on_false": (SCENE_PROMPT_TYPE,)} if class_type == "ComfySwitchNode"
                           else {"value": ("BOOLEAN",)})
        else:
            definitions = None
        cls = (
            ScenePresetReference
            if class_type == "ScenePresetReference"
            else SAFE_NODE_CLASSES.get(class_type)
        )
        if cls is None and definitions is None:
            continue
        if definitions is None:
            declared = cls.INPUT_TYPES()
            definitions = {}
            for section in ("required", "optional", "hidden"):
                definitions.update(declared.get(section, {}))
        for input_name, value in _node_inputs(node).items():
            if input_name not in definitions:
                raise ScenePresetResolutionError(
                    f"{_node_label(node_id, node)} に未対応の入力 {input_name} があります。",
                    node_id,
                )
            if is_link(value):
                continue
            _validate_literal_input(node_id, node, input_name, value, definitions[input_name])
            try:
                if input_name == "switch_names_json":
                    switch_names(value)
                elif input_name == "switch_settings_json":
                    switch_settings(value)
                elif input_name == "switch_values":
                    switch_binding(value)
                elif input_name == "switches":
                    normalize_switch_values(value)
            except ValueError as exc:
                raise ScenePresetResolutionError(str(exc), node_id) from exc


def _validate_preset_runtime(nodes, user_id="default", preset_id=None):
    validation = _validate_preset_graph(nodes)
    _validate_preset_input_values(nodes)
    resolved = {}
    if preset_id is not None:
        clean_preset_id = _clean_preset_id(preset_id)
        resolved[clean_preset_id] = {
            "schema_version": PRESET_SCHEMA_VERSION,
            "metadata": {"preset_id": clean_preset_id, "name": clean_preset_id},
            "api_graph": {"output": nodes},
        }
    occurrences = {}
    local_memo = {}
    for reference_node_id, preset_id, _node in _find_references(nodes):
        if not preset_id:
            label = _node_label(reference_node_id, _node)
            if label == f"ScenePresetReference #{reference_node_id}":
                label = f"Scene Preset Reference #{reference_node_id}"
            raise ScenePresetResolutionError(
                f"{label} でPresetが選択されていません。",
                reference_node_id,
            )
        try:
            occurrences.update(prepare_preset_occurrences({reference_node_id: _node}, resolved, user_id, local_memo))
        except ScenePresetError as exc:
            raise ScenePresetResolutionError(str(exc), reference_node_id) from exc
    resolved = {**resolved, "__occurrences__": occurrences}
    output_link = validation["output_link"]
    result = _scene_node_value(nodes, output_link[0], resolved, set(), user_id=user_id)
    result = _output_value(nodes, output_link, result)
    _validate_random_route_connections(nodes, _effective_scene_closure(nodes, output_link[0]))
    if isinstance(result, dict) and result.get("random_guards"):
        raise ScenePresetError("Scene Prompt Random Route Input の分岐をPreset内のOutputまたはQueueで合流してください。")


def _preset_nodes(preset):
    if not isinstance(preset, dict) or preset.get("schema_version") != PRESET_SCHEMA_VERSION:
        raise ScenePresetError("Presetの形式が対応していません。")
    graph = preset.get("api_graph")
    if not isinstance(graph, dict) or not isinstance(graph.get("output"), dict):
        raise ScenePresetError("Presetの実行グラフが不正です。")
    return graph["output"]


def _validate_preset_payload(preset):
    metadata = preset.get("metadata") if isinstance(preset, dict) else None
    if not isinstance(metadata, dict):
        raise ScenePresetError("Presetのメタデータが不正です。")
    if preset.get("schema_version") != PRESET_SCHEMA_VERSION:
        raise ScenePresetError("Presetの形式が対応していません。")
    _clean_preset_id(metadata.get("preset_id"))
    expected_hash = _content_hash(preset.get("api_graph"), preset.get("workflow"))
    if str(metadata.get("sha256") or "") != expected_hash:
        raise ScenePresetError("Presetの内容が壊れているか、hashが一致しません。")

    normalized = _normalize_legacy_preset_ids(preset)
    normalized_metadata = normalized.get("metadata")
    if not isinstance(normalized_metadata, dict):
        raise ScenePresetError("Presetのメタデータが不正です。")
    normalized_metadata.pop("revision", None)
    workflow = normalized.get("workflow")
    if isinstance(workflow, dict):
        extra = workflow.get("extra")
        if isinstance(extra, dict):
            extra.pop("scene_preset_editor", None)
    normalized_metadata["sha256"] = _content_hash(
        normalized.get("api_graph"),
        normalized.get("workflow"),
    )
    preset.clear()
    preset.update(normalized)
    metadata = normalized_metadata
    name = str(metadata.get("name") or metadata.get("preset_id"))
    try:
        nodes = _preset_nodes(preset)
        _validate_workflow_nodes(preset.get("workflow"), nodes)
        return _validate_preset_graph(nodes)
    except ScenePresetError as exc:
        raise ScenePresetError(f"Preset「{name}」: {exc}") from exc


def load_preset(preset_id, user_id="default"):
    """Return an owned definition; callers share it only within their operation."""
    preset = _read_json(_preset_path(preset_id, user_id))
    _validate_preset_payload(preset)
    return preset


def save_preset(payload, user_id="default"):
    if not isinstance(payload, dict):
        raise ScenePresetError("保存内容が不正です。")
    preset_id = _clean_preset_id(payload.get("preset_id"))
    name = str(payload.get("name") or preset_id).strip() or preset_id
    output_node_id = str(payload.get("output_node_id") or "").strip()
    api_graph = payload.get("api_graph")
    workflow = payload.get("workflow")
    if not isinstance(api_graph, dict) or not isinstance(api_graph.get("output"), dict):
        raise ScenePresetError("Presetの実行グラフがありません。")
    if not isinstance(workflow, dict):
        raise ScenePresetError("Presetの編集用ワークフローがありません。")
    connected_nodes = _connected_preset_nodes(api_graph["output"], output_node_id)
    workflow = _connected_preset_workflow(workflow, connected_nodes, output_node_id)
    extra = workflow.get("extra")
    if isinstance(extra, dict):
        extra.pop("scene_preset_editor", None)
    api_graph = _api_graph_with_titles({"output": connected_nodes}, workflow)
    try:
        _validate_workflow_nodes(workflow, api_graph["output"])
        _validate_preset_graph(api_graph["output"])
    except ScenePresetError as exc:
        raise ScenePresetError(f"Preset「{name}」: {exc}") from exc
    path = _preset_path(preset_id, user_id)
    # The connected workflow/API builders already own these objects. Keep the
    # large hash, serialization and verification work outside the shared lock.
    saved = {
        "schema_version": PRESET_SCHEMA_VERSION,
        "metadata": {"preset_id": preset_id, "name": name, "sha256": _content_hash(api_graph, workflow)},
        "workflow": workflow,
        "api_graph": api_graph,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{preset_id}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(saved, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        _validate_preset_payload(_read_json(Path(temp_name)))
        with _PRESET_LOCK:
            try:
                # Serialize the dependency check with publication, so two
                # concurrent saves cannot create a reference cycle.
                _validate_preset_runtime(api_graph["output"], user_id, preset_id)
            except ScenePresetResolutionError as exc:
                raise ScenePresetResolutionError(f"Preset「{name}」: {exc}", exc.node_id) from exc
            except ScenePresetError as exc:
                raise ScenePresetError(f"Preset「{name}」: {exc}") from exc
            os.replace(temp_name, path)
            _invalidate_preset_list_cache(user_id)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return saved


def parse_llm_preset_overrides(serialized="{}", local_memo=None):
    """Parse once per operation-owned memo; retain no global JSON revisions."""
    serialized = str(serialized or "{}")
    if local_memo is not None and serialized in local_memo:
        return local_memo[serialized]
    try:
        payload = json.loads(serialized)
    except (ValueError, TypeError) as exc:
        raise ScenePresetError("LLM Preset customization JSON is invalid.") from exc
    if payload == {}:
        definitions = {}
    else:
        if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("presets"), dict):
            raise ScenePresetError("LLM Preset customization format is invalid.")
        definitions = payload["presets"]
    for path, preset in definitions.items():
        if not isinstance(path, str) or (path != "." and any(not part or part in {".", ".."} for part in path.split("/"))):
            raise ScenePresetError("LLM Preset customization path is invalid.")
        if not isinstance(preset, dict) or not isinstance(preset.get("metadata"), dict):
            raise ScenePresetError("LLM Preset customization definition is invalid.")
        if preset.get("scene_compact"):
            raise ScenePresetError("Compact Preset definitions must be loaded in full before saving or execution.")
        # Local editor changes are not a shared-file revision. Recompute the
        # content hash before applying the ordinary safe graph validation.
        preset["metadata"]["sha256"] = _content_hash(preset.get("api_graph"), preset.get("workflow"))
        validation = _validate_preset_payload(preset)
        _validate_preset_input_values(_preset_nodes(preset))
        preset["_validation"] = validation
    if local_memo is not None:
        local_memo[serialized] = definitions
    return definitions


def prepare_preset_occurrences(nodes, resolved=None, user_id="default", local_memo=None):
    """Resolve by reference path; inherited entries apply only to that subtree."""
    resolved = {} if resolved is None else resolved
    local_memo = {} if local_memo is None else local_memo
    occurrences = {}
    pending = list(reversed([(node_id, preset_id, node, {}, ()) for node_id, preset_id, node in _find_references(nodes)]))
    while pending:
        path, preset_id, reference, inherited, ancestors = pending.pop()
        preset_id = _clean_preset_id(preset_id)
        if preset_id in ancestors:
            raise ScenePresetError(f"Preset参照が循環しています: {' -> '.join((*ancestors, preset_id))}")
        overrides = {**inherited, **parse_llm_preset_overrides(_node_inputs(reference).get("llm_presets_json", "{}"), local_memo)}
        preset = overrides.get(".")
        if preset is None:
            if preset_id not in resolved:
                if not overrides:
                    _resolve_preset_tree(preset_id, resolved, [], user_id)
                else:
                    resolved[preset_id] = load_preset(preset_id, user_id)
            preset = resolved[preset_id]
        if str(preset["metadata"]["preset_id"]) != preset_id:
            raise ScenePresetError(f"LLM Preset customization identity mismatch: {path}")
        if "_validation" not in preset:
            preset["_validation"] = _validate_preset_graph(_preset_nodes(preset))
        occurrences[path] = preset
        for child_id, child_preset_id, child in _find_references(_preset_nodes(preset)):
            prefix = child_id + "/"
            subtree = {("." if key == child_id else key[len(prefix):]): value
                       for key, value in overrides.items() if key == child_id or key.startswith(prefix)}
            pending.append((f"{path}/{child_id}", child_preset_id, child, subtree, (*ancestors, preset_id)))
    return occurrences


def _find_references(nodes):
    references = []
    for node_id, node in nodes.items():
        if isinstance(node, dict) and node.get("class_type") == "ScenePresetReference":
            preset_id = str(_node_inputs(node).get("preset_id") or "").strip()
            references.append((str(node_id), preset_id, node))
    return references


def _workflow_references(workflow):
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list):
        return []
    references = []
    for node in nodes:
        if (
            not isinstance(node, dict)
            or node.get("type") != "ScenePresetReference"
            or node.get("mode") in {2, 4}
        ):
            continue
        values = node.get("widgets_values")
        preset_id = str(values[0] or "").strip() if isinstance(values, list) and values else ""
        references.append((str(node.get("id") or ""), preset_id, node))
    return references


def _needs_workflow_preset_snapshots(nodes, expand_node_id):
    """Only full-workflow saves connected to this run need canvas-only Presets."""
    for node in nodes.values():
        if not isinstance(node, dict) or node.get("class_type") != "SceneSaveImage":
            continue
        inputs = _node_inputs(node)
        if (
            inputs.get("metadata_mode") != SAVE_METADATA_WORKFLOW
            or inputs.get("expand_preset_contents") is not True
            or not is_link(inputs.get("images"))
        ):
            continue
        if expand_node_id is None:
            return True
        scene_info = inputs.get("scene_info")
        if is_link(scene_info) and str(scene_info[0]) == str(expand_node_id):
            return True
    return False


def _scene_prompt_closure(nodes, source_id):
    closure = {}
    visiting = set()
    frames = [(str(source_id), False)]
    while frames:
        node_id, exiting = frames.pop()
        if node_id in closure:
            continue
        if exiting:
            visiting.remove(node_id)
            closure[node_id] = nodes[node_id]
            continue
        if node_id in visiting:
            raise ScenePresetError(f"生成グラフのScene接続が循環しています: #{node_id}")
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            raise ScenePresetError(f"Sceneノード #{node_id} が見つかりません。")
        visiting.add(node_id)
        frames.append((node_id, True))
        for linked_id in reversed(list(_linked_scene_nodes(node))):
            frames.append((str(linked_id), False))
    return closure


def _output_value(nodes, link, result):
    kind = nodes.get(str(link[0]), {}).get("class_type")
    slots = range(12) if kind == BOUNDARY_INPUT else range(10) if kind == "ScenePromptRandomRoute" else range(2) if kind == "ScenePromptToText" else (0,)
    if type(link[1]) is not int or link[1] not in slots:
        raise ScenePresetError(f"ノード #{link[0]} の出力番号が不正です。")
    return result[link[1]] if kind in {BOUNDARY_INPUT, "ScenePromptRandomRoute", "ScenePromptToText"} else result


def _switch_bindings(input_values):
    return {node_id: result[11] for node_id, result in (input_values or {}).items()
            if isinstance(result, tuple) and len(result) == 12}


def _effective_linked_nodes(nodes, node, bindings=None):
    if node.get("class_type") != "ComfySwitchNode":
        return list(_linked_scene_nodes(node))
    try:
        branch = selected_switch_input(nodes, node, bindings)
    except ValueError as exc:
        raise ScenePresetError(str(exc)) from exc
    return [str(value[0]) for name in ("switch", branch)
            for value in (_node_inputs(node).get(name),) if is_link(value)]


def _effective_scene_closure(nodes, source_id, bindings=None):
    """Selected Scene ancestry; the saved graph still retains physical branches."""
    closure = {}
    visiting = set()
    frames = [(str(source_id), False)]
    while frames:
        node_id, exiting = frames.pop()
        if node_id in closure:
            continue
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            raise ScenePresetError(f"Sceneノード #{node_id} が見つかりません。")
        if exiting:
            visiting.remove(node_id)
            closure[node_id] = node
            continue
        if node_id in visiting:
            raise ScenePresetError(f"生成グラフのScene接続が循環しています: #{node_id}")
        visiting.add(node_id)
        frames.append((node_id, True))
        frames.extend((item, False) for item in reversed(_effective_linked_nodes(nodes, node, bindings)))
    return closure


def _scene_nodes_for_expand(nodes, expand_node_id):
    if expand_node_id is None:
        return nodes, None

    expand_id = str(expand_node_id)
    expand = nodes.get(expand_id)
    if not isinstance(expand, dict):
        raise ScenePresetError(f"Scene Prompt Expand #{expand_id} が見つかりません。")
    if expand.get("class_type") != "ScenePrompterExpand":
        raise ScenePresetError(f"#{expand_id} は Scene Prompt Expand ではありません。")

    source = _node_inputs(expand).get("scene_prompt")
    if not is_link(source):
        return {}, None
    return _scene_prompt_closure(nodes, source[0]), source


def _validate_random_route_connections(nodes, scene_nodes):
    for node_id, node in scene_nodes.items():
        if node.get("class_type") != "ScenePromptRandomRoute":
            continue
        weights = ScenePromptRandomRoute.INPUT_TYPES()["required"]["weights_json"][1]["default"]
        raw = _node_inputs(node).get("weights_json", weights)
        from .nodes import _random_weights_json
        values = _random_weights_json(raw)
        connected = {
            value[1] for other in nodes.values() if isinstance(other, dict)
            for value in _node_inputs(other).values()
            if is_link(value) and str(value[0]) == str(node_id)
        }
        missing = [str(index + 1) for index, weight in enumerate(values) if weight and index not in connected]
        if missing:
            raise ScenePresetResolutionError(
                f"Scene Prompt Random Route Input #{node_id}: 出力{', '.join(missing)}が未接続です。",
                str(node_id),
            )


def _resolve_preset_tree(preset_id, resolved, stack, user_id="default"):
    """Resolve an arbitrarily large Preset DAG without Python recursion limits."""
    root_id = _clean_preset_id(preset_id)
    path = [_clean_preset_id(item) for item in stack]
    path_set = set(path)
    frames = [{"preset_id": root_id, "entered": False}]
    try:
        while frames:
            frame = frames[-1]
            current_id = frame["preset_id"]
            if current_id in resolved:
                frames.pop()
                continue
            if not frame["entered"]:
                if current_id in path_set:
                    cycle = " -> ".join([*path, current_id])
                    raise ScenePresetError(f"Preset参照が循環しています: {cycle}")
                preset = load_preset(current_id, user_id)
                frame.update({
                    "entered": True,
                    "preset": preset,
                    "name": str(preset["metadata"].get("name") or current_id),
                    "references": iter(_find_references(_preset_nodes(preset))),
                })
                path.append(current_id)
                path_set.add(current_id)
            try:
                _node_id, nested_id, _node = next(frame["references"])
            except StopIteration:
                resolved[current_id] = frame["preset"]
                frames.pop()
                path_set.remove(path.pop())
                continue
            nested_id = _clean_preset_id(nested_id)
            if nested_id not in resolved:
                frames.append({"preset_id": nested_id, "entered": False})
    except ScenePresetError as exc:
        for frame in reversed(frames):
            if frame.get("entered"):
                exc = ScenePresetError(f"Preset「{frame['name']}」: {exc}")
        raise exc


def _purge_run_snapshots(now=None):
    current = time.monotonic() if now is None else now
    for key in [key for key, cancelled_at in _CANCELLED_RUNS.items()
                if key not in _RESOLVING_RUNS and current - cancelled_at >= _CANCELLED_RUNS_TTL_SECONDS]:
        _CANCELLED_RUNS.pop(key, None)


def _run_cache_key(run_id, user_id="default"):
    return str(user_id or "default"), str(run_id or "").strip()


def _assert_run_not_cancelled(run_id, user_id="default"):
    _purge_run_snapshots()
    if _run_cache_key(run_id, user_id) in _CANCELLED_RUNS:
        raise ScenePresetError(f"実行「{run_id}」はキャンセルされました。")


def _scene_node_value_impl(
    nodes,
    node_id,
    resolved,
    node_stack,
    input_values=None,
    user_id="default",
    run_handle="",
    memo=None,
    preset_stack=(),
    preset_value_memo=None,
):
    node_id = str(node_id)
    if input_values and node_id in input_values:
        return input_values[node_id]
    if node_id in node_stack:
        raise ScenePresetError(f"Sceneグラフが循環しています: #{node_id}")
    memo = {} if memo is None else memo
    if node_id in memo:
        return memo[node_id]
    node = nodes.get(node_id)
    if not isinstance(node, dict):
        raise ScenePresetError(f"Sceneノード #{node_id} が見つかりません。")
    class_type = node.get("class_type")
    next_stack = {*(node_stack or set()), node_id}

    def value(raw):
        if isinstance(raw, (list, tuple)) and len(raw) == 2 and nodes.get(str(raw[0]), {}).get("class_type") in {BOUNDARY_INPUT, "ScenePromptRandomRoute", "ScenePromptToText"} and not is_link(raw):
            raise ScenePresetError(f"ノード #{raw[0]} の出力番号が不正です。")
        if not is_link(raw):
            return raw
        result = _scene_node_value(
            nodes, raw[0], resolved, next_stack, input_values,
            user_id, run_handle, memo, preset_stack, preset_value_memo,
        )
        return _output_value(nodes, raw, result)

    if class_type in SAFE_VALUE_NODE_CLASSES:
        raw_value = _node_inputs(node).get("value")
        if is_link(raw_value):
            raise ScenePresetError(f"{_node_label(node_id, node)} の値入力は接続できません。")
        try:
            if class_type == "PrimitiveBoolean" and type(raw_value) is not bool:
                if preset_stack or str(raw_value).lower() not in {"true", "false"}:
                    raise ValueError(raw_value)
                result = str(raw_value).lower() == "true"
            else:
                result = SAFE_VALUE_NODE_CLASSES[class_type](raw_value)
            memo[node_id] = result
            return result
        except (TypeError, ValueError) as exc:
            raise ScenePresetError(f"{_node_label(node_id, node)} の値が不正です。") from exc
    if class_type == BOUNDARY_INPUT:
        result = ScenePresetInput().build(**_node_inputs(node))
        memo[node_id] = result
        return result
    if class_type == "ComfySwitchNode":
        branch = selected_switch_input(nodes, node, _switch_bindings(input_values))
        raw = _node_inputs(node).get(branch)
        if not is_link(raw):
            raise ScenePresetError(f"Switch の {branch} が未接続です。")
        memo[node_id] = value(raw)
        return memo[node_id]
    if class_type == "ScenePresetReference":
        preset_id = _clean_preset_id(_node_inputs(node).get("preset_id"))
        reference_path = "/".join(part for part in [*(part.split("@", 1)[1] for part in preset_stack), node_id] if part)
        preset = resolved.get("__occurrences__", {}).get(reference_path, resolved.get(preset_id))
        if not preset:
            raise ScenePresetError(f"Preset「{preset_id}」のスナップショットがありません。")
        upstream = value(_node_inputs(node).get("scene_prompt")) if is_link(_node_inputs(node).get("scene_prompt")) else None
        frozen = resolved.get("__switch_values__", {})
        if reference_path in frozen:
            effective = normalize_switch_values(frozen[reference_path])
        else:
            raw_switches = _node_inputs(node).get("switches")
            incoming = value(raw_switches) if raw_switches is not None else None
            effective = resolve_switches(incoming, _node_inputs(node).get("switch_settings_json", "[]"))
            frozen[reference_path] = effective
        result = mark_prompt_whole(_evaluate_preset_scene(
            preset,
            resolved,
            upstream,
            user_id,
            run_handle,
            preset_stack,
            preset_value_memo,
            node_id,
            effective,
        ))
        memo[node_id] = result
        return result
    if class_type == "ScenePromptToText" and not preset_stack:
        kwargs = {name: value(raw) for name, raw in _node_inputs(node).items()}
        kwargs["run_handle"] = ""
        kwargs["unique_id"] = None
        result = ScenePromptToText().to_text(**kwargs)
        memo[node_id] = result
        return result
    cls = SceneApplyModel if class_type == "SceneApplyModel" else SAFE_NODE_CLASSES.get(class_type)
    if cls is None:
        raise ScenePresetError(f"{_node_label(node_id, node)} はScene計画を計算できません。")
    if class_type == "SceneApplyModel":
        kwargs = {
            name: (raw if name in {"model", "clip", "vae"} else value(raw))
            for name, raw in _node_inputs(node).items()
        }
    else:
        kwargs = {name: value(raw) for name, raw in _node_inputs(node).items()}
    if class_type in {"ScenePrompter", "SceneMatrix"}:
        kwargs["run_handle"] = run_handle
    if class_type in SAFE_NODE_CLASSES and class_type not in {"ScenePromptCallbackDiscord", "ScenePromptCallbackRequest", "ScenePromptCallbackDesktop"}:
        path = "/".join(part.split("@", 1)[1] for part in preset_stack)
        kwargs.setdefault("source_node_id", f"{path}/{node_id}" if path else node_id)
        if class_type == "SceneApplyLora" and path:
            kwargs["source_node_id"] = f"{path}/{node_id}"
        if class_type != "ScenePromptCallback":
            kwargs.setdefault("source_node_name", _source_node_name(node))
    if class_type == "ScenePromptRandomRoute":
        path = "/".join(part.split("@", 1)[1] for part in preset_stack)
        kwargs.setdefault("source_node_id", f"{path}/{node_id}" if path else node_id)
    result = getattr(cls(), cls.FUNCTION)(**kwargs)
    memo[node_id] = result if class_type == "ScenePromptRandomRoute" else result[0]
    return memo[node_id]


def _scene_node_value(
    nodes,
    node_id,
    resolved,
    stack,
    input_values=None,
    user_id="default",
    run_handle="",
    memo=None,
    preset_stack=(),
    preset_value_memo=None,
):
    target_id = str(node_id)
    values = {} if memo is None else memo
    if input_values and target_id in input_values:
        return input_values[target_id]
    if target_id in values:
        return values[target_id]

    visiting = {str(item) for item in (stack or set())}
    frames = [(target_id, False)]
    while frames:
        current_id, exiting = frames.pop()
        if (input_values and current_id in input_values) or current_id in values:
            continue
        node = nodes.get(current_id) if isinstance(nodes, dict) else None
        if not isinstance(node, dict):
            raise ScenePresetResolutionError(
                f"Sceneノード #{current_id}: Sceneノード #{current_id} が見つかりません。",
                current_id,
            )
        if exiting:
            visiting.remove(current_id)
            try:
                _scene_node_value_impl(
                    nodes,
                    current_id,
                    resolved,
                    set(),
                    input_values,
                    user_id,
                    run_handle,
                    values,
                    preset_stack,
                    preset_value_memo,
                )
            except ScenePresetResolutionError:
                raise
            except (ScenePresetError, TypeError, ValueError, KeyError) as exc:
                message = str(exc).strip() or "入力が不正です。"
                raise ScenePresetResolutionError(
                    f"{_node_label(current_id, node)}: {message}",
                    current_id,
                ) from exc
            continue
        if current_id in visiting:
            raise ScenePresetResolutionError(
                f"{_node_label(current_id, node)}: Sceneグラフが循環しています: #{current_id}",
                current_id,
            )
        visiting.add(current_id)
        frames.append((current_id, True))
        try:
            dependencies = _effective_linked_nodes(nodes, node, _switch_bindings(input_values))
        except ScenePresetError as exc:
            raise ScenePresetResolutionError(f"{_node_label(current_id, node)}: {exc}", current_id) from exc
        for linked_id in reversed(dependencies):
            linked_id = str(linked_id)
            if (not input_values or linked_id not in input_values) and linked_id not in values:
                frames.append((linked_id, False))
    return values[target_id]


def _evaluate_preset_scene(
    preset,
    resolved,
    upstream,
    user_id="default",
    run_handle="",
    preset_stack=(),
    preset_value_memo=None,
    reference_node_id="",
    switches=None,
):
    vector = normalize_switch_values(switches)
    preset_id = str(preset["metadata"]["preset_id"])
    if preset_id in [part.split("@", 1)[0] for part in preset_stack]:
        cycle = " -> ".join([*(part.split("@", 1)[0] for part in preset_stack), preset_id])
        raise ScenePresetError(f"Preset参照が循環しています: {cycle}")
    preset_value_memo = {} if preset_value_memo is None else preset_value_memo
    upstream_key = upstream.get("change_key") if isinstance(upstream, dict) else None
    memo_key = (preset_id, upstream_key, str(reference_node_id), preset_stack, vector)
    if memo_key in preset_value_memo:
        return preset_value_memo[memo_key]
    validation = preset.get("_validation") or _validate_preset_graph(_preset_nodes(preset))
    nodes = _preset_nodes(preset)
    input_id = validation["input_id"]
    output_link = validation["output_link"]
    input_values = {input_id: (upstream if upstream is not None else seed_plan(), *vector, vector)}
    _validate_random_route_connections(nodes, _effective_scene_closure(nodes, output_link[0], {input_id: vector}))
    result = _scene_node_value(
        nodes,
        output_link[0],
        resolved,
        set(),
        input_values,
        user_id,
        run_handle,
        {},
        (*preset_stack, f"{preset_id}@{reference_node_id}"),
        preset_value_memo,
    )
    result = _output_value(nodes, output_link, result)
    preset_value_memo[memo_key] = result
    return result


def snapshot_presets_for_run(run_id, api_graph, expand_node_id=None, user_id="default", workflow=None):
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ScenePresetError("実行IDがありません。")
    nodes = api_graph.get("output") if isinstance(api_graph, dict) else None
    if not isinstance(nodes, dict):
        raise ScenePresetError("生成開始時のグラフを取得できませんでした。")
    scene_nodes, source = _scene_nodes_for_expand(nodes, expand_node_id)
    cache_key = _run_cache_key(run_id, user_id)
    with _PRESET_LOCK:
        _assert_run_not_cancelled(run_id, user_id)
        existing = _RUN_SNAPSHOTS.get(cache_key)
        if existing:
            existing["last_access"] = time.monotonic()
            _RUN_SNAPSHOTS.move_to_end(cache_key)
        else:
            _RESOLVING_RUNS[cache_key] = _RESOLVING_RUNS.get(cache_key, 0) + 1
    if existing:
        return copy.deepcopy(existing["response"])

    try:
        resolved = {}
        workflow_references = (
            _workflow_references(workflow)
            if _needs_workflow_preset_snapshots(nodes, expand_node_id)
            else []
        )
        references = _find_references(nodes)
        api_reference_ids = {node_id for node_id, _preset_id, _node in references}
        references.extend(reference for reference in workflow_references if reference[0] not in api_reference_ids)
        occurrences = {}
        local_memo = {}
        for reference_node_id, preset_id, node in references:
            if node.get("class_type") != "ScenePresetReference":
                values = node.get("widgets_values", [])
                node = {"class_type": "ScenePresetReference", "inputs": {"preset_id": preset_id,
                    "llm_presets_json": values[2] if len(values) > 2 else "{}"}}
            try:
                occurrences.update(prepare_preset_occurrences({reference_node_id: node}, resolved, user_id, local_memo))
            except ScenePresetError as exc:
                raise ScenePresetResolutionError(str(exc), reference_node_id) from exc
        evaluation_resolved = {**resolved, "__occurrences__": occurrences, "__switch_values__": {}}
        plan = (
            _scene_node_value(scene_nodes, source[0], evaluation_resolved, set(), user_id=user_id, run_handle=run_id, preset_value_memo={})
            if source is not None else seed_plan()
        )
        if source is not None:
            plan = _output_value(scene_nodes, source, plan)
        effective_nodes = _effective_scene_closure(nodes, source[0]) if source is not None else {}
        _validate_random_route_connections(nodes, effective_nodes)
        if plan["random_guards"]:
            guard = plan["random_guards"][-1]
            raise ScenePresetError(f"Scene Prompt Random Route Input {guard['gate_id']} の分岐をOutputまたはQueueで合流してください。")
        response = {
            "presets": [
                {
                    "preset_id": preset_id,
                    "name": preset["metadata"]["name"],
                    "sha256": preset["metadata"]["sha256"],
                }
                for preset_id, preset in resolved.items()
            ],
            "total_images": int(plan["stats"]["total_images"]),
            "total_batches": int(plan["stats"]["total_batches"]),
        }

        response["presets"].extend(
            {"preset_id": preset["metadata"]["preset_id"], "name": preset["metadata"]["name"],
             "sha256": preset["metadata"]["sha256"], "reference_path": path}
            for path, preset in occurrences.items() if preset is not resolved.get(preset["metadata"]["preset_id"])
        )
        snapshot = copy.deepcopy({
            "presets": resolved,
            "occurrences": occurrences,
            "switch_values": evaluation_resolved["__switch_values__"],
            "has_local_overrides": any(preset is not resolved.get(preset["metadata"]["preset_id"]) for preset in occurrences.values()),
            "response": response,
        })
        with _PRESET_LOCK:
            _assert_run_not_cancelled(run_id, user_id)
            existing = _RUN_SNAPSHOTS.get(cache_key)
            if existing:
                existing["last_access"] = time.monotonic()
                _RUN_SNAPSHOTS.move_to_end(cache_key)
            else:
                snapshot["last_access"] = time.monotonic()
                _RUN_SNAPSHOTS[cache_key] = snapshot
            _purge_run_snapshots()
        return copy.deepcopy(existing["response"]) if existing else response
    finally:
        with _PRESET_LOCK:
            remaining = _RESOLVING_RUNS.get(cache_key, 0) - 1
            if remaining > 0:
                _RESOLVING_RUNS[cache_key] = remaining
            else:
                _RESOLVING_RUNS.pop(cache_key, None)
            _purge_run_snapshots()


def release_scene_preset_snapshot(run_id, user_id="default"):
    with _PRESET_LOCK:
        run_id = str(run_id or "").strip()
        if not run_id:
            return False
        _purge_run_snapshots()
        cache_key = _run_cache_key(run_id, user_id)
        _CANCELLED_RUNS[cache_key] = time.monotonic()
        released = _RUN_SNAPSHOTS.pop(cache_key, None) is not None
        _purge_run_snapshots()
        return released


def _snapshot_preset(run_id, preset_id, user_id="default", reference_path=""):
    run_id = str(run_id or "").strip()
    with _PRESET_LOCK:
        cache_key = _run_cache_key(run_id, user_id)
        entry = _RUN_SNAPSHOTS.get(cache_key)
        if run_id:
            if not entry:
                raise ScenePresetError(f"実行「{run_id}」のPresetスナップショットがありません。")
            entry["last_access"] = time.monotonic()
            _RUN_SNAPSHOTS.move_to_end(cache_key)
            preset = entry.get("occurrences", {}).get(str(reference_path)) or entry["presets"].get(preset_id)
            if preset:
                return preset
            raise ScenePresetError(f"実行「{run_id}」にPreset「{preset_id}」は含まれていません。")
    return load_preset(preset_id, user_id)


def _peek_snapshot_preset(run_id, preset_id, user_id="default", reference_path=""):
    """Read a prepared snapshot without extending TTL or changing LRU order."""
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ScenePresetError("実行コンテキストがありません。画像生成を開始し直してください。")
    with _PRESET_LOCK:
        entry = _RUN_SNAPSHOTS.get(_run_cache_key(run_id, user_id))
        if not entry:
            raise ScenePresetError(f"実行「{run_id}」のPresetスナップショットがありません。")
        preset = entry.get("occurrences", {}).get(str(reference_path)) or entry["presets"].get(preset_id)
        if not preset:
            raise ScenePresetError(f"実行「{run_id}」にPreset「{preset_id}」は含まれていません。")
        return preset


def snapshot_presets_for_metadata(run_id, user_id="default"):
    """Return the immutable Preset payloads prepared for an active run."""
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ScenePresetError("実行コンテキストがありません。画像生成を開始し直してください。")
    with _PRESET_LOCK:
        entry = _RUN_SNAPSHOTS.get(_run_cache_key(run_id, user_id))
        if not entry:
            raise ScenePresetError(f"実行「{run_id}」のPresetスナップショットがありません。")
        occurrences = entry.get("occurrences", {})
        if entry.get("has_local_overrides") or entry.get("switch_values"):
            return MappingProxyType({**entry["presets"], "__occurrences__": occurrences,
                                     "__switch_values__": entry.get("switch_values", {})})
        return MappingProxyType(entry["presets"])


def list_presets(user_id="default"):
    directory = preset_directory(user_id)
    user_key = str(user_id or "default")
    while True:
        with _PRESET_LIST_CACHE_LOCK:
            generation = _PRESET_LIST_CACHE_GENERATION
            now = time.monotonic()
            for key, entry in list(_PRESET_LIST_CACHE.items()):
                if key != user_key and entry["expires"] <= now:
                    _PRESET_LIST_CACHE.pop(key)
        signature = _preset_directory_signature(directory)
        with _PRESET_LIST_CACHE_LOCK:
            if generation != _PRESET_LIST_CACHE_GENERATION:
                continue
            cached = _PRESET_LIST_CACHE.get(user_key)
            valid = cached and cached.get("signature") == signature and cached.get("expires", 0.0) > time.monotonic()
        if valid:
            return copy.deepcopy(cached["value"])

        presets = []
        errors = []
        local_memo = {}
        for filename, mtime_ns, size in signature:
            path = directory / filename
            try:
                preset = load_preset(path.stem, user_id)
                entry = {
                    "metadata": copy.deepcopy(preset["metadata"]),
                    "api_graph": _compact_preset_list_graph(preset["api_graph"], local_memo),
                }
                error = None
            except ScenePresetError as exc:
                entry = None
                error = {"preset_id": path.stem, "error": str(exc)}
            if entry is not None:
                presets.append(entry)
            if error is not None:
                errors.append(error)

        if signature != _preset_directory_signature(directory):
            continue
        value = {"presets": presets, "errors": errors}
        entry = {
            "signature": signature,
            "expires": time.monotonic() + _PRESET_LIST_CACHE_TTL_SECONDS,
            "value": copy.deepcopy(value),
        }
        with _PRESET_LIST_CACHE_LOCK:
            if generation != _PRESET_LIST_CACHE_GENERATION:
                continue
            _PRESET_LIST_CACHE[user_key] = entry
        return value


def _replace_link(value, input_id, upstream_link, graph):
    if not is_link(value):
        return value
    source_id, output_index = str(value[0]), value[1]
    if source_id == input_id:
        if output_index == 0 and upstream_link is not None:
            return upstream_link
        source = graph.lookup_node(input_id)
        if source is None:
            raise ScenePresetError("Scene Preset Inputを展開できません。")
        return source.out(output_index)
    source = graph.lookup_node(source_id)
    if source is None:
        raise ScenePresetError(f"Presetの接続先 #{source_id} が見つかりません。")
    return source.out(output_index)


def expand_preset_reference(
    preset_id,
    scene_prompt=None,
    run_handle="",
    _require_context=False,
    source_node_id="",
    source_node_name="",
    unique_id=None,
    llm_presets_json="{}",
    switches=None,
    switch_settings_json="[]",
):
    preset_id = _clean_preset_id(preset_id)
    reference_path = str(source_node_id or unique_id or "")
    if _require_context:
        user_id = require_run_context(run_handle)["user_id"]
        preset = _snapshot_preset(run_handle, preset_id, user_id, reference_path)
    elif run_handle:
        preset = _snapshot_preset(run_handle, preset_id, reference_path=reference_path)
    else:
        user_id = "default"
        resolved = {}
        reference = {"class_type": "ScenePresetReference", "inputs": {"preset_id": preset_id, "llm_presets_json": llm_presets_json}}
        occurrences = prepare_preset_occurrences({reference_path: reference}, resolved, user_id)
        preset = occurrences[reference_path]
    validation = preset.get("_validation") or _validate_preset_graph(_preset_nodes(preset))
    nodes = _preset_nodes(preset)
    input_id = validation["input_id"]
    output_id = validation["output_id"]
    if run_handle:
        snapshot_user = user_id if _require_context else "default"
        with _PRESET_LOCK:
            frozen = _RUN_SNAPSHOTS[_run_cache_key(run_handle, snapshot_user)].get("switch_values", {})
            effective = normalize_switch_values(frozen[reference_path]) if reference_path in frozen else resolve_switches(switches, switch_settings_json)
    else:
        effective = resolve_switches(switches, switch_settings_json)
    graph = GraphBuilder()
    reference_source_id = str(source_node_id or unique_id or "").strip()

    graph.node(BOUNDARY_INPUT, input_id, switch_values={"values": list(effective)},
               switch_names_json=_node_inputs(nodes[input_id]).get("switch_names_json", "[]"))
    for node_id, node in nodes.items():
        class_type = node.get("class_type")
        if class_type not in BOUNDARY_CLASSES:
            graph.node(class_type, str(node_id))

    for node_id, node in nodes.items():
        class_type = node.get("class_type")
        if class_type in BOUNDARY_CLASSES:
            continue
        target = graph.lookup_node(str(node_id))
        for name, value in _node_inputs(node).items():
            target.set_input(name, _replace_link(value, input_id, scene_prompt, graph))
        if class_type in (set(SAFE_NODE_CLASSES) - {"ScenePromptCallbackDiscord", "ScenePromptCallbackRequest", "ScenePromptCallbackDesktop"}) or class_type == "ScenePresetReference":
            target.set_input("source_node_id", f"{reference_source_id}/{node_id}" if reference_source_id else str(node_id))
            if class_type != "ScenePromptCallback":
                target.set_input("source_node_name", _source_node_name(node))
        if class_type in {"ScenePrompter", "SceneMatrix"}:
            target.set_input("run_handle", str(run_handle))
        if class_type == "ScenePresetReference":
            target.set_input("run_handle", str(run_handle))
            if not run_handle:
                child_path = f"{reference_path}/{node_id}"
                prefix = child_path + "/"
                subtree = {("." if path == child_path else path[len(prefix):]):
                           {key: value for key, value in definition.items() if key != "_validation"}
                           for path, definition in occurrences.items() if path == child_path or path.startswith(prefix)}
                target.set_input("llm_presets_json", _canonical_json({"version": 1, "presets": subtree}))

    output_link = validation["output_link"]
    result = _replace_link(output_link, input_id, scene_prompt, graph)
    if is_link(result) and str(result[0]) == output_id:
        raise ScenePresetError("Scene Preset Outputの接続が不正です。")
    marker = graph.node("ScenePromptCounter", "__scene_preset_source")
    marker.set_input("scene_prompt", result)
    marker.set_input("count", 1)
    marker.set_input("prompt_trace_kind", "whole")
    marker.set_input("source_node_id", reference_source_id)
    marker.set_input("source_node_name", str(source_node_name or ""))
    result = marker.out(0)
    return {"result": (result,), "expand": graph.finalize()}


class ScenePresetInput:
    DESCRIPTION = """Scene Presetの入口です。専用ワークフローではこのノードからScene変換グラフを始め、最後にScene Preset Outputへ接続します。保存したPresetを参照したとき、外側から渡されたscene_promptがここへ入ります。"""
    CATEGORY = "Scene/preset"
    RETURN_TYPES = (SCENE_PROMPT_TYPE, *("BOOLEAN",) * 10, SCENE_SWITCHES_TYPE)
    RETURN_NAMES = ("scene_prompt", *(f"switch_{index}" for index in range(1, 11)), "switches")
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {
            "switch_names_json": ("STRING", {"default": "[]", "hidden": True}),
            "switch_values": (SCENE_SWITCHES_TYPE, {"hidden": True}),
        }}

    def build(self, switch_names_json="[]", switch_values=None):
        switch_names(switch_names_json)
        vector = switch_binding(switch_values)
        return (seed_plan(), *vector, vector)


class ScenePresetOutput:
    DESCRIPTION = """Scene Presetの出口です。Scene Preset Inputから安全なScene変換ノードを通して接続し、保存ボタンでPresetを保存します。画像生成や保存はPreset内に置けません。"""
    CATEGORY = "Scene/preset"
    OUTPUT_NODE = True
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "passthrough"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset_id": ("STRING", {"default": "", "display_name": "Preset ID"}),
                "preset_name": ("STRING", {"default": "", "display_name": "表示名"}),
                "scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt"}),
            }
        }

    def passthrough(self, preset_id, preset_name, scene_prompt):
        del preset_id, preset_name
        return (scene_prompt,)


class ScenePresetReference:
    DESCRIPTION = """保存済みのScene Presetを参照します。画像生成を開始した時点のPreset内容を検証して固定し、その実行中は同じ内容を使います。Preset内のScene Matrix、Queue、Mergeなどは元のノードとして展開・実行されます。"""
    CATEGORY = "Scene/preset"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "expand"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset_id": ("STRING", {"default": "", "display_name": "Preset ID"}),
            },
            "optional": {
                "scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt", "rawLink": True}),
                "run_handle": ("STRING", {"default": "", "hidden": True}),
                "llm_presets_json": ("STRING", {"default": "{}", "hidden": True}),
                "switches": (SCENE_SWITCHES_TYPE,),
                "switch_settings_json": ("STRING", {"default": "[]", "hidden": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, preset_id="", scene_prompt=None, run_handle="", **kwargs):
        del scene_prompt
        user_id = get_run_user_id(run_handle)
        reference_path = str(kwargs.get("source_node_id") or kwargs.get("unique_id") or "")
        preset = _peek_snapshot_preset(run_handle, _clean_preset_id(preset_id), user_id, reference_path)
        metadata = preset["metadata"]
        with _PRESET_LOCK:
            frozen = _RUN_SNAPSHOTS[_run_cache_key(run_handle, user_id)].get("switch_values", {})
            vector = frozen[reference_path] if reference_path in frozen else resolve_switches(kwargs.get("switches"), kwargs.get("switch_settings_json", "[]"))
        return f"{metadata['preset_id']}:{metadata['sha256']}:{run_handle}:{tuple(vector)}"

    def expand(self, preset_id, scene_prompt=None, run_handle="", unique_id=None, source_node_id="", source_node_name="", llm_presets_json="{}", switches=None, switch_settings_json="[]"):
        return expand_preset_reference(
            preset_id,
            scene_prompt,
            run_handle,
            _require_context=True,
            source_node_id=source_node_id,
            source_node_name=source_node_name,
            unique_id=unique_id,
            llm_presets_json=llm_presets_json,
            switches=switches,
            switch_settings_json=switch_settings_json,
        )
