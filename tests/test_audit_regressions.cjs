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
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function presetListRaceContext(first, second) {
    const responses = [first.promise, second.promise];
    const context = {
        Array,
        Map,
        scenePresetList: null,
        scenePresetListErrors: [],
        scenePresetDisplayGraphs: new Map(),
        scenePresetListRequestGeneration: 0,
        scenePresetListPromise: null,
        api: { fetchApi: () => responses.shift() },
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

function testSourceOwnershipBoundaries() {
    assert.doesNotMatch(functionSource("hideInternalDomWidgets"), /document\.querySelectorAll/);
    assert.match(functionSource("attachSceneUtilityNode"), /node\.onRemoved/);
    assert.match(functionSource("attachSceneUtilityNode"), /cancelSceneBatchRunForNode\(this\)/);

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

Promise.resolve()
    .then(testPresetListRaceInNormalResponseOrder)
    .then(testPresetListRaceInReverseResponseOrder)
    .then(testNodeRemovalCancelsItsRun)
    .then(testMatrixToggleSavesOnlyEnabledState)
    .then(testSourceOwnershipBoundaries)
    .then(() => console.log("Audit regression tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
