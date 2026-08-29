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
    let depth = 1;
    for (let index = bodyStart + 3; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed function: ${name}`);
}

function response(payload, ok = true) {
    return { ok, payload };
}

function reconcileContext(responses) {
    const context = {
        Map,
        Object,
        String,
        Array,
        encodeURIComponent,
        console: { warn() {} },
        sceneBatchPendingReleases: new Map(),
        sceneBatchDetachedRuns: new Map(),
        sceneBatchRunsById: new Map(),
        released: [],
        activated: 0,
        blocked: [],
        api: {
            async fetchApi(url) {
                const next = responses.shift();
                if (next instanceof Error) throw next;
                context.requests.push(url);
                return next;
            },
        },
        requests: [],
        async readApiJson(value) { return value.payload; },
        refreshSceneBatchRunNode() {},
        showSceneBatchError(message) { context.blocked.push(message); },
        clearDetachedSceneBatchRun() {},
        clearPendingSceneBatchReleasesForRun() {},
        releaseSceneBatchPlan(runId) { context.released.push(runId); },
        activateNextSceneBatchRun() { context.activated += 1; },
    };
    vm.createContext(context);
    for (const name of [
        "sceneQueueContainsPrompt",
        "markSceneBatchReleaseBlocked",
        "releaseDetachedSceneBatchRun",
        "reconcileDetachedSceneBatchRun",
    ]) vm.runInContext(functionSource(name), context);
    return context;
}

async function testHistoryTerminalReleasesOnceAndResumesFifo() {
    const context = reconcileContext([response({ "prompt-1": { status: {} } })]);
    assert.equal(context.sceneQueueContainsPrompt({ "prompt-1": { status: {} } }, "prompt-1"), true);
    const run = { runId: "run-1", currentPromptId: "prompt-1" };
    const reconciled = await context.reconcileDetachedSceneBatchRun(run);
    assert.equal(reconciled, true);
    assert.deepEqual(context.released, ["run-1"]);
    assert.equal(context.activated, 1);
    assert.equal(await context.reconcileDetachedSceneBatchRun(run), false);
    assert.deepEqual(context.released, ["run-1"]);
}

async function testAbsentFromHistoryAndQueueReleases() {
    const context = reconcileContext([response({}), response({ queue_running: [], queue_pending: [] })]);
    const run = { runId: "run-absent", currentPromptId: "prompt-absent" };
    assert.equal(await context.reconcileDetachedSceneBatchRun(run), true);
    assert.deepEqual(context.released, ["run-absent"]);
    assert.deepEqual(context.requests, ["/history/prompt-absent", "/queue"]);
}

async function testStillQueuedAndFetchFailureRemainBlocked() {
    const queued = reconcileContext([response({}), response({ queue_running: [[0, "prompt-queued"]] })]);
    const queuedRun = { runId: "run-queued", currentPromptId: "prompt-queued" };
    assert.equal(await queued.reconcileDetachedSceneBatchRun(queuedRun), false);
    assert.equal(queuedRun.releaseBlocked, true);
    assert.deepEqual(queued.released, []);

    const failed = reconcileContext([new Error("offline")]);
    const failedRun = { runId: "run-failed", currentPromptId: "prompt-failed" };
    assert.equal(await failed.reconcileDetachedSceneBatchRun(failedRun), false);
    assert.equal(failedRun.releaseBlocked, true);
    assert.deepEqual(failed.released, []);
}

async function testNonSceneQueueSkipsUserLookup() {
    const context = {
        Object,
        userRequests: 0,
        async currentScenePromptUserId() {
            context.userRequests += 1;
            throw new Error("user endpoint unavailable");
        },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("applyScenePromptUserId"), context);
    const graph = { output: { "1": { class_type: "KSampler", inputs: {} } } };
    assert.equal(await context.applyScenePromptUserId(graph), graph);
    assert.equal(context.userRequests, 0);
}

function testRemovalCleanupRunsOnceAndPreservesPreviousHandler() {
    let previousCalls = 0;
    const node = { sceneRefreshTimer: 0, onRemoved() { previousCalls += 1; } };
    const context = {
        Set,
        clearTimeout() {},
        sceneTitleSyncNodes: new Set([node]),
        sceneLoadedRefreshNodes: new Set([node]),
        sceneDownstreamRefreshSources: new Set([node]),
        activePopupContext: { node },
        closeCalls: 0,
        expandCancels: 0,
        clearSceneFitHeightTimer() {},
        closeAllPopups() { context.closeCalls += 1; },
        isSceneExpandNodeName(name) { return name === "ScenePromptExpand"; },
        cancelSceneBatchRunForNode() { context.expandCancels += 1; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("popupContextReferencesNode"), context);
    vm.runInContext(functionSource("installSceneNodeRemovalCleanup"), context);
    context.installSceneNodeRemovalCleanup(node, "ScenePromptExpand");
    context.installSceneNodeRemovalCleanup(node, "ScenePromptExpand");
    node.onRemoved();
    assert.equal(previousCalls, 1);
    assert.equal(context.closeCalls, 1);
    assert.equal(context.expandCancels, 1);
    assert.equal(context.sceneTitleSyncNodes.has(node), false);
    assert.equal(context.sceneLoadedRefreshNodes.has(node), false);
    assert.equal(context.sceneDownstreamRefreshSources.has(node), false);
}

assert.match(source, /if \(existingStatus === "blocked"\) \{\s*reconcileDetachedSceneBatchRun\(existingRun\);/u, "blocked controls retry reconciliation");

Promise.resolve()
    .then(testHistoryTerminalReleasesOnceAndResumesFifo)
    .then(testAbsentFromHistoryAndQueueReleases)
    .then(testStillQueuedAndFetchFailureRemainBlocked)
    .then(testNonSceneQueueSkipsUserLookup)
    .then(testRemovalCleanupRunsOnceAndPreservesPreviousHandler)
    .then(() => console.log("detached Scene Prompt run reconciliation tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
