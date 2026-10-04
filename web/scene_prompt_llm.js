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
export async function requestJSON(api, path, body) {
    const response = await api.fetchApi(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
}
export function identity(candidate) { return `${candidate.model_id}/${candidate.version_id}/${candidate.file_id}`; }
export function applyCandidate(node, candidate, { query = "", sort = "Most Downloaded", model_mode = value(node, "model_mode"), origin } = {}) {
    const previous = node.properties?.scene_civitai || {};
    const managed = new Set(previous.managed_triggers || []);
    const manual = String(value(node, "positive")).split(",").map((token) => token.trim()).filter((token) => token && !managed.has(token));
    const triggers = [...new Set((candidate.triggers || []).flatMap((text) => String(text).split(",")).map((token) => token.trim()).filter((token) => token && !manual.includes(token)))];
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
    for (const node of nodes) {
        graph.add(node);
        node.pos = [Number(tail.pos?.[0] || 0) + Number(tail.size?.[0] || 300) + 40, Number(tail.pos?.[1] || 0)];
        tail.connect(slot, node, (node.inputs || []).findIndex((input) => input.name === "scene_prompt"));
        tail = node;
    }
    for (const link of outgoing) {
        graph.removeLink(link.id);
        const target = graph.getNodeById(link.target_id);
        if (target) tail.connect(slot, target, link.target_slot);
    }
    return nodes;
}
export function createLLMController({ app, api, createNode, refresh, presetTargets, onError, onBusy }) {
    const busy = new WeakSet();
    function targets(root) { return collectLLMTargets(root.graph || app.graph, root, { presetTargets }); }
    async function generate(root, explicit = false) {
        if (busy.has(root)) return;
        busy.add(root);
        onBusy?.(root, true);
        const ownerGraph = app.graph;
        const list = explicit ? [{ node: root, graph: root.graph || ownerGraph }] : targets(root);
        if (!list.length) root.sceneLLMStatus = "生成対象がありません";
        let errorQuery = "";
        try {
            for (const target of list) {
                const { node, graph } = target;
                target.ownerGraph = ownerGraph;
                const captured = captureTarget(target, () => app.graph);
                const rootMode = value(root, "model_mode"), rootLinks = linksKey(root);
                const current = () => captured() && ownerGraph.getNodeById(root.id) === root && value(root, "model_mode") === rootMode && linksKey(root) === rootLinks;
                const description = String(value(node, "description")).trim(), model_mode = explicit ? value(node, "model_mode") : value(root, "model_mode") || value(node, "model_mode");
                errorQuery = description;
                if (!description || !current()) continue;
                node.sceneLLMStatus = "生成中…";
                const saved = readState(node);
                const reusable = !explicit && saved.description === description && saved.model_mode === model_mode && saved.template_version === "scene-llm-v1";
                if (reusable) { node.sceneLLMStatus = "生成済み"; continue; }
                const output = await requestJSON(api, "/scene_prompt/llm/generate", { description, model_mode });
                if (!current()) continue;
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
                if (!current()) { node.sceneLLMStatus = "変更を検出したため適用しませんでした"; continue; }
                graph.beforeChange?.();
                try {
                    if (widget(node, "positive")) widget(node, "positive").value = output.positive;
                    if (widget(node, "negative")) widget(node, "negative").value = output.negative;
                    if (widget(node, "model_mode")) widget(node, "model_mode").value = model_mode;
                    if (widget(node, "generation_state_json")) widget(node, "generation_state_json").value = JSON.stringify({ description, model_mode, template_version: output.template_version, lora_queries: output.lora_queries });
                    insertLoras(graph, node, downloaded, createNode);
                    target.commit?.();
                } finally { graph.afterChange?.(); }
                node.sceneLLMStatus = "完了";
                refresh?.(target.reference || node);
            }
        } catch (error) {
            root.sceneLLMStatus = error.message;
            onError?.(error, errorQuery, () => generate(root, explicit));
        } finally { busy.delete(root); onBusy?.(root, false); app.graph?.setDirtyCanvas?.(true, true); }
    }
    return { generate, targets, busy };
}
