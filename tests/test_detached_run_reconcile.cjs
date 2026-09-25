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
        sceneBatchFinalizingRuns: new Set(),
        sceneBatchRunsById: new Map(),
        sceneBatchPendingRuns: [],
        sceneBatchRun: null,
        SCENE_DETACHED_RETRY_MS: 30_000,
        scheduled: [],
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            context.scheduled.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            context.scheduled = context.scheduled.filter((entry) => entry !== timer);
        },
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
        findWidget(node, name) { return node?.widgets?.find((widget) => widget.name === name); },
    };
    vm.createContext(context);
    for (const name of [
        "sceneQueueContainsPrompt",
        "markSceneBatchReleaseBlocked",
        "releaseDetachedSceneBatchRun",
        "scheduleDetachedSceneBatchReconcile",
        "reconcileDetachedSceneBatchRun",
        "sceneBatchNodeRunId",
        "sceneBatchRunForNode",
        "cancelSceneBatchRunForNode",
    ]) vm.runInContext(functionSource(name), context);
    return context;
}

function detachedUiReleaseContext(responses = []) {
    const workflow = { path: "workflows/first.json" };
    const graph = {};
    const button = { sceneRole: "expand_run_all", name: "停止処理中" };
    const count = { sceneRole: "expand_total_count", value: "1 / 2" };
    const node = {
        id: 17,
        graph,
        widgets: [{ name: "run_id", value: "" }, button, count],
        setDirtyCanvas() {},
    };
    const foreignNode = {
        id: 17,
        graph: {},
        widgets: [
            { name: "run_id", value: "" },
            { sceneRole: "expand_run_all", name: "別ワークフロー" },
            { sceneRole: "expand_total_count", value: "別件数" },
        ],
    };
    graph.getNodeById = () => node;
    const run = {
        runId: "stopped-run",
        nodeId: 17,
        node,
        graph,
        workflow,
        currentPromptId: "stopped-prompt",
        controlsResetPending: false,
        nextIndex: 1,
        total: 2,
        snapshotReady: true,
    };
    const next = { runId: "next-run" };
    const context = {
        Map,
        Set,
        Object,
        String,
        Array,
        Number,
        Math,
        encodeURIComponent,
        console: { warn() {} },
        app: {
            graph,
            canvas: { setDirty() {} },
            extensionManager: { workflow: { activeWorkflow: workflow } },
        },
        sceneBatchRun: null,
        sceneBatchRunsById: new Map([[run.runId, run], [next.runId, next]]),
        sceneBatchDetachedRuns: new Map([[run.runId, run]]),
        sceneBatchFinalizingRuns: new Set(),
        sceneBatchPendingRuns: [next],
        sceneBatchPendingReleases: new Map([[
            run.currentPromptId,
            { runId: run.runId, timer: { name: "terminal-timeout" } },
        ]]),
        sceneBatchTerminalEvents: new Map([[run.currentPromptId, { type: "success" }]]),
        SCENE_DETACHED_RETRY_MS: 30_000,
        requests: [],
        released: [],
        activationSnapshots: [],
        scheduled: [],
        api: {
            async fetchApi(url) {
                context.requests.push(url);
                return responses.shift();
            },
        },
        async readApiJson(value) { return value.payload; },
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            context.scheduled.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            context.scheduled = context.scheduled.filter((entry) => entry !== timer);
        },
        findWidget(target, name) { return target?.widgets?.find((widget) => widget.name === name); },
        findSceneWidget(target, role) { return target?.widgets?.find((widget) => widget.sceneRole === role); },
        sceneExpandCounts() { return { totalBatches: 2, totalImages: null }; },
        resetSceneExpandRunControls() { throw new Error("controls were already reset by Stop"); },
        clearPendingSceneBatchReleasesForRun() {},
        releaseSceneBatchPlan(runId) { context.released.push(runId); },
        refreshSceneBatchRunNode() {},
        showSceneBatchError() {},
        activateNextSceneBatchRun() {
            context.activationSnapshots.push({ button: button.name, count: count.value });
            context.sceneBatchRun = context.sceneBatchPendingRuns.shift() || null;
        },
    };
    vm.createContext(context);
    for (const name of [
        "sceneBatchNodeRunId",
        "sceneWorkflowManager",
        "sceneActiveWorkflow",
        "sceneWorkflowsMatch",
        "sceneBatchRunForNode",
        "sceneBatchRunStatus",
        "sceneNodeForRun",
        "markSceneNodeChanged",
        "updateSceneExpandButton",
        "sceneExpandCountLabel",
        "updateSceneExpandCountWidget",
        "clearDetachedSceneBatchRun",
        "scenePromptIdFromValue",
        "releasePendingSceneBatchPlan",
        "sceneQueueContainsPrompt",
        "markSceneBatchReleaseBlocked",
        "releaseDetachedSceneBatchRun",
        "scheduleDetachedSceneBatchReconcile",
        "reconcileDetachedSceneBatchRun",
    ]) vm.runInContext(functionSource(name), context);
    return { context, run, next, node, foreignNode, button, count };
}

function assertDetachedUiReleased(fixture) {
    const { context, run, next, foreignNode, button, count } = fixture;
    assert.equal(context.sceneBatchDetachedRuns.has(run.runId), false);
    assert.equal(button.name, "連続生成", "the completed stopped run returns to its idle button label");
    assert.equal(count.value, "2回", "the completed stopped run returns to its idle count");
    assert.deepEqual(
        context.activationSnapshots,
        [{ button: "連続生成", count: "2回" }],
        "the stopped node is redrawn before the next FIFO run activates",
    );
    assert.equal(context.sceneBatchRun, next);
    assert.equal(foreignNode.widgets[1].name, "別ワークフロー");
    assert.equal(foreignNode.widgets[2].value, "別件数");
}

function testTerminalEventReleaseRestoresDetachedUiAndActivatesNext() {
    const fixture = detachedUiReleaseContext();
    fixture.context.releasePendingSceneBatchPlan({ prompt_id: fixture.run.currentPromptId });
    assertDetachedUiReleased(fixture);
}

async function testHistoryReconcileReleaseRestoresDetachedUiAndActivatesNext() {
    const fixture = detachedUiReleaseContext([
        response({ "stopped-prompt": { status: { status_str: "success", completed: true } } }),
    ]);
    assert.equal(await fixture.context.reconcileDetachedSceneBatchRun(fixture.run), true);
    assert.deepEqual(fixture.context.requests, ["/history/stopped-prompt"]);
    assertDetachedUiReleased(fixture);
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
    queued.sceneBatchDetachedRuns.set(queuedRun.runId, queuedRun);
    assert.equal(await queued.reconcileDetachedSceneBatchRun(queuedRun), false);
    assert.equal(queuedRun.releaseBlocked, true);
    assert.deepEqual(queued.released, []);
    assert.equal(queued.scheduled.length, 1);
    assert.equal(queued.scheduled[0].delay, 30_000);
    queuedRun.detachedTimer = null;
    queuedRun.nodeRemoved = true;
    queued.scheduled.length = 0;
    queued.scheduleDetachedSceneBatchReconcile(queuedRun);
    assert.equal(queued.scheduled.length, 1, "a removed node keeps a safe recovery check after retry saturation");
    assert.deepEqual(queued.released, [], "a still-queued run is never released because its node was removed");

    const failed = reconcileContext([new Error("offline")]);
    const failedRun = { runId: "run-failed", currentPromptId: "prompt-failed" };
    failed.sceneBatchDetachedRuns.set(failedRun.runId, failedRun);
    assert.equal(await failed.reconcileDetachedSceneBatchRun(failedRun), false);
    assert.equal(failedRun.releaseBlocked, true);
    assert.deepEqual(failed.released, []);
    assert.equal(failed.scheduled.length, 1);
}

async function testDeletingBlockedDetachedNodeReconcilesAndResumesFifo() {
    const context = reconcileContext([response({}), response({ queue_running: [], queue_pending: [] })]);
    const graph = {};
    const node = { id: 7, graph, widgets: [{ name: "run_id", value: "deleted-run" }] };
    const run = {
        runId: "deleted-run",
        nodeId: 7,
        node,
        graph,
        currentPromptId: "deleted-prompt",
        releaseBlocked: true,
    };
    context.sceneBatchRunsById.set(run.runId, run);
    context.sceneBatchDetachedRuns.set(run.runId, run);

    context.cancelSceneBatchRunForNode(node);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(run.nodeRemoved, true);
    assert.deepEqual(context.released, ["deleted-run"]);
    assert.equal(context.activated, 1);
}

function activeReconcileContext(history) {
    const run = { runId: "active", currentPromptId: "prompt-active", waiting: true };
    const context = {
        String,
        encodeURIComponent,
        console: { warn() {} },
        sceneBatchRun: run,
        api: { async fetchApi() { return response(history); } },
        async readApiJson(value) { return value.payload; },
        sceneQueueContainsPrompt() { return false; },
        continued: 0,
        failed: 0,
        scheduled: 0,
        continueSceneBatchRun() { context.continued += 1; run.waiting = false; },
        failSceneBatchRun() { context.failed += 1; run.waiting = false; },
        scheduleActiveSceneBatchReconcile() { context.scheduled += 1; },
    };
    vm.createContext(context);
    for (const name of ["sceneHistoryStatus", "reconcileActiveSceneBatchRun"]) {
        vm.runInContext(functionSource(name), context);
    }
    return context;
}

async function testMissedTerminalHistoryUsesItsActualStatus() {
    const success = activeReconcileContext({
        "prompt-active": { status: { status_str: "success", completed: true } },
    });
    await success.reconcileActiveSceneBatchRun(success.sceneBatchRun);
    assert.equal(success.continued, 1);
    assert.equal(success.failed, 0);
    assert.equal(success.scheduled, 0, "continueSceneBatchRun owns scheduling");

    const error = activeReconcileContext({
        "prompt-active": { status: { status_str: "error", completed: false } },
    });
    await error.reconcileActiveSceneBatchRun(error.sceneBatchRun);
    assert.equal(error.continued, 0);
    assert.equal(error.failed, 1);
}

async function testClaimFailureHistoryCompletionUsesRealCleanupPath() {
    const active = {
        runId: "blocked-active",
        runHandle: "blocked-handle",
        currentPromptId: "",
        waiting: true,
        promptAccepted: false,
        pendingPromptIds: new Set(),
        nextIndex: 0,
        total: 1,
    };
    const next = { runId: "next-run", cancelled: false };
    const context = {
        Map,
        Set,
        String,
        Array,
        Object,
        Math,
        encodeURIComponent,
        queueMicrotask,
        console: { warn() {} },
        sceneBatchRun: active,
        sceneBatchRunsById: new Map([[active.runId, active], [next.runId, next]]),
        sceneBatchDetachedRuns: new Map(),
        sceneBatchFinalizingRuns: new Set(),
        sceneBatchPendingRuns: [next],
        sceneBatchPendingReleases: new Map(),
        sceneBatchTerminalEvents: new Map(),
        released: [],
        activated: [],
        errors: [],
        timers: [],
        api: {
            async fetchApi(url) {
                if (url === "/scene_prompt/runs/claim") {
                    return response({ claimed: false });
                }
                assert.equal(url, "/history/blocked-prompt");
                return response({
                    "blocked-prompt": { status: { status_str: "success", completed: true } },
                });
            },
        },
        async readApiJson(value) { return value.payload; },
        sceneQueueContainsPrompt() { return false; },
        sceneNodeForRun() { return null; },
        clearSceneSavePreviews() {},
        prepareSceneBatchRunSnapshot(run) { context.activated.push(`prepare:${run.runId}`); },
        queueNextSceneBatchItem() { context.activated.push(`queue:${context.sceneBatchRun.runId}`); },
        releaseSceneRunHandle(handle) { context.released.push(handle); },
        refreshSceneBatchRunNode() {},
        showSceneBatchError(message) { context.errors.push(message); },
        clearTimeout(timer) { context.timers = context.timers.filter((item) => item !== timer); },
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            context.timers.push(timer);
            return timer;
        },
    };
    vm.createContext(context);
    for (const name of [
        "sceneBatchRunStatus",
        "sceneHistoryStatus",
        "scenePromptIdFromValue",
        "sceneBatchEventMatchesRun",
        "markSceneBatchReleaseBlocked",
        "claimSceneRunHandle",
        "acceptSceneBatchPrompt",
        "clearPendingSceneBatchReleasesForRun",
        "releaseSceneBatchPlan",
        "activateNextSceneBatchRun",
        "stopSceneBatchRun",
        "scheduleNextSceneBatchItem",
        "continueSceneBatchRun",
        "failSceneBatchRun",
        "scheduleActiveSceneBatchReconcile",
        "reconcileActiveSceneBatchRun",
    ]) {
        vm.runInContext(functionSource(name), context);
    }

    context.acceptSceneBatchPrompt(active, { prompt_id: "blocked-prompt" });
    await active.runClaimPromise;
    assert.equal(active.releaseBlocked, true, "the real failed claim marks the active run for cleanup");
    assert.equal(context.sceneBatchRunStatus(active), "active", "release failure does not detach the active global run");
    await context.reconcileActiveSceneBatchRun(active);

    assert.equal(context.sceneBatchRun, next, "successful history cleanup activates the next FIFO run");
    assert.equal(context.sceneBatchRunsById.has(active.runId), false);
    assert.deepEqual(context.released, ["blocked-handle"]);
    assert.deepEqual(context.activated, ["prepare:next-run", "queue:next-run"]);
}

function testNonSceneQueueSkipsRunPreparation() {
    const context = { Object };
    vm.createContext(context);
    vm.runInContext(functionSource("sceneRunTargetNodes"), context);
    const graph = { output: { "1": { class_type: "KSampler", inputs: {} } } };
    assert.equal(context.sceneRunTargetNodes(graph).length, 0);
}

function testRemovalCleanupRunsOnceAndPreservesPreviousHandler() {
    let previousCalls = 0;
    let loraModalCleanupCalls = 0;
    const node = {
        sceneRefreshTimer: 0,
        sceneLoraDetailsCleanup() { loraModalCleanupCalls += 1; },
        onRemoved() { previousCalls += 1; },
    };
    const context = {
        Set,
        clearTimeout() {},
        sceneTitleSyncNodes: new Set([node]),
        sceneLoadedRefreshNodes: new Set([node]),
        sceneDownstreamRefreshSources: new Set([node]),
        sceneWorkflowLoadDepth: 0,
        activePopupContext: { node },
        closeCalls: 0,
        expandCancels: 0,
        clearSceneFitHeightTimer() {},
        invalidatePopupRequests() {},
        closeAllPopups() { context.closeCalls += 1; },
        isSceneExpandNodeName(name) { return name === "ScenePrompterExpand"; },
        cancelSceneBatchRunForNode() { context.expandCancels += 1; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("popupContextReferencesNode"), context);
    vm.runInContext(functionSource("closeSceneLoraDetails"), context);
    vm.runInContext(functionSource("installSceneNodeRemovalCleanup"), context);
    context.installSceneNodeRemovalCleanup(node, "ScenePrompterExpand");
    context.installSceneNodeRemovalCleanup(node, "ScenePrompterExpand");
    node.onRemoved();
    assert.equal(previousCalls, 1);
    assert.equal(context.closeCalls, 1);
    assert.equal(context.expandCancels, 1);
    assert.equal(loraModalCleanupCalls, 1, "node removal disposes an open LoRA modal exactly once");
    assert.equal(node.sceneLoraDetailsCleanup, null);
    assert.equal(context.sceneTitleSyncNodes.has(node), false);
    assert.equal(context.sceneLoadedRefreshNodes.has(node), false);
    assert.equal(context.sceneDownstreamRefreshSources.has(node), false);
}

function testWorkflowTabLoadDoesNotCancelExpandRun() {
    const node = { sceneRefreshTimer: 0, onRemoved() {} };
    const context = {
        Set,
        clearTimeout() {},
        sceneTitleSyncNodes: new Set([node]),
        sceneLoadedRefreshNodes: new Set([node]),
        sceneDownstreamRefreshSources: new Set([node]),
        sceneWorkflowLoadDepth: 1,
        activePopupContext: null,
        clearSceneFitHeightTimer() {},
        invalidatePopupRequests() {},
        closeAllPopups() {},
        popupContextReferencesNode() { return false; },
        isSceneExpandNodeName(name) { return name === "ScenePrompterExpand"; },
        cancellations: 0,
        cancelSceneBatchRunForNode() { context.cancellations += 1; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("closeSceneLoraDetails"), context);
    vm.runInContext(functionSource("installSceneNodeRemovalCleanup"), context);
    context.installSceneNodeRemovalCleanup(node, "ScenePrompterExpand");
    node.onRemoved();
    assert.equal(context.cancellations, 0, "workflow loading must not cancel a queued Expand run");
}

Promise.resolve()
    .then(testTerminalEventReleaseRestoresDetachedUiAndActivatesNext)
    .then(testHistoryReconcileReleaseRestoresDetachedUiAndActivatesNext)
    .then(testHistoryTerminalReleasesOnceAndResumesFifo)
    .then(testAbsentFromHistoryAndQueueReleases)
    .then(testStillQueuedAndFetchFailureRemainBlocked)
    .then(testDeletingBlockedDetachedNodeReconcilesAndResumesFifo)
    .then(testMissedTerminalHistoryUsesItsActualStatus)
    .then(testClaimFailureHistoryCompletionUsesRealCleanupPath)
    .then(testNonSceneQueueSkipsRunPreparation)
    .then(testRemovalCleanupRunsOnceAndPreservesPreviousHandler)
    .then(testWorkflowTabLoadDoesNotCancelExpandRun)
    .then(() => console.log("detached Scene Prompt run reconciliation tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
