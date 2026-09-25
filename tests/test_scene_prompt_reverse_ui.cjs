const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    assert.notEqual(bodyStart, -1, `Missing function body: ${name}`);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

assert.match(source, /SCENE_PROMPT_REVERSE_NODE_NAMES/u);
assert.match(source, /ScenePromptReverse: "Scene Prompt Reverse"/u);
assert.match(source, /reverse_scope: "対象"/u);
assert.match(source, /SCENE_PLAN_NODE_CLASS_TYPES[\s\S]*"ScenePromptReverse"/u);
assert.match(source, /SCENE_SOURCE_NODE_CLASS_TYPES[\s\S]*"ScenePromptReverse"/u);
assert.match(functionSource("isScenePromptSourceNode"), /isScenePromptReverseNode\(node\)/u);
assert.match(functionSource("scenePromptSourceLocalCacheKey"), /type: "reverse"/u);
assert.match(functionSource("scenePromptSourceLocalCacheKey"), /reverse_scope: scenePromptReverseScope\(node\)/u);
assert.match(functionSource("scenePromptStats"), /isScenePromptReverseNode\(node\)/u);
assert.match(functionSource("scenePromptPreviewEntries"), /isScenePromptReverseNode\(node\)/u);
assert.match(functionSource("scenePromptStats"), /isSceneApplyModelNode\(node\) \|\| isSceneApplyLoraNode\(node\)/u);
assert.match(functionSource("scenePromptPreviewEntries"), /isSceneApplyModelNode\(node\) \|\| isSceneApplyLoraNode\(node\)/u);
assert.match(functionSource("scenePresetStats"), /SceneApplyModel.*SceneApplyLora/u);
assert.match(functionSource("scenePromptSourceLocalCacheKey"), /apply_model.*apply_lora/su);
assert.match(functionSource("hideSceneUtilityWidgets"), /SCENE_PROMPT_REVERSE_NODE_NAMES/u);
assert.match(functionSource("attachSceneUtilityNode"), /installScenePromptReverseWidgetSyncHandlers/u);
assert.match(source, /SCENE_PLAN_NODE_CLASS_TYPES[\s\S]*"SceneApplyModel"[\s\S]*"SceneApplyLora"/u);
assert.match(source, /SCENE_SOURCE_NODE_CLASS_TYPES[\s\S]*"SceneApplyModel"[\s\S]*"SceneApplyLora"/u);
assert.match(source, /strength_model: "モデル強度"/u);
assert.match(source, /strength_clip: "CLIP強度"/u);
assert.match(functionSource("attachSceneNode"), /SCENE_APPLY_MODEL_NODE_NAMES/u);
assert.match(functionSource("attachSceneNode"), /SCENE_APPLY_LORA_NODE_NAMES/u);

const context = {
    String,
    findWidget(node, name) {
        return node.widgets.find((widget) => widget.name === name);
    },
};
vm.createContext(context);
vm.runInContext(functionSource("scenePromptReverseScope"), context);
assert.equal(context.scenePromptReverseScope({ widgets: [{ name: "reverse_scope", value: "直前のノード" }] }), "直前のノード");
assert.equal(context.scenePromptReverseScope({ widgets: [{ name: "reverse_scope", value: "全てのノード" }] }), "全てのノード");
assert.equal(context.scenePromptReverseScope({ widgets: [] }), "全てのノード");

const applyContext = {
    JSON, Set, Map,
    isScenePromptNode(node) { return node.kind === "prompt"; },
    isPromptMatrixNode() { return false; }, isScenePathNode() { return false; },
    isScenePromptMergeNode() { return false; }, isScenePromptReverseNode() { return false; }, isScenePromptDeleteNode() { return false; },
    isScenePromptCounterNode() { return false; }, isScenePromptQueueNode() { return false; },
    isSceneEmptyLatentNode() { return false; }, isScenePresetReferenceNode() { return false; },
    isScenePromptCallbackNode() { return false; },
    isSceneApplyModelNode(node) { return node.kind === "apply_model"; },
    isSceneApplyLoraNode(node) { return node.kind === "apply_lora"; },
    scenePromptInputSource(node) { return node.upstream || null; },
    scenePromptSourceCacheKey(node) { return node.id; },
    sceneNodeMode() { return 0; }, nodeClassName(node) { return node.kind || ""; },
    sceneNodeRevision() { return 0; }, linkedInputKey(node) { return node.id; },
    scenePromptLineageKey(node) { return node.lineage || node.id; },
    isSceneNodeMuted() { return false; }, isSceneNodeBypassed() { return false; },
    sceneBypassInputSource() { return null; },
    emptyScenePromptStats() { return { rows: 0, total: 0, totalImages: 0, unsetBatches: 0 }; },
    sceneStatsSeed() { return { rows: 1, total: 1, totalImages: 1, unsetBatches: 1 }; },
    sceneStatsResult(value) { return value; },
};
vm.createContext(applyContext);
for (const name of ["scenePromptSourceLocalCacheKey", "scenePromptStats"]) vm.runInContext(functionSource(name), applyContext);
const applyDirect = { id: "model-direct", kind: "apply_model" };
const applyLeft = { id: "lora-left", kind: "apply_lora", upstream: { id: "left", kind: "prompt", lineage: "left" } };
const applyRight = { id: "lora-right", kind: "apply_lora", upstream: { id: "right", kind: "prompt", lineage: "right" } };
assert.deepEqual(JSON.parse(JSON.stringify(applyContext.scenePromptStats(applyDirect))), { rows: 1, total: 1, totalImages: 1, unsetBatches: 1 }, "a direct Apply Model starts one Scene plan");
assert.deepEqual(JSON.parse(JSON.stringify(applyContext.scenePromptStats(applyLeft))), { rows: 1, total: 1, totalImages: 1, unsetBatches: 1 }, "Apply LoRA passes its upstream Scene plan through");
assert.notEqual(applyContext.scenePromptSourceLocalCacheKey(applyLeft), applyContext.scenePromptSourceLocalCacheKey(applyRight), "distinct Apply LoRA branches keep distinct cache keys");

console.log("Scene Prompt Reverse UI tests passed.");
