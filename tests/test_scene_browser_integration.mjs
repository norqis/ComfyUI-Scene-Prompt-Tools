import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assets = new Map([
    ["/extensions/scene-prompt/web/scene_prompt_ui.js", "web/scene_prompt_ui.js"],
    ["/extensions/scene-prompt/web/scene_prompt_state.js", "web/scene_prompt_state.js"],
    ["/extensions/scene-prompt/web/scene_prompt_style.js", "web/scene_prompt_style.js"],
]);

const appModule = `
const graph = {
  _nodes: [],
  extra: { original_tab: true },
  serialize() { return { version: 1, nodes: [], extra: structuredClone(this.extra) }; },
};
const loadedGraphs = [];
export const app = {
  graph,
  canvas: {},
  registerExtension(extension) { window.__scenePromptExtension = extension; },
  queuePrompt: async () => ({ prompt_id: "browser-test" }),
  graphToPrompt: async () => ({ output: {} }),
  async loadGraphData(workflow, ...args) { loadedGraphs.push({ workflow, args }); },
};
window.app = app;
window.__scenePromptLoadedGraphs = loadedGraphs;
`;
const apiModule = `
const listeners = new Map();
const calls = [];
export const api = {
  fetchApi: async (url, options = {}) => {
    calls.push({ url, options });
    let payload = { items: [] };
    if (url.includes("/scene_prompt/items")) payload = { items: [{
      id: "summer",
      label: "Summer",
      prompt: "summer dress",
      description: "",
      category_path: ["Outfit"],
      category_key: "Outfit",
      category_label: "Outfit",
    }] };
    if (url.includes("/runs/prepare")) payload = { run_handle: "browser-run" };
    if (url.includes("/runs/claim")) payload = { claimed: true };
    if (url.includes("/runs/release")) payload = { released: true };
    if (url.includes("saved_prompts")) payload = { saved_prompts: [] };
    if (url.includes("/scene_presets/list")) payload = { presets: [{ metadata: { preset_id: "browser-preset", name: "Browser Preset", revision: 3 } }], errors: [] };
    if (url.includes("/scene_presets/load")) payload = {
      metadata: { preset_id: "browser-preset", name: "Browser Preset", revision: 3 },
      workflow: { id: "stored-workflow", version: 1, nodes: [{ id: 1, type: "ScenePresetInput" }], extra: { stored: true } },
    };
    if (url.includes("/scene_presets/save")) payload = { metadata: { preset_id: "browser-preset", name: "Browser Preset", revision: 4 } };
    return new Response(JSON.stringify(payload), { status: 200 });
  },
  queuePrompt: async () => ({ prompt_id: "browser-prompt" }),
  addEventListener(name, callback) { listeners.set(name, callback); },
};
window.api = api;
window.__scenePromptCalls = calls;
window.__scenePromptListeners = listeners;
`;
const index = `<!doctype html><script type="module">
  import { injectStyle } from "/extensions/scene-prompt/web/scene_prompt_style.js";
  import "/extensions/scene-prompt/web/scene_prompt_ui.js";
  injectStyle();
  window.__scenePromptExtension.setup();
  window.__scenePromptBrowserReady = true;
</script>`;

const server = http.createServer(async (request, response) => {
    if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(index);
        return;
    }
    if (request.url === "/extensions/scripts/app.js" || request.url === "/extensions/scripts/api.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(request.url.endsWith("app.js") ? appModule : apiModule);
        return;
    }
    const asset = assets.get(request.url);
    if (asset) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(await readFile(resolve(root, asset), "utf8"));
        return;
    }
    response.writeHead(404);
    response.end();
});

async function createPreparedRun(page) {
    await page.evaluate(async () => {
        await window.api.queuePrompt(0, {
            output: {
                1: { class_type: "ScenePrompter", inputs: {} },
            },
        });
    });
    await page.waitForFunction(() => window.__scenePromptCalls.some((call) => call.url.includes("/runs/claim")));
}

async function releaseCalls(page) {
    return page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.includes("/runs/release")));
}

await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => window.__scenePromptBrowserReady === true, null, { timeout: 5_000 });
    const result = await page.evaluate(() => {
        const makeWidget = (owned) => {
            const widget = document.createElement("div");
            widget.className = `dom-widget${owned ? " scene-prompt-owned-widget" : ""}`;
            const input = document.createElement("textarea");
            input.placeholder = "category_order";
            widget.appendChild(input);
            document.body.appendChild(widget);
            return getComputedStyle(widget).display;
        };
        return {
            extension: window.__scenePromptExtension?.name,
            externalDisplay: makeWidget(false),
            ownedDisplay: makeWidget(true),
        };
    });
    assert.equal(result.extension, "ScenePrompt.UI");
    assert.notEqual(result.externalDisplay, "none");
    assert.equal(result.ownedDisplay, "none");

    await page.evaluate(async () => {
        class LGraphNode {
            serialize() { return { widgets_values: structuredClone(this.widgets_values) }; }
            configure(serialized) {
                for (const [index, value] of (serialized.widgets_values || []).entries()) {
                    this.widgets[index].value = structuredClone(value);
                }
                this.widgets_values = structuredClone(serialized.widgets_values || []);
            }
        }
        class ScenePromptNode extends LGraphNode {
            constructor() {
                super();
                this.id = 1;
                this.type = "ScenePrompter";
                this.comfyClass = "ScenePrompter";
                this.size = [420, 300];
                this.inputs = [];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.graph = window.app.graph;
                this.widgets = [
                    { name: "prompt_name", type: "text", value: "Prompt", options: {} },
                    { name: "filename_enabled", type: "toggle", value: false, options: {} },
                    { name: "positive_base", type: "text", value: "positive base, {A|B}", options: {} },
                    { name: "positive_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "negative_base", type: "text", value: "negative base", options: {} },
                    { name: "negative_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "category_order", type: "text", value: "Outfit", options: {} },
                    { name: "seed", type: "number", value: 99, options: {} },
                    { name: "control_after_generate", type: "combo", value: "randomize", options: {} },
                    { name: "randomize", type: "toggle", value: false, options: {} },
                    { name: "run_handle", type: "text", value: "", options: {} },
                ];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            addCustomWidget(widget) {
                widget.triggerDraw = () => { widget.drawCount = (widget.drawCount || 0) + 1; };
                this.widgets.push(widget);
                return widget;
            }
            addInput(name, type) { this.inputs.push({ name, type, link: null }); }
            addOutput(name, type) { this.outputs.push({ name, type, links: [] }); }
            setDirtyCanvas() {}
            setSize(size) { this.size = [...size]; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(ScenePromptNode, { name: "ScenePrompter" });
        const node = new ScenePromptNode();
        window.app.graph._nodes = [node];
        node.onNodeCreated();
        if (node.widgets[0].name !== "filename_enabled" || node.widgets[0].serialize === false) throw new Error("serialized filename toggle must be first");
        node.widgets[0].value = true;
        node.widgets_values[0] = true;
        const saved = node.serialize();
        const restored = new ScenePromptNode();
        restored.onNodeCreated();
        restored.configure(saved);
        const restoredValues = Object.fromEntries(restored.widgets.map((widget, index) => [widget.name, {
            value: widget.value,
            stored: restored.widgets_values[index],
        }]));
        for (const [name, expected] of Object.entries(Object.fromEntries(node.widgets.map((widget, index) => [widget.name, {
            value: widget.value,
            stored: node.widgets_values[index],
        }])))) {
            if (restoredValues[name]?.value !== expected.value || restoredValues[name]?.stored !== expected.stored) {
                throw new Error(`positional widget restore changed ${name}`);
            }
        }
        window.__scenePromptFilenameRoundTrip = restoredValues;
        window.__scenePromptTestNode = node;
        node.widgets.find((widget) => widget.sceneRole === "positive_open").callback();
    });
    await page.getByText("Outfit", { exact: false }).click();
    const candidate = page.locator(".pc-candidate").filter({ hasText: "Summer" });
    await candidate.click();
    await assert.doesNotReject(async () => candidate.waitFor({ state: "visible" }));
    assert.equal(await candidate.locator('input[type="checkbox"]').isChecked(), true);
    assert.equal(await candidate.evaluate((element) => element.classList.contains("pc-selected-item")), true);
    const selectedState = await page.evaluate(() => {
        const node = window.__scenePromptTestNode;
        const widget = node.widgets.find((candidateWidget) => candidateWidget.name === "positive_json");
        return {
            widget: JSON.parse(widget.value),
            stored: JSON.parse(node.widgets_values[node.widgets.indexOf(widget)]),
            filenameEnabled: (() => {
                const widget = node.widgets.find((candidateWidget) => candidateWidget.name === "filename_enabled");
                return {
                    value: widget.value,
                    stored: node.widgets_values[node.widgets.indexOf(widget)],
                    topWidget: node.widgets[0].name,
                };
            })(),
            selectedList: (() => {
                const list = node.widgets.find((candidateWidget) => candidateWidget.sceneRole === "positive_selected_list");
                const canvas = document.createElement("canvas");
                canvas.width = 420;
                canvas.height = Math.ceil(list.computedHeight || 1);
                const context = canvas.getContext("2d");
                list.draw(context, node, 420, 0, list.computedHeight);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let paintedPixels = 0;
                for (let index = 3; index < pixels.length; index += 4) {
                    if (pixels[index] > 0) paintedPixels += 1;
                }
                return {
                    value: list.value,
                    height: list.computedHeight,
                    drawCount: list.drawCount || 0,
                    paintedPixels,
                };
            })(),
        };
    });
    assert.equal(selectedState.widget.categories.Outfit[0].id, "summer");
    assert.equal(Object.hasOwn(selectedState.widget.categories.Outfit[0], "weight"), false);
    assert.deepEqual(selectedState.stored, selectedState.widget);
    assert.equal(selectedState.filenameEnabled.value, true);
    assert.equal(selectedState.filenameEnabled.stored, true);
    assert.equal(selectedState.filenameEnabled.topWidget, "filename_enabled");
    assert.equal(
        (await page.evaluate(() => window.__scenePromptTestNode.widgets.find((widget) => widget.name === "positive_base").value)),
        "positive base, {A|B}",
    );
    assert.equal(
        (await page.evaluate(() => window.__scenePromptTestNode.widgets.find((widget) => widget.name === "randomize").value)),
        false,
    );
    assert.equal(selectedState.selectedList.value, "1カテゴリ / 1候補");
    assert.ok(selectedState.selectedList.height > 0);
    assert.ok(selectedState.selectedList.drawCount > 0);
    assert.ok(selectedState.selectedList.paintedPixels > 0);

    await page.evaluate(async () => {
        class ScenePresetReferenceNode {
            constructor() {
                this.id = 2;
                this.type = "ScenePresetReference";
                this.comfyClass = "ScenePresetReference";
                this.size = [300, 180];
                this.inputs = [];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.graph = window.app.graph;
                this.widgets = [{ name: "preset_id", type: "text", value: "browser-preset", options: {} }];
                this.widgets_values = ["browser-preset"];
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            addInput(name, type) { this.inputs.push({ name, type, link: null }); }
            addOutput(name, type) { this.outputs.push({ name, type, links: [] }); }
            setDirtyCanvas() {}
            setSize(size) { this.size = [...size]; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(ScenePresetReferenceNode, { name: "ScenePresetReference" });
        const node = new ScenePresetReferenceNode();
        window.app.graph._nodes.push(node);
        node.onNodeCreated();
        const edit = node.widgets.find((widget) => widget.sceneRole === "scene_preset_edit");
        await Promise.all([edit.callback(), edit.callback()]);
    });
    const editor = await page.evaluate(() => ({
        loads: window.__scenePromptLoadedGraphs,
        originalGraph: window.app.graph.extra,
        loadsRequested: window.__scenePromptCalls.filter((call) => call.url.includes("/scene_presets/load")).length,
    }));
    assert.equal(editor.loadsRequested, 1);
    assert.equal(editor.loads.length, 1);
    assert.deepEqual(editor.loads[0].args, [true, true, "Preset - Browser Preset"]);
    assert.notEqual(editor.loads[0].workflow.id, "stored-workflow");
    assert.match(editor.loads[0].workflow.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(editor.loads[0].workflow.extra, {
        stored: true,
        scene_preset_editor: { preset_id: "browser-preset", revision: 3 },
    });
    assert.deepEqual(editor.originalGraph, { original_tab: true });

    await page.evaluate(async () => {
        class ScenePresetOutputNode {
            constructor() {
                this.id = 3;
                this.type = "ScenePresetOutput";
                this.comfyClass = "ScenePresetOutput";
                this.size = [300, 180];
                this.inputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.graph = window.app.graph;
                this.widgets = [
                    { name: "preset_id", type: "text", value: "browser-preset", options: {} },
                    { name: "preset_name", type: "text", value: "Browser Preset", options: {} },
                ];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            addInput(name, type) { this.inputs.push({ name, type, link: null }); }
            addOutput(name, type) { this.outputs.push({ name, type, links: [] }); }
            setDirtyCanvas() {}
            setSize(size) { this.size = [...size]; }
        }
        window.app.graph.extra = { scene_preset_editor: { preset_id: "browser-preset", revision: 3 } };
        await window.__scenePromptExtension.beforeRegisterNodeDef(ScenePresetOutputNode, { name: "ScenePresetOutput" });
        const node = new ScenePresetOutputNode();
        window.app.graph._nodes.push(node);
        node.onNodeCreated();
        await node.widgets.find((widget) => widget.sceneRole === "scene_preset_save").callback();
    });
    const savedEditor = await page.evaluate(() => {
        const save = window.__scenePromptCalls.findLast((call) => call.url.includes("/scene_presets/save"));
        return { request: JSON.parse(save.options.body), editor: window.app.graph.extra.scene_preset_editor };
    });
    assert.equal(savedEditor.request.expected_revision, 3);
    assert.deepEqual(savedEditor.editor, { preset_id: "browser-preset", revision: 4 });

    await createPreparedRun(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.waitForTimeout(50);
    assert.equal((await releaseCalls(page)).length, 0);

    const closingPage = await browser.newPage();
    await closingPage.goto(`http://127.0.0.1:${address.port}/`);
    await closingPage.waitForFunction(() => window.__scenePromptBrowserReady === true, null, { timeout: 5_000 });
    await createPreparedRun(closingPage);
    await closingPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await closingPage.waitForFunction(() => window.__scenePromptCalls.some((call) => call.url.includes("/runs/release")));
    const releases = await releaseCalls(closingPage);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].options.keepalive, true);
    await closingPage.close();
    console.log("Scene Prompt browser integration tests passed.");
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolveServer) => server.close(resolveServer));
}
