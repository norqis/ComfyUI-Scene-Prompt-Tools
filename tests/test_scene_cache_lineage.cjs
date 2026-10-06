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
    SCENE_QUEUE_DISPLAY_PREVIEW_ROWS: 40, scenePresetDisplayGraphs: new Map(), MATRIX_DEFAULT_JSON: "{}",
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
    "connectedScenePromptSourcesForMerge", "sceneScheduleForLinkedInput", "sceneScheduleForNode",
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
set(prompt, "positive_base", "b"); assert.notEqual(ctx.scenePromptQueueRowsCacheKey(queue), queueKey);
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
