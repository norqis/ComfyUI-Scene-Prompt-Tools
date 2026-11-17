const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

assert.match(source, /ScenePrompterExpand/u);
assert.match(source, /current_index: "生成番号"/u);
assert.match(source, /seed_base: "開始シード"/u);
assert.match(source, /counter_position: "連番の位置"/u);

function functionSource(name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed function: ${name}`);
}

const context = {
    Set,
    SCENE_MODEL_MODES: ["Illustrious", "Anima", "NoobAI", "Pony"],
    SCENE_SAVE_IMAGE_NODE_NAMES: new Set(["SceneSaveImage"]),
    SCENE_APPLY_LORA_NODE_NAMES: new Set(["SceneApplyLora"]),
    isSceneExpandNodeName(nodeName) { return nodeName === "ScenePrompterExpand"; },
    SCENE_PROMPT_TO_TEXT_NODE_NAMES: new Set(["ScenePromptToText"]),
    SCENE_PROMPT_DELETE_NODE_NAMES: new Set(["ScenePromptDelete"]),
    SCENE_EMPTY_LATENT_NODE_NAMES: new Set(),
    hideWidget(widget) { widget.hidden = true; },
    showWidget(widget) { widget.hidden = false; },
};

async function testPathFolderModesAndRequestedTimestamp() {
    const clickedAt = "2026_1117_235959";
    const later = "2026_1118_000001";
    let now = clickedAt;
    let paint;
    const graph = { _nodes: [] };
    const calls = [];
    const ctx = {
        Set, Map, Promise, JSON,
        app: { graph }, api: { clientId: "fixture-client", async fetchApi(_url, options) {
            calls.push(JSON.parse(options.body)); return { ok: true };
        } },
        sceneBatchRunId: () => now, sceneBatchPlanId: () => "opaque-plan", sceneBatchSeedBase: () => 9,
        sceneBatchRun: null, sceneBatchDetachedRuns: new Map(), sceneBatchFinalizingRuns: new Set(),
        sceneBatchRunsById: new Map(), sceneBatchPendingRuns: [],
        sceneBatchRunForNode: () => null, sceneBatchRunStatus: () => "", sceneBatchNodeRunId: () => "",
        sceneNodeHasCurrentOwner: () => true, waitForModalPaint: () => new Promise(resolve => { paint = resolve; }),
        findSceneWidget: () => null, updateSceneExpandButton() {}, resetSceneExpandRunControls() {},
        syncSceneNodeModes() {}, syncAllScenePromptNames() {},
        sceneExpandCounts() { now = later; return { totalBatches: 3 }; },
        captureRandomizedSamplerSeedTargets: () => [], sceneGPUController: { snapshot: () => ({}) },
        isScenePresetReferenceNode: () => false, createSceneBatchPromptSnapshot: async () => ({ output: {} }),
        setWidgetValue() {}, clearSceneSavePreviews() {}, refreshSceneBatchRunNode() {},
        prepareSceneBatchRunSnapshot() {}, queueNextSceneBatchItem() {},
        showSceneBatchError(_message, error) { throw error; },
        findWidget: (node, name) => node.widgets.find(widget => widget.name === name),
        scenePrimitiveInputValue: (node, name) => node.linked?.[name],
        readApiJson: async () => ({ run_handle: "fixture-handle" }),
        scenePresetReferenceIdsForExpand: () => [], clearScenePresetReferenceErrors() {},
    };
    vm.createContext(ctx);
    for (const name of ["scenePathTitle", "scenePathLabel", "hideScenePathWidgets", "installScenePathWidgetSyncHandlers", "sceneRunTargetNodes", "applySceneRunHandle", "prepareSceneRunContext", "resolveScenePresetsForRun", "createSceneBatchRun", "requestSceneBatchRun", "startSceneBatchRun"])
        vm.runInContext(functionSource(name), ctx);
    const node = { id: 1, graph, widgets: [] };
    const pending = ctx.requestSceneBatchRun(node);
    now = later;
    paint();
    await pending;
    const run = ctx.sceneBatchRun;
    assert.equal(run.pathTimestamp, clickedAt, "paint and count computation cannot advance the click timestamp");
    assert.equal(run.runId, clickedAt + "__opaque-plan");
    const snapshot = { output: { "2": { class_type: "ScenePath", inputs: {} } } };
    await ctx.resolveScenePresetsForRun(run, snapshot, 3);
    assert.equal(calls[0].path_timestamp, clickedAt);
    assert.equal(snapshot.output["2"].inputs.run_handle, "fixture-handle", "standalone Path gets a run handle");
    await ctx.resolveScenePresetsForRun(run, snapshot, 3);
    assert.equal(calls[1].path_timestamp, clickedAt, "later preparation retains the explicit run timestamp");
    now = clickedAt;
    const pendingQueued = ctx.requestSceneBatchRun({ id: 2, graph, widgets: [] });
    now = later;
    paint();
    await pendingQueued;
    const queued = ctx.sceneBatchPendingRuns[0];
    assert.equal(queued.pathTimestamp, clickedAt);
    assert.equal(ctx.sceneBatchRun, run, "a queued request cannot replace the active run");
    await ctx.prepareSceneRunContext(snapshot);
    assert.equal(calls[2].path_timestamp, later, "ordinary Run captures a fresh request timestamp");
    assert.equal(ctx.sceneRunTargetNodes({ output: { p: { class_type: "ScenePath" }, x: { class_type: "KSampler" } } }).length, 1);
    let refreshes = 0;
    ctx.hideWidget = widget => { widget.hidden = true; };
    ctx.showWidget = widget => { widget.hidden = false; };
    ctx.clearSceneComputedCaches = () => { refreshes++; };
    ctx.refreshDownstreamSceneNodes = () => {};
    const pathNode = { title: "てすと", widgets: [{ name: "path_name", value: "old" }, { name: "path_mode", value: "フォルダに分ける" },
        { name: "folder_name_mode", value: "ノード名" }, { name: "run_handle", value: "" }] };
    // Native configure assigns the two stored legacy values; the new optional combo keeps its default.
    ["legacy", "フォルダに分ける"].forEach((value, index) => { pathNode.widgets[index].value = value; });
    assert.equal(ctx.scenePathLabel(pathNode), "てすと");
    ctx.hideScenePathWidgets(pathNode);
    assert.deepEqual(pathNode.widgets.map(widget => widget.hidden), [true, false, false, true]);
    pathNode.widgets[2].value = "ノード名+タイムスタンプ";
    assert.equal(ctx.scenePathLabel(pathNode), "てすと〈実行時刻〉");
    pathNode.linked = { folder_name_mode: "タイムスタンプ" };
    assert.equal(ctx.scenePathLabel(pathNode), "〈実行時刻〉", "linked combo takes precedence");
    ctx.installScenePathWidgetSyncHandlers(pathNode);
    pathNode.widgets[2].callback();
    assert.equal(refreshes, 1);
}
testPathFolderModesAndRequestedTimestamp().catch(error => { console.error(error); process.exitCode = 1; });
vm.createContext(context);
vm.runInContext(functionSource("hideSceneUtilityWidgets"), context);

const widgets = [
    { name: "path" },
    { name: "metadata_mode" },
    { name: "expand_preset_contents" },
    { name: "scene_info" },
];
context.hideSceneUtilityWidgets({ widgets }, "SceneSaveImage");

assert.equal(widgets[0].hidden, false);
assert.equal(widgets[1].hidden, false);
assert.equal(widgets[2].hidden, false);
assert.equal(widgets[3].hidden, true);

const toTextWidgets = [
    { name: "scope" },
    { name: "model_mode", value: "Illustrious" },
    { name: "current_index" },
    { name: "seed_base" },
];
context.hideSceneUtilityWidgets({ widgets: toTextWidgets }, "ScenePromptToText");
assert.deepEqual(toTextWidgets.map((widget) => widget.hidden), [false, true, true, true],
    "To Text shows only scope and hides a legacy model selector");

const expandWidgets = [
    { name: "timestamp_dir" },
    { name: "prefix" },
    { name: "counter_position" },
    { name: "replace_underscores" },
    { name: "convert_anima_weights" },
    { name: "model_mode" },
    { name: "current_index" },
];
context.hideSceneUtilityWidgets({ widgets: expandWidgets }, "ScenePrompterExpand");
assert.equal(expandWidgets[0].hidden, false);
assert.equal(expandWidgets[1].hidden, false);
assert.equal(expandWidgets[2].hidden, false);
assert.equal(expandWidgets[3].hidden, false);
assert.equal(expandWidgets[4].hidden, false);
assert.equal(expandWidgets[5].hidden, false);
assert.equal(expandWidgets[6].hidden, true);

const loraWidgets = [
    { name: "lora_name" },
    { name: "strength_model" },
    { name: "strength_clip" },
    { name: "model_mode" },
    { name: "scene_prompt" },
];
context.hideSceneUtilityWidgets({ widgets: loraWidgets }, "SceneApplyLora");
assert.deepEqual(loraWidgets.map((widget) => widget.hidden), [true, false, false, false, true]);

vm.runInContext(functionSource("sceneExpandConfigureValues"), context);
for (const name of ["SCENE_LORA_STORED_WIDGET_NAMES", "SCENE_LORA_DISPLAY_WIDGET_NAMES"]) {
    vm.runInContext(source.match(new RegExp(`const ${name} = \\[.*?\\];`, "u"))[0], context);
}
vm.runInContext(functionSource("sceneLoraConfiguredValues"), context);
for (const mode of context.SCENE_MODEL_MODES) {
    const current = { widgets_values: [0, "", 7, false, "", "最後", mode, false, true, "停止", true] };
    assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(current))), current);
    const legacy = { widgets_values: [0, "", 7, false, "", mode, 13, "停止", true] };
    assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(legacy).widgets_values)),
        [0, "", 7, false, "", "最後", mode, mode === "Anima", mode === "Anima", "停止", true]);
    for (const values of [
        ["NoobAI.safetensors", 0.8, 0.6, mode, "positive", "negative", "{}", "{}", ""],
        [mode, 0.8, 0.6, "positive", "negative", "NoobAI.safetensors", "{}", "{}", ""],
    ]) {
        const restored = context.sceneLoraConfiguredValues({ widgets_values: values });
        assert.equal(restored.model_mode, mode, "saved model stays explicit, independent of filename");
        assert.equal(restored.lora_name, "NoobAI.safetensors");
        assert.equal(restored.positive, "positive");
        assert.equal(restored.negative, "negative");
        assert.equal(restored.strength_model, 0.8);
    }
}
for (const seed of [0, 42]) {
    const literal = seed === 0;
    const legacyReplay = {
        widgets_values: [0, "run", seed, false, "prefix", null, 13, "停止", literal],
        inputs: [{ name: "model_mode", link: 77 }],
    };
    const migrated = context.sceneExpandConfigureValues(legacyReplay);
    assert.equal(migrated.widgets_values[2], seed);
    assert.equal(migrated.widgets_values[10], literal, "linked legacy model replay keeps the literal seed flag after migration");
    assert.equal(migrated.inputs, legacyReplay.inputs);
    assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migrated))), JSON.parse(JSON.stringify(migrated)));
}
const legacyAnima = {
    widgets_values: [15, "saved-run", 7, true, "prefix", "Anima", 13, "停止", true],
};
const migratedAnima = context.sceneExpandConfigureValues(legacyAnima);
assert.deepEqual(JSON.parse(JSON.stringify(migratedAnima.widgets_values)), [
    15, "saved-run", 7, true, "prefix", "最後", "Anima", true, true, "停止", true,
]);
assert.deepEqual(legacyAnima.widgets_values, [15, "saved-run", 7, true, "prefix", "Anima", 13, "停止", true]);
assert.deepEqual(
    JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migratedAnima).widgets_values)),
    JSON.parse(JSON.stringify(migratedAnima.widgets_values)),
    "migration is idempotent",
);
assert.deepEqual(
    JSON.parse(JSON.stringify(context.sceneExpandConfigureValues({ widgets_values: [15, "saved-run", 7, true, "prefix"] }).widgets_values)),
    [15, "saved-run", 7, true, "prefix", "最後", "Illustrious", false, false],
    "pre-model workflows receive explicit false conversion options",
);
assert.deepEqual(
    JSON.parse(JSON.stringify(context.sceneExpandConfigureValues({ widgets_values: [15, "saved-run", 7, true, "prefix", true, false, 13, "停止", true] }).widgets_values)),
    [15, "saved-run", 7, true, "prefix", "最後", "Illustrious", true, false, "停止", true],
    "existing conversion and callback values stay aligned",
);
assert.deepEqual(
    JSON.parse(JSON.stringify(context.sceneExpandConfigureValues({ widgets_values: [] }).widgets_values)),
    [],
    "an empty legacy widget list stays untouched",
);
for (const timeout of [0, 13, false, true, null]) {
    for (const controls of [["Anima"], [true, true], ["先頭", true, true]]) {
        const original = [15, "saved-run", 7, true, "prefix", ...controls, timeout, "停止", true];
        const migrated = context.sceneExpandConfigureValues({ widgets_values: original });
        assert.deepEqual(JSON.parse(JSON.stringify(migrated.widgets_values)), [
            15, "saved-run", 7, true, "prefix", controls[0] === "先頭" ? "先頭" : "最後", controls[0] === "Anima" ? "Anima" : "Illustrious", true, true, "停止", true,
        ], `legacy layout ${controls.length} removes timeout ${timeout} without shifting failure mode or literal seed`);
        assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migrated))), JSON.parse(JSON.stringify(migrated)));
        assert.equal(original.at(-3), timeout, "migration does not mutate the saved values");
    }
}
for (const legacyTimeout of [false, true]) {
    const original = [0, "", 0, true, "prefix", "最後", false, false, ...(legacyTimeout ? [null] : []), null, true];
    const migrated = context.sceneExpandConfigureValues({ widgets_values: original });
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.widgets_values)), [0, "", 0, true, "prefix", "最後", "Illustrious", false, false, null, true],
        `${legacyTimeout ? "legacy timeout and " : "current "}failure input placeholders retain the literal seed slot`);
    assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migrated))), JSON.parse(JSON.stringify(migrated)));
    assert.equal(original.length, legacyTimeout ? 11 : 10, "the original null input layout is never mutated");
    const linkedCounter = { inputs: [{ name: "counter_position", link: 42 }], widgets_values: [...original] };
    linkedCounter.widgets_values[5] = null;
    const migratedCounter = context.sceneExpandConfigureValues(linkedCounter);
    assert.deepEqual(JSON.parse(JSON.stringify(migratedCounter.widgets_values)), [0, "", 0, true, "prefix", null, "Illustrious", false, false, null, true],
        "a linked counter placeholder identifies the counter schema without inserting old options");
    assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migratedCounter))), JSON.parse(JSON.stringify(migratedCounter)));
}

for (const [values, inputs, expected] of [
    [[9, "run", 7, false, "p", "最後", true, false, "停止", true], [], [9, "run", 7, false, "p", "最後", "Illustrious", true, false, "停止", true]],
    [[9, "run", 7, false, "p", "最後", null, false, "停止", true], [{ name: "replace_underscores", link: 2 }], [9, "run", 7, false, "p", "最後", "Illustrious", null, false, "停止", true]],
    [[9, "run", 7, false, "p", "Illustrious", 13, "停止", true], [], [9, "run", 7, false, "p", "最後", "Illustrious", false, false, "停止", true]],
    [[9, "run", 7, false, "p", null, 13, "停止", true], [{ name: "model_mode", link: 77, widget: { name: "model_mode" } }], [9, "run", 7, false, "p", "最後", null, false, false, "停止", true]],
    [[9, "run", 7, false, "p", "先頭", "Anima", false, true, "停止", true], [], [9, "run", 7, false, "p", "先頭", "Anima", false, true, "停止", true]],
    [[9, "run", 7, false, "p", "先頭", null, true, false, "停止", true], [{ name: "model_mode", link: 77 }], [9, "run", 7, false, "p", "先頭", null, true, false, "停止", true]],
]) {
    const config = { widgets_values: values, inputs };
    const before = JSON.stringify(config);
    const migrated = context.sceneExpandConfigureValues(config);
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.widgets_values)), expected);
    assert.equal(migrated.inputs, inputs, "input definitions and links are preserved");
    assert.equal(JSON.stringify(config), before, "migration never mutates the saved config");
    assert.deepEqual(JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migrated))), JSON.parse(JSON.stringify(migrated)));
}
