"""Expand saved Scene Presets into PNG metadata graphs."""

from __future__ import annotations

import copy


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


def _clone_preset_workflow_nodes(preset, mapping, reference_node):
    api_nodes = _nodes(preset)
    templates = _workflow_template_index(_workflow_nodes(preset))
    internal_ids = [
        str(node_id)
        for node_id, node in api_nodes.items()
        if node.get("class_type") not in BOUNDARIES
    ]
    missing = [node_id for node_id in internal_ids if node_id not in templates]
    if missing:
        raise ValueError("Presetの編集用ワークフローにノードがありません: " + ", ".join(missing))

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
    mapping = {
        str(node_id): allocate()
        for node_id, node in nodes.items()
        if node.get("class_type") not in BOUNDARIES
    }
    inputs = reference.get("inputs") if isinstance(reference.get("inputs"), dict) else {}
    upstream = inputs.get("scene_prompt")
    upstream = list(upstream) if _link(upstream) else None
    reference_source = source_ids.get(reference_id, reference_id)
    entry_targets = []

    for original_id, original in nodes.items():
        original_id = str(original_id)
        if original.get("class_type") in BOUNDARIES:
            continue
        copied = copy.deepcopy(original)
        copied_inputs = copied.get("inputs")
        if not isinstance(copied_inputs, dict):
            copied_inputs = {}
        remapped = {}
        for name, value in copied_inputs.items():
            if not _link(value):
                remapped[name] = value
            elif str(value[0]) == input_id:
                entry_targets.append((mapping[original_id], name))
                if upstream is not None:
                    remapped[name] = list(upstream)
            else:
                remapped[name] = [mapping[str(value[0])], value[1]]
        copied["inputs"] = remapped
        prompt[mapping[original_id]] = copied
        source_ids[mapping[original_id]] = f"{reference_source}/{original_id}"

    if str(output_link[0]) == input_id:
        output = upstream
    else:
        output = [mapping[str(output_link[0])], output_link[1]]
    if output is None:
        raise ValueError("Presetの入力が未接続のため展開できません。")

    outer_nodes = workflow.get("nodes")
    if not isinstance(outer_nodes, list):
        raise ValueError("Scene Save Image の workflow が不正です。")
    workflow_reference = next((node for node in outer_nodes if str(node.get("id")) == reference_id), None)
    if not isinstance(workflow_reference, dict):
        raise ValueError(f"workflow にPreset参照ノード #{reference_id} がありません。")
    workflow["nodes"] = [node for node in outer_nodes if str(node.get("id")) != reference_id]
    workflow["nodes"].extend(_clone_preset_workflow_nodes(preset, mapping, workflow_reference))
    state["inserted"].update(mapping.values())
    state["references"][reference_id] = {
        "entry_targets": entry_targets,
        "output": output,
    }
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


def _resolve_reference_output(reference_id, state):
    output = state["references"][reference_id]["output"]
    seen = set()
    while str(output[0]) in state["references"]:
        current = str(output[0])
        if current in seen:
            raise ValueError("Preset参照の出力接続が循環しています。")
        seen.add(current)
        output = state["references"][current]["output"]
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
            next_link_id = _add_workflow_link(
                links, by_id, next_link_id, source_id, source_slot, target_id, target_slot, None, added
            )

    for link in removed:
        parts = _workflow_link_parts(link)
        if parts is None:
            continue
        _link_id, source_id, source_slot, target_id, target_slot, link_type = parts
        if source_id in reference_ids and target_id in by_id:
            output_id, output_slot = _resolve_reference_output(source_id, state)
            next_link_id = _add_workflow_link(
                links, by_id, next_link_id, output_id, output_slot, target_id, target_slot, link_type, added
            )
        if target_id in reference_ids and source_id in by_id:
            for entry_id, input_name in _resolve_entry_targets(target_id, state):
                target_node = by_id.get(entry_id)
                if target_node is None:
                    raise ValueError(f"展開後の接続先ノード #{entry_id} がありません。")
                next_link_id = _add_workflow_link(
                    links,
                    by_id,
                    next_link_id,
                    source_id,
                    source_slot,
                    entry_id,
                    _input_slot(target_node, input_name),
                    link_type,
                    added,
                )
    workflow["links"] = links
    numeric_ids = [int(node_id) for node_id in by_id if node_id.isdigit()]
    workflow["last_node_id"] = max(numeric_ids, default=0)
    workflow["last_link_id"] = next_link_id - 1


def expand_preset_references(prompt, workflow, preset_snapshots):
    """Return an expanded prompt/workflow plus source-id aliases for path slicing."""
    if not isinstance(prompt, dict):
        raise ValueError("Scene Save Image の prompt が不正です。")
    if not isinstance(workflow, dict):
        raise ValueError("Scene Save Image の workflow が不正です。")
    expanded_prompt = copy.deepcopy(prompt)
    expanded_workflow = copy.deepcopy(workflow)
    source_ids = {str(node_id): str(node_id) for node_id in expanded_prompt}
    state = {"inserted": set(), "references": {}}
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
        preset = preset_snapshots.get(preset_id) if isinstance(preset_snapshots, dict) else None
        if not isinstance(preset, dict):
            raise ValueError(f"Preset「{preset_id or reference_id}」の実行開始時スナップショットがありません。")
        _inline_reference(expanded_prompt, expanded_workflow, reference_id, preset, source_ids, state)
    _rebuild_expanded_workflow_links(expanded_prompt, expanded_workflow, state)
    return expanded_prompt, expanded_workflow, source_ids
