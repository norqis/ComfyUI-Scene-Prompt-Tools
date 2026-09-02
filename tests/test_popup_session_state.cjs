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

const context = {
    Map,
    WeakMap,
    String,
    Object,
    Array,
};
vm.createContext(context);
vm.runInContext("const popupSessionsByNode = new WeakMap();", context);
vm.runInContext("let activePopupContext = null;", context);
for (const name of [
    "activeStateWidgetName",
    "matrixLineDraftContextFor",
    "popupStateWidgetName",
    "createPopupSession",
    "popupSessionScopeKey",
    "popupSessionFor",
    "discardPopupSession",
    "setPopupListLocation",
    "resetPopupForm",
]) {
    vm.runInContext(functionSource(name), context);
}
context.listCalls = [];
context.selectedCalls = [];
context.openSavedPromptLevelPicker = (...args) => context.listCalls.push(["saved", ...args]);
context.openPromptCandidatePopup = (...args) => context.listCalls.push(["candidates", ...args]);
context.openCategoryLevelPicker = (...args) => context.listCalls.push(["categories", ...args]);
context.openSelectedPopup = (...args) => context.selectedCalls.push(args);
vm.runInContext(functionSource("openListFromPopupSession"), context);
vm.runInContext(functionSource("openSelectedFromPopupSession"), context);

const firstNode = { sceneDefaultStateWidgetName: "positive_json" };
const first = context.popupSessionFor(firstNode, "positive_json");
context.setPopupListLocation(first, "candidates", ["人物", "髪"]);
first.candidateQueries["人物 > 髪"] = "long hair";
first.searchQuery = "ribbon";
first.forms.create = {
    category: "人物",
    subcategory: "髪",
    name: "髪型",
    prompt: "long hair, ribbon",
    description: "作成途中",
};
first.forms.save = { name: "基本セット", description: "保存途中" };
first.selected.detailId = "saved-basic";
first.scrollTops.search = 128;

const returnedFromSearch = context.popupSessionFor(firstNode, "positive_json");
assert.equal(returnedFromSearch, first, "internal navigation keeps the same popup session");
assert.equal(JSON.stringify(returnedFromSearch.list), JSON.stringify({ kind: "candidates", path: ["人物", "髪"] }));
assert.equal(returnedFromSearch.candidateQueries["人物 > 髪"], "long hair");
assert.equal(returnedFromSearch.searchQuery, "ribbon");
assert.equal(returnedFromSearch.forms.create.prompt, "long hair, ribbon");
assert.equal(returnedFromSearch.forms.save.name, "基本セット");
assert.equal(returnedFromSearch.selected.detailId, "saved-basic");
assert.equal(returnedFromSearch.scrollTops.search, 128);
context.openListFromPopupSession(firstNode, { stateWidgetName: "positive_json" });
assert.equal(context.listCalls.at(-1)[0], "candidates", "一覧 returns to the exact candidate view");
assert.equal(JSON.stringify(context.listCalls.at(-1)[2]), JSON.stringify(["人物", "髪"]));
context.openSelectedFromPopupSession(firstNode, { stateWidgetName: "positive_json" });
assert.equal(context.selectedCalls.at(-1)[1].restoreDetail, true, "選択済み一覧 restores its saved-prompt detail location");

context.resetPopupForm(first, "create");
assert.equal(JSON.stringify(first.forms.create), JSON.stringify({ category: "", subcategory: "", name: "", prompt: "", description: "" }), "successful create clears only its draft");
assert.equal(JSON.stringify(first.forms.save), JSON.stringify({ name: "基本セット", description: "保存途中" }), "create does not clear the save draft");
first.forms.save.description = "error still keeps this";
assert.equal(first.forms.save.description, "error still keeps this", "errors leave drafts untouched until a successful operation resets them");
context.resetPopupForm(first, "save");
assert.equal(JSON.stringify(first.forms.save), JSON.stringify({ name: "", description: "" }), "successful save clears only its draft");

const negative = context.popupSessionFor(firstNode, "negative_json");
const secondNode = context.popupSessionFor({ sceneDefaultStateWidgetName: "positive_json" }, "positive_json");
assert.notEqual(negative, first, "positive and negative widgets never share popup state");
assert.notEqual(secondNode, first, "different nodes never share popup state");
assert.equal(negative.searchQuery, "", "another widget starts empty");
assert.equal(secondNode.searchQuery, "", "another node starts empty");
assert.deepEqual(Object.keys(firstNode), ["sceneDefaultStateWidgetName"], "popup state is never stored on the node");

const matrixNode = {
    sceneDefaultStateWidgetName: "matrix_line_positive_json",
    sceneMatrixLineDraftContext: {
        index: 0,
        stateWidgetName: "matrix_line_positive_json",
        draft: { row_id: "row-a" },
    },
};
const rowA = context.popupSessionFor(matrixNode, "matrix_line_positive_json");
rowA.searchQuery = "row-a-query";
matrixNode.sceneMatrixLineDraftContext = {
    index: 1,
    stateWidgetName: "matrix_line_positive_json",
    draft: { row_id: "row-b" },
};
const rowB = context.popupSessionFor(matrixNode, "matrix_line_positive_json");
assert.notEqual(rowB, rowA, "Matrix rows with the same positive widget use isolated sessions");
assert.equal(rowB.searchQuery, "", "a different Matrix row starts empty");
matrixNode.sceneMatrixLineDraftContext = {
    index: 0,
    stateWidgetName: "matrix_line_positive_json",
    draft: { row_id: "row-a" },
};
assert.equal(context.popupSessionFor(matrixNode, "matrix_line_positive_json"), rowA, "internal navigation in one Matrix row keeps its session");
const rowAScope = context.popupSessionScopeKey(matrixNode, "matrix_line_positive_json");
context.discardPopupSession(matrixNode, rowAScope);
assert.notEqual(context.popupSessionFor(matrixNode, "matrix_line_positive_json"), rowA, "explicit Matrix picker close discards that row session");

context.discardPopupSession(firstNode, "positive_json");
const reopened = context.popupSessionFor(firstNode, "positive_json");
assert.notEqual(reopened, first, "explicit close discards the popup session");
assert.equal(reopened.searchQuery, "", "close and reopen starts fresh");
assert.equal(JSON.stringify(reopened.list), JSON.stringify({ kind: "categories", path: [] }));
assert.match(functionSource("closePopup"), /discardPopupSession\(closingContext\.node, closingContext\.popupSessionScopeKey\)/u, "explicit popup close discards the transient session");

for (const marker of [
    'rememberPopupScroll(session, popupListScrollKey("categories", path), list)',
    'rememberPopupScroll(session, popupListScrollKey("saved", path), list)',
    'rememberPopupScroll(session, popupListScrollKey("candidates", path), list)',
    'rememberPopupScroll(session, "selected", list)',
    'rememberPopupScroll(session, "search", list)',
    'resetPopupForm(session, "save")',
    'resetPopupForm(session, "create")',
]) {
    assert.ok(source.includes(marker), `UI keeps the expected transient state: ${marker}`);
}

console.log("Popup session state tests passed.");
