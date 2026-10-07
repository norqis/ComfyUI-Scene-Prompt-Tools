const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const body = source.indexOf(") {", start);
    let depth = 0;
    for (let index = body + 2; index < source.length; index++) {
        if (source[index] === "{") depth++;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(name);
}
const classes = {
    isScenePromptNode: "ScenePrompter", isPromptMatrixNode: "ScenePromptMatrix", isScenePathNode: "ScenePromptPath",
    isScenePromptMergeNode: "ScenePrompterMerge", isScenePromptDeleteNode: "ScenePromptTextDelete",
    isScenePromptReverseNode: "ScenePromptReverse", isScenePromptCounterNode: "ScenePromptCounter",
    isScenePromptRandomRouteNode: "ScenePromptRandomRoute", isSceneEmptyLatentNode: "SceneEmptyLatent",
    isScenePresetReferenceNode: "ScenePromptPreset", isScenePromptCallbackNode: "ScenePromptCallback",
    isSceneApplyModelNode: "SceneApplyModel", isSceneApplyLoraNode: "SceneApplyLora",
    isScenePromptQueueNode: "ScenePrompterQueue", isScenePromptRandomRouteOutputNode: "ScenePromptRandomRouteOutput",
    isSceneExpandNode: "ScenePrompterExpand",
};
const ctx = {
    Set, Map, Math, JSON, String, Number, Array, Object, app: { graph: null },
    SCENE_QUEUE_CONTROL_NAMES: ["order_mode", "alternate_block_size", "downstream_count_mode"],
    SCENE_QUEUE_CONTROL_DEFAULTS: { order_mode: "input_order", alternate_block_size: 1, downstream_count_mode: "multiply" },
    SCENE_QUEUE_DISPLAY_PREVIEW_ROWS: 40, MATRIX_SECTION_VISIBLE_ROWS: 40, scenePresetDisplayGraphs: new Map(), MATRIX_DEFAULT_JSON: "{}",
    sceneWorkflowLoadDepth: 0, sceneDownstreamRefreshTimer: null, sceneDownstreamRefreshSources: new Set(),
    sceneWorkflowLoadSources: new Set(), sceneTitleSyncNodes: new Set(), sceneLoadedRefreshNodes: new Set(),
    activePopupContext: null, clearTimeout() {}, clearSceneFitHeightTimer() {}, invalidatePopupRequests() {},
    closeSceneLoraDetails() {}, closeSceneExpandResources() {}, popupContextReferencesNode() { return false; },
    isSceneExpandNodeName() { return false; }, syncSceneQueueControls() {}, scheduleSceneNodeRefresh() {},
    findWidget: (node, name) => node?.widgets?.find(widget => widget.name === name),
    scenePromptTitle: node => node.title || "", scenePathTitle: node => node.title || "",
    normalizePathMode: value => value || "append", scenePromptReverseScope: node => ctx.findWidget(node, "reverse_scope")?.value || "all",
    ensureMatrixJsonWidget: node => ctx.findWidget(node, "matrix_json"),
    matrixLinesForNode: node => JSON.parse(ctx.findWidget(node, "matrix_json")?.value || "[]"),
    matrixConfiguredLineCount: node => ctx.matrixLinesForNode(node).length,
    emptyMatrixRow: () => ({}), sceneRandomRouteInNode: () => false, sceneQueueBoundaryInNode: () => false,
    // Schedule leaf rows are deliberately tiny: topology size is independent of the generated count.
    scenePromptPreviewEntries: node => [{ parts: [node.title || "seed"], count: 1, row: {} }],
};
for (const [name, type] of Object.entries(classes)) ctx[name] = node => node?.type === type;
ctx.isScenePromptJoinNode = node => ctx.isScenePromptQueueNode(node) || ctx.isScenePromptRandomRouteOutputNode(node);
ctx.isScenePromptSourceNode = node => Object.entries(classes).some(([name]) => name !== "isSceneExpandNode" && ctx[name](node));
require("./scene_switches_test_context.cjs").install(ctx);
vm.createContext(ctx);
const core = ["nodeClassName", "nodeClassNames", "isRerouteNode", "liteGraphNodeMode", "sceneNodeMode",
    "isSceneNodeMuted", "isSceneNodeBypassed", "sceneNodeRevision", "linkedInput", "graphLink", "firstLinkedInput",
    "linkKey", "resolveLinkedSourceFromLink", "resolveLinkedSourceFromInput", "linkedSourceNode",
    "scenePromptInputSource", "sceneBypassInputSource", "scenePromptSourceLocalCacheKey", "scenePromptLineageKey",
    "scenePromptSourceCacheKey", "scenePromptQueueRowsCacheKey", "clampSceneCount", "scenePrimitiveInputValue",
    "scenePromptCounterCount", "scenePromptCounterDownstreamEnabled", "sceneEmptyLatentConfig", "scenePromptSettingsError",
    "scenePresetGraphNodes", "apiLink", "apiInput", "sceneQueueBoundaryInPreset",
    "sceneQueueBoundaryInNode", "sceneRandomRouteInNode", "sceneQueuePendingInNode",
    "scenePromptStats", "scenePromptInputNumber", "scenePromptQueueInputIndexes", "connectedScenePromptSourcesForQueue",
    "connectedScenePromptSourcesForMerge", "sceneScheduleForLinkedInput", "sceneScheduleForNode", "sceneRandomJoinReady", "sceneRandomChoicePlan",
    "clearSceneComputedCaches", "collectDownstreamSceneNodes", "downstreamNodes", "flushDownstreamSceneRefreshes",
    "installSceneNodeRemovalCleanup"];
const scalarFunctions = [...source.matchAll(/^function (emptyScenePromptStats|sceneStat\w+|sceneStats\w+|sceneCount\w+|sceneSchedule\w+|sceneRandomGuard|sceneRandomZeroArm)\(/gm)]
    .map(match => match[1]).filter(name => !["sceneCounterConfiguredValues", "sceneCounterConfigureValues", "sceneScheduleForPreset"].includes(name));
for (const name of new Set([...core, ...scalarFunctions])) vm.runInContext(functionSource(name), ctx);
function graph() {
    const nodes = new Map();
    return { nodes, links: {}, lookups: 0, lastLink: 0,
        getNodeById(id) { this.lookups++; return nodes.get(id); } };
}
function add(g, type, values = {}, id = g.nodes.size + 1) {
    const node = { id, type, graph: g, mode: 0, title: type,
        inputs: [], outputs: [{ type: type.startsWith("Primitive") ? (type === "PrimitiveBoolean" ? "BOOLEAN" : "INT") : "SCENE_PROMPT", links: [] }],
        widgets: Object.entries(values).map(([name, value]) => ({ name, value })), properties: {} };
    g.nodes.set(id, node);
    return node;
}
function connect(from, to, name, type = "SCENE_PROMPT", originSlot = 0) {
    const g = to.graph, id = ++g.lastLink;
    let slot = to.inputs.findIndex(input => input.name === name);
    if (slot < 0) { slot = to.inputs.length; to.inputs.push({ name, type }); }
    to.inputs[slot].link = id;
    g.links[id] = { id, origin_id: from.id, origin_slot: originSlot, target_id: to.id, target_slot: slot };
    from.outputs[originSlot].links.push(id);
    return id;
}
const set = (node, name, value) => { ctx.findWidget(node, name).value = value; };
const key = node => ctx.scenePromptSourceCacheKey(node);
const snapshot = node => JSON.parse(JSON.stringify(ctx.scenePromptStats(node)));

// Exercise the real preview path, including optional Scene input seed semantics.
{
    const stubPreview = ctx.scenePromptPreviewEntries;
    ctx.PATH_MODE_APPEND = "前のフォルダ名に結合"; ctx.PATH_MODE_DIRECTORY = "フォルダに分ける";
    for (const name of ["scenePromptPreviewEntries", "appendScenePathPart", "normalizePathMode", "multiplyScenePromptEntryCount", "scenePromptEntryBatchSize", "scenePromptEntryImageCount", "sceneQueueDisplayPartsForEntry"])
        vm.runInContext(functionSource(name), ctx);
    for (const type of ["ScenePromptPath", "ScenePromptMatrix", "ScenePromptTextDelete", "SceneEmptyLatent", "ScenePromptCounter", "ScenePrompterMerge"]) {
        const g = graph(), start = add(g, type, { matrix_json: "[]", width: 512, height: 512, batch_size: 3, count: 3 });
        const visible = add(g, "ScenePrompter"), normal = add(g, "ScenePrompter"), queue = add(g, "ScenePrompterQueue");
        visible.title = "VISIBLE"; normal.title = "NORMAL";
        connect(start, visible, "scene_prompt"); connect(visible, queue, "scene_prompt1"); connect(normal, queue, "scene_prompt2");
        const stats = ctx.scenePromptStats(queue), entries = ctx.scenePromptPreviewEntries(queue);
        const count = type === "ScenePromptCounter" ? 3 : 1;
        assert.equal(stats.total, count + 1, type);
        assert.equal(stats.totalImages, type === "SceneEmptyLatent" ? 4 : count + 1, type);
        assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.parts))), [...Array(count).fill(["VISIBLE"]), ["NORMAL"]], type);
        if (type === "ScenePromptPath") assert.deepEqual(Array.from(entries[0].row.path_parts), [type]);
        if (type === "SceneEmptyLatent") assert.equal(entries[0].row.latent.batch_size, 3);
        const empty = add(g, "ScenePromptMatrix", { matrix_json: "[]" });
        empty.sceneScheduleCache = null;
        // An explicitly configured all-disabled Matrix is empty, unlike an unconfigured one.
        const configured = ctx.matrixConfiguredLineCount;
        ctx.matrixConfiguredLineCount = node => node === empty ? 1 : configured(node);
        if (type === "ScenePromptCounter") {
            set(start, "count", 0);
            const zero = ctx.scenePromptPreviewEntries(start);
            assert.equal(zero.length, 1); assert.equal(zero[0].count, 0);
        }
        connect(empty, start, type === "ScenePrompterMerge" ? "scene_prompt1" : "scene_prompt");
        assert.deepEqual(JSON.parse(JSON.stringify(ctx.scenePromptPreviewEntries(queue).map(entry => entry.parts))), [["NORMAL"]], type);
        ctx.matrixConfiguredLineCount = configured;
    }
    ctx.scenePromptPreviewEntries = stubPreview;
}

const measurements = [];
for (const depth of [1, 4, 8, 16, 32, 64]) {
    const g = graph(); let root = add(g, "ScenePrompter");
    for (let i = 0; i < depth; i++) {
        const merge = add(g, "ScenePrompterMerge"); connect(root, merge, "scene_prompt1"); connect(root, merge, "scene_prompt2"); root = merge;
    }
    g.lookups = 0;
    const encoded = key(root), flat = JSON.parse(encoded);
    assert.equal(flat.length, depth + 1, "each real node has one descriptor despite shared branches");
    assert.equal(g.lookups, depth * 2, "cache construction reads each connected edge once");
    assert.equal(flat.reduce((sum, entry) => sum + entry[1].length, 0), depth * 2);
    assert(encoded.length < (depth + 1) * 330, "key storage follows actual node count");
    g.lookups = 0;
    assert.equal(ctx.sceneRandomRouteInNode(root), false);
    assert.equal(g.lookups, depth * 2, "Random existence visits shared branches once");
    g.lookups = 0;
    assert.equal(ctx.sceneQueueBoundaryInNode(root), false);
    assert.equal(g.lookups, depth * 2, "Queue existence visits shared branches once");
    g.lookups = 0;
    assert.equal(ctx.sceneQueuePendingInNode(root), false);
    assert.equal(g.lookups, depth * 2, "pending Preset search visits shared branches once");
    const stats = ctx.scenePromptStats(root);
    assert.equal(stats.total, 1, "shared depth does not change the generation count");
    const old = root.scenePromptSourceKeyCache;
    const start = performance.now();
    for (let draw = 0; draw < 100; draw++) assert.equal(ctx.scenePromptStats(root), stats, "unchanged warm draws reuse current stats");
    const elapsed = performance.now() - start;
    assert.equal(root.scenePromptSourceKeyCache, old);
    measurements.push({ nodes: depth + 1, edges: depth * 2, chars: encoded.length, warm100ms: Number(elapsed.toFixed(2)) });
    const leaf = g.nodes.get(1); leaf.title = "edited";
    assert.notEqual(key(root), encoded, "editing a shared leaf immediately changes the root key");
    assert.equal(JSON.parse(key(root)).length, depth + 1);
}

// Local fields remain part of invalidation without recursively constructing another lineage.
const g = graph(), prompt = add(g, "ScenePrompter", { positive_base: "a" });
const queue = add(g, "ScenePrompterQueue", { alternate_block_size: 1 }); connect(prompt, queue, "scene_prompt1");
const queueKey = ctx.scenePromptQueueRowsCacheKey(queue);
set(prompt, "positive_base", "b"); assert.equal(ctx.scenePromptQueueRowsCacheKey(queue), queueKey, "unused Prompt text does not invalidate display calculations");
prompt.title = "renamed"; assert.notEqual(ctx.scenePromptQueueRowsCacheKey(queue), queueKey, "Prompt titles still invalidate display labels");
for (const [type, field, first, next] of [
    ["ScenePromptMatrix", "matrix_json", "[]", '[{"label":"x"}]'],
    ["ScenePromptTextDelete", "positive", "a", "b"], ["ScenePromptReverse", "reverse_scope", "all", "last"],
    ["ScenePromptRandomRoute", "weights_json", "[10000]", "[5000,5000]"],
    ["ScenePromptRandomRoute", "preserve_join", false, true], ["ScenePrompterQueue", "order_mode", "input_order", "alternate"],
]) {
    const node = add(g, type, { [field]: first }); connect(prompt, node, type === "ScenePrompterQueue" ? "scene_prompt1" : "scene_prompt");
    const before = key(node); set(node, field, next); assert.notEqual(key(node), before, `${type}/${field} invalidates`);
}
const preset = add(g, "ScenePromptPreset", { preset_id: "fixture" });
preset.scenePresetGraph = { metadata: { sha256: "one" } };
let before = key(preset); preset.scenePresetGraph.metadata.sha256 = "two"; assert.notEqual(key(preset), before);
before = key(preset); preset.scenePresetRevision = 1; assert.notEqual(key(preset), before);

// Count + Latent settings read the actual supported Primitive values, including indirect links.
const seed = add(g, "ScenePrompter"), count = add(g, "ScenePromptCounter", { count: 99, enable_downstream_count: true });
const downstream = add(g, "ScenePromptCounter", { count: 5, enable_downstream_count: true });
const latent = add(g, "SceneEmptyLatent", { width: 512, height: 512, batch_size: 99 });
const number = add(g, "PrimitiveInt", { value: 3 }), flag = add(g, "PrimitiveBoolean", { value: false });
const batch = add(g, "PrimitiveInt", { value: 4 }), width = add(g, "PrimitiveNode", { value: 768 });
connect(seed, count, "scene_prompt"); connect(count, downstream, "scene_prompt"); connect(downstream, latent, "scene_prompt");
connect(number, count, "count", "INT"); connect(flag, count, "enable_downstream_count", "BOOLEAN");
connect(batch, latent, "batch_size", "INT"); connect(width, latent, "width", "INT");
assert.equal(ctx.scenePromptCounterCount(count), 3); assert.equal(ctx.scenePromptCounterDownstreamEnabled(count), false);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.sceneEmptyLatentConfig(latent))), { width: 768, height: 512, batch_size: 4 });
assert.equal(snapshot(latent).total, 3); assert.equal(snapshot(latent).totalImages, 12);
const heldKey = key(latent); set(flag, "value", true);
assert.notEqual(key(latent), heldKey); assert.equal(snapshot(latent).total, 15); assert.equal(snapshot(latent).totalImages, 60);
set(number, "value", 2); set(batch, "value", 7);
assert.equal(snapshot(latent).total, 10); assert.equal(snapshot(latent).totalImages, 70);
const reroute = add(g, "Reroute"); connect(flag, reroute, "input", "BOOLEAN");
connect(reroute, count, "enable_downstream_count", "BOOLEAN");
set(flag, "value", false); assert.equal(snapshot(latent).total, 2);
const bridge = add(g, "ScalarBridge"); bridge.mode = 4; bridge.outputs[0].type = "INT";
connect(batch, bridge, "number", "INT"); connect(bridge, latent, "batch_size", "INT");
assert.equal(snapshot(latent).totalImages, 14, "bypass follows the compatible scalar input without executing its node");
const bridgeKey = key(latent); bridge.mode = 0;
assert.notEqual(key(latent), bridgeKey); assert.match(snapshot(latent).error, /確定できません/u);
assert.match(ctx.sceneScheduleForNode(latent).stats.error, /確定できません/u);
bridge.mode = 4;
number.mode = 2; assert.match(snapshot(latent).error, /確定できません/u);
number.mode = 0;
const unknown = add(g, "DynamicBoolean", { value: false }); connect(unknown, count, "enable_downstream_count", "BOOLEAN");
assert.equal(ctx.scenePromptCounterDownstreamEnabled(count), null, "unknown providers do not use hidden widget defaults");
assert.match(snapshot(latent).error, /確定できません/u);
count.mode = 4; assert.equal(snapshot(latent).total, 5, "bypassed Count ignores its unsupported local settings");
count.mode = 0; connect(flag, count, "enable_downstream_count", "BOOLEAN");

// Topology, output slot, mode, object identity, and malformed cycles remain distinct/finite.
let original = key(count); count.mode = 2; assert.notEqual(key(count), original); count.mode = 0;
const alternate = add(g, "ScenePrompter", { positive_base: "another" });
original = key(count); connect(alternate, count, "scene_prompt"); assert.notEqual(key(count), original);
const otherGraph = graph(), sameId = add(otherGraph, "ScenePromptCounter", { count: 8, enable_downstream_count: true }, count.id);
assert.equal(snapshot(sameId).total, 8); assert.equal(snapshot(count).total, 2);
const cycleA = add(g, "Reroute"), cycleB = add(g, "Reroute");
connect(cycleA, cycleB, "input"); connect(cycleB, cycleA, "input");
assert.equal(JSON.parse(key(cycleA)).length, 2); assert.equal(ctx.resolveLinkedSourceFromInput(g, cycleA.inputs[0]).source, null);

// Warm lineage still reads every current edge/value, but never serializes unchanged Matrix payloads again.
{
    let stringifies = 0;
    const originalJSON = ctx.JSON;
    ctx.JSON = { parse: JSON.parse, stringify(value) { stringifies++; return JSON.stringify(value); } };
    const matrixPayload = index => JSON.stringify([{ name: `row${index}`, positive_base: "tag,".repeat(4000), negative_base: "negative,".repeat(1000) }]);
    const large = graph(); let root = add(large, "ScenePromptMatrix", { matrix_json: matrixPayload(0) });
    for (let index = 0; index < 119; index++) {
        const next = add(large, "ScenePromptMatrix", { matrix_json: matrixPayload(index + 1) });
        connect(root, next, "scene_prompt"); root = next;
    }
    const encoded = key(root), localCache = root.scenePromptLocalKeyCache, lineageCache = root.scenePromptLineageKeyCache;
    assert.equal(JSON.parse(encoded).length, large.nodes.size);
    stringifies = 0; large.lookups = 0;
    const start = performance.now();
    for (let repeat = 0; repeat < 50; repeat++) assert.equal(key(root), encoded);
    assert.equal(stringifies, 0, "large display-dependent Matrix payloads and the full lineage JSON are reused on every unchanged read");
    assert.equal(large.lookups, 119 * 50, "warm keys continue reading all current edges rather than relying on edit events");
    assert.strictEqual(root.scenePromptLocalKeyCache, localCache);
    assert.strictEqual(root.scenePromptLineageKeyCache, lineageCache);
    const warm50ms = Number((performance.now() - start).toFixed(2));
    const leaf = large.nodes.get(1);
    leaf.widgets[0].value = matrixPayload("direct edit");
    assert.notEqual(key(root), encoded, "direct edits without a callback still invalidate the selected ancestry");
    const edited = key(root); stringifies = 0; assert.equal(key(root), edited); assert.equal(stringifies, 0);
    const edge = large.links[root.inputs[0].link], oldSlot = edge.origin_slot;
    edge.origin_slot = 1; assert.notEqual(key(root), edited, "direct output slot changes are in the scalar edge snapshot");
    edge.origin_slot = oldSlot;
    const oldInputType = root.inputs[0].type, beforeType = key(root);
    root.inputs[0].type = "*"; assert.notEqual(key(root), beforeType); root.inputs[0].type = oldInputType;
    const displaced = key(root); edge.origin_id = 1;
    assert.notEqual(key(root), displaced, "direct link endpoint changes need no downstream refresh notification");
    assert.equal(JSON.parse(key(root)).length, 2, "the current snapshot releases the removed ancestry");
    assert.equal(root.scenePromptLineageKeyCache.owners.length, 4);
    const rawPrompt = add(large, "ScenePromptLLM", { positive: { nested: "one" } });
    const objectKey = key(rawPrompt);
    rawPrompt.widgets[0].value.nested = "two"; assert.notEqual(key(rawPrompt), objectKey, "existing object fallback notices in-place changes");
    const typedKey = key(rawPrompt); rawPrompt.widgets[0].value = JSON.stringify(rawPrompt.widgets[0].value);
    assert.notEqual(key(rawPrompt), typedKey, "an object and its literal JSON string remain distinct descriptor values");
    const input = add(large, "ScenePresetInput"); input.properties.scene_switch_values = Array(10).fill(false);
    const arrayKey = key(input); input.properties.scene_switch_values[2] = true;
    assert.notEqual(key(input), arrayKey, "Input's plain replay vector is compared element by element");
    stringifies = 0; key(input); assert.equal(stringifies, 0);
    input.widgets.push({ name: "switch_values", value: { values: [...input.properties.scene_switch_values] } });
    const wrapperKey = key(input); input.widgets[0].value.values[2] = false;
    assert.notEqual(key(input), wrapperKey, "Input's native binding wrapper also detects an in-place Boolean edit");
    stringifies = 0; key(input); assert.equal(stringifies, 0);
    const extraKey = key(input); input.widgets[0].value.extra = "preserve fallback";
    assert.notEqual(key(input), extraKey, "other object fields preserve the original descriptor serialization behavior");
    const savedFields = JSON.stringify({ widgets: input.widgets, properties: input.properties });
    key(input); assert.equal(JSON.stringify({ widgets: input.widgets, properties: input.properties }), savedFields,
        "derived signature snapshots never enter serialized widget/property state");
    const cloned = add(large, input.type, Object.fromEntries(input.widgets.map(widget => [widget.name, structuredClone(widget.value)])));
    cloned.properties = structuredClone(input.properties);
    assert.equal(cloned.scenePromptLocalKeyCache, undefined); assert.equal(cloned.scenePromptLineageKeyCache, undefined);
    key(cloned); assert.notStrictEqual(cloned.scenePromptLocalKeyCache, input.scenePromptLocalKeyCache);
    assert.notStrictEqual(cloned.scenePromptLineageKeyCache, input.scenePromptLineageKeyCache);
    ctx.JSON = originalJSON;
    console.log("Current descriptor/lineage warm serialization reuse passed", JSON.stringify({ nodes: 120, chars: encoded.length, warm50ms, stringifies: 0 }));
}

// Same IDs and identical serialized fields never make replacement objects reuse old computed plans.
{
    const owners = graph(), ownerLeaf = add(owners, "ScenePrompter", { positive_base: "same" }), ownerRoot = add(owners, "ScenePromptCounter", { count: 2, enable_downstream_count: true });
    connect(ownerLeaf, ownerRoot, "scene_prompt");
    const previousStats = ctx.scenePromptStats(ownerRoot), previousPlan = ctx.sceneScheduleForNode(ownerRoot);
    const revision = ownerRoot.scenePromptRevision || 0;
    add(owners, ownerLeaf.type, { positive_base: "same" }, ownerLeaf.id);
    assert.notStrictEqual(ctx.scenePromptStats(ownerRoot), previousStats, "same-ID source replacement releases old derived stats");
    assert.notStrictEqual(ctx.sceneScheduleForNode(ownerRoot), previousPlan, "same-ID source replacement releases old derived schedules");
    assert.equal(ownerRoot.scenePromptRevision, revision + 1);
    const currentKey = key(ownerRoot), currentCache = ownerRoot.scenePromptLineageKeyCache;
    assert.equal(key(ownerRoot), currentKey); assert.strictEqual(ownerRoot.scenePromptLineageKeyCache, currentCache,
        "replacement cleanup refreshes the root descriptor before saving the new snapshot");
    const moved = graph();
    add(moved, ownerLeaf.type, { positive_base: "same" }, ownerLeaf.id);
    moved.nodes.set(ownerRoot.id, ownerRoot); moved.links = structuredClone(owners.links); ownerRoot.graph = moved;
    const beforeMove = ctx.scenePromptStats(ownerRoot);
    const nextGraph = graph(); nextGraph.nodes.set(ownerRoot.id, ownerRoot);
    add(nextGraph, ownerLeaf.type, { positive_base: "same" }, ownerLeaf.id); nextGraph.links = structuredClone(moved.links);
    ownerRoot.graph = nextGraph;
    assert.notStrictEqual(ctx.scenePromptStats(ownerRoot), beforeMove, "the same root node moved to another graph owns a fresh derived cache");
    const copied = add(nextGraph, ownerRoot.type, { count: 2, enable_downstream_count: true });
    copied.scenePromptLocalKeyCache = ownerRoot.scenePromptLocalKeyCache;
    copied.scenePromptLineageKeyCache = ownerRoot.scenePromptLineageKeyCache;
    key(copied);
    assert.strictEqual(copied.scenePromptLocalKeyCache.node, copied, "even accidentally copied cache fields cannot claim another node's local key");
    assert.strictEqual(copied.scenePromptLineageKeyCache.owners[0], copied);
}

// Prompt display dependencies are pass-through counts and the visible title, never its generated text.
{
    const displayGraph = graph(), displayPrompt = add(displayGraph, "ScenePrompter");
    const body = { positive_base: "positive", positive_json: "{}", negative_base: "negative", negative_json: "{}", category_order: "[]", filename_enabled: true };
    let bodyReads = 0;
    displayPrompt.widgets = Object.keys(body).map(name => ({ name,
        get value() { bodyReads++; return body[name]; }, set value(value) { body[name] = value; } }));
    const displayQueue = add(displayGraph, "ScenePrompterQueue"); connect(displayPrompt, displayQueue, "scene_prompt1");
    const originalPreview = ctx.scenePromptPreviewEntries;
    vm.runInContext(functionSource("scenePromptPreviewEntries"), ctx);
    const firstKey = key(displayPrompt), firstStats = ctx.scenePromptStats(displayPrompt), firstPlan = ctx.sceneScheduleForNode(displayPrompt);
    const firstRows = ctx.scenePromptPreviewEntries(displayPrompt), firstQueueKey = ctx.scenePromptQueueRowsCacheKey(displayQueue);
    for (const [name, value] of Object.entries(body)) set(displayPrompt, name, typeof value === "boolean" ? !value : `${value} edited`);
    assert.equal(key(displayPrompt), firstKey);
    assert.strictEqual(ctx.scenePromptStats(displayPrompt), firstStats);
    assert.strictEqual(ctx.sceneScheduleForNode(displayPrompt), firstPlan);
    assert.strictEqual(ctx.scenePromptPreviewEntries(displayPrompt), firstRows);
    assert.equal(ctx.scenePromptQueueRowsCacheKey(displayQueue), firstQueueKey);
    assert.equal(bodyReads, 0, "Stats/Schedule/Preview/QueueRows never read the six unused Prompt body widgets");
    displayPrompt.title = "Renamed Prompt";
    assert.notEqual(key(displayPrompt), firstKey);
    assert.notStrictEqual(ctx.scenePromptStats(displayPrompt), firstStats);
    assert.notStrictEqual(ctx.sceneScheduleForNode(displayPrompt), firstPlan);
    assert.deepEqual(Array.from(ctx.scenePromptPreviewEntries(displayPrompt)[0].parts), ["Renamed Prompt"]);
    assert.notEqual(ctx.scenePromptQueueRowsCacheKey(displayQueue), firstQueueKey);
    assert.equal(bodyReads, 0);
    ctx.scenePromptPreviewEntries = originalPreview;
}

// Queue display JSON reuses the raw row key at the same rounded width, including selected Switch paths.
{
    const originalSourcePredicate = ctx.isScenePromptSourceNode;
    ctx.isScenePromptSourceNode = node => originalSourcePredicate(node) || ctx.isSceneSwitch(node);
    ctx.sceneQueueDisplayEntriesFromRows = rows => rows;
    ctx.sceneQueueDisplayNaturalHeight = () => 56;
    for (const name of ["sceneQueuePreviewRows", "scenePromptQueueDisplayCacheKey", "computeScenePromptQueueDisplayCache", "scenePromptQueueDisplayCache"])
        vm.runInContext(functionSource(name), ctx);
    const displayGraph = graph(), displaySeed = add(displayGraph, "ScenePrompter");
    const onTrue = add(displayGraph, "ScenePromptCounter", { count: 2, enable_downstream_count: true });
    const onFalse = add(displayGraph, "ScenePromptCounter", { count: 3, enable_downstream_count: true });
    const control = add(displayGraph, "PrimitiveBoolean", { value: false }), gate = add(displayGraph, "ComfySwitchNode", { switch: false });
    const displayQueue = add(displayGraph, "ScenePrompterQueue"); displayQueue.size = [360, 100];
    connect(displaySeed, onTrue, "scene_prompt"); connect(displaySeed, onFalse, "scene_prompt");
    connect(onTrue, gate, "on_true"); connect(onFalse, gate, "on_false"); connect(control, gate, "switch", "BOOLEAN"); connect(gate, displayQueue, "scene_prompt1");
    const originalRowsKey = ctx.scenePromptQueueRowsCacheKey, originalJSON = ctx.JSON;
    let rowReads = 0, stringifies = 0;
    ctx.scenePromptQueueRowsCacheKey = node => { rowReads++; return originalRowsKey(node); };
    ctx.JSON = { parse: JSON.parse, stringify(value) { stringifies++; return JSON.stringify(value); } };
    let cached = ctx.scenePromptQueueDisplayCache(displayQueue, 360.1);
    assert.equal(rowReads, 1, "a cold display computes its row key once and passes it into the cache builder");
    assert.equal(cached.totalBatches, 3); assert.equal(cached.rowKey, originalRowsKey(displayQueue));
    stringifies = 0; rowReads = 0;
    for (let draw = 0; draw < 50; draw++) assert.strictEqual(ctx.scenePromptQueueDisplayCache(displayQueue, 360.9), cached);
    assert.equal(rowReads, 50, "every warm draw still checks the current ancestry");
    assert.equal(stringifies, 0, "same row key/rounded width does not wrap a large lineage JSON a second time");
    assert.equal(ctx.scenePromptQueueDisplayCacheKey(displayQueue, 360.2), cached.cacheKey);
    const changed = mutate => {
        const previous = cached; mutate(); rowReads = 0;
        cached = ctx.scenePromptQueueDisplayCache(displayQueue, 360.1);
        assert.notStrictEqual(cached, previous); assert.notEqual(cached.cacheKey, previous.cacheKey);
        assert.equal(rowReads, 1, "an invalidated display still derives its row key only once");
    };
    changed(() => { set(control, "value", true); }); assert.equal(cached.totalBatches, 2);
    const selected = cached;
    set(onFalse, "count", 8); assert.strictEqual(ctx.scenePromptQueueDisplayCache(displayQueue, 360.1), selected,
        "unselected Switch branch edits do not change the Queue display snapshot");
    changed(() => { set(onTrue, "count", 5); }); assert.equal(cached.totalBatches, 5);
    changed(() => { onTrue.mode = 2; }); assert.equal(cached.totalBatches, 0);
    changed(() => { onTrue.mode = 0; }); assert.equal(cached.totalBatches, 5);
    const beforeWidth = cached;
    cached = ctx.scenePromptQueueDisplayCache(displayQueue, 361.1);
    assert.notStrictEqual(cached, beforeWidth); assert.equal(cached.rowKey, beforeWidth.rowKey);
    assert.notEqual(cached.cacheKey, beforeWidth.cacheKey);
    const largeMatrix = add(displayGraph, "ScenePromptMatrix", { matrix_json: JSON.stringify([{ name: "large", positive_base: "tag,".repeat(20000) }]) });
    const largeQueue = add(displayGraph, "ScenePrompterQueue"); connect(largeMatrix, largeQueue, "scene_prompt1");
    const largeCache = ctx.scenePromptQueueDisplayCache(largeQueue, 360);
    assert(largeCache.rowKey.length > 80000, "the display cache regression includes a real large Matrix dependency");
    stringifies = 0;
    for (let draw = 0; draw < 50; draw++) assert.strictEqual(ctx.scenePromptQueueDisplayCache(largeQueue, 360), largeCache);
    assert.equal(stringifies, 0, "large Queue row keys are never JSON wrapped again on warm draws");
    ctx.JSON = originalJSON; ctx.scenePromptQueueRowsCacheKey = originalRowsKey;
    ctx.isScenePromptSourceNode = originalSourcePredicate;
}

// Completed values and active recursion are separate: a masking Preset must not erase another branch's true Queue.
const cut = { api_graph: { output: {
    1: { class_type: "ScenePrompter", inputs: {} },
    2: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
} } };
ctx.scenePresetDisplayGraphs.set("cut", cut);
const maskGraph = graph(), q = add(maskGraph, "ScenePrompterQueue"), masked = add(maskGraph, "ScenePromptPreset", { preset_id: "cut" });
const maskMerge = add(maskGraph, "ScenePrompterMerge"); masked.scenePresetGraph = cut;
connect(q, masked, "scene_prompt"); connect(masked, maskMerge, "scene_prompt1"); connect(q, maskMerge, "scene_prompt2");
assert.equal(ctx.sceneQueueBoundaryInNode(masked), false);
assert.equal(ctx.sceneQueueBoundaryInNode(maskMerge), true, "direct Q retains its completed true after a Preset masks inherited Q");
const nestedMask = { api_graph: { output: {
    1: { class_type: "ScenePrompterQueue", inputs: {} },
    2: { class_type: "ScenePresetReference", inputs: { scene_prompt: ["1", 0], preset_id: "cut" } },
    3: { class_type: "ScenePrompterMerge", inputs: { scene_prompt1: ["2", 0], scene_prompt2: ["1", 0] } },
    4: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["3", 0] } },
} } };
assert.equal(ctx.sceneQueueBoundaryInPreset("nested-mask", false, new Set(), nestedMask), true,
    "Preset API graph traversal also reuses completed Q=true instead of visited=false");
const passthrough = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
} } };
assert.equal(ctx.sceneQueueBoundaryInPreset("passthrough", true, new Set(), passthrough), true);
assert.equal(ctx.sceneQueueBoundaryInPreset("passthrough", false, new Set(), passthrough), false,
    "completed values never leak between separate Preset invocations/inherited values");
assert.equal(ctx.sceneQueueBoundaryInPreset("unknown", true), null);
assert.equal(ctx.sceneQueueBoundaryInPreset("cut", true, new Set(["cut"])), null, "nested stack cycle preserves unknown fallback");
const cyclicPreset = { api_graph: { output: {
    1: { class_type: "ScenePrompter", inputs: { scene_prompt: ["2", 0] } },
    2: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0] } },
    3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
} } };
assert.equal(ctx.sceneQueueBoundaryInPreset("cycle", false, new Set(), cyclicPreset), false);

const predicates = [
    ["sceneQueueBoundaryInNode", "ScenePrompterQueue"],
    ["sceneRandomRouteInNode", "ScenePromptRandomRoute"],
    ["sceneQueuePendingInNode", "ScenePromptPreset"],
];
for (const [name, positiveType] of predicates) {
    const pg = graph(), ordinary = add(pg, "ScenePrompter"), positive = add(pg, positiveType, { preset_id: "not-loaded" });
    const merge = add(pg, "ScenePrompterMerge"); connect(ordinary, merge, "scene_prompt1"); connect(positive, merge, "scene_prompt2");
    assert.equal(ctx[name](merge), true, `${name} positive second branch`);
    positive.mode = 2; assert.equal(ctx[name](merge), false, `${name} muted source`);
    positive.mode = 4; connect(ordinary, positive, "scene_prompt");
    assert.equal(ctx[name](merge), false, `${name} bypassed positive source`);
    positive.mode = 0; assert.equal(ctx[name](merge), true, `${name} mode change has no global memo`);
    const visiting = new Set(), completed = new Map();
    assert.equal(ctx[name](ordinary, visiting, completed), false);
    const other = graph(), reusedId = add(other, positiveType, { preset_id: "not-loaded" }, ordinary.id);
    assert.equal(ctx[name](reusedId, visiting, completed), true, `${name} memo keys actual node objects across same-ID graphs`);
    assert.equal(visiting.size, 0);
    const ca = add(pg, "ScenePrompter"), cb = add(pg, "ScenePrompterMerge");
    connect(cb, ca, "scene_prompt"); connect(ca, cb, "scene_prompt1");
    assert.equal(ctx[name](ca), false, `${name} a backedge terminates`);
    connect(positive, cb, "scene_prompt2"); assert.equal(ctx[name](ca), true, `${name} cycle still sees another positive path`);
}

// Deterministic DAGs compare the optimized queries with independent path traversal.
let randomState = 173;
const next = max => { randomState = (randomState * 16807) % 2147483647; return randomState % max; };
function oracle(node, kind, trail = new Set()) {
    if (!node || trail.has(node) || node.mode === 2) return false;
    const active = new Set(trail); active.add(node);
    if (node.mode === 4) return oracle(ctx.sceneBypassInputSource(node), kind, active);
    if (kind === "sceneQueueBoundaryInNode" && ctx.isScenePromptJoinNode(node)) return true;
    if (kind === "sceneRandomRouteInNode" && ctx.isScenePromptRandomRouteNode(node)) return true;
    if (kind === "sceneQueuePendingInNode" && ctx.isScenePresetReferenceNode(node)) return true;
    const sources = ctx.isScenePromptMergeNode(node) ? ctx.connectedScenePromptSourcesForMerge(node)
        : ctx.isScenePromptJoinNode(node) ? ctx.connectedScenePromptSourcesForQueue(node)
            : [{ source: ctx.scenePromptInputSource(node) }];
    return sources.some(({ source }) => oracle(source, kind, active));
}
for (let sample = 0; sample < 40; sample++) {
    const dag = graph(), nodes = [];
    for (let index = 0; index < 18; index++) {
        const types = ["ScenePrompter", "ScenePrompterMerge", "ScenePrompterQueue", "ScenePromptRandomRoute"];
        const node = add(dag, types[next(types.length)]); node.mode = [0,0,0,2,4][next(5)];
        if (nodes.length) {
            const input = ctx.isScenePromptMergeNode(node) || ctx.isScenePromptJoinNode(node) ? "scene_prompt1" : "scene_prompt";
            connect(nodes[next(nodes.length)], node, input);
            if (input === "scene_prompt1") connect(nodes[next(nodes.length)], node, "scene_prompt2");
        }
        nodes.push(node);
        for (const [name] of predicates) assert.equal(ctx[name](node), oracle(node, name), `${name} DAG sample ${sample}/${index}`);
    }
}

// Removing a node releases all computed caches; saved state remains sufficient for lazy Undo restoration.
const savedWidgets = structuredClone(count.widgets), savedProperties = { saved: "undo" }; count.properties = savedProperties;
const cacheNames = [...functionSource("clearSceneComputedCaches").matchAll(/node\.(\w+Cache) = null/g)].map(match => match[1]);
for (const name of cacheNames) count[name] = { retained: true };
ctx.installSceneNodeRemovalCleanup(count, count.type); count.onRemoved();
for (const name of cacheNames) assert.equal(count[name], null, `${name} is released`);
assert.deepEqual(count.widgets, savedWidgets); assert.equal(count.properties, savedProperties);
assert.equal(snapshot(count).total, 2, "Undo can lazily reconstruct the same saved plan");
for (let revision = 0; revision < 200; revision++) { set(number, "value", revision); key(count); }
assert.deepEqual(Object.keys(count.scenePromptSourceKeyCache).sort(), ["graph", "key"]);

// A batched refresh shares its visited objects across overlapping sources, including cycles.
const refreshGraph = graph(), left = add(refreshGraph, "ScenePrompter"), right = add(refreshGraph, "ScenePrompter");
const shared = add(refreshGraph, "ScenePrompterMerge"), tail = add(refreshGraph, "ScenePrompter"), expand = add(refreshGraph, "ScenePrompterExpand");
connect(left, shared, "scene_prompt1"); connect(right, shared, "scene_prompt2"); connect(shared, tail, "scene_prompt"); connect(tail, expand, "scene_prompt");
ctx.sceneDownstreamRefreshSources = new Set([left, right]); refreshGraph.lookups = 0;
const refreshed = []; ctx.scheduleSceneNodeRefresh = node => refreshed.push(node);
ctx.flushDownstreamSceneRefreshes();
assert.equal(refreshGraph.lookups, 4, "shared descendants walk once across source edits");
assert.deepEqual(refreshed, [shared, tail, expand]);
const allSeen = new Set(), targets = new Set();
ctx.collectDownstreamSceneNodes(left, targets, allSeen);
const secondRefresh = graph(), reused = add(secondRefresh, "ScenePrompter", {}, left.id), reusedTail = add(secondRefresh, "ScenePrompter", {}, tail.id);
connect(reused, reusedTail, "scene_prompt"); ctx.collectDownstreamSceneNodes(reused, targets, allSeen);
assert(targets.has(reusedTail), "same IDs in another graph are distinct visited objects");
console.log("Scene flat lineage/Primitive/cache cleanup regressions passed", JSON.stringify(measurements));

// Exercise the actual Matrix normalizer with the real state parser, not a JSON stub.
async function testMatrixCurrentStateCache() {
    const stateModule = await import("../web/scene_prompt_state.js");
    const calls = { parse: 0, serialize: 0, stringify: 0 };
    const matrixContext = {
        Array, String, Object, Number,
        JSON: { parse: JSON.parse, stringify(value) { calls.stringify++; return JSON.stringify(value); } },
        parseMatrixState(value) { calls.parse++; return stateModule.parseMatrixState(value); },
        serializeMatrixState(value) { calls.serialize++; return stateModule.serializeMatrixState(value); },
        createMatrixState: stateModule.createMatrixState,
        findWidget: (node, name) => node?.widgets?.find(widget => widget.name === name),
        hideWidget(widget) { widget.hidden = true; },
        notifyWidgetChanged() {}, refreshNode() {}, refreshDownstreamSceneNodes() {}, app: { graph: { change() {} } },
    };
    require("./scene_switches_test_context.cjs").install(matrixContext);
    vm.createContext(matrixContext);
    for (const name of ["serializedMatrixJsonValue", "currentMatrixJsonValue", "cachedMatrixState",
        "normalizeMatrixWidgetValues", "ensureMatrixJsonWidget", "parseMatrixStateValue", "normalizeMatrixState",
        "readMatrixState", "writeMatrixState", "clearSceneComputedCaches"]) vm.runInContext(functionSource(name), matrixContext);
    const raw = (label, rows = 1) => stateModule.serializeMatrixState({ version: 1, sets: Array.from({ length: rows }, (_, index) => ({
        ...stateModule.createMatrixLine(`${label}-${index}`), row_id: `${label}-${index}`, name: `${label}-${index}`, path_label: `${label}-${index}`,
    })) });
    const node = { widgets: [{ name: "unrelated", value: "keep" }, { name: "matrix_json", value: raw("warm", 100) }],
        properties: {}, widgets_values: ["keep"], mode: 0, type: "SceneMatrix" };
    const widget = node.widgets[1];
    const read = () => matrixContext.readMatrixState(node);
    const warm = read(); assert.equal(warm.sets.length, 100);
    const reset = () => { calls.parse = calls.serialize = calls.stringify = 0; };
    reset(); const start = performance.now();
    for (let index = 0; index < 1000; index++) {
        assert.strictEqual(read(), warm);
        assert.strictEqual(matrixContext.ensureMatrixJsonWidget(node), widget);
    }
    const warm1000ms = Number((performance.now() - start).toFixed(2));
    assert.deepEqual(calls, { parse: 0, serialize: 0, stringify: 0 }, "warm reads and lineage ensure calls perform no state parsing or serialization");
    assert.equal(node.widgets_values[0], "keep");
    assert.equal(node.widgets_values[1], widget.value); assert.equal(node.properties.scene_matrix_json, widget.value);
    assert.deepEqual(Object.keys(node.sceneMatrixStateCache).sort(), ["propertyValue", "serializedValue", "state", "widget", "widgetValue"]);
    const changed = (mutate, expected) => {
        const old = read(); reset(); mutate(); const next = read();
        assert.notStrictEqual(next, old, "a raw source mutation invalidates the current cache");
        assert(calls.parse > 0); assert(calls.serialize > 0);
        assert.equal(next.sets[0]?.name, expected);
        assert.equal(widget.value, node.properties.scene_matrix_json); assert.equal(widget.value, node.widgets_values[1]);
        reset(); assert.strictEqual(read(), next); assert.deepEqual(calls, { parse: 0, serialize: 0, stringify: 0 });
        return next;
    };
    changed(() => { widget.value = raw("widget-edit"); }, "widget-edit-0");
    changed(() => { node.properties.scene_matrix_json = raw("property-edit"); }, "widget-edit-0");
    changed(() => { node.widgets_values[1] = raw("slot-edit"); }, "widget-edit-0");
    changed(() => { widget.value = "malformed"; node.properties.scene_matrix_json = raw("legacy-property"); }, "legacy-property-0");
    changed(() => { widget.value = "malformed"; node.properties.scene_matrix_json = "malformed"; node.widgets_values[1] = raw("legacy-slot"); }, "legacy-slot-0");
    changed(() => { widget.value = stateModule.serializeMatrixState(stateModule.createMatrixState()); node.properties.scene_matrix_json = raw("nonempty-property"); }, "nonempty-property-0");
    changed(() => { widget.value = " "; node.properties.scene_matrix_json = " "; node.widgets_values[1] = raw("slot-only"); }, "slot-only-0");
    const beforeDelete = { value: widget.value, property: node.properties.scene_matrix_json, slot: node.widgets_values[1] };
    matrixContext.writeMatrixState(node, stateModule.createMatrixState(), { refresh: false });
    assert(!Object.hasOwn(node, "sceneMatrixState"), "write does not retain a second permanent state object");
    const empty = read(); assert.deepEqual(empty.sets, []);
    reset(); for (let index = 0; index < 1000; index++) assert.strictEqual(read(), empty);
    assert.deepEqual(calls, { parse: 0, serialize: 0, stringify: 0 }, "delete-all stays empty and warm, without restoring stale legacy rows");
    const deleted = { value: widget.value, property: node.properties.scene_matrix_json, slot: node.widgets_values[1] };
    const restore = saved => { widget.value = saved.value; node.properties.scene_matrix_json = saved.property; node.widgets_values[1] = saved.slot; matrixContext.clearSceneComputedCaches(node); };
    restore(beforeDelete); assert.equal(read().sets[0].name, "slot-only-0", "Undo reconstructs the saved rows");
    restore(deleted); assert.equal(read().sets.length, 0, "Redo reconstructs the saved empty state");
    const reloaded = { ...node, widgets: [{ name: "unrelated", value: "keep" }, { name: "matrix_json", value: beforeDelete.value }],
        properties: { scene_matrix_json: beforeDelete.property }, widgets_values: ["keep", beforeDelete.slot], sceneMatrixStateCache: null };
    const loaded = matrixContext.readMatrixState(reloaded);
    assert.equal(loaded.sets[0].name, "slot-only-0"); assert.notStrictEqual(loaded, empty);
    const sameIdNewGraph = { ...reloaded, widgets: [{ name: "matrix_json", value: raw("new-graph") }], widgets_values: [],
        properties: {}, sceneMatrixStateCache: null };
    assert.equal(matrixContext.readMatrixState(sameIdNewGraph).sets[0].name, "new-graph-0");
    const oldWidget = node.widgets[1]; restore(beforeDelete); read(); node.widgets[1] = { ...oldWidget };
    const replaced = read(); assert.equal(replaced.sets[0].name, "slot-only-0");
    assert.strictEqual(node.sceneMatrixStateCache.widget, node.widgets[1], "replacement widgets own the new current tuple");
    node.widgets[1].value = node.properties.scene_matrix_json = node.widgets_values[1] = "malformed";
    assert.throws(read, /JSON/); assert.equal(node.sceneMatrixStateCache, null, "a failed recovery releases the old parsed state");
    node.widgets[1].value = beforeDelete.value; read();
    ctx.installSceneNodeRemovalCleanup(node, node.type); node.onRemoved();
    assert.equal(node.sceneMatrixStateCache, null, "node removal releases the current Matrix state");
    assert.equal(read().sets[0].name, "slot-only-0", "saved fields suffice after removal/Undo");
    const withoutWidget = { widgets: [], properties: { scene_matrix_json: raw("legacy-only") } };
    assert.equal(matrixContext.readMatrixState(withoutWidget).sets[0].name, "legacy-only-0");
    console.log("Matrix actual-parser warm cache, field invalidation, legacy fallback, delete-all, Undo/Redo/reload and release passed", JSON.stringify({ warm1000ms }));
}
testMatrixCurrentStateCache().catch(error => { console.error(error); process.exitCode = 1; });

// Catalog indexes retain only exact-leaf references and are owned by array identity.
{
    const catalog = { Map, Set, WeakMap, Object, String, JSON, promptCatalogIndexes: new WeakMap() };
    require("./scene_switches_test_context.cjs").install(catalog);
    vm.createContext(catalog);
    for (const name of ["itemPath", "pathKey", "catalogPathKey", "stripCountSuffix", "displayPathLabel",
        "itemCategoryKey", "itemKey", "promptCatalogIndex", "allCategoryPaths", "getChildSegments",
        "itemsForPath", "rootCategories", "subcategoriesFor", "selectedItems", "selectionPathCounts",
        "countForPath", "countExactForPath"]) vm.runInContext(functionSource(name), catalog);
    let pathReads = 0;
    const items = Array.from({ length: 10000 }, (_, id) => ({ id: String(id), label: `item-${id}`, prompt: `tag-${id}`,
        category_key: `Root-${id % 100} > Leaf`,
        get category_path() { pathReads++; return [`Root-${id % 100}`, "Leaf"]; } }));
    const index = catalog.promptCatalogIndex(items);
    assert.equal(pathReads, items.length, "each catalog item path is normalized once");
    const state = { categories: { first: [items[0]], second: [items[1]] } };
    const counts = catalog.selectionPathCounts(state);
    pathReads = 0;
    for (let repeat = 0; repeat < 10; repeat++) {
        for (const path of catalog.allCategoryPaths(items)) {
            catalog.getChildSegments(items, path); catalog.itemsForPath(items, path);
            catalog.countForPath(items, state, path, counts); catalog.countExactForPath(items, state, path, counts);
        }
    }
    assert.equal(pathReads, 0, "warm navigation and counts never rescan catalog paths");
    assert.equal([...index.branches.values()].reduce((sum, branch) => sum + branch.items.length, 0), items.length,
        "ancestor branches keep totals, without full descendant-array copies");
    assert.equal(catalog.countForPath(items, state, ["Root-0"], counts).selected, 1);
    const changedCounts = catalog.selectionPathCounts({ categories: {} });
    assert.equal(catalog.countForPath(items, {}, ["Root-0"], changedCounts).selected, 0, "counts use current selection");
    assert.strictEqual(catalog.promptCatalogIndex(items), index);
    const replacement = [{ id: "new", label: "New", category_path: ["New"] }];
    assert.notStrictEqual(catalog.promptCatalogIndex(replacement), index);
    assert.deepEqual(Array.from(catalog.getChildSegments(replacement, [])), ["New"], "replacement catalog has no historical branches");
    const collision = [{ id: "literal", category_path: ["A > B"], category_key: "literal" },
        { id: "nested", category_path: ["A", "B"], category_key: "nested" },
        { id: "child", category_path: ["A > B", "C"], category_key: "child" }];
    assert.deepEqual(Array.from(catalog.itemsForPath(collision, ["A > B"]), item => item.id), ["literal"]);
    assert.deepEqual(Array.from(catalog.itemsForPath(collision, ["A", "B"]), item => item.id), ["nested"]);
    assert.deepEqual(Array.from(catalog.getChildSegments(collision, ["A > B"])), ["C"]);
    const collisionState = { categories: { selected: [collision[0]] } }, collisionCounts = catalog.selectionPathCounts(collisionState);
    assert.equal(catalog.countForPath(collision, collisionState, ["A > B"], collisionCounts).total, 2);
    assert.equal(catalog.countForPath(collision, collisionState, ["A", "B"], collisionCounts).selected, 0);
    assert.equal(catalog.allCategoryPaths(collision).length, 4, "structurally different paths survive identical display labels");
    console.log("Current catalog index identity, linear storage, warm operation counts and structural paths passed");
}

// Control frame delivery explicitly, including delivery of a cancelled stale callback.
{
    const frames = new Map(); let frameId = 0, fits = 0, version = 1;
    const render = { Math, Number, window: { innerWidth: 1280, innerHeight: 720 },
        POPUP_MIN_HEIGHT: 180, POPUP_MIN_WIDTH: 420,
        clamp: (value, min, max) => Math.max(min, Math.min(value, max)),
        requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
    };
    require("./scene_switches_test_context.cjs").install(render);
    vm.createContext(render);
    for (const name of ["fitPopupToContent", "cancelPopupListRender", "cancelPopupRendering", "renderPopupListItems",
        "restorePopupScroll", "rememberPopupScroll"]) vm.runInContext(functionSource(name), render);
    const list = { isConnected: true, scrollTop: 0 }, popup = {
        isConnected: true, style: {}, classList: { add() {} }, scrollHeight: 500,
        contains: candidate => candidate === list,
        getBoundingClientRect() { fits++; return { width: 560, height: 500, left: 12, top: 12 }; },
    };
    const delivered = [], items = Array.from({ length: 1000 }, (_, index) => index);
    render.renderPopupListItems(popup, list, items, chunk => delivered.push(...chunk.map(item => [item, version])));
    assert.equal(delivered.length, 24, "large lists expose a small synchronous first chunk");
    assert.equal(frames.size, 2, "one fit and one continuation are pending");
    for (let index = 0; index < 20; index++) render.fitPopupToContent(popup);
    assert.equal(frames.size, 2, "fit requests coalesce for the popup");
    version = 2;
    const tick = () => { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); };
    while (frames.size) { const before = fits; tick(); assert(fits - before <= 1, "at most one fit in a frame"); }
    assert.deepEqual(delivered.map(([item]) => item), items, "all results arrive in catalog order without a cap");
    assert(delivered.slice(24).every(([, stateVersion]) => stateVersion === 2), "later chunks read fresh state");
    assert.equal(popup.sceneListRender, null); assert.equal(list.sceneListRender, null);
    render.renderPopupListItems(popup, list, [1, 2, 3], chunk => assert.deepEqual(Array.from(chunk), [1, 2, 3]));
    assert.equal(popup.sceneListRender, null, "small leaves remain immediate"); tick();
    const oldRows = [], newRows = [];
    render.renderPopupListItems(popup, list, items, chunk => oldRows.push(...chunk));
    const oldTask = popup.sceneListRender, stale = frames.get(oldTask.frame);
    render.renderPopupListItems(popup, list, [9999], chunk => newRows.push(...chunk)); stale();
    assert.equal(oldRows.length, 24, "stale callbacks cannot append into a replacement render"); assert.deepEqual(newRows, [9999]); tick();
    render.renderPopupListItems(popup, list, items, () => {});
    list.isConnected = false; tick(); assert.equal(popup.sceneListRender, null, "detached lists release their task");
    list.isConnected = true; render.renderPopupListItems(popup, list, items, () => {});
    render.cancelPopupRendering(popup); assert.equal(frames.size, 0, "close/reload cancels both continuation and layout");
    const handlers = {}, session = { scrollTops: { search: 5000 } };
    let scrollTop = 0, scrollLimit = 1000;
    Object.defineProperty(list, "scrollTop", { get: () => scrollTop, set: value => { scrollTop = Math.min(value, scrollLimit); } });
    list.addEventListener = (name, callback) => { handlers[name] = callback; };
    popup.getBoundingClientRect = () => {
        fits++; scrollLimit = 900; scrollTop = Math.min(scrollTop, scrollLimit);
        return { width: 560, height: 500, left: 12, top: 12 };
    };
    render.rememberPopupScroll(session, "search", list);
    render.renderPopupListItems(popup, list, items, () => {});
    assert.equal(list.scenePendingScrollRestore.appliedTop, 1000);
    tick(); handlers.scroll();
    assert.equal(list.scenePendingScrollRestore.appliedTop, 900, "fit resynchronizes the browser's automatic viewport clamp");
    assert.equal(session.scrollTops.search, 5000, "automatic clamp does not discard the deep saved target");
    list.scrollTop = 37; handlers.scroll();
    assert.equal(list.scenePendingScrollRestore, null, "manual scrolling cancels a pending deep restore");
    assert.equal(session.scrollTops.search, 37);
    list.isConnected = false; list.scrollTop = 0; handlers.scroll();
    assert.equal(session.scrollTops.search, 37, "late scroll events from removed DOM cannot overwrite the current session");
    render.cancelPopupRendering(popup); assert.equal(frames.size, 0);
    console.log("Popup chunks preserve order/fresh state and cancel stale DOM tasks; fits coalesce");
}
