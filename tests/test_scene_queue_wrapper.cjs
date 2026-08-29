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
    Object,
    String,
    Map,
    sceneBatchRun: null,
    sceneBatchDetachedRuns: new Map(),
    sceneRunHandlesByPromptId: new Map(),
    sceneRunTerminalPromptIds: new Set(),
    prepared: 0,
    queued: 0,
    released: [],
    api: {
        async queuePrompt(_number, prompt) {
            if (prompt.output?.["3"]) throw new Error("queue failed");
            context.queued += 1;
            return { prompt_id: `prompt-${context.queued}`, received: structuredClone(prompt) };
        },
        async fetchApi() { return { ok: true, payload: { claimed: true } }; },
    },
    async prepareSceneRunContext(prompt) {
        context.prepared += 1;
        for (const node of Object.values(prompt.output)) {
            if (["ScenePrompt", "SceneMatrix", "ScenePresetReference", "ScenePromptExpand"].includes(node.class_type)) {
                node.inputs.run_handle = "opaque-handle";
            }
        }
        return { run_handle: "opaque-handle" };
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
    const scenePrompt = { output: { "1": { class_type: "ScenePrompt", inputs: {} } } };
    const result = await context.api.queuePrompt(0, scenePrompt);
    assert.equal(context.prepared, 1, "Scene graph is prepared once");
    assert.equal(context.queued, 1, "wrapped queue calls the original once");
    assert.equal(result.received.output["1"].inputs.run_handle, "opaque-handle");

    await context.api.queuePrompt(0, { output: { "2": { class_type: "KSampler", inputs: {} } } });
    assert.equal(context.prepared, 1, "non-Scene graph skips preparation");
    assert.equal(context.queued, 2, "normal queue remains unchanged");

    await assert.rejects(
        () => context.api.queuePrompt(0, { output: { "3": { class_type: "ScenePrompt", inputs: {} } } }),
        /queue failed/,
    );
    assert.deepEqual(context.released, ["opaque-handle"], "failed queue releases its prepared handle");

    context.releaseCompletedSceneRun({ prompt_id: "fast-prompt" });
    context.registerQueuedSceneRunHandle("fast-prompt", "fast-handle");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        context.released,
        ["opaque-handle", "fast-handle"],
        "a completion arriving before the queue response releases the claimed handle once",
    );
    console.log("Scene Prompt queue wrapper wiring tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
