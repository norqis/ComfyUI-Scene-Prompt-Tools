const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(name);
}

const ctx = {
    Array, Map, Set, Object, Number, String, JSON, Math,
    SCENE_PROMPT_QUEUE_INPUT_NAMES: new Set(Array.from({ length: 10 }, (_, i) => `scene_prompt${i + 1}`)),
    emptyMatrixRow: () => ({}),
    matrixLineLabel: (row) => row.label,
    sceneQueueDisplayPartsForEntry: (entry) => entry.parts,
    mergeScenePromptRows: () => ({}),
};
vm.createContext(ctx);
for (const name of [
    "emptyScenePromptStats", "sceneStatNumber", "sceneStatProduct", "sceneStatSum", "sceneStatsResult", "sceneStatsMerge",
    "sceneSchedulePlan", "sceneScheduleRun", "sceneScheduleWrapper", "sceneScheduleRepeatEach",
    "sceneScheduleSequence", "sceneScheduleAlternate", "sceneScheduleAtUnit", "sceneScheduleAt",
    "sceneSchedulePrefix", "sceneScheduleCount", "sceneScheduleMap", "sceneScheduleMatrix", "sceneScheduleQueue",
    "sceneScheduleHasComposite", "sceneScheduleMerge", "mergeScenePromptEntryPair",
]) vm.runInContext(functionSource(name), ctx);

const leaf = (label, count = 1, latent = null) => ctx.sceneSchedulePlan([
    ctx.sceneScheduleRun({ parts: [label], count, row: latent ? { latent: { batch_size: latent } } : {} }),
]);
const controls = (order_mode = "input_order", block = 1, repeats = "{}", downstream_count_mode = "multiply") =>
    ({ order_mode, alternate_block_size: block, input_repeats_json: repeats, downstream_count_mode });
const queue = (plans, settings) => ctx.sceneScheduleQueue(plans, plans.map((_, index) => `scene_prompt${index + 1}`), settings);
const prefix = (plan, limit = plan.stats.total) => ctx.sceneSchedulePrefix(plan, limit).map((entry) => entry.parts.join(""));

const a = leaf("A");
const b = leaf("B");
const matrixPromptRows = ["A+PromptA", "A+PromptB", "B+PromptA", "B+PromptB", "C+PromptA", "C+PromptB"];
const matrixPromptPlan = ctx.sceneSchedulePlan(matrixPromptRows.map((label) =>
    ctx.sceneScheduleRun({ parts: [label], count: 1, row: {} })));
assert.deepEqual(JSON.parse(JSON.stringify(prefix(queue([matrixPromptPlan], controls("alternate"))))), matrixPromptRows);
const doubledMatrixPromptRows = matrixPromptRows.flatMap((label) => [label, label]);
const doubledMatrixPrompt = queue([matrixPromptPlan], controls("alternate", 2));
assert.deepEqual(JSON.parse(JSON.stringify(prefix(doubledMatrixPrompt))), doubledMatrixPromptRows,
    "one Queue input repeats each Matrix and Prompt row");
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleCount(doubledMatrixPrompt, 2)))),
    [...doubledMatrixPromptRows, ...doubledMatrixPromptRows], "Count repeats the full Matrix and Prompt cycle");
for (const [block, expected] of [[1, "AB"], [2, "AABB"], [3, "AAABBB"]]) {
    const plan = queue([a, b], controls("alternate", block, '{"scene_prompt1":3,"scene_prompt2":2}'));
    assert.equal(prefix(plan).join(""), expected);
    assert.equal(plan.stats.total, block * 2);
    assert.equal(prefix(ctx.sceneScheduleCount(plan, 2)).join(""), expected + expected);
}
const sequential = queue([a, b], controls("input_order", 1, '{"scene_prompt1":3,"scene_prompt2":2}'));
assert.equal(prefix(ctx.sceneScheduleCount(sequential, 10)).join(""), "A".repeat(10) + "B".repeat(10),
    "factor one keeps the legacy input-order Count boundary");
assert.equal(prefix(ctx.sceneScheduleCount(queue([a, b], controls("input_order", 2)), 10)).join(""), "AABB".repeat(10));
const fixed = queue([a, b], controls("alternate", 1, '{"scene_prompt1":3,"scene_prompt2":2}', "fixed"));
assert.equal(prefix(ctx.sceneScheduleCount(fixed, 10)).join(""), "AB");
assert.equal(prefix(ctx.sceneScheduleCount(queue([a, b], controls("alternate", 2, "{}", "fixed")), 10)).join(""), "AABB");
assert.equal(ctx.sceneScheduleCount(fixed, 0).stats.total, 0);
assert.equal(ctx.sceneScheduleCount(queue([], controls("alternate", 1, "{}", "fixed")), 10).stats.total, 1,
    "a fixed Queue with no connections protects its seed event");
assert.equal(ctx.sceneScheduleCount(queue([], controls()), 10).stats.total, 10);
assert.equal(ctx.sceneScheduleCount(queue([], controls("input_order", 2)), 10).stats.total, 20,
    "an empty Queue repeats its seed row before Count");

const locked = queue([fixed, leaf("C")], controls("alternate", 4, '{"scene_prompt1":20}', "fixed"));
assert.equal(prefix(ctx.sceneScheduleCount(locked, 2)).join(""), "ABCC");
assert.equal(locked.stats.total, 3, "locked Queue preserves upstream fixed units and appends ordinary units");
const matrix = ctx.sceneScheduleMatrix(queue([
    queue([leaf("b1"), leaf("b2")], controls("alternate")), leaf("b3", 2),
], controls()), [{ label: "x" }, { label: "y" }]);
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleCount(matrix, 2)))), [
    "b1x", "b1y", "b2x", "b2y", "b1x", "b1y", "b2x", "b2y",
    "b3x", "b3x", "b3x", "b3x", "b3y", "b3y", "b3y", "b3y",
]);
const target = queue([
    queue([leaf("b1"), leaf("b2")], controls("alternate")),
    queue([leaf("b3"), leaf("b4")], controls()),
], controls("alternate", 4, '{"scene_prompt1":10}', "fixed"));
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleCount(target, 3)))), [
    "b1", "b2", "b1", "b2", "b1", "b2", "b3", "b3", "b3", "b4", "b4", "b4",
]);

const latent = queue([leaf("A", 2, 3), leaf("B", 1, 2)], controls("alternate"));
assert.equal(latent.stats.total, 3);
assert.equal(latent.stats.totalImages, 8);
const product = ctx.sceneScheduleMerge(queue([a, b], controls("alternate")),
    ctx.sceneSchedulePlan([ctx.sceneScheduleRun({ parts: ["x"], count: 1, row: {} }),
        ctx.sceneScheduleRun({ parts: ["y"], count: 1, row: {} })]));
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleCount(product, 2)))),
    ["Ax", "Ay", "Bx", "By", "Ax", "Ay", "Bx", "By"]);
const legacyMerge = ctx.sceneScheduleMerge(queue([leaf("a", 2), leaf("b")], controls()),
    queue([leaf("x", 2), leaf("y")], controls()));
assert.deepEqual(JSON.parse(JSON.stringify(prefix(legacyMerge))),
    ["ax", "ax", "ax", "ax", "ay", "ay", "bx", "bx", "by"]);
const visibleRuns = Array.from({ length: 160 }, (_, index) =>
    ctx.sceneScheduleRun({ parts: [`a${index}`], count: 1, row: {} }));
const cappedSource = ctx.sceneSchedulePlan([...visibleRuns,
    { kind: "tail", entry: null, total: 1, totalImages: 1, unsetBatches: 1, rows: 1 }]);
const cappedMerge = ctx.sceneScheduleMerge(cappedSource, leaf("x"));
assert.equal(cappedMerge.stats.total, 161, "legacy Merge retains exact totals after the preview prefix");
assert.equal(prefix(cappedMerge, 160).length, 160, "the bounded 160-event prefix never resolves a tail");
const rightRuns = Array.from({ length: 160 }, (_, index) =>
    ctx.sceneScheduleRun({ parts: [`x${index}`], count: 1, row: {} }));
const rightCapped = ctx.sceneSchedulePlan([...rightRuns,
    { kind: "tail", entry: null, total: 1, totalImages: 1, unsetBatches: 1, rows: 1 }]);
const largeLegacyMerge = ctx.sceneScheduleMerge(cappedSource, rightCapped);
assert.equal(largeLegacyMerge.stats.total, 161 * 161);
assert.equal(largeLegacyMerge.stats.totalImages, 161 * 161);
assert.deepEqual(JSON.parse(JSON.stringify(prefix(largeLegacyMerge, 160))),
    Array.from({ length: 160 }, (_, index) => `a0x${index}`),
    "both capped Merge operands keep the exact non-null first 160 events in legacy row order");
const huge = ctx.sceneScheduleCount(queue([a, b], controls("alternate")), 100000000);
assert.equal(huge.stats.total, 200000000);
assert.equal(huge.units.length, 1, "large Counts keep a bounded schedule");
assert.deepEqual(JSON.parse(JSON.stringify(prefix(huge, 6))), ["A", "B", "A", "B", "A", "B"]);

Object.assign(ctx, {
    SCENE_QUEUE_CONTROL_DEFAULTS: controls(),
    SCENE_QUEUE_CONTROL_NAMES: ["order_mode", "alternate_block_size", "downstream_count_mode"],
    scenePresetDisplayGraphs: new Map(),
    scenePresetGraphNodes: (preset) => preset?.api_graph?.output || null,
    apiInput: (node, name) => node?.inputs?.[name],
    apiLink: (value) => Array.isArray(value) && value.length === 2 ? String(value[0]) : "",
    clampSceneCount: (value, fallback) => Number.isSafeInteger(value) ? value : fallback,
});
vm.runInContext(functionSource("sceneScheduleForPreset"), ctx);
const preset = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0], prompt_name: "b1" } },
    3: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0], prompt_name: "b2" } },
    4: { class_type: "ScenePrompterQueue", inputs: { scene_prompt1: ["2", 0], scene_prompt2: ["3", 0],
        order_mode: "alternate", alternate_block_size: 1, input_repeats_json: "{}", downstream_count_mode: "multiply" } },
    5: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["4", 0] } },
} } };
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleForPreset("inner", leaf("A"), new Set(), preset)))),
    ["Ab1", "Ab2"], "Preset rehydration retains the internal Queue order and Prompt labels");
const compactInner = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0] } },
    3: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0] } },
    4: { class_type: "ScenePrompterQueue", inputs: { scene_prompt1: ["2", 0], scene_prompt2: ["3", 0],
        order_mode: "alternate", alternate_block_size: 3, downstream_count_mode: "multiply" } },
    5: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["4", 0] } },
} } };
const compactOuter = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePresetReference", inputs: { scene_prompt: ["1", 0], preset_id: "compact-inner" } },
    3: { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["2", 0], count: 10 } },
    4: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["3", 0] } },
} } };
ctx.scenePresetDisplayGraphs.set("compact-inner", compactInner);
const multipliedPreset = ctx.sceneScheduleForPreset("compact-outer", leaf("A"), new Set(), compactOuter);
assert.equal(multipliedPreset.stats.total, 60,
    "a nested compact Preset retains alternate row repeat 3 before a downstream Count 10");
compactInner.api_graph.output[4].inputs.downstream_count_mode = "fixed";
const fixedPreset = ctx.sceneScheduleForPreset("compact-outer", leaf("A"), new Set(), compactOuter);
assert.equal(fixedPreset.stats.total, 6,
    "a nested compact Preset retains its fixed downstream Count mode");

Object.assign(ctx, {
    SCENE_QUEUE_CONTROL_DEFAULTS: controls(),
    SCENE_QUEUE_CONTROL_NAMES: ["order_mode", "alternate_block_size", "downstream_count_mode"],
    SCENE_WIDGET_LABELS: { order_mode: "並び順", alternate_block_size: "1行の回数",
        downstream_count_mode: "後続Count" },
    isSceneNodeMuted: (node) => node.mode === 2,
    isSceneNodeBypassed: (node) => node.mode === 4,
    sceneBypassInputSource: (node) => node.upstream || null,
    isScenePromptQueueNode: (node) => node.kind === "queue",
    isScenePresetReferenceNode: () => false,
    isScenePromptMergeNode: () => false,
    scenePromptInputSource: (node) => node.upstream || null,
    connectedScenePromptSourcesForQueue: (node) => (node.sources || []).map((source, index) =>
        ({ input: { name: `scene_prompt${index + 1}` }, source })),
    findWidget: (node, name) => node.widgets.find((widget) => widget.name === name),
    setWidgetValue: (node, name, value) => { node.widgets.find((widget) => widget.name === name).value = value; },
    hideWidget: (widget) => { widget.hidden = true; },
    findSceneWidget: () => null,
});
for (const name of ["sceneQueueBoundaryInNode", "sceneQueuePendingInNode", "sceneQueueLockState", "syncSceneQueueControls"])
    vm.runInContext(functionSource(name), ctx);
const previous = { id: "previous", kind: "queue" };
const middle = { id: "middle", kind: "prompt", upstream: previous };
const widgets = [
    { name: "order_mode", value: "alternate" }, { name: "alternate_block_size", value: 3 },
    { name: "input_repeats_json", value: '{"scene_prompt1":3}' },
    { name: "downstream_count_mode", value: "fixed" },
];
const receiving = { id: "receiving", kind: "queue", sources: [middle], widgets };
assert.equal(ctx.syncSceneQueueControls(receiving), "upstream", "Queue → Prompt → Queue locks all controls");
assert.deepEqual(widgets.map((widget) => widget.value), ["input_order", 1, "{}", "multiply"]);
assert.ok(widgets.filter((widget) => widget.name !== "input_repeats_json")
    .every((widget) => widget.disabled && widget.options.disabled));
assert.equal(widgets[2].hidden, true, "legacy repeat widget stays hidden in its serialized slot");
receiving.sources = [{ id: "ordinary", kind: "prompt" }];
assert.equal(ctx.syncSceneQueueControls(receiving), "", "disconnecting upstream Queue unlocks controls");
assert.equal(widgets[1].disabled, false, "row repeat is active in input order mode");
assert.deepEqual(widgets.map((widget) => widget.value), ["input_order", 1, "{}", "multiply"],
    "old nondefault settings do not reappear after unlocking");
receiving.sources = [{ id: "bypass", kind: "queue", mode: 4, upstream: { id: "ordinary-2", kind: "prompt" } }];
assert.equal(ctx.syncSceneQueueControls(receiving), "", "bypassed Queue without effective Queue path does not lock");

console.log("Scene Queue schedule, Count policy, chunking, and bounded preview tests passed.");
