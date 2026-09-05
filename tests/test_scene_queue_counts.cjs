const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    assert.notEqual(bodyStart, -1, `Missing function body: ${name}`);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") {
            depth += 1;
        } else if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Unclosed function: ${name}`);
}

assert.doesNotMatch(functionSource("computeScenePromptQueueDisplayCache"), /scenePromptQueueRowEntries\(/u, "Queue display cache never expands every generated row");
assert.doesNotMatch(functionSource("refreshScenePromptQueueNode"), /scenePromptQueueRowEntries\(/u, "Queue refresh stays bounded to scalar stats and preview rows");

const context = {
    Number,
    Object,
    String,
    mergeScenePromptRows(first, second) {
        return { ...(first || {}), ...(second || {}) };
    },
};
vm.createContext(context);
for (const name of [
    "sceneStatNumber",
    "multiplyScenePromptEntryCount",
    "scenePromptEntryBatchSize",
    "scenePromptEntryImageCount",
    "mergeScenePromptEntryPair",
    "emptyScenePromptStats",
    "sceneStatProduct",
    "sceneStatSum",
    "sceneStatsSeed",
    "sceneStatsResult",
    "sceneStatsMatrix",
    "sceneStatsCount",
    "sceneStatsWithLatent",
    "sceneStatsMerge",
    "sceneStatsQueue",
]) {
    vm.runInContext(functionSource(name), context);
}

const countedTwice = context.multiplyScenePromptEntryCount({ count: 2 }, 3);
const countedThreeTimes = context.multiplyScenePromptEntryCount(countedTwice, 2);
assert.equal(countedThreeTimes.count, 12, "serial Count nodes multiply their upstream count");

const merged = context.mergeScenePromptEntryPair(
    { count: 2, row: { latent: { batch_size: 3 } } },
    { count: 4, row: { latent: { batch_size: 1 } } },
);
assert.equal(merged.count, 8, "Merge multiplies the count from both branches");

const queued = { count: 2, row: { latent: { batch_size: 3 } } };
assert.equal(context.scenePromptEntryImageCount(queued), 6, "two runs at batch size three produce six images");
const left = context.sceneStatsWithLatent(context.sceneStatsCount(context.sceneStatsSeed(), 2), 3);
const right = context.sceneStatsQueue([
    context.sceneStatsWithLatent(context.sceneStatsSeed(), 4),
    context.sceneStatsSeed(),
], true);
const mergedStats = context.sceneStatsMerge(left, right);
assert.equal(JSON.stringify(mergedStats), JSON.stringify({ rows: 2, total: 4, totalImages: 14, unsetBatches: 0 }), "Merge uses the right latent batch and preserves mixed unset batches");
assert.equal(JSON.stringify(context.sceneStatsQueue([context.emptyScenePromptStats()], true)), JSON.stringify(context.emptyScenePromptStats()), "a connected empty Queue remains empty");
assert.equal(JSON.stringify(context.sceneStatsQueue([], false)), JSON.stringify(context.sceneStatsSeed()), "an unconnected Queue keeps the seed plan");
const overflow = context.sceneStatsResult(context.sceneStatsCount(context.sceneStatsCount(context.sceneStatsSeed(), Number.MAX_SAFE_INTEGER), 2));
assert.match(overflow.error, /大きすぎ/u, "unsafe totals carry an error instead of becoming a plausible zero");
assert.match(context.sceneStatsQueue([overflow, context.sceneStatsSeed()], true).error, /大きすぎ/u, "Queue propagates an overflowing branch error");
assert.match(
    source,
    /formatSceneExpandCounts\(cache\.totalBatches, cache\.totalImages\)/u,
    "Queue displays runs and images with the same format as Expand",
);

console.log("scene queue count tests passed");
