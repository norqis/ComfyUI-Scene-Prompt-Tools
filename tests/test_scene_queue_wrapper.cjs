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

const context = {
    sceneGPUController: {
        snapshot: () => ({ releaseComfyBeforeLLM: false, releaseLLMBeforeImage: false }),
        prepareImage: async () => "", releaseImage: async () => {}, applyImagePolicy() {},
        acceptImage() {}, queueClient: () => context.api, onCleanupError: (error) => { throw error; },
    },
    sceneBatchSeedBase() { return 123456; },
    Date,
    Object,
    JSON,
    String,
    Map,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    app: { graph: { serialize() { return { version: 1, nodes: [{ id: 99, type: "ScenePresetReference", widgets_values: ["saved"] }] }; } } },
    sceneBatchRun: null,
    sceneBatchRunsById: new Map(),
    activePopupContext: null,
    sceneBatchDetachedRuns: new Map(),
    sceneRunHandlesByPromptId: new Map(),
    sceneRunTerminalPromptIds: new Map(),
    sceneBatchTerminalEvents: new Map(),
    SCENE_RUN_TERMINAL_RETENTION_MS: 10 * 60 * 1000,
    prepared: 0,
    queued: 0,
    released: [],
    nodesById: new Map(),
    sceneNodeById(nodeId) { return context.nodesById.get(String(nodeId)) || null; },
    readMatrixState(node) { return node.matrixState; },
    serializeMatrixState(state) { return JSON.stringify(state); },
    api: {
        async queuePrompt(_number, prompt) {
            if (prompt.output?.["3"]) throw new Error("queue failed");
            if (prompt.output?.["4"]) return { received: structuredClone(prompt) };
            context.queued += 1;
            return { prompt_id: `prompt-${context.queued}`, received: structuredClone(prompt) };
        },
        async fetchApi() { return { ok: true, payload: { claimed: true } }; },
    },
    async prepareSceneRunContext(prompt) {
        context.prepared += 1;
        const handle = `opaque-handle-${context.prepared}`;
        for (const node of Object.values(prompt.output)) {
            if (["ScenePrompter", "SceneMatrix", "ScenePresetReference", "ScenePrompterExpand"].includes(node.class_type)) {
                node.inputs.run_handle = handle;
            }
        }
        return { run_handle: handle };
    },
    scenePromptIdFromValue(value) { return value?.prompt_id || ""; },
    async readApiJson(response) { return response.payload; },
    showPromptValidationErrorFromThrown() {},
    releaseSceneRunHandle(handle) { context.released.push(handle); },
    registerQueuedSceneRunHandle(promptId, handle) { context.sceneRunHandlesByPromptId.set(promptId, handle); },
    acceptSceneBatchPrompt() {},
    prepareSceneBatchGPU: async () => "",
    releaseSceneBatchGPU: async () => {},
    buildSceneBatchCachedPrompt() { return null; },
    applySceneSourceNodeNames() {},
    SCENE_PLAN_NODE_CLASS_TYPES: new Set([
        "ScenePrompter", "SceneMatrix", "ScenePath", "ScenePrompterMerge",
        "ScenePromptCounter", "ScenePrompterQueue", "SceneEmptyLatent", "ScenePresetReference",
        "ScenePromptCallback", "ScenePromptCallbackDiscord", "ScenePromptCallbackRequest",
    ]),
};
vm.createContext(context);
let terminalClock = 1000, terminalContinued = 0;
const terminalRun = { waiting: true, pendingPromptIds: new Set() };
const terminalContext = vm.createContext({ Map, Set, Date: { now: () => terminalClock },
    SCENE_RUN_TERMINAL_RETENTION_MS: 10 * 60 * 1000,
    sceneBatchTerminalEvents: new Map(), sceneBatchRun: terminalRun,
    scenePromptIdFromValue: (detail) => detail.prompt_id,
    scheduleActiveSceneBatchReconcile() {}, refreshSceneBatchRunNode() {},
    queueMicrotask: (callback) => callback(), continueSceneBatchRun: () => { terminalContinued++; },
});
for (const name of ["rememberSceneBatchTerminalEvent", "pruneSceneBatchTerminalEvents", "acceptSceneBatchPrompt"])
    vm.runInContext(functionSource(name), terminalContext);
for (let index = 0; index < 100; index++) terminalContext.rememberSceneBatchTerminalEvent("success", { prompt_id: `terminal-${index}` });
assert.equal(terminalContext.sceneBatchTerminalEvents.size, 100, "pending terminal delivery records survive beyond former count thresholds");
terminalContext.acceptSceneBatchPrompt(terminalRun, { prompt_id: "terminal-0" });
assert.equal(terminalContinued, 1);
assert(!terminalContext.sceneBatchTerminalEvents.has("terminal-0"), "accepted terminal delivery is consumed exactly once");
terminalClock += terminalContext.SCENE_RUN_TERMINAL_RETENTION_MS;
terminalContext.rememberSceneBatchTerminalEvent("success", { prompt_id: "terminal-current" });
assert.equal(terminalContext.sceneBatchTerminalEvents.size, 1, "subsequent terminal access retires only expired records");
assert(terminalContext.sceneBatchTerminalEvents.has("terminal-current"));
assert.equal(terminalRun.waiting, true, "terminal retention never evicts an accepted active run");
for (const name of [
    "randomizeStandardSceneSeeds",
    "sceneBatchRunFromPrompt",
    "sceneRunTargetNodes",
    "sceneHistoryStatus",
    "pruneSceneRunTerminalPromptIds",
    "pruneSceneBatchTerminalEvents",
    "rememberSceneBatchTerminalEvent",
    "rememberSceneRunTerminalPromptId",
    "consumeSceneRunTerminalPromptId",
    "claimSceneRunHandle",
    "registerQueuedSceneRunHandle",
    "releaseCompletedSceneRun",
    "samplerSeedControlWidget",
    "captureRandomizedSamplerSeedTargets",
    "scenePromptWorkflowNodes",
    "samplerSeedControlValue",
    "randomSamplerSeed",
    "applyRandomizedSamplerSeeds",
    "scenePromptSamplerSeedTargets",
    "commitActiveMatrixLineDraft",
    "syncSceneMatrixPromptInputs",
    "installSceneBatchPromptCapture",
]) {
    vm.runInContext(functionSource(name), context);
}

context.installSceneBatchPromptCapture();
context.installSceneBatchPromptCapture();

(async () => {
    const scenePrompt = { output: { "1": { class_type: "ScenePrompter", inputs: {} } } };
    const result = await context.api.queuePrompt(0, scenePrompt);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.prepared, 1, "Scene graph is prepared once");
    assert.equal(context.queued, 1, "wrapped queue calls the original once");
    assert.equal(result.received.output["1"].inputs.run_handle, "opaque-handle-1");
    assert.equal(context.sceneRunHandlesByPromptId.get("prompt-1"), "opaque-handle-1");
    context.releaseCompletedSceneRun({ prompt_id: "prompt-1" });
    context.releaseCompletedSceneRun({ prompt_id: "prompt-1" });
    assert.deepEqual(context.released, ["opaque-handle-1"], "claim-before-terminal and duplicate terminal release once");

    await context.api.queuePrompt(0, { output: { "2": { class_type: "KSampler", inputs: {} } } });
    assert.equal(context.prepared, 1, "non-Scene graph skips preparation");
    assert.equal(context.queued, 2, "normal queue remains unchanged");

    context.nodesById.set("7", {
        type: "SceneMatrix",
        matrixState: { version: 1, sets: [{ row_id: "new-first", enabled: true }] },
    });
    context.activePopupContext = {
        node: { sceneMatrixLineDraftContext: { commitDrafts() {
            context.nodesById.get("7").matrixState = { version: 1, sets: [{ row_id: "weight-draft", enabled: true, weight: 1.2 }] };
        } } },
    };
    const staleMatrix = await context.api.queuePrompt(0, { output: {
        "7": {
            class_type: "SceneMatrix",
            inputs: {
                matrix_json: JSON.stringify({ version: 1, sets: [{ row_id: "old", enabled: false }] }),
                run_handle: "existing-handle",
            },
        },
        "8": {
            class_type: "ScenePrompterExpand",
            inputs: { scene_prompt: ["7", 0], run_id: "", run_handle: "existing-handle" },
        },
    } });
    assert.deepEqual(
        JSON.parse(staleMatrix.received.output["7"].inputs.matrix_json),
        context.nodesById.get("7").matrixState,
        "normal Queue submits the current Matrix enabled state and row order",
    );
    assert.equal(JSON.parse(staleMatrix.received.output["7"].inputs.matrix_json).sets[0].weight, 1.2, "normal Queue commits an open Matrix weight draft before serializing it");
    assert.equal(context.prepared, 2, "normal Queue replaces serialized handles with fresh preparation");
    assert.equal(staleMatrix.received.output["7"].inputs.run_handle, "opaque-handle-2");
    assert.equal(staleMatrix.received.output["8"].inputs.run_handle, "opaque-handle-2");

    await assert.rejects(
        () => context.api.queuePrompt(0, { output: { "3": { class_type: "ScenePrompter", inputs: {} } } }),
        /queue failed/,
    );
    assert.deepEqual(context.released, ["opaque-handle-1", "opaque-handle-3"], "failed queue releases its prepared handle");

    await context.api.queuePrompt(0, { output: { "4": { class_type: "ScenePrompter", inputs: {} } } });
    assert.equal(context.released.at(-1), "opaque-handle-4", "a queue response without prompt_id releases its prepared handle");

    context.releaseCompletedSceneRun({ prompt_id: "fast-prompt" });
    context.registerQueuedSceneRunHandle("fast-prompt", "fast-handle");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        context.released,
        ["opaque-handle-1", "opaque-handle-3", "opaque-handle-4", "fast-handle"],
        "a completion arriving before the queue response releases the claimed handle once",
    );

    context.sceneRunTerminalPromptIds.clear();
    for (let index = 0; index < 100; index += 1) {
        context.releaseCompletedSceneRun({ prompt_id: `early-${index}` });
    }
    assert.equal(context.sceneRunTerminalPromptIds.size, 100, "more than 64 early completions remain retained");
    context.registerQueuedSceneRunHandle("early-0", "early-handle");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.released.at(-1), "early-handle");

    context.sceneRunTerminalPromptIds.clear();
    context.rememberSceneRunTerminalPromptId("expired", 1_000);
    context.pruneSceneRunTerminalPromptIds(1_000 + context.SCENE_RUN_TERMINAL_RETENTION_MS);
    assert.equal(context.sceneRunTerminalPromptIds.size, 0, "early completion markers expire after ten minutes");

    context.sceneRunTerminalPromptIds.clear();
    for (let index = 0; index < 300; index += 1) {
        context.releaseCompletedSceneRun({ prompt_id: `overflow-${index}` });
    }
    assert.equal(context.sceneRunTerminalPromptIds.size, 300, "early completion markers are not evicted by count");
    context.registerQueuedSceneRunHandle("overflow-0", "overflow-handle");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.released.at(-1), "overflow-handle", "the earliest retained marker releases its handle");
    assert.equal(context.sceneRunHandlesByPromptId.has("overflow-0"), false);

    const standardScene = await context.api.queuePrompt(0, { output: {
        "5": { class_type: "ScenePrompterExpand", inputs: {
            current_index: 2, run_id: "", seed_base: 41, seed_base_literal: true,
        } },
    } });
    assert.equal(standardScene.received.output["5"].inputs.current_index, 2, "normal Queue keeps the selected Scene row");
    assert.equal(standardScene.received.output["5"].inputs.seed_base, 123456, "normal Queue shares a fresh positive seed");
    assert.equal(standardScene.received.output["5"].inputs.seed_base_literal, false);

    const continuousScene = await context.api.queuePrompt(0, { output: {
        "6": { class_type: "ScenePrompterExpand", inputs: {
            current_index: 3, run_id: "continuous-run", seed_base: 42, seed_base_literal: false,
        } },
    } });
    assert.equal(continuousScene.received.output["6"].inputs.seed_base, 42, "continuous runs keep their per-batch seed");

    for (const name of ["applySceneRunHandle", "prepareSceneRunContext"]) {
        vm.runInContext(functionSource(name), context);
    }
    let preparedPayload = null;
    context.api.fetchApi = async (_path, options) => {
        preparedPayload = JSON.parse(options.body);
        return { ok: true, payload: { run_handle: "two-expand-handle" } };
    };
    const multiExpand = {
        workflow: { version: 1, nodes: [{ id: 99, type: "ScenePresetReference", widgets_values: ["saved"] }] },
        output: {
            "1": { class_type: "ScenePrompter", inputs: {} },
            "10": { class_type: "ScenePrompterExpand", inputs: { scene_prompt: ["1", 0] } },
            "20": { class_type: "ScenePrompterExpand", inputs: { scene_prompt: ["1", 0] } },
        },
    };
    context.app.graph.serialize = () => { throw new Error("A captured prompt must not read the active tab"); };
    await context.prepareSceneRunContext(multiExpand);
    assert.equal(preparedPayload.expand_node_id, null, "standard Queue prepares all Expand branches, not the first one");
    assert.deepEqual(preparedPayload.workflow, { version: 1, nodes: [{ id: 99, type: "ScenePresetReference", widgets_values: ["saved"] }] });
    assert.equal(multiExpand.output["10"].inputs.run_handle, "two-expand-handle");
    assert.equal(multiExpand.output["20"].inputs.run_handle, "two-expand-handle");

    for (const name of ["cloneScenePromptPayload", "scenePromptInputSourceId", "scenePromptInputSources", "buildSceneBatchCachedPrompt"]) {
        vm.runInContext(functionSource(name), context);
    }
    const cachedWithCallback = context.buildSceneBatchCachedPrompt({ output: {
        "1": { class_type: "ScenePrompter", inputs: {} },
        "2": { class_type: "ScenePromptCallback", inputs: { scene_prompt: ["1", 0], callback: ["3", 0] } },
        "3": { class_type: "ScenePromptCallbackDiscord", inputs: {} },
        "4": {
            class_type: "ScenePrompterExpand",
            inputs: {
                scene_prompt: ["2", 0],
                callback_first: ["5", 0],
                callback_each: ["6", 0],
                callback_last: ["7", 0],
            },
        },
        "5": { class_type: "ScenePromptCallbackDiscord", inputs: {} },
        "6": { class_type: "ScenePromptCallbackRequest", inputs: {} },
        "7": { class_type: "ScenePromptCallbackDiscord", inputs: {} },
        "99": { class_type: "ScenePrompter", inputs: {} },
    } }, "4");
    assert.equal(cachedWithCallback.output["4"].inputs.scene_prompt, undefined, "cached Expand removes only its consumed Scene input");
    assert.equal(cachedWithCallback.output["2"], undefined, "Callback is stripped from each cached loop prompt");
    assert.equal(cachedWithCallback.output["1"], undefined, "Callback's consumed upstream Scene plan is stripped too");
    assert.equal(cachedWithCallback.output["3"], undefined, "Callback configuration is stripped with its unused executor");
    assert.deepEqual(cachedWithCallback.output["4"].inputs.callback_first, ["5", 0], "cached Expand keeps its first Callback input");
    assert.deepEqual(cachedWithCallback.output["4"].inputs.callback_each, ["6", 0], "cached Expand keeps its each Callback input");
    assert.deepEqual(cachedWithCallback.output["4"].inputs.callback_last, ["7", 0], "cached Expand keeps its last Callback input");
    assert.ok(cachedWithCallback.output["5"], "cached Expand keeps its first Callback configuration");
    assert.ok(cachedWithCallback.output["6"], "cached Expand keeps its each Callback configuration");
    assert.ok(cachedWithCallback.output["7"], "cached Expand keeps its last Callback configuration");
    assert.equal(cachedWithCallback.output["99"], undefined, "unrelated plan nodes remain stripped from cached loop prompts");
    let preparations = 0;
    context.api.fetchApi = async (url) => ({ ok: true, payload: url.endsWith("/prepare")
        ? { run_handle: `fresh-${++preparations}` } : { claimed: true } });
    for (const handles of [["legacy-run", "", ""], ["expired", "other-run", "another-run"], ["same", "same", "same"]]) {
        const prompt = { output: {
            10: { class_type: "ScenePresetReference", inputs: { preset_id: "saved", run_handle: handles[0] } },
            20: { class_type: "ScenePrompterExpand", inputs: { scene_prompt: ["10", 0], run_handle: handles[1] } },
            30: { class_type: "ScenePrompterExpand", inputs: { scene_prompt: ["10", 0], run_handle: handles[2] } },
        } };
        const before = preparations;
        for (let repetition = 1; repetition <= 2; repetition++) {
            const queued = await context.api.queuePrompt(0, prompt);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(preparations, before + repetition, "every normal execution prepares once, including reusing the same prompt object");
            const current = `fresh-${preparations}`;
            assert.deepEqual(Object.values(queued.received.output).map(node => node.inputs.run_handle), [current, current, current]);
            assert.equal(context.sceneRunHandlesByPromptId.get(queued.prompt_id), current);
            context.releaseCompletedSceneRun(queued);
            assert.equal(context.released.at(-1), current);
        }
    }
    for (const detached of [false, true]) {
        const run = { runId: "owned-run", runHandle: "owned-snapshot", samplerSeedTargets: [], firstApiPending: false };
        (detached ? context.sceneBatchDetachedRuns : context.sceneBatchRunsById).set(run.runId, run);
        context.sceneBatchRun = detached ? null : run;
        const before = preparations;
        for (let index = 0; index < 3; index++) {
            const queued = await context.api.queuePrompt(0, { output: {
                10: { class_type: "ScenePresetReference", inputs: { preset_id: "saved", run_handle: run.runHandle } },
                20: { class_type: "ScenePrompterExpand", inputs: { run_id: run.runId, current_index: index, run_handle: run.runHandle } },
            } });
            assert.equal(preparations, before, "owned batch iterations reuse their captured preparation");
            assert.deepEqual(Object.values(queued.received.output).map(node => node.inputs.run_handle), [run.runHandle, run.runHandle]);
        }
        context.sceneBatchRun = null; context.sceneBatchRunsById.clear(); context.sceneBatchDetachedRuns.clear();
    }
    await testSubmissionLifetime();
    console.log("Scene Prompt queue wrapper wiring and terminal/removal lifetime tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

async function testSubmissionLifetime() {
    const tick = () => new Promise(resolve => setTimeout(resolve, 5));
    for (const scene of [false, true]) for (const type of ["success", "error", "interrupted"])
    for (const order of ["before-response", "before-claim", "after-claim"]) {
        const workflow = { activeState: { nodes: [{ widgets_values: ["large workflow"] }] } };
        let next = 0;
        const ctx = {
            sceneBatchRun: null, sceneBatchDetachedRuns: new Map(), sceneBatchTerminalEvents: new Map(),
            scenePromptSubmissionsById: new Map(), sceneRunHandlesByPromptId: new Map(), sceneRunTerminalPromptIds: new Map(),
            sceneProgressNodeIdsByPromptId: new Map(), sceneExecutingPromptId: "", SCENE_RUN_TERMINAL_RETENTION_MS: 600000,
            setTimeout, clearTimeout, console,
            sceneGPUController: { snapshot: () => ({}), prepareImage: async () => "", applyImagePolicy() {},
                queueClient: () => ctx.api, acceptImage() {}, releaseImage: async () => {}, onCleanupError() {} },
            syncSceneMatrixPromptInputs() {}, scenePromptSamplerSeedTargets: () => [], applySceneSourceNodeNames() {},
            randomizeStandardSceneSeeds() {}, applyRandomizedSamplerSeeds() {}, sceneWorkflowFromPrompt: () => workflow,
            sceneRunTargetNodes: () => scene ? [{}] : [],
            prepareSceneRunContext: async () => ({ run_handle: `handle-${next + 1}` }),
            scenePromptIdFromValue: value => value?.prompt_id || "",
            claimSceneRunHandle: async (_handle, promptId) => {
                if (order === "before-claim") { ctx.receiveScenePromptTerminal(type, { prompt_id: promptId }); await tick(); }
            },
            released: [], releaseSceneRunHandle: handle => ctx.released.push(handle),
            continueSceneBatchRun() {}, failSceneBatchRun() {}, releasePendingSceneBatchPlan() {},
            api: { async queuePrompt() {
                const prompt_id = `id-${++next}`;
                if (order === "before-response" || (!scene && order === "before-claim")) {
                    ctx.receiveScenePromptTerminal(type, { prompt_id }); await tick();
                }
                return { prompt_id };
            } },
        };
        vm.createContext(ctx);
        for (const name of ["installSceneBatchPromptCapture", "rememberSceneBatchTerminalEvent", "pruneSceneBatchTerminalEvents",
            "pruneSceneRunTerminalPromptIds", "rememberSceneRunTerminalPromptId", "consumeSceneRunTerminalPromptId",
            "registerQueuedSceneRunHandle", "releaseCompletedSceneRun", "forgetScenePromptSubmission", "receiveScenePromptTerminal"])
            vm.runInContext(functionSource(name), ctx);
        ctx.installSceneBatchPromptCapture();
        for (let index = 0; index < 10; index++) {
            const result = await ctx.api.queuePrompt(0, { output: {} });
            await tick();
            if (order === "after-claim") ctx.receiveScenePromptTerminal(type, result);
            await tick();
            assert.equal(ctx.scenePromptSubmissionsById.size, 0, `${scene}/${type}/${order}: no closed workflow references remain`);
            assert.equal(ctx.sceneRunHandlesByPromptId.size, 0);
            assert.equal(ctx.sceneProgressNodeIdsByPromptId.size, 0);
        }
        assert.equal(ctx.released.length, scene ? 10 : 0, "release each claimed handle once");
        for (const id of ["running", "pending-a", "pending-b"]) {
            ctx.scenePromptSubmissionsById.set(id, { workflow });
            ctx.sceneRunHandlesByPromptId.set(id, id);
        }
        ctx.receiveScenePromptTerminal("interrupted", { prompt_id: "pending-a" }); await tick();
        assert.deepEqual([...ctx.scenePromptSubmissionsById.keys()], ["running", "pending-b"]);
        ctx.receiveScenePromptTerminal("interrupted", { prompt_id: "pending-b" }); await tick();
        assert.deepEqual([...ctx.scenePromptSubmissionsById.keys()], ["running"]);
        assert.deepEqual([...ctx.sceneRunHandlesByPromptId.keys()], ["running"]);
    }
}
