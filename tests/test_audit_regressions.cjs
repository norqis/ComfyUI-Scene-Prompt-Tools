const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

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

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function presetListRaceContext(...requests) {
    const responses = requests.map((request) => request.promise);
    const context = {
        Array,
        Map,
        scenePresetList: null,
        scenePresetListErrors: [],
        scenePresetDisplayGraphs: new Map(),
        scenePresetListRequestGeneration: 0,
        scenePresetListPromise: null,
        scenePresetListLatestPromise: null,
        scenePresetListCacheCurrent: false,
        fetchCount: 0,
        api: { fetchApi: () => {
            context.fetchCount += 1;
            return responses.shift();
        } },
        readApiJson: async (response) => response.payload,
    };
    vm.createContext(context);
    vm.runInContext(functionSource("loadScenePresetList"), context);
    return context;
}

async function testPresetListRaceInNormalResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    let oldRequestSettled = false;
    oldRequest.finally(() => { oldRequestSettled = true; });
    first.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "old" } }], errors: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldRequestSettled, false);
    second.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
    assert.equal(context.scenePresetDisplayGraphs.has("old"), false);
}

async function testPresetListRaceInReverseResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    second.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const newResult = await newRequest;
    first.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "old" } }], errors: [] } });
    const oldResult = await oldRequest;
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
    assert.equal(context.scenePresetDisplayGraphs.has("old"), false);
}

async function testPresetListFailureInNormalResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    first.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "old" } }], errors: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    second.resolve({ ok: false, payload: { error: "latest failed" } });
    const results = await Promise.allSettled([oldRequest, newRequest]);
    assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
    assert.deepEqual(results.map((result) => result.reason.message), ["latest failed", "latest failed"]);
    assert.equal(context.scenePresetList, null);
    assert.equal(context.scenePresetDisplayGraphs.size, 0);
}

async function testPresetListFailureInReverseResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    second.resolve({ ok: false, payload: { error: "latest failed" } });
    await assert.rejects(newRequest, /latest failed/);
    first.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "old" } }], errors: [] } });
    await assert.rejects(oldRequest, /latest failed/);
    assert.equal(context.scenePresetList, null);
    assert.equal(context.scenePresetDisplayGraphs.size, 0);
}

async function testStalePresetListFailureAdoptsLatestSuccessInNormalResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    let oldRequestSettled = false;
    oldRequest.then(
        () => { oldRequestSettled = true; },
        () => { oldRequestSettled = true; },
    );
    first.resolve({ ok: false, payload: { error: "stale failed" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldRequestSettled, false);
    second.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
}

async function testStalePresetListFailureAdoptsLatestSuccessInReverseResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    second.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const newResult = await newRequest;
    first.resolve({ ok: false, payload: { error: "stale failed" } });
    const oldResult = await oldRequest;
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
}

async function testStalePresetListNetworkFailureAdoptsLatestSuccessInNormalResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    let oldRequestSettled = false;
    oldRequest.then(
        () => { oldRequestSettled = true; },
        () => { oldRequestSettled = true; },
    );
    first.reject(new Error("stale network failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldRequestSettled, false);
    second.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
}

async function testStalePresetListNetworkFailureAdoptsLatestSuccessInReverseResponseOrder() {
    const first = deferred();
    const second = deferred();
    const context = presetListRaceContext(first, second);
    const oldRequest = context.loadScenePresetList(true);
    const newRequest = context.loadScenePresetList(true);
    second.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const newResult = await newRequest;
    first.reject(new Error("stale network failed"));
    const oldResult = await oldRequest;
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
}

async function testStalePresetListParseFailureAdoptsLatestSuccessInNormalResponseOrder() {
    const firstFetch = deferred();
    const secondFetch = deferred();
    const firstParse = deferred();
    const context = presetListRaceContext(firstFetch, secondFetch);
    const oldRequest = context.loadScenePresetList(true);
    firstFetch.resolve({ ok: true, payload: firstParse.promise });
    await new Promise((resolve) => setImmediate(resolve));
    const newRequest = context.loadScenePresetList(true);
    let oldRequestSettled = false;
    oldRequest.then(
        () => { oldRequestSettled = true; },
        () => { oldRequestSettled = true; },
    );
    firstParse.reject(new Error("stale parse failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldRequestSettled, false);
    secondFetch.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
}

async function testStalePresetListParseFailureAdoptsLatestSuccessInReverseResponseOrder() {
    const firstFetch = deferred();
    const secondFetch = deferred();
    const firstParse = deferred();
    const context = presetListRaceContext(firstFetch, secondFetch);
    const oldRequest = context.loadScenePresetList(true);
    firstFetch.resolve({ ok: true, payload: firstParse.promise });
    await new Promise((resolve) => setImmediate(resolve));
    const newRequest = context.loadScenePresetList(true);
    secondFetch.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "new" } }], errors: [] } });
    const newResult = await newRequest;
    firstParse.reject(new Error("stale parse failed"));
    const oldResult = await oldRequest;
    assert.equal(oldResult[0].preset_id, "new");
    assert.equal(newResult[0].preset_id, "new");
    assert.equal(context.scenePresetList[0].preset_id, "new");
    assert.equal(context.scenePresetDisplayGraphs.has("new"), true);
}

async function testPresetListRetriesAfterLatestFailure() {
    const initial = deferred();
    const failed = deferred();
    const retry = deferred();
    const context = presetListRaceContext(initial, failed, retry);

    const initialRequest = context.loadScenePresetList();
    initial.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "initial" } }], errors: [] } });
    assert.equal((await initialRequest)[0].preset_id, "initial");

    const failedRequest = context.loadScenePresetList(true);
    failed.resolve({ ok: false, payload: { error: "refresh failed" } });
    await assert.rejects(failedRequest, /refresh failed/);

    const retryRequest = context.loadScenePresetList();
    assert.equal(context.fetchCount, 3);
    retry.resolve({ ok: true, payload: { presets: [{ metadata: { preset_id: "recovered" } }], errors: [] } });
    assert.equal((await retryRequest)[0].preset_id, "recovered");
    assert.equal(context.scenePresetList[0].preset_id, "recovered");
    assert.equal(context.scenePresetDisplayGraphs.has("recovered"), true);
    assert.equal(context.scenePresetDisplayGraphs.has("initial"), false);
}

function testNodeRemovalCancelsItsRun() {
    const active = { runId: "active" };
    const pending = { runId: "pending" };
    const context = {
        sceneBatchRun: active,
        sceneBatchPendingRuns: [pending],
        sceneBatchRunForNode: (node) => node.run,
        stopped: 0,
        cancelled: [],
        stopSceneBatchRun() { context.stopped += 1; },
        cancelPendingSceneBatchRun(run) { context.cancelled.push(run.runId); },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("cancelSceneBatchRunForNode"), context);
    context.cancelSceneBatchRunForNode({ run: active });
    context.cancelSceneBatchRunForNode({ run: pending });
    assert.equal(context.stopped, 1);
    assert.deepEqual(context.cancelled, ["pending"]);
}

function testMatrixToggleSavesOnlyEnabledState() {
    const original = { row_id: "row-a", name: "Saved name", enabled: true, positive_base: "saved" };
    const context = {
        String,
        readMatrixState: () => ({ version: 1, sets: [original] }),
        written: null,
        writeMatrixState(_node, value) { context.written = value; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("saveMatrixLineEnabled"), context);
    context.saveMatrixLineEnabled({}, {
        row_id: "row-a",
        name: "Unsaved name",
        enabled: false,
        positive_base: "unsaved",
    });
    assert.equal(context.written.sets[0].enabled, false);
    assert.equal(context.written.sets[0].name, "Saved name");
    assert.equal(context.written.sets[0].positive_base, "saved");
}

function testMatrixStateUsesFirstValidStoredValue() {
    const context = {
        String,
        parseMatrixState(value) {
            if (value === "broken") throw new Error("broken state");
            return { value, sets: value === "empty" ? [] : [value] };
        },
        serializeMatrixState(state) { return state.value; },
        serializedMatrixJsonValue() { return "memory"; },
        createMatrixState() { return { value: "empty" }; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("currentMatrixJsonValue"), context);
    assert.equal(
        context.currentMatrixJsonValue({ properties: { scene_matrix_json: "property" } }, { value: "broken" }),
        "property",
    );
    assert.equal(
        context.currentMatrixJsonValue({ properties: { scene_matrix_json: "broken" } }, { value: "widget" }),
        "widget",
    );
    assert.equal(
        context.currentMatrixJsonValue({ properties: { scene_matrix_json: "property" } }, { value: "empty" }),
        "property",
    );
}

function testSourceOwnershipBoundaries() {
    assert.doesNotMatch(functionSource("hideInternalDomWidgets"), /document\.querySelectorAll/);
    const cleanup = functionSource("installSceneNodeRemovalCleanup");
    assert.match(cleanup, /node\.onRemoved/);
    assert.match(cleanup, /cancelSceneBatchRunForNode\(this\)/);

    const matrixEditor = functionSource("openSceneMatrixLinesPopup");
    const toggleStart = matrixEditor.indexOf('toggle.addEventListener("click"');
    const toggleEnd = matrixEditor.indexOf("actions.appendChild(toggle)", toggleStart);
    assert.notEqual(toggleStart, -1);
    const toggleSource = matrixEditor.slice(toggleStart, toggleEnd);
    assert.doesNotMatch(toggleSource, /saveMatrixLineDrafts/);
    assert.match(toggleSource, /saveMatrixLineEnabled/);

    const capture = functionSource("installSceneBatchPromptCapture");
    assert.doesNotMatch(capture, /releaseSceneBatchPlan/);
    assert.doesNotMatch(capture, /stopSceneBatchRun/);
}

function listRaceContext(kind, ...requests) {
    const context = {
        Array,
        Promise,
        console: { error() {} },
        promptItems: null,
        savedPrompts: null,
        promptItemsPromise: null,
        savedPromptsPromise: null,
        promptItemsLatestPromise: null,
        savedPromptsLatestPromise: null,
        promptItemsRequestGeneration: 0,
        savedPromptsRequestGeneration: 0,
        fetchCount: 0,
        api: {
            fetchApi: () => {
                context.fetchCount += 1;
                return requests.shift().promise;
            },
        },
        readApiJson: async (response) => response.payload,
        showSceneBatchError() {},
        clearSceneSelectedListLayoutCaches() {},
    };
    vm.createContext(context);
    vm.runInContext(functionSource(kind === "items" ? "loadPromptItems" : "loadSavedPrompts"), context);
    return context;
}

async function testItemAndSavedPromptStaleRefreshesAdoptTheLatestResponse() {
    for (const kind of ["items", "saved"]) {
        const old = deferred();
        const fresh = deferred();
        const context = listRaceContext(kind, old, fresh);
        const load = kind === "items" ? context.loadPromptItems : context.loadSavedPrompts;
        const first = load(true);
        const second = load(true);
        const key = kind === "items" ? "items" : "saved_prompts";
        old.resolve({ ok: true, payload: { [key]: [{ label: "old" }] } });
        fresh.resolve({ ok: true, payload: { [key]: [{ label: "fresh" }] } });
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(firstResult[0].label, "fresh");
        assert.equal(secondResult[0].label, "fresh");
    }
}

async function testItemAndSavedPromptStaleGetDoesNotAwaitItselfAfterPost() {
    for (const kind of ["items", "saved"]) {
        const request = deferred();
        const context = listRaceContext(kind, request);
        const load = kind === "items" ? context.loadPromptItems : context.loadSavedPrompts;
        const result = load(true);
        const key = kind === "items" ? "promptItems" : "savedPrompts";
        const generationKey = kind === "items" ? "promptItemsRequestGeneration" : "savedPromptsRequestGeneration";
        context[generationKey] += 1;
        context[key] = [{ label: "saved-by-post" }];
        request.resolve({ ok: true, payload: { [kind === "items" ? "items" : "saved_prompts"]: [{ label: "stale" }] } });
        const value = await Promise.race([
            result,
            new Promise((_, reject) => setTimeout(() => reject(new Error("stale request did not settle")), 250)),
        ]);
        assert.equal(value[0].label, "saved-by-post");
    }
}

async function testSavedPromptNormalLoadsShareOneInFlightRequest() {
    const request = deferred();
    const context = listRaceContext("saved", request);
    const first = context.loadSavedPrompts();
    const second = context.loadSavedPrompts();
    assert.equal(context.savedPromptsRequestGeneration, 1);
    assert.equal(context.fetchCount, 1);
    request.resolve({ ok: true, payload: { saved_prompts: [{ label: "shared" }] } });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult[0].label, "shared");
    assert.equal(secondResult[0].label, "shared");
}

function testLiveWidgetStateWinsOverStaleSerializedValue() {
    const context = { String, Array };
    vm.createContext(context);
    vm.runInContext(functionSource("serializedSelectionStateValue"), context);
    const widget = { name: "positive_json", value: '{"version":1,"categories":{"Live":[]}}' };
    const node = { widgets: [widget], widgets_values: ['{"version":1,"categories":{"Stale":[]}}'] };
    assert.match(context.serializedSelectionStateValue(node, widget, widget.name), /Live/);
    widget.value = "";
    assert.match(context.serializedSelectionStateValue(node, widget, widget.name), /Stale/);
}

function testMatrixEmptyNameFailsBeforePersisting() {
    const context = { String };
    vm.createContext(context);
    vm.runInContext(functionSource("saveMatrixLineDrafts"), context);
    assert.throws(
        () => context.saveMatrixLineDrafts({}, [{ name: "", row_id: "row-a" }]),
        /Matrix 行 1 の名前/,
    );
}

async function testWorkflowLoadGuardMarksOnlyLoadWindow() {
    let resolveLoad;
    const loading = new Promise((resolve) => { resolveLoad = resolve; });
    const context = {
        Math,
        sceneWorkflowLoadDepth: 0,
        app: {
            loadGraphData() {
                assert.equal(context.sceneWorkflowLoadDepth, 1);
                return loading;
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("installSceneWorkflowLoadGuard"), context);
    context.installSceneWorkflowLoadGuard();
    const result = context.app.loadGraphData({});
    assert.equal(context.sceneWorkflowLoadDepth, 1);
    resolveLoad("loaded");
    assert.equal(await result, "loaded");
    assert.equal(context.sceneWorkflowLoadDepth, 0);
}

function testPendingFifoRunPreparesPresetSnapshotImmediately() {
    const active = { runId: "active" };
    const pending = { runId: "pending" };
    const node = { id: 2 };
    const context = {
        Map,
        sceneBatchRun: active,
        sceneBatchDetachedRuns: new Map(),
        sceneBatchPendingRuns: [],
        sceneBatchRunForNode() { return null; },
        sceneBatchRunStatus() { return "idle"; },
        syncSceneNodeModes() {},
        syncAllScenePromptNames() {},
        sceneExpandCounts() { return { totalBatches: 1 }; },
        createSceneBatchRun() { return pending; },
        updateSceneExpandButton() {},
        refreshSceneBatchRunNode() {},
        prepared: [],
        prepareSceneBatchRunSnapshot(run, snapshotNode) { context.prepared.push([run, snapshotNode]); },
        resetSceneExpandRunControls() {},
        showSceneBatchError(error) { throw error; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("startSceneBatchRun"), context);
    context.startSceneBatchRun(node);
    assert.deepEqual(context.sceneBatchPendingRuns, [pending]);
    assert.deepEqual(context.prepared, [[pending, node]]);
}

async function testPresetSaveDoesNotClaimRefreshSucceededAfterRefreshFailure() {
    const node = {
        graph: null,
        widgets: [
            { name: "preset_id", value: "preset-a" },
            { name: "preset_name", value: "Preset A" },
        ],
    };
    const errors = [];
    const notices = [];
    const context = {
        String,
        JSON,
        app: {
            graph: { serialize() { return { nodes: [] }; } },
            async graphToPrompt() { return { output: {} }; },
        },
        scenePresetList: [],
        findWidget(target, name) { return target.widgets.find((widget) => widget.name === name); },
        api: { async fetchApi() { return { ok: true, payload: { metadata: { name: "Preset A", revision: 1 } } }; } },
        async readApiJson(response) { return response.payload; },
        async loadScenePresetList() { throw new Error("refresh offline"); },
        refreshAllScenePresetReferences() { throw new Error("must not refresh stale data"); },
        showSceneBatchError(message, error) { errors.push([message, error?.message || ""]); },
        showSceneNotification(message) { notices.push(message); },
        console: { warn() {} },
    };
    node.graph = context.app.graph;
    vm.createContext(context);
    vm.runInContext(functionSource("saveScenePreset"), context);
    await context.saveScenePreset(node);
    assert.deepEqual(notices, []);
    assert.deepEqual(errors, [["Presetは保存しましたが、一覧を更新できませんでした。", "refresh offline"]]);
}

async function testCancelledPickerRequestDoesNotReopenAfterNodeLifecycleChange() {
    let resolveLoad;
    const pending = new Promise((resolve) => { resolveLoad = resolve; });
    const graph = {};
    const node = { graph };
    const context = {
        Number,
        app: { graph },
        errors: [],
        showSceneBatchError(message) { context.errors.push(message); },
    };
    vm.createContext(context);
    for (const name of ["beginPopupRequest", "isCurrentPopupRequest", "invalidatePopupRequests", "loadPopupRequest"]) {
        vm.runInContext(functionSource(name), context);
    }
    const request = context.loadPopupRequest(node, () => pending, "候補を読み込めませんでした。");
    context.invalidatePopupRequests(node);
    resolveLoad(["late response"]);
    assert.equal(await request, null);
    assert.deepEqual(context.errors, []);
}

Promise.resolve()
    .then(testPresetListRaceInNormalResponseOrder)
    .then(testPresetListRaceInReverseResponseOrder)
    .then(testPresetListFailureInNormalResponseOrder)
    .then(testPresetListFailureInReverseResponseOrder)
    .then(testStalePresetListFailureAdoptsLatestSuccessInNormalResponseOrder)
    .then(testStalePresetListFailureAdoptsLatestSuccessInReverseResponseOrder)
    .then(testStalePresetListNetworkFailureAdoptsLatestSuccessInNormalResponseOrder)
    .then(testStalePresetListNetworkFailureAdoptsLatestSuccessInReverseResponseOrder)
    .then(testStalePresetListParseFailureAdoptsLatestSuccessInNormalResponseOrder)
    .then(testStalePresetListParseFailureAdoptsLatestSuccessInReverseResponseOrder)
    .then(testPresetListRetriesAfterLatestFailure)
    .then(testNodeRemovalCancelsItsRun)
    .then(testMatrixToggleSavesOnlyEnabledState)
    .then(testMatrixStateUsesFirstValidStoredValue)
    .then(testSourceOwnershipBoundaries)
    .then(testItemAndSavedPromptStaleRefreshesAdoptTheLatestResponse)
    .then(testItemAndSavedPromptStaleGetDoesNotAwaitItselfAfterPost)
    .then(testSavedPromptNormalLoadsShareOneInFlightRequest)
    .then(testLiveWidgetStateWinsOverStaleSerializedValue)
    .then(testMatrixEmptyNameFailsBeforePersisting)
    .then(testWorkflowLoadGuardMarksOnlyLoadWindow)
    .then(testPendingFifoRunPreparesPresetSnapshotImmediately)
    .then(testPresetSaveDoesNotClaimRefreshSucceededAfterRefreshFailure)
    .then(testCancelledPickerRequestDoesNotReopenAfterNodeLifecycleChange)
    .then(() => console.log("Audit regression tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
