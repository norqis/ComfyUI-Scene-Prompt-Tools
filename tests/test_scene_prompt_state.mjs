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
const legacySelection = parseSelectionState({
    version: 1,
    categories: { "Outfit > School": [{ label: "Summer", prompt: "summer uniform" }] },
});
assert.deepEqual(legacySelection.categories["Outfit > School"][0], {
    label: "Summer",
    prompt: "summer uniform",
    category_path: ["Outfit", "School"],
    category_key: "Outfit > School",
    category_label: "Outfit > School",
});
const legacyKeysSelection = parseSelectionState({
    version: 1,
    categories: { Outfit: [{ label: "Summer", prompt: "summer uniform", legacy_keys: ["Outfit::Summer"] }] },
});
assert.deepEqual(legacyKeysSelection.categories.Outfit[0], {
    label: "Summer",
    prompt: "summer uniform",
    category_path: ["Outfit"],
    category_key: "Outfit",
    category_label: "Outfit",
});
assert.doesNotMatch(serializeSelectionState(legacyKeysSelection), /legacy_keys/u);
for (const legacyKeys of ["Outfit::Summer", [], [""], [1]]) {
    assert.throws(() => parseSelectionState({
        version: 1,
        categories: { Outfit: [{ label: "Summer", prompt: "summer uniform", legacy_keys: legacyKeys }] },
    }), /legacy_keys/u);
}
assert.throws(() => parseSelectionState({
    version: 1,
    categories: { "Outfit > School": [{ label: "Summer", prompt: "summer uniform", category_key: "Wrong" }] },
}), /inconsistent/u);
assert.throws(() => parseSelectionState({
    version: 1,
    categories: { Category: [{ label: "A", prompt: "a", legacy_keys: ["Category::A"], unknown: true }] },
}), /unsupported/u);

const line = createMatrixLine("Night");
assert.equal(line.filename_enabled, false);
line.positive_base = "night, forest";
line.negative_base = "daylight";
const state = { version: 1, sets: [line] };
assert.deepEqual(parseMatrixState(serializeMatrixState(state)), state);
assert.equal(parseMatrixState(serializeMatrixState(state)).sets[0].positive_base, "night, forest");
assert.throws(() => parseMatrixState('{"version":1,"sets":[{"name":"old"}]}'), /unsupported|schema/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, enabled: "true" }] }), /boolean/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, filename_enabled: "true" }] }), /boolean/u);
const { positive_base, ...oldLine } = line;
assert.equal(parseMatrixState({ version: 1, sets: [{ row_id: "old", name: "Old", path_label: "Old" }] }).sets[0].enabled, true);
assert.equal(parseMatrixState({ version: 1, sets: [{ row_id: "old", name: "Old", path_label: "Old" }] }).sets[0].filename_enabled, false);
assert.deepEqual(parseMatrixState({ version: 1, sets: [{ row_id: "old", name: "Old", path_label: "Old" }] }).sets[0].display_label_groups, []);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...oldLine, unknown: true }] }), /unsupported/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, sceneScheduleRenderSummaries: true }] }), /unsupported/u);
assert.equal(serializeSelectionState(createSelectionState()), '{"version":1,"categories":{}}');
assert.equal(formatSceneExpandCounts(2, 6), "2回 / 6枚");
assert.throws(() => formatSceneExpandCounts(2, 6.5), /integer/u);

console.log("scene prompt state tests passed");
