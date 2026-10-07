// Preset switches carry values only. Names never participate in branch selection.
const switchCount = 10;
const className = (node) => node?.comfyClass || node?.class_type || node?.type || "";
const field = (node, name) => (node?.widgets || []).find((widget) => widget.name === name)?.value;
const parseArray = (raw) => {
    const value = typeof raw === "string" ? JSON.parse(raw || "[]") : raw ?? [];
    if (!Array.isArray(value)) throw new Error("スイッチ設定は配列で指定してください。");
    return value;
};

export function sceneSwitchValues(raw) {
    if (raw == null) return Array(switchCount).fill(false);
    if (!Array.isArray(raw) || raw.length !== switchCount || raw.some((value) => typeof value !== "boolean"))
        throw new Error("スイッチの入力値は10個のBooleanで指定してください。");
    return raw;
}

export function sceneSwitchNames(raw) {
    const names = parseArray(raw);
    if (names.length > switchCount || names.some((name) => typeof name !== "string"))
        throw new Error("スイッチ名は10個までの文字列で指定してください。");
    return Array.from({ length: switchCount }, (_, index) => names[index]?.trim() || `スイッチ${index + 1}`);
}

export function sceneSwitchSettings(raw) {
    const settings = parseArray(raw);
    if (!settings.length) return Array.from({ length: switchCount }, (_, index) => index + 1);
    if (settings.length !== switchCount || settings.some((value) => typeof value !== "boolean"
        && !(Number.isInteger(value) && value >= 1 && value <= switchCount)))
        throw new Error("スイッチ設定はON/OFFまたは入力スイッチ1〜10で指定してください。");
    return settings;
}

export function resolveSceneSwitchSettings(incoming, raw) {
    const values = sceneSwitchValues(incoming);
    return sceneSwitchSettings(raw).map((setting) => typeof setting === "boolean" ? setting : values[setting - 1]);
}

export function isSceneSwitch(node) {
    return className(node) === "ComfySwitchNode";
}

export function sceneLiveSwitchSource(node, inputName) {
    const graph = node?.graph;
    const input = (node?.inputs || []).find((entry) => entry.name === inputName);
    let link = graph?.links?.[input?.link];
    const seen = new Set();
    while (link) {
        const source = graph.getNodeById(link.origin_id);
        if (!source || seen.has(source) || Number(source.mode) === 2) return null;
        seen.add(source);
        const slot = Number(link.origin_slot) || 0;
        if (className(source) === "Reroute" || Number(source.mode) === 4) {
            const type = source.outputs?.[slot]?.type;
            const upstream = (source.inputs || []).find((entry) => entry.link != null
                && (className(source) === "Reroute" || entry.type === type));
            link = graph.links?.[upstream?.link];
        } else return { source, slot };
    }
    return null;
}

export function sceneLiveSwitchValue(node, inputName, kind) {
    const input = (node?.inputs || []).find((entry) => entry.name === inputName);
    if (input?.link == null) return undefined;
    const resolved = sceneLiveSwitchSource(node, inputName);
    if (!resolved) return null;
    const { source, slot } = resolved, type = className(source);
    if (["ScenePresetInput", "Scene Preset Input"].includes(type)) {
        const binding = field(source, "switch_values");
        const values = sceneSwitchValues(binding?.values ?? binding ?? source.properties?.scene_switch_values);
        if (kind === "bundle" && slot === 11) return values;
        if (kind === "boolean" && slot >= 1 && slot <= switchCount) return values[slot - 1];
        return null;
    }
    const supported = kind === "boolean" ? ["PrimitiveBoolean", "PrimitiveNode"]
        : kind === "string" ? ["PrimitiveString", "PrimitiveStringMultiline", "PrimitiveNode"]
            : ["PrimitiveInt", "PrimitiveFloat", "PrimitiveNode"];
    if (slot !== 0 || !supported.includes(type) || (source.inputs || []).some((entry) => entry.name === "value" && entry.link != null)) return null;
    const value = field(source, "value");
    if (kind === "boolean") return typeof value === "boolean" ? value : null;
    if (kind === "string") return typeof value === "string" ? value : null;
    return kind === "number" && typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sceneLiveSwitchSelection(node) {
    const linked = sceneLiveSwitchValue(node, "switch", "boolean");
    const value = linked === undefined ? field(node, "switch") : linked;
    if (typeof value !== "boolean") throw new Error("スイッチの接続されたBooleanを確定できません。PrimitiveBooleanまたはPresetのスイッチを接続してください。");
    return value ? "on_true" : "on_false";
}

export function sceneLiveReferenceSwitchValues(node) {
    const incoming = sceneLiveSwitchValue(node, "switches", "bundle");
    if (incoming === null) throw new Error("接続されたスイッチ入力を確定できません。Preset Inputのswitchesを接続してください。");
    return resolveSceneSwitchSettings(incoming, field(node, "switch_settings_json"));
}

export function createScenePresetSwitchContext(nodes, incoming) {
    const values = sceneSwitchValues(incoming), memo = new Map(), visiting = new Set();
    const linked = (raw) => Array.isArray(raw) && raw.length === 2 && typeof raw[1] === "number";
    function value(raw, kind) {
        if (!linked(raw)) return raw;
        const [id, slot] = raw, key = `${id}:${slot}:${kind}`;
        if (memo.has(key)) return memo.get(key);
        if (visiting.has(key)) throw new Error("スイッチ入力が循環しています。");
        visiting.add(key);
        const node = nodes[String(id)];
        let result;
        if (node?.class_type === "ScenePresetInput") {
            const binding = node.inputs?.switch_values;
            const bound = incoming === undefined && binding != null ? sceneSwitchValues(binding.values ?? binding) : values;
            if (kind === "bundle" && slot === 11) result = bound;
            else if (kind === "boolean" && slot >= 1 && slot <= switchCount) result = bound[slot - 1];
        } else if (slot === 0 && (kind === "boolean" ? ["PrimitiveBoolean", "PrimitiveNode"]
            : kind === "string" ? ["PrimitiveString", "PrimitiveStringMultiline", "PrimitiveNode"]
                : ["PrimitiveInt", "PrimitiveFloat", "PrimitiveNode"]).includes(node?.class_type)) {
            result = node.inputs?.value;
        }
        visiting.delete(key);
        if (result === undefined || linked(result)) throw new Error("接続されたスイッチ・Primitiveの値を確定できません。");
        memo.set(key, result);
        return result;
    }
    function scalar(node, name, kind, fallback) {
        const result = value(node.inputs?.[name] ?? fallback, kind);
        if (kind === "number" ? typeof result !== "number" || !Number.isFinite(result) : typeof result !== kind)
            throw new Error(`接続された${name}の値を確定できません。`);
        return result;
    }
    return {
        selection: (node) => scalar(node, "switch", "boolean", false) ? "on_true" : "on_false",
        scalar,
        childValues(node) {
            const raw = node.inputs?.switches;
            return resolveSceneSwitchSettings(raw == null ? undefined : value(raw, "bundle"), node.inputs?.switch_settings_json);
        },
    };
}
