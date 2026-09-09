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
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

function lifecycleContext(response) {
    const release = deferred();
    const responses = Array.isArray(response) ? [...response] : null;
    const context = {
        Promise,
        Map,
        Set,
        String,
        JSON,
        Object,
        encodeURIComponent,
        setTimeout,
        console: { warn() {} },
        SCENE_CALLBACK_FINALIZE_POLL_MS: 0,
        SCENE_CALLBACK_FINALIZE_MAX_POLLS: 4,
        sceneBatchRun: null,
        sceneBatchRunsById: new Map(),
        sceneBatchPendingRuns: [{ runId: "next" }],
        sceneBatchPendingReleases: new Map(),
        sceneBatchFinalizingRuns: new Set(),
        sceneBatchTerminalEvents: new Map(),
        releaseCalls: [],
        activated: 0,
        scheduled: 0,
        errors: [],
        api: {
            async fetchApi(url, options) {
                context.fetches.push({ url, options });
                if (typeof response === "function") return response(url, options);
                return responses ? responses.shift() : response;
            },
        },
        fetches: [],
        async readApiJson(value) { return value.payload; },
        scenePromptInputSourceId(value) { return Array.isArray(value) ? String(value[0] || "") : ""; },
        sceneBatchEventMatchesRun(run, detail) { return String(detail?.prompt_id || "") === run.currentPromptId; },
        scenePromptIdFromValue(value) { return String(value?.prompt_id || ""); },
        sceneNodeForRun() { return null; },
        clearPendingSceneBatchReleasesForRun() {},
        resetSceneExpandRunControls() {},
        updateSceneExpandButton() {},
        refreshSceneBatchRunNode() {},
        async releaseSceneBatchPlan(runId) {
            context.releaseCalls.push(runId);
            return release.promise;
        },
        activateNextSceneBatchRun() { context.activated += 1; },
        scheduleNextSceneBatchItem() { context.scheduled += 1; },
        showSceneBatchError(message) { context.errors.push(message); },
        failSceneBatchRun() { throw new Error("unexpected failure"); },
        scheduleActiveSceneBatchReconcile() {},
    };
    vm.createContext(context);
    for (const name of [
        "sceneExpandHasLastCallback",
        "completeFinalSceneBatchRun",
        "finalizeSceneBatchRun",
        "continueSceneBatchRun",
    ]) {
        vm.runInContext(functionSource(name), context);
    }
    return { context, release };
}

function finalRun(withLast = true) {
    return {
        runId: "run-one",
        runHandle: "handle-one",
        nodeId: "9",
        total: 1,
        nextIndex: 0,
        waiting: true,
        promptAccepted: true,
        currentPromptId: "prompt-one",
        pendingPromptIds: new Set(["prompt-one"]),
        firstPromptSnapshot: {
            output: {
                "9": {
                    class_type: "ScenePrompterExpand",
                    inputs: withLast ? { callback_last: ["callback", 0] } : {},
                },
            },
        },
    };
}

async function testFinalCallbackWaitsBeforeReleaseAndFifo() {
    const response = deferred();
    const { context, release } = lifecycleContext(response.promise);
    const run = finalRun();
    context.sceneBatchRun = run;
    context.sceneBatchRunsById.set(run.runId, run);

    context.continueSceneBatchRun({ prompt_id: "prompt-one" });
    context.continueSceneBatchRun({ prompt_id: "prompt-one" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.fetches.length, 1, "a duplicated success event sends the final Callback once");
    assert.deepEqual(JSON.parse(context.fetches[0].options.body), {
        run_handle: "handle-one", expand_node_id: "9", prompt_id: "prompt-one",
    });
    assert.equal(context.releaseCalls.length, 0, "the context stays live while final Callback is pending");
    assert.equal(context.activated, 0, "the next FIFO run waits for final Callback");

    response.resolve({ ok: true, payload: { warnings: ["temporary transport error"] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(context.releaseCalls, ["run-one"], "final Callback completion releases its context");
    assert.equal(context.activated, 0, "release completion still gates the next FIFO run");
    release.resolve(true);
    await run.finalizePromise;
    assert.equal(context.activated, 1, "the next FIFO run starts after final Callback and release complete");
}

async function testFinalStopFailureDoesNotStartNextRun() {
    const { context, release } = lifecycleContext({ ok: false, payload: { error: "callback failed" } });
    const run = finalRun();
    context.sceneBatchRun = run;
    context.sceneBatchRunsById.set(run.runId, run);

    context.continueSceneBatchRun({ prompt_id: "prompt-one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(context.releaseCalls, ["run-one"], "a stopping final Callback failure still releases its context");
    release.resolve(true);
    await run.finalizePromise;
    assert.equal(context.activated, 0, "a stopping final Callback failure does not start later queued runs");
    assert.equal(context.errors.length, 1, "a stopping final Callback failure is visible");
}

async function testFinalCallbackPollsUntilBackendFinalizes() {
    const { context, release } = lifecycleContext([
        { ok: true, status: 202, payload: { state: "pending" } },
        { ok: true, status: 200, payload: { state: "finalized" } },
    ]);
    const run = finalRun();
    context.sceneBatchRun = run;
    context.sceneBatchRunsById.set(run.runId, run);

    context.continueSceneBatchRun({ prompt_id: "prompt-one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(context.fetches.length, 2, "a pending finalization is polled until the backend confirms completion");
    assert.equal(context.releaseCalls.length, 1, "release begins only after finalization is confirmed");
    release.resolve(true);
    await run.finalizePromise;
    assert.equal(context.activated, 1);
}

async function testHistorySuccessFinalizesBeforeRelease() {
    const { context, release } = lifecycleContext((url) => {
        if (url === "/history/prompt-one") {
            return { ok: true, payload: { "prompt-one": { status: { status_str: "success", completed: true } } } };
        }
        if (url === "/scene_prompt/runs/finalize") {
            return context.fetches.filter((entry) => entry.url === url).length === 1
                ? { ok: true, status: 202, payload: { state: "in_progress" } }
                : { ok: true, status: 200, payload: { state: "finalized" } };
        }
        throw new Error(`unexpected URL: ${url}`);
    });
    const run = finalRun();
    context.sceneBatchRun = run;
    context.sceneBatchRunsById.set(run.runId, run);
    vm.runInContext(functionSource("sceneHistoryStatus"), context);
    vm.runInContext(functionSource("reconcileActiveSceneBatchRun"), context);

    await context.reconcileActiveSceneBatchRun(run);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(context.fetches.map((entry) => entry.url), [
        "/history/prompt-one",
        "/scene_prompt/runs/finalize",
        "/scene_prompt/runs/finalize",
    ], "a delayed terminal event uses history success to enter the final Callback path");
    assert.deepEqual(context.releaseCalls, ["run-one"]);
    release.resolve(true);
    await run.finalizePromise;
    assert.equal(context.activated, 1);
}

function testNoLastCallbackUsesNormalCompletion() {
    const { context } = lifecycleContext({ ok: true, payload: {} });
    const run = finalRun(false);
    context.sceneBatchRun = run;
    context.continueSceneBatchRun({ prompt_id: "prompt-one" });
    assert.equal(context.fetches.length, 0, "an unconnected final Callback input is a no-op");
    assert.equal(context.scheduled, 1, "an unconnected final Callback uses the normal completion path");
}

Promise.resolve()
    .then(testFinalCallbackWaitsBeforeReleaseAndFifo)
    .then(testFinalStopFailureDoesNotStartNextRun)
    .then(testFinalCallbackPollsUntilBackendFinalizes)
    .then(testHistorySuccessFinalizesBeforeRelease)
    .then(testNoLastCallbackUsesNormalCompletion)
    .then(() => console.log("Scene Prompt final Callback lifecycle tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
