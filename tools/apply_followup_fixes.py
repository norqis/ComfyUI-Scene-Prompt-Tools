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
        raise RuntimeError(f"{path}: expected one match, got {count}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


# #37: old partially-migrated state can contain an index/text mismatch.
# Treat it as an explicit missing selection so the UI can repair it.
replace_once(
    "scene_prompt_tools/prompt.py",
    '''    missing = part.get("missing", False)\n    if "missing" in part and not isinstance(missing, bool):\n        raise ValueError(f"{label} missing must be a boolean.")\n    if not missing:\n        if part["index"] >= len(prompt_parts) or prompt_parts[part["index"]] != text:\n            raise ValueError(f"{label} does not match its prompt part.")\n    result = {"index": part["index"], "text": text}\n''',
    '''    missing = part.get("missing", False)\n    if "missing" in part and not isinstance(missing, bool):\n        raise ValueError(f"{label} missing must be a boolean.")\n    if not missing and (part["index"] >= len(prompt_parts) or prompt_parts[part["index"]] != text):\n        missing = True\n    result = {"index": part["index"], "text": text}\n''',
)
replace_once(
    "web/scene_prompt_state.js",
    '''    const missing = value.missing ?? false;\n    if (typeof missing !== "boolean") {\n        throw new Error(`${label} missing must be a boolean.`);\n    }\n    if (!missing && (value.index >= promptParts.length || promptParts[value.index] !== text)) {\n        throw new Error(`${label} does not match its prompt part.`);\n    }\n    const result = { index: value.index, text };\n    if (missing) result.missing = true;\n''',
    '''    let missing = value.missing ?? false;\n    if (typeof missing !== "boolean") {\n        throw new Error(`${label} missing must be a boolean.`);\n    }\n    if (!missing && (value.index >= promptParts.length || promptParts[value.index] !== text)) {\n        missing = true;\n    }\n    const result = { index: value.index, text };\n    if (missing) result.missing = true;\n''',
)
replace_once(
    "tests/test_prompt_choices.py",
    '''    assert _compose_prompt_parts("", state, "", False, 0) == ["alpha"]\n''',
    '''    assert _compose_prompt_parts("", state, "", False, 0) == ["alpha"]\n\n    mismatched = selection_item(\n        "alpha, gamma",\n        selected_parts=[{"index": 1, "text": "beta", "weight": 1.2}],\n    )\n    mismatched_state = json.dumps({"version": 1, "categories": {"Category": [mismatched]}})\n    repaired = _parse_selection_json(mismatched_state)["Category"][0]["selected_parts"][0]\n    assert repaired == {"index": 1, "text": "beta", "missing": True, "weight": 1.2}\n    assert _compose_prompt_parts("", mismatched_state, "", False, 0) == []\n''',
)

# #38: document and lock down the deterministic overlap policy.
replace_once(
    "scene_prompt_tools/nodes.py",
    '''def _model_prompt_weight(weight, model_mode):\n    value = float(weight)\n    mode = _normalize_model_mode(model_mode)\n''',
    '''def _model_prompt_weight(weight, model_mode):\n    # The ranges overlap, so values already inside the selected model's distinct\n    # range are left alone to avoid double conversion.  For Anima, Illustrious\n    # 1.0..1.5 is scaled by 5x around 1.0 and clamped at 3.0 (1.4 -> 3.0).\n    # For Illustrious, Anima-only >1.5..3.0 uses the inverse mapping. Values\n    # below 1.0, above 3.0, and negative weights are intentionally unchanged.\n    value = float(weight)\n    mode = _normalize_model_mode(model_mode)\n''',
)
replace_once(
    "tests/test_node_plan_semantics.py",
    '''        self.assertEqual(weighted_anima[1], "(bad hands:3)")\n        self.assertEqual(weighted_illustrious[1], "(bad_hands:1.4)")''',
    '''        self.assertEqual(weighted_anima[1], "(bad hands:3)")\n        self.assertEqual(weighted_illustrious[1], "(bad_hands:1.4)")\n\n        boundary = self.prompt.ScenePrompt().build(\n            "B", "(low:0.8), (already_anima:2), (high:4), (negative:-1.2), version 2.0",\n            '{"version":1,"categories":{}}', "", '{"version":1,"categories":{}}', "", 0, True,\n        )[0]\n        boundary_anima = expander.expand(current_index=0, seed_base=7, timestamp_dir=False, scene_prompt=boundary, model_mode="Anima")\n        self.assertEqual(\n            boundary_anima[0],\n            "(low:0.8), (already anima:2), (high:4), (negative:-1.2), version 2.0",\n        )\n''',
)

# #39: expose an explicit reload action; normal picker open remains cache-only.
replace_once(
    "web/scene_prompt_ui.js",
    '''    const popup = openPopupShell(node, "Scene Presetを選択", { hideReload: true, hideClear: true });\n    const list = document.createElement("div");''',
    '''    const popup = openPopupShell(node, "Scene Presetを選択", { hideReload: true, hideClear: true });\n    const toolbar = document.createElement("div");\n    toolbar.className = "pc-toolbar";\n    const reload = createButton("再読み込み");\n    reload.addEventListener("click", async () => {\n        const refreshed = await loadPopupRequest(\n            node,\n            () => refreshScenePresetReferenceList(node, true),\n            "Preset一覧を再取得できませんでした。",\n        );\n        if (!refreshed) return;\n        refreshAllScenePresetReferences(refreshed);\n        openScenePresetPicker(node);\n    });\n    toolbar.appendChild(reload);\n    popup.appendChild(toolbar);\n    const list = document.createElement("div");''',
)

# #36: exercise byte-preserving load followed by same-ID overwrite/revision bump.
replace_once(
    "tests/test_issue_regressions.py",
    '''    def test_legacy_expand_remains_disallowed_after_normalization(self):\n''',
    '''    def test_legacy_file_load_is_read_only_and_same_id_overwrite_bumps_revision(self):\n        raw = self.legacy_payload()\n        path = self.presets._preset_path("legacy", "default")\n        path.parent.mkdir(parents=True, exist_ok=True)\n        original_bytes = (json.dumps(raw, ensure_ascii=False, indent=2) + "\\n").encode("utf-8")\n        path.write_bytes(original_bytes)\n\n        loaded = self.presets.load_preset("legacy", "default")\n        self.assertEqual(loaded["api_graph"]["output"]["2"]["class_type"], "ScenePrompter")\n        self.assertEqual(path.read_bytes(), original_bytes)\n\n        current_graph = loaded["api_graph"]\n        current_workflow = loaded["workflow"]\n        saved = self.presets.save_preset({\n            "preset_id": "legacy",\n            "name": "Legacy",\n            "expected_revision": 1,\n            "output_node_id": "3",\n            "api_graph": current_graph,\n            "workflow": current_workflow,\n        }, "default")\n        self.assertEqual(saved["metadata"]["revision"], 2)\n        on_disk = json.loads(path.read_text(encoding="utf-8"))\n        self.assertEqual(on_disk["metadata"]["revision"], 2)\n        self.assertEqual(on_disk["api_graph"]["output"]["2"]["class_type"], "ScenePrompter")\n        self.assertEqual(on_disk["workflow"]["nodes"][1]["type"], "ScenePrompter")\n        self.assertEqual(\n            on_disk["metadata"]["sha256"],\n            self.presets._content_hash(on_disk["api_graph"], on_disk["workflow"]),\n        )\n\n    def test_legacy_expand_remains_disallowed_after_normalization(self):\n''',
)

print("Applied follow-up acceptance-condition fixes")
