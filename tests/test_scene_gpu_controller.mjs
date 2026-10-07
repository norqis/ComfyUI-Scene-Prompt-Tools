import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createGPUController, GPU_HANDOFF_SETTINGS } from "../web/scene_prompt_gpu.js";

const source = await readFile(new URL("../web/scene_prompt_ui.js", import.meta.url), "utf8");
function functionSource(name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert(start >= 0, name);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index++) {
        if (source[index] === "{") depth++;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed ${name}`);
}

function fixture({ on = false, bound = false } = {}) {
    const settings = { "ScenePrompt.ReleaseLLMBeforeImage": on }, calls = [], cleanupErrors = [];
    let nextPolicy = 0, nextPrompt = 0, queueOutcome = "accept", prepareFinish;
    const app = { extensionManager: { setting: { get: (id) => settings[id] } } };
    const api = {
        clientId: "client-a", authToken: "comfy-auth", apiKey: "comfy-key",
        // Mirror the official native API: data.extra_data is deliberately ignored.
        async queuePrompt(number, data, options) {
            const { output: prompt, workflow } = data;
            const body = {
                client_id: this.clientId, prompt,
                ...(options?.partialExecutionTargets ? { partial_execution_targets: options.partialExecutionTargets } : {}),
                extra_data: { auth_token_comfy_org: this.authToken, api_key_comfy_org: this.apiKey, extra_pnginfo: { workflow } },
                ...(number === -1 ? { front: true } : number ? { number } : {}),
            };
            const response = await this.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
            if (!response.ok) throw new Error("node validation failed");
            return response.json();
        },
        async fetchApi(path, options) {
            const body = JSON.parse(options.body); calls.push({ path, body, keepalive: options.keepalive });
            if (path.endsWith("gpu/prepare")) {
                const policyId = `policy-${++nextPolicy}`;
                if (prepareFinish) await prepareFinish.promise;
                return { ok: true, json: async () => ({ policy_id: policyId }) };
            }
            if (path === "/prompt") return { ok: queueOutcome !== "error", json: async () => queueOutcome === "empty" ? {} : { prompt_id: `prompt-${++nextPrompt}` } };
            return { ok: true, json: async () => ({ released: true }) };
        },
    };
    if (bound) api.queuePrompt = api.queuePrompt.bind(api);
    const resources = createGPUController({ app, api, onCleanupError: (error) => cleanupErrors.push(error) });
    const context = vm.createContext({
        app, api, sceneGPUController: resources,
        sceneBatchRun: null, sceneBatchRunsById: new Map(), sceneBatchDetachedRuns: new Map(),
        scenePromptSubmissionsById: new Map(),
        sceneBatchTerminalEvents: new Map(),
        syncSceneMatrixPromptInputs() {}, scenePromptSamplerSeedTargets: () => [], applySceneSourceNodeNames() {},
        randomizeStandardSceneSeeds() {}, sceneRunTargetNodes: () => [], applyRandomizedSamplerSeeds() {},
        scenePromptIdFromValue: (value) => value?.prompt_id || "", releaseSceneRunHandle: () => Promise.resolve(),
        showPromptValidationErrorFromThrown() {}, acceptSceneBatchPrompt() {},
        buildSceneBatchCachedPrompt: (prompt) => structuredClone(prompt),
    });
    for (const name of ["sceneBatchRunFromPrompt", "prepareSceneBatchGPU", "releaseSceneBatchGPU", "releaseSceneBatchPlan", "installSceneBatchPromptCapture"])
        vm.runInContext(functionSource(name), context);
    context.installSceneBatchPromptCapture();
    return { app, api, resources, context, settings, calls, cleanupErrors,
        queueOutcome: (outcome) => { queueOutcome = outcome; },
        delayPrepare() { let done; const promise = new Promise((resolve) => { done = resolve; }); prepareFinish = { promise }; return done; },
    };
}
const prompt = () => ({ output: { 7: { class_type: "KSampler", inputs: {} } }, workflow: { nodes: [], extra: {} } });
const continuousPrompt = (run, index = 0) => ({ ...prompt(), output: { 7: {
    class_type: "ScenePrompterExpand", inputs: { run_id: run.runId, current_index: index },
} } });
const settle = () => new Promise((done) => setImmediate(done));

assert(GPU_HANDOFF_SETTINGS.every((setting) => setting.type === "boolean" && setting.defaultValue === false));
for (const llm of [false, true]) for (const image of [false, true]) {
    const { settings, resources, calls } = fixture();
    settings["ScenePrompt.ReleaseComfyBeforeLLM"] = llm;
    settings["ScenePrompt.ReleaseLLMBeforeImage"] = image;
    assert.deepEqual(resources.snapshot(), { releaseComfyBeforeLLM: llm, releaseLLMBeforeImage: image });
    assert.equal(calls.length, 0, "reading independent native settings never requests resources");
}
{
    const { api, calls } = fixture();
    await api.queuePrompt(0, prompt());
    assert.deepEqual(calls.map(({ path }) => path), ["/prompt"], "OFF adds no resource HTTP or polling");
    assert(!("scene_gpu_policy" in calls[0].body.extra_data));
}
for (const outcome of ["accept", "error", "empty"]) {
    const { api, calls, queueOutcome } = fixture({ on: true }); queueOutcome(outcome);
    const submission = prompt();
    const result = api.queuePrompt(-1, submission, { partialExecutionTargets: ["7"] });
    if (outcome === "error") await assert.rejects(result, /node validation failed/);
    else await result;
    await settle();
    const sent = calls.find(({ path }) => path === "/prompt").body;
    assert.equal(sent.extra_data.scene_gpu_policy, "policy-1", "native POST body carries its policy");
    assert.equal(sent.extra_data.auth_token_comfy_org, "comfy-auth");
    assert.equal(sent.extra_data.api_key_comfy_org, "comfy-key");
    assert.deepEqual(sent.partial_execution_targets, ["7"]);
    assert.equal(sent.front, true);
    assert.doesNotMatch(JSON.stringify(sent.extra_data.extra_pnginfo), /policy-1|scene_gpu_policy/);
    assert.doesNotMatch(JSON.stringify(sent.prompt), /policy-1|scene_gpu_policy/);
    assert.equal(calls.filter(({ path }) => path.endsWith("gpu/release")).length, outcome === "accept" ? 0 : 1);
    assert.deepEqual(calls[0].body, { client_id: "client-a", continuous: false });
}
{
    const { api, resources, calls } = fixture({ on: true });
    const originalFetch = api.fetchApi;
    const slowQueue = async function (number, data) {
        await data.wait;
        return this.fetchApi("/prompt", { method: "POST", body: JSON.stringify({ prompt: data.output, extra_data: { marker: number } }) });
    };
    let finishA;
    const a = { ...prompt(), wait: new Promise((done) => { finishA = done; }) }, b = prompt();
    const pendingA = slowQueue.call(resources.queueClient(slowQueue, "a"), 1, a);
    await slowQueue.call(resources.queueClient(slowQueue, "b"), 2, b);
    finishA(); await pendingA;
    assert.deepEqual(calls.map(({ body }) => [body.extra_data.marker, body.extra_data.scene_gpu_policy]), [[2, "b"], [1, "a"]],
        "concurrent receiver transports keep policies with their own submission");
    assert.strictEqual(api.fetchApi, originalFetch, "global transport never changes");
}
for (const on of [false, true]) {
    const { api, calls } = fixture({ on, bound: true });
    if (on) {
        await assert.rejects(api.queuePrompt(0, prompt()), /Queue拡張/);
        await settle();
        assert(!calls.some(({ path }) => path === "/prompt"), "unsupported bound queues fail before admission");
        assert(calls.some(({ path }) => path.endsWith("gpu/release")), "failed compatibility check retires prepared policy");
    } else await api.queuePrompt(0, prompt());
}
for (const initial of [false, true]) {
    const { api, context, resources, settings, calls } = fixture({ on: initial });
    const run = { runId: "fifo-waiting", nodeId: 7, firstApiPending: true, nextIndex: 0,
        runHandle: "run-handle", gpuSettings: resources.snapshot(), gpuPolicyId: "" };
    context.sceneBatchRunsById.set(run.runId, run);
    // Its settings are captured at the click, before a FIFO wait in another tab.
    settings["ScenePrompt.ReleaseLLMBeforeImage"] = !initial;
    context.sceneBatchRun = run;
    run.firstPromptSnapshot = continuousPrompt(run);
    await api.queuePrompt(0, run.firstPromptSnapshot);
    assert.equal(calls.filter(({ path }) => path.endsWith("gpu/prepare")).length, initial ? 1 : 0);
    if (initial) {
        assert.equal(run.cachedPrompt.extra_data.scene_gpu_policy, "policy-1", "first cached snapshot carries the policy");
        assert.deepEqual(calls.find(({ path }) => path.endsWith("gpu/prepare")).body,
            { client_id: "client-a", continuous: true, run_handle: "run-handle" });
    }
    run.nextIndex = 1;
    await api.queuePrompt(0, run.cachedPrompt);
    assert.equal(calls.filter(({ path }) => path.endsWith("gpu/prepare")).length, initial ? 1 : 0, "continuous steps reuse one policy");
    await context.releaseSceneBatchPlan(run.runId);
    await context.releaseSceneBatchPlan(run.runId);
    assert.equal(calls.filter(({ path }) => path.endsWith("gpu/release")).length, initial ? 1 : 0, "completion releases once");
    assert.equal(run.gpuPolicyId, "");
    assert.equal(run.gpuPolicyPromise, null);
}
{
    const { context, resources, calls, delayPrepare } = fixture({ on: true });
    const run = { runId: "cancel-during-prepare", gpuSettings: resources.snapshot() };
    const finish = delayPrepare();
    const pending = context.prepareSceneBatchGPU(run);
    await context.releaseSceneBatchGPU(run);
    finish();
    await assert.rejects(pending, /停止/);
    assert.equal(calls.filter(({ path }) => path.endsWith("gpu/release")).length, 1, "a late preparation result is retired after stop");
    assert.equal(run.gpuPolicyPromise, null);
}
{
    const { resources, calls, settings, api } = fixture({ on: true });
    settings["ScenePrompt.ReleaseComfyBeforeLLM"] = true;
    const originalFetch = api.fetchApi;
    api.fetchApi = async function (path, options) {
        if (path.endsWith("/begin")) return { ok: true, json: async () => ({ session_id: "active-session" }) };
        return originalFetch.call(this, path, options);
    };
    await resources.beginLLM(resources.snapshot());
    await resources.prepareImage(resources.snapshot(), { continuous: true });
    resources.releaseOnPageHide({ persisted: true });
    assert(!calls.some(({ keepalive }) => keepalive));
    resources.releaseOnPageHide({ persisted: false });
    await settle();
    assert.deepEqual(calls.filter(({ keepalive }) => keepalive).map(({ path }) => path),
        ["/scene_prompt/llm/end", "/scene_prompt/gpu/release"], "page teardown retires both resource ownership kinds");
    const previous = calls.length;
    resources.releaseOnPageHide({ persisted: false }); await settle();
    assert.equal(calls.length, previous, "completed ownership is not retained by the browser");
}
{
    const { resources, calls, delayPrepare } = fixture({ on: true });
    const finish = delayPrepare();
    const pending = resources.prepareImage(resources.snapshot());
    resources.releaseOnPageHide({ persisted: false }); finish();
    await assert.rejects(pending, /ページ/);
    assert.equal(calls.at(-1).keepalive, true, "page teardown also retires a late policy response");
}
for (const cleanup of ["llm/end", "gpu/release"]) {
    const { resources, api, calls } = fixture({ on: true });
    const originalFetch = api.fetchApi;
    let fail = false, nextSession = 0;
    api.fetchApi = async function (path, options) {
        if (path.endsWith("llm/begin")) return { ok: true, json: async () => ({ session_id: `session-${++nextSession}` }) };
        if (path.endsWith(cleanup) && fail) {
            calls.push({ path, failed: true });
            throw new Error("temporary cleanup transport failure");
        }
        return originalFetch.call(this, path, options);
    };
    const id = cleanup === "llm/end" ? await resources.beginLLM({ releaseComfyBeforeLLM: true })
        : await resources.prepareImage(resources.snapshot());
    const release = cleanup === "llm/end" ? resources.endLLM : resources.releaseImage;
    fail = true;
    await assert.rejects(release(id), /temporary cleanup/);
    const before = calls.length;
    await assert.rejects(resources.prepareImage({ releaseLLMBeforeImage: false }), /temporary cleanup/);
    assert.equal(calls.length, before + 1, "persistent cleanup failure is attempted once and prevents new work");
    fail = false;
    const active = await resources.beginLLM({ releaseComfyBeforeLLM: true });
    assert.equal(calls.at(-1).path, `/scene_prompt/${cleanup}`, "next user action retires failed ownership before acquiring new resources");
    const recovered = calls.length;
    assert.equal(await resources.prepareImage({ releaseLLMBeforeImage: false }), "");
    assert.equal(calls.length, recovered, "an active LLM is not part of failed cleanup; OFF adds no request after recovery");
    await resources.endLLM(active);
    const complete = calls.length;
    resources.releaseOnPageHide({ persisted: false }); await settle();
    assert.equal(calls.length, complete, "successfully cleaned ownership is not retained");
}
{
    const { resources, api, calls } = fixture();
    const originalFetch = api.fetchApi;
    let fail = true;
    api.fetchApi = async function (path, options) {
        if (path.endsWith("llm/begin")) return { ok: true, json: async () => ({ session_id: "failed-at-hide" }) };
        if (path.endsWith("llm/end") && fail) throw new Error("end failed");
        return originalFetch.call(this, path, options);
    };
    const session = await resources.beginLLM({ releaseComfyBeforeLLM: true });
    await assert.rejects(resources.endLLM(session), /end failed/);
    fail = false;
    resources.releaseOnPageHide({ persisted: false }); await settle();
    assert.equal(calls.at(-1).path, "/scene_prompt/llm/end");
    assert.equal(calls.at(-1).keepalive, true, "pagehide retains a way to retire failed sessions");
}
console.log("GPU settings, native POST transport, concurrency, FIFO policy reuse, failed cleanup recovery and teardown tests passed.");
