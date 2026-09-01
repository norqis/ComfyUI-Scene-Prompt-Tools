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
    sceneBatchDetachedRuns: new Map(),
    sceneRunHandlesByPromptId: new Map(),
    sceneRunTerminalPromptIds: new Map(),
    sceneRunHandleReconcileTimers: new Map(),
    SCENE_RUN_TERMINAL_MAX: 256,
    SCENE_RUN_TERMINAL_RETENTION_MS: 10 * 60 * 1000,
    sceneRunTerminalOverflowUntil: 0,
    prepared: 0,
    queued: 0,
    released: [],
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
    buildSceneBatchCachedPrompt() { return null; },
};
vm.createContext(context);
for (const name of [
    "sceneRunTargetNodes",
    "sceneHistoryStatus",
    "pruneSceneRunTerminalPromptIds",
    "rememberSceneRunTerminalPromptId",
    "consumeSceneRunTerminalPromptId",
    "clearQueuedSceneRunReconcile",
    "reconcileQueuedSceneRunHandle",
    "claimSceneRunHandle",
    "registerQueuedSceneRunHandle",
    "releaseCompletedSceneRun",
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

    await assert.rejects(
        () => context.api.queuePrompt(0, { output: { "3": { class_type: "ScenePrompter", inputs: {} } } }),
        /queue failed/,
    );
    assert.deepEqual(context.released, ["opaque-handle-1", "opaque-handle-2"], "failed queue releases its prepared handle");

    await context.api.queuePrompt(0, { output: { "4": { class_type: "ScenePrompter", inputs: {} } } });
    assert.equal(context.released.at(-1), "opaque-handle-3", "a queue response without prompt_id releases its prepared handle");

    context.releaseCompletedSceneRun({ prompt_id: "fast-prompt" });
    context.registerQueuedSceneRunHandle("fast-prompt", "fast-handle");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        context.released,
        ["opaque-handle-1", "opaque-handle-2", "opaque-handle-3", "fast-handle"],
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
    for (let index = 0; index < 257; index += 1) {
        context.releaseCompletedSceneRun({ prompt_id: `overflow-${index}` });
    }
    assert.equal(context.sceneRunTerminalPromptIds.size, 256);
    assert.ok(context.sceneRunTerminalOverflowUntil > Date.now());
    context.api.fetchApi = async (url) => {
        if (url === "/scene_prompt/runs/claim") return { ok: true, payload: { claimed: true } };
        if (url === "/history/overflow-0") {
            return { ok: true, payload: { "overflow-0": { status: { status_str: "success", completed: true } } } };
        }
        throw new Error(`unexpected request: ${url}`);
    };
    context.registerQueuedSceneRunHandle("overflow-0", "overflow-handle");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.released.at(-1), "overflow-handle", "overflow history reconciliation prevents a leaked handle");
    assert.equal(context.sceneRunHandlesByPromptId.has("overflow-0"), false);

    for (const name of ["applySceneRunHandle", "prepareSceneRunContext"]) {
        vm.runInContext(functionSource(name), context);
    }
    let preparedPayload = null;
    context.api.fetchApi = async (_path, options) => {
        preparedPayload = JSON.parse(options.body);
        return { ok: true, payload: { run_handle: "two-expand-handle" } };
    };
    const multiExpand = {
        output: {
            "1": { class_type: "ScenePrompter", inputs: {} },
            "10": { class_type: "ScenePrompterExpand", inputs: { scene_prompt: ["1", 0] } },
            "20": { class_type: "ScenePrompterExpand", inputs: { scene_prompt: ["1", 0] } },
        },
    };
    await context.prepareSceneRunContext(multiExpand);
    assert.equal(preparedPayload.expand_node_id, null, "standard Queue prepares all Expand branches, not the first one");
    assert.deepEqual(preparedPayload.workflow, { version: 1, nodes: [{ id: 99, type: "ScenePresetReference", widgets_values: ["saved"] }] });
    assert.equal(multiExpand.output["10"].inputs.run_handle, "two-expand-handle");
    assert.equal(multiExpand.output["20"].inputs.run_handle, "two-expand-handle");
    console.log("Scene Prompt queue wrapper wiring tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
