import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import vm from "node:vm";
import { preparePresetReference, presetOccurrenceChild, collectPresetLLMTargets,
    presetEditorDefinition, parsePresetOverrides } from "../web/scene_llm_presets.js";
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
const additions = insertLoras(first.graph, first.node, candidates, loraNode);
assert.equal(additions.length, 2);
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
assert.deepEqual(nativeWorkflowNode.widgets_values, ["llm/1.safetensors", "", "trigger1"], "new native node canonical widget ordering survives UI control attachment");
assert.deepEqual(Object.keys(nativeWorkflowNode.widgets_values_named), ["lora_name", "model_mode", "positive"]);
assert(!Object.hasOwn(inserted.api_graph.output[String(nativeLora.id)].inputs, "LoRA select"));
assert(!Object.hasOwn(inserted.api_graph.output[String(nativeLora.id)].inputs, "state list"));
// A later occurrence commit traverses the already-attached parent graph again.
insertionTargets[1].commit();
const afterSecondCommit = parsePresetOverrides(a.widgets[1].value)["5"];
assert.deepEqual(afterSecondCommit.workflow.nodes.find((node) => node.id === nativeLora.id).widgets_values, nativeWorkflowNode.widgets_values);
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
