const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

const previewContext = {
    Math, Number, Set, Map, Array, String,
    MATRIX_SECTION_VISIBLE_ROWS: 160,
    emptyMatrixRow() { return {}; },
    scenePromptSourceCacheKey(node) { return node.id; },
    scenePromptStats() { return {}; },
    isSceneNodeMuted() { return false; }, isSceneNodeBypassed() { return false; },
    isScenePresetReferenceNode() { return false; },
    isScenePromptRandomRouteNode() { return false; }, sceneRandomRouteInNode() { return false; },
    sceneQueueBoundaryInNode() { return false; },
    sceneScheduleForNode(node) { return node; },
    sceneSchedulePrefix(node, limit) {
        return (node.sources || []).flatMap((source) =>
            previewContext.scenePromptPreviewEntries(source, limit)).slice(0, limit);
    },
    scenePromptInputSource(node) { return node.upstream || null; },
    isScenePromptNode(node) { return node.kind === "prompt"; },
    isScenePromptCallbackNode(node) { return node.kind === "callback"; },
    isSceneApplyModelNode(node) { return node.kind === "apply_model"; },
    isSceneApplyLoraNode(node) { return node.kind === "apply_lora"; },
    scenePromptTitle(node) { return node.title; },
    isPromptMatrixNode(node) { return node.kind === "matrix"; },
    matrixLinesForNode(node) { return node.rows || []; },
    matrixConfiguredLineCount(node) { return node.configured || 0; },
    matrixLineLabel(row) { return row.label; },
    isScenePathNode() { return false; }, isScenePromptCounterNode() { return false; }, isScenePromptReverseNode() { return false; }, isScenePromptDeleteNode() { return false; }, isSceneEmptyLatentNode() { return false; },
    isScenePromptQueueNode(node) { return node.kind === "queue"; },
    isScenePromptJoinNode(node) { return node.kind === "queue"; },
    isScenePromptRandomRouteOutputNode() { return false; },
    connectedScenePromptSourcesForQueue(node) { return (node.sources || []).map((source) => ({ source })); },
    sceneQueueDisplayPartsForEntry(entry) { return entry.parts; },
    isScenePromptMergeNode(node) { return node.kind === "merge"; },
    connectedScenePromptSourcesForMerge(node) { return [{ source: node.left || null }, { source: node.right || null }]; },
    mergeScenePromptEntryLists(first, second, limit) {
        const result = [];
        for (const left of first) for (const right of second) {
            result.push({ parts: [...left.parts, ...right.parts], count: 1, row: {} });
            if (result.length >= limit) return result;
        }
        return result;
    },
};
require("./scene_switches_test_context.cjs").install(previewContext);
vm.createContext(previewContext);
vm.runInContext(functionSource("nodeClassName"), previewContext);
vm.runInContext(functionSource("scenePromptPreviewEntries"), previewContext);
const base = { id: "base", kind: "queue", sources: [
    { id: "a", kind: "prompt", title: "A" }, { id: "b", kind: "prompt", title: "B" },
] };
const matrixRows = Array.from({ length: 100 }, (_value, index) => ({ label: `M${index + 1}` }));
const matrix = { id: "matrix", kind: "matrix", upstream: base, rows: matrixRows };
assert.deepEqual(JSON.parse(JSON.stringify(previewContext.scenePromptPreviewEntries(matrix, 10))).map((entry) => entry.parts.join("")), ["AM1", "AM2", "AM3", "AM4", "AM5", "AM6", "AM7", "AM8", "AM9", "AM10"], "Matrix preview follows backend base-outer ordering and stops at its limit");
const merge = { id: "merge", kind: "merge", left: base, right: { id: "right", kind: "matrix", rows: matrixRows } };
assert.deepEqual(JSON.parse(JSON.stringify(previewContext.scenePromptPreviewEntries(merge, 10))).map((entry) => entry.parts.join("")), ["AM1", "AM2", "AM3", "AM4", "AM5", "AM6", "AM7", "AM8", "AM9", "AM10"], "Merge preview fetches enough right-hand rows for its backend prefix");
const empty = { id: "empty", kind: "matrix", upstream: base, rows: [], configured: 1 };
assert.equal(previewContext.scenePromptPreviewEntries({ id: "downstream", kind: "matrix", upstream: empty, rows: [{ label: "X" }] }, 160).length, 0, "connected empty Matrix stays empty");
const callback = { id: "callback", kind: "callback", upstream: matrix };
assert.deepEqual(
    JSON.parse(JSON.stringify(previewContext.scenePromptPreviewEntries(callback, 2))).map((entry) => entry.parts.join("")),
    ["AM1", "AM2"],
    "Callback stays transparent to Scene preview rows",
);
assert.equal(
    previewContext.scenePromptPreviewEntries({ id: "callback-first", kind: "callback" }, 2).length,
    1,
    "Callback can start a Scene plan without a scene_prompt input",
);
const mergeContext = { Array, Number, Math, sceneStatNumber(value) { return Number(value || 0); }, mergeScenePromptRows() { return {}; } };
require("./scene_switches_test_context.cjs").install(mergeContext);
vm.createContext(mergeContext);
for (const name of ["mergeScenePromptEntryPair", "mergeScenePromptEntryLists"]) vm.runInContext(functionSource(name), mergeContext);
assert.deepEqual(JSON.parse(JSON.stringify(mergeContext.mergeScenePromptEntryLists([{ count: 1 }], []))), [], "the real Merge helper treats a connected empty input as empty");

const displayContext = {
    Math, JSON,
    scenePromptQueueDisplayCacheKey() { return "cache"; },
    scenePromptQueueRowsCacheKey() { return "rows"; },
    scenePromptQueueRowEntries() { throw new Error("full rows must not be expanded"); },
    scenePromptStats() { return { rows: 1000000, total: 1000000, totalImages: 1000000, unsetBatches: 1000000 }; },
    sceneQueuePreviewRows() { return Array.from({ length: 160 }, () => ({ parts: ["p"] })); },
    sceneQueueDisplayEntriesFromRows(rows) { return rows; },
    sceneQueueDisplayNaturalHeight(entries) { return entries.length; },
    connectedScenePromptSourcesForQueue() { return [{}]; },
    sceneShouldDrawDetails() { return true; },
    findSceneWidget() { return {}; }, formatSceneExpandCounts(a, b) { return `${a}/${b}`; },
    SCENE_COMPACT_WIDGET_HEIGHT: 18,
    app: { graph: { setDirtyCanvas() {} }, canvas: { setDirty() {} } },
};
require("./scene_switches_test_context.cjs").install(displayContext);
vm.createContext(displayContext);
for (const name of ["computeScenePromptQueueDisplayCache", "refreshScenePromptQueueNode"]) vm.runInContext(functionSource(name), displayContext);
const queueNode = { size: [360, 100], setDirtyCanvas() {} };
assert.equal(displayContext.computeScenePromptQueueDisplayCache(queueNode).entries.length, 160, "Queue cache keeps only bounded preview entries");
displayContext.refreshScenePromptQueueNode(queueNode, { fitHeight: true });

let createdImages = 0;
const saveContext = {
    Set, Map, JSON, Math, Array,
    SCENE_SAVE_PREVIEW_LIMIT: 1,
    SCENE_SAVE_IMAGE_NODE_NAMES: new Set(["SceneSaveImage"]),
    sceneNodeFromEvent(detail) { return detail.node; },
    imageRefKey(ref) { return ref.filename; }, previewUrl(ref) { return ref.filename; },
    Image: class { constructor() { createdImages += 1; } },
    app: { graph: { setDirtyCanvas() {} }, canvas: { setDirty() {} } },
};
require("./scene_switches_test_context.cjs").install(saveContext);
vm.createContext(saveContext);
for (const name of ["appendSceneSavePreview", "trimSceneSavePreviews", "clearSceneSavePreviews"]) {
    vm.runInContext(functionSource(name), saveContext);
}
const saveNode = { type: "SceneSaveImage", imgs: [], size: [100, 100], setDirtyCanvas() {} };
const hundred = Array.from({ length: 100 }, (_value, index) => ({ filename: `image-${index}` }));
saveContext.appendSceneSavePreview({ node: saveNode, output: { images: hundred } });
assert.equal(createdImages, 1, "a 100-image event constructs only the displayed latest image");
assert.equal(saveNode.imgs[0].scenePreviewKey, "image-99");
saveContext.appendSceneSavePreview({ node: saveNode, output: { images: hundred } });
assert.equal(createdImages, 1, "repeated events retain the latest cached image without loading an older one");
saveContext.appendSceneSavePreview({ node: saveNode, output: { images: [{ filename: "image-100" }] } });
assert.equal(createdImages, 2, "a newer event loads one new latest image");
assert.equal(saveNode.imgs[0].scenePreviewKey, "image-100");
for (let index = 101; index < 126; index++) {
    const obsolete = saveNode.scenePreviewImages.values().next().value;
    // Native ComfyUI replaces imgs with independently loaded Image objects.
    saveNode.imgs = [{ src: `image-${index - 1}` }];
    saveContext.appendSceneSavePreview({ node: saveNode, output: { images: [{ filename: `image-${index}` }] } });
    assert.equal(saveNode.imgs.length, 1);
    assert.deepEqual([...saveNode.scenePreviewKeys], [`image-${index}`]);
    assert.deepEqual([...saveNode.scenePreviewImages.keys()], [`image-${index}`]);
    assert.equal(obsolete.onload, null, "replaced preview releases its node callback");
    const createdBeforeDuplicate = createdImages;
    saveNode.imgs = [{ src: `image-${index}` }];
    saveContext.appendSceneSavePreview({ node: saveNode, output: { images: [{ filename: `image-${index}` }] } });
    assert.equal(createdImages, createdBeforeDuplicate, "native replacement does not reload a duplicate latest image");
    assert.equal(saveNode.scenePreviewImages.size, 1);
}
saveContext.app.graph._nodes = [saveNode];
saveContext.clearSceneSavePreviews();
assert.equal(saveNode.scenePreviewImages.size, 0);
assert.equal(saveNode.scenePreviewKeys.size, 0);
assert.equal(saveNode.imgs.length, 0);

const documentListeners = new Map();
const dragContext = {
    Math, window: { innerWidth: 1000, innerHeight: 800 },
    clamp(value, low, high) { return Math.min(high, Math.max(low, value)); },
    rememberPopupRect() {}, rememberSecondaryPopupRect() {},
    document: {
        addEventListener(name, listener) { documentListeners.set(name, listener); },
        removeEventListener(name, listener) { if (documentListeners.get(name) === listener) documentListeners.delete(name); },
    },
};
require("./scene_switches_test_context.cjs").install(dragContext);
vm.createContext(dragContext);
vm.runInContext(functionSource("makePopupDraggable"), dragContext);
const handleListeners = new Map();
const handle = { addEventListener(name, listener) { handleListeners.set(name, listener); } };
const popup = { offsetWidth: 300, offsetHeight: 200, style: {}, getBoundingClientRect() { return { left: 20, top: 30 }; } };
const disposeDrag = dragContext.makePopupDraggable({}, popup, handle);
handleListeners.get("pointerdown")({ button: 0, clientX: 30, clientY: 40, preventDefault() {}, stopPropagation() {} });
assert.equal(documentListeners.size, 3, "drag installs move, up, and cancel listeners");
documentListeners.get("pointercancel")();
assert.equal(documentListeners.size, 0, "pointercancel cleans every drag listener");
handleListeners.get("pointerdown")({ button: 0, clientX: 30, clientY: 40, preventDefault() {}, stopPropagation() {} });
disposeDrag();
assert.equal(documentListeners.size, 0, "closing a popup during drag cleans every document listener");

const expandContext = {
    Set,
    INTERNAL_INPUT_NAMES: new Set(["current_index", "run_id", "seed_base", "seed_base_literal"]),
    VISIBLE_INPUT_NAMES: new Set(["scene_prompt"]),
    app: { graph: { links: {}, setDirtyCanvas() {} }, canvas: { setDirty() {} } },
    injectStyle() {}, applySceneWidgetLabels() {}, installSceneConnectionWatcher() {},
    isSceneExpandNodeName: (name) => name === "ScenePrompterExpand",
    rebindSceneBatchRunNode() { return null; }, setWidgetValue() {}, ensureSceneExpandControls() {},
    SCENE_APPLY_MODEL_NODE_NAMES: new Set(),
    SCENE_APPLY_LORA_NODE_NAMES: new Set(), ensureSceneLoraControls() {},
    SCENE_PROMPT_TO_TEXT_NODE_NAMES: new Set(["ScenePromptToText"]),
    SCENE_PROMPT_DELETE_NODE_NAMES: new Set(["ScenePromptDelete"]),
    SCENE_EMPTY_LATENT_NODE_NAMES: new Set(), SCENE_PROMPT_REVERSE_NODE_NAMES: new Set(),
    installSceneEmptyLatentWidgetSyncHandlers() {}, installScenePromptReverseWidgetSyncHandlers() {},
    hideSceneUtilityWidgets() {}, scheduleHideInternalDomWidgets() {}, refreshSceneExpandNode() {},
};
require("./scene_switches_test_context.cjs").install(expandContext);
vm.createContext(expandContext);
for (const name of ["removeInternalInputSockets", "syncInputLinkTargetSlots", "attachSceneUtilityNode"]) {
    vm.runInContext(functionSource(name), expandContext);
}
const expandNode = {
    id: 41,
    graph: expandContext.app.graph,
    inputs: [
        { name: "current_index", link: null },
        { name: "run_id", link: null },
        { name: "seed_base", link: null },
        { name: "timestamp_dir", link: null },
        { name: "prefix", link: null },
        { name: "counter_position", link: null },
        { name: "scene_prompt", link: 101 },
        { name: "replace_underscores", link: null },
        { name: "convert_anima_weights", link: null },
        { name: "callback_first", link: 102 },
        { name: "callback_each", link: 103 },
        { name: "callback_last", link: 104 },
        { name: "callback_timeout_seconds", link: null },
        { name: "callback_failure_mode", link: null },
        { name: "seed_base_literal", link: null },
    ],
    removeInput(index) { this.inputs.splice(index, 1); },
};
for (const linkId of [101, 102, 103, 104]) {
    expandContext.app.graph.links[linkId] = { target_id: 41, target_slot: -1 };
}
expandContext.attachSceneUtilityNode(expandNode, "ScenePrompterExpand");
assert.deepEqual(
    Array.from(expandNode.inputs, (input) => input.name),
    [
        "timestamp_dir", "prefix", "counter_position", "scene_prompt", "replace_underscores", "convert_anima_weights",
        "callback_first", "callback_each", "callback_last",
        "callback_failure_mode",
    ],
    "Expand removes internal sockets while preserving Scene, Callback, and public widget inputs",
);
assert.deepEqual(
    [101, 102, 103, 104].map((linkId) => expandContext.app.graph.links[linkId].target_slot),
    [3, 6, 7, 8],
    "Expand resynchronizes existing Scene and Callback links after internal socket removal",
);

const applyModelContext = {
    SCENE_APPLY_MODEL_NODE_NAMES: new Set(["SceneApplyModel"]),
    SCENE_APPLY_LORA_NODE_NAMES: new Set(), ensureSceneLoraControls() {},
    app: { graph: { links: {}, setDirtyCanvas() {} }, canvas: { setDirty() {} } },
    injectStyle() {}, applySceneWidgetLabels() {}, installSceneConnectionWatcher() {},
    isSceneExpandNodeName() { return false; },
    SCENE_PROMPT_TO_TEXT_NODE_NAMES: new Set(["ScenePromptToText"]),
    SCENE_PROMPT_DELETE_NODE_NAMES: new Set(["ScenePromptDelete"]),
    SCENE_EMPTY_LATENT_NODE_NAMES: new Set(), SCENE_PROMPT_REVERSE_NODE_NAMES: new Set(),
    installSceneEmptyLatentWidgetSyncHandlers() {}, installScenePromptReverseWidgetSyncHandlers() {},
    hideSceneUtilityWidgets() {}, scheduleHideInternalDomWidgets() {},
};
require("./scene_switches_test_context.cjs").install(applyModelContext);
vm.createContext(applyModelContext);
for (const name of ["syncInputLinkTargetSlots", "moveScenePromptInputFirst", "attachSceneUtilityNode"]) {
    vm.runInContext(functionSource(name), applyModelContext);
}
const applyModelNode = {
    id: 42,
    graph: applyModelContext.app.graph,
    inputs: [
        { name: "model", link: 201 },
        { name: "clip", link: 202 },
        { name: "vae", link: 203 },
        { name: "scene_prompt", link: 204 },
    ],
    setDirtyCanvas() {},
};
for (const linkId of [201, 202, 203, 204]) {
    applyModelContext.app.graph.links[linkId] = { target_id: 42, target_slot: -1 };
}
applyModelContext.attachSceneUtilityNode(applyModelNode, "SceneApplyModel");
assert.deepEqual(
    Array.from(applyModelNode.inputs, (input) => input.name),
    ["scene_prompt", "model", "clip", "vae"],
    "Scene Apply Model displays scene_prompt first",
);
assert.deepEqual(
    [204, 201, 202, 203].map((linkId) => applyModelContext.app.graph.links[linkId].target_slot),
    [0, 1, 2, 3],
    "Scene Apply Model updates existing link slots after reordering inputs",
);

const layoutContext = vm.createContext({ Map, Set, Math, Number, String, JSON,
    DEFAULT_SELECTED_JSON: "{}", savedPromptsLayoutRevision: 0, sceneWorkflowLoadDepth: 0, activePopupContext: null,
    sceneTitleSyncNodes: new Set(), sceneLoadedRefreshNodes: new Set(), sceneDownstreamRefreshSources: new Set(),
    findWidget: (node, name) => node.widgets.find((widget) => widget.name === name),
    activeStateWidgetName: () => "role0", readStateFromWidget: (node, name) => node.widgets.find((widget) => widget.name === name).value,
    selectedListLayout: (_node, width, _unused, options) => ({ width, state: options.state }),
    clearSceneFitHeightTimer() {}, clearTimeout() {}, invalidatePopupRequests() {}, closeSceneLoraDetails() {},
    closeSceneExpandResources() {}, closeSceneLoraPicker() {}, popupContextReferencesNode() { return false; },
    isSceneExpandNodeName() { return false; },
});
for (const name of ["selectedListLayoutCacheKey", "cachedSelectedListLayout", "selectedListRenderCacheName", "clearSceneComputedCaches", "installSceneNodeRemovalCleanup"])
    vm.runInContext(functionSource(name), layoutContext);
const layoutNode = { widgets: Array.from({ length: 12 }, (_, index) => ({ name: `role${index}`, value: `state${index}` })) };
for (let index = 0; index < 12; index++) layoutContext.cachedSelectedListLayout(layoutNode, 300, { stateWidgetName: `role${index}` });
assert.equal(layoutNode.sceneSelectedListLayoutCache.size, 12, "all actual widget roles retain their current layouts without a count cap");
for (let revision = 0; revision < 1000; revision++) {
    layoutNode.widgets[0].value = `revision${revision}`;
    layoutContext.cachedSelectedListLayout(layoutNode, 300 + revision, { stateWidgetName: "role0" });
}
assert.equal(layoutNode.sceneSelectedListLayoutCache.size, 12, "state and resize changes replace their obsolete layout");
const latestLayout = layoutContext.cachedSelectedListLayout(layoutNode, 1299, { stateWidgetName: "role0" });
assert.equal(latestLayout.state, "revision999");
assert.strictEqual(layoutContext.cachedSelectedListLayout(layoutNode, 1299, { stateWidgetName: "role0" }), latestLayout);
layoutContext.installSceneNodeRemovalCleanup(layoutNode, "ScenePrompter");
layoutNode.onRemoved();
assert.equal(layoutNode.sceneSelectedListLayoutCache, null, "node removal releases its widget layouts");

{
    const frames = new Map(), attached = [];
    let nextFrame = 0;
    layoutContext.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
    layoutContext.cancelAnimationFrame = id => frames.delete(id);
    layoutContext.attachSceneNode = node => { attached.push(node); layoutContext.sceneTitleSyncNodes.add(node); };
    vm.runInContext(functionSource('scheduleAttachSceneNode'), layoutContext);
    const node = { widgets: [] };
    layoutContext.installSceneNodeRemovalCleanup(node, 'SceneMatrix');
    layoutContext.scheduleAttachSceneNode(node, 'SceneMatrix');
    layoutContext.scheduleAttachSceneNode(node, 'SceneMatrix');
    assert.equal(frames.size, 1, 'configuration coalesces into one pending frame');
    node.onRemoved();
    for (const callback of frames.values()) callback();
    assert.equal(attached.length, 0, 'a removed node must not be reattached by its old frame');
    assert.equal(frames.size, 0, 'removal releases the pending callback and node reference');
    layoutContext.scheduleAttachSceneNode(node, 'SceneMatrix');
    for (const callback of [...frames.values()]) callback();
    frames.clear();
    assert.deepEqual(attached, [node], 'later configuration still attaches without requiring graph membership');
    node.onRemoved();
    assert.equal(layoutContext.sceneTitleSyncNodes.size, 0);
}

console.log("Scene Prompt UI audit behavior tests passed.");

async function testCurrentDisplayAndRasterOwnership() {
    const stateModule = await import("../web/scene_prompt_state.js");
    const calls = { stringify: 0, selectionParse: 0, matrixParse: 0 };
    const textContext = () => ({ texts: [], images: [], font: "",
        measureText(value) { return { width: String(value).length * 7 }; },
        fillText(value) { this.texts.push(value); }, drawImage(canvas) { this.images.push(canvas); },
        save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, scale() {}, translate() {}, roundRect() {}, fill() {}, stroke() {},
    });
    const ctx = { Map, Set, Math, Number, String, Array, Object,
        JSON: { parse: JSON.parse, stringify(value) { calls.stringify++; return JSON.stringify(value); } },
        savedPrompts: [], savedPromptsLayoutRevision: 0, app: { graph: { _nodes: [] } },
        DEFAULT_SELECTED_JSON: stateModule.DEFAULT_SELECTED_JSON, MATRIX_DEFAULT_JSON: stateModule.MATRIX_DEFAULT_JSON,
        SELECTED_LIST_MIN_HEIGHT: 28, SELECTED_LIST_WIDTH_GUARD: 12, SELECTED_LIST_HEIGHT_GUARD: 6,
        CHIP_HEIGHT: 19, CHIP_GAP: 4, CHIP_LINE_GAP: 4, CHIP_TEXT_PAD_X: 6,
        MATRIX_NODE_DEFAULT_WIDTH: 340, MATRIX_SECTION_VISIBLE_ROWS: 12, SCENE_WIDGET_CANVAS_MAX_PIXELS: 2500000,
        chipMeasureContext: textContext(), window: { devicePixelRatio: 1 },
        document: { createElement(type) { assert.equal(type, "canvas"); const context = textContext(); return { getContext() { return context; }, context }; } },
        findWidget: (node, name) => node.widgets.find(widget => widget.name === name),
        findSceneWidget: () => null, activeStateWidgetName: () => "positive_json", sceneShouldDrawDetails: () => true,
        readStateFromWidget(node, name) { calls.selectionParse++; return stateModule.parseSelectionState(ctx.findWidget(node, name).value); },
        normalizedSelectedParts: () => null,
        sceneNodeMode: node => node?.mode || 0, sceneNodeRevision: node => node?.scenePromptRevision || 0,
        scenePromptInputSource: node => node.inputSource || null, linkedInputKey: node => node.inputLink || "",
        ensureMatrixJsonWidget: node => ctx.findWidget(node, "matrix_json"),
        matrixInputItems: node => node.inputSource ? [{ label: node.inputSource.title }] : [],
        matrixOutputLabels(node) { calls.matrixParse++; return stateModule.parseMatrixState(ctx.findWidget(node, "matrix_json").value).sets.map(row => row.name); },
        sceneWorkflowLoadDepth: 0, activePopupContext: null, sceneTitleSyncNodes: new Set(), sceneLoadedRefreshNodes: new Set(), sceneDownstreamRefreshSources: new Set(),
        clearSceneFitHeightTimer() {}, clearTimeout() {}, invalidatePopupRequests() {}, closeSceneLoraDetails() {},
        closeSceneExpandResources() {}, closeSceneLoraPicker() {}, popupContextReferencesNode: () => false, isSceneExpandNodeName: () => false,
    };
    vm.createContext(ctx);
    for (const name of ["normalizeWeight", "weightForStorage", "itemWeight", "formatWeight", "itemHasPartSelection", "itemHasPartialSelection",
        "itemWeightSuffix", "itemBaseLabel", "stripCountSuffix", "displayCategoryLabel", "itemCategoryKey", "itemKey", "selectedItems", "selectedItemMap",
        "itemSelectionSignature", "savedPromptMatches", "matchedSavedPrompts", "itemsCoveredBySavedPrompts", "uncoveredCategories", "selectedListSections",
        "estimateChipWidth", "estimateChipWidthWithContext", "selectedListLayout", "selectedListLayoutWidth", "selectedListLayoutCacheKey",
        "cachedSelectedListLayout", "selectedListHeight", "selectedListRenderCacheName", "roundedRect", "fitCanvasText", "drawSelectedListContent", "drawSelectedList",
        "sceneWidgetDrawHeight", "sceneWidgetDrawWidth", "sceneWidgetCanvasRatio", "cachedSceneWidgetCanvas",
        "matrixDisplayCacheKey", "compactMatrixLabels", "matrixSectionHeight", "computeMatrixDisplayCache", "matrixDisplayCache", "drawMatrixSection", "drawMatrixList",
        "clearSceneSelectedListLayoutCaches", "clearSceneComputedCaches", "installSceneNodeRemovalCleanup"]) vm.runInContext(functionSource(name), ctx);
    const item = (label, weight = 1.1, id = "one") => ({ id, label, prompt: label, category_path: ["Canvas"], category_key: "Canvas", category_label: "Canvas", weight });
    const selection = (label, weight = 1.1, id) => JSON.stringify({ version: 1, categories: { Canvas: [item(label, weight, id)] } });
    const node = { size: [360, 900], widgets: [{ name: "positive_json", value: selection("alpha") }, { name: "negative_json", value: selection("omega", 1.2, "negative") }], properties: {} };
    const outer = textContext();
    const draw = (role = "positive_selected_list", options = {}) => {
        ctx.drawSelectedList(outer, node, 360, 0, 80, { role, stateWidgetName: role === "negative_selected_list" ? "negative_json" : "positive_json", ...options });
        return node[ctx.selectedListRenderCacheName(role)]?.canvas;
    };
    const first = draw(); assert(first.context.texts.includes("alpha:1.1"));
    const negative = draw("negative_selected_list"); assert(negative.context.texts.includes("omega:1.2"));
    const size = [first.width, first.height];
    node.widgets[0].value = selection("bravo", 1.3);
    const changed = draw(); assert.notStrictEqual(changed, first); assert.deepEqual([changed.width, changed.height], size);
    assert(changed.context.texts.includes("bravo:1.3"), "same-size direct text/weight edits repaint the raster, not just the layout");
    assert.strictEqual(node.sceneSelectedListNegativeRenderCache.canvas, negative, "positive changes preserve the negative raster");
    node.widgets[1].value = selection("theta", 1.4, "negative");
    assert(draw("negative_selected_list").context.texts.includes("theta:1.4"));
    assert.strictEqual(node.sceneSelectedListPositiveRenderCache.canvas, changed, "negative changes preserve the positive raster");
    ctx.savedPrompts = [{ id: "saved", name: "Saved First", items: [item("bravo", 1.3)] }];
    ctx.clearSceneSelectedListLayoutCaches();
    assert(draw().context.texts.includes("Saved First"));
    const priorCatalog = ctx.savedPrompts;
    ctx.savedPrompts = [{ id: "saved", name: "Saved Next", items: [item("bravo", 1.3)] }];
    const inactiveLayout = node.sceneSelectedListLayoutCache;
    ctx.clearSceneSelectedListLayoutCaches();
    assert.strictEqual(node.sceneSelectedListLayoutCache, inactiveLayout, "the hidden graph is lazily invalidated by a scalar catalog revision");
    assert(draw().context.texts.includes("Saved Next"), "replacement saved catalogs invalidate headings despite unchanged selection JSON");
    assert(!Object.values(node.sceneSelectedListLayoutCache.get("positive_json").cacheKey).includes(priorCatalog), "descriptors retain no old whole-catalog array");
    ctx.savedPrompts = null; ctx.clearSceneSelectedListLayoutCaches();
    assert(!draw().context.texts.includes("Saved Next"), "catalog reset invalidates hidden layouts before a reload request succeeds");
    ctx.savedPrompts = [];
    ctx.clearSceneSelectedListLayoutCaches();
    const external = stateModule.parseSelectionState(selection("cello", 1.3));
    assert(draw("positive_selected_list", { state: external }).context.texts.includes("cello:1.3"));
    external.categories.Canvas[0].label = "zebra";
    assert(draw("positive_selected_list", { state: external }).context.texts.includes("zebra:1.3"), "mutable external state never reuses an obsolete raster");
    const sections = [{ title: "Custom", type: "category", items: [item("delta", 1.5)] }];
    assert(draw("positive_selected_list", { sections }).context.texts.includes("delta:1.5"));
    sections[0].items[0].label = "other";
    assert(draw("positive_selected_list", { sections }).context.texts.includes("other:1.5"));
    assert(draw().context.texts.includes("bravo:1.3"), "returning from explicit sections/state restores the widget's own raster");
    node.size[0] = 361; assert.notStrictEqual(draw(), changed, "width changes rebuild the corresponding layout and raster");
    const largeSelection = JSON.stringify({ version: 1, categories: { Canvas: Array.from({ length: 500 }, (_, index) => item(`tag-${index}`, 1.1, `id-${index}`)) } });
    node.widgets[0].value = largeSelection;
    const warm = ctx.cachedSelectedListLayout(node, 349, { stateWidgetName: "positive_json" });
    calls.stringify = calls.selectionParse = calls.matrixParse = 0;
    const selectionStart = performance.now();
    for (let index = 0; index < 1000; index++) assert.strictEqual(ctx.cachedSelectedListLayout(node, 349, { stateWidgetName: "positive_json" }), warm);
    const selectionWarm1000ms = Number((performance.now() - selectionStart).toFixed(2));
    assert.deepEqual(calls, { stringify: 0, selectionParse: 0, matrixParse: 0 }, "warm selected layouts perform no serialization or parsing");
    assert.strictEqual(ctx.selectedListLayoutCacheKey(node, 349, { stateWidgetName: "positive_json" }), node.sceneSelectedListLayoutCache.get("positive_json").cacheKey);
    const rawMatrix = label => stateModule.serializeMatrixState({ version: 1, sets: Array.from({ length: 30 }, (_, index) => ({
        ...stateModule.createMatrixLine(`${label}-${index}`), positive_json: largeSelection,
    })) });
    const matrix = { size: [340, 900], mode: 0, scenePromptRevision: 0, inputLink: "link-a", inputSource: { id: 1, mode: 0, scenePromptRevision: 0, title: "Source A" },
        widgets: [{ name: "matrix_json", value: rawMatrix("before") }], properties: {} };
    const cachedState = stateModule.parseMatrixState(matrix.widgets[0].value);
    cachedState.sets.forEach(row => { row.enabled = false; });
    let lineParses = 0;
    const countContext = { Set, readMatrixState: () => cachedState,
        normalizeMatrixLine(value) { lineParses++; return stateModule.parseMatrixLine(value); } };
    vm.createContext(countContext);
    for (const name of ["matrixConfiguredLineCount", "matrixLinesForNode"]) vm.runInContext(functionSource(name), countContext);
    for (let index = 0; index < 10; index++) {
        assert.equal(countContext.matrixConfiguredLineCount(matrix), 30);
        assert.equal(countContext.matrixLinesForNode(matrix).length, 0);
    }
    assert.equal(lineParses, 0, "counting validated rows and skipping disabled rows never reparses their large selections");
    cachedState.sets[0].enabled = true;
    cachedState.sets.push(cachedState.sets[0]);
    const enabled = countContext.matrixLinesForNode(matrix);
    assert.equal(enabled.length, 1, "enabled row IDs still deduplicate");
    assert.notStrictEqual(enabled[0], cachedState.sets[0], "enabled rows remain independent editable copies");
    enabled[0].positive_parts.push("local-edit");
    assert.equal(cachedState.sets[0].positive_parts.length, 0, "editing an output copy never changes the cached state");
    ctx.drawMatrixList(outer, matrix, 340, 0, 200);
    const matrixWarm = ctx.matrixDisplayCache(matrix, 340), matrixRaster = matrix.sceneMatrixRenderCache.canvas;
    calls.stringify = calls.selectionParse = calls.matrixParse = 0;
    const matrixStart = performance.now();
    for (let index = 0; index < 1000; index++) assert.strictEqual(ctx.matrixDisplayCache(matrix, 340), matrixWarm);
    const matrixWarm1000ms = Number((performance.now() - matrixStart).toFixed(2));
    assert.deepEqual(calls, { stringify: 0, selectionParse: 0, matrixParse: 0 }, "warm Matrix display checks never copy or parse its large JSON");
    assert.strictEqual(ctx.matrixDisplayCacheKey(matrix, 340), matrixWarm.cacheKey);
    matrix.widgets[0].value = rawMatrix("after"); ctx.drawMatrixList(outer, matrix, 340, 0, 200);
    assert.notStrictEqual(matrix.sceneMatrixRenderCache.canvas, matrixRaster);
    assert(matrix.sceneMatrixRenderCache.canvas.context.texts.includes("after-0"));
    const matrixChange = mutate => { const old = ctx.matrixDisplayCache(matrix, 340); mutate(); const next = ctx.matrixDisplayCache(matrix, 340);
        assert.notStrictEqual(next, old); assert.equal(matrix.sceneMatrixRenderCache, null); };
    matrixChange(() => { matrix.inputSource = { ...matrix.inputSource, title: "Same ID, new source" }; });
    matrixChange(() => { matrix.inputSource.mode = 4; });
    matrixChange(() => { matrix.inputSource.scenePromptRevision++; });
    matrixChange(() => { matrix.mode = 2; });
    matrixChange(() => { matrix.scenePromptRevision++; });
    matrixChange(() => { matrix.inputLink = "link-b"; });
    const beforeWidth = ctx.matrixDisplayCache(matrix, 340); assert.notStrictEqual(ctx.matrixDisplayCache(matrix, 341), beforeWidth);
    assert.equal(matrix.sceneMatrixRenderCache, null);
    const rasterNode = {}; let paints = 0;
    const raster = ctx.cachedSceneWidgetCanvas(rasterNode, "raster", 30, 40, () => { paints++; });
    assert.equal(ctx.cachedSceneWidgetCanvas(rasterNode, "raster", 2000, 2000, () => { paints++; }), null);
    assert.equal(rasterNode.raster, null, "direct oversized drawing releases a previously retained raster");
    assert.notStrictEqual(ctx.cachedSceneWidgetCanvas(rasterNode, "raster", 30, 40, () => { paints++; }), raster);
    assert.equal(paints, 2, "returning below the threshold builds a fresh raster");
    const saved = JSON.stringify({ widgets: node.widgets, properties: node.properties });
    ctx.clearSceneComputedCaches(node);
    assert.equal(node.sceneSelectedListLayoutCache, null); assert.equal(node.sceneSelectedListPositiveRenderCache, null); assert.equal(node.sceneSelectedListNegativeRenderCache, null);
    assert.equal(JSON.stringify({ widgets: node.widgets, properties: node.properties }), saved);
    draw(); ctx.installSceneNodeRemovalCleanup(node, "ScenePrompter"); node.onRemoved();
    assert.equal(node.sceneSelectedListLayoutCache, null); assert.equal(node.sceneSelectedListPositiveRenderCache, null);
    ctx.drawMatrixList(outer, matrix, 340, 0, 200); ctx.installSceneNodeRemovalCleanup(matrix, "SceneMatrix"); matrix.onRemoved();
    assert.equal(matrix.sceneMatrixDisplayCache, null); assert.equal(matrix.sceneMatrixRenderCache, null);
    assert(!source.includes("function matrixSourceCacheKey("), "the unused Matrix source-key builder is removed");
    console.log("Selected/Matrix current descriptors, same-size raster repaint, role ownership, external state, lifecycle and oversized release passed",
        JSON.stringify({ selectionBytes: largeSelection.length, matrixBytes: matrix.widgets[0].value.length, selectionWarm1000ms, matrixWarm1000ms, warmStringifies: 0 }));
}

testCurrentDisplayAndRasterOwnership().catch(error => { console.error(error); process.exitCode = 1; });
