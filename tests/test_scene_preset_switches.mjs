import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as switches from "../web/scene_prompt_switches.js";
import { parseMatrixState, createMatrixLine } from "../web/scene_prompt_state.js";
import { collectLLMTargets, hasLLMTargets } from "../web/scene_prompt_llm.js";
import { createPresetGraph, preparePresetReference, collectPresetLLMTargets, presetReferenceHasLLM } from "../web/scene_llm_presets.js";

const source = fs.readFileSync(new URL("../web/scene_prompt_ui.js", import.meta.url), "utf8");
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`), body = source.indexOf(") {", start);
    assert(start >= 0, name);
    let depth = 0;
    for (let index = body + 2; index < source.length; index++) {
        if (source[index] === "{") depth++;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(name);
}
const types = {
    isScenePromptNode: "ScenePrompter", isSceneLLMNode: "ScenePromptLLM", isPromptMatrixNode: "SceneMatrix",
    isScenePathNode: "ScenePath", isScenePromptMergeNode: "ScenePrompterMerge", isScenePromptDeleteNode: "ScenePromptDelete",
    isScenePromptReverseNode: "ScenePromptReverse", isScenePromptCounterNode: "ScenePromptCounter",
    isScenePromptRandomRouteNode: "ScenePromptRandomRoute", isSceneEmptyLatentNode: "SceneEmptyLatent",
    isScenePresetReferenceNode: "ScenePresetReference", isScenePresetInputNode: "ScenePresetInput",
    isScenePromptCallbackNode: "ScenePromptCallback", isSceneApplyModelNode: "SceneApplyModel", isSceneApplyLoraNode: "SceneApplyLora",
    isScenePromptQueueNode: "ScenePrompterQueue", isScenePromptRandomRouteOutputNode: "ScenePromptRandomRouteOutput",
};
const ctx = { ...switches, Set, Map, Math, JSON, String, Number, Array, Object, parseMatrixState,
    app: { graph: null }, scenePresetDisplayGraphs: new Map(),
    sceneWorkflowLoadDepth: 0, sceneWorkflowLoadSources: new Set(), sceneDownstreamRefreshSources: new Set(), sceneDownstreamRefreshTimer: null,
    setTimeout: () => 1, clearTimeout: () => {}, scheduleSceneNodeRefresh: () => {}, installSceneNodeRemovalCleanup: () => {},
    SCENE_WIDGET_LABELS: { order_mode: "順番", alternate_block_size: "交互ブロック", downstream_count_mode: "Count" },
    SCENE_PROMPT_QUEUE_INPUT_COUNT: 10, SCENE_PROMPT_QUEUE_INPUT_NAMES: new Set(Array.from({ length: 10 }, (_, i) => `scene_prompt${i + 1}`)),
    SCENE_QUEUE_CONTROL_NAMES: ["order_mode", "alternate_block_size", "downstream_count_mode"],
    SCENE_QUEUE_CONTROL_DEFAULTS: { order_mode: "input_order", alternate_block_size: 1, downstream_count_mode: "multiply" },
    SCENE_QUEUE_DISPLAY_PREVIEW_ROWS: 160, MATRIX_SECTION_VISIBLE_ROWS: 160, SCENE_COUNT_MAX: Number.MAX_SAFE_INTEGER,
    MATRIX_DEFAULT_JSON: "{}", clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
    findWidget: (node, name) => node?.widgets?.find(widget => widget.name === name),
    scenePromptTitle: node => node.title, scenePathTitle: node => node.title, scenePromptReverseScope: () => "all",
    normalizePathMode: v => v || "append", ensureMatrixJsonWidget: node => ctx.findWidget(node, "matrix_json"),
    matrixLinesForNode: node => parseMatrixState(ctx.findWidget(node, "matrix_json")?.value).sets.filter(row => row.enabled),
    matrixConfiguredLineCount: node => parseMatrixState(ctx.findWidget(node, "matrix_json")?.value).sets.length,
    matrixLineLabel: row => row.name, emptyMatrixRow: () => ({ labels: [], path_parts: [] }),
    mergeScenePromptRows: (left, right) => ({ ...left, ...right }),
};
for (const [name, type] of Object.entries(types)) ctx[name] = node => node?.type === type;
ctx.isScenePromptJoinNode = node => ctx.isScenePromptQueueNode(node) || ctx.isScenePromptRandomRouteOutputNode(node);
ctx.isSceneExpandNode = node => node?.type === "ScenePromptExpand";
vm.createContext(ctx);
const funcs = ["nodeClassName", "nodeClassNames", "isRerouteNode", "isScenePromptSourceNode", "liteGraphNodeMode", "sceneNodeMode", "isSceneNodeMuted", "isSceneNodeBypassed", "sceneNodeRevision",
    "linkedInput", "graphLink", "firstLinkedInput", "linkKey", "resolveLinkedSourceFromLink", "resolveLinkedSourceFromInput", "linkedSourceNode",
    "scenePromptInputSource", "sceneBypassInputSource", "scenePromptSourceLocalCacheKey", "scenePromptLineageKey", "scenePromptSourceCacheKey",
    "clampSceneCount", "scenePrimitiveInputValue", "scenePromptCounterCount", "scenePromptCounterDownstreamEnabled", "sceneEmptyLatentConfig", "scenePromptSettingsError",
    "scenePresetGraphNodes", "apiLink", "apiInput", "parseMatrixStateValue", "scenePresetStats",
    "sceneQueueBoundaryInPreset", "sceneQueueBoundaryInNode", "sceneRandomRouteInNode", "sceneQueuePendingInNode", "scenePromptStats",
    "scenePromptInputNumber", "scenePromptQueueInputIndexes", "connectedScenePromptSourcesForQueue", "connectedScenePromptSourcesForMerge", "scenePromptPreviewEntries", "mergeScenePromptEntryPair",
    "multiplyScenePromptEntryCount", "scenePromptEntryBatchSize", "scenePromptEntryImageCount", "sceneQueueDisplayPartsForEntry", "sceneRandomJoinReady", "sceneRandomChoicePlan", "applyScenePresetSwitchBindings",
    "downstreamNodes", "collectDownstreamSceneNodes", "clearSceneComputedCaches", "flushDownstreamSceneRefreshes", "refreshDownstreamSceneNodes", "sceneQueueLockState", "syncSceneQueueControls", "attachSceneNode"];
const scheduleFuncs = [...source.matchAll(/^function (emptyScenePromptStats|sceneStat\w+|sceneStats\w+|sceneCount\w+|sceneSchedule\w+|sceneRandomGuard|sceneRandomZeroArm)\(/gm)]
    .map(match => match[1]).filter(name => !["sceneCounterConfiguredValues", "sceneCounterConfigureValues"].includes(name));
for (const name of new Set([...funcs, ...scheduleFuncs])) vm.runInContext(functionSource(name), ctx);
const plain = value => JSON.parse(JSON.stringify(value));
const vector = (...on) => Array.from({ length: 10 }, (_, i) => on.includes(i + 1));
const identity = Array.from({ length: 10 }, (_, i) => i + 1);
assert.deepEqual(switches.sceneSwitchNames('["名前", "", "名前"]'), ["名前", "スイッチ2", "名前", ...Array.from({ length: 7 }, (_, i) => `スイッチ${i + 4}`)]);
assert.deepEqual(switches.resolveSceneSwitchSettings(undefined, undefined), vector());
assert.deepEqual(switches.resolveSceneSwitchSettings(vector(1, 3, 10), "[]"), vector(1, 3, 10));
assert.deepEqual(switches.resolveSceneSwitchSettings(vector(1), JSON.stringify([2, 1, 1, true, false, 6, 7, 8, 9, 10])), vector(2, 3, 4));
for (const bad of ["{}", "[0]", JSON.stringify(identity.map((n, i) => i === 3 ? "true" : n)), JSON.stringify([...identity, 1])])
    assert.throws(() => switches.sceneSwitchSettings(bad));
assert.throws(() => switches.sceneSwitchValues([true]));
assert.throws(() => switches.sceneSwitchValues(identity));

function graph() { const nodes = new Map(); return { nodes, links: {}, lastLink: 0, getNodeById(id) { return nodes.get(String(id)); } }; }
function add(g, type, values = {}, id = g.nodes.size + 1) {
    const node = { id, type, comfyClass: type, graph: g, mode: 0, title: `${type} #${id}`, properties: {}, inputs: [],
        outputs: [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }], widgets: Object.entries(values).map(([name, value]) => ({ name, value })) };
    if (type === "ScenePresetInput") node.outputs.push(...identity.map(n => ({ name: `switch_${n}`, type: "BOOLEAN", links: [] })), { name: "switches", type: "SCENE_SWITCHES", links: [] });
    if (type === "PrimitiveBoolean") node.outputs[0].type = "BOOLEAN";
    g.nodes.set(String(id), node); return node;
}
function connect(from, to, name, slot = 0, type = "SCENE_PROMPT") {
    const g = to.graph, id = ++g.lastLink;
    let inputSlot = to.inputs.findIndex(input => input.name === name);
    if (inputSlot < 0) { inputSlot = to.inputs.length; to.inputs.push({ name, type }); }
    to.inputs[inputSlot].link = id;
    g.links[id] = { id, origin_id: from.id, origin_slot: slot, target_id: to.id, target_slot: inputSlot, type };
    from.outputs[slot].links.push(id);
}
function set(node, name, value) { ctx.findWidget(node, name).value = value; }
const matrix = count => JSON.stringify({ version: 1, sets: Array.from({ length: count }, (_, i) => ({ ...createMatrixLine(`row${i}`), positive_base: `tag${i}` })) });
for (const configured of [false, true]) {
    const raw = JSON.stringify({ version: 1, sets: configured ? [{ ...createMatrixLine("disabled"), enabled: false }] : [] });
    const live = graph(); ctx.app.graph = live;
    const first = add(live, "ScenePromptCounter", { count: 100_000_000, enable_downstream_count: true });
    const second = add(live, "ScenePromptCounter", { count: 100_000_000, enable_downstream_count: true });
    const rows = add(live, "SceneMatrix", { matrix_json: raw });
    const valid = add(live, "ScenePrompter"), join = add(live, "ScenePrompterQueue");
    connect(first, second, "scene_prompt"); connect(second, rows, "scene_prompt");
    connect(rows, join, "scene_prompt1"); connect(valid, join, "scene_prompt2");
    const error = ctx.scenePromptStats(second).error;
    assert.match(error, /大きすぎ/u);
    assert.equal(ctx.scenePromptStats(join).error, error, "Matrix never turns upstream overflow into a plausible Queue count");
    const definition = { api_graph: { output: {
        1: { class_type: "ScenePresetInput", inputs: {} },
        2: { class_type: "SceneMatrix", inputs: { scene_prompt: ["1", 0], matrix_json: raw } },
        3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
    } } };
    const upstream = ctx.sceneStatsCount(ctx.sceneStatsSeed(), 3);
    assert.equal(ctx.scenePresetStats("matrix-error", { ...upstream, error }, new Set(), definition).error, error);
    assert.equal(ctx.scenePresetStats("matrix-valid", upstream, new Set(), definition).total, configured ? 0 : 3);
    const guarded = ctx.sceneSchedulePlan([], false, [{ gateId: "random", armIndex: 0, weights: [5000, 5000, 0, 0, 0, 0, 0, 0, 0, 0] }]);
    assert.match(ctx.sceneScheduleForPreset("matrix-arm", guarded, new Set(), definition).stats.error, /Queueで合流/u,
        "Preset Matrix uses the same open-arm rule even without enabled rows");
}
for (const arm of [0, 9]) for (const depth of [1, 3]) for (const upstreamKind of ["none", "counted", "held"]) {
    const childId = `random-stats-${arm}`;
    const child = { api_graph: { output: {
        1: { class_type: "ScenePresetInput", inputs: {} },
        2: { class_type: "ScenePromptRandomRoute", inputs: { scene_prompt: ["1", 0],
            weights_json: JSON.stringify(Array.from({ length: 10 }, (_, index) => index === arm ? 10000 : 0)) } },
        3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", arm] } },
    } } };
    ctx.scenePresetDisplayGraphs.set(childId, child);
    let rootId = childId;
    for (let level = 0; level < depth; level++) {
        const parentId = `${childId}-${level}`;
        ctx.scenePresetDisplayGraphs.set(parentId, { api_graph: { output: {
            1: { class_type: "ScenePresetInput", inputs: {} },
            2: { class_type: "ScenePresetReference", inputs: { preset_id: rootId, scene_prompt: ["1", 0] } },
            3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
        } } });
        rootId = parentId;
    }
    const live = graph(), reference = add(live, "ScenePresetReference", { preset_id: rootId });
    ctx.app.graph = live;
    if (upstreamKind !== "none") {
        const rows = add(live, "SceneMatrix", { matrix_json: matrix(2) });
        const latent = add(live, "SceneEmptyLatent", { batch_size: 3, width: 512, height: 512 });
        const counter = add(live, "ScenePromptCounter", { count: 4, enable_downstream_count: upstreamKind !== "held" });
        connect(rows, latent, "scene_prompt"); connect(latent, counter, "scene_prompt"); connect(counter, reference, "scene_prompt");
    }
    const stats = ctx.scenePromptStats(reference);
    assert.equal(stats.total, upstreamKind === "none" ? 1 : 8, "nested single-arm Random retains the upstream generation count");
    assert.equal(stats.totalImages, upstreamKind === "none" ? 1 : 24);
    assert.deepEqual(plain(stats), plain(ctx.sceneScheduleForNode(reference).stats));
    const downstream = add(live, "ScenePromptCounter", { count: 6, enable_downstream_count: true });
    connect(reference, downstream, "scene_prompt");
    assert.equal(ctx.scenePromptStats(downstream).total, upstreamKind === "held" ? 8 : stats.total * 6);
}
{
    const presetId = "unselected-random-stats";
    ctx.scenePresetDisplayGraphs.set(presetId, { api_graph: { output: {
        1: { class_type: "ScenePresetInput", inputs: {} },
        2: { class_type: "ScenePromptRandomRoute", inputs: { weights_json: "invalid", scene_prompt: ["1", 0] } },
        3: { class_type: "ComfySwitchNode", inputs: { switch: false, on_true: ["2", 0], on_false: ["1", 0] } },
        4: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["3", 0] } },
    } } });
    const originalSchedule = ctx.sceneScheduleForPreset;
    let schedules = 0;
    ctx.sceneScheduleForPreset = (...args) => { schedules++; return originalSchedule(...args); };
    assert.equal(ctx.scenePresetStats(presetId, null).total, 1);
    assert.equal(schedules, 0, "an unselected Random arm does not trigger schedule fallback");
    ctx.sceneScheduleForPreset = originalSchedule;
}
{
    const live = graph(); ctx.app.graph = live;
    const size = add(live, "GetImageSize"); size.outputs[0].type = "INT";
    const count = add(live, "ScenePromptCounter", { count: 4, enable_downstream_count: true });
    connect(size, count, "count", 0, "INT");
    const unresolved = ctx.scenePromptStats(count);
    assert.match(unresolved.error, /Count.*確定/u);
    const definition = { api_graph: { output: {
        1: { class_type: "ScenePresetInput", inputs: {} },
        2: { class_type: "ScenePromptCounter", inputs: { count: 2 } },
        3: { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["1", 0], on_false: ["2", 0] } },
        4: { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["3", 0], count: 3, enable_downstream_count: false } },
        5: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["4", 0] } },
    } } };
    const stats = upstream => ctx.scenePresetStats("upstream-count-error", upstream, new Set(), definition);
    assert.equal(stats(unresolved).error, unresolved.error, "Preset schedule fallback preserves the selected upstream error");
    definition.api_graph.output[3].inputs.switch = false;
    assert.equal(stats(unresolved).total, 6, "an independent selected branch ignores an unused upstream error");
    assert.equal(stats(unresolved).error, undefined);
    definition.api_graph.output[3].inputs.switch = true;
    assert.equal(stats(ctx.sceneStatsCount(ctx.sceneStatsSeed(), 4)).total, 12, "known upstream values recover the count");
    assert.equal(stats(ctx.emptyScenePromptStats()).total, 0);
    assert.equal(stats(ctx.emptyScenePromptStats()).error, undefined, "a valid zero upstream remains valid");
}
const g = graph(), input = add(g, "ScenePresetInput", { switch_names_json: "[]" }), bool = add(g, "PrimitiveBoolean", { value: false });
input.properties.scene_switch_values = vector(1, 3, 10);
const bindingPrompt = { output: { [input.id]: { class_type: "ScenePresetInput", inputs: {} } } };
ctx.applyScenePresetSwitchBindings(bindingPrompt, g);
input.properties.scene_switch_values[0] = false;
assert.equal(bindingPrompt.output[input.id].inputs.switch_values.values[0], true, "captured API binding is independent of later widget/property edits");
input.properties.scene_switch_values[0] = true;
{
    const random = add(g, "ScenePromptRandomRoute", {});
    random.properties.scene_random_seed = { node_id: String(random.id), seed_source_id: "preset/2" };
    const prompt = { output: { [random.id]: { class_type: "ScenePromptRandomRoute", inputs: {} } } };
    ctx.applyScenePresetSwitchBindings(prompt, g);
    assert.equal(prompt.output[random.id].inputs.seed_source_id, "preset/2");
    const clone = add(g, "ScenePromptRandomRoute", {});
    clone.properties.scene_random_seed = { ...random.properties.scene_random_seed };
    const clonedPrompt = { output: { [clone.id]: { class_type: "ScenePromptRandomRoute", inputs: {} } } };
    ctx.applyScenePresetSwitchBindings(clonedPrompt, g);
    assert.equal(clonedPrompt.output[clone.id].inputs.seed_source_id, undefined, "a clone has its own draw identity");
    const captured = { output: { [random.id]: { class_type: "ScenePromptRandomRoute", inputs: {} } },
        workflow: { nodes: [{ id: random.id, properties: { scene_random_seed: { node_id: String(random.id), seed_source_id: "snapshot/2" } } }] } };
    ctx.applyScenePresetSwitchBindings(captured, g);
    assert.equal(captured.output[random.id].inputs.seed_source_id, "snapshot/2", "use the captured workflow rather than a changed live graph");
}
for (let slot = 1; slot <= 10; slot++) {
    const holder = add(g, "ComfySwitchNode", { switch: false }); connect(input, holder, "switch", slot, "BOOLEAN");
    assert.equal(switches.sceneLiveSwitchValue(holder, "switch", "boolean"), vector(1, 3, 10)[slot - 1]);
}
const ref = add(g, "ScenePresetReference", { preset_id: "unused", switch_settings_json: "[]" });
connect(input, ref, "switches", 11, "SCENE_SWITCHES");
assert.deepEqual(switches.sceneLiveReferenceSwitchValues(ref), vector(1, 3, 10));
const left = add(g, "SceneMatrix", { matrix_json: matrix(2) }), right = add(g, "SceneMatrix", { matrix_json: matrix(3) });
const queue = add(g, "ScenePrompterQueue", { order_mode: "alternate", alternate_block_size: 1 }); connect(left, queue, "scene_prompt1");
const gate = add(g, "ComfySwitchNode", { switch: true }); connect(queue, gate, "on_true"); connect(right, gate, "on_false"); connect(bool, gate, "switch", 0, "BOOLEAN");
const count = add(g, "ScenePromptCounter", { count: 4, enable_downstream_count: true }); connect(gate, count, "scene_prompt");
ctx.app.graph = g;
assert.equal(ctx.scenePromptStats(count).total, 12);
assert.equal(ctx.sceneQueueBoundaryInNode(count), false);
const oldKey = ctx.scenePromptLineageKey(count);
set(left, "matrix_json", matrix(9));
assert.equal(ctx.scenePromptLineageKey(count), oldKey, "unselected branch edits do not replace the selected lineage");
set(bool, "value", true);
assert.notEqual(ctx.scenePromptLineageKey(count), oldKey);
assert.equal(ctx.sceneQueueBoundaryInNode(count), true);
assert.equal(ctx.scenePromptStats(count).total, 36);
assert.equal(ctx.sceneScheduleForNode(count).stats.total, 36);
assert.equal(ctx.scenePromptPreviewEntries(gate, 3).length, 3);
const controlReroute = add(g, "Reroute"); controlReroute.outputs[0].type = "BOOLEAN";
connect(bool, controlReroute, "", 0, "BOOLEAN"); connect(controlReroute, gate, "switch", 0, "BOOLEAN");
assert.equal(switches.sceneLiveSwitchSelection(gate), "on_true");
const passthrough = add(g, "BooleanPass"); passthrough.outputs[0].type = "BOOLEAN"; passthrough.mode = 4;
connect(controlReroute, passthrough, "value", 0, "BOOLEAN"); connect(passthrough, gate, "switch", 0, "BOOLEAN");
assert.equal(switches.sceneLiveSwitchSelection(gate), "on_true");
passthrough.mode = 0;
assert.match(ctx.scenePromptStats(count).error, /Booleanを確定/);
assert.match(ctx.sceneScheduleForNode(count).stats.error, /Booleanを確定/);
assert.deepEqual(plain(ctx.scenePromptPreviewEntries(count)), []);
passthrough.mode = 4;
gate.mode = 4; set(bool, "value", false);
assert.equal(ctx.scenePromptStats(gate).total, 9, "native bypass follows the first Scene branch, independently of its Boolean control");
gate.mode = 2; assert.equal(ctx.scenePromptStats(gate).total, 0); gate.mode = 0;
const literal = add(g, "ComfySwitchNode", { switch: false }); connect(left, literal, "on_true"); connect(right, literal, "on_false");
assert.equal(ctx.scenePromptStats(literal).total, 3);
set(literal, "switch", true); assert.equal(ctx.scenePromptStats(literal).total, 9);
connect(input, count, "enable_downstream_count", 3, "BOOLEAN");
assert.equal(ctx.scenePromptCounterDownstreamEnabled(count), true);
input.properties.scene_switch_values = vector(1, 10);
assert.equal(ctx.scenePromptCounterDownstreamEnabled(count), false, "Count reads a linked Preset Boolean slot without its widget fallback");
const inputNamesKey = ctx.scenePromptLineageKey(input); set(input, "switch_names_json", '["rename"]');
assert.equal(ctx.scenePromptLineageKey(input), inputNamesKey, "names never change effective values");

// The actual native Boolean callback must synchronize downstream controls before the delayed draw refresh.
const eventGraph = graph(), eventBool = add(eventGraph, "PrimitiveBoolean", { value: false });
const eventA = add(eventGraph, "SceneMatrix", { matrix_json: matrix(2) }), eventB = add(eventGraph, "SceneMatrix", { matrix_json: matrix(3) });
const eventQueueA = add(eventGraph, "ScenePrompterQueue", { order_mode: "input_order", alternate_block_size: 1, downstream_count_mode: "multiply" });
const eventGate = add(eventGraph, "ComfySwitchNode", { switch: false });
const eventQueueC = add(eventGraph, "ScenePrompterQueue", { order_mode: "alternate", alternate_block_size: 4, downstream_count_mode: "fixed" });
connect(eventA, eventQueueA, "scene_prompt1"); connect(eventQueueA, eventGate, "on_true"); connect(eventB, eventGate, "on_false");
connect(eventBool, eventGate, "switch", 0, "BOOLEAN"); connect(eventGate, eventQueueC, "scene_prompt1");
ctx.app.graph = eventGraph;
ctx.syncSceneQueueControls(eventQueueC);
const eventWidget = ctx.findWidget(eventBool, "value"), nativeResult = { native: true }, callbackCalls = [];
eventWidget.callback = function (value, ...args) { callbackCalls.push({ receiver: this, value, args }); this.value = value; return nativeResult; };
const nativeWidgets = [...eventBool.widgets], nativeInputs = JSON.stringify(eventBool.inputs), nativeOutputs = JSON.stringify(eventBool.outputs);
ctx.attachSceneNode(eventBool, "PrimitiveBoolean");
const wrappedCallback = eventWidget.callback;
ctx.attachSceneNode(eventBool, "PrimitiveBoolean");
assert.strictEqual(eventWidget.callback, wrappedCallback, "reload/configure attachment does not wrap the native callback twice");
assert.deepEqual(eventBool.widgets, nativeWidgets, "core Boolean receives no Scene widgets or positive_json state");
assert.equal(JSON.stringify(eventBool.inputs), nativeInputs);
assert.equal(JSON.stringify(eventBool.outputs), nativeOutputs);
assert.equal(ctx.scenePromptStats(eventQueueC).total, 12);
const storedControls = eventQueueC.widgets.map(widget => widget.value);
const marker = { mouse: "native" };
assert.strictEqual(eventWidget.callback.call(eventWidget, true, marker), nativeResult);
assert.equal(eventQueueC.sceneQueueControlLock, "upstream", "Queue A selection disables Queue C immediately, without a draw or polling");
for (const widget of eventQueueC.widgets) { assert.equal(widget.disabled, true); assert.equal(widget.options.disabled, true); }
assert.equal(ctx.scenePromptStats(eventQueueC).total, 2, "the value event invalidates the warm count cache");
assert.deepEqual(eventQueueC.widgets.map(widget => widget.value), storedControls, "locking never overwrites Queue control settings");
assert.strictEqual(callbackCalls[0].receiver, eventWidget);
assert.deepEqual(callbackCalls[0].args, [marker]);
assert.strictEqual(eventWidget.callback.call(eventWidget, false), nativeResult);
assert.equal(eventQueueC.sceneQueueControlLock, "");
for (const widget of eventQueueC.widgets) { assert.equal(widget.disabled, false); assert.equal(widget.options.disabled, false); }
assert.equal(ctx.scenePromptStats(eventQueueC).total, 12);
assert.deepEqual(eventQueueC.widgets.map(widget => widget.value), storedControls);
assert.equal(callbackCalls.length, 2);
const unrelatedBool = add(eventGraph, "PrimitiveBoolean", { value: false });
let unrelatedCalls = 0;
const unrelatedWidget = ctx.findWidget(unrelatedBool, "value");
unrelatedWidget.callback = value => { unrelatedCalls++; unrelatedWidget.value = value; return "native-return"; };
ctx.attachSceneNode(unrelatedBool, "PrimitiveBoolean");
const queueRevision = eventQueueC.scenePromptRevision;
assert.equal(unrelatedWidget.callback(true), "native-return");
assert.equal(unrelatedCalls, 1); assert.equal(unrelatedWidget.value, true);
assert.equal(eventQueueC.scenePromptRevision, queueRevision, "an unrelated Boolean does not refresh disconnected Scene nodes");
assert.deepEqual(unrelatedBool.widgets.map(widget => widget.name), ["value"]);
ctx.sceneDownstreamRefreshSources.clear();

function preset(output) { return { metadata: { preset_id: "fixture" }, api_graph: { output } }; }
const leaf = preset({
    1: { class_type: "ScenePresetInput", inputs: { switch_names_json: '["first", "second", "third"]' } },
    2: { class_type: "ScenePromptCounter", inputs: { count: 2 } },
    3: { class_type: "ScenePromptCounter", inputs: { count: 5 } },
    4: { class_type: "ComfySwitchNode", inputs: { switch: ["1", 3], on_true: ["2", 0], on_false: ["3", 0] } },
    5: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["4", 0] } },
});
const middle = preset({
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePresetReference", inputs: { preset_id: "leaf", switches: ["1", 11], switch_settings_json: JSON.stringify([1, 2, 1, 4, 5, 6, 7, 8, 9, 10]) } },
    3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
});
const outer = preset({
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePresetReference", inputs: { preset_id: "middle", switches: ["1", 11], switch_settings_json: JSON.stringify([3, 2, 1, 4, 5, 6, 7, 8, 9, 10]) } },
    3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
});
ctx.scenePresetDisplayGraphs.set("leaf", leaf); ctx.scenePresetDisplayGraphs.set("middle", middle); ctx.scenePresetDisplayGraphs.set("outer", outer);
const fullLeaf = structuredClone(leaf);
fullLeaf.workflow = { nodes: [{ id: 1, type: "ScenePresetInput", mode: 0, outputs: [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }] }, { id: 20, type: "Note", mode: 0 }], links: [], groups: [] };
for (const values of [vector(), vector(3)]) {
    assert.deepEqual(plain(ctx.sceneScheduleForPreset("leaf", null, new Set(), fullLeaf, "leaf", values).stats),
        plain(ctx.sceneScheduleForPreset("leaf", null, new Set(), leaf, "leaf", values).stats), "full and compact Preset sources select the same branch");
    assert.deepEqual(plain(ctx.scenePresetStats("leaf", null, new Set(), fullLeaf, values)), plain(ctx.scenePresetStats("leaf", null, new Set(), leaf, values)));
}
const presetCount = (id, values) => ctx.sceneScheduleForPreset(id, null, new Set(), null, id, values).stats.total;
assert.equal(presetCount("outer", vector(3)), 2, "three levels retain 1→3 and 3→1 mappings through slot11");
assert.equal(presetCount("outer", vector()), 5);
assert.equal(ctx.scenePresetStats("outer", null, new Set(), null, vector(3)).total, 2, "optimized stats agree with schedule");
const original = JSON.stringify([...ctx.scenePresetDisplayGraphs]);
for (let i = 0; i < 100; i++) assert.equal(presetCount("outer", vector(i % 2 ? 3 : 1)), i % 2 ? 2 : 5);
assert.equal(JSON.stringify([...ctx.scenePresetDisplayGraphs]), original, "occurrence values do not mutate shared definitions");
delete middle.api_graph.output[2].inputs.switches;
assert.equal(presetCount("outer", vector(3)), 5, "containment never implicitly forwards the parent vector");
middle.api_graph.output[2].inputs.switches = ["1", 11];
leaf.api_graph.output[1].inputs.switch_values = { values: vector() };
assert.equal(presetCount("outer", vector(3)), 2, "a fresh Reference overrides an expanded replay binding");
delete leaf.api_graph.output[1].inputs.switch_values;
const siblings = preset({
    1: { class_type: "ScenePresetReference", inputs: { preset_id: "leaf", switch_settings_json: JSON.stringify([false, false, true, false, false, false, false, false, false, false]) } },
    2: { class_type: "ScenePresetReference", inputs: { preset_id: "leaf", switch_settings_json: "[]" } },
    3: { class_type: "ScenePrompterMerge", inputs: { scene_prompt1: ["1", 0], scene_prompt2: ["2", 0] } },
    4: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["3", 0] } },
});
ctx.scenePresetDisplayGraphs.set("siblings", siblings);
assert.equal(presetCount("siblings", vector(3)), 10, "same-Preset siblings resolve their own literal/missing incoming values");
assert.equal(ctx.scenePresetStats("siblings", null).total, 10);
leaf.api_graph.output[4].inputs.switch = ["dynamic", 0];
leaf.api_graph.output.dynamic = { class_type: "ExternalBoolean", inputs: {} };
assert.match(ctx.sceneScheduleForPreset("leaf", null).stats.error, /確定/);
assert.match(ctx.scenePresetStats("leaf", null).error, /確定/);
leaf.api_graph.output[4].inputs.switch = ["1", 3]; delete leaf.api_graph.output.dynamic;
leaf.api_graph.output[2].class_type = "ScenePrompterQueue"; leaf.api_graph.output[2].inputs = {};
assert.equal(ctx.sceneQueueBoundaryInPreset("leaf", false, new Set(), null, vector(3)), true);
assert.equal(ctx.sceneQueueBoundaryInPreset("leaf", false, new Set(), null, vector()), false);

const llmGraph = graph(), llmA = add(llmGraph, "ScenePromptLLM", { description: "A" }), llmB = add(llmGraph, "ScenePromptLLM", { description: "B" });
const llmGate = add(llmGraph, "ComfySwitchNode", { switch: false }); connect(llmA, llmGate, "on_true"); connect(llmB, llmGate, "on_false");
assert.equal(hasLLMTargets(llmGraph, llmGate), true);
assert.deepEqual(collectLLMTargets(llmGraph, llmGate).map(target => target.node), [llmA, llmB], "explicit LLM generation retains the existing all-connected scope");
const definition = preset({
    1: { class_type: "ScenePresetInput", inputs: { switch_names_json: '["A"]', switch_values: { values: vector(3) } } },
    2: { class_type: "ComfySwitchNode", inputs: { switch: ["1", 3], on_true: ["4", 0], on_false: ["5", 0] } },
    3: { class_type: "ScenePresetReference", inputs: { switches: ["1", 11], preset_id: "child", switch_settings_json: "[]" } },
    4: { class_type: "ScenePromptLLM", inputs: { description: "A", positive: "before" } },
    5: { class_type: "ScenePromptLLM", inputs: { description: "B", positive: "before" } },
    6: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
});
definition.workflow = { nodes: [], links: [] };
const llmLibrary = new Map([["fixture", definition]]), outerReference = add(llmGraph, "ScenePresetReference", { preset_id: "fixture", llm_presets_json: "" });
preparePresetReference(outerReference, llmLibrary);
assert.equal(presetReferenceHasLLM(outerReference), true, "compact discovery crosses both Switch branches");
assert.deepEqual(collectPresetLLMTargets(outerReference, llmLibrary).map(target => target.node.id), [4, 5], "Preset LLM targeting crosses both branches");
const detached = createPresetGraph(definition, {});
assert.equal(detached.getNodeById(1).outputs[3].type, "BOOLEAN");
assert.equal(detached.getNodeById(1).outputs[11].type, "SCENE_SWITCHES");
assert.equal(detached.links[detached.getNodeById(2).inputs.find(input => input.name === "switch").link].type, "BOOLEAN");
assert.equal(detached.links[detached.getNodeById(3).inputs.find(input => input.name === "switches").link].type, "SCENE_SWITCHES");
detached.getNodeById(4).widgets.find(widget => widget.name === "positive").value = "after";
const saved = detached.definition();
assert.deepEqual(saved.api_graph.output[2].inputs.switch, ["1", 3]);
assert.deepEqual(saved.api_graph.output[3].inputs.switches, ["1", 11]);
assert.deepEqual(saved.api_graph.output[1].inputs.switch_values, { values: vector(3) });
assert.equal(saved.api_graph.output[4].inputs.positive, "after");
detached.dispose();
const measurements = [];
for (const depth of [1, 8, 32, 128]) {
    const dag = graph(); let tail = add(dag, "ScenePrompter"), control = add(dag, "PrimitiveBoolean", { value: true });
    for (let index = 0; index < depth; index++) {
        const merge = add(dag, "ScenePrompterMerge"); connect(tail, merge, "scene_prompt1"); connect(tail, merge, "scene_prompt2");
        const gate = add(dag, "ComfySwitchNode", { switch: false }); connect(merge, gate, "on_true"); connect(control, gate, "switch", 0, "BOOLEAN"); tail = gate;
    }
    const counter = add(dag, "ScenePromptCounter", { count: 100000000, enable_downstream_count: true }); connect(tail, counter, "scene_prompt");
    let lookups = 0; const originalLookup = dag.getNodeById; dag.getNodeById = id => { lookups++; return originalLookup(id); };
    const encoded = ctx.scenePromptLineageKey(counter), flat = JSON.parse(encoded);
    const keyLookups = lookups;
    assert.equal(flat.length, dag.nodes.size);
    assert(lookups <= dag.nodes.size * 4, "shared selected branches and controls retain linear lineage traversal");
    assert(encoded.length <= dag.nodes.size * 420);
    const stats = ctx.scenePromptStats(counter); assert.equal(stats.total, 100000000);
    lookups = 0;
    let warmStringifies = 0;
    const originalJSON = ctx.JSON;
    ctx.JSON = { parse: JSON.parse, stringify(value) { warmStringifies++; return JSON.stringify(value); } };
    const start = performance.now();
    for (let draw = 0; draw < 100; draw++) assert.strictEqual(ctx.scenePromptStats(counter), stats);
    ctx.JSON = originalJSON;
    assert.equal(warmStringifies, 0, "selected Switch and linked Boolean/Count ancestry reuse all unchanged local and lineage JSON");
    assert(lookups <= dag.nodes.size * 400, "warm draws scale with actual nodes, not generated rows or repeated shared branches");
    measurements.push({ nodes: dag.nodes.size, keyLookups, chars: encoded.length, warm100Lookups: lookups, warmStringifies, warm100ms: Number((performance.now() - start).toFixed(2)) });
}
console.log("Preset switch values, selected live lineage/counts, full/compact nested mappings, Queue boundaries and LLM physical slot/type preservation passed.");
console.log("Selected Switch lineage retains linear node/edge storage independently of 100 million generated rows", JSON.stringify(measurements));
