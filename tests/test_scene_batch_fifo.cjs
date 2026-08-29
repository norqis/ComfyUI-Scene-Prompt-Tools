const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
    path.join(__dirname, "..", "web", "scene_prompt_ui.js"),
    "utf8",
);

function functionSource(name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);

    const bodyStart = source.indexOf(") {", start);
    assert.notEqual(bodyStart, -1, `Missing function body: ${name}`);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        const character = source[index];
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Unclosed function: ${name}`);
}

const context = {
    sceneBatchRun: null,
    sceneBatchRunsById: new Map(),
    sceneBatchDetachedRuns: new Map(),
    sceneBatchPendingRuns: [],
    activated: [],
    queuedPrompts: [],
    api: {
        async queuePrompt(_number, prompt) {
            context.queuedPrompts.push(structuredClone(prompt));
            return { prompt_id: `prompt-${context.queuedPrompts.length}` };
        },
    },
    acceptSceneBatchPrompt() {},
    findWidget(node, name) {
        return node?.widgets?.find((widget) => widget.name === name);
    },
    clearSceneSavePreviews() {},
    refreshSceneBatchRunNode() {},
    resetSceneExpandRunControls() {},
    updateSceneExpandButton() {},
    cancelSceneBatchRunPreparation() {},
    sceneNodeForRun() {
        return null;
    },
    prepareSceneBatchRunSnapshot() {},
    queueNextSceneBatchItem() {
        context.activated.push(context.sceneBatchRun.runId);
    },
    releaseSceneRunHandle() {},
};
vm.createContext(context);
for (const name of [
    "sceneBatchNodeRunId",
    "sceneBatchRunForNode",
    "cancelPendingSceneBatchRun",
    "activateNextSceneBatchRun",
    "cloneScenePromptPayload",
    "queueSingleScenePrompt",
]) {
    vm.runInContext(functionSource(name), context);
}

function node(id, runId) {
    return { id, widgets: [{ name: "run_id", value: runId }] };
}

const runA = { nodeId: 41, runId: "tab-a" };
const runB = { nodeId: 41, runId: "tab-b" };
const runC = { nodeId: 41, runId: "tab-c" };
const tabA = node(41, runA.runId);
const tabBIdle = node(41, "");
const tabBQueued = node(41, runB.runId);
const tabCQueued = node(41, runC.runId);

context.sceneBatchRun = runA;
context.sceneBatchRunsById.set(runA.runId, runA);
assert.equal(context.sceneBatchRunForNode(tabA), runA);
assert.equal(context.sceneBatchRunForNode(tabBIdle), null);

context.sceneBatchRunsById.set(runB.runId, runB);
context.sceneBatchRunsById.set(runC.runId, runC);
assert.equal(context.sceneBatchRunForNode(tabBQueued), runB);
assert.equal(context.sceneBatchRunForNode(tabCQueued), runC);

context.sceneBatchPendingRuns.push(runB, runC);
context.activateNextSceneBatchRun();
assert.equal(context.sceneBatchRun, runA);
assert.deepEqual(context.activated, []);

context.cancelPendingSceneBatchRun(runB);
assert.equal(context.sceneBatchRun, runA);
assert.deepEqual(context.sceneBatchPendingRuns, [runC]);
assert.equal(context.sceneBatchRunsById.has(runB.runId), false);
assert.equal(context.sceneBatchRunsById.has(runC.runId), true);

context.sceneBatchPendingRuns.unshift(runB);
context.sceneBatchRunsById.set(runB.runId, runB);
context.sceneBatchRun = null;
context.activateNextSceneBatchRun();
assert.equal(context.sceneBatchRun, runB);
assert.deepEqual(context.activated, ["tab-b"]);

context.sceneBatchRun = null;
context.activateNextSceneBatchRun();
assert.equal(context.sceneBatchRun, runC);
assert.deepEqual(context.activated, ["tab-b", "tab-c"]);

async function testQueuedPrefixesStayWithTheirTabs() {
    const promptA = {
        output: { "41": { inputs: { prefix: "tab_a_", current_index: 0 } } },
    };
    const promptB = {
        output: { "41": { inputs: { prefix: "tab_b_", current_index: 0 } } },
    };
    const batchA = {
        nodeId: 41,
        runId: "tab-a",
        nextIndex: 3,
        currentSeed: 101,
        cachedPrompt: context.cloneScenePromptPayload(promptA),
    };
    const batchB = {
        nodeId: 41,
        runId: "tab-b",
        nextIndex: 7,
        currentSeed: 202,
        cachedPrompt: context.cloneScenePromptPayload(promptB),
    };

    promptA.output["41"].inputs.prefix = "edited_a_";
    promptB.output["41"].inputs.prefix = "edited_b_";

    context.sceneBatchRun = batchA;
    await context.queueSingleScenePrompt();
    context.sceneBatchRun = batchB;
    await context.queueSingleScenePrompt();

    assert.equal(context.queuedPrompts[0].output["41"].inputs.prefix, "tab_a_");
    assert.equal(context.queuedPrompts[1].output["41"].inputs.prefix, "tab_b_");
    assert.equal(context.queuedPrompts[0].output["41"].inputs.current_index, 3);
    assert.equal(context.queuedPrompts[1].output["41"].inputs.current_index, 7);

    const waitingPrompt = {
        output: { "41": { inputs: { prefix: "waiting_b_", current_index: 0 } } },
    };
    const waitingBatch = {
        nodeId: 41,
        runId: "waiting-tab-b",
        nextIndex: 0,
        currentSeed: 303,
        firstPromptSnapshot: context.cloneScenePromptPayload(waitingPrompt),
        cachedPrompt: null,
    };
    waitingPrompt.output["41"].inputs.prefix = "edited_while_waiting_";
    context.sceneBatchRunsById.set(waitingBatch.runId, waitingBatch);
    context.sceneBatchPendingRuns.length = 0;
    context.sceneBatchPendingRuns.push(waitingBatch);
    context.sceneBatchRun = batchA;
    context.activateNextSceneBatchRun();
    assert.equal(context.sceneBatchRun, batchA);

    context.sceneBatchRun = null;
    context.activateNextSceneBatchRun();
    assert.equal(context.sceneBatchRun, waitingBatch);
    await context.queueSingleScenePrompt();
    assert.equal(context.queuedPrompts[2].output["41"].inputs.prefix, "waiting_b_");
}

testQueuedPrefixesStayWithTheirTabs()
    .then(testScenePresetResolution)
    .then(testSelectedExpandBranchOnlyQueues)
    .then(testCancelledPresetResolutionReleasesOnce)
    .then(testPresetResolutionKeepsClickFifo)
    .then(testPresetFailureDoesNotQueue)
    .then(testPresetRunCountDisplay)
    .then(testPresetErrorMarksOnlyTargetReference)
    .then(testPresetErrorClearStaysInSelectedBranch)
    .then(testPresetResolveClearsOnlyItsOwnReferences)
    .then(testPresetDisplayCacheStaysPerReference)
    .then(() => console.log("Scene Prompt Expand cross-tab FIFO tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

async function testScenePresetResolution() {
    const presetContext = {
        Map,
        Set,
        Object,
        Array,
        JSON,
        String,
        Number,
        Math,
        scenePresetDisplayGraphs: new Map(),
        MATRIX_DEFAULT_JSON: "{\"version\":1,\"sets\":[]}",
        parseMatrixStateValue(value) {
            if (value == null || !String(value).trim()) {
                return { version: 1, sets: [] };
            }
            const parsed = JSON.parse(String(value));
            if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sets)) {
                throw new Error("Unsupported Scene Matrix schema.");
            }
            return parsed;
        },
        SCENE_PROMPT_QUEUE_INPUT_COUNT: 10,
        clampSceneCount(value, fallback) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
        },
        clearScenePresetReferenceErrors() {},
        async prepareSceneRunContext(_snapshot, expandNodeId) {
            assert.equal(expandNodeId, "10");
            return {
                run_handle: "opaque-run-handle",
                presets: [{ preset_id: "preset-a", revision: 2 }],
                preset_graphs: {
                    "preset-a": {
                        metadata: { sha256: "abc" },
                        api_graph: {
                            output: {
                                "1": { class_type: "ScenePresetInput", inputs: {} },
                                "2": { class_type: "SceneMatrix", inputs: { matrix_json: "{\"version\":1,\"sets\":[{\"enabled\":true},{\"enabled\":true}]}", scene_prompt: ["1", 0] } },
                                "3": { class_type: "ScenePromptCounter", inputs: { count: 3, scene_prompt: ["2", 0] } },
                                "4": { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["3", 0] } },
                            },
                        },
                    },
                },
            };
        },
        releaseSceneRunHandle() {},
        async apiResponse(data, ok = true) {
            return { ok, status: ok ? 200 : 400, async text() { return JSON.stringify(data); } };
        },
        api: {
            async fetchApi(_path, options) {
                const request = JSON.parse(options.body);
                assert.equal(request.run_id, "run-a");
                return presetContext.apiResponse({
                    presets: [{ preset_id: "preset-a", revision: 2 }],
                    preset_graphs: {
                        "preset-a": {
                            metadata: { sha256: "abc" },
                            api_graph: {
                                output: {
                                    "1": { class_type: "ScenePresetInput", inputs: {} },
                                    "2": { class_type: "SceneMatrix", inputs: { matrix_json: "{\"version\":1,\"sets\":[{\"enabled\":true},{\"enabled\":true}]}", scene_prompt: ["1", 0] } },
                                    "3": { class_type: "ScenePromptCounter", inputs: { count: 3, scene_prompt: ["2", 0] } },
                                    "4": { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["3", 0] } },
                                },
                            },
                        },
                    },
                });
            },
        },
    };
    vm.createContext(presetContext);
    for (const name of [
        "readApiJson",
        "scenePresetReferenceIdsForExpand",
        "resolveScenePresetsForRun",
        "scenePresetGraphNodes",
        "apiLink",
        "apiInput",
        "apiMatrixEnabledCount",
        "apiMatrixConfigured",
        "emptyScenePromptStats",
        "sceneStatNumber",
        "scenePresetStats",
    ]) {
        vm.runInContext(functionSource(name), presetContext);
    }

    const snapshot = {
        output: {
            "9": { class_type: "ScenePresetReference", inputs: { preset_id: "preset-a" } },
            "10": { class_type: "ScenePromptExpand", inputs: { scene_prompt: ["9", 0] } },
        },
    };
    const run = { runId: "run-a" };
    await presetContext.resolveScenePresetsForRun(run, snapshot, "10");
    assert.equal(run.runHandle, "opaque-run-handle");
    assert.equal(run.presetSnapshots[0].revision, 2);
    presetContext.scenePresetDisplayGraphs = run.presetGraphs;
    const presetStats = presetContext.scenePresetStats("preset-a", null);
    assert.equal(presetStats.rows, 2);
    assert.equal(presetStats.total, 6);

    presetContext.prepareSceneRunContext = async () => { throw new Error("Presetが壊れています"); };
    await assert.rejects(
        () => presetContext.resolveScenePresetsForRun({ runId: "run-a" }, snapshot, "10"),
        /Presetが壊れています/,
    );
}

async function testPresetFailureDoesNotQueue() {
    const failedRun = {
        runId: "preset-failure",
        queueing: false,
        waiting: false,
        cachedPrompt: null,
        snapshotReady: false,
        snapshotError: null,
    };
    failedRun.snapshotPromise = Promise.resolve().then(() => {
        failedRun.snapshotError = new Error("Presetの検証に失敗しました");
    });

    const failureContext = {
        sceneBatchRun: failedRun,
        queued: false,
        stopped: false,
        sceneNodeForRun() { return null; },
        sceneBatchSeedBase() { return 0; },
        setWidgetValue() { return false; },
        updateSceneExpandButton() {},
        markSceneNodeChanged() {},
        async queueSingleScenePrompt() {
            failureContext.queued = true;
            return { prompt_id: "must-not-happen" };
        },
        acceptSceneBatchPrompt() {},
        stopSceneBatchRun() { failureContext.stopped = true; },
        showSceneBatchError() {},
        clearDetachedSceneBatchRun() {},
        sceneBatchRunsById: new Map(),
        releaseSceneBatchPlan() {},
        activateNextSceneBatchRun() {},
    };
    vm.createContext(failureContext);
    vm.runInContext(functionSource("queueNextSceneBatchItem"), failureContext);
    await failureContext.queueNextSceneBatchItem();
    assert.equal(failureContext.queued, false);
    assert.equal(failureContext.stopped, true);
}

async function testPresetResolutionKeepsClickFifo() {
    const fifoContext = {
        sceneBatchRun: null,
        sceneBatchRunsById: new Map(),
        sceneBatchDetachedRuns: new Map(),
        sceneBatchPendingRuns: [],
        activated: [],
        clearSceneSavePreviews() {},
        refreshSceneBatchRunNode() {},
        sceneNodeForRun() { return null; },
        prepareSceneBatchRunSnapshot() {},
        queueNextSceneBatchItem() {
            fifoContext.activated.push(fifoContext.sceneBatchRun.runId);
        },
    };
    vm.createContext(fifoContext);
    vm.runInContext(functionSource("activateNextSceneBatchRun"), fifoContext);

    const runA = { runId: "A" };
    const runB = { runId: "B" };
    fifoContext.sceneBatchRun = runA;
    fifoContext.sceneBatchRunsById.set("A", runA);
    fifoContext.sceneBatchRunsById.set("B", runB);
    fifoContext.sceneBatchPendingRuns.push(runB);

    const resolutionOrder = [];
    const resolveA = new Promise((resolve) => setTimeout(() => {
        resolutionOrder.push("A");
        resolve();
    }, 10));
    const resolveB = Promise.resolve().then(() => resolutionOrder.push("B"));
    await resolveB;
    fifoContext.activateNextSceneBatchRun();
    assert.equal(fifoContext.sceneBatchRun, runA);
    assert.deepEqual(fifoContext.activated, []);

    await resolveA;
    assert.deepEqual(resolutionOrder, ["B", "A"]);
    fifoContext.sceneBatchRun = null;
    fifoContext.activateNextSceneBatchRun();
    assert.equal(fifoContext.sceneBatchRun, runB);
    assert.deepEqual(fifoContext.activated, ["B"]);
}

async function testPresetRunCountDisplay() {
    const run = { preparing: true, nextIndex: 0, total: 6 };
    const node = { widgets: [{ sceneRole: "expand_run_all", name: "連続生成" }] };
    const displayContext = {
        sceneBatchPendingRuns: [],
        findSceneWidget(target, role) {
            return target.widgets.find((widget) => widget.sceneRole === role);
        },
        sceneBatchRunForNode() { return run; },
        sceneBatchRunStatus() { return "active"; },
        markSceneNodeChanged() {},
    };
    vm.createContext(displayContext);
    vm.runInContext(functionSource("updateSceneExpandButton"), displayContext);
    displayContext.updateSceneExpandButton(node);
    assert.equal(node.widgets[0].name, "準備中");
    run.preparing = false;
    run.nextIndex = 2;
    displayContext.updateSceneExpandButton(node);
    assert.equal(node.widgets[0].name, "停止 3/6");
}

async function testPresetErrorMarksOnlyTargetReference() {
    const canvasNodes = [
        { id: 10, presetReference: true, color: "a", bgcolor: "a", setDirtyCanvas() {} },
        { id: 20, presetReference: true, color: "b", bgcolor: "b", setDirtyCanvas() {} },
        { id: 30, presetReference: true, color: "c", bgcolor: "c", setDirtyCanvas() {} },
    ];
    const markContext = {
        Set,
        String,
        Object,
        app: { graph: { _nodes: canvasNodes, setDirtyCanvas() {} } },
        isScenePresetReferenceNode(node) { return node.presetReference; },
    };
    vm.createContext(markContext);
    vm.runInContext(functionSource("markScenePresetReferenceErrors"), markContext);
    markContext.markScenePresetReferenceErrors("壊れています", { nodeId: "20", relatedNodeIds: ["10", "30"] });
    assert.equal(canvasNodes[0].color, "a");
    assert.equal(canvasNodes[1].color, "#7f1d1d");
    assert.equal(canvasNodes[2].color, "c");

    const graphContext = { Set, String, Object };
    vm.createContext(graphContext);
    for (const name of ["apiLink", "apiInput", "scenePresetReferenceIdsForExpand"]) {
        vm.runInContext(functionSource(name), graphContext);
    }
    const relatedIds = graphContext.scenePresetReferenceIdsForExpand({
        output: {
            "1": { class_type: "ScenePresetReference", inputs: {} },
            "2": { class_type: "ScenePrompt", inputs: { scene_prompt: ["1", 0] } },
            "3": { class_type: "ScenePromptExpand", inputs: { scene_prompt: ["2", 0] } },
            "4": { class_type: "ScenePresetReference", inputs: {} },
        },
    }, "3");
    assert.deepEqual(Array.from(relatedIds), ["1"]);
}

async function testSelectedExpandBranchOnlyQueues() {
    const branchContext = { Map, Set, Object, String, Array };
    vm.createContext(branchContext);
    for (const name of [
        "apiLink",
        "apiInput",
        "cloneScenePromptPayload",
        "sceneRunTargetNodes",
        "applySceneRunHandle",
        "promptDescendantIds",
        "promptAncestorIds",
        "sliceSceneBatchPrompt",
        "createSceneBatchPromptSnapshot",
    ]) {
        vm.runInContext(functionSource(name), branchContext);
    }
    const fullPrompt = {
        output: {
            "1": { class_type: "ScenePresetReference", inputs: { preset_id: "A" } },
            "2": { class_type: "ScenePromptExpand", inputs: { scene_prompt: ["1", 0] } },
            "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
            "4": { class_type: "KSampler", inputs: { model: ["3", 0], scene_prompt: ["2", 0] } },
            "5": { class_type: "SaveImage", inputs: { images: ["4", 0] } },
            "10": { class_type: "ScenePresetReference", inputs: { preset_id: "B" } },
            "11": { class_type: "ScenePromptExpand", inputs: { scene_prompt: ["10", 0] } },
            "12": { class_type: "KSampler", inputs: { model: ["3", 0], scene_prompt: ["11", 0] } },
            "13": { class_type: "SaveImage", inputs: { images: ["12", 0] } },
        },
    };
    branchContext.app = { async graphToPrompt() { return fullPrompt; } };
    const selected = await branchContext.createSceneBatchPromptSnapshot("2");
    assert.deepEqual(Object.keys(selected.output).sort(), ["1", "2", "3", "4", "5"]);
    branchContext.applySceneRunHandle(selected, "opaque-handle");
    assert.equal(selected.output["1"].inputs.run_handle, "opaque-handle");
    assert.equal(selected.output["5"].class_type, "SaveImage");
    assert.equal(selected.output["10"], undefined);
    assert.equal(fullPrompt.output["10"].inputs.run_handle, undefined);

    const merged = structuredClone(fullPrompt);
    merged.output["4"].inputs.negative = ["11", 0];
    branchContext.app = { async graphToPrompt() { return merged; } };
    await assert.rejects(
        () => branchContext.createSceneBatchPromptSnapshot("2"),
        /複数の Scene Prompt Expand/,
    );
}

async function testCancelledPresetResolutionReleasesOnce() {
    const cancelledContext = {
        AbortController,
        Set,
        String,
        Object,
        Array,
        JSON,
        sceneBatchPendingRuns: [],
        sceneBatchRunsById: new Map(),
        releaseCalls: 0,
        releaseSceneRunHandle() { cancelledContext.releaseCalls += 1; },
        sceneNodeForRun() { return null; },
        refreshSceneBatchRunNode() {},
        resetSceneExpandRunControls() {},
        updateSceneExpandButton() {},
    };
    vm.createContext(cancelledContext);
    for (const name of [
        "releaseCancelledSceneBatchRun",
        "cancelSceneBatchRunPreparation",
        "cancelPendingSceneBatchRun",
    ]) {
        vm.runInContext(functionSource(name), cancelledContext);
    }
    const run = {
        runId: "cancelled",
        resolveController: new AbortController(),
        snapshotReleased: false,
        cancelled: false,
    };
    cancelledContext.sceneBatchRunsById.set(run.runId, run);
    cancelledContext.sceneBatchPendingRuns.push(run);
    cancelledContext.cancelPendingSceneBatchRun(run);
    cancelledContext.cancelPendingSceneBatchRun(run);
    assert.equal(run.cancelled, true);
    assert.equal(run.resolveController.signal.aborted, true);
    assert.equal(cancelledContext.releaseCalls, 1);
    assert.equal(cancelledContext.sceneBatchRunsById.has(run.runId), false);

    cancelledContext.prepareSceneRunContext = async () => ({ run_handle: "unused", presets: [], preset_graphs: {}, total_images: 1 });
    cancelledContext.clearScenePresetReferenceErrors = () => { throw new Error("cancelled run must not alter UI"); };
    cancelledContext.scenePresetReferenceIdsForExpand = () => [];
    vm.runInContext(functionSource("resolveScenePresetsForRun"), cancelledContext);
    const resolved = await cancelledContext.resolveScenePresetsForRun(run, { output: {} }, "2");
    assert.equal(resolved, null);
}

async function testPresetErrorClearStaysInSelectedBranch() {
    const nodes = [
        { id: 1, presetReference: true, color: "A", bgcolor: "A", scenePresetOriginalColors: { color: "a", bgcolor: "a" }, setDirtyCanvas() {} },
        { id: 2, presetReference: true, color: "B", bgcolor: "B", scenePresetOriginalColors: { color: "b", bgcolor: "b" }, setDirtyCanvas() {} },
    ];
    const clearContext = {
        Set,
        String,
        app: { graph: { _nodes: nodes, setDirtyCanvas() {} } },
        isScenePresetReferenceNode(node) { return node.presetReference; },
    };
    vm.createContext(clearContext);
    vm.runInContext(functionSource("clearScenePresetReferenceErrors"), clearContext);
    clearContext.clearScenePresetReferenceErrors({ nodeIds: ["2"] });
    assert.equal(nodes[0].color, "A");
    assert.equal(nodes[1].color, "b");
}

async function testPresetResolveClearsOnlyItsOwnReferences() {
    const nodes = [
        { id: 1, presetReference: true, color: "a", bgcolor: "a", setDirtyCanvas() {} },
        { id: 3, presetReference: true, color: "b", bgcolor: "b", setDirtyCanvas() {} },
    ];
    const resolveContext = {
        Set,
        String,
        Object,
        Array,
        JSON,
        app: { graph: { _nodes: nodes, setDirtyCanvas() {} } },
        isScenePresetReferenceNode(node) { return node.presetReference; },
        async prepareSceneRunContext(_snapshot, expand) {
            if (String(expand) === "4") {
                throw new Error("B is broken");
            }
            return { run_handle: "handle-A", presets: [], preset_graphs: {}, total_images: 1 };
        },
    };
    vm.createContext(resolveContext);
    for (const name of [
        "apiLink",
        "apiInput",
        "scenePresetReferenceIdsForExpand",
        "markScenePresetReferenceErrors",
        "clearScenePresetReferenceErrors",
        "resolveScenePresetsForRun",
    ]) {
        vm.runInContext(functionSource(name), resolveContext);
    }
    resolveContext.markScenePresetReferenceErrors("A is broken", { nodeId: "1" });
    await resolveContext.resolveScenePresetsForRun(
        { runId: "fixed-A" },
        { output: { "1": { class_type: "ScenePresetReference", inputs: {} }, "2": { class_type: "ScenePromptExpand", inputs: { scene_prompt: ["1", 0] } } } },
        "2",
    );
    assert.equal(nodes[0].color, "a");
    await assert.rejects(
        () => resolveContext.resolveScenePresetsForRun(
            { runId: "broken-B" },
            { output: { "3": { class_type: "ScenePresetReference", inputs: {} }, "4": { class_type: "ScenePromptExpand", inputs: { scene_prompt: ["3", 0] } } } },
            "4",
        ),
        /B is broken/,
    );
    resolveContext.markScenePresetReferenceErrors("B is broken", { nodeId: "3" });
    assert.equal(nodes[0].color, "a");
    assert.equal(nodes[1].color, "#7f1d1d");
}

async function testPresetDisplayCacheStaysPerReference() {
    const displayContext = {
        String,
        findSceneWidget(node) { return node.widgets.find((widget) => widget.sceneRole === "scene_preset_select"); },
        findWidget(node, name) { return node.widgets.find((widget) => widget.name === name); },
        scenePresetDisplayGraphs: new Map([
            ["A", { metadata: { preset_id: "A", revision: 1, sha256: "a" }, api_graph: { output: {} } }],
            ["B", { metadata: { preset_id: "B", revision: 4, sha256: "b" }, api_graph: { output: {} } }],
        ]),
    };
    vm.createContext(displayContext);
    for (const name of ["selectedScenePreset", "refreshScenePresetReference"]) {
        vm.runInContext(functionSource(name), displayContext);
    }
    const presets = [{ preset_id: "A", name: "Alpha" }, { preset_id: "B", name: "Beta" }];
    const nodeA = { widgets: [{ name: "preset_id", value: "A" }, { sceneRole: "scene_preset_select" }], setDirtyCanvas() {} };
    const nodeB = { widgets: [{ name: "preset_id", value: "B" }, { sceneRole: "scene_preset_select" }], setDirtyCanvas() {} };
    displayContext.refreshScenePresetReference(nodeA, presets);
    displayContext.refreshScenePresetReference(nodeB, presets);
    assert.equal(nodeA.scenePresetGraph.metadata.sha256, "a");
    assert.equal(nodeB.scenePresetGraph.metadata.sha256, "b");
}
