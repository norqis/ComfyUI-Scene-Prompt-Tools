const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_switches.js"), "utf8");
const names = [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]);
const switches = new Function(source.replace(/^export /gm, "") + `\nreturn {${names.join(",")}};`)();
exports.install = (context) => Object.assign(context, switches, {
    isScenePresetInputNode: context.isScenePresetInputNode || ((node) => ["ScenePresetInput", "Scene Preset Input"].includes(node?.type || node?.comfyClass || node?.class_type)),
});
