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
        if (source[index] === "{") depth += 1;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

const writes = [];
const context = {
    Number,
    Object,
    String,
    Map,
    Set,
    JSON,
    writeStateToWidget(node, state, widgetName) {
        writes.push({ node, widgetName, value: JSON.parse(JSON.stringify(state)) });
    },
};
vm.createContext(context);
for (const name of [
    "activeStateWidgetName",
    "itemPath",
    "pathKey",
    "itemCategoryKey",
    "itemKey",
    "normalizeWeight",
    "weightForStorage",
    "splitPromptParts",
    "itemPromptParts",
    "normalizedSelectedParts",
    "itemForState",
    "itemSelectionSignature",
    "pruneStateToData",
]) {
    vm.runInContext(functionSource(name), context);
}

const category = "顔のパーツ別 > 目";
function candidate(id, label = "男目無し", prompt = "no eyes, blank eyes") {
    return {
        id,
        label,
        prompt,
        category_path: ["顔のパーツ別", "目"],
        category_key: category,
        category_label: category,
    };
}

function stateFor(item) {
    return {
        version: 1,
        categories: {
            [category]: [item],
        },
    };
}

const oldSelection = {
    ...candidate("目無し"),
    weight: 1.4,
    selected_parts: [{ index: 1, text: "blank eyes", weight: 1.2 }],
};
const current = candidate("目無し_2");
const normalizedState = stateFor(oldSelection);
const normalizedNode = { sceneDefaultStateWidgetName: "positive_json" };
context.pruneStateToData(normalizedNode, normalizedState, [current]);

const normalized = normalizedState.categories[category][0];
assert.equal(normalized.id, "目無し_2", "old IDs normalize to the current candidate ID");
assert.equal(
    JSON.stringify(normalized.selected_parts),
    JSON.stringify([{ index: 1, text: "blank eyes", weight: 1.2 }]),
    "selected parts and weights are preserved",
);
assert.equal(normalized.weight, undefined, "partial selection keeps per-part weights instead of an item weight");
assert.equal(writes.length, 1, "normalization writes the current state back to the widget");
assert.equal(writes[0].widgetName, "positive_json");
assert.equal(writes[0].value.categories[category][0].id, "目無し_2", "queued widget serialization uses the normalized ID");

writes.length = 0;
const currentSelection = { ...candidate("目無し_2"), weight: 1.3 };
context.pruneStateToData({ sceneDefaultStateWidgetName: "positive_json" }, stateFor(currentSelection), [current]);
assert.equal(writes.length, 0, "current IDs remain untouched");

assert.throws(
    () => context.pruneStateToData({}, stateFor(oldSelection), [candidate("other", "別の候補")]),
    /候補データにありません/u,
    "a missing match remains an error",
);

assert.throws(
    () => context.pruneStateToData({}, stateFor(oldSelection), [current, candidate("目無し_3")]),
    /候補データにありません/u,
    "ambiguous matches remain an error",
);

console.log("Scene Prompt selection normalization tests passed.");
