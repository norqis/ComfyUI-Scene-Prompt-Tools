// Explicit, sequential prompt generation. Importing this module never makes requests.
export const LLM_TYPE = "ScenePromptLLM";
export const widget = (node, name) => node?.widgets?.find((entry) => entry.name === name);
export const value = (node, name) => widget(node, name)?.value ?? "";
export const className = (node) => node?.comfyClass || node?.type || node?.class_type;
export function readState(node) {
    try { return JSON.parse(String(value(node, "generation_state_json") || "{}")); }
    catch { return {}; }
}
export function collectLLMTargets(graph, root, { presetTargets } = {}) {
    const targets = [], seen = new Set();
    function visit(node) {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (Number(node.mode) === 2) return;
        for (const input of node.inputs || []) {
            if (!(input.type === "SCENE_PROMPT" || /^scene_prompt\d*$/.test(input.name || "") || className(node) === "Reroute")) continue;
            const link = graph.links?.[input.link];
            if (link) visit(graph.getNodeById(link.origin_id));
        }
        if (className(node) === "ScenePresetReference" && Number(node.mode) !== 4) {
            targets.push(...(presetTargets?.(node) || []));
        }
        if (className(node) === LLM_TYPE && Number(node.mode) !== 4 && String(value(node, "description")).trim()) targets.push({ node, graph });
    }
    visit(root);
    return targets;
}
export function hasLLMTargets(graph, root, presetHasTargets) {
    const seen = new Set();
    function visit(node) {
        if (!node || seen.has(node) || Number(node.mode) === 2) return false;
        seen.add(node);
        if (Number(node.mode) !== 4) {
            if (className(node) === LLM_TYPE && String(value(node, "description")).trim()) return true;
            if (className(node) === "ScenePresetReference" && presetHasTargets?.(node)) return true;
        }
        return (node.inputs || []).some((input) => {
            if (!(input.type === "SCENE_PROMPT" || /^scene_prompt\d*$/.test(input.name || "") || className(node) === "Reroute")) return false;
            const link = graph.links?.[input.link];
            return link ? visit(graph.getNodeById(link.origin_id)) : false;
        });
    }
    return visit(root);
}
function linksKey(node) {
    const graph = node.graph;
    return JSON.stringify({ inputs: (node.inputs || []).map((input) => [input.name, input.link]),
        outputs: (node.outputs || []).map((output) => (output.links || []).map((id) => {
            const link = graph?.links?.[id];
            return link && [id, link.origin_id, link.origin_slot, link.target_id, link.target_slot];
        })) });
}
export function captureTarget(target, activeGraph) {
    const { node, graph } = target;
    const snapshot = JSON.stringify([node.mode, value(node, "description"), value(node, "model_mode"), value(node, "positive"), value(node, "negative"), value(node, "generation_state_json"), node.properties?.scene_civitai, linksKey(node)]);
    return () => activeGraph() === target.ownerGraph && graph.getNodeById(node.id) === node &&
        JSON.stringify([node.mode, value(node, "description"), value(node, "model_mode"), value(node, "positive"), value(node, "negative"), value(node, "generation_state_json"), node.properties?.scene_civitai, linksKey(node)]) === snapshot && (target.current?.() ?? true);
}
// Keep only the routes joining this occurrence to the requested root. Other
// branches may change while a request is pending without cancelling its output.
function routeRecords(graph, root, anchor) {
    const records = [], visiting = new Set(), memo = new Map();
    function visit(node) {
        if (!node || visiting.has(node)) return false;
        if (memo.has(node)) return memo.get(node);
        visiting.add(node);
        const edges = [];
        let reaches = node === anchor;
        if (!reaches && Number(node.mode) !== 2) {
            for (const [slot, input] of (node.inputs || []).entries()) {
                if (!(input.type === "SCENE_PROMPT" || /^scene_prompt\d*$/.test(input.name || "") || className(node) === "Reroute")) continue;
                const link = graph.links?.[input.link];
                if (link && visit(graph.getNodeById(link.origin_id))) {
                    edges.push({ slot, input, id: input.link, endpoints: [link.origin_id, link.origin_slot, link.target_id, link.target_slot] });
                    reaches = true;
                }
            }
        }
        visiting.delete(node); memo.set(node, reaches);
        if (reaches) records.push({ node, mode: node.mode, edges });
        return reaches;
    }
    return visit(root) ? records : null;
}
function captureRoute(graph, root, anchor) {
    const expected = routeRecords(graph, root, anchor);
    return () => {
        const current = routeRecords(graph, root, anchor);
        return expected && current && expected.length === current.length && expected.every(({ node, mode, edges }, index) => {
            const next = current[index];
            return node === next.node && graph.getNodeById(node.id) === node && mode === next.mode && edges.length === next.edges.length &&
                edges.every((edge, slot) => {
                    const other = next.edges[slot];
                    return edge.input === other.input && edge.slot === other.slot && edge.id === other.id &&
                        edge.endpoints.every((value, endpoint) => value === other.endpoints[endpoint]);
                });
        });
    };
}
export async function requestJSON(api, path, body) {
    const response = await api.fetchApi(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
}
export function identity(candidate) { return `${candidate.model_id}/${candidate.version_id}/${candidate.file_id}`; }
function triggerIdentity(token) {
    let word = String(token).trim();
    while (word.startsWith("(") && word.endsWith(")")) word = word.slice(1, -1).replace(/:\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/u, "").trim();
    return word.toLocaleLowerCase();
}
export function applyCandidate(node, candidate, { query = "", sort = "Most Downloaded", model_mode = value(node, "model_mode"), origin } = {}) {
    const previous = node.properties?.scene_civitai || {};
    const managed = new Set(previous.managed_triggers || []);
    const manual = String(value(node, "positive")).split(",").map((token) => token.trim()).filter((token) => token && !managed.has(token));
    const manualIdentities = new Set(manual.map(triggerIdentity));
    const triggers = [...new Set((candidate.triggers || []).flatMap((text) => String(text).split(",")).map((token) => token.trim()).filter((token) => token && !manualIdentities.has(triggerIdentity(token))))];
    for (const [name, next] of Object.entries({ lora_name: candidate.lora_name, model_mode, positive: [...manual, ...triggers].join(", ") })) {
        if (widget(node, name)) widget(node, name).value = next;
    }
    node.properties ||= {};
    node.properties.scene_civitai = { query, sort, model_mode, model_id: candidate.model_id, version_id: candidate.version_id,
        file_id: candidate.file_id, lora_name: candidate.lora_name, name: candidate.name, version_name: candidate.version_name,
        managed_triggers: triggers, origin: origin === undefined ? previous.origin ?? null : origin };
}
export function insertLoras(graph, origin, candidates, createNode) {
    const slot = (origin.outputs || []).findIndex((output) => output.type === "SCENE_PROMPT");
    if (slot < 0) throw new Error("Scene output is missing.");
    let tail = origin;
    const originKey = String(origin.id), used = new Set(), chainSeen = new Set();
    // Only consume an actually adjacent generated chain, never a manual LoRA.
    while (!chainSeen.has(tail)) {
        chainSeen.add(tail);
        const links = tail.outputs?.[slot]?.links || [];
        if (links.length !== 1) break;
        const next = graph.getNodeById(graph.links[links[0]]?.target_id);
        const state = next?.properties?.scene_civitai;
        if (className(next) !== "SceneApplyLora" || state?.origin !== originKey) break;
        used.add(identity(state)); tail = next;
    }
    const additions = candidates.filter((item) => !used.has(identity(item)) && (used.add(identity(item)), true));
    if (!additions.length) return [];
    const outgoing = (tail.outputs?.[slot]?.links || []).map((id) => graph.links[id]).filter(Boolean).map((link) => ({ ...link }));
    const nodes = additions.map((candidate) => {
        const node = createNode("SceneApplyLora");
        if (!node) throw new Error("Scene Apply LoRA is unavailable.");
        applyCandidate(node, candidate, { ...candidate.search_state, origin: originKey });
        return node;
    });
    const placedNodes = [];
    for (const node of nodes) {
        graph.add(node);
        const placed = graph.getNodeById(node.id);
        placed.pos = [Number(tail.pos?.[0] || 0) + Number(tail.size?.[0] || 300) + 40, Number(tail.pos?.[1] || 0)];
        tail.connect(slot, placed, (placed.inputs || []).findIndex((input) => input.name === "scene_prompt"));
        tail = placed;
        placedNodes.push(placed);
    }
    for (const link of outgoing) {
        graph.removeLink(link.id);
        const target = graph.getNodeById(link.target_id);
        if (target) tail.connect(slot, target, link.target_slot);
    }
    return placedNodes;
}
export function createLLMController({ app, api, createNode, refresh, presetTargets, presetHasTargets, prepareTargets, onError, onBusy,
    beginChange = (graph) => graph.beforeChange?.(), endChange = (graph) => graph.afterChange?.() }) {
    const busy = new WeakSet();
    let operationBusy = false;
    function targets(root, operation) { return collectLLMTargets(root.graph || app.graph, root, {
        presetTargets: (reference) => presetTargets?.(reference, operation),
    }); }
    function canGenerate(root) { return hasLLMTargets(root.graph || app.graph, root, presetHasTargets); }
    async function generate(root, explicit = false) {
        if (operationBusy) return;
        operationBusy = true;
        busy.add(root);
        onBusy?.(root, true);
        const ownerGraph = app.graph;
        const initialRoot = captureTarget({ node: root, graph: ownerGraph, ownerGraph }, () => app.graph);
        let list = [];
        let preparation;
        let errorQuery = "";
        let currentNode = root;
        try {
            if (!explicit) preparation = await prepareTargets?.(root);
            if (!initialRoot()) return;
            list = explicit ? [{ node: root, graph: root.graph || ownerGraph }] : targets(root, preparation);
            let routes = list.map((target) => captureRoute(ownerGraph, root, target.reference || target.node));
            for (const { node } of list) { busy.add(node); onBusy?.(node, true); }
            if (!list.length) root.sceneLLMStatus = "生成対象がありません";
            for (const [index, target] of list.entries()) {
                if (!routes[index]()) break;
                const { node, graph } = target;
                currentNode = node;
                target.ownerGraph = ownerGraph;
                const captured = captureTarget(target, () => app.graph);
                const rootMode = value(root, "model_mode");
                const current = () => captured() && routes[index]() && value(root, "model_mode") === rootMode;
                const description = String(value(node, "description")).trim(), model_mode = explicit ? value(node, "model_mode") : value(root, "model_mode") || value(node, "model_mode");
                errorQuery = description;
                if (!description || !current()) continue;
                node.sceneLLMStatus = "生成中…";
                const saved = readState(node);
                const reusable = !explicit && saved.description === description && saved.model_mode === model_mode && saved.template_version === "scene-llm-v1";
                if (reusable) { node.sceneLLMStatus = "生成済み"; continue; }
                const output = await requestJSON(api, "/scene_prompt/llm/generate", { description, model_mode });
                if (!current()) { node.sceneLLMStatus = "変更を検出したため適用しませんでした"; break; }
                const downloaded = [];
                for (const query of output.lora_queries || []) {
                    errorQuery = query;
                    const result = await requestJSON(api, `/scene_prompt/civitai/search?${new URLSearchParams({ query, model_mode, sort: "Most Downloaded" })}`);
                    if (!current()) break;
                    const selection = await requestJSON(api, "/scene_prompt/llm/select_loras", { description, model_mode, query, candidates: result.items });
                    if (!current()) break;
                    for (const selected of selection.selected || []) {
                        if (!current()) break;
                        if (!result.items.some((candidate) => identity(candidate) === identity(selected))) throw new Error("LLM selected an unknown LoRA.");
                        const acquired = await requestJSON(api, "/scene_prompt/civitai/download", { ...selected, model_mode });
                        if (!current()) break;
                        downloaded.push({ ...acquired.candidate, lora_name: acquired.lora_name, search_state: { query, sort: "Most Downloaded", model_mode } });
                    }
                }
                if (!current()) { node.sceneLLMStatus = "変更を検出したため適用しませんでした"; break; }
                const remainingCurrent = routes.slice(index + 1).every((current) => current());
                beginChange(graph);
                try {
                    if (widget(node, "positive")) widget(node, "positive").value = output.positive;
                    if (widget(node, "negative")) widget(node, "negative").value = output.negative;
                    if (widget(node, "model_mode")) widget(node, "model_mode").value = model_mode;
                    if (widget(node, "generation_state_json")) widget(node, "generation_state_json").value = JSON.stringify({ description, model_mode, template_version: output.template_version, lora_queries: output.lora_queries });
                    insertLoras(graph, node, downloaded, createNode);
                    target.commit?.();
                } finally { endChange(graph); }
                // Our own insertion changes these paths legitimately. Capture
                // the new paths only after the synchronous generation commit.
                if (remainingCurrent) routes = list.map((next) => captureRoute(ownerGraph, root, next.reference || next.node));
                node.sceneLLMStatus = "完了";
                refresh?.(target.reference || node);
                if (!remainingCurrent) break;
            }
        } catch (error) {
            root.sceneLLMStatus = error.message;
            currentNode.sceneLLMStatus = error.message;
            onError?.(error, errorQuery, () => generate(root, explicit));
        } finally {
            preparation?.dispose();
            operationBusy = false;
            for (const node of new Set([root, ...list.map((target) => target.node)])) { busy.delete(node); onBusy?.(node, false); }
            list = [];
            app.graph?.setDirtyCanvas?.(true, true);
        }
    }
    return { generate, targets, canGenerate, busy };
}
