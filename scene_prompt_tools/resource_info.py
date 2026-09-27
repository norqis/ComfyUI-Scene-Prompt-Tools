"""Read the resources connected to an Expand without evaluating its scene plan."""

import hashlib
import os
import threading
from collections import OrderedDict

import folder_paths
from comfy_execution.graph_utils import is_link

from .nodes import MODEL_MODE_ILLUSTRIOUS, _normalize_model_mode
from .presets import (
    ScenePresetError,
    _node_inputs,
    _preset_nodes,
    _scene_nodes_for_expand,
    _scene_prompt_closure,
    _validate_preset_graph,
    load_preset,
)


_MODEL_HASH_CACHE = OrderedDict()
_MODEL_HASH_LOCK = threading.Lock()
_MODEL_FOLDERS = {"checkpoint": "checkpoints", "diffusion_model": "diffusion_models"}
_VALUE_TYPES = {"PrimitiveFloat": float, "PrimitiveInt": int, "PrimitiveString": str}


def _literal(nodes, raw, default):
    if not is_link(raw):
        return default if raw is None else raw
    source = nodes.get(str(raw[0]))
    if not isinstance(source, dict):
        return default
    convert = _VALUE_TYPES.get(source.get("class_type"))
    if convert is None:
        return default
    try:
        return convert(_node_inputs(source).get("value"))
    except (TypeError, ValueError):
        return default


def connected_resources(api_graph, expand_node_id, user_id="default"):
    """Summarize distinct resources in the selected Expand's Scene ancestry."""
    nodes = api_graph.get("output") if isinstance(api_graph, dict) else None
    if not isinstance(nodes, dict):
        raise ScenePresetError("生成グラフを取得できませんでした。")
    scene_nodes, _source = _scene_nodes_for_expand(nodes, expand_node_id)
    expand = nodes[str(expand_node_id)]
    mode = _normalize_model_mode(_literal(nodes, _node_inputs(expand).get("model_mode"), MODEL_MODE_ILLUSTRIOUS))
    models = OrderedDict()
    loras = OrderedDict()
    visited_sources = set()
    loaded_presets = {}
    visited_presets = set()

    def add_model(kind, name, role, source_class):
        key = (kind, str(name))
        if key not in models:
            models[key] = {"kind": kind, "name": str(name), "roles": [], "source_class": source_class}
        if role not in models[key]["roles"]:
            models[key]["roles"].append(role)

    def add_lora(name, model_mode, strength_model, strength_clip, role):
        name = str(name or "")
        entry = loras.setdefault(name, {"name": name, "variants": []})
        variant = next((item for item in entry["variants"] if
                        item["model_mode"] == model_mode and
                        item["strength_model"] == strength_model and
                        item["strength_clip"] == strength_clip), None)
        if variant is None:
            variant = {"model_mode": model_mode, "strength_model": strength_model,
                       "strength_clip": strength_clip, "roles": [], "applies": model_mode == mode}
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
            add_model("unresolved", f"#{node_id}", role, "Unknown")
            return
        kind = node.get("class_type")
        inputs = _node_inputs(node)
        if kind in {"CheckpointLoaderSimple", "CheckpointLoader"}:
            add_model("checkpoint", inputs.get("ckpt_name", ""), role, kind)
        elif kind in {"UNETLoader", "DiffusionModelLoader"}:
            add_model("diffusion_model", inputs.get("unet_name", inputs.get("model_name", "")), role, kind)
        elif kind == "CLIPLoader":
            add_model("clip", inputs.get("clip_name", ""), role, kind)
        elif kind in {"DualCLIPLoader", "TripleCLIPLoader"}:
            for field in ("clip_name1", "clip_name2", "clip_name3"):
                if inputs.get(field):
                    add_model("clip", inputs[field], role, kind)
        elif kind == "VAELoader":
            add_model("vae", inputs.get("vae_name", ""), role, kind)
        elif kind in {"LoraLoader", "LoraLoaderModelOnly"}:
            source_role = "model" if slot == 0 else "clip"
            if kind == "LoraLoaderModelOnly" or slot in (0, 1):
                add_lora(inputs.get("lora_name"), mode,
                         _literal(scope, inputs.get("strength_model"), 1.0),
                         _literal(scope, inputs.get("strength_clip"), 1.0 if kind == "LoraLoader" else None),
                         source_role)
                follow_source(scope, inputs.get(source_role), source_role)
        else:
            add_model("unresolved", kind or f"#{node_id}", role, kind or "Unknown")

    def visit_scene(scope, resource_nodes):
        for node in scope.values():
            if not isinstance(node, dict):
                continue
            kind = node.get("class_type")
            inputs = _node_inputs(node)
            if kind == "SceneApplyModel":
                for role in ("model", "clip", "vae"):
                    follow_source(resource_nodes, inputs.get(role), role)
            elif kind == "SceneApplyLora":
                add_lora(_literal(scope, inputs.get("lora_name"), ""),
                         _normalize_model_mode(_literal(scope, inputs.get("model_mode"), MODEL_MODE_ILLUSTRIOUS)),
                         _literal(scope, inputs.get("strength_model"), 1.0),
                         _literal(scope, inputs.get("strength_clip"), 1.0), "model")
                add_lora(_literal(scope, inputs.get("lora_name"), ""),
                         _normalize_model_mode(_literal(scope, inputs.get("model_mode"), MODEL_MODE_ILLUSTRIOUS)),
                         _literal(scope, inputs.get("strength_model"), 1.0),
                         _literal(scope, inputs.get("strength_clip"), 1.0), "clip")
            elif kind == "ScenePresetReference":
                preset_id = _literal(scope, inputs.get("preset_id"), "")
                if preset_id not in loaded_presets:
                    loaded_presets[preset_id] = load_preset(preset_id, user_id)
                if preset_id in visited_presets:
                    continue
                visited_presets.add(preset_id)
                preset_nodes = _preset_nodes(loaded_presets[preset_id])
                output_link = _validate_preset_graph(preset_nodes)["output_link"]
                visit_scene(_scene_prompt_closure(preset_nodes, output_link[0]), preset_nodes)

    visit_scene(scene_nodes, nodes)
    return {"model_mode": mode, "models": list(models.values()), "loras": list(loras.values())}


def read_model_hash(kind, name):
    """Hash only an explicitly selected base model, with bounded memory use."""
    folder = _MODEL_FOLDERS.get(kind)
    if folder is None or not name or name not in folder_paths.get_filename_list(folder):
        raise ValueError("Select an available model.")
    path = folder_paths.get_full_path(folder, name)
    if not path:
        raise FileNotFoundError("Selected model was not found.")
    stat = os.stat(path)
    key = (kind, name, path, stat.st_size, stat.st_mtime_ns)
    with _MODEL_HASH_LOCK:
        cached = _MODEL_HASH_CACHE.get(key)
        if cached is not None:
            _MODEL_HASH_CACHE.move_to_end(key)
            return dict(cached)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    result = {"kind": kind, "name": name, "sha256": digest.hexdigest(),
              "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    with _MODEL_HASH_LOCK:
        _MODEL_HASH_CACHE[key] = result
        _MODEL_HASH_CACHE.move_to_end(key)
        while len(_MODEL_HASH_CACHE) > 32:
            _MODEL_HASH_CACHE.popitem(last=False)
    return dict(result)
