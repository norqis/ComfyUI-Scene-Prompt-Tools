const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

function functionSource(name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    let depth = 0;
    for (let index = source.indexOf(") {", start) + 2; index < source.length; index++) {
        if (source[index] === "{") depth++;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function fixture() {
    let timerId = 0;
    const timers = new Map();
    const widgets = [
        { name: "run_id", value: "run-one" },
        { sceneRole: "expand_run_all", name: "停止" },
        { sceneRole: "expand_pause", name: "一時停止" },
    ];
    const node = { id: 41, widgets };
    node.graph = { getNodeById: () => node };
    const run = {
        runId: "run-one", runHandle: "handle-one", nodeId: 41, node,
        total: 4, nextIndex: 0, waiting: false, queueing: false, pauseRequested: false,
        currentPromptId: "", pendingPromptIds: new Set(), snapshotReady: true,
        firstPromptSnapshot: { output: { "41": { inputs: { prefix: "snapshot", callback_last: null } } } },
        currentSeed: 101,
    };
    const context = {
        Promise, Map, Set, String, JSON, Object, encodeURIComponent, queueMicrotask,
        sceneBatchRun: run, sceneBatchRunsById: new Map([[run.runId, run]]),
        sceneBatchDetachedRuns: new Map(), sceneBatchFinalizingRuns: new Set(),
        sceneBatchPendingRuns: [], sceneBatchTerminalEvents: new Map(),
        timers, queued: [], claims: [], warnings: [], errors: [], released: [], activated: 0, dirtied: 0, gpuCalls: 0,
        console: { warn(...args) { context.warnings.push(args); } },
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        sceneLLMController: { busy: new Set(), canGenerate: () => true },
        findSceneWidget: (target, role) => target.widgets.find((widget) => widget.sceneRole === role),
        findWidget: (target, name) => target.widgets.find((widget) => widget.name === name),
        sceneNodeHasCurrentOwner: (target) => target.graph?.getNodeById(target.id) === target,
        sceneNodeForRun: (target) => target?.node || null,
        markSceneNodeChanged() { context.dirtied++; },
        refreshSceneBatchRunNode(target) { if (target?.node) context.updateSceneExpandButton(target.node); },
        setWidgetValue() { return false; },
        sceneBatchSeedBase: () => 202,
        resetSceneExpandRunControls() {}, cancelSceneBatchRunPreparation() {},
        releaseSceneBatchGPU: async () => {}, sceneGPUController: {
            onCleanupError: assert.fail,
            async freeComfy() { context.gpuCalls++; },
        },
        clearPendingSceneBatchReleasesForRun() {},
        releaseSceneBatchPlan(id) { context.released.push(id); },
        activateNextSceneBatchRun() { if (!context.sceneBatchFinalizingRuns.size) context.activated++; },
        async queueSingleScenePrompt() {
            context.queued.push({ index: run.nextIndex, runId: run.runId, handle: run.runHandle, snapshot: run.firstPromptSnapshot, seed: run.currentSeed });
            return { prompt_id: `prompt-${context.queued.length}` };
        },
        scenePromptIdFromValue: (detail) => detail?.prompt_id || "",
        async claimSceneRunHandle(handle, prompt) { context.claims.push({ handle, prompt }); },
        pruneSceneBatchTerminalEvents() {},
        showSceneBatchError(...args) { context.errors.push(args); },
        markSceneBatchReleaseBlocked: assert.fail,
        failSceneBatchRun: assert.fail,
        clearDetachedSceneBatchRun() {},
        api: { async fetchApi(url) { context.fetches.push(url); return { ok: true, payload: {} }; } },
        fetches: [],
        readApiJson: async (response) => response.payload,
        sceneQueueContainsPrompt: () => true,
        scenePromptInputSourceId: (value) => Array.isArray(value) ? value[0] : "",
    };
    vm.createContext(context);
    for (const name of [
        "sceneBatchNodeRunId", "sceneBatchRunForNode", "sceneBatchRunStatus", "updateSceneExpandButton",
        "toggleSceneBatchPause", "settleSceneBatchPause", "queueNextSceneBatchItem", "scheduleNextSceneBatchItem",
        "sceneBatchEventMatchesRun", "continueSceneBatchRun", "acceptSceneBatchPrompt",
        "scheduleActiveSceneBatchReconcile", "reconcileActiveSceneBatchRun", "sceneHistoryStatus",
        "stopSceneBatchRun", "cancelSceneBatchRunForNode", "sceneExpandHasLastCallback", "completeFinalSceneBatchRun",
    ]) vm.runInContext(functionSource(name), context);
    const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
    const fire = async (delay) => {
        const entry = [...timers].find(([, timer]) => timer.delay === delay);
        assert.ok(entry, `missing ${delay}ms timer`);
        timers.delete(entry[0]); entry[1].callback(); await flush();
    };
    return { context, run, node, pause: widgets[2], flush, fire };
}

async function testPauseResumeAndLease() {
    const { context: c, run, node, pause, fire, flush } = fixture();
    const snapshot = run.firstPromptSnapshot;
    await c.queueNextSceneBatchItem();
    c.toggleSceneBatchPause(node);
    assert.equal(pause.name, "停止中..."); assert.equal(pause.disabled, true);
    c.toggleSceneBatchPause(node);
    assert.equal(run.pauseRequested, true, "cannot resume until queue/execution finishes");
    c.continueSceneBatchRun({ prompt_id: "unrelated" });
    assert.equal(run.nextIndex, 0);
    await fire(90_000);
    assert.deepEqual(c.fetches, ["/history/prompt-1", "/queue"], "waiting keeps normal reconciliation");
    assert.equal(c.claims.length, 2, "pause request refreshes the lease even during a long running prompt");
    c.continueSceneBatchRun({ prompt_id: "prompt-1" });
    assert.equal(pause.name, "停止中..."); await flush();
    assert.equal(run.nextIndex, 1); assert.equal(pause.name, "再開"); assert.equal(pause.disabled, false);
    assert.equal([...c.timers.values()].some((timer) => timer.delay === 120), false);
    for (let cycle = 0; cycle < 3; cycle++) await fire(90_000);
    assert.deepEqual(c.claims, Array(5).fill({ handle: "handle-one", prompt: "prompt-1" }));
    c.toggleSceneBatchPause(node);
    assert.equal(pause.name, "一時停止");
    assert.equal([...c.timers.values()].some((timer) => timer.delay === 90_000), false);
    await fire(120);
    assert.equal(run.claimedPromptId, "prompt-1", "later prompt IDs never replace the backend claim");
    c.toggleSceneBatchPause(node);
    c.continueSceneBatchRun({ prompt_id: "prompt-2" });
    await flush();
    await fire(90_000);
    assert.deepEqual(c.claims.at(-1), { handle: "handle-one", prompt: "prompt-1" });
    c.toggleSceneBatchPause(node); await fire(120);
    c.continueSceneBatchRun({ prompt_id: "prompt-3" });
    c.toggleSceneBatchPause(node); // Pause between completion and the next 120ms timer.
    await flush();
    assert.equal(pause.name, "再開");
    assert.equal([...c.timers.values()].some((timer) => timer.delay === 120), false);
    c.toggleSceneBatchPause(node); await fire(120);
    c.toggleSceneBatchPause(node);
    c.continueSceneBatchRun({ prompt_id: "prompt-4" });
    await run.finalizePromise;
    assert.equal(c.sceneBatchRun, null, "last completion takes priority over pause");
    assert.equal(pause.name, "一時停止"); assert.equal(pause.disabled, true);
    assert.equal(c.timers.size, 0);
    assert.deepEqual(c.queued.map((item) => item.index), [0, 1, 2, 3]);
    assert.ok(c.queued.every((item) => item.runId === run.runId && item.handle === run.runHandle && item.snapshot === snapshot));
    assert.deepEqual(c.queued.map((item) => item.seed), [101, 202, 202, 202]);
    assert.deepEqual(c.released, [run.runId]); assert.equal(c.activated, 1);
    assert.equal(c.gpuCalls, 4, "each pause cycle frees once, including a paused final item");
}

async function testSnapshotAndQueueAcknowledgementBarriers() {
    const { context: c, run, node, pause, flush } = fixture();
    const snapshot = deferred(); run.snapshotReady = false; run.snapshotPromise = snapshot.promise;
    const queue = c.queueNextSceneBatchItem();
    c.toggleSceneBatchPause(node); snapshot.resolve(); await queue; await flush();
    assert.equal(c.queued.length, 0, "pause requested while awaiting snapshot prevents submission");
    assert.equal(pause.name, "再開"); assert.equal(run.queueing, false);
    run.snapshotReady = true;
    c.toggleSceneBatchPause(node);
    const acknowledgement = deferred();
    c.queueSingleScenePrompt = () => acknowledgement.promise;
    const next = c.queueNextSceneBatchItem();
    c.acceptSceneBatchPrompt(run, { prompt_id: "early" });
    c.toggleSceneBatchPause(node);
    c.continueSceneBatchRun({ prompt_id: "early" });
    assert.equal(pause.name, "停止中...", "early terminal still waits for queue acknowledgement");
    acknowledgement.resolve({ prompt_id: "early" }); await next; await flush();
    assert.equal(pause.name, "再開"); assert.equal(pause.disabled, false);
    assert.equal(run.nextIndex, 1);
    assert.equal([...c.timers.values()].some((timer) => timer.delay === 120), false);
}

async function testCachedTerminalAndLeaseRetry() {
    const { context: c, run, node, pause, flush, fire } = fixture();
    c.sceneBatchTerminalEvents.set("prompt-1", { type: "success", detail: { prompt_id: "prompt-1" } });
    c.queueSingleScenePrompt = async () => { c.toggleSceneBatchPause(node); return { prompt_id: "prompt-1" }; };
    await c.queueNextSceneBatchItem(); await flush();
    assert.equal(run.nextIndex, 1); assert.equal(pause.name, "再開");
    c.claimSceneRunHandle = async () => { throw new Error("offline"); };
    await fire(90_000);
    assert.equal(c.warnings.length, 1); assert.equal(run.releaseBlocked, undefined);
    c.claimSceneRunHandle = async (handle, prompt) => c.claims.push({ handle, prompt });
    await fire(90_000);
    assert.equal(c.claims.length, 2, "failed keepalive retries next cycle");
    const request = deferred(); c.claimSceneRunHandle = () => request.promise;
    await fire(90_000);
    c.toggleSceneBatchPause(node); request.resolve(); await flush();
    assert.equal([...c.timers.values()].some((timer) => timer.delay === 90_000), false, "finishing keepalive cannot resurrect timer after resume");
}

async function testWaitingLeaseFailureStillReconcilesHistory() {
    const { context: c, run, node, fire } = fixture();
    await c.queueNextSceneBatchItem(); c.toggleSceneBatchPause(node);
    c.claimSceneRunHandle = async () => { throw new Error("temporary lease failure"); };
    await fire(90_000);
    assert.deepEqual(c.fetches, ["/history/prompt-1", "/queue"], "lease renewal failure cannot skip running prompt reconciliation");
    assert.equal(c.warnings.length, 1); assert.equal(run.waiting, true);
    assert.equal(run.releaseBlocked, undefined); assert.equal(c.sceneBatchRun, run);
    assert.equal([...c.timers.values()].filter((timer) => timer.delay === 90_000).length, 1);
}

async function testStopDeletionAndOwnership() {
    for (const remove of [false, true]) {
        const { context: c, run, node, flush } = fixture();
        await c.queueNextSceneBatchItem(); c.toggleSceneBatchPause(node);
        c.continueSceneBatchRun({ prompt_id: "prompt-1" });
        await flush();
        c.sceneBatchPendingRuns.push({ runId: "next-run" });
        if (remove) c.cancelSceneBatchRunForNode(node); else c.stopSceneBatchRun();
        assert.equal(c.sceneBatchRun, null); assert.equal(c.timers.size, 0);
        assert.deepEqual(c.released, [run.runId]); assert.equal(c.activated, 1);
    }
    const { context: c, run, node, pause } = fixture();
    const otherTab = { id: node.id, widgets: [{ name: "run_id", value: "other-run" }], graph: node.graph };
    c.toggleSceneBatchPause(otherTab); assert.equal(run.pauseRequested, false);
    node.graph.getNodeById = () => otherTab;
    c.toggleSceneBatchPause(node); assert.equal(run.pauseRequested, false, "removed node cannot control current run");
    node.graph.getNodeById = () => node;
    for (const state of ["preparing", "finalizing", "releaseBlocked", "cancelled"]) {
        run[state] = true; c.updateSceneExpandButton(node); c.toggleSceneBatchPause(node);
        assert.equal(run.pauseRequested, false); assert.equal(pause.disabled, true); run[state] = false;
    }
    c.updateSceneExpandButton(node); const dirty = c.dirtied;
    run.queueing = true; run.pauseRequested = true; c.updateSceneExpandButton(node);
    run.queueing = false; c.updateSceneExpandButton(node);
    assert.ok(c.dirtied > dirty, "label and enabled changes redraw controls");
}

async function testGPUReleaseAndRetryBeforeResume() {
    const { context: c, run, node, pause, flush } = fixture();
    const gpu = deferred();
    c.sceneGPUController.freeComfy = () => { c.gpuCalls++; return gpu.promise; };
    await c.queueNextSceneBatchItem(); c.toggleSceneBatchPause(node);
    assert.equal(c.gpuCalls, 0, "running prompt must finish and save before freeing models");
    c.continueSceneBatchRun({ prompt_id: "prompt-1" });
    assert.equal(c.gpuCalls, 1); assert.equal(pause.name, "停止中..."); assert.equal(pause.disabled, true);
    await c.toggleSceneBatchPause(node); c.settleSceneBatchPause(run);
    assert.equal(c.gpuCalls, 1, "draining clicks/refreshes share the existing release promise");
    assert.equal(run.nextIndex, 1); assert.equal(c.queued.length, 1);
    gpu.resolve(); await flush();
    assert.equal(pause.name, "再開"); assert.equal(run.pauseGPUReleased, true);
    await c.toggleSceneBatchPause(node);
    assert.equal(run.pauseRequested, false); assert.equal(c.gpuCalls, 1, "successful release is not repeated by resume");

    const retry = fixture();
    const r = retry.context;
    r.sceneGPUController.freeComfy = async () => { r.gpuCalls++; throw new Error("GPU busy"); };
    await r.toggleSceneBatchPause(retry.node); await retry.flush();
    assert.equal(retry.pause.name, "再開"); assert.equal(retry.run.pauseRequested, true);
    assert.equal(r.errors.length, 1);
    await r.toggleSceneBatchPause(retry.node);
    assert.equal(retry.run.pauseRequested, true, "failed retry cannot resume generation");
    assert.equal(r.errors.length, 2);
    r.sceneGPUController.freeComfy = async () => { r.gpuCalls++; };
    await r.toggleSceneBatchPause(retry.node);
    assert.equal(retry.run.pauseRequested, false); assert.equal(r.gpuCalls, 3);
    assert.equal([...r.timers.values()].filter((timer) => timer.delay === 120).length, 1);
}

async function testStopDuringGPUReleaseAndTerminalFailure() {
    for (const fail of [false, true]) {
        const { context: c, run, node, flush } = fixture();
        let resolveGPU, rejectGPU;
        c.sceneGPUController.freeComfy = () => new Promise((resolve, reject) => { resolveGPU = resolve; rejectGPU = reject; });
        c.toggleSceneBatchPause(node);
        c.stopSceneBatchRun();
        assert.equal(c.sceneBatchRun, null); assert.equal(c.activated, 0);
        assert.equal(c.sceneBatchFinalizingRuns.has(run), true, "stopped run blocks fresh/FIFO runs while reset is outstanding");
        if (fail) rejectGPU(new Error("GPU cleanup failed")); else resolveGPU();
        await flush();
        assert.equal(c.sceneBatchFinalizingRuns.size, 0); assert.equal(c.activated, 1);
        assert.equal(c.timers.size, 0); assert.equal(c.errors.length, 0);
        assert.equal(c.warnings.length, fail ? 1 : 0);
    }
    const { context: c, run, node, pause, flush } = fixture();
    run.total = 1;
    let rejectGPU;
    c.sceneGPUController.freeComfy = () => new Promise((_resolve, reject) => { rejectGPU = reject; });
    await c.queueNextSceneBatchItem(); c.toggleSceneBatchPause(node);
    c.continueSceneBatchRun({ prompt_id: "prompt-1" });
    assert.notEqual(pause.name, "再開", "final item never offers resume during GPU release");
    assert.equal(c.released.length, 0, "terminal plan cleanup waits for GPU release");
    assert.equal(c.sceneBatchFinalizingRuns.has(run), true);
    rejectGPU(new Error("terminal GPU release failed")); await run.finalizePromise; await flush();
    assert.equal(c.activated, 0, "terminal cleanup failure holds later FIFO runs");
    assert.deepEqual(c.released, [run.runId]); assert.equal(c.sceneBatchFinalizingRuns.size, 0);
    assert.equal(pause.name, "一時停止"); assert.equal(pause.disabled, true);
    assert.equal(c.warnings.length, 1);
    assert.equal(c.errors.length, 1, "terminal release failure explains why later FIFO runs did not start");
}

Promise.resolve().then(testPauseResumeAndLease)
    .then(testSnapshotAndQueueAcknowledgementBarriers)
    .then(testCachedTerminalAndLeaseRetry)
    .then(testWaitingLeaseFailureStillReconcilesHistory)
    .then(testStopDeletionAndOwnership)
    .then(testGPUReleaseAndRetryBeforeResume)
    .then(testStopDuringGPUReleaseAndTerminalFailure)
    .then(() => console.log("Scene Prompt pause/resume lifecycle tests passed."))
    .catch((error) => { console.error(error); process.exitCode = 1; });
