from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def write(path, text):
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement):
    text = read(path)
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern[:80]!r}")
    write(path, next_text)


# Issue #37: tolerate and repair partial selections when candidate prompt parts move.
replace_once(
    "scene_prompt_tools/prompt.py",
    'SELECTED_PART_OPTIONAL_KEYS = {"weight"}',
    'SELECTED_PART_OPTIONAL_KEYS = {"weight", "missing"}',
)
replace_once(
    "scene_prompt_tools/prompt.py",
    '''                for selected_part in selected_parts:\n                    part_text = selected_part["text"]\n                    weight = _item_weight(selected_part)\n                    parts.extend(_apply_weight(part, weight) for part in _split_prompt(part_text))''',
    '''                for selected_part in selected_parts:\n                    if selected_part.get("missing") is True:\n                        continue\n                    part_text = selected_part["text"]\n                    weight = _item_weight(selected_part)\n                    parts.extend(_apply_weight(part, weight) for part in _split_prompt(part_text))''',
)
regex_once(
    "scene_prompt_tools/prompt.py",
    r'def _validate_selected_part\(part, prompt_parts, label\):\n.*?\n    return result\n',
    '''def _validate_selected_part(part, prompt_parts, label):
    _require_exact_keys(part, SELECTED_PART_REQUIRED_KEYS, SELECTED_PART_OPTIONAL_KEYS, label)
    if type(part["index"]) is not int or part["index"] < 0:
        raise ValueError(f"{label} index is invalid.")
    text = _require_nonempty_string(part["text"], f"{label} text")
    missing = part.get("missing", False)
    if "missing" in part and not isinstance(missing, bool):
        raise ValueError(f"{label} missing must be a boolean.")
    if not missing:
        if part["index"] >= len(prompt_parts) or prompt_parts[part["index"]] != text:
            raise ValueError(f"{label} does not match its prompt part.")
    result = {"index": part["index"], "text": text}
    if missing:
        result["missing"] = True
    if "weight" in part:
        result["weight"] = _validate_weight(part["weight"], f"{label} weight")
    return result
''',
)

replace_once(
    "web/scene_prompt_state.js",
    'const SELECTED_PART_OPTIONAL_KEYS = ["weight"];',
    'const SELECTED_PART_OPTIONAL_KEYS = ["weight", "missing"];',
)
regex_once(
    "web/scene_prompt_state.js",
    r'function parseSelectedPart\(value, promptParts, label\) \{\n.*?\n\}',
    '''function parseSelectedPart(value, promptParts, label) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object.`);
    }
    requireExactKeys(value, SELECTED_PART_REQUIRED_KEYS, SELECTED_PART_OPTIONAL_KEYS, label);
    if (!Number.isSafeInteger(value.index) || value.index < 0) {
        throw new Error(`${label} index is invalid.`);
    }
    const text = requireString(value.text, `${label} text`, { allowEmpty: false });
    const missing = value.missing ?? false;
    if (typeof missing !== "boolean") {
        throw new Error(`${label} missing must be a boolean.`);
    }
    if (!missing && (value.index >= promptParts.length || promptParts[value.index] !== text)) {
        throw new Error(`${label} does not match its prompt part.`);
    }
    const result = { index: value.index, text };
    if (missing) result.missing = true;
    if (Object.hasOwn(value, "weight")) {
        result.weight = requireWeight(value.weight, `${label} weight`);
    }
    return result;
}''',
)

regex_once(
    "web/scene_prompt_ui.js",
    r'function normalizedSelectedParts\(item, source = item\) \{\n.*?\n\}\n\nfunction itemHasPartSelection',
    '''function normalizedSelectedParts(item, source = item) {
    const parts = itemPromptParts(item);
    if (!parts.length || !Array.isArray(source?.selected_parts)) {
        return null;
    }

    if (!source.selected_parts.length) {
        throw new Error("選択済みのプロンプト要素が空です。");
    }
    const sourceParts = itemPromptParts(source);
    const used = new Set();
    const fallbackOccurrences = new Map();
    return source.selected_parts.map((raw) => {
        if (!raw || typeof raw !== "object" || !Number.isInteger(raw.index) || raw.index < 0
            || typeof raw.text !== "string" || !raw.text.trim()) {
            throw new Error("選択済みのプロンプト要素が不正です。");
        }
        if (Object.hasOwn(raw, "missing") && typeof raw.missing !== "boolean") {
            throw new Error("選択済みのプロンプト要素が不正です。");
        }
        const text = raw.text.trim();
        let occurrence = null;
        if (!raw.missing && raw.index < sourceParts.length && sourceParts[raw.index]?.text === text) {
            occurrence = sourceParts
                .slice(0, raw.index + 1)
                .filter((part) => part.text === text)
                .length - 1;
        }
        if (occurrence === null) {
            occurrence = fallbackOccurrences.get(text) || 0;
        }
        fallbackOccurrences.set(text, occurrence + 1);

        let matched = null;
        let seen = -1;
        for (const part of parts) {
            if (part.text !== text) {
                continue;
            }
            seen += 1;
            if (seen === occurrence && !used.has(part.index)) {
                matched = part;
                break;
            }
        }

        const selectedPart = matched
            ? { index: matched.index, text: matched.text }
            : { index: raw.index, text, missing: true };
        if (matched) {
            used.add(matched.index);
        }
        const stored = weightForStorage(raw.weight ?? 1);
        if (stored !== null) selectedPart.weight = stored;
        return selectedPart;
    });
}

function itemHasPartSelection''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''function itemHasPartialSelection(item) {\n    const selectedParts = normalizedSelectedParts(item, item);\n    return !!selectedParts && selectedParts.length < itemPromptParts(item).length;\n}''',
    '''function itemHasPartialSelection(item) {\n    const selectedParts = normalizedSelectedParts(item, item);\n    return !!selectedParts && (\n        selectedParts.some((part) => part.missing)\n        || selectedParts.filter((part) => !part.missing).length < itemPromptParts(item).length\n    );\n}''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''function itemForEditedState(updatedItem, previousItem) {\n    if (!Array.isArray(previousItem?.selected_parts)) {\n        return itemForState(updatedItem, previousItem);\n    }\n    if (updatedItem.prompt !== previousItem.prompt) {\n        throw new Error("一部選択されている候補は、選択を解除してからプロンプトを編集してください。");\n    }\n    return itemForState(updatedItem, previousItem);\n}''',
    '''function itemForEditedState(updatedItem, previousItem) {\n    return itemForState(updatedItem, previousItem);\n}''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''        return selectedParts\n            .map((part) => {''',
    '''        return selectedParts\n            .filter((part) => !part.missing)\n            .map((part) => {''',
)
regex_once(
    "web/scene_prompt_ui.js",
    r'function partSelectionsForItem\(item, selectedItem = null\) \{\n.*?\n\}\n\nfunction writeItemPartSelections',
    '''function partSelectionsForItem(item, selectedItem = null) {
    const parts = itemPromptParts(item);
    const selectedParts = normalizedSelectedParts(item, selectedItem);
    if (selectedParts) {
        const selectedMap = new Map(
            selectedParts.filter((part) => !part.missing).map((part) => [partKey(part), part]),
        );
        const current = parts.map((part) => {
            const selectedPart = selectedMap.get(partKey(part));
            return {
                ...part,
                checked: !!selectedPart,
                weight: selectedPart ? itemWeight(selectedPart) : 1,
            };
        });
        const missing = selectedParts
            .filter((part) => part.missing)
            .map((part) => ({ ...part, checked: true, weight: itemWeight(part) }));
        return [...current, ...missing];
    }

    const wholeSelected = !!selectedItem;
    const weight = wholeSelected ? itemWeight(selectedItem) : 1;
    return parts.map((part) => ({
        ...part,
        checked: wholeSelected,
        weight,
    }));
}

function writeItemPartSelections''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''    const checked = (selections || [])\n        .filter((part) => part.checked && allKeys.has(partKey(part)))\n        .map((part) => ({\n            index: part.index,\n            text: part.text,\n            weight: itemWeight(part),\n        }));''',
    '''    const checked = (selections || [])\n        .filter((part) => part.checked && (part.missing || allKeys.has(partKey(part))))\n        .map((part) => ({\n            index: part.index,\n            text: part.text,\n            ...(part.missing ? { missing: true } : {}),\n            weight: itemWeight(part),\n        }));''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''    const allChecked = checked.length === allParts.length;''',
    '''    const allChecked = !checked.some((part) => part.missing) && checked.length === allParts.length;''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''            const selectedPart = { index: part.index, text: part.text };\n            const stored = weightForStorage(part.weight);''',
    '''            const selectedPart = { index: part.index, text: part.text };\n            if (part.missing) selectedPart.missing = true;\n            const stored = weightForStorage(part.weight);''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''                index: part.index,\n                text: part.text,\n                weight: weightForStorage(part.weight),''',
    '''                index: part.index,\n                text: part.text,\n                missing: !!part.missing,\n                weight: weightForStorage(part.weight),''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''    text.textContent = partSelection.text;''',
    '''    text.textContent = partSelection.missing\n        ? `${partSelection.text}（現在の候補にありません）`\n        : partSelection.text;''',
)

# Preflight every affected workflow/Matrix state before mutating the prompt catalog.
replace_once(
    "web/scene_prompt_ui.js",
    '''function replacePromptItemEverywhere(originalItem, updatedItem) {''',
    '''function preflightPromptItemReplacement(node, originalItem, updatedItem, options = {}) {
    const originalCategory = itemCategoryKey(originalItem);
    const updatedCategory = itemCategoryKey(updatedItem);
    const originalKey = itemKey(originalItem);
    if (!originalCategory || !updatedCategory || !originalKey) {
        return;
    }

    const matrixLineContext = matrixLineDraftContextFor(node, options.stateWidgetName);
    if (matrixLineContext) {
        for (const side of ["positive", "negative"]) {
            replacePromptItemInState(
                matrixLineDraftSelectionState(matrixLineContext.draft, side),
                originalCategory,
                originalKey,
                updatedItem,
                updatedCategory,
            );
        }
    }

    for (const graphNode of graphNodes()) {
        if (isScenePromptNode(graphNode)) {
            for (const stateWidgetName of selectionStateWidgetNames(graphNode)) {
                replacePromptItemInState(
                    readStateFromWidget(graphNode, stateWidgetName),
                    originalCategory,
                    originalKey,
                    updatedItem,
                    updatedCategory,
                );
            }
        }
        if (isPromptMatrixNode(graphNode)) {
            replacePromptItemInMatrixState(
                readMatrixState(graphNode),
                originalCategory,
                originalKey,
                updatedItem,
                updatedCategory,
            );
        }
    }
}

function replacePromptItemEverywhere(originalItem, updatedItem) {''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''        try {\n            const updated = await updatePromptItem({''',
    '''        try {\n            const prospective = {\n                ...item,\n                label: nameInput.value,\n                prompt: promptInput.value,\n                description: descInput.value,\n            };\n            preflightPromptItemReplacement(node, item, prospective, { stateWidgetName });\n            const updated = await updatePromptItem({''',
)

# Issue #38: convert final weighted prompt syntax for the selected model mode.
replace_once(
    "scene_prompt_tools/nodes.py",
    '''MODEL_MODE_CHOICES = (MODEL_MODE_ILLUSTRIOUS, MODEL_MODE_ANIMA)\n''',
    '''MODEL_MODE_CHOICES = (MODEL_MODE_ILLUSTRIOUS, MODEL_MODE_ANIMA)\nMODEL_WEIGHT_RE = re.compile(r"(:\\s*)([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(?=\\s*\\))")\n''',
)
replace_once(
    "scene_prompt_tools/nodes.py",
    '''def _normalize_model_mode(value):\n    return MODEL_MODE_ANIMA if str(value or "").strip() == MODEL_MODE_ANIMA else MODEL_MODE_ILLUSTRIOUS\n''',
    '''def _normalize_model_mode(value):\n    return MODEL_MODE_ANIMA if str(value or "").strip() == MODEL_MODE_ANIMA else MODEL_MODE_ILLUSTRIOUS\n\n\ndef _model_prompt_weight(weight, model_mode):\n    value = float(weight)\n    mode = _normalize_model_mode(model_mode)\n    if mode == MODEL_MODE_ANIMA and 1.0 <= value <= 1.5:\n        return min(3.0, 1.0 + ((value - 1.0) * 5.0))\n    if mode == MODEL_MODE_ILLUSTRIOUS and 1.5 < value <= 3.0:\n        return 1.0 + ((value - 1.0) / 5.0)\n    return value\n\n\ndef _convert_model_prompt_weights(text, model_mode):\n    def replace(match):\n        raw = float(match.group(2))\n        converted = _model_prompt_weight(raw, model_mode)\n        if abs(converted - raw) < 0.0005:\n            return match.group(0)\n        return f"{match.group(1)}{converted:.3f}".rstrip("0").rstrip(".")\n\n    return MODEL_WEIGHT_RE.sub(replace, str(text or ""))\n''',
)
replace_once(
    "scene_prompt_tools/nodes.py",
    '''        positive = _join_unique(positive_parts, separator)\n        negative = _join_unique(negative_parts, separator)\n        if _normalize_model_mode(model_mode) == MODEL_MODE_ANIMA:\n            positive = positive.replace("_", " ")\n            negative = negative.replace("_", " ")''',
    '''        positive = _join_unique(positive_parts, separator)\n        negative = _join_unique(negative_parts, separator)\n        normalized_model = _normalize_model_mode(model_mode)\n        positive = _convert_model_prompt_weights(positive, normalized_model)\n        negative = _convert_model_prompt_weights(negative, normalized_model)\n        if normalized_model == MODEL_MODE_ANIMA:\n            positive = positive.replace("_", " ")\n            negative = negative.replace("_", " ")''',
)
replace_once(
    "scene_prompt_tools/nodes.py",
    '''            "exec_model": _normalize_model_mode(model_mode), "exec_seed": seed,''',
    '''            "exec_model": normalized_model, "exec_seed": seed,''',
)
replace_once(
    "scene_prompt_tools/nodes.py",
    '''        _dispatch_row_callbacks(row, item, seed, model_mode, run_handle, positive, negative, desktop_context=desktop_context)''',
    '''        _dispatch_row_callbacks(row, item, seed, normalized_model, run_handle, positive, negative, desktop_context=desktop_context)''',
)

# Issues #36/#39: normalize legacy Preset node IDs after raw integrity validation,
# and make the Preset list compact + cached without holding the global Preset lock.
replace_once(
    "scene_prompt_tools/presets.py",
    '''_PRESET_LOCK = threading.RLock()\n''',
    '''_PRESET_LOCK = threading.RLock()\n_PRESET_LIST_CACHE_LOCK = threading.RLock()\n_PRESET_LIST_CACHE = OrderedDict()\n_PRESET_LIST_CACHE_MAX_USERS = 64\n''',
)
replace_once(
    "scene_prompt_tools/presets.py",
    '''DEFAULT_SOURCE_NODE_NAMES = {''',
    '''LEGACY_PRESET_CLASS_TYPES = {\n    "ScenePrompt": "ScenePrompter",\n    "ScenePromptMerge": "ScenePrompterMerge",\n    "ScenePromptQueue": "ScenePrompterQueue",\n    "ScenePromptExpand": "ScenePrompterExpand",\n}\n\nDEFAULT_SOURCE_NODE_NAMES = {''',
)
insert_marker = '''def _preset_path(preset_id, user_id="default"):\n    return preset_directory(user_id) / f"{_clean_preset_id(preset_id)}{PRESET_FILE_SUFFIX}"\n'''
replace_once(
    "scene_prompt_tools/presets.py",
    insert_marker,
    insert_marker + '''\n\ndef _normalize_legacy_preset_ids(preset):\n    normalized = copy.deepcopy(preset)\n    nodes = ((normalized.get("api_graph") or {}).get("output") if isinstance(normalized, dict) else None)\n    if isinstance(nodes, dict):\n        for node in nodes.values():\n            if not isinstance(node, dict):\n                continue\n            class_type = node.get("class_type")\n            if class_type in LEGACY_PRESET_CLASS_TYPES:\n                node["class_type"] = LEGACY_PRESET_CLASS_TYPES[class_type]\n\n    workflow_nodes = ((normalized.get("workflow") or {}).get("nodes") if isinstance(normalized, dict) else None)\n    if isinstance(workflow_nodes, list):\n        for node in workflow_nodes:\n            if not isinstance(node, dict):\n                continue\n            node_type = node.get("type")\n            if node_type in LEGACY_PRESET_CLASS_TYPES:\n                node["type"] = LEGACY_PRESET_CLASS_TYPES[node_type]\n            properties = node.get("properties")\n            if isinstance(properties, dict):\n                search_name = properties.get("Node name for S&R")\n                if search_name in LEGACY_PRESET_CLASS_TYPES:\n                    properties["Node name for S&R"] = LEGACY_PRESET_CLASS_TYPES[search_name]\n    return normalized\n\n\ndef _preset_directory_signature(directory):\n    if not directory.exists():\n        return ()\n    signature = []\n    for path in sorted(directory.glob(f"*{PRESET_FILE_SUFFIX}"), key=lambda item: item.name.lower()):\n        try:\n            stat = path.stat()\n        except OSError:\n            continue\n        signature.append((path.name, stat.st_mtime_ns, stat.st_size))\n    return tuple(signature)\n\n\ndef _invalidate_preset_list_cache(user_id="default"):\n    with _PRESET_LIST_CACHE_LOCK:\n        _PRESET_LIST_CACHE.pop(str(user_id or "default"), None)\n\n\ndef _compact_matrix_json(value):\n    if not isinstance(value, str):\n        return value\n    try:\n        parsed = json.loads(value)\n    except (TypeError, ValueError):\n        return value\n    sets = parsed.get("sets") if isinstance(parsed, dict) else None\n    if not isinstance(sets, list):\n        return value\n    compact = []\n    for index, line in enumerate(sets):\n        if not isinstance(line, dict):\n            return value\n        name = str(line.get("name") or f"row-{index + 1}")\n        compact.append({\n            "row_id": str(line.get("row_id") or f"row-{index + 1}"),\n            "name": name,\n            "path_label": str(line.get("path_label") or name),\n            "enabled": line.get("enabled", True) is not False,\n        })\n    return json.dumps({"version": 1, "sets": compact}, ensure_ascii=False, separators=(",", ":"))\n\n\ndef _compact_preset_list_graph(api_graph):\n    nodes = api_graph.get("output") if isinstance(api_graph, dict) else None\n    if not isinstance(nodes, dict):\n        return copy.deepcopy(api_graph)\n    compact_nodes = {}\n    scalar_inputs = {"matrix_json", "batch_size", "count", "preset_id"}\n    for node_id, node in nodes.items():\n        if not isinstance(node, dict):\n            continue\n        inputs = {}\n        for name, value in _node_inputs(node).items():\n            if is_link(value):\n                inputs[name] = copy.deepcopy(value)\n            elif name in scalar_inputs:\n                inputs[name] = _compact_matrix_json(value) if name == "matrix_json" else copy.deepcopy(value)\n        compact_nodes[str(node_id)] = {"class_type": node.get("class_type"), "inputs": inputs}\n    return {"output": compact_nodes}\n''',
)
regex_once(
    "scene_prompt_tools/presets.py",
    r'def _validate_preset_payload\(preset\):\n.*?\n\n\ndef load_preset',
    '''def _validate_preset_payload(preset):
    metadata = preset.get("metadata") if isinstance(preset, dict) else None
    if not isinstance(metadata, dict):
        raise ScenePresetError("Presetのメタデータが不正です。")
    if preset.get("schema_version") != PRESET_SCHEMA_VERSION:
        raise ScenePresetError("Presetの形式が対応していません。")
    _clean_preset_id(metadata.get("preset_id"))
    revision = metadata.get("revision")
    if not isinstance(revision, int) or revision < 1:
        raise ScenePresetError("Presetのrevisionが不正です。")
    expected_hash = _content_hash(preset.get("api_graph"), preset.get("workflow"))
    if str(metadata.get("sha256") or "") != expected_hash:
        raise ScenePresetError("Presetの内容が壊れているか、hashが一致しません。")

    normalized = _normalize_legacy_preset_ids(preset)
    preset.clear()
    preset.update(normalized)
    name = str(metadata.get("name") or metadata.get("preset_id"))
    try:
        nodes = _preset_nodes(preset)
        _validate_workflow_nodes(preset.get("workflow"), nodes)
        return _validate_preset_graph(nodes)
    except ScenePresetError as exc:
        raise ScenePresetError(f"Preset「{name}」: {exc}") from exc


def load_preset''',
)
replace_once(
    "scene_prompt_tools/presets.py",
    '''            os.replace(temp_name, path)\n        finally:''',
    '''            os.replace(temp_name, path)\n            _invalidate_preset_list_cache(user_id)\n        finally:''',
)
regex_once(
    "scene_prompt_tools/presets.py",
    r'def list_presets\(user_id="default"\):\n.*?\n\n\ndef _replace_link',
    '''def list_presets(user_id="default"):
    directory = preset_directory(user_id)
    user_key = str(user_id or "default")
    while True:
        signature = _preset_directory_signature(directory)
        with _PRESET_LIST_CACHE_LOCK:
            cached = _PRESET_LIST_CACHE.get(user_key)
            if cached and cached.get("signature") == signature:
                _PRESET_LIST_CACHE.move_to_end(user_key)
                return copy.deepcopy(cached["value"])
            previous_files = dict((cached or {}).get("files") or {})

        presets = []
        errors = []
        next_files = {}
        for filename, mtime_ns, size in signature:
            file_signature = (mtime_ns, size)
            cached_file = previous_files.get(filename)
            if cached_file and cached_file.get("signature") == file_signature:
                entry = copy.deepcopy(cached_file.get("entry"))
                error = copy.deepcopy(cached_file.get("error"))
            else:
                path = directory / filename
                try:
                    preset = load_preset(path.stem, user_id)
                    entry = {
                        "metadata": copy.deepcopy(preset["metadata"]),
                        "api_graph": _compact_preset_list_graph(preset["api_graph"]),
                    }
                    error = None
                except ScenePresetError as exc:
                    entry = None
                    error = {"preset_id": path.stem, "error": str(exc)}
            next_files[filename] = {
                "signature": file_signature,
                "entry": copy.deepcopy(entry),
                "error": copy.deepcopy(error),
            }
            if entry is not None:
                presets.append(entry)
            if error is not None:
                errors.append(error)

        if signature != _preset_directory_signature(directory):
            continue
        value = {"presets": presets, "errors": errors}
        with _PRESET_LIST_CACHE_LOCK:
            _PRESET_LIST_CACHE[user_key] = {
                "signature": signature,
                "files": next_files,
                "value": copy.deepcopy(value),
            }
            _PRESET_LIST_CACHE.move_to_end(user_key)
            while len(_PRESET_LIST_CACHE) > _PRESET_LIST_CACHE_MAX_USERS:
                _PRESET_LIST_CACHE.popitem(last=False)
        return value


def _replace_link''',
)

# Issue #39 frontend: share in-flight/cache and do not force reload per Reference node/picker.
replace_once(
    "web/scene_prompt_ui.js",
    '''    if (!force && scenePresetListPromise) {\n        return scenePresetListPromise;\n    }''',
    '''    if (scenePresetListPromise) {\n        return scenePresetListPromise;\n    }''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''        () => refreshScenePresetReferenceList(node, true),''',
    '''        () => refreshScenePresetReferenceList(node, false),''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''            refreshScenePresetReferenceList(node, true).catch((error) => console.warn("[Scene Prompt]", error));''',
    '''            refreshScenePresetReference(node, scenePresetList || []);''',
)
replace_once(
    "web/scene_prompt_ui.js",
    '''    refreshScenePresetReferenceList(node, true).catch((error) => console.warn("[Scene Prompt]", error));''',
    '''    refreshScenePresetReferenceList(node, false).catch((error) => console.warn("[Scene Prompt]", error));''',
)

# Regression coverage for backend missing selections and model weights.
replace_once(
    "tests/test_prompt_choices.py",
    '''def test_selection_keeps_its_stored_prompt_and_partial_selection():\n    previous = selection_item("alpha, beta", selected_parts=[{"index": 1, "text": "beta", "weight": 1.2}])\n    parsed = _parse_selection_json(json.dumps({"version": 1, "categories": {"Category": [previous]}}))\n    assert parsed["Category"][0]["prompt"] == "alpha, beta"\n    selected = parsed["Category"][0]["selected_parts"]\n    assert selected == [{"index": 1, "text": "beta", "weight": 1.2}]\n''',
    '''def test_selection_keeps_its_stored_prompt_and_partial_selection():\n    previous = selection_item("alpha, beta", selected_parts=[{"index": 1, "text": "beta", "weight": 1.2}])\n    parsed = _parse_selection_json(json.dumps({"version": 1, "categories": {"Category": [previous]}}))\n    assert parsed["Category"][0]["prompt"] == "alpha, beta"\n    selected = parsed["Category"][0]["selected_parts"]\n    assert selected == [{"index": 1, "text": "beta", "weight": 1.2}]\n\n\ndef test_missing_partial_selection_is_valid_but_not_emitted():\n    item = selection_item(\n        "alpha, gamma",\n        selected_parts=[\n            {"index": 0, "text": "alpha"},\n            {"index": 1, "text": "beta", "missing": True, "weight": 1.2},\n        ],\n    )\n    state = json.dumps({"version": 1, "categories": {"Category": [item]}})\n    parsed = _parse_selection_json(state)["Category"][0]\n    assert parsed["selected_parts"][1] == {"index": 1, "text": "beta", "missing": True, "weight": 1.2}\n    assert _compose_prompt_parts("", state, "", False, 0) == ["alpha"]\n''',
)
replace_once(
    "tests/test_prompt_choices.py",
    '''        test_selection_keeps_its_stored_prompt_and_partial_selection()''',
    '''        test_selection_keeps_its_stored_prompt_and_partial_selection()\n        test_missing_partial_selection_is_valid_but_not_emitted()''',
)
replace_once(
    "tests/test_node_plan_semantics.py",
    '''        self.assertEqual(anima[0], "blue hair, score 7")\n        self.assertEqual(anima[1], "bad hands")''',
    '''        self.assertEqual(anima[0], "blue hair, score 7")\n        self.assertEqual(anima[1], "bad hands")\n\n        weighted = self.prompt.ScenePrompt().build(\n            "W", "(blue_hair:1.4), ((eyes:1.2):0.8)", '{"version":1,"categories":{}}',\n            "(bad_hands:3)", '{"version":1,"categories":{}}', "", 0, True,\n        )[0]\n        weighted_anima = expander.expand(current_index=0, seed_base=7, timestamp_dir=False, scene_prompt=weighted, model_mode="Anima")\n        weighted_illustrious = expander.expand(current_index=0, seed_base=7, timestamp_dir=False, scene_prompt=weighted, model_mode="Illustrious")\n        self.assertEqual(weighted_anima[0], "(blue hair:3), ((eyes:2):0.8)")\n        self.assertEqual(weighted_anima[1], "(bad hands:3)")\n        self.assertEqual(weighted_illustrious[1], "(bad_hands:1.4)")''',
)

# Extend the focused frontend normalization harness.
replace_once(
    "tests/test_scene_prompt_selection_normalization.cjs",
    '''    "normalizedSelectedParts",\n    "itemForState",''',
    '''    "normalizedSelectedParts",\n    "itemForState",\n    "itemForEditedState",''',
)
replace_once(
    "tests/test_scene_prompt_selection_normalization.cjs",
    '''console.log("Scene Prompt selection normalization tests passed.");''',
    '''const movedOld = {\n    ...candidate("stable", "Moved", "alpha, beta, alpha"),\n    selected_parts: [{ index: 2, text: "alpha", weight: 1.25 }],\n};\nconst movedCurrent = candidate("stable", "Moved", "alpha, alpha, beta, added");\nconst moved = context.itemForEditedState(movedCurrent, movedOld);\nassert.deepEqual(\n    JSON.parse(JSON.stringify(moved.selected_parts)),\n    [{ index: 1, text: "alpha", weight: 1.25 }],\n    "duplicate prompt parts remap by text occurrence order",\n);\n\nconst removedOld = {\n    ...candidate("stable", "Removed", "alpha, beta, gamma"),\n    selected_parts: [{ index: 1, text: "beta", weight: 1.2 }],\n};\nconst removedCurrent = candidate("stable", "Removed", "gamma, alpha");\nconst removed = context.itemForEditedState(removedCurrent, removedOld);\nassert.deepEqual(\n    JSON.parse(JSON.stringify(removed.selected_parts)),\n    [{ index: 1, text: "beta", missing: true, weight: 1.2 }],\n    "a deleted selected part is retained as an explicit missing selection",\n);\n\nconst reorderedOld = {\n    ...candidate("stable", "Reordered", "alpha, beta, gamma"),\n    selected_parts: [{ index: 0, text: "alpha" }, { index: 2, text: "gamma" }],\n};\nconst reorderedCurrent = candidate("stable", "Reordered", "gamma, added, alpha, beta");\nconst reordered = context.itemForEditedState(reorderedCurrent, reorderedOld);\nassert.deepEqual(\n    JSON.parse(JSON.stringify(reordered.selected_parts)),\n    [{ index: 2, text: "alpha" }, { index: 0, text: "gamma" }],\n    "reordering and additions preserve selected parts",\n);\n\nconsole.log("Scene Prompt selection normalization tests passed.");''',
)

# Dedicated Preset compatibility/compact-list unit coverage.
issue_test = r'''import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()
ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"


def load_presets(root):
    install_comfy_execution_stub()
    comfy = types.ModuleType("comfy")
    management = types.ModuleType("comfy.model_management")
    management.intermediate_device = lambda: "cpu"
    management.intermediate_dtype = lambda: torch.float32
    comfy.model_management = management
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: str(root / "output")
    folder_paths.get_user_directory = lambda: str(root / "user")
    folder_paths.get_public_user_directory = lambda user_id: str(root / "user" / user_id)
    sys.modules.update({
        "comfy": comfy,
        "comfy.model_management": management,
        "comfy.cli_args": cli_args,
        "folder_paths": folder_paths,
    })
    package_name = "scene_issue_regression_test"
    for name in list(sys.modules):
        if name == package_name or name.startswith(f"{package_name}."):
            del sys.modules[name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    return importlib.import_module(f"{package_name}.presets")


def prompt_inputs(upstream):
    return {
        "scene_prompt": upstream,
        "prompt_name": "Legacy",
        "positive_base": "alpha",
        "positive_json": '{"version":1,"categories":{}}',
        "negative_base": "",
        "negative_json": '{"version":1,"categories":{}}',
        "category_order": "",
        "seed": 0,
        "randomize": True,
    }


def workflow_for(nodes):
    return {
        "nodes": [
            {
                "id": int(node_id),
                "type": node["class_type"],
                "properties": {"Node name for S&R": node["class_type"]},
            }
            for node_id, node in nodes.items()
        ],
        "links": [],
        "groups": [],
    }


class OpenIssueRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.presets = load_presets(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def legacy_payload(self, middle_type="ScenePrompt"):
        nodes = {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": middle_type, "inputs": prompt_inputs(["1", 0]) if middle_type == "ScenePrompt" else {"scene_prompt": ["1", 0]}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
        }
        workflow = workflow_for(nodes)
        api_graph = {"output": nodes}
        return {
            "schema_version": 1,
            "metadata": {
                "preset_id": "legacy",
                "name": "Legacy",
                "revision": 1,
                "sha256": self.presets._content_hash(api_graph, workflow),
            },
            "api_graph": api_graph,
            "workflow": workflow,
        }

    def test_legacy_ids_normalize_only_after_raw_hash_validation(self):
        payload = self.legacy_payload()
        original_hash = payload["metadata"]["sha256"]
        self.presets._validate_preset_payload(payload)
        self.assertEqual(payload["api_graph"]["output"]["2"]["class_type"], "ScenePrompter")
        self.assertEqual(payload["workflow"]["nodes"][1]["type"], "ScenePrompter")
        self.assertEqual(payload["workflow"]["nodes"][1]["properties"]["Node name for S&R"], "ScenePrompter")
        self.assertEqual(payload["metadata"]["sha256"], original_hash)

        corrupted = self.legacy_payload()
        corrupted["api_graph"]["output"]["2"]["inputs"]["positive_base"] = "tampered"
        with self.assertRaisesRegex(self.presets.ScenePresetError, "hash"):
            self.presets._validate_preset_payload(corrupted)

    def test_legacy_expand_remains_disallowed_after_normalization(self):
        payload = self.legacy_payload("ScenePromptExpand")
        with self.assertRaises(self.presets.ScenePresetError):
            self.presets._validate_preset_payload(payload)
        self.assertEqual(payload["api_graph"]["output"]["2"]["class_type"], "ScenePrompterExpand")

    def test_compact_preset_list_graph_removes_matrix_selection_payloads(self):
        matrix = {
            "version": 1,
            "sets": [
                {
                    "row_id": "r1",
                    "name": "one",
                    "path_label": "one",
                    "enabled": True,
                    "positive_json": "x" * 10000,
                },
                {
                    "row_id": "r2",
                    "name": "two",
                    "path_label": "two",
                    "enabled": False,
                    "negative_json": "y" * 10000,
                },
            ],
        }
        graph = {"output": {
            "1": {"class_type": "ScenePresetInput", "inputs": {}},
            "2": {"class_type": "SceneMatrix", "inputs": {"scene_prompt": ["1", 0], "matrix_json": json.dumps(matrix)}},
            "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
        }}
        compact = self.presets._compact_preset_list_graph(graph)
        encoded = compact["output"]["2"]["inputs"]["matrix_json"]
        self.assertLess(len(encoded), 500)
        parsed = json.loads(encoded)
        self.assertEqual([line["enabled"] for line in parsed["sets"]], [True, False])


if __name__ == "__main__":
    unittest.main()
'''
write("tests/test_issue_regressions.py", issue_test)

print("Applied fixes for issues #36-#39")
