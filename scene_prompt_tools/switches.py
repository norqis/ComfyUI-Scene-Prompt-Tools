"""Fixed Preset switch values and safe, side-effect-free control resolution."""

import json


SCENE_SWITCHES_TYPE = "SCENE_SWITCHES"
SWITCH_COUNT = 10
FALSE_SWITCHES = (False,) * SWITCH_COUNT
IDENTITY_SETTINGS = tuple(range(1, SWITCH_COUNT + 1))


def switch_values(value=None):
    if value is None:
        return FALSE_SWITCHES
    if not isinstance(value, (list, tuple)) or len(value) != SWITCH_COUNT or any(type(item) is not bool for item in value):
        raise ValueError("switches は10個のBoolean値が必要です。")
    return tuple(value)


def switch_binding(value=None):
    # Core API prompt validation interprets every JSON list as a node link.
    # Only the internal literal binding uses an object; bundles stay tuples.
    return switch_values(value["values"] if isinstance(value, dict) and "values" in value else value)


def _array(raw, field):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} のJSONが不正です。") from exc
    if not isinstance(value, list):
        raise ValueError(f"{field} は配列が必要です。")
    return value


def switch_names(raw="[]"):
    names = _array(raw, "switch_names_json")
    if len(names) > SWITCH_COUNT or any(not isinstance(name, str) for name in names):
        raise ValueError("スイッチ名は10個以内の文字列が必要です。")
    return tuple((names[index].strip() if index < len(names) else "") or f"スイッチ{index + 1}" for index in range(SWITCH_COUNT))


def make_switch_values(raw="[]"):
    values = _array(raw, "switch_values_json")
    return switch_values(values if values else None)


class ScenePromptMakeSwitch:
    DESCRIPTION = "10個のスイッチのON/OFFと名前を設定し、スイッチ一式としてScene Preset Referenceへ渡します。"
    CATEGORY = "Scene/control"
    RETURN_TYPES = (SCENE_SWITCHES_TYPE,)
    RETURN_NAMES = ("switches",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {
            "switch_names_json": ("STRING", {"default": "[]", "hidden": True}),
            "switch_values_json": ("STRING", {"default": "[]", "hidden": True}),
        }}

    def build(self, switch_names_json="[]", switch_values_json="[]"):
        switch_names(switch_names_json)
        return (make_switch_values(switch_values_json),)


def switch_settings(raw="[]"):
    settings = _array(raw, "switch_settings_json")
    if not settings:
        return IDENTITY_SETTINGS
    if len(settings) != SWITCH_COUNT or any(type(item) is not bool and (type(item) is not int or not 1 <= item <= SWITCH_COUNT) for item in settings):
        raise ValueError("スイッチ設定は10個のON/OFFまたは入力番号1..10が必要です。")
    return tuple(settings)


def resolve_switches(incoming=None, settings_json="[]"):
    incoming = switch_values(incoming)
    return tuple(item if type(item) is bool else incoming[item - 1] for item in switch_settings(settings_json))


def safe_control(nodes, raw, bindings=None):
    """Read known Boolean/bundle sources, never execute arbitrary providers."""
    bindings = bindings or {}
    seen = set()
    while isinstance(raw, (list, tuple)) and len(raw) == 2 and isinstance(raw[0], str) and type(raw[1]) is int:
        node_id, slot = raw
        if (node_id, slot) in seen:
            raise ValueError(f"スイッチ入力が循環しています: #{node_id}")
        seen.add((node_id, slot))
        node = nodes.get(node_id, {})
        inputs = node.get("inputs", {})
        kind = node.get("class_type")
        if kind == "ScenePromptMakeSwitch" and slot == 0:
            return make_switch_values(inputs.get("switch_values_json", "[]"))
        if kind == "ScenePresetInput" and 1 <= slot <= 11:
            vector = switch_binding(bindings.get(node_id, inputs.get("switch_values")))
            return vector if slot == 11 else vector[slot - 1]
        if kind == "PrimitiveBoolean" and slot == 0:
            raw = inputs.get("value")
            if isinstance(raw, str) and raw.lower() in {"true", "false"}:
                raw = raw.lower() == "true"
            break
        raise ValueError(f"スイッチ入力 #{node_id}:{slot} の値を安全に取得できません。")
    if type(raw) is bool:
        return raw
    if isinstance(raw, (list, tuple)):
        return switch_values(raw)
    raise ValueError("スイッチ入力にはBoolean値が必要です。")


def selected_switch_input(nodes, node, bindings=None):
    inputs = node.get("inputs", {})
    control = safe_control(nodes, inputs.get("switch"), bindings)
    if type(control) is not bool:
        raise ValueError("Switch の switch にはBoolean値が必要です。")
    return "on_true" if control else "on_false"
