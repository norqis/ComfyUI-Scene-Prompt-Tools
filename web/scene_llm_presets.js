// Instance-local Preset definitions. Preparation happens on load/change, never in draw.
const cache = new WeakMap();
const contexts = new WeakMap();
const EMPTY = '{"version":1,"presets":{}}';
const field = (node, name) => node?.widgets?.find((widget) => widget.name === name);
const copy = (value) => JSON.parse(JSON.stringify(value));
const pathJoin = (path, id) => path === "." ? String(id) : `${path}/${id}`;

export function parsePresetOverrides(serialized) {
    if (!serialized) return {};
    const state = JSON.parse(String(serialized));
    if (state && !Array.isArray(state) && Object.keys(state).length === 0) return {};
    if (state?.version !== 1 || !state.presets || typeof state.presets !== "object" || Array.isArray(state.presets))
        throw new Error("Preset instance state is invalid.");
    for (const [path, definition] of Object.entries(state.presets)) {
        if (!(path === "." || path.split("/").every((part) => part && part !== "." && part !== "..")) || !definition?.metadata?.preset_id
            || !definition?.api_graph?.output || !Array.isArray(definition?.workflow?.nodes))
            throw new Error("Preset instance definition is invalid.");
    }
    return state.presets;
}

export function preparePresetReference(reference, definitions) {
    const serialized = String(field(reference, "llm_presets_json")?.value || "");
    const presetId = String(field(reference, "preset_id")?.value || "");
    const previous = cache.get(reference);
    if (previous?.serialized === serialized && previous.presetId === presetId && previous.definitions === definitions)
        return previous;
    let overrides, error = null;
    try { overrides = parsePresetOverrides(serialized); } catch (failure) { overrides = {}; error = failure; }
    const prepared = { serialized, presetId, definitions, overrides, occurrences: new Map(), localPaths: new Set(), error,
        revision: (previous?.revision || 0) + 1 };
    function prepare(id, path, inherited, stack) {
        if (stack.has(id)) return null;
        const definition = inherited["."] || definitions.get(id);
        if (!definition || String(definition.metadata?.preset_id) !== id) return null;
        const preset = { ...definition };
        if (inherited["."]) prepared.localPaths.add(path);
        const children = new Map();
        Object.defineProperty(preset, "scenePresetChildren", { value: children });
        prepared.occurrences.set(path, preset);
        contexts.set(preset, { prepared, path, children });
        const nextStack = new Set(stack).add(id);
        for (const [nodeId, entry] of Object.entries(definition.api_graph.output || {})) {
            if (entry.class_type !== "ScenePresetReference") continue;
            const childOverrides = {};
            for (const [key, local] of Object.entries(inherited)) {
                if (key === nodeId) childOverrides["."] = local;
                else if (key.startsWith(`${nodeId}/`)) childOverrides[key.slice(nodeId.length + 1)] = local;
            }
            // A nested Reference owns its subtree and wins over inherited outer entries.
            const own = parsePresetOverrides(entry.inputs?.llm_presets_json || "");
            Object.assign(childOverrides, own);
            children.set(String(nodeId), prepare(String(entry.inputs?.preset_id || ""), pathJoin(path, nodeId), childOverrides, nextStack));
        }
        const modes = new Map((definition.workflow?.nodes || []).map((node) => [String(node.id), Number(node.mode) || 0]));
        const visited = new Set();
        function hasLLM(nodeId) {
            if (visited.has(nodeId) || modes.get(nodeId) === 2) return false;
            visited.add(nodeId);
            const entry = definition.api_graph.output[nodeId];
            if (!entry) return false;
            if (modes.get(nodeId) !== 4 && ((entry.class_type === "ScenePromptLLM" && String(entry.inputs.description || "").trim())
                || (entry.class_type === "ScenePresetReference" && children.get(nodeId)?.scenePresetHasLLM))) return true;
            return Object.entries(entry.inputs || {}).some(([name, value]) => /^scene_prompt\d*$/u.test(name)
                && Array.isArray(value) && hasLLM(String(value[0])));
        }
        const output = Object.entries(definition.api_graph.output).find(([, entry]) => entry.class_type === "ScenePresetOutput");
        Object.defineProperty(preset, "scenePresetHasLLM", { value: !!output && !!hasLLM(output[0]) });
        return preset;
    }
    try { prepared.root = prepare(presetId, ".", overrides, new Set()); }
    catch (failure) { prepared.error = failure; prepared.root = null; }
    cache.set(reference, prepared);
    return prepared;
}

export function presetOccurrenceChild(preset, referenceId) {
    return contexts.get(preset)?.children.get(String(referenceId)) || null;
}

export function presetReferenceRevision(reference) { return cache.get(reference)?.revision || 0; }
export function presetReferenceHasLLM(reference) { return !!cache.get(reference)?.root?.scenePresetHasLLM; }

function writeWorkflowWidget(node, name, value, inputNames) {
    node.widgets_values_named = { ...node.widgets_values_named, [name]: value };
    node.widgets_values ||= [];
    const index = inputNames.indexOf(name);
    if (index >= 0) node.widgets_values[index] = value;
}

export function presetEditorDefinition(reference, definitions) {
    const prepared = preparePresetReference(reference, definitions);
    if (!prepared.root) return null;
    const root = copy(prepared.root);
    // Put each descendant occurrence onto its direct Reference, so explicit root Save
    // retains children locally without writing any child shared file.
    for (const [nodeId, entry] of Object.entries(root.api_graph.output)) {
        if (entry.class_type !== "ScenePresetReference") continue;
        const presets = {};
        for (const [path, definition] of prepared.occurrences) {
            if (!prepared.localPaths.has(path)) continue;
            if (path === nodeId) presets["."] = copy(definition);
            else if (path.startsWith(`${nodeId}/`)) presets[path.slice(nodeId.length + 1)] = copy(definition);
        }
        if (!Object.keys(presets).length) continue;
        const value = JSON.stringify({ version: 1, presets });
        entry.inputs.llm_presets_json = value;
        const workflowNode = root.workflow.nodes.find((node) => String(node.id) === nodeId);
        if (workflowNode) writeWorkflowWidget(workflowNode, "llm_presets_json", value, ["preset_id", "run_handle", "llm_presets_json"]);
    }
    return root;
}

// A small serialized graph adapter supports the controller's regular graph insertion
// operations without configuring a hidden Comfy graph or firing node-load hooks.
export function createPresetGraph(definition, ownerGraph) {
    const local = copy(definition), output = local.api_graph.output;
    const workflowNodes = new Map(local.workflow.nodes.map((node) => [String(node.id), node]));
    const nodes = new Map();
    const graph = { links: {}, getNodeById: (id) => nodes.get(String(id)),
        beforeChange: () => ownerGraph?.beforeChange?.(), afterChange: () => ownerGraph?.afterChange?.() };
    let nextNode = Math.max(0, ...[...workflowNodes.keys()].map(Number).filter(Number.isFinite));
    let nextLink = Math.max(0, ...((local.workflow.links || []).map((link) => Number(link[0]))));
    function connect(slot, target, targetSlot) {
        if (targetSlot < 0) throw new Error("Preset Scene input is missing.");
        const input = target.inputs[targetSlot];
        if (input.link != null) graph.removeLink(input.link);
        const id = ++nextLink;
        graph.links[id] = { id, origin_id: this.id, origin_slot: slot, target_id: target.id, target_slot: targetSlot, type: "SCENE_PROMPT" };
        (this.outputs[slot].links ||= []).push(id);
        input.link = id;
        return graph.links[id];
    }
    graph.removeLink = (id) => {
        const link = graph.links[id];
        if (!link) return;
        const source = graph.getNodeById(link.origin_id), target = graph.getNodeById(link.target_id);
        if (source?.outputs?.[link.origin_slot]) source.outputs[link.origin_slot].links = source.outputs[link.origin_slot].links.filter((item) => item !== id);
        if (target?.inputs?.[link.target_slot]?.link === id) target.inputs[link.target_slot].link = null;
        delete graph.links[id];
    };
    graph.add = (node) => { node.id = ++nextNode; node.graph = graph; node.connect = connect; nodes.set(String(node.id), node); };
    for (const [id, entry] of Object.entries(output)) {
        const saved = workflowNodes.get(id) || { id: Number(id), type: entry.class_type };
        const scalarNames = Object.keys(entry.inputs || {}).filter((name) => !Array.isArray(entry.inputs[name]));
        if (entry.class_type === "ScenePromptLLM" && !scalarNames.includes("generation_state_json")) scalarNames.push("generation_state_json");
        const node = { ...saved, id: saved.id ?? Number(id), comfyClass: entry.class_type, class_type: entry.class_type,
            graph, connect, properties: copy(saved.properties || {}),
            widgets: scalarNames.map((name) => ({ name, value: entry.inputs[name] ?? (name === "generation_state_json" ? "{}" : "") })),
            inputs: copy(saved.inputs || Object.keys(entry.inputs || {}).filter((name) => Array.isArray(entry.inputs[name])).map((name) => ({ name, type: "SCENE_PROMPT", link: null }))),
            outputs: copy(saved.outputs || [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }]) };
        for (const input of node.inputs) input.link = null;
        for (const port of node.outputs) port.links = [];
        nodes.set(id, node);
    }
    // Reconstruct from API links, retaining serialized slots and IDs where present.
    for (const [id, entry] of Object.entries(output)) {
        const target = graph.getNodeById(id);
        for (const [name, value] of Object.entries(entry.inputs || {})) {
            if (!Array.isArray(value) || value.length !== 2) continue;
            const source = graph.getNodeById(value[0]);
            const slot = target.inputs.findIndex((input) => input.name === name);
            if (!source || slot < 0) continue;
            const existing = (local.workflow.links || []).find((link) => String(link[1]) === String(source.id) && link[2] === value[1] && String(link[3]) === String(target.id) && link[4] === slot);
            const linkId = existing?.[0] ?? ++nextLink;
            source.outputs[value[1]] ||= { name: "scene_prompt", type: "SCENE_PROMPT", links: [] };
            source.outputs[value[1]].links.push(linkId);
            target.inputs[slot].link = linkId;
            graph.links[linkId] = { id: linkId, origin_id: source.id, origin_slot: value[1], target_id: target.id, target_slot: slot, type: "SCENE_PROMPT" };
        }
    }
    graph.definition = () => {
        const api = {}, serialized = [];
        for (const node of nodes.values()) {
            const old = output[String(node.id)], saved = workflowNodes.get(String(node.id));
            const inputs = { ...(old?.inputs || {}) };
            for (const widget of node.widgets || []) inputs[widget.name] = widget.value;
            for (const input of node.inputs || []) {
                const link = graph.links[input.link];
                if (link) inputs[input.name] = [String(link.origin_id), link.origin_slot];
                else if (Array.isArray(inputs[input.name])) delete inputs[input.name];
            }
            api[String(node.id)] = { ...(old || {}), class_type: node.comfyClass || node.type || node.class_type, inputs };
            const workflowNode = saved ? { ...saved, properties: node.properties, inputs: copy(node.inputs), outputs: copy(node.outputs) }
                : node.serialize();
            if (saved) {
                workflowNode.widgets_values = [...(saved.widgets_values || [])];
                workflowNode.widgets_values_named = { ...saved.widgets_values_named };
                const scalarNames = Object.keys(old?.inputs || {}).filter((name) => !Array.isArray(old.inputs[name]));
                for (const widget of node.widgets || []) {
                    if (widget.value === old?.inputs?.[widget.name]) continue;
                    if (!scalarNames.includes(widget.name)) scalarNames.push(widget.name);
                    writeWorkflowWidget(workflowNode, widget.name, widget.value, scalarNames);
                }
            } else {
                workflowNode.widgets_values = (node.widgets || []).map((widget) => widget.value);
                workflowNode.widgets_values_named = Object.fromEntries((node.widgets || []).map((widget) => [widget.name, widget.value]));
            }
            serialized.push(workflowNode);
        }
        return { ...local, api_graph: { ...local.api_graph, output: api }, workflow: { ...local.workflow, nodes: serialized,
            links: Object.values(graph.links).map((link) => [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type]),
            last_node_id: nextNode, last_link_id: nextLink } };
    };
    return graph;
}

export function collectPresetLLMTargets(reference, definitions, { refresh } = {}) {
    const prepared = preparePresetReference(reference, definitions);
    if (!prepared.root || prepared.error) return [];
    if (prepared.targets) return prepared.targets;
    let expected = prepared.serialized;
    const ownerGraph = reference.graph;
    const targets = [], visited = new Set();
    const graphs = new Map();
    function visitPreset(preset) {
        if (!preset) return;
        const context = contexts.get(preset), path = context.path;
        let graph = graphs.get(path);
        if (!graph) { graph = createPresetGraph(preset, ownerGraph); graphs.set(path, graph); }
        const output = Object.entries(preset.api_graph.output).find(([, entry]) => entry.class_type === "ScenePresetOutput");
        function visit(id) {
            const key = `${path}:${id}`;
            if (visited.has(key)) return;
            visited.add(key);
            const node = graph.getNodeById(id);
            if (!node || Number(node.mode) === 2) return;
            for (const input of node.inputs || []) {
                if (!/^scene_prompt\d*$/u.test(input.name)) continue;
                const link = graph.links[input.link];
                if (link) visit(String(link.origin_id));
            }
            if (node.class_type === "ScenePresetReference" && Number(node.mode) !== 4) visitPreset(presetOccurrenceChild(preset, id));
            if (node.class_type !== "ScenePromptLLM" || Number(node.mode) === 4 || !String(field(node, "description")?.value || "").trim()) return;
            targets.push({ node, graph, reference,
                identity: { ownerGraph, outerReference: reference, path, presetId: preset.metadata.preset_id, nodeId: String(id) },
                current: () => reference.graph === ownerGraph && ownerGraph?.getNodeById?.(reference.id) === reference
                    && String(field(reference, "preset_id")?.value || "") === prepared.presetId
                    && String(field(reference, "llm_presets_json")?.value || "") === expected,
                commit() {
                    const widget = field(reference, "llm_presets_json");
                    if (!widget) throw new Error("Preset local state widget is missing.");
                    prepared.overrides[path] = graph.definition();
                    // Update owning nested References too: their own local state has
                    // priority over outer inherited paths, including after root Save.
                    const segments = path === "." ? [] : path.split("/");
                    for (let depth = segments.length - 1; depth >= 0; depth--) {
                        const parentPath = depth ? segments.slice(0, depth).join("/") : ".";
                        const childPath = segments.slice(0, depth + 1).join("/");
                        const childId = segments[depth];
                        const parentGraph = graphs.get(parentPath);
                        const parent = parentGraph ? parentGraph.definition() : copy(prepared.occurrences.get(parentPath));
                        const childEntry = parent.api_graph.output[childId];
                        const localOverrides = parsePresetOverrides(childEntry.inputs.llm_presets_json || "");
                        for (const [overridePath, definition] of Object.entries(prepared.overrides)) {
                            if (overridePath === childPath) localOverrides["."] = definition;
                            else if (overridePath.startsWith(`${childPath}/`)) localOverrides[overridePath.slice(childPath.length + 1)] = definition;
                        }
                        const childValue = JSON.stringify({ version: 1, presets: localOverrides });
                        childEntry.inputs.llm_presets_json = childValue;
                        const savedChild = parent.workflow.nodes.find((entry) => String(entry.id) === childId);
                        if (savedChild) writeWorkflowWidget(savedChild, "llm_presets_json", childValue, ["preset_id", "run_handle", "llm_presets_json"]);
                        if (parentGraph) {
                            const childNode = parentGraph.getNodeById(childId);
                            const childWidget = field(childNode, "llm_presets_json");
                            if (childWidget) childWidget.value = childValue;
                            else childNode.widgets.push({ name: "llm_presets_json", value: childValue });
                        }
                        prepared.overrides[parentPath] = parent;
                    }
                    expected = JSON.stringify({ version: 1, presets: prepared.overrides });
                    widget.value = expected;
                    refresh?.(reference);
                } });
        }
        if (output) visit(output[0]);
    }
    visitPreset(prepared.root);
    prepared.targets = targets;
    return targets;
}

export { EMPTY as EMPTY_PRESET_OVERRIDES };
