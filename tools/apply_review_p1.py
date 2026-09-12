from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

presets_path = ROOT / "scene_prompt_tools" / "presets.py"
presets = presets_path.read_text(encoding="utf-8")
old = '''    normalized = _normalize_legacy_preset_ids(preset)\n    preset.clear()\n    preset.update(normalized)\n    name = str(metadata.get("name") or metadata.get("preset_id"))\n'''
new = '''    normalized = _normalize_legacy_preset_ids(preset)\n    normalized_metadata = normalized.get("metadata")\n    if not isinstance(normalized_metadata, dict):\n        raise ScenePresetError("Presetのメタデータが不正です。")\n    normalized_metadata["sha256"] = _content_hash(\n        normalized.get("api_graph"),\n        normalized.get("workflow"),\n    )\n    preset.clear()\n    preset.update(normalized)\n    metadata = normalized_metadata\n    name = str(metadata.get("name") or metadata.get("preset_id"))\n'''
if old not in presets:
    raise SystemExit("presets.py target block not found")
presets_path.write_text(presets.replace(old, new, 1), encoding="utf-8")

test_path = ROOT / "tests" / "test_issue_regressions.py"
tests = test_path.read_text(encoding="utf-8")
old_assert = '''        self.assertEqual(payload["workflow"]["nodes"][1]["properties"]["Node name for S&R"], "ScenePrompter")\n        self.assertEqual(payload["metadata"]["sha256"], original_hash)\n\n        corrupted = self.legacy_payload()\n'''
new_assert = '''        self.assertEqual(payload["workflow"]["nodes"][1]["properties"]["Node name for S&R"], "ScenePrompter")\n        self.assertNotEqual(payload["metadata"]["sha256"], original_hash)\n        self.assertEqual(\n            payload["metadata"]["sha256"],\n            self.presets._content_hash(payload["api_graph"], payload["workflow"]),\n        )\n\n        corrupted = self.legacy_payload()\n'''
if old_assert not in tests:
    raise SystemExit("test hash assertion target not found")
tests = tests.replace(old_assert, new_assert, 1)

anchor = '''    def test_legacy_expand_remains_disallowed_after_normalization(self):\n'''
new_test = '''    def test_legacy_reference_expansion_uses_normalized_in_memory_hash(self):\n        raw = self.legacy_payload()\n        path = self.presets._preset_path("legacy", "default")\n        path.parent.mkdir(parents=True, exist_ok=True)\n        original_bytes = (json.dumps(raw, ensure_ascii=False, indent=2) + "\\n").encode("utf-8")\n        path.write_bytes(original_bytes)\n\n        expanded = self.presets.expand_preset_reference("legacy")\n        self.assertIn("result", expanded)\n        self.assertIn("expand", expanded)\n        self.assertEqual(path.read_bytes(), original_bytes)\n\n        loaded = self.presets.load_preset("legacy", "default")\n        self.assertEqual(\n            loaded["metadata"]["sha256"],\n            self.presets._content_hash(loaded["api_graph"], loaded["workflow"]),\n        )\n\n'''
if anchor not in tests:
    raise SystemExit("test insertion anchor not found")
tests = tests.replace(anchor, new_test + anchor, 1)
test_path.write_text(tests, encoding="utf-8")

print("Applied PR #40 review P1 fix and regression coverage")
