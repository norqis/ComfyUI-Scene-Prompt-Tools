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

from .prompt import SCENE_PROMPT_TYPE, ScenePrompt
from .plan import seed_plan
from .storage import public_user_directory
from .nodes import (
    SceneEmptyLatent,
    SceneMatrix,
    ScenePath,
    ScenePromptMerge,
    ScenePromptQueue,
    ScenePromptCounter,
)
from .runs import peek_run_context, require_run_context


PRESET_SCHEMA_VERSION = 1
PRESET_FILE_SUFFIX = ".json"
PRESET_DIRECTORY_NAME = "scene_presets"
SAVE_METADATA_WORKFLOW = "ワークフロー全体"
PRESET_ID_RE = re.compile(r"^[0-9A-Za-z_-]{1,80}$")
_PRESET_LOCK = threading.RLock()
_RUN_SNAPSHOTS = OrderedDict()
_CANCELLED_RUNS = OrderedDict()
_RESOLVING_RUNS = {}
_CANCELLED_RUNS_TTL_SECONDS = 5 * 60
_CANCELLED_RUNS_MAX_ENTRIES = 256
# Scene plan evaluation is intentionally direct and recursive. Keep the
# accepted graph size comfortably below the depth where coverage tracing can
# exhaust Python's stack, so the save-time limit remains a reliable contract.
MAX_PRESET_NODES = 128
MAX_PRESET_REFERENCE_DEPTH = 64
MAX_PRESET_REFERENCE_NODE_DEPTH = MAX_PRESET_NODES

SAFE_NODE_CLASSES = {
    "ScenePrompter": ScenePrompt,
    "SceneMatrix": SceneMatrix,
    "ScenePath": ScenePath,
    "ScenePrompterMerge": ScenePromptMerge,
    "ScenePromptCounter": ScenePromptCounter,
    "ScenePrompterQueue": ScenePromptQueue,
    "SceneEmptyLatent": SceneEmptyLatent,
    "ScenePresetReference": None,
}
# ComfyUI serializes widget-input Primitive nodes as executable API nodes.  They
# are only allowed while evaluating an outer Scene graph, never inside a saved
# Preset, and only as literal value sources for safe Scene inputs.
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


class ScenePresetError(ValueError):
    pass


class ScenePresetNotFoundError(ScenePresetError):
    pass


class ScenePresetConflictError(ScenePresetError):
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


def _linked_nodes(node):
    for value in _node_inputs(node).values():
        if is_link(value):
            yield str(value[0])


def _is_non_execution_workflow_node(node):
    node_type = str(node.get("type") or "").strip().lower()
    return node_type in WORKFLOW_NON_EXECUTION_TYPES


def _validate_workflow_nodes(workflow, api_nodes):
    workflow_nodes = workflow.get("nodes")
    if not isinstance(workflow_nodes, list):
        raise ScenePresetError("Presetの編集用ワークフローが不正です。")
    api_node_ids = {str(node_id) for node_id in api_nodes}
    for node in workflow_nodes:
        if not isinstance(node, dict):
            raise ScenePresetError("編集用ワークフローのノード形式が不正です。")
        if _is_non_execution_workflow_node(node):
            continue
        node_id = node.get("id")
        node_type = str(node.get("type") or "不明なノード")
        if node_id is None or str(node_id) not in api_node_ids:
            raise ScenePresetError(
                f"編集用ワークフローの {node_type} #{node_id} は実行グラフに含まれていません。"
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


def _connected_preset_workflow(workflow, node_ids):
    result = copy.deepcopy(workflow)
    if not isinstance(result.get("nodes"), list):
        raise ScenePresetError("Presetの編集用ワークフローが不正です。")
    connected = {str(node_id) for node_id in node_ids}
    result["nodes"] = [
        node for node in result["nodes"]
        if isinstance(node, dict) and str(node.get("id")) in connected
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
    return result


def _validate_preset_graph(nodes):
    if not isinstance(nodes, dict) or not nodes:
        raise ScenePresetError("Presetの実行グラフがありません。")
    if len(nodes) > MAX_PRESET_NODES:
        raise ScenePresetError(f"Presetのノード数は{MAX_PRESET_NODES}個までです。")

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
    if input_node is not None and _node_inputs(input_node):
        raise ScenePresetError(f"{_node_label(input_id, input_node)} に入力を接続しないでください。")
    output_link = _node_inputs(output_node).get("scene_prompt")
    if not is_link(output_link):
        raise ScenePresetError(f"{_node_label(output_id, output_node)} の scene_prompt が未接続です。")

    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            raise ScenePresetError(f"ノード #{node_id} の形式が不正です。")
        class_type = node.get("class_type")
        if class_type not in SAFE_NODE_CLASSES and class_type not in BOUNDARY_CLASSES:
            raise ScenePresetError(f"{_node_label(node_id, node)} はPreset内で使えません。")
        for input_name, input_value in _node_inputs(node).items():
            if not is_link(input_value):
                continue
            source_id = str(input_value[0])
            if type(input_value[1]) is not int or input_value[1] != 0:
                raise ScenePresetError(
                    f"{_node_label(node_id, node)} の {input_name} は出力0だけを接続してください。"
                )
            if source_id not in nodes:
                raise ScenePresetError(f"{_node_label(node_id, node)} の接続先 #{source_id} がありません。")

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
        cls = (
            ScenePresetReference
            if class_type == "ScenePresetReference"
            else SAFE_NODE_CLASSES.get(class_type)
        )
        if cls is None:
            continue
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
    node_budget = {"total": len(nodes)}
    for reference_node_id, preset_id, _node in _find_references(nodes):
        try:
            _resolve_preset_tree(preset_id, resolved, [], user_id, node_budget=node_budget)
        except ScenePresetError as exc:
            raise ScenePresetResolutionError(str(exc), reference_node_id) from exc
    _scene_node_value(nodes, validation["output_link"][0], resolved, set(), user_id=user_id)


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
    _clean_preset_id(metadata.get("preset_id"))
    revision = metadata.get("revision")
    if not isinstance(revision, int) or revision < 1:
        raise ScenePresetError("Presetのrevisionが不正です。")
    expected_hash = _content_hash(preset.get("api_graph"), preset.get("workflow"))
    if str(metadata.get("sha256") or "") != expected_hash:
        raise ScenePresetError("Presetの内容が壊れているか、hashが一致しません。")
    name = str(metadata.get("name") or metadata.get("preset_id"))
    try:
        nodes = _preset_nodes(preset)
        _validate_workflow_nodes(preset.get("workflow"), nodes)
        return _validate_preset_graph(nodes)
    except ScenePresetError as exc:
        raise ScenePresetError(f"Preset「{name}」: {exc}") from exc


def load_preset(preset_id, user_id="default"):
    path = _preset_path(preset_id, user_id)
    preset = _read_json(path)
    _validate_preset_payload(preset)
    return preset


def save_preset(payload, user_id="default"):
    if not isinstance(payload, dict):
        raise ScenePresetError("保存内容が不正です。")
    preset_id = _clean_preset_id(payload.get("preset_id"))
    name = str(payload.get("name") or preset_id).strip() or preset_id
    output_node_id = str(payload.get("output_node_id") or "").strip()
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None and (
        type(expected_revision) is not int or expected_revision < 1
    ):
        raise ScenePresetError("expected_revision は1以上の整数で指定してください。")
    api_graph = payload.get("api_graph")
    workflow = payload.get("workflow")
    if not isinstance(api_graph, dict) or not isinstance(api_graph.get("output"), dict):
        raise ScenePresetError("Presetの実行グラフがありません。")
    if not isinstance(workflow, dict):
        raise ScenePresetError("Presetの編集用ワークフローがありません。")
    connected_nodes = _connected_preset_nodes(api_graph["output"], output_node_id)
    workflow = _connected_preset_workflow(workflow, connected_nodes)
    api_graph = _api_graph_with_titles({**api_graph, "output": connected_nodes}, workflow)
    with _PRESET_LOCK:
        try:
            _validate_workflow_nodes(workflow, api_graph["output"])
            _validate_preset_graph(api_graph["output"])
            _validate_preset_runtime(api_graph["output"], user_id, preset_id)
        except ScenePresetResolutionError as exc:
            raise ScenePresetResolutionError(f"Preset「{name}」: {exc}", exc.node_id) from exc
        except ScenePresetError as exc:
            raise ScenePresetError(f"Preset「{name}」: {exc}") from exc

        path = _preset_path(preset_id, user_id)
        revision = 1
        if path.exists():
            existing = _read_json(path)
            _validate_preset_payload(existing)
            if expected_revision is not None and existing["metadata"]["revision"] != expected_revision:
                raise ScenePresetConflictError("Presetは別のタブで更新されています。再度開いてください。")
            revision = existing["metadata"]["revision"] + 1
        elif expected_revision is not None:
            raise ScenePresetConflictError("Presetは別のタブで削除されています。再度開いてください。")
        digest = _content_hash(api_graph, workflow)
        saved = {
            "schema_version": PRESET_SCHEMA_VERSION,
            "metadata": {
                "preset_id": preset_id,
                "name": name,
                "revision": revision,
                "sha256": digest,
            },
            "workflow": copy.deepcopy(workflow),
            "api_graph": copy.deepcopy(api_graph),
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
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return saved


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
        if not isinstance(node, dict) or node.get("type") != "ScenePresetReference":
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
        scene_info = inputs.get("scene_info")
        if not is_link(scene_info):
            continue
        if expand_node_id is None or str(scene_info[0]) == str(expand_node_id):
            return True
    return False


def _scene_prompt_closure(nodes, source_id):
    closure = {}
    visiting = set()

    def visit(node_id):
        node_id = str(node_id)
        if node_id in closure:
            return
        if node_id in visiting:
            raise ScenePresetError(f"生成グラフのScene接続が循環しています: #{node_id}")
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            raise ScenePresetError(f"Sceneノード #{node_id} が見つかりません。")
        visiting.add(node_id)
        for linked_id in _linked_nodes(node):
            visit(linked_id)
        visiting.remove(node_id)
        closure[node_id] = node

    visit(source_id)
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


def _resolve_preset_tree(preset_id, resolved, stack, user_id="default", node_depth=0, node_budget=None):
    preset_id = _clean_preset_id(preset_id)
    if len(stack) >= MAX_PRESET_REFERENCE_DEPTH:
        raise ScenePresetError(f"Preset参照の深さは{MAX_PRESET_REFERENCE_DEPTH}個までです。")
    if preset_id in stack:
        cycle = " -> ".join([*stack, preset_id])
        raise ScenePresetError(f"Preset参照が循環しています: {cycle}")
    preset = resolved.get(preset_id)
    if preset is None:
        preset = load_preset(preset_id, user_id)
    preset_name = str(preset["metadata"].get("name") or preset_id)
    budget = node_budget if node_budget is not None else {"total": node_depth}
    next_node_depth = budget["total"] + len(_preset_nodes(preset))
    if next_node_depth > MAX_PRESET_REFERENCE_NODE_DEPTH:
        raise ScenePresetError(
            f"Preset参照内の累積ノード数は{MAX_PRESET_REFERENCE_NODE_DEPTH}個までです。"
        )
    budget["total"] = next_node_depth
    next_stack = [*stack, preset_id]
    for _node_id, nested_id, _node in _find_references(_preset_nodes(preset)):
        try:
            _resolve_preset_tree(nested_id, resolved, next_stack, user_id, next_node_depth, budget)
        except ScenePresetError as exc:
            raise ScenePresetError(f"Preset「{preset_name}」: {exc}") from exc
    resolved[preset_id] = preset


def _purge_run_snapshots(now=None):
    current = time.monotonic() if now is None else now
    for key in [key for key, cancelled_at in _CANCELLED_RUNS.items()
                if key not in _RESOLVING_RUNS and current - cancelled_at >= _CANCELLED_RUNS_TTL_SECONDS]:
        _CANCELLED_RUNS.pop(key, None)
    while len(_CANCELLED_RUNS) > _CANCELLED_RUNS_MAX_ENTRIES:
        removable = next((key for key in _CANCELLED_RUNS if key not in _RESOLVING_RUNS), None)
        if removable is None:
            break
        _CANCELLED_RUNS.pop(removable, None)


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
    stack,
    input_values=None,
    user_id="default",
    run_handle="",
):
    node_id = str(node_id)
    if input_values and node_id in input_values:
        return input_values[node_id]
    if node_id in stack:
        raise ScenePresetError(f"Sceneグラフが循環しています: #{node_id}")
    node = nodes.get(node_id)
    if not isinstance(node, dict):
        raise ScenePresetError(f"Sceneノード #{node_id} が見つかりません。")
    class_type = node.get("class_type")
    next_stack = {*(stack or set()), node_id}

    def value(raw):
        if not is_link(raw):
            return raw
        return _scene_node_value(
            nodes,
            raw[0],
            resolved,
            next_stack,
            input_values,
            user_id,
            run_handle,
        )

    if class_type in SAFE_VALUE_NODE_CLASSES:
        raw_value = _node_inputs(node).get("value")
        if is_link(raw_value):
            raise ScenePresetError(f"{_node_label(node_id, node)} の値入力は接続できません。")
        try:
            if class_type == "PrimitiveBoolean" and not isinstance(raw_value, bool):
                if str(raw_value).lower() not in {"true", "false"}:
                    raise ValueError(raw_value)
                return str(raw_value).lower() == "true"
            return SAFE_VALUE_NODE_CLASSES[class_type](raw_value)
        except (TypeError, ValueError) as exc:
            raise ScenePresetError(f"{_node_label(node_id, node)} の値が不正です。") from exc
    if class_type == BOUNDARY_INPUT:
        return ScenePresetInput().build()[0]
    if class_type == "ScenePresetReference":
        preset_id = _clean_preset_id(_node_inputs(node).get("preset_id"))
        preset = resolved.get(preset_id)
        if not preset:
            raise ScenePresetError(f"Preset「{preset_id}」のスナップショットがありません。")
        upstream = value(_node_inputs(node).get("scene_prompt")) if is_link(_node_inputs(node).get("scene_prompt")) else None
        return _evaluate_preset_scene(
            preset,
            resolved,
            upstream,
            set(),
            user_id,
            run_handle,
        )
    cls = SAFE_NODE_CLASSES.get(class_type)
    if cls is None:
        raise ScenePresetError(f"{_node_label(node_id, node)} はScene計画を計算できません。")
    kwargs = {name: value(raw) for name, raw in _node_inputs(node).items()}
    if class_type in {"ScenePrompter", "SceneMatrix"}:
        kwargs["run_handle"] = run_handle
    result = getattr(cls(), cls.FUNCTION)(**kwargs)
    return result[0]


def _scene_node_value(
    nodes,
    node_id,
    resolved,
    stack,
    input_values=None,
    user_id="default",
    run_handle="",
):
    try:
        return _scene_node_value_impl(
            nodes,
            node_id,
            resolved,
            stack,
            input_values,
            user_id,
            run_handle,
        )
    except ScenePresetResolutionError:
        raise
    except (ScenePresetError, TypeError, ValueError, KeyError) as exc:
        node = nodes.get(str(node_id), {}) if isinstance(nodes, dict) else {}
        message = str(exc).strip() or "入力が不正です。"
        raise ScenePresetResolutionError(
            f"{_node_label(node_id, node)}: {message}",
            node_id,
        ) from exc


def _evaluate_preset_scene(
    preset,
    resolved,
    upstream,
    stack,
    user_id="default",
    run_handle="",
):
    preset_id = str(preset["metadata"]["preset_id"])
    if preset_id in stack:
        cycle = " -> ".join([*stack, preset_id])
        raise ScenePresetError(f"Preset参照が循環しています: {cycle}")
    validation = _validate_preset_payload(preset)
    nodes = _preset_nodes(preset)
    input_id = validation["input_id"]
    output_link = validation["output_link"]
    input_values = {input_id: upstream} if upstream is not None else None
    return _scene_node_value(
        nodes,
        output_link[0],
        resolved,
        set(),
        input_values,
        user_id,
        run_handle,
    )


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
            return copy.deepcopy(existing["response"])
        _RESOLVING_RUNS[cache_key] = _RESOLVING_RUNS.get(cache_key, 0) + 1

    try:
        resolved = {}
        workflow_references = (
            _workflow_references(workflow)
            if _needs_workflow_preset_snapshots(nodes, expand_node_id)
            else []
        )
        node_budget = {"total": len(scene_nodes) + len(workflow_references)}
        references = [*_find_references(scene_nodes), *workflow_references]
        for reference_node_id, preset_id, _node in references:
            try:
                _resolve_preset_tree(preset_id, resolved, [], user_id, node_budget=node_budget)
            except ScenePresetError as exc:
                raise ScenePresetResolutionError(str(exc), reference_node_id) from exc
        plan = (
            _scene_node_value(scene_nodes, source[0], resolved, set(), user_id=user_id, run_handle=run_id)
            if source is not None else {"total_images": 1, "total_batches": 1}
        )
        response = {
            "presets": [
                {
                    "preset_id": preset_id,
                    "name": preset["metadata"]["name"],
                    "revision": preset["metadata"]["revision"],
                    "sha256": preset["metadata"]["sha256"],
                }
                for preset_id, preset in resolved.items()
            ],
            "preset_graphs": {
                preset_id: {
                    "metadata": copy.deepcopy(preset["metadata"]),
                    "api_graph": copy.deepcopy(preset["api_graph"]),
                }
                for preset_id, preset in resolved.items()
            },
            "total_images": int(plan.get("total_images") or 0),
            "total_batches": int(plan.get("total_batches") or 0),
        }

        with _PRESET_LOCK:
            _assert_run_not_cancelled(run_id, user_id)
            existing = _RUN_SNAPSHOTS.get(cache_key)
            if existing:
                existing["last_access"] = time.monotonic()
                _RUN_SNAPSHOTS.move_to_end(cache_key)
                return copy.deepcopy(existing["response"])
            _RUN_SNAPSHOTS[cache_key] = {
                "presets": resolved,
                "response": copy.deepcopy(response),
                "last_access": time.monotonic(),
            }
            _purge_run_snapshots()
            return response
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


def _snapshot_preset(run_id, preset_id, user_id="default"):
    run_id = str(run_id or "").strip()
    with _PRESET_LOCK:
        cache_key = _run_cache_key(run_id, user_id)
        entry = _RUN_SNAPSHOTS.get(cache_key)
        if run_id:
            if not entry:
                raise ScenePresetError(f"実行「{run_id}」のPresetスナップショットがありません。")
            entry["last_access"] = time.monotonic()
            _RUN_SNAPSHOTS.move_to_end(cache_key)
            preset = entry["presets"].get(preset_id)
            if preset:
                return preset
            raise ScenePresetError(f"実行「{run_id}」にPreset「{preset_id}」は含まれていません。")
    return load_preset(preset_id, user_id)


def _peek_snapshot_preset(run_id, preset_id, user_id="default"):
    """Read a prepared snapshot without extending TTL or changing LRU order."""
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ScenePresetError("実行コンテキストがありません。画像生成を開始し直してください。")
    with _PRESET_LOCK:
        entry = _RUN_SNAPSHOTS.get(_run_cache_key(run_id, user_id))
        if not entry:
            raise ScenePresetError(f"実行「{run_id}」のPresetスナップショットがありません。")
        preset = entry["presets"].get(preset_id)
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
        return MappingProxyType(entry["presets"])


def list_presets(user_id="default"):
    with _PRESET_LOCK:
        directory = preset_directory(user_id)
        if not directory.exists():
            return {"presets": [], "errors": []}
        presets = []
        errors = []
        for path in sorted(directory.glob(f"*{PRESET_FILE_SUFFIX}"), key=lambda item: item.name.lower()):
            try:
                preset = load_preset(path.stem, user_id)
            except ScenePresetError as exc:
                errors.append({"preset_id": path.stem, "error": str(exc)})
                continue
            presets.append({
                "metadata": copy.deepcopy(preset["metadata"]),
                "api_graph": copy.deepcopy(preset["api_graph"]),
            })
        return {"presets": presets, "errors": errors}


def _replace_link(value, input_id, upstream_link, graph):
    if not is_link(value):
        return value
    source_id, output_index = str(value[0]), value[1]
    if source_id == input_id:
        if upstream_link is not None:
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
    unique_id=None,
):
    preset_id = _clean_preset_id(preset_id)
    if _require_context:
        user_id = require_run_context(run_handle)["user_id"]
        preset = _snapshot_preset(run_handle, preset_id, user_id)
    elif run_handle:
        preset = _snapshot_preset(run_handle, preset_id)
    else:
        user_id = "default"
        resolved = {}
        _resolve_preset_tree(preset_id, resolved, [], user_id)
        preset = resolved[preset_id]
    validation = _validate_preset_payload(preset)
    nodes = _preset_nodes(preset)
    input_id = validation["input_id"]
    output_id = validation["output_id"]
    graph = GraphBuilder()
    reference_source_id = str(source_node_id or unique_id or "").strip()

    input_is_referenced = any(
        any(is_link(value) and str(value[0]) == str(input_id) for value in _node_inputs(node).values())
        for node in nodes.values()
        if isinstance(node, dict)
    )
    if scene_prompt is None and input_is_referenced:
        graph.node(BOUNDARY_INPUT, input_id)
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
        if class_type in SAFE_NODE_CLASSES or class_type == "ScenePresetReference":
            target.set_input("source_node_id", f"{reference_source_id}/{node_id}" if reference_source_id else str(node_id))
        if class_type in {"ScenePrompter", "SceneMatrix"}:
            target.set_input("run_handle", str(run_handle))
        if class_type == "ScenePresetReference":
            target.set_input("run_handle", str(run_handle))

    output_link = validation["output_link"]
    result = _replace_link(output_link, input_id, scene_prompt, graph)
    if is_link(result) and str(result[0]) == output_id:
        raise ScenePresetError("Scene Preset Outputの接続が不正です。")
    marker = graph.node("ScenePromptCounter", "__scene_preset_source")
    marker.set_input("scene_prompt", result)
    marker.set_input("count", 1)
    marker.set_input("source_node_id", reference_source_id)
    result = marker.out(0)
    return {"result": (result,), "expand": graph.finalize()}


class ScenePresetInput:
    DESCRIPTION = """Scene Presetの入口です。専用ワークフローではこのノードからScene変換グラフを始め、最後にScene Preset Outputへ接続します。保存したPresetを参照したとき、外側から渡されたscene_promptがここへ入ります。"""
    CATEGORY = "Scene/preset"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def build(self):
        return (seed_plan(),)


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
    DESCRIPTION = """保存済みのScene Presetを参照します。画像生成を開始した時点で最新のPresetを検証して固定し、その実行中は同じrevisionを使います。Preset内のScene Matrix、Queue、Mergeなどは元のノードとして展開・実行されます。"""
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
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, preset_id="", scene_prompt=None, run_handle="", **kwargs):
        del scene_prompt, kwargs
        context = peek_run_context(run_handle)
        preset = _peek_snapshot_preset(run_handle, _clean_preset_id(preset_id), context["user_id"])
        metadata = preset["metadata"]
        return f"{metadata['preset_id']}:{metadata['revision']}:{metadata['sha256']}:{run_handle}"

    def expand(self, preset_id, scene_prompt=None, run_handle="", unique_id=None, source_node_id=""):
        return expand_preset_reference(
            preset_id,
            scene_prompt,
            run_handle,
            _require_context=True,
            source_node_id=source_node_id,
            unique_id=unique_id,
        )
