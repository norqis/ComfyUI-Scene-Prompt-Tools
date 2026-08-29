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

function releaseContext(responses) {
    const context = {
        Map,
        Set,
        String,
        JSON,
        Promise,
        console: { warn() {} },
        sceneRunReleaseStates: new Map(),
        sceneRunHandlesByPromptId: new Map(),
        sceneBatchRunsById: new Map(),
        sceneBatchDetachedRuns: new Map(),
        calls: [],
        api: {
            async fetchApi(url, options) {
                context.calls.push({ url, options });
                const result = responses.shift();
                if (result instanceof Error) throw result;
                if (result?.promise) return result.promise;
                return result;
            },
        },
        async readApiJson(response) { return response.payload; },
        setTimeout(callback) { callback(); return 0; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("releaseSceneRunHandle"), context);
    vm.runInContext(functionSource("releaseSceneRunsOnPageHide"), context);
    return context;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

(async () => {
    const recovered = releaseContext([
        new Error("temporary one"),
        new Error("temporary two"),
        { ok: true, payload: { released: true } },
    ]);
    assert.equal(await recovered.releaseSceneRunHandle("retry-handle"), true);
    assert.equal(recovered.calls.length, 3);
    assert.equal(recovered.sceneRunReleaseStates.has("retry-handle"), false);

    const failed = releaseContext([
        new Error("offline"),
        new Error("offline"),
        new Error("offline"),
    ]);
    assert.equal(await failed.releaseSceneRunHandle("failed-handle"), false);
    assert.equal(failed.calls.length, 3);
    assert.equal(failed.sceneRunReleaseStates.has("failed-handle"), false);

    const retryAfterFailure = releaseContext([
        new Error("offline"),
        new Error("offline"),
        new Error("offline"),
        { ok: true, payload: { released: true } },
    ]);
    assert.equal(await retryAfterFailure.releaseSceneRunHandle("retry-after-failure"), false);
    const firstRetry = retryAfterFailure.releaseSceneRunHandle("retry-after-failure");
    const sharedRetry = retryAfterFailure.releaseSceneRunHandle("retry-after-failure");
    assert.equal(firstRetry, sharedRetry);
    assert.equal(await firstRetry, true);
    assert.equal(retryAfterFailure.calls.length, 4);

    const pagehide = releaseContext([
        { ok: true, payload: { released: true } },
        { ok: true, payload: { released: true } },
    ]);
    pagehide.sceneRunHandlesByPromptId.set("prompt-a", "handle-a");
    pagehide.sceneBatchRunsById.set("run-b", { runHandle: "handle-b" });
    pagehide.releaseSceneRunsOnPageHide({ persisted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pagehide.calls.length, 0);
    pagehide.releaseSceneRunsOnPageHide({ persisted: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pagehide.calls.map((call) => call.options.keepalive), [true, true]);

    const normalResponse = deferred();
    const keepaliveResponse = deferred();
    const competing = releaseContext([normalResponse, keepaliveResponse]);
    const normal = competing.releaseSceneRunHandle("competing-handle");
    assert.equal(competing.releaseSceneRunHandle("competing-handle"), normal);
    competing.sceneRunHandlesByPromptId.set("prompt-competing", "competing-handle");
    competing.releaseSceneRunsOnPageHide({ persisted: false });
    const keepalive = competing.sceneRunReleaseStates.get("competing-handle").keepalive;
    competing.releaseSceneRunsOnPageHide({ persisted: false });
    assert.equal(competing.calls.length, 2);
    assert.deepEqual(competing.calls.map((call) => call.options.keepalive), [false, true]);
    keepaliveResponse.resolve({ ok: true, payload: { released: false } });
    normalResponse.resolve({ ok: true, payload: { released: true } });
    assert.equal(await keepalive, false);
    assert.equal(await normal, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(competing.sceneRunReleaseStates.has("competing-handle"), false);

    console.log("Scene Prompt run release tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
