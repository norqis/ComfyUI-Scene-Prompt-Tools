const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

assert.match(source, /ScenePrompterExpand/u);
assert.match(source, /current_index: "生成番号"/u);
assert.match(source, /seed_base: "開始シード"/u);

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed function: ${name}`);
}

const context = {
    Set,
    SCENE_SAVE_IMAGE_NODE_NAMES: new Set(["SceneSaveImage"]),
    isSceneExpandNodeName(nodeName) { return nodeName === "ScenePrompterExpand"; },
    SCENE_EMPTY_LATENT_NODE_NAMES: new Set(),
    hideWidget(widget) { widget.hidden = true; },
    showWidget(widget) { widget.hidden = false; },
};
vm.createContext(context);
vm.runInContext(functionSource("hideSceneUtilityWidgets"), context);

const widgets = [
    { name: "path" },
    { name: "metadata_mode" },
    { name: "expand_preset_contents" },
    { name: "scene_info" },
];
context.hideSceneUtilityWidgets({ widgets }, "SceneSaveImage");

assert.equal(widgets[0].hidden, false);
assert.equal(widgets[1].hidden, false);
assert.equal(widgets[2].hidden, false);
assert.equal(widgets[3].hidden, true);

const expandWidgets = [
    { name: "timestamp_dir" },
    { name: "prefix" },
    { name: "replace_underscores" },
    { name: "convert_anima_weights" },
    { name: "current_index" },
];
context.hideSceneUtilityWidgets({ widgets: expandWidgets }, "ScenePrompterExpand");
assert.equal(expandWidgets[0].hidden, false);
assert.equal(expandWidgets[1].hidden, false);
assert.equal(expandWidgets[2].hidden, false);
assert.equal(expandWidgets[3].hidden, false);
assert.equal(expandWidgets[4].hidden, true);

vm.runInContext(functionSource("sceneExpandConfigureValues"), context);
const legacyAnima = {
    widgets_values: [0, "", 7, true, "prefix", "Anima", 13, "停止", true],
};
const migratedAnima = context.sceneExpandConfigureValues(legacyAnima);
assert.deepEqual(JSON.parse(JSON.stringify(migratedAnima.widgets_values)), [
    0, "", 7, true, "prefix", true, true, 13, "停止", true,
]);
assert.deepEqual(legacyAnima.widgets_values, [0, "", 7, true, "prefix", "Anima", 13, "停止", true]);
assert.deepEqual(
    JSON.parse(JSON.stringify(context.sceneExpandConfigureValues(migratedAnima).widgets_values)),
    JSON.parse(JSON.stringify(migratedAnima.widgets_values)),
    "migration is idempotent",
);
assert.deepEqual(
    JSON.parse(JSON.stringify(context.sceneExpandConfigureValues({ widgets_values: [0, "", 7, true, "prefix"] }).widgets_values)),
    [0, "", 7, true, "prefix", false, false],
    "pre-model workflows receive explicit false conversion options",
);
