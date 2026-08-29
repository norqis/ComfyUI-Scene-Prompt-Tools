"""One-time migration from the retired node installation to v0.2.4.

This script is deliberately separate from the custom-node runtime.  It accepts
only the old on-disk format and writes only the current format.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


PROMPT_FILE = "prompt.json"
SAVED_PROMPTS = "保存済みプロンプト"
_RETIRED_NODE_LABEL = "Scene" + "-Promp" + "ter"
OLD_NODE_DIRECTORY = "ComfyUI-" + _RETIRED_NODE_LABEL
NEW_NODE_DIRECTORY = "ComfyUI-Scene-Prompt-Tools"


def _retired_node_type(suffix: str = "") -> str:
    return "Scene" + "Promp" + "ter" + suffix


OLD_TO_NEW_TYPES = {
    _retired_node_type(): "ScenePrompt",
    _retired_node_type("Merge"): "ScenePromptMerge",
    _retired_node_type("Queue"): "ScenePromptQueue",
    _retired_node_type("Expand"): "ScenePromptExpand",
}
SCENE_TYPES = {
    "ScenePrompt", "SceneMatrix", "ScenePath", "ScenePromptMerge",
    "ScenePromptCounter", "ScenePromptQueue", "SceneEmptyLatent",
    "ScenePromptExpand", "SceneSaveImage", "ScenePresetInput",
    "ScenePresetOutput", "ScenePresetReference",
}
SCENE_INPUTS = {
    "ScenePrompt": ("scene_prompt",),
    "SceneMatrix": ("scene_prompt",),
    "ScenePath": ("scene_prompt",),
    "ScenePromptMerge": ("scene_prompt1", "scene_prompt2"),
    "ScenePromptCounter": ("scene_prompt",),
    "ScenePromptQueue": tuple(f"scene_prompt{index}" for index in range(1, 11)),
    "SceneEmptyLatent": ("scene_prompt",),
    "ScenePromptExpand": ("scene_prompt",),
    "SceneSaveImage": ("images", "scene_info"),
    "ScenePresetInput": ("scene_prompt",),
    "ScenePresetOutput": ("scene_prompt",),
    "ScenePresetReference": ("scene_prompt",),
}
SCENE_OUTPUTS = {
    "ScenePrompt": ("scene_prompt",),
    "SceneMatrix": ("scene_prompt",),
    "ScenePath": ("scene_prompt",),
    "ScenePromptMerge": ("scene_prompt",),
    "ScenePromptCounter": ("scene_prompt",),
    "ScenePromptQueue": ("scene_prompt",),
    "SceneEmptyLatent": ("scene_prompt",),
    "ScenePromptExpand": ("ポジティブ", "ネガティブ", "メタ情報", "シード", "潜在画像"),
    "SceneSaveImage": ("画像", "保存先"),
    "ScenePresetInput": ("scene_prompt",),
    "ScenePresetOutput": ("scene_prompt",),
    "ScenePresetReference": ("scene_prompt",),
}
EMPTY_SELECTION = {"version": 1, "categories": {}}


class MigrationError(ValueError):
    pass


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError(f"Cannot read JSON: {path}") from exc


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _safe_item(raw: Any, source: Path, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise MigrationError(f"{source}: item {index} is not an object")
    label = raw.get("label")
    prompt = raw.get("prompt")
    if not isinstance(label, str) or not label.strip() or not isinstance(prompt, str) or not prompt.strip():
        raise MigrationError(f"{source}: item {index} requires label and prompt")
    item = {"label": label.strip(), "prompt": prompt.strip()}
    if isinstance(raw.get("id"), str) and raw["id"].strip():
        item["id"] = raw["id"].strip()
    if "description" in raw:
        if not isinstance(raw["description"], str):
            raise MigrationError(f"{source}: item {index} description is invalid")
        item["description"] = raw["description"]
    return item


@dataclass
class PromptRecord:
    category_path: tuple[str, ...]
    raw: dict[str, Any]
    item: dict[str, Any]

    @property
    def category(self) -> str:
        return " > ".join(self.category_path)


class PromptResolver:
    def __init__(self, records: Iterable[PromptRecord]):
        self.records = list(records)
        self.by_id: dict[tuple[str, str], list[PromptRecord]] = defaultdict(list)
        self.by_fields: dict[tuple[str, str, str], list[PromptRecord]] = defaultdict(list)
        self.by_legacy: dict[str, list[PromptRecord]] = defaultdict(list)
        for record in self.records:
            raw_id = str(record.raw.get("id") or "").strip()
            if raw_id:
                self.by_id[(record.category, raw_id)].append(record)
            self.by_fields[(record.category, record.raw["label"], record.raw["prompt"])].append(record)
            for key in record.raw.get("legacy_keys", []):
                if isinstance(key, str) and key.strip():
                    self.by_legacy[key.strip()].append(record)

    @staticmethod
    def _one(candidates: Iterable[PromptRecord], context: str) -> PromptRecord:
        unique = []
        seen = set()
        for candidate in candidates:
            identity = id(candidate)
            if identity not in seen:
                seen.add(identity)
                unique.append(candidate)
        if len(unique) != 1:
            raise MigrationError(f"{context}: selected prompt cannot be resolved uniquely")
        return unique[0]

    def resolve(self, raw: dict[str, Any], category: str, context: str) -> PromptRecord:
        category = str(raw.get("category_key") or category or "").strip()
        candidates: list[PromptRecord] = []
        item_id = raw.get("id")
        if isinstance(item_id, str) and item_id.strip():
            candidates.extend(self.by_id.get((category, item_id.strip()), []))
        label = raw.get("label")
        prompt = raw.get("prompt")
        if isinstance(label, str) and isinstance(prompt, str):
            candidates.extend(self.by_fields.get((category, label, prompt), []))
        for value in (item_id, label, prompt):
            if isinstance(value, str) and value.strip():
                candidates.extend(self.by_legacy.get(f"{category}::{value.strip()}", []))
                candidates.extend(self.by_legacy.get(value.strip(), []))
        if not candidates:
            raise MigrationError(f"{context}: selected prompt no longer exists")
        if len(candidates) > 1:
            matching = [
                candidate for candidate in candidates
                if (not isinstance(label, str) or candidate.raw["label"] == label)
                and (not isinstance(prompt, str) or candidate.raw["prompt"] == prompt)
            ]
            if matching:
                candidates = matching
        return self._one(candidates, context)


def _unique_ids(records: list[PromptRecord]) -> None:
    groups: dict[str, list[PromptRecord]] = defaultdict(list)
    for record in records:
        item_id = record.item.get("id")
        if item_id:
            groups[item_id].append(record)
    for item_id, group in groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda item: (item.item["label"] != item_id, item.category, item.item["label"], item.item["prompt"]))
        for index, record in enumerate(group[1:], start=2):
            record.item["id"] = f"{item_id}_{index}"


def _normal_prompt_payload(value: Any, source: Path) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and set(value) == {"items"} and isinstance(value["items"], list):
        return value["items"]
    raise MigrationError(f"{source}: expected a prompt item array")


def migrate_data(source_root: Path, destination_root: Path) -> PromptResolver:
    records: list[PromptRecord] = []
    normal_files: list[tuple[Path, list[Any]]] = []
    saved_files: list[tuple[Path, dict[str, Any]]] = []
    for source in sorted(source_root.rglob(PROMPT_FILE)):
        relative = source.relative_to(source_root)
        value = _read_json(source)
        if relative.parts and relative.parts[0] == SAVED_PROMPTS:
            if not isinstance(value, dict) or set(value) != {"name", "description", "items"}:
                raise MigrationError(f"{source}: invalid saved prompt payload")
            saved_files.append((relative, value))
            continue
        items = _normal_prompt_payload(value, source)
        normal_files.append((relative, items))
        category_path = relative.parent.parts
        for index, raw in enumerate(items):
            item = _safe_item(raw, source, index)
            records.append(PromptRecord(category_path, raw, item))

    _unique_ids(records)
    resolver = PromptResolver(records)
    by_file: dict[Path, list[PromptRecord]] = defaultdict(list)
    for record in records:
        by_file[Path(*record.category_path) / PROMPT_FILE].append(record)
    for relative, _items in normal_files:
        payload = [record.item for record in by_file[relative]]
        _write_json(destination_root / relative, payload)

    for relative, value in saved_files:
        items = []
        for index, raw in enumerate(value["items"]):
            if not isinstance(raw, dict):
                raise MigrationError(f"{source_root / relative}: saved item {index} is invalid")
            category = str(raw.get("category_key") or "").strip()
            record = resolver.resolve(raw, category, f"{source_root / relative} item {index}")
            items.append(_selection_from_record(raw, record))
        payload = {"name": value["name"], "description": value["description"], "items": items}
        _write_json(destination_root / relative, payload)
    return resolver


def _split_prompt(text: str) -> list[str]:
    return [part.strip() for part in text.replace("\n", ",").split(",") if part.strip()]


def _selection_from_record(raw: dict[str, Any], record: PromptRecord) -> dict[str, Any]:
    item = dict(record.item)
    item["category_path"] = list(record.category_path)
    item["category_key"] = record.category
    item["category_label"] = record.category
    if "weight" in raw:
        item["weight"] = raw["weight"]
    if "selected_parts" in raw:
        latest_parts = _split_prompt(record.item["prompt"])
        selected_parts = []
        used = set()
        for part in raw["selected_parts"]:
            if not isinstance(part, dict) or not isinstance(part.get("index"), int) or not isinstance(part.get("text"), str):
                raise MigrationError("selected prompt part is invalid")
            text = part["text"]
            candidates = [index for index, value in enumerate(latest_parts) if value == text and index not in used]
            if not candidates:
                # The selected source item was replaced. Selecting its current
                # full prompt is the only current-schema representation that
                # does not pretend the retired fragment still exists.
                return item
            index = part["index"] if part["index"] in candidates else candidates[0]
            next_part = {"index": index, "text": latest_parts[index]}
            if "weight" in part:
                next_part["weight"] = part["weight"]
            selected_parts.append(next_part)
            used.add(index)
        item["selected_parts"] = selected_parts
    return item


def normalize_selection(raw_value: Any, resolver: PromptResolver, context: str) -> str:
    if raw_value is None or raw_value == "":
        return _json_text(EMPTY_SELECTION)
    if not isinstance(raw_value, str):
        raise MigrationError(f"{context}: selection is not a string")
    try:
        value = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise MigrationError(f"{context}: selection JSON is invalid") from exc
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("categories"), dict):
        raise MigrationError(f"{context}: selection schema is invalid")
    categories: dict[str, list[dict[str, Any]]] = {}
    for category, items in value["categories"].items():
        if not isinstance(category, str) or not isinstance(items, list):
            raise MigrationError(f"{context}: selection entries are invalid")
        for index, raw in enumerate(items):
            if not isinstance(raw, dict):
                raise MigrationError(f"{context}: selection item {index} is invalid")
            record = resolver.resolve(raw, category, f"{context} item {index}")
            categories.setdefault(record.category, []).append(_selection_from_record(raw, record))
    return _json_text({"version": 1, "categories": categories})


def normalize_matrix(raw_value: Any, resolver: PromptResolver, context: str) -> str:
    if not isinstance(raw_value, str):
        raise MigrationError(f"{context}: matrix JSON is not a string")
    try:
        value = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise MigrationError(f"{context}: matrix JSON is invalid") from exc
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("sets"), list):
        raise MigrationError(f"{context}: matrix schema is invalid")
    sets = []
    for index, raw in enumerate(value["sets"]):
        if not isinstance(raw, dict):
            raise MigrationError(f"{context}: matrix set {index} is invalid")
        name = raw.get("name")
        path_label = raw.get("path_label")
        row_id = raw.get("row_id")
        if not all(isinstance(field, str) and field.strip() for field in (name, path_label, row_id)):
            raise MigrationError(f"{context}: matrix set {index} has no name")
        line = {
            "type": "SCENE_MATRIX_LINE",
            "version": 1,
            "row_id": row_id,
            "node_id": str(raw.get("node_id") or ""),
            "category": str(raw.get("category") or ""),
            "name": name,
            "path_label": path_label,
            "enabled": raw.get("enabled", True),
            "positive_base": str(raw.get("positive_base") or ""),
            "positive_json": normalize_selection(raw.get("positive_json", _json_text(EMPTY_SELECTION)), resolver, f"{context} matrix {index} positive"),
            "negative_base": str(raw.get("negative_base") or ""),
            "negative_json": normalize_selection(raw.get("negative_json", _json_text(EMPTY_SELECTION)), resolver, f"{context} matrix {index} negative"),
            "category_order": str(raw.get("category_order") or ""),
            "positive_parts": list(raw.get("positive_parts") or []),
            "negative_parts": list(raw.get("negative_parts") or []),
            "display_labels": list(raw.get("display_labels") or []),
            "display_label_groups": list(raw.get("display_label_groups") or []),
        }
        if not isinstance(line["enabled"], bool):
            raise MigrationError(f"{context}: matrix set {index} enabled is invalid")
        if not all(isinstance(value, str) for field in ("positive_parts", "negative_parts", "display_labels") for value in line[field]):
            raise MigrationError(f"{context}: matrix set {index} string fields are invalid")
        if not all(isinstance(group, list) and all(isinstance(value, str) for value in group) for group in line["display_label_groups"]):
            raise MigrationError(f"{context}: matrix set {index} display_label_groups are invalid")
        sets.append(line)
    return _json_text({"version": 1, "sets": sets})


def _named_or_widget(node: dict[str, Any], name: str, index: int, default: Any) -> Any:
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and name in named:
        return named[name]
    values = node.get("widgets_values")
    return values[index] if isinstance(values, list) and index < len(values) else default


def _scene_inputs(type_name: str, old_inputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    existing = {str(value.get("name") or value.get("label") or ""): value for value in old_inputs if isinstance(value, dict)}
    result = []
    for name in SCENE_INPUTS[type_name]:
        prior = existing.get(name, {})
        current = {key: value for key, value in prior.items() if key not in {"name", "label", "localized_name"}}
        current.update({"name": name, "label": name, "localized_name": name})
        result.append(current)
    return result


def _scene_outputs(type_name: str, old_outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for index, name in enumerate(SCENE_OUTPUTS[type_name]):
        prior = old_outputs[index] if index < len(old_outputs) and isinstance(old_outputs[index], dict) else {}
        current = {key: value for key, value in prior.items() if key not in {"name", "label", "localized_name"}}
        current.update({"name": name, "label": name, "localized_name": name})
        result.append(current)
    return result


def _set_widgets(node: dict[str, Any], values: list[Any], named: dict[str, Any]) -> None:
    node["widgets_values"] = values
    node["widgets_values_named"] = named


def _migrate_scene_node(node: dict[str, Any], resolver: PromptResolver, workflow: Path) -> None:
    type_name = str(node.get("type") or "")
    type_name = OLD_TO_NEW_TYPES.get(type_name, type_name)
    node["type"] = type_name
    properties = node.get("properties")
    if not isinstance(properties, dict):
        properties = {}
        node["properties"] = properties
    properties["Node name for S&R"] = type_name
    if type_name == "ScenePrompt":
        prompt_name = _named_or_widget(node, "prompt_name", 0, "")
        positive_base = _named_or_widget(node, "positive_base", 1, "")
        positive_json = normalize_selection(_named_or_widget(node, "positive_json", 2, _json_text(EMPTY_SELECTION)), resolver, f"{workflow} node {node.get('id')} positive")
        negative_base = _named_or_widget(node, "negative_base", 3, "")
        negative_json = normalize_selection(_named_or_widget(node, "negative_json", 4, _json_text(EMPTY_SELECTION)), resolver, f"{workflow} node {node.get('id')} negative")
        category_order = _named_or_widget(node, "category_order", 5, "")
        seed = _named_or_widget(node, "seed", 6, 0)
        control = _named_or_widget(node, "control_after_generate", 7, True)
        randomize = _named_or_widget(node, "randomize", 8, True)
        named = {
            "prompt_name": prompt_name, "positive_base": positive_base, "positive_json": positive_json,
            "negative_base": negative_base, "negative_json": negative_json, "category_order": category_order,
            "seed": seed, "control_after_generate": control, "randomize": randomize, "run_handle": "",
        }
        _set_widgets(node, [prompt_name, positive_base, positive_json, negative_base, negative_json, category_order, seed, control, randomize, ""], named)
    elif type_name == "SceneMatrix":
        matrix_json = normalize_matrix(_named_or_widget(node, "matrix_json", 0, _json_text({"version": 1, "sets": []})), resolver, f"{workflow} node {node.get('id')}")
        properties["scene_matrix_json"] = matrix_json
        _set_widgets(node, [matrix_json, ""], {"matrix_json": matrix_json, "run_handle": ""})
    elif type_name == "SceneSaveImage":
        path = _named_or_widget(node, "path", 0, "")
        _set_widgets(node, [path, "ワークフロー全体"], {"path": path, "metadata_mode": "ワークフロー全体"})
    node["inputs"] = _scene_inputs(type_name, node.get("inputs") if isinstance(node.get("inputs"), list) else [])
    node["outputs"] = _scene_outputs(type_name, node.get("outputs") if isinstance(node.get("outputs"), list) else [])


def migrate_workflow(source: Path, destination: Path, resolver: PromptResolver) -> dict[str, Any]:
    workflow = _read_json(source)
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list) or not isinstance(workflow.get("links"), list):
        raise MigrationError(f"{source}: invalid workflow")
    old_input_names: dict[str, list[str]] = {}
    for node in workflow["nodes"]:
        if not isinstance(node, dict):
            raise MigrationError(f"{source}: workflow node is invalid")
        node_id = str(node.get("id"))
        old_input_names[node_id] = [str(item.get("name") or item.get("label") or "") for item in node.get("inputs", []) if isinstance(item, dict)]
        if str(node.get("type") or "") in SCENE_TYPES | set(OLD_TO_NEW_TYPES):
            _migrate_scene_node(node, resolver, source)

    by_id = {str(node.get("id")): node for node in workflow["nodes"] if isinstance(node, dict)}
    for link in workflow["links"]:
        if not isinstance(link, list) or len(link) < 6:
            raise MigrationError(f"{source}: invalid workflow link")
        target_id = str(link[3])
        target = by_id.get(target_id)
        if target and target.get("type") in SCENE_INPUTS:
            old_name = old_input_names[target_id][int(link[4])] if isinstance(link[4], int) and 0 <= link[4] < len(old_input_names[target_id]) else ""
            try:
                link[4] = SCENE_INPUTS[target["type"]].index(old_name)
            except ValueError as exc:
                raise MigrationError(f"{source}: link {link[0]} target input cannot be mapped") from exc
    validate_workflow(workflow, source)
    _write_json(destination, workflow)
    return workflow


def validate_data(data_root: Path) -> None:
    prompt_module = _runtime_modules()[0]
    seen_ids = set()
    for prompt_file in sorted(data_root.rglob(PROMPT_FILE)):
        relative = prompt_file.relative_to(data_root)
        value = _read_json(prompt_file)
        if relative.parts and relative.parts[0] == SAVED_PROMPTS:
            if not isinstance(value, dict) or set(value) != {"name", "description", "items"}:
                raise MigrationError(f"{prompt_file}: invalid saved prompt schema")
            continue
        if not isinstance(value, list):
            raise MigrationError(f"{prompt_file}: current prompt data must be an array")
        for index, item in enumerate(value):
            prompt_module.validate_prompt_data_item(item, f"{prompt_file} item {index}")
            item_id = item.get("id")
            if item_id:
                if item_id in seen_ids:
                    raise MigrationError(f"{prompt_file}: duplicate prompt ID '{item_id}'")
                seen_ids.add(item_id)
            if "legacy_keys" in item:
                raise MigrationError(f"{prompt_file}: legacy_keys survived migration")


def validate_workflow(workflow: dict[str, Any], source: Path) -> None:
    node_ids = set()
    nodes = {}
    for node in workflow["nodes"]:
        node_id = str(node.get("id"))
        if node_id in node_ids:
            raise MigrationError(f"{source}: duplicate workflow node ID")
        node_ids.add(node_id)
        nodes[node_id] = node
        if node.get("type") in OLD_TO_NEW_TYPES:
            raise MigrationError(f"{source}: old Scene node survived migration")
        if node.get("type") in SCENE_TYPES:
            if node.get("properties", {}).get("Node name for S&R") != node["type"]:
                raise MigrationError(f"{source}: Scene S&R type is invalid")
            expected_inputs = SCENE_INPUTS[node["type"]]
            if [item.get("name") for item in node.get("inputs", [])] != list(expected_inputs):
                raise MigrationError(f"{source}: Scene input slots are invalid")
            expected_outputs = SCENE_OUTPUTS[node["type"]]
            if [item.get("name") for item in node.get("outputs", [])] != list(expected_outputs):
                raise MigrationError(f"{source}: Scene output slots are invalid")
            serialized = _json_text(node)
            if "legacy_keys" in serialized:
                raise MigrationError(f"{source}: legacy_keys survived workflow migration in node {node_id}")
    for link in workflow["links"]:
        if not isinstance(link, list) or len(link) < 6:
            raise MigrationError(f"{source}: invalid workflow link")
        source_node = nodes.get(str(link[1]))
        target_node = nodes.get(str(link[3]))
        if source_node is None or target_node is None:
            raise MigrationError(f"{source}: dangling workflow link")
        if source_node.get("type") in SCENE_OUTPUTS and not 0 <= int(link[2]) < len(SCENE_OUTPUTS[source_node["type"]]):
            raise MigrationError(f"{source}: source link slot is invalid")
        if target_node.get("type") in SCENE_INPUTS and not 0 <= int(link[4]) < len(SCENE_INPUTS[target_node["type"]]):
            raise MigrationError(f"{source}: target link slot is invalid")


def _runtime_modules():
    package_root = str(Path(__file__).resolve().parents[1])
    if package_root not in sys.path:
        sys.path.insert(0, package_root)
    try:
        from scene_prompt_tools import nodes, prompt
    except ModuleNotFoundError as exc:
        raise MigrationError("Run this script with the ComfyUI embedded Python from the ComfyUI root.") from exc
    return prompt, nodes


def validate_stage(stage: Path) -> None:
    data_root = stage / "data"
    validate_data(data_root)
    prompt_module, nodes_module = _runtime_modules()
    records = []
    for path in sorted(data_root.rglob(PROMPT_FILE)):
        relative = path.relative_to(data_root)
        if relative.parts and relative.parts[0] == SAVED_PROMPTS:
            continue
        for raw in _read_json(path):
            item = dict(raw)
            item["category_path"] = list(relative.parent.parts)
            item["category_key"] = " > ".join(relative.parent.parts)
            item["category_label"] = item["category_key"]
            records.append(PromptRecord(relative.parent.parts, raw, item))
    resolver = PromptResolver(records)
    index = {"by_key": {}, "by_id": {}}
    for record in records:
        item = dict(record.item)
        key = prompt_module._selection_item_key(item, record.category)
        index["by_key"][key] = item
        if item.get("id"):
            index["by_id"][(record.category, item["id"])] = item
    for saved_file in sorted((data_root / SAVED_PROMPTS).rglob(PROMPT_FILE)) if (data_root / SAVED_PROMPTS).exists() else []:
        saved = _read_json(saved_file)
        if not isinstance(saved, dict) or set(saved) != {"name", "description", "items"} or not saved["items"]:
            raise MigrationError(f"{saved_file}: invalid saved prompt schema")
        for item in saved["items"]:
            if not isinstance(item, dict):
                raise MigrationError(f"{saved_file}: invalid saved prompt item")
            category = item.get("category_key")
            if not isinstance(category, str) or not category:
                raise MigrationError(f"{saved_file}: saved prompt item category is invalid")
            prompt_module._parse_selection_json(
                _json_text({"version": 1, "categories": {category: [item]}}), index
            )
    for workflow_file in sorted((stage / "workflows").glob("*.json")):
        workflow = _read_json(workflow_file)
        validate_workflow(workflow, workflow_file)
        for node in workflow["nodes"]:
            if node.get("type") == "ScenePrompt":
                prompt_module._parse_selection_json(node["widgets_values_named"]["positive_json"], index)
                prompt_module._parse_selection_json(node["widgets_values_named"]["negative_json"], index)
            if node.get("type") == "SceneMatrix":
                matrix = node["widgets_values_named"]["matrix_json"]
                for entry in nodes_module._parse_matrix_data(matrix)["sets"]:
                    nodes_module._normalize_matrix_line_set(entry, index)


def build_stage(source_data: Path, workflow_dir: Path, stage: Path) -> dict[str, Any]:
    if stage.exists():
        raise MigrationError(f"Stage directory already exists: {stage}")
    stage.mkdir(parents=True)
    resolver = migrate_data(source_data, stage / "data")
    workflow_files = sorted(workflow_dir.glob("*.json"))
    if not workflow_files:
        raise MigrationError(f"No workflow files found: {workflow_dir}")
    for source in workflow_files:
        migrate_workflow(source, stage / "workflows" / source.name, resolver)
    manifest = {
        "source_data": str(source_data),
        "workflow_dir": str(workflow_dir),
        "files": {
            str(path.relative_to(source_data)): _sha256(path)
            for path in sorted(source_data.rglob(PROMPT_FILE))
        },
    }
    for path in workflow_files:
        manifest["files"][f"workflows/{path.name}"] = _sha256(path)
    _write_json(stage / "manifest.json", manifest)
    validate_stage(stage)
    return manifest


def apply_stage(stage: Path, comfy_root: Path, source_node: Path) -> None:
    validate_stage(stage)
    custom_nodes = comfy_root / "custom_nodes"
    user_default = comfy_root / "user" / "default"
    destination_data = user_default / "scene_prompt_tools" / "data"
    destination_node = custom_nodes / NEW_NODE_DIRECTORY
    old_node = custom_nodes / OLD_NODE_DIRECTORY
    backup_root = user_default / "scene_prompt_tools" / "migration_backup"
    if destination_node.exists():
        raise MigrationError(f"New node destination already exists: {destination_node}")
    if not old_node.exists():
        raise MigrationError(f"Old node does not exist: {old_node}")
    if destination_data.exists():
        raise MigrationError(f"Destination data already exists: {destination_data}")
    backup_root.mkdir(parents=True, exist_ok=True)
    if (backup_root / OLD_NODE_DIRECTORY).exists():
        raise MigrationError("Old node backup already exists")
    shutil.copytree(source_node, destination_node, ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__", ".pytest_cache", "node_modules", ".coverage"))
    shutil.copytree(stage / "data", destination_data)
    for staged in sorted((stage / "workflows").glob("*.json")):
        target = comfy_root / "user" / "default" / "workflows" / staged.name
        shutil.copy2(staged, target)
    shutil.move(str(old_node), str(backup_root / OLD_NODE_DIRECTORY))


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate the installed retired node to Scene Prompt Tools v0.2.4.")
    parser.add_argument("--comfy-root", type=Path, required=True)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--dry-run", action="store_true")
    actions.add_argument("--stage", type=Path)
    actions.add_argument("--apply", type=Path, metavar="STAGE_DIRECTORY")
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    comfy_root = args.comfy_root.resolve()
    if str(comfy_root) not in sys.path:
        sys.path.insert(0, str(comfy_root))
    source_data = comfy_root / "custom_nodes" / OLD_NODE_DIRECTORY / "data"
    workflow_dir = comfy_root / "user" / "default" / "workflows"
    if args.apply:
        apply_stage(args.apply.resolve(), comfy_root, Path(__file__).resolve().parents[1])
        print(f"Applied: {args.apply}")
        return 0
    if args.dry_run:
        with tempfile.TemporaryDirectory(prefix="scene-prompt-v023-") as temporary:
            build_stage(source_data, workflow_dir, Path(temporary) / "stage")
        print("Dry run passed.")
        return 0
    stage = args.stage.resolve()
    build_stage(source_data, workflow_dir, stage)
    print(f"Staged: {stage}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as exc:
        print(f"Migration failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
