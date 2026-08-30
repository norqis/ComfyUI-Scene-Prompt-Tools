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
    hideWidget(widget) { widget.hidden = true; },
    showWidget(widget) { widget.hidden = false; },
};
vm.createContext(context);
vm.runInContext(functionSource("hideSceneUtilityWidgets"), context);

const widgets = [
    { name: "path" },
    { name: "metadata_mode" },
    { name: "scene_info" },
];
context.hideSceneUtilityWidgets({ widgets }, "SceneSaveImage");

assert.equal(widgets[0].hidden, false);
assert.equal(widgets[1].hidden, false);
assert.equal(widgets[2].hidden, true);
