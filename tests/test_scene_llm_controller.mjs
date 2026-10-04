import assert from "node:assert/strict";
import { collectLLMTargets, createLLMController, insertLoras, applyCandidate, identity } from "../web/scene_prompt_llm.js";

function fixture() {
    let next = 1, linkID = 1;
    const graph = { links: {}, _nodes: [], before: 0, after: 0,
        getNodeById(id) { return this._nodes.find((node) => String(node.id) === String(id)); },
        add(node) { node.id ||= next++; node.graph = this; this._nodes.push(node); },
        removeLink(id) { const link = this.links[id]; if (!link) return; const output = this.getNodeById(link.origin_id).outputs[link.origin_slot]; output.links = output.links.filter((value) => value !== id); this.getNodeById(link.target_id).inputs[link.target_slot].link = null; delete this.links[id]; },
        beforeChange() { this.before++; }, afterChange() { this.after++; }, setDirtyCanvas() {} };
    const create = (type, description = "") => ({ type, mode: 0, pos: [0, 0], size: [300, 100], properties: {},
        inputs: [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }], outputs: [{ type: "SCENE_PROMPT", links: [] }],
        widgets: Object.entries({ description, model_mode: "Illustrious", positive: "", negative: "", generation_state_json: "{}", lora_name: "" }).map(([name, value]) => ({ name, value })),
        connect(slot, target, input) { if (target.inputs[input].link != null) graph.removeLink(target.inputs[input].link); const id = linkID++; graph.links[id] = { id, origin_id: this.id, origin_slot: slot, target_id: target.id, target_slot: input }; this.outputs[slot].links.push(id); target.inputs[input].link = id; } });
    const node = (type, description) => { const item = create(type, description); graph.add(item); return item; };
    return { graph, node, create };
}
const field = (node, name) => node.widgets.find((widget) => widget.name === name);
const candidate = (id) => ({ model_id: id, version_id: id + 10, file_id: id + 20, lora_name: `llm/${id}.safetensors`, triggers: [`trigger${id}`] });
{
    const { graph, node } = fixture();
    const first = node("ScenePromptLLM", "first"), second = node("ScenePromptLLM", "second"), queue = node("ScenePrompterQueue"), unrelated = node("ScenePromptLLM", "model");
    first.connect(0, second, 0); queue.inputs.push({ name: "scene_prompt2", type: "SCENE_PROMPT" }, { name: "model", type: "MODEL" });
    second.connect(0, queue, 0); first.connect(0, queue, 1); unrelated.connect(0, queue, 2);
    assert.deepEqual(collectLLMTargets(graph, queue).map(({ node }) => node), [first, second]);
    second.mode = 4; assert.deepEqual(collectLLMTargets(graph, queue).map(({ node }) => node), [first]);
    field(first, "description").value = " "; assert.equal(collectLLMTargets(graph, queue).length, 0);
}
{
    const { graph, node, create } = fixture();
    const origin = node("ScenePromptLLM", "a"), queue = node("ScenePrompterQueue"), manual = node("SceneApplyLora");
    queue.inputs.push({ name: "scene_prompt2", type: "SCENE_PROMPT" }); origin.connect(0, queue, 1); origin.connect(0, manual, 0);
    const inserted = insertLoras(graph, origin, [candidate(1), candidate(2)], create);
    assert.equal(graph.links[queue.inputs[1].link].origin_id, inserted[1].id);
    assert.equal(graph.links[manual.inputs[0].link].origin_id, inserted[1].id);
    assert.equal(graph.links[inserted[1].inputs[0].link].origin_id, inserted[0].id);
    assert.equal(insertLoras(graph, origin, [candidate(1), candidate(2)], create).length, 0);
    assert.equal(insertLoras(graph, origin, [candidate(3)], create).length, 1);
    field(inserted[0], "positive").value = "manual, trigger1 edited, trigger1";
    applyCandidate(inserted[0], candidate(4));
    assert.equal(field(inserted[0], "positive").value, "manual, trigger1 edited, trigger4");
}
{
    const { graph, node, create } = fixture(), app = { graph }, calls = [];
    const first = node("ScenePromptLLM", "first"), second = node("ScenePromptLLM", "second"), expand = node("ScenePrompterExpand"); first.connect(0, second, 0); second.connect(0, expand, 0);
    const api = { async fetchApi(path, options) {
        calls.push(path); const body = options.body && JSON.parse(options.body);
        const data = path.endsWith("generate") ? { positive: body.description, negative: "bad", lora_queries: ["hat"], template_version: "scene-llm-v1" }
            : path.includes("search?") ? { items: [candidate(1)] } : path.endsWith("select_loras") ? { selected: [candidate(1)] } : { candidate: candidate(1), lora_name: candidate(1).lora_name };
        return { ok: true, json: async () => data };
    } };
    const controller = createLLMController({ app, api, createNode: create });
    assert.equal(calls.length, 0, "no implicit requests");
    await controller.generate(expand);
    assert.equal(field(first, "positive").value, "first"); assert.equal(field(second, "positive").value, "second", "capture second after first insertion");
    assert.equal(graph.before, 2); assert.equal(graph.after, 2);
    field(first, "positive").value = "manual edit"; const previousCalls = calls.length; await controller.generate(expand);
    assert.equal(field(first, "positive").value, "manual edit", "Expand reuses manual outputs");
    assert.equal(calls.filter((path) => path.endsWith("generate")).length, 2);
    assert.equal(calls.length, previousCalls, "complete matching targets reuse without any service calls");
    field(expand, "model_mode").value = "Anima"; await controller.generate(expand);
    assert.equal(field(first, "model_mode").value, "Anima", "Expand mode becomes the saved output mode");
    assert.equal(field(first, "positive").value, "first", "mode change overwrites manual saved output");
    await controller.generate(first, true); assert.equal(field(first, "positive").value, "first", "own Generate explicitly regenerates");
    assert.equal(calls.filter((path) => path.endsWith("generate")).length, 5);
}
for (const change of ["output", "description", "tab", "delete", "connection"]) {
    const { graph, node, create } = fixture(), app = { graph }, target = node("ScenePromptLLM", "before");
    let resolve;
    const api = { fetchApi: () => new Promise((done) => { resolve = done; }) };
    const pending = createLLMController({ app, api, createNode: create }).generate(target, true);
    if (change === "output") field(target, "positive").value = "user edit";
    if (change === "description") field(target, "description").value = "user description";
    if (change === "tab") app.graph = {};
    if (change === "delete") graph._nodes = [];
    if (change === "connection") target.connect(0, node("ScenePrompterExpand"), 0);
    resolve({ ok: true, json: async () => ({ positive: "generated", negative: "", lora_queries: [], template_version: "scene-llm-v1" }) });
    await pending;
    assert.notEqual(field(target, "positive").value, "generated", change);
    assert.equal(graph.before, 0, "stale graph never enters transaction");
}
assert.equal(identity(candidate(1)), "1/11/21");
console.log("LLM controller traversal, insertion, reuse and ownership tests passed.");
