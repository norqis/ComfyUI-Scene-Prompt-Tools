const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/scene_prompt_ui.js'), 'utf8');
function functionSource(name) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const end = source.indexOf('\n}', start);
    return source.slice(start, end + 2);
}
const context = {
    Object, JSON, Set, Map, String, Number,
    cloneScenePromptPayload: structuredClone,
    seeds: 0,
    sceneBatchSeedBase() { return 100 + ++context.seeds; },
    sceneBatchRun: null,
    api: { async queuePrompt(_number, prompt) { context.sent = structuredClone(prompt); return {}; } },
    acceptSceneBatchPrompt() {},
};
vm.createContext(context);
for (const constant of ['SCENE_PLAN_NODE_CLASS_TYPES', 'SCENE_SOURCE_NODE_CLASS_TYPES']) {
    const start = source.indexOf(`const ${constant} =`);
    vm.runInContext(source.slice(start, source.indexOf('\n]);', start) + 4), context);
    assert.equal(vm.runInContext(`${constant}.has('ScenePromptToText')`, context), false);
    assert.equal(vm.runInContext(`${constant}.has('ScenePromptDelete')`, context), true);
}
for (const name of ['scenePromptInputSourceId', 'scenePromptInputSources', 'buildSceneBatchCachedPrompt', 'syncSceneToTextInputs', 'randomizeStandardSceneSeeds', 'sceneRunTargetNodes', 'applySceneRunHandle', 'queueSingleScenePrompt']) {
    vm.runInContext(functionSource(name), context);
}
const prompt = { output: {
    a: { class_type: 'ScenePrompter', inputs: {} },
    b: { class_type: 'ScenePromptDelete', inputs: { scene_prompt: ['a', 0], positive: 'bald' } },
    e: { class_type: 'ScenePrompterExpand', inputs: { scene_prompt: ['b', 0], current_index: 3, seed_base: 0 } },
    p: { class_type: 'ScenePresetReference', inputs: { preset_id: 'separate' } },
    t: { class_type: 'ScenePromptToText', inputs: { scene_prompt: ['p', 0], current_index: 2, seed_base: 9, seed_base_literal: true } },
    t2: { class_type: 'ScenePromptToText', inputs: { scene_prompt: ['b', 0], current_index: 7 } },
    sink: { class_type: 'Sink', inputs: { image: ['e', 4], text: ['t', 0], negative: ['t2', 1] } },
} };
context.randomizeStandardSceneSeeds(prompt);
assert.equal(context.seeds, 1);
for (const id of ['e', 't', 't2']) {
    assert.equal(prompt.output[id].inputs.seed_base, 101);
    assert.equal(prompt.output[id].inputs.seed_base_literal, false);
}
assert.deepEqual(['e', 't', 't2'].map(id => prompt.output[id].inputs.current_index), [3, 2, 7]);
context.randomizeStandardSceneSeeds(prompt);
assert.equal(context.seeds, 2);
assert.equal(prompt.output.t.inputs.seed_base, 102);
context.applySceneRunHandle(prompt, 'handle');
assert.equal(prompt.output.t.inputs.run_handle, 'handle');
assert.ok(context.sceneRunTargetNodes(prompt).includes(prompt.output.t));
prompt.output.e.inputs.run_id = 'batch';
context.syncSceneToTextInputs(prompt, 0, 200);
context.randomizeStandardSceneSeeds(prompt);
assert.equal(context.seeds, 2, 'continuous ToText must retain the selected run seed');
assert.equal(prompt.output.t.inputs.seed_base, 200);
const cached = context.buildSceneBatchCachedPrompt(prompt, 'e');
for (const id of ['e', 't', 't2']) assert.equal(cached.output[id].inputs.scene_prompt, undefined);
for (const id of ['a', 'b', 'p']) assert.equal(cached.output[id], undefined, 'unused plan ancestor is pruned');
assert.ok(prompt.output.a, 'original snapshot remains available for PNG metadata');
async function checkContinuous() {
    context.sceneBatchRun = { nodeId: 'e', runId: 'batch', nextIndex: 0, currentSeed: 300, firstPromptSnapshot: prompt };
    await context.queueSingleScenePrompt();
    assert.equal(context.sent.output.t.inputs.current_index, 0);
    assert.equal(context.sent.output.t.inputs.seed_base, 300);
    Object.assign(context.sceneBatchRun, { nextIndex: 2, currentSeed: 400, cachedPrompt: cached });
    await context.queueSingleScenePrompt();
    for (const id of ['e', 't', 't2']) {
        assert.equal(context.sent.output[id].inputs.current_index, 2);
        assert.equal(context.sent.output[id].inputs.seed_base, 400);
        assert.equal(context.sent.output[id].inputs.seed_base_literal, false);
    }
}
checkContinuous().then(() => console.log('Scene Prompt To Text shared seeds, run handles, cached pruning and iteration sync passed.')).catch(error => { console.error(error); process.exitCode = 1; });
