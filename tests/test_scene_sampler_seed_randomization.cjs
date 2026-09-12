const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

const randomSeeds = [5, 5, 12, 12, 19, 19, 26, 26];
const context = {
    Array,
    Map,
    Math,
    Number,
    Object,
    String,
    findWidget(node, name) { return node.widgets?.find((widget) => widget.name === name); },
    sceneBatchSeedBase() { return randomSeeds.shift(); },
};
vm.createContext(context);
for (const name of [
    "samplerSeedControlWidget",
    "captureRandomizedSamplerSeedTargets",
    "scenePromptWorkflowNodes",
    "samplerSeedControlValue",
    "randomSamplerSeed",
    "applyRandomizedSamplerSeeds",
]) {
    vm.runInContext(functionSource(name), context);
}

function sampler(id, inputName, control = "randomize", linked = null) {
    return {
        id,
        inputs: [{ name: inputName, link: linked }],
        widgets: [
            { name: inputName, value: 1, options: { min: 0, max: 100 } },
            { name: "control_after_generate", value: control },
        ],
    };
}

const randomized = sampler(10, "seed");
const noiseRandomized = sampler(11, "noise_seed");
const fixed = sampler(12, "seed", "fixed");
const linked = sampler(13, "seed", "randomize", 42);
const targets = context.captureRandomizedSamplerSeedTargets({ _nodes: [randomized, noiseRandomized, fixed, linked] });
assert.deepEqual(JSON.parse(JSON.stringify(targets)), [
    { nodeId: "10", inputName: "seed", widgetIndex: 0, min: 0, max: 100 },
    { nodeId: "11", inputName: "noise_seed", widgetIndex: 0, min: 0, max: 100 },
]);

function prompt(seed = 5, noiseSeed = 5, control = "randomize") {
    return {
        output: {
            "1": { class_type: "ScenePrompterExpand", inputs: { run_id: "" } },
            "10": { class_type: "KSampler", inputs: { seed } },
            "11": { class_type: "KSamplerAdvanced", inputs: { noise_seed: noiseSeed } },
            "12": { class_type: "KSampler", inputs: { seed: 99 } },
            "13": { class_type: "KSampler", inputs: { seed: ["99", 0] } },
        },
        workflow: {
            nodes: [
                { id: 10, widgets_values: [seed, control], widgets_values_named: { seed, control_after_generate: control } },
                { id: 11, widgets_values: [noiseSeed, "randomize"], widgets_values_named: { noise_seed: noiseSeed, control_after_generate: "randomize" } },
                { id: 12, widgets_values: [99, "fixed"], widgets_values_named: { seed: 99, control_after_generate: "fixed" } },
                { id: 13, widgets_values: [7, "randomize"], widgets_values_named: { seed: 7, control_after_generate: "randomize" } },
            ],
        },
    };
}

const normal = prompt();
context.applyRandomizedSamplerSeeds(normal, targets);
assert.equal(normal.output["10"].inputs.seed, 6, "a repeated generated seed increments inside its range");
assert.equal(normal.workflow.nodes[0].widgets_values[0], 6);
assert.equal(normal.workflow.nodes[0].widgets_values_named.seed, 6);
assert.equal(normal.output["11"].inputs.noise_seed, 6);
assert.equal(normal.workflow.nodes[1].widgets_values[0], 6);
context.applyRandomizedSamplerSeeds(normal, targets);
assert.equal(normal.output["10"].inputs.seed, 12, "a failed normal send can retry with a new seed");
assert.equal(normal.output["11"].inputs.noise_seed, 12);

const fixedMetadata = prompt(7, 8, "fixed");
context.applyRandomizedSamplerSeeds(fixedMetadata, targets);
assert.equal(fixedMetadata.output["10"].inputs.seed, 7, "serialized fixed control wins over stale live graph state");
assert.equal(fixedMetadata.output["13"].inputs.seed[0], "99", "linked sampler inputs stay linked");

const graphA = { _nodes: [sampler(10, "seed")] };
const graphB = { _nodes: [sampler(20, "seed")] };
const runATargets = context.captureRandomizedSamplerSeedTargets(graphA);
const runBTargets = context.captureRandomizedSamplerSeedTargets(graphB);
const first = prompt(1, 2);
const cached = prompt(1, 2);
cached.output["10"].inputs.seed = 1;
context.applyRandomizedSamplerSeeds(first, runATargets);
context.applyRandomizedSamplerSeeds(cached, runATargets);
context.applyRandomizedSamplerSeeds(cached, runATargets);
assert.deepEqual(
    [first.output["10"].inputs.seed, cached.output["10"].inputs.seed],
    [19, 27],
    "continuous first snapshot and cached sends refresh their captured sampler targets",
);
assert.equal(runBTargets[0].nodeId, "20", "each FIFO tab retains its own graph target snapshot");

async function testSubmissionWrapper() {
    let nextSeed = 30;
    let rejectNext = false;
    const sent = [];
    Object.assign(context, {
        app: { graph: graphA },
        sceneBatchRun: null,
        sceneBatchDetachedRuns: new Map(),
        sceneBatchSeedBase() { return nextSeed++; },
        applySceneSourceNodeNames() {},
        sceneRunTargetNodes() { return []; },
        scenePromptIdFromValue(value) { return value.prompt_id; },
        buildSceneBatchCachedPrompt(value) { return structuredClone(value); },
        acceptSceneBatchPrompt() {},
        releaseSceneRunHandle() {},
        showPromptValidationErrorFromThrown() {},
        api: {
            async queuePrompt(_number, value) {
                sent.push(structuredClone(value));
                if (rejectNext) {
                    rejectNext = false;
                    throw new Error("send failed");
                }
                return { prompt_id: `sent-${sent.length}` };
            },
        },
    });
    for (const name of ["randomizeStandardSceneSeeds", "scenePromptSamplerSeedTargets", "installSceneBatchPromptCapture"]) {
        vm.runInContext(functionSource(name), context);
    }
    context.installSceneBatchPromptCapture();
    await context.api.queuePrompt(0, prompt());
    await context.api.queuePrompt(0, prompt());
    rejectNext = true;
    await assert.rejects(context.api.queuePrompt(0, prompt()), /send failed/);
    await context.api.queuePrompt(0, prompt());
    assert.equal(new Set(sent.map((value) => value.output["10"].inputs.seed)).size, 4,
        "normal submissions, including failed sends and retries, use fresh seeds");

    const firstBatch = prompt();
    firstBatch.output["1"].inputs.run_id = "batch-a";
    context.sceneBatchRun = {
        runId: "batch-a", nodeId: "1", nextIndex: 0, firstApiPending: true,
        samplerSeedTargets: runATargets,
    };
    context.app.graph = { get _nodes() { throw new Error("batch must not inspect the active tab"); } };
    await context.api.queuePrompt(0, firstBatch);
    const cachedBatch = context.sceneBatchRun.cachedPrompt;
    assert.equal(cachedBatch.output["10"].inputs.seed, sent.at(-1).output["10"].inputs.seed,
        "the cache starts with the first submitted seed");
    await context.api.queuePrompt(0, cachedBatch);
    await context.api.queuePrompt(0, cachedBatch);
    assert.equal(new Set(sent.slice(-3).map((value) => value.output["10"].inputs.seed)).size, 3,
        "first and cached submissions retain the original tab's targets");
    const detached = context.sceneBatchRun;
    context.sceneBatchRun = null;
    context.sceneBatchDetachedRuns.set(detached.runId, detached);
    await context.api.queuePrompt(0, cachedBatch);
    assert.notEqual(sent.at(-1).output["10"].inputs.seed, sent.at(-2).output["10"].inputs.seed,
        "detached submissions also retain their captured targets");
    context.sceneBatchDetachedRuns.clear();
    context.app.graph = graphA;
    for (const control of ["fixed", "increment", "decrement"]) {
        await context.api.queuePrompt(0, prompt(77, 88, control));
        assert.equal(sent.at(-1).output["10"].inputs.seed, 77);
    }
    const linkedPrompt = prompt();
    linkedPrompt.output["10"].inputs.seed = ["1", 3];
    await context.api.queuePrompt(0, linkedPrompt);
    assert.deepEqual(sent.at(-1).output["10"].inputs.seed, ["1", 3]);
    const missingSeed = prompt();
    delete missingSeed.output["10"].inputs.seed;
    await context.api.queuePrompt(0, missingSeed);
    assert.equal(Object.hasOwn(sent.at(-1).output["10"].inputs, "seed"), false);
    const noScene = prompt();
    delete noScene.output["1"];
    await context.api.queuePrompt(0, noScene);
    assert.equal(sent.at(-1).output["10"].inputs.seed, 5, "non-Scene submissions remain untouched");
    for (const value of sent.slice(0, 8)) {
        assert.equal(value.output["10"].inputs.seed, value.workflow.nodes[0].widgets_values[0]);
    }
}

testSubmissionWrapper().then(() => {
    console.log("Scene Prompt sampler seed randomization tests passed.");
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
