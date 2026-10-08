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

function methodSource(name) {
    const start = source.indexOf(`    ${name}() {`);
    assert.notEqual(start, -1, `Missing method: ${name}`);
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed method: ${name}`);
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
        sceneGraphNodes: () => [],
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

function testPresetReferenceCandidatesAreSortedByDisplayName() {
    const context = { Array, String };
    vm.createContext(context);
    vm.runInContext(functionSource("sortedScenePresetCandidates"), context);
    const presets = [
        { preset_id: "z-id", name: "シーン10" },
        { preset_id: "fallback-name" },
        { preset_id: "a-id", name: "シーン2" },
        { preset_id: "b-id", name: "Alpha" },
        { preset_id: "a2-id", name: "alpha" },
    ];
    const sorted = context.sortedScenePresetCandidates(presets);
    assert.deepEqual(
        Array.from(sorted, (preset) => preset.preset_id),
        ["a2-id", "b-id", "fallback-name", "a-id", "z-id"],
    );
    assert.deepEqual(Array.from(presets, (preset) => preset.preset_id), ["z-id", "fallback-name", "a-id", "b-id", "a2-id"]);
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

function testMatrixCommitWritesWholeDraftOnlyWhenChanged() {
    const original = { row_id: "row-a", name: "Saved name", enabled: true, positive_base: "saved" };
    const context = {
        matrixLineDraftState: (drafts) => ({ version: 1, sets: drafts }),
        serializeMatrixState: JSON.stringify,
        current: { version: 1, sets: [original] },
        writes: 0,
        withSceneUserChange: (_node, commit) => commit(),
        readMatrixState: () => context.current,
        writeMatrixState(_node, value) {
            context.writes += 1;
            context.current = value;
        },
    };
    const node = { id: 1 };
    node.graph = { getNodeById: id => id === node.id ? node : null };
    vm.createContext(context);
    vm.runInContext(functionSource("sceneNodeHasCurrentOwner"), context);
    vm.runInContext(functionSource("commitMatrixLineDrafts"), context);
    assert.equal(context.commitMatrixLineDrafts(node, [original]), false);
    assert.equal(context.writes, 0);
    assert.equal(context.commitMatrixLineDrafts(node, [{ ...original, name: "Changed", enabled: false }]), true);
    assert.equal(context.writes, 1);
    assert.equal(context.current.sets[0].name, "Changed");
    assert.equal(context.current.sets[0].enabled, false);
}

function testMatrixEmptyNameUsesDefaultOnCommit() {
    const context = {
        String,
        refreshMatrixLineDraftComputedFields() {},
        normalizeMatrixLine: (draft) => draft,
    };
    vm.createContext(context);
    vm.runInContext(functionSource("matrixLineDraftState"), context);
    const state = context.matrixLineDraftState([{ row_id: "row-a", name: "   ", path_label: "old" }]);
    assert.equal(state.sets[0].name, "行 1");
    assert.equal(state.sets[0].path_label, "行 1");
}

function testModalCommitsUseOnlyTheirActiveOwner() {
    const events = [], nodes = new Map();
    const graph = { getNodeById: id => nodes.get(id), beforeChange() { events.push("graph-before"); },
        afterChange() { events.push("graph-after"); }, change() { events.push("owner-change"); } };
    const canvas = { graph, emitBeforeChange() { events.push("canvas-before"); }, emitAfterChange() { events.push("canvas-after"); } };
    const context = { JSON, Array, Object, app: { graph, canvas },
        findWidget: (node, name) => node.widgets.find(widget => widget.name === name),
        activeStateWidgetName: () => "positive_json", setActiveStateWidget() {},
        matrixLineDraftContextFor: node => node.draft ? { draft: node.draft, side: "positive" } : null,
        writeMatrixLineDraftSelectionState(draft, _side, state) { draft.state = state; },
        notifyWidgetChanged() { events.push("write"); if (context.failWrite) throw new Error("Write failed"); },
        clearSceneComputedCaches() {}, refreshNode() {}, refreshDownstreamSceneNodes() {}, scheduleFitHeight() {},
        isScenePromptNode: () => false, isSceneApplyLoraNode: () => false,
        serializeMatrixState: JSON.stringify, matrixLineDraftState: sets => ({ version: 1, sets }),
        readMatrixState: node => node.matrix,
        writeMatrixState(node, state) { events.push("matrix-write"); node.matrix = state; },
    };
    vm.createContext(context);
    for (const name of ["beginSceneGraphChange", "endSceneGraphChange", "sceneNodeHasCurrentOwner", "withSceneUserChange", "writeStateToWidget", "writeState", "commitMatrixLineDrafts"])
        vm.runInContext(functionSource(name), context);
    const empty = { version: 1, categories: {} }, selected = { version: 1, categories: { Test: [{ id: "a", weight: 1.25 }] } };
    const node = { id: 1, graph, widgets: [{ name: "positive_json", value: JSON.stringify(empty) }], widgets_values: [] };
    nodes.set(node.id, node);
    context.writeState(node, selected);
    assert.deepEqual(events.splice(0), ["graph-before", "canvas-before", "write", "owner-change", "graph-after", "canvas-after"]);
    assert.equal(node.widgets_values[0], JSON.stringify(selected));
    context.writeState(node, selected); assert.deepEqual(events, [], "unchanged blur/close does not enter native history");
    node.draft = {}; context.writeState(node, empty);
    assert.deepEqual(node.draft.state, empty); assert.deepEqual(events, [], "Matrix selection remains a draft until its existing commit boundary");
    assert.equal(node.widgets[0].value, JSON.stringify(selected)); delete node.draft;
    node.matrix = { version: 1, sets: [] };
    assert.equal(context.commitMatrixLineDrafts(node, []), false); assert.deepEqual(events, []);
    assert.equal(context.commitMatrixLineDrafts(node, [{ name: "Edited", positive_base: "prompt" }]), true);
    assert.deepEqual(events.splice(0), ["graph-before", "canvas-before", "matrix-write", "graph-after", "canvas-after"]);
    assert.equal(context.commitMatrixLineDrafts(node, node.matrix.sets), false); assert.deepEqual(events, []);
    const otherGraph = { getNodeById: () => node, change() { events.push("inactive-change"); } };
    node.graph = otherGraph; context.writeState(node, empty);
    assert.deepEqual(events.splice(0), ["write", "inactive-change"], "inactive owners never notify the active graph/canvas");
    node.graph = graph; nodes.set(node.id, { id: node.id }); context.writeState(node, selected);
    assert.deepEqual(events, [], "same-ID replacement nodes reject the old owner's commit entirely");
    assert.equal(node.widgets[0].value, JSON.stringify(empty));
    const matrixBuilder = context.matrixLineDraftState, matrixReader = context.readMatrixState;
    context.matrixLineDraftState = context.readMatrixState = () => { throw new Error("Stale normalization must not run"); };
    assert.equal(context.commitMatrixLineDrafts(node, []), false);
    node.graph = null; assert.equal(context.withSceneUserChange(node, () => { throw new Error("Graph-less commit must not run"); }), false);
    assert.equal(context.commitMatrixLineDrafts(node, []), false);
    context.matrixLineDraftState = matrixBuilder; context.readMatrixState = matrixReader; node.graph = graph;
    nodes.set(node.id, node); canvas.graph = otherGraph; context.writeState(node, selected);
    assert.deepEqual(events.splice(0), ["write", "owner-change"], "a different displayed canvas graph receives no transaction");
    canvas.graph = graph; context.failWrite = true;
    assert.throws(() => context.writeState(node, empty), /Write failed/);
    assert.deepEqual(events.splice(0), ["graph-before", "canvas-before", "write", "graph-after", "canvas-after"]);
    context.failWrite = false;
    context.withSceneUserChange(node, () => { context.app.canvas = { graph: otherGraph }; context.app.graph = otherGraph; });
    assert.deepEqual(events.splice(0), ["graph-before", "canvas-before", "graph-after", "canvas-after"], "synchronous transaction ends on its captured owner/canvas");
    context.app.graph = graph; context.app.canvas = canvas;
    graph.afterChange = () => { events.push("graph-after"); throw new Error("Graph end failed"); };
    assert.throws(() => context.withSceneUserChange(node, () => {}), /Graph end failed/);
    assert.deepEqual(events.splice(0), ["graph-before", "canvas-before", "graph-after", "canvas-after"], "canvas end remains balanced when graph end throws");
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
    assert.doesNotMatch(matrixEditor, /createButton\("保存"/);
    assert.match(toggleSource, /commitStructuralChange/);
    assert.match(matrixEditor, /onClose: commitDrafts/);

    const negativeIndex = matrixEditor.indexOf('createButton("ネガティブ候補")');
    const filenameIndex = matrixEditor.indexOf('createButton(draft.filename_enabled');
    const duplicateIndex = matrixEditor.indexOf('createButton("複製")');
    const removeIndex = matrixEditor.indexOf('createButton("削除", "pc-danger")');
    assert.ok(negativeIndex >= 0 && negativeIndex < filenameIndex && filenameIndex < duplicateIndex && duplicateIndex < removeIndex);
    assert.match(matrixEditor, /copiedDraft\.row_id = createMatrixLine\(`行 \$\{index \+ 2\}`\)\.row_id/);
    assert.match(matrixEditor, /let drafts = matrixLineDraftsForNode\(node\)/);
    assert.match(matrixEditor, /drafts = matrixLineDraftsForNode\(node\)/);
    assert.match(matrixEditor, /draft\.name = nextName;\s+draft\.path_label = nextName/);
    assert.match(matrixEditor, /drafts\.splice\(index \+ 1, 0, copiedDraft\)/);
    assert.match(matrixEditor, /const remove = createButton\("削除", "pc-danger"\)/);

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
        assert.equal(context[kind === "items" ? "promptItemsLatestPromise" : "savedPromptsLatestPromise"], null,
            "settled loader promises do not retain replaced catalog arrays");

        const stale = deferred(), latest = deferred(), delayed = listRaceContext(kind, stale, latest);
        const delayedLoad = kind === "items" ? delayed.loadPromptItems : delayed.loadSavedPrompts;
        const oldResult = delayedLoad(true), newResult = delayedLoad(true);
        latest.resolve({ ok: true, payload: { [key]: [{ label: "loaded" }] } });
        await newResult;
        const cacheKey = kind === "items" ? "promptItems" : "savedPrompts";
        delayed[cacheKey] = [{ label: "edited-after-load" }];
        stale.reject(new Error("old failed response"));
        assert.strictEqual(await oldResult, delayed[cacheKey], "stale failures use the current post/edit catalog after the latest request settles");
        assert.equal(delayed[kind === "items" ? "promptItemsLatestPromise" : "savedPromptsLatestPromise"], null);
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

async function testOverlappingFormWritesInvalidateEarlierReadSnapshots() {
    for (const mutationName of ["createPromptItem", "updatePromptItem", "saveCurrentPrompt"]) for (const overlappingRead of [false, true]) {
        const kind = mutationName === "saveCurrentPrompt" ? "saved" : "items";
        const older = deferred(), newer = deferred(), stale = deferred(), fresh = deferred();
        const context = listRaceContext(kind, older, newer, ...(overlappingRead ? [stale] : []), fresh);
        vm.runInContext(functionSource(mutationName), context);
        if (kind === "items") vm.runInContext(functionSource("createPromptItem"), context);
        const mutate = () => context[mutationName](kind === "items" ? { name: "draft" } : "draft", "", []);
        const load = kind === "items" ? context.loadPromptItems : context.loadSavedPrompts;
        const key = kind === "items" ? "items" : "saved_prompts";
        const first = mutate(), second = kind === "items" ? context.createPromptItem({ name: "B" }) : mutate();
        newer.resolve({ ok: true, payload: { [key]: [{ label: "B" }] } });
        await second;
        assert.equal((await load())[0].label, "B");
        assert.equal(context.fetchCount, 2, "fresh POST list requires no extra GET");
        const oldRead = overlappingRead ? load(true) : null;
        older.resolve({ ok: true, payload: { [key]: [{ label: "A" }, { label: "B" }] } });
        await first;
        const latest = load();
        if (overlappingRead) stale.resolve({ ok: true, payload: { [key]: [{ label: "B" }] } });
        fresh.resolve({ ok: true, payload: { [key]: [{ label: "A" }, { label: "B" }] } });
        assert.deepEqual(Array.from(await latest, (entry) => entry.label), ["A", "B"]);
        if (oldRead) assert.deepEqual(Array.from(await oldRead, (entry) => entry.label), ["A", "B"]);
        assert.equal(context[kind === "items" ? "promptItemsLatestPromise" : "savedPromptsLatestPromise"], null);
    }
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

async function testWorkflowLoadGuardMarksOnlyLoadWindow() {
    let resolveLoad;
    const loading = new Promise((resolve) => { resolveLoad = resolve; });
    const context = {
        Math,
        sceneWorkflowLoadDepth: 0,
        sceneWorkflowLoadSources: new Set(),
        app: {
            loadGraphData(workflow) {
                assert.equal(context.sceneWorkflowLoadDepth, 1);
                if (workflow?.fail) {
                    context.sceneWorkflowLoadSources.add({ id: 1 });
                    throw new Error("load failed");
                }
                if (workflow?.cancel) {
                    context.sceneWorkflowLoadSources.add({ id: 2 });
                    return false;
                }
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
    await assert.rejects(context.app.loadGraphData({ fail: true }), /load failed/);
    assert.equal(context.sceneWorkflowLoadSources.size, 0, "failed loads discard pending old nodes");
    assert.equal(await context.app.loadGraphData({ cancel: true }), false);
    assert.equal(context.sceneWorkflowLoadSources.size, 0, "cancelled loads discard pending old nodes");
}

function testWorkflowConnectionStormDefersSceneWork() {
    const work = { original: 0, queue: 0, random: 0, label: 0, cache: 0, schedule: 0, downstream: 0 };
    const context = {
        Set,
        sceneWorkflowLoadDepth: 1,
        sceneWorkflowLoadSources: new Set(),
        installSceneModeWatcher() {},
        isSceneApplyLoraNode: () => true,
        isScenePromptQueueNode: () => true,
        isScenePromptJoinNode: () => true,
        isScenePromptRandomRouteOutputNode: () => false,
        isScenePromptRandomRouteNode: () => true,
        syncSceneLoraSelectLabel: () => { work.label += 1; },
        syncSceneQueueControls: () => { work.queue += 1; },
        syncSceneRandomRoute: () => { work.random += 1; },
        clearSceneComputedCaches: () => { work.cache += 1; },
        scheduleSceneNodeRefresh: () => { work.schedule += 1; },
        refreshDownstreamSceneNodes: () => { work.downstream += 1; },
        handleSceneNodeModeChange() {},
    };
    vm.createContext(context);
    vm.runInContext(functionSource("installSceneConnectionWatcher"), context);
    const node = { id: 100, onConnectionsChange() { work.original += 1; } };
    context.installSceneConnectionWatcher(node);
    for (let index = 0; index < 1200; index += 1) node.onConnectionsChange();
    assert.equal(work.original, 1200, "the original connection handler still receives every load event");
    assert.equal(work.cache, 1200, "the current node cache is invalidated for every changed edge");
    assert.equal(context.sceneWorkflowLoadSources.size, 1, "repeated edge changes share one source");
    assert.deepEqual([work.queue, work.random, work.label, work.schedule, work.downstream], [0, 0, 0, 0, 0],
        "load edges defer graph work until configuration completes");
    context.sceneWorkflowLoadDepth = 0;
    node.onConnectionsChange();
    assert.deepEqual([work.original, work.queue, work.random, work.label, work.schedule, work.downstream],
        [1201, 1, 1, 1, 1, 1], "interactive edge changes still refresh immediately");
}

function testWorkflowLoadDefersWidgetTriggeredRefreshes() {
    const node = { id: 77, sceneQueueControlLock: "upstream" };
    const context = {
        sceneWorkflowLoadDepth: 1,
        sceneWorkflowLoadSources: new Set(),
        collectDownstreamSceneNodes() { throw new Error("must not traverse during load"); },
        sceneQueueLockState() { throw new Error("must not compute Queue lock during load"); },
        setTimeout() { throw new Error("must not schedule a per-widget timer during load"); },
    };
    vm.createContext(context);
    for (const name of ["refreshDownstreamSceneNodes", "scheduleSceneNodeRefresh", "syncSceneQueueControls"]) {
        vm.runInContext(functionSource(name), context);
    }
    context.refreshDownstreamSceneNodes(node);
    context.scheduleSceneNodeRefresh(node);
    assert.equal(context.syncSceneQueueControls(node), "upstream");
    assert.deepEqual([...context.sceneWorkflowLoadSources], [node],
        "connection, widget, and Queue callbacks converge on one deferred source");
}

function testWorkflowLoadFlushTraversesOldGraphOnce() {
    const count = 302;
    const queueIds = new Set(Array.from({ length: 17 }, (_, index) => index * 17 + 16));
    const nodes = Array.from({ length: count }, (_, index) => ({
        id: index,
        type: queueIds.has(index) ? "ScenePrompterQueue" : "ScenePrompter",
        widgets: queueIds.has(index) ? [
            { name: "order_mode", value: index === 16 ? "alternate" : "input_order" },
            { name: "alternate_block_size", value: index === 16 ? 3 : 1 },
            { name: "downstream_count_mode", value: index === 16 ? "fixed" : "multiply" },
        ] : [],
        outputs: [{ links: index < count - 1 ? [index + 1] : [] }],
    }));
    let lookups = 0;
    const graph = {
        _nodes: nodes,
        links: Object.fromEntries(nodes.slice(1).map((node) => [node.id, { target_id: node.id }])),
        getNodeById(id) { lookups += 1; return nodes[id]; },
    };
    for (const node of nodes) node.graph = graph;
    const stale = { id: 42, graph, outputs: [{ links: [43] }] };
    const work = { queue: 0, cleared: new Set(), refreshed: new Set() };
    const context = {
        Set,
        app: { graph },
        sceneWorkflowLoadSources: new Set([...nodes, stale]),
        SCENE_QUEUE_CONTROL_NAMES: ["order_mode", "alternate_block_size", "downstream_count_mode"],
        sceneGraphNodes: () => nodes,
        isRerouteNode: () => false,
        isPromptMatrixNode: () => false,
        isScenePromptSourceNode: (node) => node.type === "ScenePrompter" || node.type === "ScenePrompterQueue",
        isSceneExpandNode: () => false,
        isScenePromptQueueNode: (node) => node.type === "ScenePrompterQueue",
        isScenePromptJoinNode: (node) => node.type === "ScenePrompterQueue",
        isScenePromptRandomRouteOutputNode: () => false,
        findWidget: (node, name) => node.widgets.find((widget) => widget.name === name),
        syncSceneQueueControls(node) {
            work.queue += 1;
            if (node.id === 16) {
                node.widgets[0].value = "input_order";
                node.widgets[1].value = 1;
                node.widgets[2].value = "multiply";
            }
        },
        clearSceneComputedCaches: (node) => work.cleared.add(node),
        scheduleSceneNodeRefresh: (node) => work.refreshed.add(node),
    };
    vm.createContext(context);
    vm.runInContext(functionSource("downstreamNodes"), context);
    vm.runInContext(functionSource("collectDownstreamSceneNodes"), context);
    vm.runInContext(`globalThis.extension = { ${methodSource("afterConfigureGraph")} };`, context);
    context.extension.afterConfigureGraph();
    assert.equal(work.queue, 17, "each Queue locks or unlocks once after the graph is restored");
    assert.deepEqual(nodes[16].widgets.map((widget) => widget.value), ["input_order", 1, "multiply"],
        "the final Queue lock can replace stale saved controls");
    assert.equal(lookups, count + 1 + count - 1, "shared traversal visits each edge at most once");
    assert.equal(work.refreshed.size, count, "changed sources and downstream nodes refresh once despite 302 load sources");
    assert.equal(context.sceneWorkflowLoadSources.size, 0, "pending load sources are drained");
    assert.equal(work.cleared.has(nodes[42]), true, "a live node sharing a stale id is still refreshed");
    assert.equal(work.refreshed.has(stale), false, "a removed node is not scheduled after graph replacement");
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
    const captureOrder = [];
    let savedPayload = null;
    const context = {
        String,
        JSON,
        app: {
            graph: { serialize() { return { nodes: [] }; } },
            async graphToPrompt() {
                captureOrder.push("graphToPrompt");
                return { output: { "matrix": { class_type: "SceneMatrix", inputs: { matrix_json: captureOrder[0] === "commit" ? "weight-draft" : "stale" } } } };
            },
        },
        activePopupContext: { node: { sceneMatrixLineDraftContext: { commitDrafts() { captureOrder.push("commit"); } } } },
        scenePresetList: [],
        isScenePresetReferenceNode(target) { return target.type === "ScenePresetReference"; },
        syncAllScenePromptNames() {},
        applySceneSourceNodeNames(prompt) { return prompt; },
        findWidget(target, name) { return target.widgets.find((widget) => widget.name === name); },
        api: { async fetchApi(_path, options) { savedPayload = JSON.parse(options.body); return { ok: true, payload: { metadata: { name: "Preset A" } } }; } },
        async readApiJson(response) { return response.payload; },
        async loadScenePresetList() { throw new Error("refresh offline"); },
        refreshAllScenePresetReferences() { throw new Error("must not refresh stale data"); },
        showSceneBatchError(message, error) { errors.push([message, error?.message || ""]); },
        showSceneNotification(message) { notices.push(message); },
        console: { warn() {} },
    };
    node.graph = context.app.graph;
    vm.createContext(context);
    vm.runInContext(functionSource("commitActiveMatrixLineDraft"), context);
    context.sceneLLMValue = (await import("../web/scene_prompt_llm.js")).value;
    vm.runInContext(functionSource("saveScenePreset"), context);
    await context.saveScenePreset(node);
    assert.deepEqual(captureOrder, ["commit", "graphToPrompt"]);
    assert.equal(savedPayload.api_graph.output.matrix.inputs.matrix_json, "weight-draft");
    assert.deepEqual(notices, []);
    assert.deepEqual(errors, [["Presetは保存しましたが、一覧を更新できませんでした。", "refresh offline"]]);
}

async function testPresetSaveMarksOnlyTheReferenceReturnedByTheServer() {
    const failedReference = {
        id: 12,
        type: "ScenePresetReference",
        color: "original-failed",
        bgcolor: "original-failed-bg",
        setDirtyCanvas() {},
    };
    const otherReference = {
        id: 13,
        type: "ScenePresetReference",
        color: "original-other",
        bgcolor: "original-other-bg",
        setDirtyCanvas() {},
    };
    const node = {
        id: 20,
        graph: null,
        widgets: [
            { name: "preset_id", value: "preset-a" },
            { name: "preset_name", value: "Preset A" },
        ],
    };
    const errors = [];
    const context = {
        String,
        JSON,
        Set,
        app: {
            graph: {
                _nodes: [failedReference, otherReference],
                getNodeById(id) { return this._nodes.find(node => String(node.id) === String(id)); },
                serialize() { return { nodes: [] }; },
                setDirtyCanvas() {},
            },
            async graphToPrompt() { return { output: {} }; },
        },
        syncAllScenePromptNames() {},
        commitActiveMatrixLineDraft() {},
        applySceneSourceNodeNames() {},
        findWidget(target, name) { return target.widgets.find((widget) => widget.name === name); },
        isScenePresetReferenceNode(target) { return target.type === "ScenePresetReference"; },
        api: {
            async fetchApi() {
                return {
                    ok: false,
                    payload: { error: "途中の参照 #12 でPresetが選択されていません。", node_id: "12" },
                };
            },
        },
        async readApiJson(response) { return response.payload; },
        showSceneBatchError(message, error) { errors.push([message, error.message]); },
    };
    node.graph = context.app.graph;
    vm.createContext(context);
    vm.runInContext(functionSource("markScenePresetReferenceErrors"), context);
    context.sceneLLMValue = (await import("../web/scene_prompt_llm.js")).value;
    vm.runInContext(functionSource("saveScenePreset"), context);

    await context.saveScenePreset(node);

    assert.equal(failedReference.color, "#7f1d1d");
    assert.equal(failedReference.bgcolor, "#3b1010");
    assert.equal(failedReference.scenePresetError, "途中の参照 #12 でPresetが選択されていません。");
    assert.equal(otherReference.color, "original-other");
    assert.equal(otherReference.bgcolor, "original-other-bg");
    assert.deepEqual(errors, [["Presetを保存できませんでした。", "途中の参照 #12 でPresetが選択されていません。"]]);
}

async function testPresetPickerClearsTheSelectedReferenceError() {
    const buttons = [];
    const cleared = [];
    const history = [];
    const node = { id: 12, widgets: [{ name: "preset_id", value: "" }], setDirtyCanvas() {} };
    node.graph = { getNodeById: id => id === node.id ? node : null, setDirtyCanvas() {},
        beforeChange() { history.push("before"); }, afterChange() { history.push("after"); }, change() { history.push("change"); } };
    const createElement = (tagName) => ({
        tagName,
        children: [],
        className: "",
        textContent: "",
        appendChild(child) { this.children.push(child); },
        append(...children) { this.children.push(...children); },
        setAttribute() {}, remove() {},
    });
    const context = {
        Array,
        String,
        document: { createElement },
        scenePresetListErrors: [],
        app: { graph: node.graph, canvas: { graph: node.graph } },
        findWidget: (target, name) => target.widgets.find(widget => widget.name === name),
        async loadPopupRequest() { return [{ preset_id: "chosen", name: "Chosen" }]; },
        refreshScenePresetReferenceList() { throw new Error("initial load is supplied by the test"); },
        openPopupShell() { context.activePopupContext = { node }; return context.activePopup = createElement("popup"); },
        waitForModalPaint: async () => {},
        fitPopupToContent() {},
        createButton(label) {
            const button = {
                label,
                classList: { add() {} },
                addEventListener(type, listener) { this[type] = listener; },
            };
            buttons.push(button);
            return button;
        },
        selectedScenePreset() { return null; },
        setWidgetValue(target, name, value) {
            target.widgets.find((widget) => widget.name === name).value = value;
        },
        clearScenePresetReferenceErrors(options) { cleared.push([...options.nodeIds]); },
        refreshScenePresetReference() {},
        refreshAllScenePresetReferences() {},
        closePopup() {},
    };
    vm.createContext(context);
    for (const name of ["beginSceneGraphChange", "endSceneGraphChange", "sceneNodeHasCurrentOwner", "withSceneUserChange",
        "sortedScenePresetCandidates", "openScenePresetPicker"]) vm.runInContext(functionSource(name), context);

    await context.openScenePresetPicker(node);
    buttons.find((button) => button.label === "Chosen").click();

    assert.equal(node.widgets[0].value, "chosen");
    assert.deepEqual(cleared, [[12]]);
    assert.deepEqual(history, ["before", "change", "after"]);
    buttons.find(button => button.label === "Chosen").click();
    assert.deepEqual(history, ["before", "change", "after"], "selecting the current Preset is a no-op");
    node.graph = null; node.widgets[0].value = "";
    buttons.find(button => button.label === "Chosen").click();
    assert.equal(node.widgets[0].value, "", "a removed popup owner is not changed");
    assert.deepEqual(history, ["before", "change", "after"]);
    let releasePaint, loads = 0;
    context.waitForModalPaint = () => new Promise(resolve => { releasePaint = resolve; });
    context.loadPopupRequest = async () => { loads++; return []; };
    const closed = context.openScenePresetPicker(node);
    context.activePopup = null;
    releasePaint(); await closed;
    assert.equal(loads, 0, "closing before paint avoids the Preset request");
    context.waitForModalPaint = async () => {};
    let releaseLoad;
    context.loadPopupRequest = () => new Promise(resolve => { releaseLoad = resolve; });
    const stale = context.openScenePresetPicker(node);
    await new Promise(setImmediate);
    context.activePopup = createElement("other popup");
    const beforeButtons = buttons.length;
    releaseLoad([{ preset_id: "stale", name: "Stale" }]); await stale;
    assert.equal(buttons.length, beforeButtons, "a late Preset list cannot replace another popup");
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
    vm.runInContext("let popupRequestIntent = 0;", context);
    for (const name of ["beginPopupRequest", "isCurrentPopupRequest", "invalidatePopupRequests", "loadPopupRequest"]) {
        vm.runInContext(functionSource(name), context);
    }
    const request = context.loadPopupRequest(node, () => pending, "候補を読み込めませんでした。");
    context.invalidatePopupRequests(node);
    resolveLoad(["late response"]);
    assert.equal(await request, null);
    assert.deepEqual(context.errors, []);
}

function testOverflowCountsDoNotStartABatchRun() {
    const errors = [];
    const context = {
        Map,
        sceneBatchRun: null,
        sceneBatchDetachedRuns: new Map(),
        sceneBatchPendingRuns: [],
        sceneBatchRunForNode() { return null; },
        sceneBatchRunStatus() { return "idle"; },
        syncSceneNodeModes() {}, syncAllScenePromptNames() {},
        sceneExpandCounts() { return { totalBatches: null, error: "件数が大きすぎます。" }; },
        createSceneBatchRun() { throw new Error("must not create"); },
        prepareSceneBatchRunSnapshot() { throw new Error("must not prepare"); },
        updateSceneExpandButton() {}, resetSceneExpandRunControls() {},
        showSceneBatchError(message, error) { errors.push([message, error.message]); },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("startSceneBatchRun"), context);
    context.startSceneBatchRun({ id: 1 });
    assert.deepEqual(errors, [["連続生成を開始できませんでした。", "件数が大きすぎます。"]]);
}

async function testPopupRequestsUseOneIntentAcrossNodes() {
    let resolveFirst;
    let resolveSecond;
    const firstLoad = new Promise((resolve) => { resolveFirst = resolve; });
    const secondLoad = new Promise((resolve) => { resolveSecond = resolve; });
    const graph = {};
    const context = { Number, app: { graph }, showSceneBatchError() {} };
    vm.createContext(context);
    vm.runInContext("let popupRequestIntent = 0;", context);
    for (const name of ["beginPopupRequest", "isCurrentPopupRequest", "invalidatePopupRequests", "loadPopupRequest"]) {
        vm.runInContext(functionSource(name), context);
    }
    const first = context.loadPopupRequest({ graph }, () => firstLoad, "failed");
    const secondNode = { graph };
    const second = context.loadPopupRequest(secondNode, () => secondLoad, "failed");
    resolveSecond("new popup");
    assert.equal(await second, "new popup", "the newer node may open its popup");
    resolveFirst("old popup");
    assert.equal(await first, null, "a slower node cannot replace a newer popup");
    let resolveClosed;
    const closedLoad = new Promise((resolve) => { resolveClosed = resolve; });
    const closed = context.loadPopupRequest(secondNode, () => closedLoad, "failed");
    context.invalidatePopupRequests(secondNode);
    resolveClosed("closed popup");
    assert.equal(await closed, null, "closing a popup invalidates its pending open");
}

function testLLMSettingsAlwaysLeadWithoutChangingStoredWidgets() {
    const context = vm.createContext({ String,
        sceneLLMValue: (node, name) => node.widgets.find(widget => widget.name === name)?.value ?? "",
        injectStyle() {}, installSceneConnectionWatcher() {}, hideWidget(widget) { widget.hidden = true; }, showWidget() {},
        findWidget: (node, name) => node.widgets.find(widget => widget.name === name),
        findSceneWidget: (node, role) => node.widgets.find(widget => widget.sceneRole === role),
        sceneLLMController: { busy: new Set() },
    });
    for (const name of ["addSceneButton", "attachSceneLLM"]) vm.runInContext(functionSource(name), context);
    const names = ["model_mode", "description", "positive", "negative", "generation_state_json"];
    const values = ["Anima", "saved description", "saved positive", "saved negative", '{"saved":true}'];
    const node = { widgets: names.map((name, index) => ({ name, value: values[index] })),
        addWidget(type, name, value, callback, options) { const widget = { type, name, value, callback, options }; this.widgets.push(widget); return widget; },
        addCustomWidget(widget) { this.widgets.push(widget); return widget; },
    };
    context.attachSceneLLM(node);
    const settings = node.widgets[0];
    assert.equal(settings.sceneRole, "llm_settings");
    assert.equal(settings.serialize, false);
    context.attachSceneLLM(node);
    assert.strictEqual(node.widgets[0], settings, "repeated attach reuses the first settings button");
    assert.equal(node.widgets.filter(widget => widget.sceneRole === "llm_settings").length, 1);
    assert.deepEqual(node.widgets.filter(widget => widget.serialize !== false).map(widget => [widget.name, widget.value]),
        names.map((name, index) => [name, values[index]]), "moving controls preserves the declared serialized widget order and values");
}

function testPromptSummariesUseComfyWeights() {
    const context = vm.createContext({ String, Number, Set, Map });
    for (const name of ["promptIdentity", "promptOverrideKey", "uniquePromptParts", "promptOverrideKeys", "mergePositiveNegativeParts"]) {
        vm.runInContext(functionSource(name), context);
    }
    const parts = Object.freeze(["First", "((TAG:4):0.5)", "(tag:1.2)", "(equal:1.)", "(EQUAL:1e0)",
        "(science:1_2e-1)", "(SCIENCE:1.1)", "(negative:-1)", "(NEGATIVE: -0.5 )", "last"]);
    assert.deepEqual(Array.from(context.uniquePromptParts(parts)), ["First", "((TAG:4):0.5)", "(equal:1.)",
        "(science:1_2e-1)", "(NEGATIVE: -0.5 )", "last"], "innermost weights win while first positions and equal spellings remain");
    assert.deepEqual(Array.from(context.uniquePromptParts(["((tag:0.5):4)", "tag", "(TAG:1.2)"])), ["(TAG:1.2)"]);
    for (const raw of ["1e0", "1.", "1_0e-1", "1.0_0", " .1e1 ", "+1_0.e-1", "1e+0_0"]) {
        assert.equal(context.promptOverrideKey(`(TAG:${raw})`), "tag", raw);
    }
    const distinct = ["tag", "(tag)", "[tag]", "(tag;1.4)", "(tag:NaN)", "(tag:Infinity)", "(tag:1e999)",
        "(tag:1__0)", "(tag:1_.0)", "(tag:0x10)", "(tag:1 0)", "<lora:tag:1>"];
    assert.deepEqual(Array.from(context.uniquePromptParts(distinct)), distinct, "implicit, invalid and nonfinite syntax stays distinct");
    const merged = context.mergePositiveNegativeParts(parts, ["(tag:.1)"], ["(tag:99)", "new"], ["(TAG:0.2)"]);
    assert.deepEqual(Array.from(merged.negativeParts), ["(TAG:0.2)"]);
    assert.equal(merged.positiveParts.some((part) => context.promptOverrideKey(part) === "tag"), false,
        "negative precedence ignores positive strength");
    assert.equal(parts[1], "((TAG:4):0.5)", "summary computation leaves its source intact");
    const deep = "(".repeat(5000) + "tag:4)" + ":1)".repeat(4999);
    assert.deepEqual(Array.from(context.uniquePromptParts([deep, "(tag:3)"])), [deep], "deep wrappers are processed without recursion");
}

async function testBatchStartPaintAndOwnership() {
    const helper = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_civitai.js"), "utf8")
        .match(/export function waitForModalPaint\(\) \{[\s\S]*?\n\}/u)[0].replace("export ", "");
    for (const scenario of ["start", "double", "removed", "other-tab", "throw", "existing", "residual"]) {
        const frames = [], calls = [], errors = [];
        const button = { name: "連続生成" };
        const graph = { getNodeById: () => node };
        const node = { id: 1, graph };
        const context = vm.createContext({
            Promise, requestAnimationFrame: callback => frames.push(callback), app: { graph },
            sceneBatchRunForNode: () => scenario === "existing" ? {} : null,
            sceneBatchNodeRunId: () => scenario === "residual" ? "stale" : "",
            findSceneWidget: (_node, role) => role === "expand_run_all" ? button : null,
            sceneLLMController: {}, sceneBatchRunStatus: () => "idle",
            markSceneNodeChanged() {},
            showSceneBatchError: (...args) => errors.push(args),
            startSceneBatchRun() { calls.push("start"); if (scenario === "throw") throw new Error("fixture failure"); },
        });
        vm.runInContext(helper, context);
        for (const name of ["sceneNodeHasCurrentOwner", "updateSceneExpandButton", "requestSceneBatchRun"]) vm.runInContext(functionSource(name), context);
        const pending = context.requestSceneBatchRun(node);
        if (["existing", "residual"].includes(scenario)) {
            assert.deepEqual(calls, ["start"]); assert.equal(frames.length, 0); await pending; continue;
        }
        assert.equal(button.name, "生成準備中"); assert.equal(button.disabled, true);
        assert.deepEqual(calls, []);
        if (scenario === "double") await context.requestSceneBatchRun(node);
        frames.shift()(); await Promise.resolve();
        assert.deepEqual(calls, [], "first frame must paint before preparation starts");
        if (scenario === "removed") node.graph = null;
        if (scenario === "other-tab") context.app.graph = {};
        frames.shift()(); await pending;
        assert.deepEqual(calls, ["removed", "other-tab"].includes(scenario) ? [] : ["start"]);
        assert.equal(errors.length, scenario === "throw" ? 1 : 0);
        assert.equal(node.sceneBatchStarting, undefined);
        assert.equal(button.disabled, false); assert.equal(button.name, "連続生成");
    }
}

Promise.resolve()
    .then(testBatchStartPaintAndOwnership)
    .then(testLLMSettingsAlwaysLeadWithoutChangingStoredWidgets)
    .then(testPromptSummariesUseComfyWeights)
    .then(testPresetReferenceCandidatesAreSortedByDisplayName)
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
    .then(testMatrixCommitWritesWholeDraftOnlyWhenChanged)
    .then(testMatrixEmptyNameUsesDefaultOnCommit)
    .then(testModalCommitsUseOnlyTheirActiveOwner)
    .then(testMatrixStateUsesFirstValidStoredValue)
    .then(testSourceOwnershipBoundaries)
    .then(testItemAndSavedPromptStaleRefreshesAdoptTheLatestResponse)
    .then(testItemAndSavedPromptStaleGetDoesNotAwaitItselfAfterPost)
    .then(testSavedPromptNormalLoadsShareOneInFlightRequest)
    .then(testOverlappingFormWritesInvalidateEarlierReadSnapshots)
    .then(testLiveWidgetStateWinsOverStaleSerializedValue)
    .then(testWorkflowLoadGuardMarksOnlyLoadWindow)
    .then(testWorkflowConnectionStormDefersSceneWork)
    .then(testWorkflowLoadDefersWidgetTriggeredRefreshes)
    .then(testWorkflowLoadFlushTraversesOldGraphOnce)
    .then(testPendingFifoRunPreparesPresetSnapshotImmediately)
    .then(testOverflowCountsDoNotStartABatchRun)
    .then(testPresetSaveDoesNotClaimRefreshSucceededAfterRefreshFailure)
    .then(testPresetSaveMarksOnlyTheReferenceReturnedByTheServer)
    .then(testPresetPickerClearsTheSelectedReferenceError)
    .then(testCancelledPickerRequestDoesNotReopenAfterNodeLifecycleChange)
    .then(testPopupRequestsUseOneIntentAcrossNodes)
    .then(() => console.log("Audit regression tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
