import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import vm from "node:vm";
import { preparePresetReference, presetOccurrenceChild, collectPresetLLMTargets,
    presetEditorDefinition, parsePresetOverrides, hydratePresetReference, presetReferenceHasLLM, createPresetOperation } from "../web/scene_llm_presets.js";
import { insertLoras } from "../web/scene_prompt_llm.js";

function definition(id, output) {
    return { metadata: { preset_id: id, sha256: "shared" }, api_graph: { output }, workflow: {
        nodes: Object.entries(output).map(([nodeId, entry]) => ({ id: Number(nodeId), type: entry.class_type, mode: 0,
            inputs: Object.keys(entry.inputs).filter((name) => Array.isArray(entry.inputs[name])).map((name) => ({ name, type: "SCENE_PROMPT", link: null })),
            outputs: [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }],
            widgets_values: Object.values(entry.inputs).filter((value) => !Array.isArray(value)), properties: {} })), links: [] } };
}
const inner = definition("inner", {
    1: { class_type: "ScenePromptLLM", inputs: { model_mode: "Illustrious", description: "room", positive: "shared", negative: "", generation_state_json: "{}" } },
    2: { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["1", 0], count: 2 } },
    3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
});
const outer = definition("outer", {
    5: { class_type: "ScenePresetReference", inputs: { preset_id: "inner" } },
    6: { class_type: "ScenePresetReference", inputs: { preset_id: "inner" } },
    7: { class_type: "ScenePrompterQueue", inputs: { scene_prompt2: ["5", 0], scene_prompt5: ["6", 0] } },
    8: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["7", 0] } },
});
const definitions = new Map([["inner", inner], ["outer", outer]]);
const original = JSON.stringify([...definitions]);
const references = new Map();
const ownerGraph = { getNodeById: (id) => references.get(id), beforeChange() {}, afterChange() {} };
const reference = (id, state = "") => {
    const node = { id, graph: ownerGraph, widgets: [{ name: "preset_id", value: "outer" }, { name: "llm_presets_json", value: state }] };
    references.set(id, node); return node;
};
const a = reference(40), b = reference(41);
assert.deepEqual(parsePresetOverrides("{}"), {}, "backend default empty widget value is accepted");
const preparedA = preparePresetReference(a, definitions);
assert.strictEqual(preparePresetReference(a, definitions), preparedA);
assert.notStrictEqual(preparePresetReference(b, definitions).root, preparedA.root);
const originalParse = JSON.parse;
let parses = 0;
JSON.parse = (...args) => { parses++; return originalParse(...args); };
for (let index = 0; index < 1000; index++) preparePresetReference(a, definitions);
JSON.parse = originalParse;
assert.equal(parses, 0, "unchanged reference preparation never reparses JSON");

const targets = collectPresetLLMTargets(a, definitions);
assert.equal(targets.length, 2, "repeated nested preset IDs remain separate occurrences");
assert.deepEqual(targets.map((target) => target.identity.path), ["5", "6"]);
assert.strictEqual(collectPresetLLMTargets(a, definitions), targets);
assert.notStrictEqual(targets[0].node, targets[1].node);
const widget = (node, name) => node.widgets.find((entry) => entry.name === name);
widget(targets[0].node, "positive").value = "local A first";
targets[0].commit();
widget(targets[1].node, "positive").value = "local A second";
widget(targets[1].graph.getNodeById(2), "count").value = 9;
targets[1].commit();
assert(targets.every((target) => target.current()), "sequential targets remain current after previous local commits");
let local = preparePresetReference(a, definitions);
assert.equal(presetOccurrenceChild(local.root, 5).api_graph.output[1].inputs.positive, "local A first");
assert.equal(presetOccurrenceChild(local.root, 6).api_graph.output[1].inputs.positive, "local A second");
assert.equal(presetOccurrenceChild(local.root, 6).api_graph.output[2].inputs.count, 9);
// Exercise the production count traversal against occurrence definitions.
const uiSource = fs.readFileSync(new URL("../web/scene_prompt_ui.js", import.meta.url), "utf8");
function uiFunction(name) {
    const start = uiSource.indexOf(`function ${name}(`), body = uiSource.indexOf(") {", start);
    let depth = 0;
    for (let index = body + 2; index < uiSource.length; index++) {
        if (uiSource[index] === "{") depth++;
        if (uiSource[index] === "}" && --depth === 0) return uiSource.slice(start, index + 1);
    }
    throw new Error(`Missing function ${name}`);
}
const statsContext = vm.createContext({ Map, Set, Number, Object, String,
    scenePresetDisplayGraphs: definitions, SCENE_PROMPT_QUEUE_INPUT_COUNT: 10,
    clampSceneCount: (value, fallback) => Number(value) || fallback });
for (const name of ["scenePresetGraphNodes", "apiLink", "apiInput", "scenePresetStats", "emptyScenePromptStats",
    "sceneStatNumber", "sceneStatProduct", "sceneStatSum", "sceneStatsSeed", "sceneStatsResult", "sceneStatsCount", "sceneStatsQueue"])
    vm.runInContext(uiFunction(name), statsContext);
assert.equal(statsContext.scenePresetStats("outer", null, new Set(), local.root).total, 11);
assert.equal(statsContext.scenePresetStats("outer", null, new Set(), preparePresetReference(b, definitions).root).total, 4,
    "independent references compute distinct counts using their own nested definitions");
assert.equal(presetOccurrenceChild(preparePresetReference(b, definitions).root, 5).api_graph.output[1].inputs.positive, "shared");
assert.equal(JSON.stringify([...definitions]), original, "generation never mutates shared definitions");

const liveDefinitions = new Map(definitions), live = reference(44, "{}");
const beforeReplace = preparePresetReference(live, liveDefinitions);
const pendingLive = collectPresetLLMTargets(live, liveDefinitions);
const revisedInner = structuredClone(inner);
revisedInner.api_graph.output[1].inputs.positive = "shared update";
liveDefinitions.set("inner", revisedInner);
assert(!pendingLive[0].current(), "shared definition replacement invalidates pending generation");
const afterReplace = preparePresetReference(live, liveDefinitions);
assert.notStrictEqual(afterReplace, beforeReplace, "same Map nested entry replacement rebuilds occurrence preparation");
assert.equal(presetOccurrenceChild(afterReplace.root, 5).api_graph.output[1].inputs.positive, "shared update");
const unrelated = definition("unused", {});
liveDefinitions.set("unused", unrelated);
assert.strictEqual(preparePresetReference(live, liveDefinitions), afterReplace, "unrelated shared entry changes retain preparation");
const revisedOuter = structuredClone(outer);
revisedOuter.api_graph.output[7].inputs.scene_prompt5 = ["5", 0];
liveDefinitions.set("outer", revisedOuter);
const rootReplaced = preparePresetReference(live, liveDefinitions);
assert.notStrictEqual(rootReplaced, afterReplace, "same Map root entry replacement rebuilds preparation");
assert.deepEqual(rootReplaced.root.api_graph.output[7].inputs.scene_prompt5, ["5", 0]);

const ownInner = structuredClone(inner);
ownInner.api_graph.output[1].inputs.positive = "owned child";
const ownOuter = structuredClone(outer);
ownOuter.api_graph.output[5].inputs.llm_presets_json = JSON.stringify({ version: 1, presets: { ".": ownInner } });
const inheritedInner = structuredClone(inner);
inheritedInner.api_graph.output[1].inputs.positive = "inherited child";
const owned = reference(42, JSON.stringify({ version: 1, presets: { ".": ownOuter, "5": inheritedInner } }));
assert.equal(presetOccurrenceChild(preparePresetReference(owned, definitions).root, 5).api_graph.output[1].inputs.positive, "owned child");
const ownTargets = collectPresetLLMTargets(owned, definitions);
widget(ownTargets[0].node, "positive").value = "updated owned child";
ownTargets[0].commit();
assert.equal(presetOccurrenceChild(preparePresetReference(owned, definitions).root, 5).api_graph.output[1].inputs.positive, "updated owned child",
    "child commit updates its own override instead of losing to stale child ownership");

function loraNode() {
    return { type: "SceneApplyLora", comfyClass: "SceneApplyLora", properties: {}, pos: [0, 0], size: [300, 150],
        inputs: [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }], outputs: [{ type: "SCENE_PROMPT", links: [] }],
        widgets: ["lora_name", "model_mode", "positive"].map((name) => ({ name, value: "" })),
        serialize() { return { id: this.id, type: this.type, pos: this.pos, size: this.size, properties: structuredClone(this.properties),
            inputs: structuredClone(this.inputs), outputs: structuredClone(this.outputs) }; } };
}
const insertionTargets = collectPresetLLMTargets(a, definitions);
const first = insertionTargets[0];
// Add a branch to a nonzero target socket to exercise exact reconnection.
const queue = loraNode(); queue.type = queue.comfyClass = "ScenePrompterQueue";
queue.inputs = Array.from({ length: 6 }, (_, index) => ({ name: `scene_prompt${index + 1}`, type: "SCENE_PROMPT", link: null }));
first.graph.add(queue);
first.node.connect(0, queue, 4);
const formerTargets = first.node.outputs[0].links.map((id) => first.graph.links[id]).map((link) => [link.target_id, link.target_slot]);
const candidates = [1, 2].map((id) => ({ model_id: id, version_id: id, file_id: id, lora_name: `llm/${id}.safetensors`, triggers: [`trigger${id}`] }));
const detachedSources = [];
function nativeFactory() {
    const node = loraNode(), baseSerialize = node.serialize;
    node.widgets.push({ name: "LoRA select", value: "gallery", options: { serialize: false } },
        { name: "state list", value: { transient: true }, serialize: false });
    node.widgets.reverse();
    node.serialize = function () {
        assert(this.graph == null, "native DOM serializer must run before any fake graph binding");
        this.snapshotCalls = (this.snapshotCalls || 0) + 1;
        const named = Object.fromEntries(["lora_name", "model_mode", "positive"].map((name) => [name, widget(this, name).value]));
        return { ...baseSerialize.call(this), widgets_values: Object.values(named), widgets_values_named: named };
    };
    node.onRemoved = function () {
        assert(this.graph == null);
        assert(this.scenePresetDetachedSnapshot);
        this.cleaned = true;
    };
    detachedSources.push(node);
    return node;
}
const additions = insertLoras(first.graph, first.node, candidates, nativeFactory);
assert.equal(additions.length, 2);
for (let index = 0; index < additions.length; index++) {
    assert.notStrictEqual(additions[index], detachedSources[index], "local graph stores a separate plain facade");
    assert.strictEqual(first.graph.getNodeById(additions[index].id), additions[index]);
    assert.equal(detachedSources[index].snapshotCalls, 1);
    assert(detachedSources[index].cleaned);
    assert(detachedSources[index].graph == null, "native original remains detached after insertion");
}
assert.equal(first.graph.links[first.node.outputs[0].links[0]].target_id, additions[0].id);
assert.equal(first.graph.links[additions[0].outputs[0].links[0]].target_id, additions[1].id);
assert.deepEqual(additions[1].outputs[0].links.map((id) => first.graph.links[id]).map((link) => [link.target_id, link.target_slot]), formerTargets);
assert.equal(insertLoras(first.graph, first.node, candidates, loraNode).length, 0, "repeat generation reuses adjacent identities");
// Mimic native attach/rAF controls: UI-only widgets and displayed widget order
// differ from the canonical serialized transport emitted by SceneApplyLora.
const nativeLora = additions[0], nativeSerialize = nativeLora.serialize;
nativeLora.widgets.push({ name: "LoRA select", value: "gallery", options: { serialize: false } },
    { name: "state list", value: { transient: true }, serialize: false });
nativeLora.widgets.reverse();
nativeLora.serialize = function () {
    const named = Object.fromEntries(["lora_name", "model_mode", "positive"].map((name) => [name, widget(this, name).value]));
    return { ...nativeSerialize.call(this), widgets_values: Object.values(named), widgets_values_named: named };
};
first.commit();
const inserted = parsePresetOverrides(a.widgets[1].value)["5"];
const nativeWorkflowNode = inserted.workflow.nodes.find((node) => node.id === nativeLora.id);
assert(detachedSources.every((node) => node.snapshotCalls === 1), "later commits never invoke native DOM serialization again");
assert.deepEqual(nativeWorkflowNode.widgets_values, ["llm/1.safetensors", "", "trigger1"], "new native node canonical widget ordering survives UI control attachment");
assert.deepEqual(Object.keys(nativeWorkflowNode.widgets_values_named), ["lora_name", "model_mode", "positive"]);
assert(!Object.hasOwn(inserted.api_graph.output[String(nativeLora.id)].inputs, "LoRA select"));
assert(!Object.hasOwn(inserted.api_graph.output[String(nativeLora.id)].inputs, "state list"));
assert(!a.widgets[1].value.includes("scenePresetDetachedSnapshot"), "detached lifecycle flag is not serialized into workflow state");
// A later occurrence commit traverses the already-attached parent graph again.
insertionTargets[1].commit();
const afterSecondCommit = parsePresetOverrides(a.widgets[1].value)["5"];
assert.deepEqual(afterSecondCommit.workflow.nodes.find((node) => node.id === nativeLora.id).widgets_values, nativeWorkflowNode.widgets_values);
widget(nativeLora, "positive").value = "edited trigger";
first.commit();
const editedFacade = parsePresetOverrides(a.widgets[1].value)["5"];
assert.equal(editedFacade.api_graph.output[String(nativeLora.id)].inputs.positive, "edited trigger");
assert.equal(editedFacade.workflow.nodes.find((node) => node.id === nativeLora.id).widgets_values_named.positive, "edited trigger",
    "plain facade canonical serialization follows later scalar edits");
assert(detachedSources.every((node) => node.snapshotCalls === 1));
assert.deepEqual(inserted.api_graph.output[2].inputs.scene_prompt, [String(additions[1].id), 0]);
assert.deepEqual(inserted.api_graph.output[String(queue.id)].inputs.scene_prompt5, [String(additions[1].id), 0]);
for (const link of inserted.workflow.links) {
    const target = inserted.workflow.nodes.find((node) => node.id === link[3]);
    assert.deepEqual(inserted.api_graph.output[String(link[3])].inputs[target.inputs[link[4]].name], [String(link[1]), link[2]]);
}
const editor = presetEditorDefinition(a, definitions);
const editorChild = parsePresetOverrides(editor.api_graph.output[5].inputs.llm_presets_json)["."];
const editorReferenceNode = editor.workflow.nodes.find((node) => node.id === 5);
assert.equal(editorReferenceNode.widgets_values[2], editor.api_graph.output[5].inputs.llm_presets_json,
    "local state appends after the existing hidden run_handle widget");
assert.equal(editorChild.api_graph.output[1].inputs.positive, "local A first");
assert.equal(editorChild.api_graph.output[String(additions[0].id)].inputs.lora_name, "llm/1.safetensors");
assert.equal(JSON.stringify([...definitions]), original);
// Real widget order includes the preexisting optional hidden run handle.
const threeWidgetRoot = structuredClone(editor);
const threeWidgetReference = threeWidgetRoot.workflow.nodes.find((node) => node.id === 6);
threeWidgetReference.widgets_values = ["inner", "existing-run-handle", threeWidgetRoot.api_graph.output[6].inputs.llm_presets_json];
const threeWidgetSource = reference(45, JSON.stringify({ version: 1, presets: { ".": threeWidgetRoot } }));
const opened = presetEditorDefinition(threeWidgetSource, definitions);
const openedReference = opened.workflow.nodes.find((node) => node.id === 6);
assert.equal(openedReference.widgets_values[0], "inner");
assert.equal(openedReference.widgets_values[1], "existing-run-handle");
assert.equal(openedReference.widgets_values[2], opened.api_graph.output[6].inputs.llm_presets_json);
const savedRootDefinitions = new Map(definitions).set("outer", structuredClone(opened));
const savedRootReference = reference(46, "{}");
assert.equal(presetOccurrenceChild(preparePresetReference(savedRootReference, savedRootDefinitions).root, 6).api_graph.output[2].inputs.count, 9,
    "opening local root, explicit root save, and shared root reload retains its three-widget child customization");
const savedEditorReference = reference(43, JSON.stringify({ version: 1, presets: { ".": editor } }));
assert.equal(presetOccurrenceChild(preparePresetReference(savedEditorReference, definitions).root, 6).api_graph.output[2].inputs.count, 9,
    "root editor save/reload retains child-local customization");
const oldSerialized = a.widgets[1].value;
a.widgets[1].value = "";
assert(!first.current(), "undo/external widget edits invalidate pending targets");
a.widgets[1].value = oldSerialized;
assert.throws(() => parsePresetOverrides('{"version":2,"presets":{}}'));

const fullChild = structuredClone(inner);
fullChild.metadata.preset_id = "lazy-child";
fullChild.api_graph.output[1].inputs.positive = "full customized child";
fullChild.api_graph.output[1].inputs.generation_state_json = '{"description":"room","model_mode":"Illustrious","template_version":"1"}';
const fullParent = structuredClone(outer);
fullParent.metadata.preset_id = "lazy-parent";
for (const id of [5, 6]) fullParent.api_graph.output[id].inputs.preset_id = "lazy-child";
fullParent.api_graph.output[5].inputs.llm_presets_json = JSON.stringify({ version: 1, presets: { ".": fullChild } });
delete fullParent.api_graph.output[7].inputs.scene_prompt5;
function compactPreset(full, local = false) {
    const output = {};
    for (const [id, node] of Object.entries(full.api_graph.output)) {
        const inputs = Object.fromEntries(Object.entries(node.inputs || {}).filter(([name, value]) => Array.isArray(value) || ["preset_id", "count"].includes(name)));
        if (node.inputs?.llm_presets_json) {
            const overrides = parsePresetOverrides(node.inputs.llm_presets_json);
            inputs.llm_presets_json = JSON.stringify({ version: 1, presets: Object.fromEntries(Object.entries(overrides).map(([path, preset]) => [path, compactPreset(preset, true)])) });
        }
        output[id] = { class_type: node.class_type, inputs,
            ...(node.class_type === "ScenePromptLLM" ? { has_llm_input: !!node.inputs.description.trim() } : {}) };
    }
    return { metadata: structuredClone(full.metadata), api_graph: { output }, ...(local ? { scene_compact: true,
        workflow: { nodes: full.workflow.nodes.map(({ id, mode }) => ({ id, mode })) } } : {}) };
}
const compactDefinitions = new Map([["lazy-parent", compactPreset(fullParent)], ["lazy-child", compactPreset(fullChild)]]);
const lazyReference = reference(60, "{}"); lazyReference.widgets[0].value = "lazy-parent";
preparePresetReference(lazyReference, compactDefinitions);
assert(presetReferenceHasLLM(lazyReference), "compact availability uses has_llm_input without workflow hydration");
assert.equal(presetEditorDefinition(lazyReference, compactDefinitions), null, "compact editor root cannot replace the real full response");
const requests = [];
const compactBeforeHydration = JSON.stringify([...compactDefinitions]);
const lazyOperation = createPresetOperation(compactDefinitions);
await hydratePresetReference(lazyReference, lazyOperation, async (id) => {
    requests.push(id); return structuredClone(id === "lazy-parent" ? fullParent : fullChild);
});
assert.deepEqual(requests, ["lazy-parent"], "full ancestor restores customized child without fetching or replacing it by its shared ID");
assert.equal(JSON.stringify([...compactDefinitions]), compactBeforeHydration, "full hydration never promotes the global display sources");
const hydrated = collectPresetLLMTargets(lazyReference, lazyOperation.definitions);
assert.equal(hydrated.length, 1, "unreachable second Reference is not hydrated or generated");
assert.equal(widget(hydrated[0].node, "positive").value, "full customized child", "full ancestor restores its actual own child definition");
assert.equal(widget(hydrated[0].node, "generation_state_json").value, fullChild.api_graph.output[1].inputs.generation_state_json);
hydrated[0].commit();
assert(!lazyReference.widgets[1].value.includes('"scene_compact":true'), "compact transport markers never persist into Reference state");
const requestsBeforeCached = requests.length;
await hydratePresetReference(lazyReference, lazyOperation, async () => { throw new Error("Unexpected extra source request"); });
assert.equal(requests.length, requestsBeforeCached);
const cachedReference = reference(61, "{}"); cachedReference.widgets[0].value = "lazy-parent";
const freshCompact = new Map([["lazy-parent", compactPreset(fullParent)], ["lazy-child", compactPreset(fullChild)]]);
const cachedOperation = createPresetOperation(freshCompact);
let nextActionRequests = 0;
await hydratePresetReference(cachedReference, cachedOperation, async () => { nextActionRequests++; return fullParent; });
assert.equal(nextActionRequests, 1, "a new action fetches its current full source instead of a completed action's payload");
assert(presetReferenceHasLLM(cachedReference));
const sharedParent = structuredClone(fullParent); sharedParent.metadata.preset_id = "lazy-shared-parent";
delete sharedParent.api_graph.output[5].inputs.llm_presets_json;
const sharedReference = reference(62, "{}"); sharedReference.widgets[0].value = "lazy-shared-parent";
const sharedDefinitions = new Map([["lazy-shared-parent", compactPreset(sharedParent)], ["lazy-child", compactPreset(fullChild)]]);
const sharedRequests = [];
const sharedOperation = createPresetOperation(sharedDefinitions);
await hydratePresetReference(sharedReference, sharedOperation, async (id) => {
    sharedRequests.push(id); return structuredClone(id === "lazy-shared-parent" ? sharedParent : fullChild);
});
assert.deepEqual(sharedRequests, ["lazy-shared-parent", "lazy-child"], "uncustomized shared child loads only after its full ancestor");
lazyOperation.dispose(); cachedOperation.dispose(); sharedOperation.dispose();
assert(presetReferenceHasLLM(cachedReference), "disposed hydration restores compact readiness immediately");

// Explicit actions own full definitions and detached targets, including their
// cleanup when another operation has already replaced the live Reference cache.
const lifecycleReference = reference(63); lifecycleReference.widgets[0].value = "lazy-shared-parent";
const firstOperation = createPresetOperation(sharedDefinitions);
await hydratePresetReference(lifecycleReference, firstOperation, async (id) => id === "lazy-shared-parent" ? sharedParent : fullChild);
const firstPrepared = preparePresetReference(lifecycleReference, firstOperation.definitions);
const firstTargets = collectPresetLLMTargets(lifecycleReference, firstOperation.definitions);
assert(firstTargets[0].current());
const nextOperation = createPresetOperation(sharedDefinitions);
await hydratePresetReference(lifecycleReference, nextOperation, async (id) => id === "lazy-shared-parent" ? sharedParent : fullChild);
const nextPrepared = preparePresetReference(lifecycleReference, nextOperation.definitions);
firstOperation.dispose(); firstOperation.dispose();
assert.equal(firstOperation.definitions.size, 0);
assert.equal(firstPrepared.root, null);
assert.equal(firstPrepared.targets, null);
assert.equal(firstPrepared.occurrences.size, 0);
assert.equal(firstTargets[0].current(), false, "disposed target cannot apply a late result");
assert.strictEqual(preparePresetReference(lifecycleReference, nextOperation.definitions), nextPrepared,
    "compare-and-dispose never deletes a newer operation's cache");
const nextTargets = collectPresetLLMTargets(lifecycleReference, nextOperation.definitions);
widget(nextTargets[0].node, "positive").value = "edited inside operation";
nextTargets[0].commit();
const editorCopy = structuredClone(presetEditorDefinition(lifecycleReference, nextOperation.definitions));
nextOperation.dispose();
assert.equal(nextPrepared.root, null);
assert.equal(parsePresetOverrides(editorCopy.api_graph.output[5].inputs.llm_presets_json)["."].api_graph.output[1].inputs.positive,
    "edited inside operation", "projected editor copy survives operation disposal");
const restoredCompact = preparePresetReference(lifecycleReference, sharedDefinitions);
assert.equal(restoredCompact.definitions, sharedDefinitions, "normal preparation no longer owns a full operation source map");

const staleFull = structuredClone(inner); staleFull.metadata.preset_id = "pending-full";
const staleSources = new Map([["pending-full", compactPreset(staleFull)]]);
const staleReference = reference(64); staleReference.widgets[0].value = "pending-full";
const staleOperation = createPresetOperation(staleSources);
let finishSource;
const pendingSource = hydratePresetReference(staleReference, staleOperation, () => new Promise((done) => { finishSource = done; }));
const oldSource = staleSources.get("pending-full");
staleSources.set("pending-full", { ...oldSource });
finishSource(staleFull);
await assert.rejects(pendingSource, /Preset changed while loading/);
staleOperation.dispose();
assert.strictEqual(staleSources.get("pending-full").api_graph, oldSource.api_graph,
    "stale full response never replaces the current compact source");
const freshOperation = createPresetOperation(staleSources);
await hydratePresetReference(staleReference, freshOperation, async () => staleFull);
assert.equal(collectPresetLLMTargets(staleReference, freshOperation.definitions).length, 1,
    "retry starts a fresh context and fetches its current source");
const freshPrepared = preparePresetReference(staleReference, freshOperation.definitions);
staleSources.set("unrelated", unrelated);
assert(freshOperation.current(freshPrepared), "unrelated source updates do not invalidate this action");
staleSources.set("pending-full", { ...oldSource });
assert(!freshOperation.current(freshPrepared), "same Map replacement of a required source invalidates targets");
freshOperation.dispose();

async function operationSourceProbe(id, full, loader) {
    const sources = new Map([[id, compactPreset(full)]]);
    const instance = reference(`probe-${id}`); instance.widgets[0].value = id;
    const operation = createPresetOperation(sources);
    try { await hydratePresetReference(instance, operation, loader); return operation; }
    catch (error) { operation.dispose(); throw error; }
}
function largeSource(id, bytes) {
    return definition(id, {
        1: { class_type: "ScenePromptLLM", inputs: { model_mode: "Illustrious", description: "room", positive: "x".repeat(bytes), negative: "", generation_state_json: "{}" } },
        2: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
    });
}
const activeSources = Array.from({ length: 40 }, (_, index) => largeSource(`active-source-${index}`, 512 * 1024));
const activeCompact = new Map(activeSources.map((full) => [full.metadata.preset_id, compactPreset(full)]));
const activeBefore = JSON.stringify([...activeCompact]);
const activeOperation = createPresetOperation(activeCompact);
let activeLoads = 0, hydrationSerializations = 0;
const savedStringify = JSON.stringify;
JSON.stringify = (...args) => { hydrationSerializations++; return savedStringify(...args); };
try {
    for (const full of activeSources) {
        const instance = reference(`active-${full.metadata.preset_id}`); instance.widgets[0].value = full.metadata.preset_id;
        await hydratePresetReference(instance, activeOperation, async () => { activeLoads++; return full; });
    }
    const duplicate = reference("active-duplicate"); duplicate.widgets[0].value = activeSources[0].metadata.preset_id;
    await hydratePresetReference(duplicate, activeOperation, async () => { throw new Error("one active action shares its full source across references"); });
} finally { JSON.stringify = savedStringify; }
assert.equal(activeLoads, 40);
assert.equal(hydrationSerializations, 0, "full hydration performs no payload-size serialization");
for (const full of activeSources) assert.strictEqual(activeOperation.definitions.get(full.metadata.preset_id), full,
    "all active full sources remain owned beyond the former entry and byte thresholds");
assert.equal(JSON.stringify([...activeCompact]), activeBefore);
activeOperation.dispose();
assert.equal(activeOperation.definitions.size, 0);
let independentLoads = 0;
(await operationSourceProbe(activeSources[0].metadata.preset_id, activeSources[0], async () => { independentLoads++; return activeSources[0]; })).dispose();
assert.equal(independentLoads, 1, "disposed action does not retain a full-source history");

const titleStart = uiSource.indexOf('const SCENE_LORA_CACHE_KEY =');
const titleEnd = uiSource.indexOf('function closeSceneLoraPicker(', titleStart);
let titleDisk = "[]", titleInfoCalls = 0, finishTitleInfo, finishTitleVersion, pauseTitleInfo = false, pauseTitleVersion = false, failTitleInfo = false;
const titleContext = vm.createContext({ Map, Set, Array, String, JSON, Object,
    localStorage: { getItem: () => titleDisk, setItem: (_key, value) => { titleDisk = value; } },
    api: { async fetchApi() {
        titleInfoCalls++;
        if (pauseTitleInfo) { pauseTitleInfo = false; await new Promise((done) => { finishTitleInfo = done; }); }
        if (failTitleInfo) { failTitleInfo = false; return { ok: false, json: async () => ({ error: "missing file" }) }; }
        return { ok: true, json: async () => ({ size: 1, mtime_ns: 1, sha256: "hash", trigger_phrases: [] }) };
    } },
    readApiJson: (response) => response.json(),
    fetch: async () => {
        if (pauseTitleVersion) { pauseTitleVersion = false; await new Promise((done) => { finishTitleVersion = done; }); }
        return { ok: true, status: 200, json: async () => ({ id: 1, model: { name: "Resolved again" } }) };
    },
});
vm.runInContext(`${uiSource.slice(titleStart, titleEnd)}; globalThis.titles = { cachedSceneLora, saveSceneLoraCache, resolveSceneLora, reconcileSceneLoraTitles, sceneLoraSessionCache, sceneLoraFileIdentities, sceneLoraResolutions, sceneLoraCacheKey };`, titleContext);
const legacyTitleContext = vm.createContext({ Map, Array, String, JSON,
    localStorage: { getItem: () => JSON.stringify([{ key: "folder\\legacy.safetensors\u00001\u00001", title: "Legacy cached title", status: "found" }]) },
});
vm.runInContext(`${uiSource.slice(titleStart, titleEnd)}; globalThis.legacyTitle = cachedSceneLora({path:'folder/legacy.safetensors',size:1,mtime_ns:1});`, legacyTitleContext);
assert.equal(legacyTitleContext.legacyTitle.title, "Legacy cached title", "legacy persisted Windows separators migrate to the current normalized identity");
const titles = titleContext.titles, titleItem = (index, revision = 1) => ({ path: `lora-${index}`, size: 1, mtime_ns: revision });
for (let index = 0; index < 300; index++) titles.saveSceneLoraCache(titleItem(index), {}, { model: { name: `Title ${index}` } }, "found");
assert.equal(titles.sceneLoraSessionCache.size, 300, "all current file titles remain usable beyond former count thresholds");
assert.equal(JSON.parse(titleDisk).length, 300);
assert.equal(titles.cachedSceneLora(titleItem(0)).title, "Title 0");
titles.saveSceneLoraCache(titleItem(300), {}, { model: { name: "New" } }, "found");
for (let revision = 2; revision < 302; revision++) titles.saveSceneLoraCache(titleItem(300, revision), {}, { model: { name: "Revision" } }, "found");
assert.equal(titles.sceneLoraSessionCache.size, 301, "same-path revisions replace obsolete titles instead of accumulating history");
assert.equal(JSON.parse(titleDisk).filter((entry) => entry.path === "lora-300").length, 1);
const currentCatalog = Array.from({ length: 300 }, (_, index) => titleItem(index + 1, index === 0 ? 2 : index === 299 ? 301 : 1));
titles.reconcileSceneLoraTitles(currentCatalog);
assert.equal(titles.sceneLoraSessionCache.size, 299, "catalog refresh removes deleted and changed file titles");
assert.equal(JSON.parse(titleDisk).length, 299);
assert.equal(titles.cachedSceneLora(titleItem(0)), null);
const unlisted = titleItem("resolve"); currentCatalog.push(unlisted); titles.reconcileSceneLoraTitles(currentCatalog);
const [resolvedTitle, duplicateTitle] = await Promise.all([titles.resolveSceneLora(unlisted), titles.resolveSceneLora(unlisted)]);
assert.equal(resolvedTitle.title, "Resolved again");
assert.strictEqual(resolvedTitle, duplicateTitle);
assert.equal(titleInfoCalls, 1, "current uncached file resolves with in-flight deduplication");
assert.equal(titles.sceneLoraResolutions.size, 0);
assert.equal(titles.sceneLoraSessionCache.size, 300);
for (const stage of ["info", "version"]) {
    const late = titleItem(`late-${stage}`); currentCatalog.push(late); titles.reconcileSceneLoraTitles(currentCatalog);
    if (stage === "info") pauseTitleInfo = true; else pauseTitleVersion = true;
    const pending = titles.resolveSceneLora(late);
    while (!(stage === "info" ? finishTitleInfo : finishTitleVersion)) await new Promise((done) => setImmediate(done));
    currentCatalog.splice(currentCatalog.indexOf(late), 1); titles.reconcileSceneLoraTitles(currentCatalog);
    (stage === "info" ? finishTitleInfo : finishTitleVersion)();
    await assert.rejects(pending, /再表示/);
    assert(!titles.sceneLoraSessionCache.has(late.path), "late metadata cannot repopulate a removed file identity");
    assert(!JSON.parse(titleDisk).some((entry) => entry.path === late.path));
    assert.equal(titles.sceneLoraResolutions.size, 0);
}
const acquiredFile = { path: "llm/newly-acquired.safetensors" };
const acquired = await titles.resolveSceneLora(acquiredFile);
assert.equal(acquired.title, "Resolved again", "newly acquired selected file can resolve before the old catalog is refreshed");
assert.equal(titles.sceneLoraFileIdentities.get(acquiredFile.path).key, titles.sceneLoraCacheKey({ ...acquiredFile, size: 1, mtime_ns: 1 }));
failTitleInfo = true;
const absentFile = { path: "missing.safetensors" };
await assert.rejects(titles.resolveSceneLora(absentFile), /missing file/);
assert(!titles.sceneLoraFileIdentities.has(absentFile.path), "failed uncatalogued lookup releases its temporary identity");
const changedFile = titleItem("changed-file"); currentCatalog.push(changedFile); titles.reconcileSceneLoraTitles(currentCatalog);
finishTitleVersion = null; pauseTitleVersion = true;
const changedLookup = titles.resolveSceneLora(changedFile);
while (!finishTitleVersion) await new Promise((done) => setImmediate(done));
changedFile.mtime_ns = 2; titles.reconcileSceneLoraTitles(currentCatalog);
finishTitleVersion();
await assert.rejects(changedLookup, /再表示/);
assert(!titles.sceneLoraSessionCache.has(changedFile.path), "late version reply cannot publish an obsolete same-path revision");

const largeOutput = {};
for (let index = 1; index <= 1500; index++) largeOutput[index] = { class_type: "ScenePromptCounter", inputs: { count: index } };
largeOutput[1501] = { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1500", 0] } };
const large = definition("large", largeOutput), largeReference = reference(50);
largeReference.widgets[0].value = "large";
largeReference.widgets[1].value = JSON.stringify({ version: 1, presets: { ".": large } });
const largeDefinitions = new Map([["large", large]]), started = performance.now();
preparePresetReference(largeReference, largeDefinitions);
const firstMs = performance.now() - started;
const cachedStarted = performance.now();
for (let index = 0; index < 10000; index++) preparePresetReference(largeReference, largeDefinitions);
console.log(`Preset local regression passed; 1501-node prepare ${firstMs.toFixed(1)} ms, 10000 cache hits ${(performance.now() - cachedStarted).toFixed(1)} ms.`);

// A generated leaf is stored once even through eight nested References. Source
// definitions and intermediate run-handle positions must remain untouched.
const nestedSizes = [];
for (let depth = 0; depth <= 8; depth++) {
    const nestedDefinitions = new Map([["depth0", definition("depth0", {
        1: { class_type: "ScenePromptLLM", inputs: { description: "room", positive: "", negative: "", model_mode: "Illustrious" } },
        8: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
    })]]);
    for (let index = 1; index <= depth; index++) nestedDefinitions.set(`depth${index}`, definition(`depth${index}`, {
        5: { class_type: "ScenePresetReference", inputs: { preset_id: `depth${index - 1}`, run_handle: "keep-handle" } },
        8: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["5", 0] } },
    }));
    const sources = JSON.stringify([...nestedDefinitions]);
    const source = reference(100 + depth); source.widgets[0].value = `depth${depth}`;
    const [target] = collectPresetLLMTargets(source, nestedDefinitions);
    widget(target.node, "positive").value = "x".repeat(1024);
    target.commit();
    const serialized = source.widgets[1].value;
    nestedSizes.push(Buffer.byteLength(serialized));
    assert(nestedSizes.at(-1) < 250 * 1024, `depth ${depth} exceeds compact storage budget`);
    assert.equal(Object.keys(parsePresetOverrides(serialized)).length, 1, "unchanged shared ancestors need no local copy");
    assert.equal(widget(collectPresetLLMTargets(source, nestedDefinitions)[0].node, "positive").value, "x".repeat(1024));
    assert.equal(JSON.stringify([...nestedDefinitions]), sources);
    const rootEditor = presetEditorDefinition(source, nestedDefinitions);
    const saved = new Map(nestedDefinitions).set(`depth${depth}`, rootEditor);
    const reloaded = reference(200 + depth); reloaded.widgets[0].value = `depth${depth}`;
    assert.equal(widget(collectPresetLLMTargets(reloaded, saved)[0].node, "positive").value, "x".repeat(1024),
        "explicit editor root Save retains deeply nested generated output");
}
assert(nestedSizes.at(-1) < nestedSizes[0] + 100, "flat path length is the only growth for a shared ancestor chain");

// Legacy sources can own child overrides at every level. Resolve that ownership
// first, including unrelated siblings, then clear all embedded representations.
const legacyDefinitions = new Map([["inner", inner]]);
let legacyChild = structuredClone(inner);
legacyChild.api_graph.output[1].inputs.positive = "legacy leaf";
for (let index = 1; index <= 8; index++) {
    const id = `legacy${index}`, childId = index === 1 ? "inner" : `legacy${index - 1}`;
    const state = JSON.stringify({ version: 1, presets: { ".": legacyChild } });
    const parent = definition(id, {
        5: { class_type: "ScenePresetReference", inputs: { preset_id: childId, run_handle: "keep-handle", llm_presets_json: state } },
        8: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["5", 0] } },
    });
    parent.workflow.nodes[0].widgets_values_named = { preset_id: childId, run_handle: "keep-handle", llm_presets_json: state };
    legacyDefinitions.set(id, parent);
    legacyChild = parent;
}
const legacySource = reference(300); legacySource.widgets[0].value = "legacy8";
const legacyTargets = collectPresetLLMTargets(legacySource, legacyDefinitions);
assert.equal(widget(legacyTargets[0].node, "positive").value, "legacy leaf");
widget(legacyTargets[0].node, "positive").value = "updated legacy leaf";
legacyTargets[0].commit();
assert(Buffer.byteLength(legacySource.widgets[1].value) < 250 * 1024);
for (const local of Object.values(parsePresetOverrides(legacySource.widgets[1].value))) {
    for (const entry of Object.values(local.api_graph.output))
        if (entry.class_type === "ScenePresetReference") assert.equal(entry.inputs.llm_presets_json, "");
    for (const node of local.workflow.nodes) if (node.type === "ScenePresetReference") {
        assert.equal(node.widgets_values[1], "keep-handle");
        assert.equal(node.widgets_values[2], "");
        assert.equal(node.widgets_values_named.llm_presets_json, "");
    }
}
assert.equal(widget(collectPresetLLMTargets(legacySource, legacyDefinitions)[0].node, "positive").value, "updated legacy leaf");
const legacyEditor = presetEditorDefinition(legacySource, legacyDefinitions);
const legacyReload = reference(301); legacyReload.widgets[0].value = "legacy8";
assert.equal(widget(collectPresetLLMTargets(legacyReload, new Map(legacyDefinitions).set("legacy8", legacyEditor))[0].node, "positive").value,
    "updated legacy leaf", "editor flat child projection overrides stale shared ancestor ownership");
console.log(`Compact nested Preset bytes at depths 0..8: ${nestedSizes.join(", ")}.`);

// Both commit orders keep edited ancestor output and generated child output.
const ancestor = structuredClone(ownOuter);
ancestor.api_graph.output[9] = { class_type: "ScenePromptLLM", inputs: { scene_prompt: ["7", 0],
    description: "ancestor", positive: "ancestor shared", negative: "", model_mode: "Illustrious" } };
ancestor.api_graph.output[8].inputs.scene_prompt = ["9", 0];
ancestor.workflow = definition("outer", ancestor.api_graph.output).workflow;
for (const order of [[0, 2], [2, 0]]) {
    const instance = reference(400 + order[0], JSON.stringify({ version: 1, presets: { ".": ancestor } }));
    const ordered = collectPresetLLMTargets(instance, definitions);
    assert.equal(ordered.length, 3);
    for (const index of order) {
        widget(ordered[index].node, "positive").value = index === 0 ? "descendant edited" : "ancestor edited";
        ordered[index].commit();
        assert(ordered.every((target) => target.current()));
    }
    const resolved = preparePresetReference(instance, definitions);
    assert.equal(resolved.root.api_graph.output[9].inputs.positive, "ancestor edited");
    assert.equal(presetOccurrenceChild(resolved.root, 5).api_graph.output[1].inputs.positive, "descendant edited");
    const editedRoot = presetEditorDefinition(instance, definitions);
    const restored = reference(410 + order[0]);
    const restoredPrepared = preparePresetReference(restored, new Map(definitions).set("outer", editedRoot));
    assert.equal(restoredPrepared.root.api_graph.output[9].inputs.positive, "ancestor edited");
    assert.equal(presetOccurrenceChild(restoredPrepared.root, 5).api_graph.output[1].inputs.positive, "descendant edited");
    assert.equal(presetOccurrenceChild(restoredPrepared.root, 6).api_graph.output[1].inputs.positive, "shared");
}
