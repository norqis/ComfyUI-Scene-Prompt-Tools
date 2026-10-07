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
    SCENE_RANDOM_DEFAULT_WEIGHTS: [10000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    emptyMatrixRow: () => ({}),
    matrixLineLabel: (row) => row.label,
    sceneQueueDisplayPartsForEntry: (entry) => entry.parts,
};
require("./scene_switches_test_context.cjs").install(ctx);
vm.createContext(ctx);
for (const name of [
    "emptyScenePromptStats", "sceneStatNumber", "sceneStatProduct", "sceneStatSum", "sceneStatsResult", "sceneStatsMerge",
    "sceneSchedulePlan", "sceneScheduleRun", "sceneScheduleWrapper", "sceneScheduleRepeatEach",
    "sceneCountHasHold", "sceneCountPolicyAdd", "sceneCountPolicyProduct", "sceneCountPlanPolicy", "sceneCountUnitPolicy",
    "sceneCountPrefixPlan", "sceneCountPrefixUnit", "sceneCountPrefixUnitUncached", "sceneCountEligibleIndex",
    "sceneScheduleSequence", "sceneScheduleAlternate", "sceneScheduleAtUnit", "sceneScheduleAtUnitUncached", "sceneScheduleAt",
    "sceneSchedulePrefix", "sceneScheduleCount", "sceneScheduleMap", "sceneScheduleMatrix", "sceneScheduleQueue",
    "sceneScheduleError", "sceneRandomGuard", "sceneRandomChoicePlan", "sceneRandomZeroArm", "sceneRandomJoinReady",
    "sceneScheduleHasComposite", "sceneScheduleMerge", "mergeScenePromptEntryPair",
    "mergeScenePromptRows", "mergePositiveNegativeParts", "uniquePromptParts", "promptOverrideKeys", "promptOverrideKey", "promptIdentity",
]) vm.runInContext(functionSource(name), ctx);

const leaf = (label, count = 1, latent = null) => ctx.sceneSchedulePlan([
    ctx.sceneScheduleRun({ parts: [label], count, row: { labels: [label], ...(latent ? { latent: { batch_size: latent } } : {}) } }),
]);
const controls = (order_mode = "input_order", block = 1, repeats = "{}", downstream_count_mode = "multiply") =>
    ({ order_mode, alternate_block_size: block, input_repeats_json: repeats, downstream_count_mode });
const queue = (plans, settings) => ctx.sceneScheduleQueue(plans, plans.map((_, index) => `scene_prompt${index + 1}`), settings);
const prefix = (plan, limit = plan.stats.total) => ctx.sceneSchedulePrefix(plan, limit).map((entry) => entry.parts.join(""));

const randomWeights = [6000, 4000, 0, 0, 0, 0, 0, 0, 0, 0];
const guarded = (plan, index, gateId = "random-1") => ctx.sceneSchedulePlan(plan.units, plan.boundary,
    [{ gateId, armIndex: index, weights: randomWeights }]);
const randomJoined = queue([guarded(leaf("A"), 0), guarded(leaf("B"), 1)], controls("alternate", 3));
const boundaryArm = guarded(leaf("boundary"), 0);
assert.equal(ctx.sceneScheduleCount(boundaryArm, 1, true, "whole"), boundaryArm,
    "internal Preset boundaries preserve open Random arms without applying Count");
for (const [factor, enabled, kind] of [[1, true, ""], [2, true, "whole"], [1, false, "whole"]])
    assert.match(ctx.sceneScheduleCount(boundaryArm, factor, enabled, kind).stats.error, /Queueで合流/u);
assert.equal(randomJoined.stats.total, 1, "random alternatives occupy one generation slot");
assert.equal(randomJoined.stats.rows, 1);
assert.deepEqual(JSON.parse(JSON.stringify(prefix(randomJoined))), ["ランダム候補"],
    "preview does not falsely claim a winner before execution");
assert.equal(ctx.sceneScheduleCount(randomJoined, 10).stats.total, 10, "Count repeats draws, not winning paths");

for (const mapped of [false, true]) {
    let plan = randomJoined;
    for (let level = 0; level < 28; level += 1) {
        const left = mapped ? ctx.sceneScheduleMap(plan, (entry) => ({ ...entry, parts: [...entry.parts, "left"] })) : plan;
        const right = mapped ? ctx.sceneScheduleMap(plan, (entry) => ({ ...entry, parts: [...entry.parts, "right"] })) : plan;
        plan = ctx.sceneScheduleMerge(left, right);
    }
    const original = ctx.sceneScheduleAtUnitUncached;
    let visits = 0;
    ctx.sceneScheduleAtUnitUncached = (...args) => {
        assert.ok(++visits < 200, "shared paths must not be expanded as a tree");
        return original(...args);
    };
    const entry = ctx.sceneScheduleAt(plan, 0);
    ctx.sceneScheduleAtUnitUncached = original;
    assert.deepEqual(Array.from(entry.parts), mapped ? ["ランダム候補", "left", "right"] : ["ランダム候補"]);
    const prefixUnit = ctx.sceneCountPrefixUnitUncached;
    visits = 0;
    ctx.sceneCountPrefixUnitUncached = (...args) => {
        assert.ok(++visits < 200, "Count prefixes reuse shared paths within one calculation");
        return prefixUnit(...args);
    };
    assert.deepEqual(Array.from(ctx.sceneCountPrefixPlan(plan, 1)), [0, 0, 1]);
    ctx.sceneCountPrefixUnitUncached = prefixUnit;
}
assert.match(ctx.sceneScheduleCount(guarded(leaf("A"), 0), 2).stats.error, /Queueで合流/u);
assert.match(ctx.sceneScheduleMatrix(guarded(leaf("A"), 0), [{ label: "single" }]).stats.error, /Queueで合流/u);
assert.match(ctx.sceneScheduleMerge(guarded(leaf("A"), 0), leaf("B")).stats.error, /Queueで合流/u);
assert.match(ctx.sceneScheduleMap(ctx.sceneScheduleError("不正な確率"), (entry) => entry).stats.error,
    /不正な確率/u, "a downstream Prompt does not erase the random validation error");
assert.match(queue([guarded(leaf("A"), 0)], controls()).stats.error, /ランダム分岐/u,
    "a missing positive arm is an error");
const incompleteRandom = queue([guarded(leaf("A"), 0)], controls());
for (const merge of [
    ctx.sceneScheduleMerge(incompleteRandom, leaf("B")),
    ctx.sceneScheduleMerge(leaf("B"), incompleteRandom),
]) {
    assert.equal(merge.stats.error, incompleteRandom.stats.error,
        "Merge preserves an upstream error instead of presenting a valid zero count");
    assert.equal(ctx.sceneScheduleCount(ctx.sceneScheduleMatrix(merge, [{ label: "X" }]), 10).stats.error,
        incompleteRandom.stats.error, "later Matrix and Count preserve the original error");
}
assert.equal(ctx.sceneScheduleMerge(randomJoined, leaf("B")).stats.total, 1,
    "connecting the missing arm restores a valid Merge count");
const zeroArm = ctx.sceneSchedulePlan([], false, [{ gateId: "random-1", armIndex: 2, weights: randomWeights }]);
assert.match(queue([zeroArm], controls()).stats.error, /0%を超える出力/u,
    "a Queue containing only zero-percent arms cannot close a missing positive-probability route");
assert.equal(queue([guarded(leaf("A"), 0), guarded(leaf("B"), 1), zeroArm], controls()).stats.total, 1,
    "connected zero-percent arms do not increase the generation count");
const zeroUpstream = ctx.sceneSchedulePlan();
const zeroJoined = queue([guarded(zeroUpstream, 0), guarded(zeroUpstream, 1), zeroArm], controls());
assert.equal(zeroJoined.stats.total, 0, "positive-probability arms remain joined when the upstream plan has zero rows");
assert.equal(zeroJoined.boundary, true, "a Random join remains a Queue boundary even with zero rows");
assert.equal(ctx.sceneScheduleCount(randomJoined, 2).boundary, true,
    "a downstream Count repeats the Random Queue unit, not individual alternatives");
const crossed = queue([
    ctx.sceneSchedulePlan(leaf("A").units, false, [{ gateId: "outer", armIndex: 0, weights: randomWeights },
        { gateId: "inner", armIndex: 0, weights: randomWeights }]),
    ctx.sceneSchedulePlan(leaf("B").units, false, [{ gateId: "outer", armIndex: 1, weights: randomWeights },
        { gateId: "inner", armIndex: 1, weights: randomWeights }]),
], controls());
assert.match(crossed.stats.error, /ランダム分岐/u, "crossed nested random guards cannot be joined");

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

function verifyCompactOrdinaryRows() {
    for (let factor = 0; factor < 4; factor += 1) {
        const leftEntries = [["a", 2], ["empty", 0], ["b", 3]];
        const rightEntries = [["c", 1], ["d", 2]];
        const toPlan = (entries) => ctx.sceneSchedulePlan(entries.flatMap(([name, count]) => leaf(name, count).units));
        let actual = ctx.sceneScheduleMatrix(toPlan(leftEntries), [{ label: "x" }, { label: "y" }]);
        actual = ctx.sceneScheduleCount(actual, factor);
        actual = ctx.sceneScheduleMerge(actual, toPlan(rightEntries));
        actual = ctx.sceneScheduleMatrix(actual, [{ label: "u" }, { label: "v" }]);
        const expected = leftEntries.flatMap(([name, count]) => ["x", "y"].flatMap((first) =>
            rightEntries.flatMap(([other, otherCount]) => ["u", "v"].map((last) =>
                ({ label: name + first + other + last, count: count * factor * otherCount })))));
        assert.deepEqual(Array.from(prefix(actual)), expected.flatMap((entry) => Array(entry.count).fill(entry.label)));
        let index = 0;
        for (const entry of expected) for (let repeat = 1; repeat <= entry.count; repeat += 1) {
            const selected = ctx.sceneScheduleAt(actual, index++);
            assert.equal(selected.count, entry.count);
            assert.equal(selected.repeatIndex, repeat);
        }
    }
    let compact = leaf("base");
    const rows = Array.from({ length: 30 }, (_, index) => ({ label: String(index) }));
    for (let stage = 0; stage < 3; stage += 1) compact = ctx.sceneScheduleMatrix(compact, rows);
    assert.equal(compact.units.length, 1);
    assert.equal(compact.stats.rows, 27000);
    assert.ok(JSON.stringify(compact).length < 6000, "preview retains Matrix input rows, not Cartesian combinations");
    compact = ctx.sceneScheduleCount(compact, 100000000);
    const last = ctx.sceneScheduleAt(compact, compact.stats.total - 1);
    assert.deepEqual(Array.from(last.parts), ["base", "29", "29", "29"]);
    assert.equal(last.repeatIndex, 100000000);
    for (const held of [false, true]) {
        let scalar = ctx.sceneScheduleCount(leaf("same"), 1, !held);
        for (let depth = 0; depth < 40; depth += 1) scalar = ctx.sceneScheduleMerge(scalar, scalar);
        assert.equal(scalar.units[0].kind, held ? "count_hold" : "run",
            "single-row shared Merge chains must not create exponentially traversed products");
        assert.deepEqual(Array.from(ctx.sceneScheduleAt(scalar, 0).row.labels), ["same"]);
        assert.equal(ctx.sceneScheduleCount(scalar, 10).stats.total, held ? 1 : 10);
    }
}
verifyCompactOrdinaryRows();
for (const kind of ["alternate", "sequence"]) for (const held of [false, true]) for (const fixed of [false, true]) {
    let singleton = queue([ctx.sceneScheduleCount(leaf("same"), 1, !held)], controls("alternate", 1, "{}", fixed ? "fixed" : "multiply"));
    if (kind === "sequence") singleton = ctx.sceneSchedulePlan([ctx.sceneScheduleSequence(singleton)], true);
    singleton = ctx.sceneScheduleMap(singleton, entry => entry, 3);
    for (let depth = 0; depth < 40; depth++) singleton = ctx.sceneScheduleMerge(singleton, singleton);
    assert.equal(singleton.units[0].kind, held ? "count_hold" : "run");
    assert.deepEqual(Array.from(ctx.sceneScheduleAt(singleton, 0).parts), ["same"]);
    assert.equal(singleton.stats.total, 1); assert.equal(singleton.stats.totalImages, 3);
    assert.equal(singleton.boundary, true);
    assert.equal(ctx.sceneScheduleCount(singleton, 10).stats.total, held ? 1 : 10);
}
for (const plan of [queue([leaf("repeat", 2)], controls("alternate")), queue([leaf("a"), leaf("b")], controls("alternate")), randomJoined]) {
    const merged = ctx.sceneScheduleMerge(plan, plan);
    assert.equal(merged.units[0].kind, "product", "multi-event and Random plans must keep their composition");
    assert.equal(merged.stats.total, plan.stats.total ** 2);
}
for (const boundary of [false, true]) {
    let empty = ctx.sceneSchedulePlan([], boundary);
    for (let depth = 0; depth < 40; depth += 1) empty = ctx.sceneScheduleMerge(empty, empty);
    assert.equal(empty.stats.rows, 0);
    assert.equal(empty.stats.total, 0);
    assert.equal(empty.boundary, boundary);
    assert.equal(empty.units.length, 0, "empty shared Merge chains do not retain product subtrees");
}

Object.assign(ctx, {
    sceneWorkflowLoadDepth: 0,
    sceneWorkflowLoadSources: new Set(),
    SCENE_QUEUE_CONTROL_DEFAULTS: controls(),
    SCENE_QUEUE_CONTROL_NAMES: ["order_mode", "alternate_block_size", "downstream_count_mode"],
    scenePresetDisplayGraphs: new Map(),
    scenePresetGraphNodes: (preset) => preset?.api_graph?.output || null,
    apiInput: (node, name) => node?.inputs?.[name],
    apiLink: (value) => Array.isArray(value) && value.length === 2 ? String(value[0]) : "",
    clampSceneCount: (value, fallback) => Number.isSafeInteger(value) ? value : fallback,
});
vm.runInContext(functionSource("sceneScheduleForPreset"), ctx);
const wholeBoundaryPreset = { api_graph: { output: {
    "1": { class_type: "ScenePresetInput", inputs: {} },
    "2": { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["1", 0], count: 1, prompt_trace_kind: "whole" } },
    "3": { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
} } };
const presetBoundaryArm = ctx.sceneScheduleForPreset("boundary", boundaryArm, new Set(), wholeBoundaryPreset);
assert.equal(presetBoundaryArm.stats.error, undefined);
assert.equal(presetBoundaryArm.randomGuards.length, 1, "saved whole boundary preserves the open Random arm");
assert.equal(queue([presetBoundaryArm, guarded(leaf("other"), 1)], controls()).stats.total, 1);
const preset = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0], prompt_name: "b1" } },
    3: { class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0], prompt_name: "b2" } },
    4: { class_type: "ScenePrompterQueue", inputs: { scene_prompt1: ["2", 0], scene_prompt2: ["3", 0],
        order_mode: "alternate", alternate_block_size: 1, input_repeats_json: "{}", downstream_count_mode: "multiply" } },
    5: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["4", 0] } },
} } };
const compactPresetWeights = [2900, 7100, 0, 0, 0, 0, 0, 0, 0, 0];
const randomPreset = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePromptRandomRoute", inputs: { scene_prompt: ["1", 0], weights_json: JSON.stringify(compactPresetWeights) } },
    3: { class_type: "ScenePrompter", inputs: { scene_prompt: ["2", 0], prompt_name: "A" } },
    4: { class_type: "ScenePrompter", inputs: { scene_prompt: ["2", 1], prompt_name: "B" } },
    5: { class_type: "ScenePrompterQueue", inputs: { scene_prompt1: ["3", 0], scene_prompt2: ["4", 0] } },
    6: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["5", 0] } },
} } };
const randomPresetPlan = ctx.sceneScheduleForPreset("random-preset", leaf("X"), new Set(), randomPreset, "reference-42");
assert.equal(randomPresetPlan.stats.total, 1, "Preset Random keeps one draw after Queue join");
assert.deepEqual(JSON.parse(JSON.stringify(prefix(randomPresetPlan))), ["ランダム候補"]);
assert.deepEqual(JSON.parse(JSON.stringify(randomPresetPlan.units[0].plans.map((branch) =>
    branch.randomGuards.at(-1).weights[branch.randomGuards.at(-1).armIndex]))), [2900, 7100],
"compact Preset preview retains its nondefault saved Random percentages");
assert.equal(ctx.sceneScheduleCount(randomPresetPlan, 10).stats.total, 10,
    "Count after a compact Random Preset multiplies one draw per generation, not two alternatives");
const frozenPreset = structuredClone(randomPreset);
frozenPreset.api_graph.output[2].inputs.weights_json = JSON.stringify([10000, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
frozenPreset.api_graph.output[2].inputs.preserve_join = true;
const frozenPlan = ctx.sceneScheduleForPreset("frozen-preset", leaf("X"), new Set(), frozenPreset, "reference-43");
assert.equal(frozenPlan.units[0].kind, "random_choice",
    "PNG replay's frozen 100/0 Random preserves the original Queue join");
assert.equal(frozenPlan.boundary, true);
assert.equal(ctx.sceneScheduleCount(frozenPlan, 10).stats.total, 10);
const outputPreset = structuredClone(randomPreset);
outputPreset.api_graph.output[5].class_type = "ScenePromptRandomRouteOutput";
outputPreset.api_graph.output[2].inputs.preserve_join = true;
const outputPlan = ctx.sceneScheduleForPreset("output-preset", leaf("X"), new Set(), outputPreset, "output-reference");
for (const saved of [randomPreset, outputPreset]) {
    assert.equal(ctx.sceneScheduleForPreset("invalid-upstream", incompleteRandom, new Set(), saved).stats.error,
        incompleteRandom.stats.error, "a complete Random join inside a Preset preserves its upstream error");
    const zero = ctx.sceneScheduleForPreset("valid-zero", ctx.sceneSchedulePlan(), new Set(), saved);
    assert.equal(zero.stats.total, 0);
    assert.equal(zero.stats.error, undefined, "legitimate zero-row inputs remain valid");
}
assert.equal(outputPlan.units[0].kind, "random_choice");
assert.equal(ctx.sceneScheduleCount(outputPlan, 10).stats.total, 10);
assert.equal(ctx.sceneScheduleCount(outputPlan, 1_000_000).units.length, 1);
const innerOutputPreset = structuredClone(outputPreset);
innerOutputPreset.api_graph.output[7] = { class_type: "ScenePromptRandomRoute", inputs: {
    scene_prompt: ["2", 0], weights_json: JSON.stringify([10000, 0, 0, 0, 0, 0, 0, 0, 0, 0]), preserve_join: true } };
innerOutputPreset.api_graph.output[8] = { class_type: "ScenePromptRandomRouteOutput", inputs: { scene_prompt10: ["7", 0] } };
innerOutputPreset.api_graph.output[3].inputs.scene_prompt = ["8", 0];
const nestedOutputPlan = ctx.sceneScheduleForPreset("nested-output", leaf("X"), new Set(), innerOutputPreset, "nested-reference");
assert.equal(nestedOutputPlan.stats.total, 1, "an inner 100% Output preserves the outer guarded group");
assert.equal(nestedOutputPlan.randomGuards.length, 0);
assert.equal(nestedOutputPlan.units[0].plans[0].units[0].kind, "map");
for (const [kind, inputs, pattern] of [
    ["empty", {}, /Output.*接続/u],
    ["missing", { scene_prompt1: ["3", 0] }, /ランダム分岐/u],
    ["duplicate", { scene_prompt1: ["3", 0], scene_prompt2: ["4", 0], scene_prompt3: ["3", 0] }, /ランダム分岐/u],
]) {
    const invalid = structuredClone(outputPreset); invalid.api_graph.output[5].inputs = inputs;
    assert.match(ctx.sceneScheduleForPreset(kind, leaf("X"), new Set(), invalid).stats.error, pattern);
}
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
    isScenePromptRandomRouteOutputNode: (node) => node.kind === "random_output",
    isScenePresetReferenceNode: () => false,
    isScenePromptMergeNode: () => false,
    scenePromptInputSource: (node) => node.upstream || null,
    connectedScenePromptSourcesForQueue: (node) => (node.sources || []).map((source, index) =>
        ({ input: { name: `scene_prompt${index + 1}` }, source })),
    sceneScheduleForLinkedInput: () => null,
    findWidget: (node, name) => node.widgets.find((widget) => widget.name === name),
    setWidgetValue: (node, name, value) => { node.widgets.find((widget) => widget.name === name).value = value; },
    hideWidget: (widget) => { widget.hidden = true; },
    findSceneWidget: () => null,
});
for (const name of ["isScenePromptJoinNode", "sceneQueueBoundaryInNode", "sceneQueuePendingInNode", "sceneQueueLockState", "syncSceneQueueControls"])
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
assert.deepEqual(widgets.map((widget) => widget.value), ["alternate", 3, "{}", "fixed"]);
assert.ok(widgets.filter((widget) => widget.name !== "input_repeats_json")
    .every((widget) => widget.disabled && widget.options.disabled));
assert.equal(widgets[2].hidden, true, "legacy repeat widget stays hidden in its serialized slot");
ctx.sceneScheduleForLinkedInput = (_node, name) => name === "scene_prompt1"
    ? guarded(leaf("A"), 0) : guarded(leaf("B"), 1);
receiving.sources = [previous, { id: "random-branch", kind: "prompt" }];
assert.equal(ctx.syncSceneQueueControls(receiving), "random",
    "a complete Random join locks Queue controls even with an upstream Queue");
assert.match(widgets[0].label, /ランダム分岐の合流/u);
ctx.sceneScheduleForLinkedInput = () => null;
receiving.sources = [{ id: "ordinary", kind: "prompt" }];
assert.equal(ctx.syncSceneQueueControls(receiving), "", "disconnecting upstream Queue unlocks controls");
assert.equal(widgets[1].disabled, false, "row repeat is active in input order mode");
assert.deepEqual(widgets.map((widget) => widget.value), ["alternate", 3, "{}", "fixed"],
    "locking and unlocking retain the Queue's own visible settings");
receiving.sources = [{ id: "bypass", kind: "queue", mode: 4, upstream: { id: "ordinary-2", kind: "prompt" } }];
assert.equal(ctx.syncSceneQueueControls(receiving), "", "bypassed Queue without effective Queue path does not lock");
receiving.sources.push(previous);
assert.equal(ctx.syncSceneQueueControls(receiving), "upstream", "a second active Queue keeps controls disabled");
previous.mode = 4; previous.upstream = { id: "previous-ordinary", kind: "prompt" };
assert.equal(ctx.syncSceneQueueControls(receiving), "");
previous.mode = 0;
assert.equal(ctx.syncSceneQueueControls(receiving), "upstream");
assert.deepEqual(widgets.map((widget) => widget.value), ["alternate", 3, "{}", "fixed"]);
ctx.isScenePromptRandomRouteNode = (node) => node.kind === "random";
vm.runInContext(functionSource("sceneRandomRouteInNode"), ctx);
const activeRoute = { id: "route-active", kind: "random" };
assert.equal(ctx.sceneRandomRouteInNode(activeRoute), true);
assert.equal(ctx.sceneRandomRouteInNode({ ...activeRoute, id: "route-muted", mode: 2 }), false);
assert.equal(ctx.sceneRandomRouteInNode({ ...activeRoute, id: "route-bypassed", mode: 4,
    upstream: { id: "ordinary-route-source", kind: "prompt" } }), false,
"bypassed Random does not impose route semantics");

Object.assign(ctx, {
    isRerouteNode: (node) => node.kind === "reroute",
    firstLinkedInput: (node) => node.inputs.find((input) => input.link != null),
    graphLink: (graph, id) => graph.links[id] || null,
    nodeClassName: (node) => node?.kind || "",
    linkKey: (link) => [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot].join(":"),
});
for (const name of ["resolveLinkedSourceFromLink", "resolveLinkedSourceFromInput"])
    vm.runInContext(functionSource(name), ctx);
const rerouteGraph = { links: {
    1: { id: 1, origin_id: "random", origin_slot: 1, target_id: "reroute", target_slot: 0 },
    2: { id: 2, origin_id: "reroute", origin_slot: 0, target_id: "target", target_slot: 0 },
} };
rerouteGraph.getNodeById = (id) => ({ random: { id: "random", kind: "random" },
    reroute: { id: "reroute", kind: "reroute", inputs: [{ link: 1 }] } })[id];
const resolvedReroute = ctx.resolveLinkedSourceFromInput(rerouteGraph, { link: 2 });
assert.equal(resolvedReroute.source.id, "random");
assert.equal(resolvedReroute.slot, 1, "Reroute preserves the Random output slot");

console.log("Scene Queue schedule, Count policy, chunking, and bounded preview tests passed.");

// Strict Count is path-local across every compact preview unit.
const hold = (plan, factor = 1) => ctx.sceneScheduleCount(plan, factor, false);
assert.equal(ctx.sceneScheduleCount(hold(a, 10), 10).stats.total, 10);
assert.equal(ctx.sceneScheduleCount(hold(ctx.sceneScheduleCount(a, 10), 10), 10).stats.total, 100);
const partial = queue([hold(a, 2), leaf("B", 2), leaf("C")], controls());
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleCount(partial, 3)))), [..."AABBCBBCBBC"]);
assert.deepEqual(JSON.parse(JSON.stringify(prefix(ctx.sceneScheduleCount(partial, 0)))), ["A", "A"]);
const example = ctx.sceneScheduleCount(queue([hold(a, 3), ctx.sceneScheduleCount(b, 2)], controls()), 10);
assert.equal(example.stats.total, 23);
assert.deepEqual(JSON.parse(JSON.stringify(prefix(example))), [...Array(3).fill("A"), ...Array(20).fill("B")]);
const repeatedProtected = queue([hold(a, 2), b], controls("alternate", 3));
assert.equal(repeatedProtected.stats.total, 9);
assert.equal(repeatedProtected.boundary, true);
assert.equal(ctx.sceneScheduleCount(repeatedProtected, 2).stats.total, 12);
const protectedMerge = ctx.sceneScheduleMerge(queue([hold(a), b], controls()), queue([hold(leaf("X")), leaf("Y")], controls()));
const multipliedMerge = ctx.sceneScheduleCount(protectedMerge, 3);
assert.equal(multipliedMerge.stats.total, 6);
assert.deepEqual(JSON.parse(JSON.stringify(prefix(multipliedMerge))), ["AX", "AY", "BX", "BY", "BY", "BY"]);
assert.equal(ctx.sceneScheduleCount(protectedMerge, 0).stats.total, 3);
const mappedPartial = ctx.sceneScheduleMap(partial, entry => ({ ...entry, parts: [...entry.parts, "mapped"] }), 5);
const mappedResult = ctx.sceneScheduleCount(mappedPartial, 3);
assert.equal(mappedResult.stats.totalImages, mappedResult.stats.total * 5);
assert.equal(mappedResult.stats.unsetBatches, 0);
assert.equal(ctx.sceneScheduleCount(ctx.sceneScheduleMatrix(partial, [{ label: "x" }, { label: "y" }]), 3).stats.total, 22);
for (const factor of [0, 2]) {
    const randomPolicyMismatch = ctx.sceneRandomChoicePlan([guarded(hold(a), 0), guarded(b, 1)]);
    assert.match(ctx.sceneScheduleCount(randomPolicyMismatch, factor).stats.error, /Count.*一致/u);
}
const randomPositions = ctx.sceneRandomChoicePlan([guarded(partial, 0), guarded(queue([leaf("C"), hold(a, 2), leaf("B", 2)], controls()), 1)]);
assert.equal(ctx.sceneScheduleCount(randomPositions, 3).stats.total, 11);
assert(prefix(ctx.sceneScheduleCount(randomPositions, 3)).every(label => label === "ランダム候補"));
const randomImagePolicy = ctx.sceneRandomChoicePlan([
    guarded(queue([hold(leaf("A", 1, 2)), leaf("B", 1, 1)], controls()), 0),
    guarded(queue([hold(leaf("C", 1, 1)), leaf("D", 1, 2)], controls()), 1),
]);
assert(ctx.sceneScheduleCount(randomImagePolicy, 2).stats.error);
const resolvedImagePolicy = ctx.sceneScheduleMap(randomImagePolicy, entry => entry, 5);
assert.equal(ctx.sceneScheduleCount(resolvedImagePolicy, 2).stats.totalImages, 15);
assert.equal(ctx.sceneScheduleCount(resolvedImagePolicy, 0).stats.totalImages, 5);
const unresolvedBatchPolicy = ctx.sceneScheduleMap(ctx.sceneRandomChoicePlan([guarded(hold(a), 0), guarded(b, 1)]), entry => entry, 5);
for (const factor of [0, 2]) assert(ctx.sceneScheduleCount(unresolvedBatchPolicy, factor).stats.error);
const hugeHeld = ctx.sceneScheduleCount(queue([hold(a, 2), leaf("B", 10_000_000)], controls("alternate")), 100_000_000);
assert.equal(hugeHeld.stats.total, 1_000_000_000_000_002);
assert.equal(ctx.sceneScheduleAt(hugeHeld, hugeHeld.stats.total - 1).parts[0], "B");
assert(JSON.stringify(hugeHeld).length < 12000);
assert(!JSON.stringify(hugeHeld).includes("countPolicy"));
assert(ctx.sceneScheduleCount(queue([hold(a), leaf("B", Math.floor(Number.MAX_SAFE_INTEGER / 2))], controls()), 3).stats.error);
let entirelyHeld = hold(a, 3);
const heldUnits = entirelyHeld.units;
for (let index = 0; index < 200; index += 1) {
    entirelyHeld = ctx.sceneScheduleCount(entirelyHeld, index % 2 ? 0 : 100, index % 3 !== 0);
    assert.strictEqual(entirelyHeld.units, heldUnits);
}
const innerCount = { api_graph: { output: {
    1: { class_type: "ScenePresetInput", inputs: {} },
    2: { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["1", 0], count: 3, enable_downstream_count: false } },
    3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
} } };
ctx.scenePresetDisplayGraphs.set("inner-count", innerCount);
const outerCount = { api_graph: { output: {
    1: { class_type: "ScenePresetReference", inputs: { preset_id: "inner-count" } },
    2: { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["1", 0], count: 10 } },
    3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
} } };
const presetHeld = ctx.sceneScheduleForPreset("outer-count", null, new Set(), outerCount);
assert.equal(presetHeld.stats.total, 3);
assert.equal(presetHeld.stats.hasCountHold, true);
assert.equal(ctx.sceneScheduleCount(presetHeld, 0).stats.total, 3);
for (const name of ["sceneCounterConfiguredValues", "sceneCounterConfigureValues", "scenePromptCounterDownstreamEnabled"])
    vm.runInContext(functionSource(name), ctx);
for (const config of [{}, { widgets_values: [10] }, { widgets_values: [10], widgets_values_named: { count: 10 } },
    { widgets_values: [10, "source-id", "source-title"] }]) assert.equal(ctx.sceneCounterConfiguredValues(config).enable_downstream_count, true);
const oldSources = ctx.sceneCounterConfiguredValues({ widgets_values: [10, "source-id", "source-title"] });
assert.equal(oldSources.source_node_id, "source-id"); assert.equal(oldSources.source_node_name, "source-title");
assert.equal(ctx.sceneCounterConfiguredValues({ widgets_values: [10, false] }).enable_downstream_count, false);
assert.equal(ctx.sceneCounterConfiguredValues({ widgets_values: [10, true], widgets_values_named: { enable_downstream_count: false } }).enable_downstream_count, false);
console.log("Strict Count preview composition, Random policy, compact huge access, nested Presets and legacy widget migration passed.");

function verifyPresetMatrixMergeParity() {
    ctx.parseMatrixStateValue = JSON.parse;
    const labels = (plan) => Array.from(prefix(plan));
    const matrixRows = [{ label: "x", enabled: true }, { label: "y", enabled: true }];
    for (const factor of [0, 1, 2, 3]) {
        const counted = ctx.sceneScheduleCount(leaf("A"), factor);
        const mapped = ctx.sceneScheduleMap(counted, (entry) => ({ ...entry, parts: [...entry.parts, "P"] }));
        const matrix = ctx.sceneScheduleMatrix(mapped, matrixRows);
        assert.deepEqual(labels(matrix), [...Array(factor).fill("APx"), ...Array(factor).fill("APy")]);
        const merged = ctx.sceneScheduleMerge(matrix, leaf("B", 2));
        assert.deepEqual(labels(merged), [...Array(factor * 2).fill("APxB"), ...Array(factor * 2).fill("APyB")]);
    }
    const fixture = { api_graph: { output: {
        1: { class_type: "ScenePresetInput", inputs: {} },
        2: { class_type: "ScenePromptCounter", inputs: { scene_prompt: ["1", 0], count: 2 } },
        3: { class_type: "SceneMatrix", inputs: { scene_prompt: ["2", 0], matrix_json: JSON.stringify({ sets: matrixRows }) } },
        4: { class_type: "ScenePrompterMerge", inputs: { scene_prompt1: ["3", 0] } },
        5: { class_type: "SceneEmptyLatent", inputs: { scene_prompt: ["4", 0], batch_size: 3 } },
        6: { class_type: "ScenePrompterMerge", inputs: { scene_prompt1: ["5", 0] } },
        7: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["6", 0] } },
    } } };
    const preset = ctx.sceneScheduleForPreset("matrix-merge", leaf("A"), new Set(), fixture);
    assert.deepEqual(labels(preset), ["Ax", "Ax", "Ay", "Ay"]);
    assert.equal(preset.stats.rows, 2);
    assert.equal(preset.stats.totalImages, 12);
    assert.equal(preset.stats.unsetBatches, 0);
    const latent = ctx.sceneScheduleMap(queue([leaf("A"), leaf("B")], controls("alternate")), (entry) => entry, 3);
    assert.equal(ctx.sceneScheduleAt(latent, 1).row.latent.batch_size, 3);
    assert.equal(ctx.sceneScheduleMerge(latent, leaf("C", 1, 5)).stats.totalImages, 10);
}
verifyPresetMatrixMergeParity();

if (process.argv.includes("--compact-count-response")) {
    async function verifyCompactCountResponse() {
        const { preparePresetReference } = await import(require("node:url").pathToFileURL(path.join(__dirname, "..", "web", "scene_llm_presets.js")).href);
        const fixture = JSON.parse(fs.readFileSync(0, "utf8"));
        assert.deepEqual(fixture.response.errors, []);
        ctx.scenePresetDisplayGraphs.clear();
        for (const preset of fixture.response.presets) ctx.scenePresetDisplayGraphs.set(preset.metadata.preset_id, preset);
        for (const entry of fixture.cases) {
            const reference = { widgets: [{ name: "preset_id", value: entry.preset_id }, { name: "llm_presets_json", value: "{}" }] };
            const prepared = preparePresetReference(reference, ctx.scenePresetDisplayGraphs);
            assert.equal(prepared.error, null);
            const plan = ctx.sceneScheduleForPreset(entry.preset_id, null, new Set(), prepared.root);
            const result = ctx.sceneScheduleCount(plan, entry.factor);
            assert.equal(result.stats.total, entry.total, `${entry.preset_id} * ${entry.factor}: real compact response matches execution`);
            assert.equal(result.stats.error, undefined);
        }
        console.log("Real compact Preset response Count parity passed.");
    }
    verifyCompactCountResponse().catch((error) => { console.error(error); process.exitCode = 1; });
}
