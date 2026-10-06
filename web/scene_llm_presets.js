// Instance-local Preset definitions. Preparation happens on load/change, never in draw.
const cache = new WeakMap();
const contexts = new WeakMap();
const operations = new WeakMap();
const EMPTY = '{"version":1,"presets":{}}';
const field = (node, name) => node?.widgets?.find((widget) => widget.name === name);
const copy = (value) => JSON.parse(JSON.stringify(value));
const pathJoin = (path, id) => path === "." ? String(id) : `${path}/${id}`;
const sharedEntriesCurrent = (prepared, definitions) => [...prepared.sharedEntries]
    .every(([id, definition]) => definitions.get(id) === definition);

// Full bodies belong to one explicit action. The long-lived source list stays
// compact, and a live Reference never retains this operation's detached graphs.
export function createPresetOperation(sources, currentSources = () => sources) {
    const initialSources = new Map(sources), definitions = new Map(sources), preparedEntries = new Set();
    let disposed = false;
    const operation = {
        definitions,
        track(prepared) { preparedEntries.add(prepared); },
        current(prepared) {
            return !disposed && currentSources() === sources && [...prepared.sharedEntries.keys()]
                .every((id) => sources.get(id) === initialSources.get(id));
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            const restore = new Set();
            for (const prepared of preparedEntries) {
                if (cache.get(prepared.reference) === prepared) {
                    cache.delete(prepared.reference);
                    restore.add(prepared.reference);
                }
                prepared.targets = null;
                prepared.graphs?.forEach((graph) => graph.dispose());
                prepared.graphs?.clear();
                prepared.graphs = null;
                prepared.root = null;
                prepared.occurrences.clear();
                prepared.localPaths.clear();
                prepared.embeddedPaths.clear();
                prepared.sharedEntries.clear();
                prepared.overrides = null;
            }
            preparedEntries.clear();
            definitions.clear();
            initialSources.clear();
            operations.delete(definitions);
            for (const reference of restore) preparePresetReference(reference, currentSources());
        },
    };
    operations.set(definitions, operation);
    return operation;
}

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
    if (previous?.serialized === serialized && previous.presetId === presetId && previous.definitions === definitions
        && sharedEntriesCurrent(previous, definitions))
        return previous;
    let overrides, error = null;
    try { overrides = parsePresetOverrides(serialized); } catch (failure) { overrides = {}; error = failure; }
    const prepared = { reference, operation: operations.get(definitions), serialized, presetId, definitions, overrides, occurrences: new Map(), localPaths: new Set(), embeddedPaths: new Set(), sharedEntries: new Map(), error,
        revision: (previous?.revision || 0) + 1 };
    prepared.operation?.track(prepared);
    function prepare(id, path, inherited, stack) {
        if (stack.has(id)) return null;
        const definition = inherited["."] || definitions.get(id);
        if (!inherited["."]) prepared.sharedEntries.set(id, definition);
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
            if (Object.keys(own).length) prepared.embeddedPaths.add(path);
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
            if (modes.get(nodeId) !== 4 && ((entry.class_type === "ScenePromptLLM" && (entry.has_llm_input === true || String(entry.inputs.description || "").trim()))
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

const fullDefinition = (preset) => !!preset && !preset.scene_compact && Array.isArray(preset.workflow?.nodes)
    && !!preset.api_graph?.output;

function reachablePresetOccurrences(prepared) {
    const occurrences = [], seenPresets = new Set();
    function visitPreset(preset) {
        if (!preset || seenPresets.has(preset)) return;
        seenPresets.add(preset);
        occurrences.push(preset);
        const seen = new Set(), modes = new Map((preset.workflow?.nodes || []).map((node) => [String(node.id), Number(node.mode) || 0]));
        function visit(id) {
            if (seen.has(id) || modes.get(id) === 2) return;
            seen.add(id);
            const entry = preset.api_graph.output[id];
            if (!entry) return;
            for (const [name, value] of Object.entries(entry.inputs || {}))
                if (/^scene_prompt\d*$/u.test(name) && Array.isArray(value)) visit(String(value[0]));
            if (entry.class_type === "ScenePresetReference" && modes.get(id) !== 4) {
                const child = presetOccurrenceChild(preset, id);
                if (child?.scenePresetHasLLM) visitPreset(child);
            }
        }
        const output = Object.entries(preset.api_graph.output).find(([, entry]) => entry.class_type === "ScenePresetOutput");
        if (output) visit(output[0]);
    }
    visitPreset(prepared.root);
    return occurrences;
}

// Called only by explicit generation/editor actions. Fetch a full ancestor before
// inspecting its children: its full local child definitions own their customization.
export async function hydratePresetReference(reference, operation, loadFull) {
    const { definitions } = operation;
    const initialValue = String(field(reference, "llm_presets_json")?.value || "");
    const initialId = String(field(reference, "preset_id")?.value || "");
    for (;;) {
        const prepared = preparePresetReference(reference, definitions);
        if (!operation.current(prepared)) throw new Error("Preset source changed while loading.");
        if (prepared.error) throw prepared.error;
        if (!prepared.root) throw new Error("Preset definition is unavailable.");
        const missing = reachablePresetOccurrences(prepared).find((preset) => !fullDefinition(preset));
        if (!missing) return prepared;
        const context = contexts.get(missing);
        if (prepared.localPaths.has(context.path)) throw new Error("Preset customization is incomplete. Reload its full source before generating.");
        const id = String(missing.metadata.preset_id);
        const full = await loadFull(id);
        if (!fullDefinition(full) || String(full.metadata?.preset_id) !== id) throw new Error("Full Preset response is invalid.");
        if (String(field(reference, "llm_presets_json")?.value || "") !== initialValue
            || String(field(reference, "preset_id")?.value || "") !== initialId || !operation.current(prepared))
            throw new Error("Preset changed while loading its source.");
        definitions.set(id, full);
    }
}

function writeWorkflowWidget(node, name, value, inputNames) {
    node.widgets_values_named = { ...node.widgets_values_named, [name]: value };
    node.widgets_values ||= [];
    const index = inputNames.indexOf(name);
    if (index >= 0) node.widgets_values[index] = value;
}

// Resolve occurrence ownership before removing its nested transport. The outer
// Reference holds each effective customization once, keyed by occurrence path.
function compactDefinition(definition) {
    const result = { ...definition, api_graph: { ...definition.api_graph, output: { ...definition.api_graph.output } },
        workflow: { ...definition.workflow, nodes: [...definition.workflow.nodes] } };
    const executionReferences = new Set();
    for (const [id, entry] of Object.entries(result.api_graph.output)) {
        if (entry.class_type !== "ScenePresetReference") continue;
        executionReferences.add(id);
        if (entry.inputs?.llm_presets_json)
            result.api_graph.output[id] = { ...entry, inputs: { ...entry.inputs, llm_presets_json: "" } };
    }
    result.workflow.nodes = result.workflow.nodes.map((node) => {
        if (node.type !== "ScenePresetReference" || !executionReferences.has(String(node.id))
            || !(node.widgets_values_named?.llm_presets_json || node.widgets_values?.[2])) return node;
        const stripped = { ...node, widgets_values: [...(node.widgets_values || [])] };
        writeWorkflowWidget(stripped, "llm_presets_json", "", ["preset_id", "run_handle", "llm_presets_json"]);
        return stripped;
    });
    // Strip before deep-copying so legacy nested JSON is never duplicated here.
    return copy(result);
}

function effectiveFlatOverrides(prepared) {
    const overrides = {};
    for (const [path, definition] of prepared.occurrences) {
        if (prepared.localPaths.has(path) || prepared.embeddedPaths.has(path)) overrides[path] = compactDefinition(definition);
    }
    return overrides;
}

export function presetEditorDefinition(reference, definitions) {
    const prepared = preparePresetReference(reference, definitions);
    if (!fullDefinition(prepared.root) || !prepared.localPaths.size) return null;
    const root = compactDefinition(prepared.root);
    const overrides = effectiveFlatOverrides(prepared);
    // Put each descendant occurrence onto its direct Reference, so explicit root Save
    // retains children locally without writing any child shared file.
    for (const [nodeId, entry] of Object.entries(root.api_graph.output)) {
        if (entry.class_type !== "ScenePresetReference") continue;
        const presets = {};
        for (const [path, definition] of Object.entries(overrides)) {
            if (path === nodeId) presets["."] = definition;
            else if (path.startsWith(`${nodeId}/`)) presets[path.slice(nodeId.length + 1)] = definition;
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
    let local = copy(definition), output = local.api_graph.output;
    const workflowNodes = new Map(local.workflow.nodes.map((node) => [String(node.id), node]));
    const physicalLinks = new Map(), physicalFanout = new Map(), endpointLinks = new Map();
    const hasPhysicalLinks = !!local.workflow.links?.length;
    const portKey = (id, slot) => JSON.stringify([String(id), slot]);
    const edgeKey = (source, sourceSlot, target, targetSlot) => JSON.stringify([String(source), sourceSlot, String(target), targetSlot]);
    const nodes = new Map(), inputSlots = new Map(), initialWidgets = new Map();
    const graph = { links: {}, getNodeById: (id) => nodes.get(String(id)),
        beforeChange: () => ownerGraph?.beforeChange?.(), afterChange: () => ownerGraph?.afterChange?.() };
    let nextNode = Number(local.workflow.last_node_id) || 0, nextLink = Number(local.workflow.last_link_id) || 0;
    let inserted = false, virtualLink = 0;
    for (const id of [...workflowNodes.keys(), ...Object.keys(output)]) nextNode = Math.max(nextNode, Number(id) || 0);
    function indexPhysicalLink(link) {
        physicalLinks.set(link[0], link);
        const key = portKey(link[1], link[2]);
        if (!physicalFanout.has(key)) physicalFanout.set(key, new Set());
        physicalFanout.get(key).add(link[0]);
    }
    for (const link of local.workflow.links || []) {
        nextLink = Math.max(nextLink, Number(link[0]) || 0);
        indexPhysicalLink(link);
        endpointLinks.set(edgeKey(link[1], link[2], link[3], link[4]), link);
    }
    function indexInputs(node) { inputSlots.set(String(node.id), new Map(node.inputs.map((input, slot) => [input.name, slot]))); }
    function connect(slot, target, targetSlot) {
        target = graph.getNodeById(target.id) || target;
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
    graph.add = (node) => {
        // Snapshot while detached: native DOM widgets expect a real Comfy graph.
        // The local occurrence holds plain data and never binds the native node.
        const template = copy(node.serialize());
        const named = template.widgets_values_named || Object.fromEntries((node.widgets || [])
            .filter((widget) => widget.serialize !== false && widget.options?.serialize !== false)
            .map((widget) => [widget.name, copy(widget.value)]));
        const facade = { ...template, id: ++nextNode, type: node.type, comfyClass: node.comfyClass || node.type,
            graph, connect, widgets: Object.entries(named).map(([name, value]) => ({ name, value })),
            pos: Array.from(template.pos || node.pos || [0, 0]), size: Array.from(template.size || node.size || [300, 150]),
            properties: copy(node.properties || template.properties || {}),
            inputs: copy(template.inputs || node.inputs || []), outputs: copy(template.outputs || node.outputs || []),
            serialize() {
                const values = Object.fromEntries(this.widgets.map((widget) => [widget.name, widget.value]));
                return { ...copy(template), id: this.id, pos: [...this.pos], size: [...this.size], mode: this.mode || 0,
                    properties: copy(this.properties), inputs: copy(this.inputs), outputs: copy(this.outputs),
                    widgets_values: Object.values(values), widgets_values_named: values };
            } };
        node.id = facade.id;
        node.scenePresetDetachedSnapshot = true;
        node.onRemoved?.();
        nodes.set(String(facade.id), facade);
        workflowNodes.set(String(facade.id), facade.serialize());
        indexInputs(facade);
        inserted = true;
        return facade;
    };
    for (const [id, entry] of Object.entries(output)) {
        const saved = workflowNodes.get(id) || { id: Number(id), type: entry.class_type };
        const scalarNames = Object.keys(entry.inputs || {}).filter((name) => !Array.isArray(entry.inputs[name]));
        if (entry.class_type === "ScenePromptLLM" && !scalarNames.includes("generation_state_json")) scalarNames.push("generation_state_json");
        const node = { ...saved, id: saved.id ?? Number(id), comfyClass: entry.class_type, class_type: entry.class_type,
            graph, connect, properties: copy(saved.properties || {}),
            widgets: scalarNames.map((name) => ({ name, value: Object.hasOwn(entry.inputs || {}, name)
                ? entry.inputs[name] : (name === "generation_state_json" ? "{}" : "") })),
            inputs: copy(saved.inputs || Object.keys(entry.inputs || {}).filter((name) => Array.isArray(entry.inputs[name])).map((name) => ({ name, type: "SCENE_PROMPT", link: null }))),
            outputs: copy(saved.outputs || [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }]) };
        for (const input of node.inputs) input.link = null;
        for (const port of node.outputs) port.links = [];
        nodes.set(id, node);
        for (const widget of node.widgets) initialWidgets.set(widget, widget.value);
        if (!workflowNodes.has(id)) workflowNodes.set(id, copy(saved));
        indexInputs(node);
    }
    // Logical API edges can contract bypass/Reroute nodes. Index matching physical
    // endpoints once; unmatched logical links never change the physical snapshot.
    for (const [id, entry] of Object.entries(output)) {
        const target = graph.getNodeById(id), slots = inputSlots.get(id);
        for (const [name, value] of Object.entries(entry.inputs || {})) {
            if (!Array.isArray(value) || value.length !== 2) continue;
            const source = graph.getNodeById(value[0]), slot = slots.get(name);
            if (!source || slot === undefined) continue;
            const existing = endpointLinks.get(edgeKey(source.id, value[1], target.id, slot));
            const linkId = existing?.[0] ?? (hasPhysicalLinks ? `api:${++virtualLink}` : ++nextLink);
            source.outputs[value[1]] ||= { name: "scene_prompt", type: "SCENE_PROMPT", links: [] };
            source.outputs[value[1]].links.push(linkId);
            target.inputs[slot].link = linkId;
            graph.links[linkId] = { id: linkId, origin_id: source.id, origin_slot: value[1], target_id: target.id, target_slot: slot, type: "SCENE_PROMPT" };
        }
    }
    graph.spliceLoras = (oldTail, slot, chain) => {
        if (!hasPhysicalLinks) return; // Legacy definitions are reconstructed below, retaining every saved node.
        const newTail = chain.at(-1), oldKey = portKey(oldTail.id, slot);
        const fanout = physicalFanout.get(oldKey) || new Set();
        const savedTail = workflowNodes.get(String(oldTail.id));
        savedTail.outputs[slot].links = (savedTail.outputs[slot].links || []).filter((id) => !fanout.has(id));
        physicalFanout.set(oldKey, new Set());
        const newTailOutput = workflowNodes.get(String(newTail.id)).outputs[slot];
        for (const id of fanout) {
            const link = physicalLinks.get(id);
            link[1] = newTail.id; link[2] = slot;
            indexPhysicalLink(link);
            (newTailOutput.links ||= []).push(id);
        }
        let source = oldTail;
        for (const placed of chain) {
            const targetSlot = inputSlots.get(String(placed.id)).get("scene_prompt");
            const link = graph.links[placed.inputs[targetSlot].link];
            indexPhysicalLink([link.id, source.id, slot, placed.id, targetSlot, link.type]);
            const savedSource = workflowNodes.get(String(source.id)), savedTarget = workflowNodes.get(String(placed.id));
            (savedSource.outputs[slot].links ||= []).push(link.id);
            savedTarget.inputs[targetSlot].link = link.id;
            source = placed;
        }
    };
    graph.definition = () => {
        const api = {}, serialized = new Map();
        for (const node of nodes.values()) {
            const old = output[String(node.id)], saved = workflowNodes.get(String(node.id));
            const storedWidgets = (node.widgets || []).filter((widget) => widget.serialize !== false && widget.options?.serialize !== false);
            const workflowNode = old ? copy(saved) : node.serialize();
            if (saved.properties !== undefined || Object.keys(node.properties).length) workflowNode.properties = copy(node.properties);
            if (hasPhysicalLinks) {
                if (saved.inputs) workflowNode.inputs = copy(saved.inputs);
                if (saved.outputs) workflowNode.outputs = copy(saved.outputs);
            } else {
                workflowNode.inputs = copy(node.inputs); workflowNode.outputs = copy(node.outputs);
            }
            const inputs = { ...(old?.inputs || {}) };
            const namedValues = !old && workflowNode.widgets_values_named;
            if (namedValues && typeof namedValues === "object") Object.assign(inputs, namedValues);
            else for (const widget of storedWidgets) {
                if (!old || widget.value !== initialWidgets.get(widget)) inputs[widget.name] = widget.value;
            }
            for (const input of node.inputs || []) {
                const link = graph.links[input.link];
                if (link) inputs[input.name] = [String(link.origin_id), link.origin_slot];
                else if (Array.isArray(inputs[input.name])) delete inputs[input.name];
            }
            api[String(node.id)] = { ...(old || {}), class_type: node.comfyClass || node.type || node.class_type, inputs };
            if (old) {
                const scalarNames = old.class_type === "ScenePresetReference"
                    ? ["preset_id", "run_handle", "llm_presets_json"]
                    : Object.keys(old.inputs || {}).filter((name) => !Array.isArray(old.inputs[name]));
                for (const widget of storedWidgets) {
                    if (widget.value === initialWidgets.get(widget)) continue;
                    if (!scalarNames.includes(widget.name)) scalarNames.push(widget.name);
                    writeWorkflowWidget(workflowNode, widget.name, widget.value, scalarNames);
                }
            } else {
                if (!Array.isArray(workflowNode.widgets_values)) workflowNode.widgets_values = storedWidgets.map((widget) => widget.value);
                if (!workflowNode.widgets_values_named) workflowNode.widgets_values_named = Object.fromEntries(storedWidgets.map((widget) => [widget.name, widget.value]));
            }
            serialized.set(String(node.id), workflowNode);
        }
        const workflow = { ...local.workflow,
            nodes: [...workflowNodes].map(([id, saved]) => serialized.get(id) || copy(saved)),
            links: hasPhysicalLinks ? [...physicalLinks.values()].map(copy)
                : Object.values(graph.links).map((link) => [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type]) };
        if (inserted || !hasPhysicalLinks) { workflow.last_node_id = nextNode; workflow.last_link_id = nextLink; }
        return { ...local, api_graph: { ...local.api_graph, output: api }, workflow };
    };
    graph.dispose = () => {
        nodes.clear(); inputSlots.clear(); initialWidgets.clear(); workflowNodes.clear(); physicalLinks.clear(); physicalFanout.clear(); endpointLinks.clear();
        graph.links = {}; local = null; output = null;
    };
    return graph;
}

export function collectPresetLLMTargets(reference, definitions, { refresh } = {}) {
    const prepared = preparePresetReference(reference, definitions);
    if (!prepared.root || prepared.error || !prepared.root.scenePresetHasLLM) return [];
    if (prepared.targets) return prepared.targets;
    let expected = prepared.serialized;
    const ownerGraph = reference.graph;
    const targets = [], visited = new Set();
    const graphs = new Map();
    prepared.graphs = graphs;
    let flatOverrides;
    function visitPreset(preset) {
        if (!preset?.scenePresetHasLLM) return;
        const context = contexts.get(preset), path = context.path;
        let graph = graphs.get(path);
        if (!graph) { graph = createPresetGraph(compactDefinition(preset), ownerGraph); graphs.set(path, graph); }
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
                    && String(field(reference, "llm_presets_json")?.value || "") === expected
                    && (!prepared.operation || prepared.operation.current(prepared))
                    && sharedEntriesCurrent(prepared, definitions),
                commit() {
                    const widget = field(reference, "llm_presets_json");
                    if (!widget) throw new Error("Preset local state widget is missing.");
                    flatOverrides ||= effectiveFlatOverrides(prepared);
                    flatOverrides[path] = compactDefinition(graph.definition());
                    expected = JSON.stringify({ version: 1, presets: flatOverrides });
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
