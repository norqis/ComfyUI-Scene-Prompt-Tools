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
    isSceneNodeMuted() { return false; }, isSceneNodeBypassed() { return false; },
    scenePromptInputSource(node) { return node.upstream || null; },
    isScenePromptNode(node) { return node.kind === "prompt"; },
    scenePromptTitle(node) { return node.title; },
    isPromptMatrixNode(node) { return node.kind === "matrix"; },
    matrixLinesForNode(node) { return node.rows || []; },
    matrixConfiguredLineCount(node) { return node.configured || 0; },
    matrixLineLabel(row) { return row.label; },
    isScenePathNode() { return false; }, isScenePromptCounterNode() { return false; }, isSceneEmptyLatentNode() { return false; },
    isScenePromptQueueNode(node) { return node.kind === "queue"; },
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
vm.createContext(previewContext);
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

const displayContext = {
    Math, JSON,
    scenePromptQueueDisplayCacheKey() { return "cache"; },
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
vm.createContext(displayContext);
for (const name of ["computeScenePromptQueueDisplayCache", "refreshScenePromptQueueNode"]) vm.runInContext(functionSource(name), displayContext);
const queueNode = { size: [360, 100], setDirtyCanvas() {} };
assert.equal(displayContext.computeScenePromptQueueDisplayCache(queueNode).entries.length, 160, "Queue cache keeps only bounded preview entries");
displayContext.refreshScenePromptQueueNode(queueNode, { fitHeight: true });

let createdImages = 0;
const saveContext = {
    Set, Map, JSON,
    SCENE_SAVE_PREVIEW_LIMIT: 1,
    SCENE_SAVE_IMAGE_NODE_NAMES: new Set(["SceneSaveImage"]),
    sceneNodeFromEvent(detail) { return detail.node; },
    imageRefKey(ref) { return ref.filename; }, previewUrl(ref) { return ref.filename; },
    Image: class { constructor() { createdImages += 1; } },
    trimSceneSavePreviews(node) {
        while (node.imgs.length > 1) {
            const old = node.imgs.shift();
            node.scenePreviewKeys.delete(old.scenePreviewKey);
            node.scenePreviewImages.delete(old.scenePreviewKey);
        }
        node.imageIndex = node.imgs.length - 1;
    },
    app: { graph: { setDirtyCanvas() {} }, canvas: { setDirty() {} } },
};
vm.createContext(saveContext);
vm.runInContext(functionSource("appendSceneSavePreview"), saveContext);
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

console.log("Scene Prompt UI audit behavior tests passed.");
