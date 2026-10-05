"""Read the resources connected to an Expand without evaluating its scene plan."""

import hashlib
import threading
from collections import OrderedDict

import folder_paths
from comfy_execution.graph_utils import is_link

from .nodes import MODEL_MODE_ILLUSTRIOUS, _normalize_model_mode
from .lora_metadata import file_identity, file_signature
from .presets import (
    ScenePresetError,
    _node_inputs,
    _preset_nodes,
    _scene_nodes_for_expand,
    _scene_prompt_closure,
    _validate_preset_graph,
    prepare_preset_occurrences,
)


_MODEL_HASH_CACHE = {}
_MODEL_HASH_SELECTIONS = {}
_MODEL_HASH_LOCK = threading.Lock()
_MODEL_FOLDERS = {"checkpoint": "checkpoints", "diffusion_model": "diffusion_models"}
_VALUE_TYPES = {"PrimitiveFloat": float, "PrimitiveInt": int, "PrimitiveString": str}


def _resource_key(name):
    return str(name or "").replace("\\", "/").casefold()


def _literal(nodes, raw, default):
    if not is_link(raw):
        return default if raw is None else raw
    source = nodes.get(str(raw[0]))
    if not isinstance(source, dict):
        return None
    convert = _VALUE_TYPES.get(source.get("class_type"))
    if convert is None:
        return None
    try:
        value = _node_inputs(source).get("value")
        return convert(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _filename(nodes, raw, node_id):
    value = _literal(nodes, raw, "")
    return (str(value), False) if value is not None else (f"取得不可 (#{node_id})", True)


def connected_resources(api_graph, expand_node_id, user_id="default"):
    """Summarize distinct resources in the selected Expand's Scene ancestry."""
    nodes = api_graph.get("output") if isinstance(api_graph, dict) else None
    if not isinstance(nodes, dict):
        raise ScenePresetError("生成グラフを取得できませんでした。")
    scene_nodes, _source = _scene_nodes_for_expand(nodes, expand_node_id)
    expand = nodes[str(expand_node_id)]
    raw_mode = _literal(nodes, _node_inputs(expand).get("model_mode"), MODEL_MODE_ILLUSTRIOUS)
    mode = _normalize_model_mode(raw_mode) if raw_mode is not None else None
    models = OrderedDict()
    loras = OrderedDict()
    visited_sources = set()
    loaded_presets = {}
    occurrences = prepare_preset_occurrences(scene_nodes, loaded_presets, user_id)
    visiting_presets = set()

    def add_model(kind, name, role, source_class, unresolved=False):
        key = (kind, _resource_key(name))
        if key not in models:
            models[key] = {"kind": kind, "name": str(name), "roles": [],
                           "source_class": source_class, "unresolved": unresolved}
        if role not in models[key]["roles"]:
            models[key]["roles"].append(role)

    def add_lora(name, model_mode, strength_model, strength_clip, role, applies, unresolved=False):
        name = str(name or "")
        entry = loras.setdefault(_resource_key(name), {"name": name, "variants": [], "unresolved": unresolved})
        variant = next((item for item in entry["variants"] if
                        item["model_mode"] == model_mode and
                        item["strength_model"] == strength_model and
                        item["strength_clip"] == strength_clip and
                        item["applies"] == applies), None)
        if variant is None:
            variant = {"model_mode": model_mode, "strength_model": strength_model,
                       "strength_clip": strength_clip, "roles": [], "applies": applies}
            entry["variants"].append(variant)
        if role not in variant["roles"]:
            variant["roles"].append(role)

    def follow_source(scope, source, role):
        if not is_link(source):
            return
        node_id, slot = str(source[0]), source[1]
        key = (id(scope), node_id, slot, role)
        if key in visited_sources:
            return
        visited_sources.add(key)
        node = scope.get(node_id)
        if not isinstance(node, dict):
            add_model("unresolved", f"#{node_id}", role, "Unknown", True)
            return
        kind = node.get("class_type")
        inputs = _node_inputs(node)
        if kind in {"CheckpointLoaderSimple", "CheckpointLoader"}:
            name, unresolved = _filename(scope, inputs.get("ckpt_name"), node_id)
            add_model("checkpoint", name, role, kind, unresolved)
        elif kind in {"UNETLoader", "DiffusionModelLoader"}:
            name, unresolved = _filename(scope, inputs.get("unet_name", inputs.get("model_name")), node_id)
            add_model("diffusion_model", name, role, kind, unresolved)
        elif kind == "CLIPLoader":
            name, unresolved = _filename(scope, inputs.get("clip_name"), node_id)
            add_model("clip", name, role, kind, unresolved)
        elif kind in {"DualCLIPLoader", "TripleCLIPLoader"}:
            for field in ("clip_name1", "clip_name2", "clip_name3"):
                if field in inputs:
                    name, unresolved = _filename(scope, inputs[field], node_id)
                    add_model("clip", name, role, kind, unresolved)
        elif kind == "VAELoader":
            name, unresolved = _filename(scope, inputs.get("vae_name"), node_id)
            add_model("vae", name, role, kind, unresolved)
        elif kind in {"LoraLoader", "LoraLoaderModelOnly"}:
            source_role = "model" if slot == 0 else "clip"
            if kind == "LoraLoaderModelOnly" or slot in (0, 1):
                name, unresolved = _filename(scope, inputs.get("lora_name"), node_id)
                add_lora(name, None,
                         _literal(scope, inputs.get("strength_model"), 1.0),
                         _literal(scope, inputs.get("strength_clip"), 1.0 if kind == "LoraLoader" else None),
                         source_role, True, unresolved)
                follow_source(scope, inputs.get(source_role), source_role)
        else:
            add_model("unresolved", kind or f"#{node_id}", role, kind or "Unknown", True)

    def visit_scene(scope, resource_nodes, path=""):
        for node_id, node in scope.items():
            if not isinstance(node, dict):
                continue
            kind = node.get("class_type")
            inputs = _node_inputs(node)
            if kind == "SceneApplyModel":
                for role in ("model", "clip", "vae"):
                    follow_source(resource_nodes, inputs.get(role), role)
            elif kind == "SceneApplyLora":
                lora_name = _literal(resource_nodes, inputs.get("lora_name"), "")
                raw_lora_mode = _literal(resource_nodes, inputs.get("model_mode"), MODEL_MODE_ILLUSTRIOUS)
                lora_mode = _normalize_model_mode(raw_lora_mode) if raw_lora_mode is not None else None
                strength_model = _literal(resource_nodes, inputs.get("strength_model"), 1.0)
                strength_clip = _literal(resource_nodes, inputs.get("strength_clip"), 1.0)
                unresolved = lora_name is None
                if unresolved:
                    lora_name = f"取得不可 (#{node_id})"
                applies = lora_mode == mode if lora_mode is not None and mode is not None else None
                add_lora(lora_name, lora_mode, strength_model, strength_clip, "model", applies, unresolved)
                add_lora(lora_name, lora_mode, strength_model, strength_clip, "clip", applies, unresolved)
            elif kind == "ScenePresetReference":
                preset_id = _literal(resource_nodes, inputs.get("preset_id"), "")
                if preset_id in visiting_presets:
                    raise ScenePresetError(f"Preset参照が循環しています: {preset_id}")
                reference_path = f"{path}/{node_id}" if path else str(node_id)
                preset = occurrences[reference_path]
                visiting_presets.add(preset_id)
                preset_nodes = _preset_nodes(preset)
                output_link = _validate_preset_graph(preset_nodes)["output_link"]
                visit_scene(_scene_prompt_closure(preset_nodes, output_link[0]), preset_nodes, reference_path)
                visiting_presets.remove(preset_id)

    visit_scene(scene_nodes, nodes)
    return {"model_mode": mode, "models": list(models.values()), "loras": list(loras.values())}


def read_model_hash(kind, name):
    """Stream an explicitly selected file; keep only its current revision."""
    folder = _MODEL_FOLDERS.get(kind)
    if folder is None or not name:
        raise ValueError("Select an available model.")
    while True:
        names = set(folder_paths.get_filename_list(folder))
        with _MODEL_HASH_LOCK:
            for selection in list(_MODEL_HASH_SELECTIONS):
                if selection[0] == folder and selection[1] not in names:
                    _MODEL_HASH_SELECTIONS.pop(selection)
            active = set(_MODEL_HASH_SELECTIONS.values())
            for key in list(_MODEL_HASH_CACHE):
                if key not in active:
                    _MODEL_HASH_CACHE.pop(key)
        if name not in names:
            raise ValueError("Select an available model.")
        path = folder_paths.get_full_path(folder, name)
        if not path:
            raise FileNotFoundError("Selected model was not found.")
        key = file_identity(path)
        selection = (folder, name)
        try:
            signature = file_signature(path)
        except OSError:
            with _MODEL_HASH_LOCK:
                _MODEL_HASH_SELECTIONS.pop(selection, None)
                _MODEL_HASH_CACHE.pop(key, None)
            raise
        with _MODEL_HASH_LOCK:
            previous = _MODEL_HASH_SELECTIONS.get(selection)
            _MODEL_HASH_SELECTIONS[selection] = key
            if previous != key and previous not in _MODEL_HASH_SELECTIONS.values():
                _MODEL_HASH_CACHE.pop(previous, None)
            cached = _MODEL_HASH_CACHE.get(key)
            if cached is not None and cached[0] != signature:
                _MODEL_HASH_CACHE.pop(key)
                cached = None
        if cached is not None:
            result = cached[1]
        else:
            digest = hashlib.sha256()
            with open(path, "rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            result = {"sha256": digest.hexdigest(),
                      "size": signature[0], "mtime_ns": signature[1]}
        current_names = folder_paths.get_filename_list(folder)
        if name not in current_names:
            with _MODEL_HASH_LOCK:
                _MODEL_HASH_SELECTIONS.pop(selection, None)
                if key not in _MODEL_HASH_SELECTIONS.values():
                    _MODEL_HASH_CACHE.pop(key, None)
            raise ValueError("Select an available model.")
        current_path = folder_paths.get_full_path(folder, name)
        if not current_path or file_identity(current_path) != key:
            continue
        with _MODEL_HASH_LOCK:
            try:
                current_signature = file_signature(current_path)
            except OSError:
                _MODEL_HASH_CACHE.pop(key, None)
                raise
            if current_signature != signature or _MODEL_HASH_SELECTIONS.get(selection) != key:
                continue
            _MODEL_HASH_CACHE[key] = (signature, result)
        return {**result, "kind": kind, "name": name}
