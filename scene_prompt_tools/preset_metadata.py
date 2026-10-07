"""Expand saved Scene Presets into PNG metadata graphs."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from .switches import safe_control, resolve_switches


PRESET_REFERENCE = "ScenePresetReference"
PRESET_INPUT = "ScenePresetInput"
PRESET_OUTPUT = "ScenePresetOutput"
BOUNDARIES = {PRESET_INPUT, PRESET_OUTPUT}


def _link(value):
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], str)
        and isinstance(value[1], int)
        and value[1] >= 0
    )


def _nodes(preset):
    graph = preset.get("api_graph") if isinstance(preset, dict) else None
    nodes = graph.get("output") if isinstance(graph, dict) else None
    if not isinstance(nodes, dict):
        raise ValueError("Presetの実行グラフが不正です。")
    return nodes


def _workflow_nodes(preset):
    workflow = preset.get("workflow") if isinstance(preset, dict) else None
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list):
        raise ValueError("Presetの編集用ワークフローが不正です。")
    return nodes


def _boundary_ids(nodes):
    inputs = [str(node_id) for node_id, node in nodes.items() if node.get("class_type") == PRESET_INPUT]
    outputs = [str(node_id) for node_id, node in nodes.items() if node.get("class_type") == PRESET_OUTPUT]
    if len(inputs) != 1 or len(outputs) != 1:
        raise ValueError("Presetの入出力境界が不正です。")
    output_inputs = nodes[outputs[0]].get("inputs")
    output_link = output_inputs.get("scene_prompt") if isinstance(output_inputs, dict) else None
    if not _link(output_link):
        raise ValueError("Presetの出力が未接続です。")
    return inputs[0], outputs[0], list(output_link)


def _position(node):
    value = node.get("pos") if isinstance(node, dict) else None
    if isinstance(value, (list, tuple)) and len(value) == 2:
        try:
            return float(value[0]), float(value[1])
        except (TypeError, ValueError):
            pass
    return 0.0, 0.0


def _new_node_ids(prompt, workflow):
    used = {str(node_id) for node_id in prompt}
    used.update(str(node.get("id")) for node in workflow.get("nodes", []) if isinstance(node, dict) and node.get("id") is not None)
    numeric = [int(value) for value in used if value.isdigit()]
    next_id = max(numeric, default=0) + 1

    def allocate():
        nonlocal next_id
        while str(next_id) in used:
            next_id += 1
        value = str(next_id)
        used.add(value)
        next_id += 1
        return value

    return allocate


def _replace_reference_links(prompt, reference_id, output_link):
    for node in prompt.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for name, value in list(inputs.items()):
            if _link(value) and str(value[0]) == reference_id:
                inputs[name] = list(output_link)


def _workflow_template_index(nodes):
    return {
        str(node.get("id")): node
        for node in nodes
        if isinstance(node, dict) and node.get("id") is not None
    }


def _preset_internal_ids(preset, *, retain_input=False):
    api_nodes = _nodes(preset)
    workflow_nodes = _workflow_nodes(preset)
    boundary_ids = {
        str(node_id)
        for node_id, node in api_nodes.items()
        if node.get("class_type") == PRESET_INPUT
    }
    boundary_ids.update(
        str(node.get("id"))
        for node in workflow_nodes
        if isinstance(node, dict) and node.get("id") is not None and node.get("type") == PRESET_INPUT
    )
    retain_input = retain_input or _uses_switches(api_nodes, preset.get("workflow"))
    if retain_input:
        boundary_ids = {node_id for node_id in boundary_ids if api_nodes.get(node_id, {}).get("class_type") != PRESET_INPUT}
    physical_ids = set()
    workflow = preset.get("workflow") if isinstance(preset, dict) else None
    links = workflow.get("links") if isinstance(workflow, dict) else None
    if isinstance(links, list):
        for link in links:
            parts = _workflow_link_parts(link)
            if parts is not None:
                physical_ids.update((parts[1], parts[3]))
    required = {
        str(node_id)
        for node_id, node in api_nodes.items()
        if str(node_id) not in boundary_ids
    }
    required.update(physical_ids - boundary_ids)
    result = []
    for node in workflow_nodes:
        node_id = str(node.get("id")) if isinstance(node, dict) and node.get("id") is not None else None
        if node_id in required:
            result.append(node_id)
    missing = required - set(result)
    if missing:
        raise ValueError("Presetの編集用ワークフローにノードがありません: " + ", ".join(sorted(missing)))
    return result


def _uses_switches(nodes, workflow=None):
    input_ids = {str(node_id) for node_id, node in nodes.items() if node.get("class_type") == PRESET_INPUT}
    if any(node.get("class_type") == PRESET_INPUT and node.get("inputs", {}).get("switch_names_json", "[]") != "[]"
           or any(_link(value) and str(value[0]) in input_ids and value[1] != 0
                  for value in node.get("inputs", {}).values()) for node in nodes.values()):
        return True
    if isinstance(workflow, dict):
        return any(parts[1] in input_ids and parts[2] != 0
                   for link in workflow.get("links", []) if (parts := _workflow_link_parts(link)) is not None)
    return False


def _preset_internal_links(preset, mapping):
    workflow = preset.get("workflow") if isinstance(preset, dict) else None
    links = workflow.get("links") if isinstance(workflow, dict) else None
    if not isinstance(links, list):
        return []
    result = []
    for link in links:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        _link_id, source_id, source_slot, target_id, target_slot, link_type = parts
        if source_id in mapping and target_id in mapping:
            result.append((mapping[source_id], source_slot, mapping[target_id], target_slot, link_type))
    return result


def _preset_physical_boundaries(preset, mapping, input_id, output_id):
    workflow = preset.get("workflow") if isinstance(preset, dict) else None
    links = workflow.get("links") if isinstance(workflow, dict) else None
    entries = []
    output = (mapping[output_id], 0)
    if not isinstance(links, list):
        return entries, output
    for link in links:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        _link_id, source_id, source_slot, target_id, target_slot, _link_type = parts
        if source_id == input_id and source_slot == 0 and target_id in mapping:
            entries.append((mapping[target_id], target_slot))
    return entries, output


def _clone_preset_workflow_nodes(preset, mapping, reference_node):
    templates = _workflow_template_index(_workflow_nodes(preset))
    internal_ids = list(mapping)

    positions = [_position(templates[node_id]) for node_id in internal_ids]
    min_x = min((position[0] for position in positions), default=0.0)
    min_y = min((position[1] for position in positions), default=0.0)
    ref_x, ref_y = _position(reference_node)
    result = []
    for node_id in internal_ids:
        copied = copy.deepcopy(templates[node_id])
        x, y = _position(copied)
        copied["id"] = int(mapping[node_id])
        copied["pos"] = [x - min_x + ref_x, y - min_y + ref_y]
        if copied.get("type") == PRESET_OUTPUT:
            # Preserve the Reference's whole-prompt boundary after PNG import.
            copied["type"] = "ScenePromptCounter"
            copied["title"] = reference_node.get("title") or "Scene Preset Reference"
            copied["mode"] = 0
            copied["widgets_values"] = [1, True]
            copied.pop("widgets_values_named", None)
            copied["inputs"] = [{"name": "scene_prompt", "type": "SCENE_PROMPT", "link": None}]
            copied["outputs"] = [{"name": "scene_prompt", "type": "SCENE_PROMPT", "links": []}]
            copied["properties"] = {"Node name for S&R": "ScenePromptCounter", "scene_prompt_trace_kind": "whole"}
        for slot in copied.get("inputs", []) if isinstance(copied.get("inputs"), list) else []:
            if isinstance(slot, dict):
                slot["link"] = None
        for slot in copied.get("outputs", []) if isinstance(copied.get("outputs"), list) else []:
            if isinstance(slot, dict):
                slot["links"] = []
        result.append(copied)
    return result


def _inline_reference(prompt, workflow, reference_id, preset, source_ids, state):
    reference = prompt.get(reference_id)
    if not isinstance(reference, dict):
        raise ValueError(f"Preset参照ノード #{reference_id} がありません。")
    nodes = _nodes(preset)
    input_id, _output_id, output_link = _boundary_ids(nodes)
    allocate = _new_node_ids(prompt, workflow)
    inputs = reference.get("inputs") if isinstance(reference.get("inputs"), dict) else {}
    upstream = inputs.get("scene_prompt")
    upstream = list(upstream) if _link(upstream) else None
    mapping = {node_id: allocate() for node_id in _preset_internal_ids(preset, retain_input=upstream is None)}
    reference_source = source_ids.get(reference_id, reference_id)
    frozen = state["switch_values"]
    if reference_source in frozen:
        vector = tuple(frozen[reference_source])
    else:
        incoming = safe_control(prompt, inputs["switches"]) if "switches" in inputs else None
        vector = resolve_switches(incoming, inputs.get("switch_settings_json", "[]"))
    entry_targets = []

    for original_id, original in nodes.items():
        original_id = str(original_id)
        if original.get("class_type") in BOUNDARIES and original_id not in mapping:
            continue
        copied = copy.deepcopy(original)
        if original_id == _output_id:
            copied = {"class_type": "ScenePromptCounter", "inputs": {
                "scene_prompt": output_link, "count": 1, "enable_downstream_count": True,
                "prompt_trace_kind": "whole", "source_node_id": reference_source,
                "source_node_name": inputs.get("source_node_name", ""),
            }}
        copied_inputs = copied.get("inputs")
        if not isinstance(copied_inputs, dict):
            copied_inputs = {}
        remapped = {}
        for name, value in copied_inputs.items():
            if not _link(value):
                remapped[name] = value
            elif str(value[0]) == input_id and value[1] == 0:
                entry_targets.append((mapping[original_id], name))
                if upstream is not None:
                    remapped[name] = list(upstream)
                elif input_id in mapping:
                    remapped[name] = [mapping[input_id], 0]
            else:
                remapped[name] = [mapping[str(value[0])], value[1]]
        if copied.get("class_type") == PRESET_INPUT:
            remapped["switch_values"] = {"values": list(vector)}
        if copied.get("class_type") in {"ScenePromptRandomRoute", "SceneApplyLora"}:
            remapped["source_node_id"] = f"{reference_source}/{original_id}"
        copied["inputs"] = remapped
        prompt[mapping[original_id]] = copied
        source_ids[mapping[original_id]] = reference_source if original_id == _output_id else f"{reference_source}/{original_id}"

    output = [mapping[_output_id], 0]

    outer_nodes = workflow.get("nodes")
    if not isinstance(outer_nodes, list):
        raise ValueError("Scene Save Image の workflow が不正です。")
    workflow_reference = next((node for node in outer_nodes if str(node.get("id")) == reference_id), None)
    if not isinstance(workflow_reference, dict):
        raise ValueError(f"workflow にPreset参照ノード #{reference_id} がありません。")
    workflow["nodes"] = [node for node in outer_nodes if str(node.get("id")) != reference_id]
    copied_workflow_nodes = _clone_preset_workflow_nodes(preset, mapping, workflow_reference)
    if input_id in mapping:
        for copied_node in copied_workflow_nodes:
            if str(copied_node["id"]) == mapping[input_id]:
                copied_node.setdefault("properties", {})["scene_switch_values"] = list(vector)
    workflow["nodes"].extend(copied_workflow_nodes)
    state["inserted"].update(mapping.values())
    templates = _workflow_template_index(_workflow_nodes(preset))
    for original_id, copied_id in mapping.items():
        if original_id not in nodes and templates[original_id].get("type") == PRESET_REFERENCE:
            state["display_only_references"].add(copied_id)
    physical_entries, physical_output = _preset_physical_boundaries(preset, mapping, input_id, _output_id)
    state["references"][reference_id] = {
        "entry_targets": entry_targets,
        "output": output,
        "physical_entries": physical_entries,
        "physical_output": physical_output,
    }
    state["physical_links"].extend(edge for edge in _preset_internal_links(preset, mapping)
                                  if not (upstream is not None and input_id in mapping and str(edge[0]) == mapping[input_id] and edge[1] == 0))
    state["references"][reference_id]["scene_input_slot"] = next((index for index, slot in enumerate(workflow_reference.get("inputs", [])) if slot.get("name") == "scene_prompt"), None)
    _replace_reference_links(prompt, reference_id, output)
    prompt.pop(reference_id, None)
    return output


def _workflow_id(node_id):
    return int(node_id) if str(node_id).isdigit() else node_id


def _workflow_link_parts(link):
    if not isinstance(link, list) or len(link) < 6:
        return None
    return link[0], str(link[1]), link[2], str(link[3]), link[4], link[5]


def _remove_link_from_slots(by_id, link):
    parts = _workflow_link_parts(link)
    if parts is None:
        return
    link_id, source_id, source_slot, target_id, target_slot, _link_type = parts
    source = by_id.get(source_id)
    if isinstance(source, dict):
        outputs = source.get("outputs")
        if isinstance(outputs, list) and 0 <= source_slot < len(outputs) and isinstance(outputs[source_slot], dict):
            values = outputs[source_slot].get("links")
            if isinstance(values, list):
                outputs[source_slot]["links"] = [value for value in values if value != link_id]
    target = by_id.get(target_id)
    if isinstance(target, dict):
        inputs = target.get("inputs")
        if isinstance(inputs, list) and 0 <= target_slot < len(inputs) and isinstance(inputs[target_slot], dict):
            if inputs[target_slot].get("link") == link_id:
                inputs[target_slot]["link"] = None


def _input_slot(node, name):
    inputs = node.setdefault("inputs", [])
    for index, slot in enumerate(inputs):
        if isinstance(slot, dict) and slot.get("name") == name:
            return index
    inputs.append({"name": name, "type": "*", "link": None})
    return len(inputs) - 1


def _output_slot(node, index):
    outputs = node.setdefault("outputs", [])
    while len(outputs) <= index:
        outputs.append({"name": "output", "type": "*", "links": []})
    return outputs[index]


def _resolve_reference_physical_output(reference_id, state):
    output = state["references"][reference_id]["physical_output"]
    return str(output[0]), output[1]


def _resolve_entry_targets(reference_id, state):
    result = []
    for node_id, input_name in state["references"][reference_id]["entry_targets"]:
        node_id = str(node_id)
        if node_id in state["references"]:
            result.extend(_resolve_entry_targets(node_id, state))
        else:
            result.append((node_id, input_name))
    return result


def _resolve_reference_entry_slots(reference_id, state, by_id):
    reference = state["references"][reference_id]
    physical_entries = reference.get("physical_entries")
    if physical_entries:
        result = []
        for node_id, slot in physical_entries:
            node_id = str(node_id)
            if node_id in state["references"]:
                result.extend(_resolve_reference_entry_slots(node_id, state, by_id))
            else:
                result.append((node_id, slot))
        return result
    result = []
    for node_id, input_name in _resolve_entry_targets(reference_id, state):
        node = by_id.get(str(node_id))
        if node is None:
            raise ValueError(f"展開後の接続先ノード #{node_id} がありません。")
        result.append((str(node_id), _input_slot(node, input_name)))
    return result


def _add_workflow_link(links, by_id, next_link_id, source_id, source_slot, target_id, target_slot, link_type, added):
    source_id = str(source_id)
    target_id = str(target_id)
    key = (source_id, source_slot, target_id, target_slot)
    if key in added:
        return next_link_id
    source = by_id.get(source_id)
    target = by_id.get(target_id)
    if source is None or target is None:
        raise ValueError(f"展開後の接続先ノード #{source_id if source is None else target_id} がありません。")
    output = _output_slot(source, source_slot)
    target_inputs = target.setdefault("inputs", [])
    while len(target_inputs) <= target_slot:
        target_inputs.append({"name": "input", "type": "*", "link": None})
    target_input = target_inputs[target_slot]
    if not isinstance(target_input, dict):
        target_input = {"name": "input", "type": "*", "link": None}
        target_inputs[target_slot] = target_input
    if not isinstance(output.get("links"), list):
        output["links"] = []
    output["links"].append(next_link_id)
    target_input["link"] = next_link_id
    links.append([
        next_link_id,
        _workflow_id(source_id),
        source_slot,
        _workflow_id(target_id),
        target_slot,
        link_type or target_input.get("type") or output.get("type") or "*",
    ])
    added.add(key)
    return next_link_id + 1


def _remove_reference_reroutes(workflow, removed_link_ids):
    reroutes = workflow.get("reroutes")
    if not isinstance(reroutes, list) or not removed_link_ids:
        return
    updated = []
    for reroute in reroutes:
        link_ids = reroute.get("linkIds") if isinstance(reroute, dict) else None
        if not isinstance(link_ids, list) or not any(link_id in removed_link_ids for link_id in link_ids):
            updated.append(reroute)
            continue
        kept_ids = [link_id for link_id in link_ids if link_id not in removed_link_ids]
        if kept_ids:
            copied = copy.deepcopy(reroute)
            copied["linkIds"] = kept_ids
            updated.append(copied)
    workflow["reroutes"] = updated


def _rebuild_expanded_workflow_links(prompt, workflow, state):
    """Replace only Reference links; leave every unrelated workflow link untouched."""
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("Scene Save Image の workflow が不正です。")
    by_id = {str(node.get("id")): node for node in nodes if isinstance(node, dict) and node.get("id") is not None}
    reference_ids = set(state["references"])
    original_links = workflow.get("links")
    if not isinstance(original_links, list):
        raise ValueError("Scene Save Image の workflow links が不正です。")
    old_link_ids = [parts[0] for link in original_links if (parts := _workflow_link_parts(link)) is not None and isinstance(parts[0], int)]
    old_link_ids.append(workflow.get("last_link_id") if isinstance(workflow.get("last_link_id"), int) else 0)
    next_link_id = max(old_link_ids, default=0) + 1
    links = []
    removed = []
    for link in original_links:
        parts = _workflow_link_parts(link)
        if parts is not None and (parts[1] in reference_ids or parts[3] in reference_ids):
            removed.append(link)
            _remove_link_from_slots(by_id, link)
        else:
            links.append(link)
    _remove_reference_reroutes(
        workflow,
        {parts[0] for link in removed if (parts := _workflow_link_parts(link)) is not None},
    )

    added = set()
    physical_targets = {
        (str(target_id), target_slot)
        for _source_id, _source_slot, target_id, target_slot, _link_type in state["physical_links"]
    }
    physical_reference_inputs = {}
    for source_id, source_slot, target_id, _target_slot, _link_type in state["physical_links"]:
        if str(target_id) in reference_ids and _target_slot == state["references"][str(target_id)].get("scene_input_slot", 0):
            physical_reference_inputs[str(target_id)] = (source_id, source_slot)
    for link in original_links:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        _link_id, source_id, source_slot, target_id, _target_slot, _link_type = parts
        if target_id in reference_ids and _target_slot == state["references"][target_id].get("scene_input_slot", 0):
            physical_reference_inputs[target_id] = (source_id, source_slot)
    for _source_id, _source_slot, target_id, _target_slot, _link_type in state["physical_links"]:
        if str(target_id) in reference_ids:
            physical_targets.update(_resolve_reference_entry_slots(str(target_id), state, by_id))
    for reference_id, reference in state["references"].items():
        if reference_id in physical_reference_inputs:
            physical_targets.update((str(node_id), slot) for node_id, slot in reference.get("physical_entries", ()))
    for link in original_links:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        _link_id, source_id, _source_slot, target_id, target_slot, _link_type = parts
        reference = state["references"].get(source_id)
        if reference and reference.get("physical_output") is not None:
            physical_targets.add((target_id, target_slot))
    for target_id, target in prompt.items():
        inputs = target.get("inputs") if isinstance(target, dict) else None
        if not isinstance(inputs, dict):
            continue
        for input_name, value in inputs.items():
            if not _link(value) or (str(value[0]) not in state["inserted"] and str(target_id) not in state["inserted"]):
                continue
            source_id, source_slot = str(value[0]), value[1]
            target_node = by_id.get(str(target_id))
            if target_node is None:
                raise ValueError(f"展開後の接続先ノード #{target_id} がありません。")
            target_slot = _input_slot(target_node, input_name)
            if (str(target_id), target_slot) in physical_targets:
                continue
            next_link_id = _add_workflow_link(
                links, by_id, next_link_id, source_id, source_slot, target_id, target_slot, None, added
            )

    for link in removed:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        _link_id, source_id, source_slot, target_id, target_slot, link_type = parts
        if source_id in reference_ids and target_id in by_id:
            output_id, output_slot = _resolve_reference_physical_output(source_id, state)
            next_link_id = _add_workflow_link(
                links, by_id, next_link_id, output_id, output_slot, target_id, target_slot, link_type, added
            )
        if target_id in reference_ids and source_id in by_id and target_slot == state["references"][target_id].get("scene_input_slot", 0):
            for entry_id, entry_slot in _resolve_reference_entry_slots(target_id, state, by_id):
                next_link_id = _add_workflow_link(
                    links,
                    by_id,
                    next_link_id,
                    source_id,
                    source_slot,
                    entry_id,
                    entry_slot,
                    link_type,
                    added,
                )
    for source_id, source_slot, target_id, target_slot, link_type in state["physical_links"]:
        source_ids = [(source_id, source_slot)]
        if str(source_id) in reference_ids:
            source_ids = [_resolve_reference_physical_output(str(source_id), state)]
        target_ids = [(target_id, target_slot)]
        if str(target_id) in reference_ids:
            target_ids = (_resolve_reference_entry_slots(str(target_id), state, by_id)
                          if target_slot == state["references"][str(target_id)].get("scene_input_slot", 0) else [])
        for resolved_source_id, resolved_source_slot in source_ids:
            for resolved_target_id, resolved_target_slot in target_ids:
                next_link_id = _add_workflow_link(
                    links,
                    by_id,
                    next_link_id,
                    resolved_source_id,
                    resolved_source_slot,
                    resolved_target_id,
                    resolved_target_slot,
                    link_type,
                    added,
                )
    workflow["links"] = links
    numeric_ids = [int(node_id) for node_id in by_id if node_id.isdigit()]
    workflow["last_node_id"] = max(numeric_ids, default=0)
    workflow["last_link_id"] = next_link_id - 1


def _workflow_reference_preset_id(node):
    values = node.get("widgets_values") if isinstance(node, dict) else None
    preset_id = str(values[0] or "").strip() if isinstance(values, list) and values else ""
    if not preset_id:
        raise ValueError("workflow のScene Preset ReferenceにPreset IDがありません。")
    return preset_id


def _expand_workflow_only_reference(workflow, reference_id, preset, frozen_vector=None):
    nodes = workflow.get("nodes")
    links = workflow.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise ValueError("Scene Save Image の workflow が不正です。")
    by_id = {str(node.get("id")): node for node in nodes if isinstance(node, dict) and node.get("id") is not None}
    reference = by_id.get(reference_id)
    if reference is None:
        raise ValueError(f"workflow にPreset参照ノード #{reference_id} がありません。")

    preset_nodes = _nodes(preset)
    input_id, _output_id, output_link = _boundary_ids(preset_nodes)
    scene_slot = next((index for index, slot in enumerate(reference.get("inputs", [])) if slot.get("name") == "scene_prompt"), None)
    bundle_slot = next((index for index, slot in enumerate(reference.get("inputs", [])) if slot.get("name") == "switches"), None)
    incoming_bundle = None
    if frozen_vector is None and bundle_slot is not None:
        bundle_edge = next((parts for link in links if (parts := _workflow_link_parts(link)) is not None
                            and parts[3] == reference_id and parts[4] == bundle_slot), None)
        if bundle_edge is not None:
            edges = {(parts[3], parts[4]): (parts[1], parts[2]) for link in links
                     if (parts := _workflow_link_parts(link)) is not None}
            source_id, source_slot = bundle_edge[1:3]
            seen = set()
            while (source_id, source_slot) not in seen:
                seen.add((source_id, source_slot))
                source = by_id.get(source_id, {})
                if str(source.get("type", "")).casefold() == "reroute":
                    input_slot = 0
                elif source.get("mode") == 4:
                    input_slot = next((index for index, item in enumerate(source.get("inputs", []))
                                       if item.get("type") in {"SCENE_SWITCHES", "*"} and (source_id, index) in edges), None)
                else:
                    break
                if (source_id, input_slot) not in edges:
                    break
                source_id, source_slot = edges[(source_id, input_slot)]
            source = by_id.get(source_id, {})
            if source.get("type") != PRESET_INPUT or source_slot != 11:
                raise ValueError("Presetのswitches入力を安全に取得できません。")
            incoming_bundle = source.get("properties", {}).get("scene_switch_values")
    widgets = reference.get("widgets_values", [])
    settings = widgets[3] if len(widgets) > 3 else "[]"
    vector = tuple(frozen_vector) if frozen_vector is not None else resolve_switches(incoming_bundle, settings)
    allocate = _new_node_ids({}, workflow)
    incoming = [parts for link in links if (parts := _workflow_link_parts(link)) is not None
                and parts[3] == reference_id and parts[4] == scene_slot]
    mapping = {node_id: allocate() for node_id in _preset_internal_ids(preset, retain_input=not incoming)}
    entry_targets = []
    internal_edges = []
    for target_id, target in preset_nodes.items():
        target_id = str(target_id)
        if target.get("class_type") == PRESET_INPUT:
            continue
        inputs = target.get("inputs") if isinstance(target.get("inputs"), dict) else {}
        for name, value in inputs.items():
            if not _link(value):
                continue
            source_id, source_slot = str(value[0]), value[1]
            if source_id == input_id and source_slot == 0:
                entry_targets.append((mapping[target_id], name))
                if not incoming:
                    internal_edges.append((mapping[input_id], 0, mapping[target_id], name))
            else:
                internal_edges.append((mapping[source_id], source_slot, mapping[target_id], name))

    removed = []
    retained = []
    for link in links:
        parts = _workflow_link_parts(link)
        if parts is not None and (parts[1] == reference_id or parts[3] == reference_id):
            removed.append(link)
            _remove_link_from_slots(by_id, link)
        else:
            retained.append(link)
    _remove_reference_reroutes(
        workflow,
        {parts[0] for link in removed if (parts := _workflow_link_parts(link)) is not None},
    )
    workflow["nodes"] = [node for node in nodes if str(node.get("id")) != reference_id]
    copied_nodes = _clone_preset_workflow_nodes(preset, mapping, reference)
    if input_id in mapping:
        for copied in copied_nodes:
            if str(copied["id"]) == mapping[input_id]:
                copied.setdefault("properties", {})["scene_switch_values"] = list(vector)
    workflow["nodes"].extend(copied_nodes)
    by_id = {str(node.get("id")): node for node in workflow["nodes"] if isinstance(node, dict) and node.get("id") is not None}

    old_link_ids = [parts[0] for link in links if (parts := _workflow_link_parts(link)) is not None and isinstance(parts[0], int)]
    old_link_ids.append(workflow.get("last_link_id") if isinstance(workflow.get("last_link_id"), int) else 0)
    next_link_id = max(old_link_ids, default=0) + 1
    added = set()
    physical_edges = _preset_internal_links(preset, mapping)
    physical_targets = {(str(target_id), target_slot) for _source_id, _source_slot, target_id, target_slot, _type in physical_edges}
    physical_entries, physical_output = _preset_physical_boundaries(preset, mapping, input_id, _output_id)
    for source_id, source_slot, target_id, input_name in internal_edges:
        target_slot = _input_slot(by_id[target_id], input_name)
        if (str(target_id), target_slot) in physical_targets:
            continue
        next_link_id = _add_workflow_link(
            retained, by_id, next_link_id, source_id, source_slot, target_id, target_slot, None, added,
        )
    outgoing = [parts for link in removed if (parts := _workflow_link_parts(link)) is not None and parts[1] == reference_id]
    for _link_id, source_id, source_slot, _target_id, _target_slot, link_type in incoming:
        targets = physical_entries or [
            (target_id, _input_slot(by_id[target_id], input_name))
            for target_id, input_name in entry_targets
        ]
        for target_id, target_slot in targets:
            next_link_id = _add_workflow_link(
                retained, by_id, next_link_id, source_id, source_slot, target_id, target_slot, link_type, added,
            )
    output_id, output_slot = physical_output
    for _link_id, _source_id, _source_slot, target_id, target_slot, link_type in outgoing:
        next_link_id = _add_workflow_link(
            retained, by_id, next_link_id, output_id, output_slot, target_id, target_slot, link_type, added,
        )
    for source_id, source_slot, target_id, target_slot, link_type in physical_edges:
        if incoming and input_id in mapping and str(source_id) == mapping[input_id] and source_slot == 0:
            continue
        next_link_id = _add_workflow_link(
            retained, by_id, next_link_id, source_id, source_slot, target_id, target_slot, link_type, added,
        )
    workflow["links"] = retained
    numeric_ids = [int(node_id) for node_id in by_id if node_id.isdigit()]
    workflow["last_node_id"] = max(numeric_ids, default=0)
    workflow["last_link_id"] = next_link_id - 1
    return mapping


def _expand_workflow_only_references(workflow, preset_snapshots, display_only_references=(), source_ids=None):
    source_ids = {} if source_ids is None else source_ids
    display_only_references = set(display_only_references)
    while True:
        reference = next(
            (
                node for node in workflow.get("nodes", [])
                if (
                    isinstance(node, dict)
                    and node.get("type") == PRESET_REFERENCE
                    and node.get("mode") not in {2, 4}
                    and str(node.get("id")) not in display_only_references
                )
            ),
            None,
        )
        if reference is None:
            return
        preset_id = _workflow_reference_preset_id(reference)
        reference_id = str(reference.get("id"))
        reference_path = source_ids.get(reference_id, reference_id)
        preset = (preset_snapshots.get("__occurrences__", {}).get(reference_path)
                  or preset_snapshots.get(preset_id)) if isinstance(preset_snapshots, Mapping) else None
        if not isinstance(preset, dict):
            raise ValueError(f"Preset「{preset_id}」の実行開始時スナップショットがありません。")
        reference_id = str(reference.get("id"))
        mapping = _expand_workflow_only_reference(workflow, reference_id, preset,
                    preset_snapshots.get("__switch_values__", {}).get(reference_path))
        templates = _workflow_template_index(_workflow_nodes(preset))
        api_nodes = _nodes(preset)
        for original_id, copied_id in mapping.items():
            source_ids[copied_id] = reference_path if api_nodes.get(original_id, {}).get("class_type") == PRESET_OUTPUT else f"{reference_path}/{original_id}"
            if (
                original_id not in api_nodes
                and templates[original_id].get("type") == PRESET_REFERENCE
            ):
                display_only_references.add(copied_id)


def expand_preset_references(prompt, workflow, preset_snapshots, expand_workflow_references=False):
    """Return an expanded prompt/workflow plus source-id aliases for path slicing."""
    if not isinstance(prompt, dict):
        raise ValueError("Scene Save Image の prompt が不正です。")
    if not isinstance(workflow, dict):
        raise ValueError("Scene Save Image の workflow が不正です。")
    expanded_prompt = copy.deepcopy(prompt)
    expanded_workflow = copy.deepcopy(workflow)
    source_ids = {str(node_id): str(node_id) for node_id in expanded_prompt}
    state = {"inserted": set(), "references": {}, "physical_links": [], "display_only_references": set(),
             "switch_values": preset_snapshots.get("__switch_values__", {})}
    while True:
        reference_id = next(
            (
                str(node_id)
                for node_id, node in expanded_prompt.items()
                if isinstance(node, dict) and node.get("class_type") == PRESET_REFERENCE
            ),
            None,
        )
        if reference_id is None:
            break
        inputs = expanded_prompt[reference_id].get("inputs")
        preset_id = str(inputs.get("preset_id") or "").strip() if isinstance(inputs, dict) else ""
        preset = (preset_snapshots.get("__occurrences__", {}).get(source_ids.get(reference_id, reference_id))
                  or preset_snapshots.get(preset_id)) if isinstance(preset_snapshots, Mapping) else None
        if not isinstance(preset, dict):
            raise ValueError(f"Preset「{preset_id or reference_id}」の実行開始時スナップショットがありません。")
        _inline_reference(expanded_prompt, expanded_workflow, reference_id, preset, source_ids, state)
    _rebuild_expanded_workflow_links(expanded_prompt, expanded_workflow, state)
    if expand_workflow_references:
        _expand_workflow_only_references(expanded_workflow, preset_snapshots, state["display_only_references"], source_ids)
    return expanded_prompt, expanded_workflow, source_ids
