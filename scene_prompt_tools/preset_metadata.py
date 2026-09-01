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
        result.append(copied)
    return result


def _inline_reference(prompt, workflow, reference_id, preset, source_ids):
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
    _replace_reference_links(prompt, reference_id, output)
    prompt.pop(reference_id, None)
    return output


def _rebuild_workflow_links(prompt, workflow):
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("Scene Save Image の workflow が不正です。")
    by_id = {str(node.get("id")): node for node in nodes if isinstance(node, dict) and node.get("id") is not None}
    missing = sorted(set(prompt) - set(by_id))
    if missing:
        raise ValueError("workflow にノードIDがありません: " + ", ".join(missing))
    for node in by_id.values():
        for slot in node.get("inputs", []) if isinstance(node.get("inputs"), list) else []:
            if isinstance(slot, dict):
                slot["link"] = None
        for slot in node.get("outputs", []) if isinstance(node.get("outputs"), list) else []:
            if isinstance(slot, dict):
                slot["links"] = []

    links = []
    link_id = 1
    for target_id, target in prompt.items():
        inputs = target.get("inputs") if isinstance(target, dict) else None
        if not isinstance(inputs, dict):
            continue
        target_node = by_id[target_id]
        target_inputs = target_node.setdefault("inputs", [])
        for input_name, value in inputs.items():
            if not _link(value):
                continue
            source_id, source_slot = str(value[0]), value[1]
            if source_id not in by_id:
                raise ValueError(f"展開後の接続先ノード #{source_id} がありません。")
            target_slot = next((index for index, slot in enumerate(target_inputs) if isinstance(slot, dict) and slot.get("name") == input_name), None)
            if target_slot is None:
                target_inputs.append({"name": input_name, "type": "*", "link": None})
                target_slot = len(target_inputs) - 1
            target_input = target_inputs[target_slot]
            target_input["link"] = link_id
            source_node = by_id[source_id]
            outputs = source_node.setdefault("outputs", [])
            while len(outputs) <= source_slot:
                outputs.append({"name": "output", "type": "*", "links": []})
            source_output = outputs[source_slot]
            if not isinstance(source_output.get("links"), list):
                source_output["links"] = []
            source_output["links"].append(link_id)
            link_type = target_input.get("type") or source_output.get("type") or "*"
            source_workflow_id = int(source_id) if source_id.isdigit() else source_id
            target_workflow_id = int(target_id) if target_id.isdigit() else target_id
            links.append([link_id, source_workflow_id, source_slot, target_workflow_id, target_slot, link_type])
            link_id += 1
    workflow["links"] = links
    numeric_ids = [int(node_id) for node_id in by_id if node_id.isdigit()]
    workflow["last_node_id"] = max(numeric_ids, default=0)
    workflow["last_link_id"] = link_id - 1


def expand_preset_references(prompt, workflow, preset_snapshots):
    """Return an expanded prompt/workflow plus source-id aliases for path slicing."""
    if not isinstance(prompt, dict):
        raise ValueError("Scene Save Image の prompt が不正です。")
    if not isinstance(workflow, dict):
        raise ValueError("Scene Save Image の workflow が不正です。")
    expanded_prompt = copy.deepcopy(prompt)
    expanded_workflow = copy.deepcopy(workflow)
    source_ids = {str(node_id): str(node_id) for node_id in expanded_prompt}
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
        _inline_reference(expanded_prompt, expanded_workflow, reference_id, preset, source_ids)
    _rebuild_workflow_links(expanded_prompt, expanded_workflow)
    return expanded_prompt, expanded_workflow, source_ids
