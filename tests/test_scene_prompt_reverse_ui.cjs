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

assert.match(source, /SCENE_PROMPT_REVERSE_NODE_NAMES/u);
assert.match(source, /ScenePromptReverse: "Scene Prompt Reverse"/u);
assert.match(source, /reverse_scope: "対象"/u);
assert.match(source, /SCENE_PLAN_NODE_CLASS_TYPES[\s\S]*"ScenePromptReverse"/u);
assert.match(source, /SCENE_SOURCE_NODE_CLASS_TYPES[\s\S]*"ScenePromptReverse"/u);
assert.match(functionSource("isScenePromptSourceNode"), /isScenePromptReverseNode\(node\)/u);
assert.match(functionSource("scenePromptSourceLocalCacheKey"), /type: "reverse"/u);
assert.match(functionSource("scenePromptSourceLocalCacheKey"), /reverse_scope: scenePromptReverseScope\(node\)/u);
assert.match(functionSource("scenePromptStats"), /isScenePromptReverseNode\(node\)/u);
assert.match(functionSource("scenePromptPreviewEntries"), /isScenePromptReverseNode\(node\)/u);
assert.match(functionSource("hideSceneUtilityWidgets"), /SCENE_PROMPT_REVERSE_NODE_NAMES/u);
assert.match(functionSource("attachSceneUtilityNode"), /installScenePromptReverseWidgetSyncHandlers/u);

const context = {
    String,
    findWidget(node, name) {
        return node.widgets.find((widget) => widget.name === name);
    },
};
vm.createContext(context);
vm.runInContext(functionSource("scenePromptReverseScope"), context);
assert.equal(context.scenePromptReverseScope({ widgets: [{ name: "reverse_scope", value: "直前のノード" }] }), "直前のノード");
assert.equal(context.scenePromptReverseScope({ widgets: [{ name: "reverse_scope", value: "全てのノード" }] }), "全てのノード");
assert.equal(context.scenePromptReverseScope({ widgets: [] }), "全てのノード");

console.log("Scene Prompt Reverse UI tests passed.");
