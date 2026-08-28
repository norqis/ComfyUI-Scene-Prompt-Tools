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
assert.match(
    source,
    /formatSceneExpandCounts\(cache\.totalBatches, cache\.totalImages\)/u,
    "Queue displays runs and images with the same format as Expand",
);

console.log("scene queue count tests passed");
