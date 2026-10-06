import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { collectLLMTargets, createLLMController, insertLoras, applyCandidate, identity, hasLLMTargets, compactCandidates, requestJSON } from "../web/scene_prompt_llm.js";
import { createPresetOperation, preparePresetReference, hydratePresetReference, collectPresetLLMTargets, presetReferenceHasLLM } from "../web/scene_llm_presets.js";
import { createGPUController } from "../web/scene_prompt_gpu.js";

const reply = (data, ok = true, status = ok ? 200 : 503) => new Response(JSON.stringify(data), { status });

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
    const { graph, node, create } = fixture();
    const a = node("ScenePromptLLM", "A"), b = node("ScenePromptLLM", "B"), output = node("ScenePromptRandomRouteOutput"), expand = node("ScenePrompterExpand");
    output.inputs = [{ name: "scene_prompt1", type: "SCENE_PROMPT" }, { name: "scene_prompt10", type: "SCENE_PROMPT" }];
    a.connect(0, output, 0); b.connect(0, output, 1); output.connect(0, expand, 0);
    assert.deepEqual(collectLLMTargets(graph, expand).map(({ node: target }) => target), [a, b]);
    const [lora] = insertLoras(graph, b, [candidate(9)], create);
    assert.equal(graph.links[output.inputs[1].link].origin_id, lora.id, "LoRA insertion preserves Output's tenth input edge");
    assert.deepEqual(collectLLMTargets(graph, expand).map(({ node: target }) => target), [a, b]);
}
{
    const rich = { ...candidate(1), name: "model", description: "full metadata", gallery: [{url:"preview"}], model_stats: {downloadCount:3} };
    assert.deepEqual(Object.keys(compactCandidates([rich])[0]), ["model_id","version_id","file_id","name","version_name","base_model","triggers"]);
    for (const [status, text] of [[200,""],[200,'{"items":'],[502,"<html>failure</html>"],[404,""]]) {
        let reads = 0;
        await assert.rejects(() => requestJSON({ fetchApi: async () => ({ok:status===200,status,text:async()=>{reads++;return text;}}) }, "/scene_prompt/civitai/search?query=private"),
            error => error.message.includes(`HTTP ${status}`) && error.message.includes("/scene_prompt/civitai/search") && !/SyntaxError|Unexpected end|private|<html>/.test(error.message));
        assert.equal(reads,1,"the HTTP body is consumed exactly once");
    }
}
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
    field(inserted[0], "positive").value = "manual, (TRIGGER4:1.3)";
    applyCandidate(inserted[0], candidate(4));
    assert.equal(field(inserted[0], "positive").value, "manual, (TRIGGER4:1.3)", "weighted existing manual triggers are not duplicated");
}
{
    const { graph, node, create } = fixture(), app = { graph }, calls = [];
    const first = node("ScenePromptLLM", "first"), second = node("ScenePromptLLM", "second"), expand = node("ScenePrompterExpand"); first.connect(0, second, 0); second.connect(0, expand, 0);
    const api = { async fetchApi(path, options) {
        calls.push(path); const body = options.body && JSON.parse(options.body);
        const data = path.endsWith("generate") ? { positive: body.description, negative: "bad", lora_queries: ["hat"], template_version: "scene-llm-v1" }
            : path.includes("search?") ? { items: [candidate(1)] } : path.endsWith("select_loras") ? { selected: [candidate(1)] } : { candidate: candidate(1), lora_name: candidate(1).lora_name };
        return reply(data);
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
    resolve(reply({ positive: "generated", negative: "", lora_queries: [], template_version: "scene-llm-v1" }));
    await pending;
    assert.notEqual(field(target, "positive").value, "generated", change);
    assert.equal(graph.before, 0, "stale graph never enters transaction");
}
assert.equal(identity(candidate(1)), "1/11/21");
for (const outcome of ["success", "error", "stale-root", "stale-target", "retry"]) {
    const { graph, node, create } = fixture(), app = { graph };
    const target = node("ScenePromptLLM", "operation target"), expand = node("ScenePrompterExpand");
    target.connect(0, expand, 0);
    const contexts = [], calls = [];
    let finish, retry;
    const controller = createLLMController({ app, createNode: create,
        prepareTargets: async () => { const context = { disposed: false, dispose() { this.disposed = true; } }; contexts.push(context); return context; },
        presetTargets: () => [],
        api: { async fetchApi(path) {
            calls.push(path);
            if (calls.length === 1 && ["stale-root", "stale-target"].includes(outcome)) await new Promise((done) => { finish = done; });
            const failing = calls.length === 1 && ["error", "retry"].includes(outcome);
            return reply(failing ? { error: "test failure" }
                : { positive: "generated", negative: "", lora_queries: [], template_version: "scene-llm-v1" }, !failing);
        } },
        onError: (_error, _query, callback) => { retry = callback; },
    });
    const pending = controller.generate(expand);
    if (["stale-root", "stale-target"].includes(outcome)) {
        while (!finish) await new Promise((done) => setImmediate(done));
        if (outcome === "stale-root") app.graph = {};
        else field(target, "positive").value = "manual";
        finish();
    }
    await pending;
    assert.equal(contexts[0].disposed, true, `${outcome} always disposes prepared data`);
    if (outcome === "retry") {
        await retry();
        assert.equal(contexts.length, 2);
        assert.notStrictEqual(contexts[0], contexts[1], "retry never reuses disposed preparation");
        assert(contexts.every((context) => context.disposed));
        assert.equal(field(target, "positive").value, "generated");
    }
    assert.equal(controller.busy.has(expand), false);
}
{
    const { graph, node, create } = fixture(), app = { graph };
    const reference = node("ScenePresetReference"), expand = node("ScenePrompterExpand");
    reference.widgets.push({ name: "preset_id", value: "retry-preset" }, { name: "llm_presets_json", value: "{}" });
    reference.connect(0, expand, 0);
    const output = {
        1: { class_type: "ScenePromptLLM", inputs: { description: "room", positive: "", negative: "", model_mode: "Illustrious", generation_state_json: "{}" } },
        2: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
    };
    const full = { metadata: { preset_id: "retry-preset", sha256: "retry" }, api_graph: { output }, workflow: { nodes: [
        { id: 1, type: "ScenePromptLLM", inputs: [], outputs: [{ name: "scene_prompt", type: "SCENE_PROMPT" }] },
        { id: 2, type: "ScenePresetOutput", inputs: [{ name: "scene_prompt", type: "SCENE_PROMPT" }], outputs: [] },
    ], links: [] } };
    const compact = { metadata: full.metadata, api_graph: { output: {
        1: { class_type: "ScenePromptLLM", inputs: {}, has_llm_input: true }, 2: output[2],
    } } };
    const sources = new Map([["retry-preset", compact]]), preparations = [];
    preparePresetReference(reference, sources);
    let retry, calls = 0, settledAvailable = false;
    const resourceCalls = [];
    const resources = {
        snapshot: () => ({ releaseComfyBeforeLLM: true }),
        beginLLM: async () => { const id = `preset-session-${preparations.length}`; resourceCalls.push(["begin", id]); return id; },
        endLLM: async (id) => { assert.equal(preparations.at(-1).definitions.size, 0, "Preset operation disposes before its session ends"); resourceCalls.push(["end", id]); },
        onCleanupError: (error) => { throw error; },
    };
    const controller = createLLMController({ app, createNode: create,
        resources,
        presetHasTargets: presetReferenceHasLLM,
        presetTargets: (reference, operation) => collectPresetLLMTargets(reference, operation.definitions),
        prepareTargets: async () => {
            const operation = createPresetOperation(sources); preparations.push(operation);
            try { await hydratePresetReference(reference, operation, async () => full); return operation; }
            catch (error) { operation.dispose(); throw error; }
        },
        api: { async fetchApi(_path, options) { calls++; assert.equal(JSON.parse(options.body).session_id, `preset-session-${preparations.length}`); return reply(calls === 1 ? { error: "service failure" }
            : { positive: "new room", negative: "", lora_queries: [], template_version: "scene-llm-v1" }, calls !== 1); } },
        onError: (_error, _query, callback) => { retry = callback; },
        onBusy: (_node, busy) => { if (!busy) settledAvailable = presetReferenceHasLLM(reference); },
    });
    await controller.generate(expand);
    assert.equal(controller.canGenerate(expand), true, "failed generation restores compact availability without an unrelated UI refresh");
    assert.equal(settledAvailable, true, "disposal restores availability before settled button callbacks");
    assert.equal(preparations[0].definitions.size, 0);
    await retry();
    assert.equal(calls, 2, "retry still discovers and generates the Reference target");
    assert.equal(preparations.length, 2);
    assert(preparations.every((operation) => operation.definitions.size === 0));
    assert.equal(JSON.parse(field(reference, "llm_presets_json").value).presets["."].api_graph.output[1].inputs.positive, "new room");
    assert.strictEqual(sources.get("retry-preset"), compact);
    assert.deepEqual(resourceCalls, [["begin", "preset-session-1"], ["end", "preset-session-1"], ["begin", "preset-session-2"], ["end", "preset-session-2"]]);
}
{
    const { graph, node, create } = fixture(), app = { graph };
    const first = node("ScenePromptLLM", "first"), second = node("ScenePromptLLM", "second"), middle = node("ScenePrompt"), expand = node("ScenePrompterExpand");
    expand.inputs.push({ name: "scene_prompt2", type: "SCENE_PROMPT", link: null });
    first.connect(0, expand, 0); second.connect(0, middle, 0); middle.connect(0, expand, 1);
    let finish; const calls = [];
    const api = { async fetchApi(path) { calls.push(path); await new Promise((done)=>{finish=done;}); return reply({positive:"first",negative:"",lora_queries:[],template_version:"scene-llm-v1"}); } };
    const pending = createLLMController({ app, api, createNode:create }).generate(expand);
    while (!finish) await new Promise((done)=>setImmediate(done));
    graph.removeLink(middle.inputs[0].link); finish(); await pending;
    assert.equal(field(first,"positive").value,"first","independent current path still commits");
    assert.equal(calls.length,1,"own commit never refreshes away a user change to next target path");
}
{
    const source = await readFile(new URL("../web/scene_prompt_ui.js", import.meta.url), "utf8");
    const start = source.indexOf("function endSceneGraphChange(");
    const snippet = source.slice(start, source.indexOf("\nconst sceneGPUController", start));
    let completed = 0;
    assert.throws(() => vm.runInNewContext(`${snippet}; endSceneGraphChange(graph);`, {
        graph: { afterChange() { throw new Error("Graph callback failed"); } }, app: { canvas: { emitAfterChange() { completed++; } } },
    }), /Graph callback failed/);
    assert.equal(completed, 1, "native ChangeTracker transaction closes even when graph callbacks fail");
}
for (const startWithExpand of [true, false]) {
    const { graph, node, create } = fixture(), app = { graph }, target = node("ScenePromptLLM", "test"), expand = node("ScenePrompterExpand");
    target.connect(0, expand, 0);
    let resolve, requests = 0;
    const api = { fetchApi: () => { requests++; return new Promise((done) => { resolve = done; }); } };
    const controller = createLLMController({ app, api, createNode: create });
    const operation = controller.generate(startWithExpand ? expand : target, !startWithExpand);
    await controller.generate(startWithExpand ? target : expand, startWithExpand);
    assert.equal(requests, 1, "own and Expand operations cannot overlap");
    assert.equal(controller.busy.has(target), true, "upstream own button is busy during Expand");
    resolve(reply({ error: "Service unavailable" }, false));
    await operation;
    assert.equal(target.sceneLLMStatus, "API /scene_prompt/llm/generate · HTTP 503: Service unavailable", "failing target displays the API, HTTP status and settled error");
    assert.equal(controller.busy.has(target), false);
    assert.equal(controller.busy.has(expand), false);
}
for (const change of ["mode", "tab", "connection"]) {
    const { graph, node, create } = fixture(), app = { graph }, reference = node("ScenePresetReference"), expand = node("ScenePrompterExpand");
    reference.connect(0, expand, 0);
    let finishPreparation, hydration = 0, requests = 0, constructed = 0;
    const controller = createLLMController({ app, api: { fetchApi() { requests++; } }, createNode: create,
        presetHasTargets: () => true,
        presetTargets: () => { constructed++; return []; },
        prepareTargets: () => { hydration++; return new Promise((done) => { finishPreparation = done; }); } });
    assert.equal(controller.canGenerate(expand), true);
    assert.equal(hasLLMTargets(graph, expand, () => false), false);
    assert.equal(constructed, 0, "availability never constructs a Preset graph");
    assert.equal(hydration, 0, "availability never fetches missing workflows");
    const pending = controller.generate(expand);
    if (change === "mode") field(expand, "model_mode").value = "Anima";
    if (change === "tab") app.graph = {};
    if (change === "connection") graph.removeLink(expand.inputs[0].link);
    finishPreparation(); await pending;
    assert.equal(constructed, 0, "root changed during workflow hydration never constructs stale targets");
    assert.equal(requests, 0);
    assert.equal(controller.busy.has(expand), false);
}
for (const stage of ["generate", "search?", "select_loras", "download"]) {
    for (const change of ["disconnect", "mute-root", "bypass-root", "mute-middle", "bypass-middle", "replace-middle", "reroute", "parallel", "unrelated"]) {
        const { graph, node, create } = fixture(), app = { graph };
        const first = node("ScenePromptLLM", "first"), a = node("ScenePrompt"), b = node("ScenePrompt"), second = node("ScenePromptLLM", "second"), expand = node("ScenePrompterExpand");
        first.connect(0, a, 0); a.connect(0, b, 0); b.connect(0, second, 0); second.connect(0, expand, 0);
        const unrelated = node("ScenePrompt"); expand.inputs.push({ name: "scene_prompt2", type: "SCENE_PROMPT", link: null }); unrelated.connect(0, expand, 1);
        let finish, paused = false; const calls = [];
        const api = { async fetchApi(path, options = {}) {
            calls.push(path);
            if (!paused && path.includes(stage)) { paused = true; await new Promise((done) => { finish = done; }); }
            const body = options.body && JSON.parse(options.body);
            const data = path.endsWith("generate") ? { positive: body.description, negative: "", lora_queries: ["hat"], template_version: "scene-llm-v1" }
                : path.includes("search?") ? { items: [candidate(1)] } : path.endsWith("select_loras") ? { selected: [candidate(1)] } : { candidate: candidate(1), lora_name: candidate(1).lora_name };
            return reply(data);
        } };
        const pending = createLLMController({ app, api, createNode: create }).generate(expand);
        while (!finish) await new Promise((done) => setImmediate(done));
        if (change === "disconnect") graph.removeLink(b.inputs[0].link);
        if (change === "mute-root") expand.mode = 2;
        if (change === "bypass-root") expand.mode = 4;
        if (change === "mute-middle") b.mode = 2;
        if (change === "bypass-middle") b.mode = 4;
        if (change === "replace-middle") { const replacement = create("ScenePrompt"); replacement.id = b.id; replacement.graph = graph; replacement.inputs = b.inputs; replacement.outputs = b.outputs; graph._nodes[graph._nodes.indexOf(b)] = replacement; }
        if (change === "reroute") node("ScenePrompt").connect(0, b, 0);
        if (change === "parallel") { b.inputs.push({ name: "scene_prompt2", type: "SCENE_PROMPT", link: null }); a.connect(0, b, 1); }
        if (change === "unrelated") node("ScenePrompt").connect(0, unrelated, 0);
        finish(); await pending;
        assert.equal(field(first, "positive").value, change === "unrelated" ? "first" : "", `${stage}/${change}`);
        if (change !== "unrelated") assert.equal(graph.before, 0, `${stage}/${change}: stale path never commits`);
        if (["mute-root", "bypass-root"].includes(change)) assert.equal(calls.filter((path) => path.endsWith("generate")).length, 1, "old remaining target is invalidated before inference");
        if (change === "unrelated") assert.equal(field(second, "positive").value, "second", "own insertion keeps next target reachable");
    }
}
for (const outcome of ["success", "partial-error", "stale", "stale-begin", "retry"]) {
    const { graph, node, create } = fixture();
    const first = node("ScenePromptLLM", "first"), second = node("ScenePromptLLM", "second"), expand = node("ScenePrompterExpand");
    first.connect(0, second, 0); second.connect(0, expand, 0);
    const settings = { "ScenePrompt.ReleaseComfyBeforeLLM": true }, calls = [], cleanupErrors = [];
    const app = { graph, extensionManager: { setting: { get: (id) => settings[id] } } };
    let retry, finish, generationCount = 0, sessionCount = 0;
    const api = { clientId: "test-client", async fetchApi(path, options) {
        const body = JSON.parse(options.body || "{}"); calls.push({ path, body });
        if ((outcome === "stale-begin" && path.endsWith("/begin")) || (outcome === "stale" && path.endsWith("/generate"))) {
            await new Promise((done) => { finish = done; });
        }
        let data = {};
        if (path.endsWith("/begin")) data = { session_id: `session-${++sessionCount}` };
        if (path.endsWith("/generate")) {
            generationCount++;
            const fails = outcome === "partial-error" && body.description === "second" || outcome === "retry" && generationCount === 1;
            if (fails) return reply({ error: "service failure" }, false);
            data = { positive: body.description, negative: "", lora_queries: ["hat"], template_version: "scene-llm-v1" };
        }
        if (path.includes("/search?")) data = { items: [] };
        if (path.endsWith("/select_loras")) data = { selected: [] };
        if (path.endsWith("/end")) assert(controller.busy.has(expand), "the Generate button remains busy until resource cleanup finishes");
        return reply(data);
    } };
    const resources = createGPUController({ app, api, onCleanupError: (error) => cleanupErrors.push(error) });
    const controller = createLLMController({ app, api, resources, createNode: create,
        onError: (_error, _query, callback) => { retry = callback; } });
    const pending = controller.generate(expand);
    if (outcome.startsWith("stale")) {
        while (!finish) await new Promise((done) => setImmediate(done));
        field(first, "positive").value = "manual";
        settings["ScenePrompt.ReleaseComfyBeforeLLM"] = false;
        finish();
    }
    await pending;
    assert.equal(calls.filter(({ path }) => path.endsWith("/begin")).length, 1, outcome);
    assert.equal(calls.filter(({ path }) => path.endsWith("/end")).length, 1, outcome);
    assert(calls.filter(({ path }) => path.endsWith("/generate") || path.endsWith("/select_loras"))
        .every(({ body }) => body.session_id === "session-1" && body.client_id === "test-client"), "all target generation and LoRA selection use the same owned session");
    assert(!calls.some(({ path }) => path.includes("/gpu/")), "finishing prompt generation never unloads the LLM");
    assert.equal(cleanupErrors.length, 0);
    if (outcome === "partial-error") assert.equal(field(first, "positive").value, "first", "completed targets keep partial commits");
    if (outcome === "stale-begin") assert.equal(generationCount, 0, "a stale graph while waiting for GPU never starts inference");
    if (outcome === "success") {
        const before = calls.length;
        await controller.generate(expand);
        assert.equal(calls.length, before, "all cached targets skip resource and LLM requests");
    }
    if (outcome === "retry") {
        await retry();
        assert.equal(sessionCount, 2, "retry creates its own operation session");
        assert.equal(calls.filter(({ path }) => path.endsWith("/end")).length, 2);
        assert.equal(field(second, "positive").value, "second");
    }
    assert.doesNotMatch(JSON.stringify(graph._nodes.map(({ widgets, properties }) => ({ widgets, properties }))), /session-\d|session_id/,
        "private sessions never enter node state");
}
console.log("LLM controller traversal, insertion, reuse and GPU operation ownership tests passed.");
