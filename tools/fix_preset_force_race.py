from pathlib import Path

path = Path("web/scene_prompt_ui.js")
text = path.read_text(encoding="utf-8")
old = """    if (scenePresetListPromise) {\n        return scenePresetListPromise;\n    }"""
new = """    if (!force && scenePresetListPromise) {\n        return scenePresetListPromise;\n    }"""
if text.count(old) != 1:
    raise RuntimeError(f"expected one preset promise guard, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Restored explicit-refresh race semantics while normal loads keep sharing in-flight requests")
