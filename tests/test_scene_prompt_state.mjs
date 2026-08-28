import assert from "node:assert/strict";

import {
    createMatrixLine,
    createMatrixState,
    createSelectionState,
    formatSceneExpandCounts,
    parseMatrixState,
    parseSelectionState,
    serializeMatrixState,
    serializeSelectionState,
} from "../web/scene_prompt_state.js";

assert.deepEqual(parseSelectionState(null), createSelectionState());
assert.deepEqual(parseMatrixState(""), createMatrixState());
assert.throws(() => parseSelectionState('{"version":0,"categories":{}}'), /schema version/u);
assert.throws(() => parseSelectionState('{"version":1,"categories":[]}'), /categories/u);
assert.throws(() => parseSelectionState('{broken'), /invalid/u);
const selectionItem = {
    id: "a", label: "A", prompt: "alpha, beta", category_path: ["Category"],
    category_key: "Category", category_label: "Category",
    selected_parts: [{ index: 0, text: "alpha", weight: 1.2 }],
};
assert.equal(parseSelectionState({ version: 1, categories: { Category: [selectionItem] } }).categories.Category[0].label, "A");
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [{ ...selectionItem, weight: "bad" }] } }), /weight/u);
const { prompt, ...missingPrompt } = selectionItem;
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [missingPrompt] } }), /missing/u);
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [{ ...selectionItem, legacy: true }] } }), /unsupported/u);

const line = createMatrixLine("Night");
line.positive_base = "night, forest";
line.negative_base = "daylight";
const state = { version: 1, sets: [line] };
assert.deepEqual(parseMatrixState(serializeMatrixState(state)), state);
assert.equal(parseMatrixState(serializeMatrixState(state)).sets[0].positive_base, "night, forest");
assert.throws(() => parseMatrixState('{"version":1,"sets":[{"name":"old"}]}'), /unsupported|schema/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, enabled: "true" }] }), /boolean/u);
const { positive_base, ...oldLine } = line;
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...oldLine, positive: "old" }] }), /unsupported|positive/u);
assert.equal(serializeSelectionState(createSelectionState()), '{"version":1,"categories":{}}');
assert.equal(formatSceneExpandCounts(2, 6), "2回 / 6枚");
assert.throws(() => formatSceneExpandCounts(2, 6.5), /integer/u);

console.log("scene prompt state tests passed");
