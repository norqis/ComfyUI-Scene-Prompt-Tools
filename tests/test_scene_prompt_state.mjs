import assert from "node:assert/strict";

import {
    SCENE_MODEL_MODES,
    createMatrixLine,
    createMatrixState,
    createSelectionState,
    formatSceneExpandCounts,
    parseMatrixState,
    parseSelectionState,
    serializeMatrixState,
    serializeSelectionState,
} from "../web/scene_prompt_state.js";

assert.deepEqual(SCENE_MODEL_MODES, ["Illustrious", "Anima", "NoobAI", "Pony"]);
assert.deepEqual(parseSelectionState(null), createSelectionState());
assert.deepEqual(parseMatrixState(""), createMatrixState());
assert.throws(() => parseSelectionState('{"version":0,"categories":{}}'), /形式番号.*対応していません/u);
assert.throws(() => parseSelectionState('{"version":1,"categories":[]}'), /カテゴリ一覧/u);
assert.throws(() => parseSelectionState('{broken'), /JSONとして読み取れません.*開き直し/u);
const selectionItem = {
    id: "a", label: "A", prompt: "alpha, beta", category_path: ["Category"],
    category_key: "Category", category_label: "Category",
    selected_parts: [{ index: 0, text: "alpha", weight: 1.2 }],
};
for (const name of ["__proto__", "constructor", "toString"]) {
    const state = createSelectionState();
    assert.equal(state.categories[name], undefined);
    state.categories[name] = [{ ...selectionItem, category_key: name, category_label: name, category_path: [name] }];
    const restored = parseSelectionState(serializeSelectionState(state));
    assert.equal(restored.categories[name][0].prompt, selectionItem.prompt);
    assert.deepEqual(Object.keys(restored.categories), [name]);
}
assert.equal(parseSelectionState({ version: 1, categories: { Category: [selectionItem] } }).categories.Category[0].label, "A");
for (const [prompt, parts] of [
    ["beta, gamma", [{ index: 0, text: "alpha", missing: true, weight: 1.3 }, { index: 0, text: "beta", weight: 1.2 }]],
    ["beta, alpha", [{ index: 1, text: "alpha", weight: 1.3 }, { index: 1, text: "alpha", missing: true, weight: 1.2 }]],
]) {
    const value = { version: 1, categories: { Category: [{ ...selectionItem, prompt, selected_parts: parts }] } };
    const parsed = parseSelectionState(value);
    const result = parsed.categories.Category[0].selected_parts;
    assert.equal(result.find((part) => part.missing).index, 2);
    assert.deepEqual(result.map(({ text, weight }) => [text, weight]), parts.map(({ text, weight }) => [text, weight]));
    assert.deepEqual(parseSelectionState(serializeSelectionState(parsed)), parsed, "repaired stored selections remain stable");
}
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [{ ...selectionItem,
    selected_parts: [selectionItem.selected_parts[0], selectionItem.selected_parts[0]],
}] } }), /選択位置が重複/u, "repeated active selections remain invalid");
for (const weight of [-20, 50]) {
    const weighted = { ...selectionItem, selected_parts: [{ index: 0, text: "alpha", weight }] };
    assert.equal(parseSelectionState({ version: 1, categories: { Category: [weighted] } }).categories.Category[0].selected_parts[0].weight, weight);
}
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [{ ...selectionItem, weight: "bad" }] } }), /候補「A」.*強度と部分選択.*両方/u);
const { prompt, ...missingPrompt } = selectionItem;
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [missingPrompt] } }), /候補名・プロンプト.*未対応/u);
assert.throws(() => parseSelectionState({ version: 1, categories: { Category: [{ ...selectionItem, legacy: true }] } }), /未対応/u);
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
}), /カテゴリ名と階層が一致しません/u);
assert.throws(() => parseSelectionState({
    version: 1,
    categories: { Category: [{ label: "A", prompt: "a", legacy_keys: ["Category::A"], unknown: true }] },
}), /未対応/u);

const line = createMatrixLine("Night");
assert.equal(line.filename_enabled, false);
line.positive_base = "night, forest";
line.negative_base = "daylight";
const state = { version: 1, sets: [line] };
assert.deepEqual(parseMatrixState(serializeMatrixState(state)), state);
assert.equal(parseMatrixState(serializeMatrixState(state)).sets[0].positive_base, "night, forest");
assert.throws(() => parseMatrixState('{"version":1,"sets":[{"name":"old"}]}'), /Matrix行「old」.*識別名.*未対応/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, enabled: "true" }] }), /有効・無効.*trueまたはfalse/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, filename_enabled: "true" }] }), /ファイル名付与.*trueまたはfalse/u);
const { positive_base, ...oldLine } = line;
assert.equal(parseMatrixState({ version: 1, sets: [{ row_id: "old", name: "Old", path_label: "Old" }] }).sets[0].enabled, true);
assert.equal(parseMatrixState({ version: 1, sets: [{ row_id: "old", name: "Old", path_label: "Old" }] }).sets[0].filename_enabled, false);
assert.deepEqual(parseMatrixState({ version: 1, sets: [{ row_id: "old", name: "Old", path_label: "Old" }] }).sets[0].display_label_groups, []);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...oldLine, unknown: true }] }), /未対応/u);
assert.throws(() => parseMatrixState({ version: 1, sets: [{ ...line, sceneScheduleRenderSummaries: true }] }), /未対応/u);
assert.equal(serializeSelectionState(createSelectionState()), '{"version":1,"categories":{}}');
assert.equal(formatSceneExpandCounts(2, 6), "2回 / 6枚");
assert.throws(() => formatSceneExpandCounts(2, 6.5), /生成枚数.*0以上の整数/u);

const namedBadSelection = JSON.stringify({ version: 1, categories: { "衣装 > 制服": [{ label: "夏服", prompt: "summer uniform", selected_parts: [{ index: 0, text: "summer uniform", weight: "bad" }] }] } });
assert.throws(() => parseSelectionState(namedBadSelection), error => {
    assert.match(error.message, /カテゴリ「衣装 > 制服」.*候補「夏服」.*部分選択 1番目.*強度.*数値/u);
    assert.match(error.message, /設定を確認.*開き直/u);
    assert.doesNotMatch(error.message, /must be|corrupt|破損/u);
    return true;
});
const matrixBadSelection = JSON.stringify({ version: 1, sets: [{ ...line, name: "夜の森", negative_json: "{broken" }] });
assert.throws(() => parseMatrixState(matrixBadSelection), /Matrix行「夜の森」: ネガティブ候補:.*JSONとして読み取れません/u);
assert.equal(JSON.parse(matrixBadSelection).sets[0].negative_json, "{broken", "reporting does not repair or delete saved data");

console.log("scene prompt state tests passed");
