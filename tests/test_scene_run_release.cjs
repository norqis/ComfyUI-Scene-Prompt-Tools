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
    assert.equal(failed.sceneRunReleaseStates.get("failed-handle").attempts, 3);

    const pagehide = releaseContext([
        { ok: true, payload: { released: true } },
        { ok: true, payload: { released: true } },
    ]);
    pagehide.sceneRunHandlesByPromptId.set("prompt-a", "handle-a");
    pagehide.sceneBatchRunsById.set("run-b", { runHandle: "handle-b" });
    pagehide.releaseSceneRunsOnPageHide();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pagehide.calls.map((call) => call.options.keepalive), [true, true]);
    console.log("Scene Prompt run release tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
