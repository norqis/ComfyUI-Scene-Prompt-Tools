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
let releaseDelayedItems = null;
const baseItem = {
  id: "summer",
  label: "Summer",
  prompt: "summer dress",
  description: "",
  category_path: ["Outfit"],
  category_key: "Outfit",
  category_label: "Outfit",
};
const nestedItem = {
  id: "search-detail",
  label: "Search Detail",
  prompt: "blue_hair, white_shirt",
  description: "Nested search test item",
  category_path: ["Search", "Nested"],
  category_key: "Search/Nested",
  category_label: "Search > Nested",
};
const promptItems = [baseItem, nestedItem, ...Array.from({ length: 60 }, (_value, index) => ({
  ...baseItem,
  id: "summer-" + index,
  label: "Summer " + index,
  prompt: "summer dress " + index,
}))];
const savedPrompt = { id: "browser-set", name: "Browser Set", description: "", items: [baseItem] };
export const api = {
  fileURL(route) {
    calls.push({ url: "fileURL:" + route, options: {} });
    return route;
  },
  fetchApi: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("/scene_prompt/items") && options.method !== "POST" && window.__delayNextScenePromptItems) {
      window.__delayNextScenePromptItems = false;
      await new Promise((resolveDelay) => { releaseDelayedItems = resolveDelay; });
      releaseDelayedItems = null;
    }
    let payload = { items: [] };
    let status = 200;
    if (url.includes("/scene_prompt/items")) payload = { items: promptItems };
    if (url === "/scene_prompt/items" && options.method === "POST") {
      const request = JSON.parse(options.body || "{}");
      if (request.name === "Failure") {
        status = 400;
        payload = { error: "creation failed" };
      } else {
        payload = {
          items: promptItems,
          item: { ...baseItem, id: "created", label: request.name, prompt: request.prompt },
        };
      }
    }
    if (url.includes("/runs/prepare")) payload = { run_handle: "browser-run" };
    if (url.includes("/runs/claim")) payload = { claimed: true };
    if (url.includes("/runs/release")) payload = { released: true };
    if (url.includes("saved_prompts")) payload = { saved_prompts: [savedPrompt], saved_prompt: savedPrompt };
    if (url.includes("/scene_presets/list")) payload = { presets: [{ metadata: { preset_id: "browser-preset", name: "Browser Preset", revision: 3 } }], errors: [] };
    if (url.includes("/scene_presets/load")) payload = {
      metadata: { preset_id: "browser-preset", name: "Browser Preset", revision: 3 },
      workflow: { id: "stored-workflow", version: 1, nodes: [{ id: 1, type: "ScenePresetInput" }], extra: { stored: true } },
    };
    if (url.includes("/scene_presets/save")) payload = { metadata: { preset_id: "browser-preset", name: "Browser Preset", revision: 4 } };
    return new Response(JSON.stringify(payload), { status });
  },
  queuePrompt: async () => ({ prompt_id: "browser-prompt" }),
  addEventListener(name, callback) { listeners.set(name, callback); },
};
window.api = api;
window.__scenePromptCalls = calls;
window.__scenePromptListeners = listeners;
window.__delayScenePromptItems = () => { window.__delayNextScenePromptItems = true; };
window.__releaseScenePromptItems = () => releaseDelayedItems?.();
window.__scenePromptItemsDelayed = () => !!releaseDelayedItems;
`;
const customScriptsAutocompleteModule = `
const upstreamStyle = document.createElement("style");
upstreamStyle.textContent = ".pysssss-autocomplete { position: absolute; z-index: 9999; min-width: 120px; padding: 4px; background: white; color: black; } .pysssss-autocomplete-item { cursor: pointer; padding: 4px; }";
document.head.append(upstreamStyle);
export class TextAreaAutoComplete {
  constructor(element) {
    this.element = element;
    this.helper = { getScale: () => 2 };
    this.dropdown = document.createElement("div");
    this.dropdown.className = "pysssss-autocomplete";
    this.suffix = element.placeholder.includes("ネガティブ") ? "_hands" : "_hair";
    this.element.addEventListener("input", () => {
      if (this.skipNextInput) {
        this.skipNextInput = false;
        return;
      }
      this.show();
    });
    window.__customScriptsAutocompleteInstances ||= [];
    window.__customScriptsAutocompleteInstances.push(this);
  }
  show() {
    const item = document.createElement("div");
    item.className = "pysssss-autocomplete-item";
    item.textContent = this.suffix;
    item.addEventListener("click", () => this.insert(this.suffix));
    this.dropdown.replaceChildren(item);
    document.body.append(this.dropdown);
    const rect = this.element.getBoundingClientRect();
    this.dropdown.style.left = (rect.left + 4) + "px";
    this.dropdown.style.top = (rect.top + 4) + "px";
  }
  insert(value) {
    this.dropdown.remove();
    this.skipNextInput = true;
    this.element.value += value;
    this.element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
`;
let customScriptsAutocompleteAvailable = true;
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
    if (request.url === "/extensions/ComfyUI-Custom-Scripts/js/common/autocomplete.js") {
        if (!customScriptsAutocompleteAvailable) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(customScriptsAutocompleteModule);
        return;
    }
    const asset = assets.get(request.url);
    if (asset) {
        response.writeHead(200, { "content-type": "text/javascript" });
        let source = await readFile(resolve(root, asset), "utf8");
        if (asset === "web/scene_prompt_ui.js") {
            source += `\nwindow.__scenePromptPopupTestHooks = {\n`
                + `  openSavePromptPopup,\n`
                + `  openCreatePromptPopup,\n`
                + `  attachMatrixTextAreaAutocomplete,\n`
                + `  syncAllScenePromptNames,\n`
                + `  applySceneSourceNodeNames,\n`
                + `  saveScenePreset,\n`
                + `  clearPromptItemsCache() { promptItems = null; promptItemsPromise = null; promptItemsLatestPromise = null; },\n`
                + `};\n`;
        }
        response.end(source);
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
    const candidate = page.getByTitle("summer dress", { exact: true });
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

    const candidateFilter = page.locator(".pc-popup .pc-searchbox");
    await candidateFilter.fill("Summer");
    const candidateList = page.locator(".pc-popup .pc-popup-list");
    const rememberedScrollTop = await candidateList.evaluate((element) => {
        element.scrollTop = 180;
        element.dispatchEvent(new Event("scroll"));
        return element.scrollTop;
    });
    assert.ok(rememberedScrollTop > 0, "candidate list is scrollable for restoration coverage");

    await page.getByRole("button", { name: "検索", exact: true }).click();
    await page.locator(".pc-popup .pc-searchbox").fill("Summer 5");
    await page.getByRole("button", { name: "プロンプト作成", exact: true }).click();
    const createForm = page.locator(".pc-popup .pc-form");
    await createForm.locator("label").filter({ hasText: "カテゴリ（必須）" }).locator("input").fill("Outfit");
    await createForm.locator("label").filter({ hasText: "サブカテゴリ（任意）" }).locator("input").fill("Style");
    await createForm.locator("label").filter({ hasText: "名前" }).locator("input").fill("Failure");
    await createForm.locator("label").filter({ hasText: "プロンプト" }).locator("textarea").fill("test prompt");
    await createForm.locator("label").filter({ hasText: "説明" }).locator("textarea").fill("draft description");

    await page.getByRole("button", { name: "一覧", exact: true }).click();
    assert.equal(await page.locator(".pc-popup .pc-searchbox").inputValue(), "Summer");
    await page.waitForTimeout(50);
    assert.equal(await page.locator(".pc-popup .pc-popup-list").evaluate((element) => element.scrollTop), rememberedScrollTop);
    await page.getByRole("button", { name: "検索", exact: true }).click();
    assert.equal(await page.locator(".pc-popup .pc-searchbox").inputValue(), "Summer 5");
    await page.getByRole("button", { name: "プロンプト作成", exact: true }).click();
    assert.equal(await createForm.locator("label").filter({ hasText: "名前" }).locator("input").inputValue(), "Failure");
    assert.equal(await createForm.locator("label").filter({ hasText: "プロンプト" }).locator("textarea").inputValue(), "test prompt");

    await page.getByRole("button", { name: "作成", exact: true }).click();
    await assert.doesNotReject(async () => page.getByText("creation failed", { exact: true }).waitFor({ state: "visible" }));
    assert.equal(await createForm.locator("label").filter({ hasText: "名前" }).locator("input").inputValue(), "Failure");
    await createForm.locator("label").filter({ hasText: "名前" }).locator("input").fill("Success");
    await page.getByRole("button", { name: "作成", exact: true }).click();
    await page.getByRole("button", { name: "プロンプト作成", exact: true }).click();
    assert.equal(await createForm.locator("label").filter({ hasText: "名前" }).locator("input").inputValue(), "");
    assert.equal(await createForm.locator("label").filter({ hasText: "プロンプト" }).locator("textarea").inputValue(), "");

    await page.getByRole("button", { name: "選択済み一覧", exact: true }).click();
    await page.getByText("Browser Set", { exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Browser Set");
    await page.getByRole("button", { name: "プロンプトまとめて保存", exact: true }).click();
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Browser Set", "save back restores selected detail");

    await page.getByRole("button", { name: "検索", exact: true }).click();
    const searchInput = page.locator(".pc-popup .pc-searchbox");
    await searchInput.fill("Search");
    await page.locator('button.pc-search-path[title="Search"]').click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Search");
    assert.equal(await page.getByRole("button", { name: "検索", exact: true }).evaluate((element) => element.classList.contains("pc-on")), true);
    await page.getByRole("button", { name: /^Nested \(/ }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Search > Nested");
    assert.equal(await page.getByRole("button", { name: "検索", exact: true }).evaluate((element) => element.classList.contains("pc-on")), true);
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Search");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "候補検索");
    assert.equal(await searchInput.inputValue(), "Search");
    await page.getByRole("button", { name: "一覧", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Outfit", "search navigation does not overwrite the list location");

    await page.getByRole("button", { name: "検索", exact: true }).click();
    await searchInput.fill("Search Detail");
    await page.getByRole("button", { name: "個別選択", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "Search Detail 個別選択");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "候補検索");
    assert.equal(await searchInput.inputValue(), "Search Detail");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "候補を編集");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    assert.equal(await page.locator(".pc-popup-title").textContent(), "候補検索");
    assert.equal(await searchInput.inputValue(), "Search Detail");

    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.evaluate(() => window.__scenePromptTestNode.widgets.find((widget) => widget.sceneRole === "positive_open").callback());
    await page.getByRole("button", { name: "検索", exact: true }).click();
    assert.equal(await page.locator(".pc-popup .pc-searchbox").inputValue(), "", "explicit close resets the popup session");
    await page.getByRole("button", { name: "閉じる", exact: true }).click();

    await page.evaluate(() => {
        const node = window.__scenePromptTestNode;
        node.widgets.find((widget) => widget.sceneRole === "positive_open").callback();
        window.__scenePromptPopupTestHooks.clearPromptItemsCache();
        window.__delayScenePromptItems();
    });
    await page.getByRole("button", { name: "プロンプト作成", exact: true }).click();
    await page.waitForFunction(() => window.__scenePromptItemsDelayed());
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.evaluate(() => window.__releaseScenePromptItems());
    await page.waitForTimeout(80);
    assert.equal(await page.locator(".pc-popup").count(), 0, "closing during create load cannot resurrect its popup");

    await page.evaluate(() => {
        const node = window.__scenePromptTestNode;
        node.widgets.find((widget) => widget.sceneRole === "positive_open").callback();
        window.__scenePromptPopupTestHooks.clearPromptItemsCache();
        window.__delayScenePromptItems();
    });
    await page.getByRole("button", { name: "プロンプトまとめて保存", exact: true }).click();
    await page.waitForFunction(() => window.__scenePromptItemsDelayed());
    await page.getByRole("button", { name: "検索", exact: true }).click();
    await page.evaluate(() => window.__releaseScenePromptItems());
    await assert.doesNotReject(async () => page.locator(".pc-popup-title").filter({ hasText: "候補検索" }).waitFor({ state: "visible" }));
    await page.waitForTimeout(80);
    assert.equal(await page.locator(".pc-popup-title").textContent(), "候補検索", "stale save load cannot replace the navigated view");
    assert.equal(await page.locator(".pc-popup .pc-searchbox").inputValue(), "", "navigation after delayed load keeps a clean session");
    await page.getByRole("button", { name: "閉じる", exact: true }).click();

    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
        const emptySelection = '{"version":1,"categories":{}}';
        const makeLine = (rowId, name) => ({
            type: "SCENE_MATRIX_LINE",
            version: 1,
            row_id: rowId,
            node_id: "",
            category: "",
            name,
            path_label: name,
            enabled: true,
            filename_enabled: false,
            positive_base: "",
            positive_json: emptySelection,
            negative_base: "",
            negative_json: emptySelection,
            category_order: "",
            positive_parts: [],
            negative_parts: [],
            display_labels: [],
            display_label_groups: [],
        });
        class SceneMatrixNode {
            constructor() {
                this.id = 4;
                this.type = "SceneMatrix";
                this.comfyClass = "SceneMatrix";
                this.size = [420, 300];
                this.inputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.graph = window.app.graph;
                this.widgets = [{
                    name: "matrix_json",
                    type: "text",
                    value: JSON.stringify({ version: 1, sets: [makeLine("line-one", "Line One"), makeLine("line-two", "Line Two")] }),
                    options: {},
                }];
                this.widgets_values = this.widgets.map((widget) => widget.value);
                this.matrixWriteCount = 0;
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
            onWidgetChanged(name) {
                if (name === "matrix_json") this.matrixWriteCount += 1;
            }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(SceneMatrixNode, { name: "SceneMatrix" });
        const node = new SceneMatrixNode();
        window.app.graph._nodes.push(node);
        node.onNodeCreated();
        window.__sceneMatrixTestNode = node;
        node.widgets.find((widget) => widget.sceneRole === "matrix_rows").callback();
    });
    const initialMatrixJson = await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value);
    assert.equal(await page.locator(".pc-popup").last().getByRole("button", { name: "保存", exact: true }).count(), 0, "the Matrix editor has no Save button");
    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    const positiveBaseInput = page.getByPlaceholder("ポジティブ基本文");
    await positiveBaseInput.fill("blue");
    await page.waitForFunction(() => window.__customScriptsAutocompleteInstances?.length === 1);
    await positiveBaseInput.press("End");
    await positiveBaseInput.press("Space");
    await positiveBaseInput.press("Backspace");
    const positiveAutocomplete = await page.evaluate(() => {
        const input = document.querySelector("textarea[placeholder='ポジティブ基本文']");
        const before = window.__customScriptsAutocompleteInstances.length;
        window.__scenePromptPopupTestHooks.attachMatrixTextAreaAutocomplete(input);
        window.__scenePromptPopupTestHooks.attachMatrixTextAreaAutocomplete(input);
        const instance = window.__customScriptsAutocompleteInstances.at(-1);
        return {
            count: window.__customScriptsAutocompleteInstances.length,
            before,
            scale: instance.helper.getScale(),
        };
    });
    assert.equal(positiveAutocomplete.count, positiveAutocomplete.before, "a Matrix textarea is connected once");
    assert.equal(positiveAutocomplete.scale, 1, "Matrix autocomplete ignores canvas zoom");
    const positiveLayer = await page.evaluate(() => {
        const dropdown = document.querySelector(".pysssss-autocomplete");
        const popup = document.querySelector(".pc-popup");
        const rect = dropdown.getBoundingClientRect();
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const popupRect = popup.getBoundingClientRect();
        return {
            matrixClass: dropdown.classList.contains("pc-matrix-autocomplete"),
            abovePopup: point?.closest(".pysssss-autocomplete") === dropdown,
            overlapsPopup: rect.left < popupRect.right && rect.right > popupRect.left && rect.top < popupRect.bottom && rect.bottom > popupRect.top,
        };
    });
    assert.equal(positiveLayer.matrixClass, true, "a Matrix dropdown has its scoped layer class");
    assert.equal(positiveLayer.overlapsPopup, true, "the positive candidate overlaps the Matrix popup");
    assert.equal(positiveLayer.abovePopup, true, "the positive candidate remains clickable above the Matrix popup");
    await page.locator(".pysssss-autocomplete-item").click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.sceneMatrixLineDraftContext.draft.positive_base), "blue_hair", "clicking a positive autocomplete candidate updates the Matrix draft");
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value), initialMatrixJson, "typing in a Matrix candidate editor does not write the Matrix state");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.some((call) => call.url.startsWith("fileURL:/extensions/ComfyUI-Custom-Scripts/"))), true, "Matrix autocomplete resolves its static extension with ComfyUI's base-aware file URL");
    await positiveBaseInput.press("End");
    await positiveBaseInput.press("Space");
    await positiveBaseInput.press("Backspace");
    await page.locator(".pysssss-autocomplete").waitFor({ state: "visible" });
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(await page.locator(".pysssss-autocomplete").count(), 0, "closing a Matrix picker removes its autocomplete dropdown");
    const positiveCommitted = await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        return { state: JSON.parse(node.widgets.find((widget) => widget.name === "matrix_json").value), writes: node.matrixWriteCount };
    });
    assert.equal(positiveCommitted.state.sets[0].positive_base, "blue_hair", "closing a positive Matrix editor commits its manual prompt");
    assert.equal(positiveCommitted.writes, 1, "the final positive editor close writes once");
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(0).locator(".pc-candidate-desc").allTextContents(),
        ["blue_hair"],
        "closing a positive editor shows its base prompt without selected candidates",
    );

    await page.getByRole("button", { name: "ネガティブ候補" }).nth(0).click();
    const negativeBaseInput = page.getByPlaceholder("ネガティブ基本文");
    await negativeBaseInput.fill("bad");
    await page.waitForFunction(() => window.__customScriptsAutocompleteInstances?.length === 2);
    await negativeBaseInput.press("End");
    await negativeBaseInput.press("Space");
    await negativeBaseInput.press("Backspace");
    const negativeLayer = await page.evaluate(() => {
        const dropdown = document.querySelector(".pysssss-autocomplete");
        const popup = document.querySelector(".pc-popup");
        const rect = dropdown.getBoundingClientRect();
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const popupRect = popup.getBoundingClientRect();
        return {
            abovePopup: point?.closest(".pysssss-autocomplete") === dropdown,
            overlapsPopup: rect.left < popupRect.right && rect.right > popupRect.left && rect.top < popupRect.bottom && rect.bottom > popupRect.top,
        };
    });
    assert.equal(negativeLayer.overlapsPopup, true, "the negative candidate overlaps the Matrix popup");
    assert.equal(negativeLayer.abovePopup, true, "the negative candidate remains clickable above the Matrix popup");
    await page.locator(".pysssss-autocomplete-item").click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.sceneMatrixLineDraftContext.draft.negative_base), "bad_hands", "clicking a negative autocomplete candidate updates the Matrix draft");
    assert.deepEqual(await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        return { state: JSON.parse(node.widgets.find((widget) => widget.name === "matrix_json").value), writes: node.matrixWriteCount };
    }), positiveCommitted, "a Matrix candidate editor keeps changes in its draft until it closes");
    await negativeBaseInput.press("End");
    await negativeBaseInput.press("Space");
    await negativeBaseInput.press("Backspace");
    await page.locator(".pysssss-autocomplete").waitFor({ state: "visible" });
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(await page.locator(".pysssss-autocomplete").count(), 0, "closing a negative Matrix picker removes its autocomplete dropdown");
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount), 2, "the final negative editor close writes once");
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(0).locator(".pc-candidate-desc").allTextContents(),
        ["blue_hair", "bad_hands"],
        "closing a negative editor keeps both base prompts in the parent row",
    );

    await page.getByRole("button", { name: "ポジティブ候補" }).nth(1).click();
    await page.getByPlaceholder("ポジティブ基本文").fill(" \t ");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(1).locator(".pc-candidate-desc").count(),
        0,
        "a whitespace-only Matrix base prompt does not create an empty summary",
    );

    const disconnectedAutocomplete = await page.evaluate(async () => {
        const input = document.createElement("textarea");
        document.body.append(input);
        window.__scenePromptPopupTestHooks.attachMatrixTextAreaAutocomplete(input);
        input.remove();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        return window.__customScriptsAutocompleteInstances.some((instance) => instance.element === input);
    });
    assert.equal(disconnectedAutocomplete, false, "a detached Matrix textarea is not connected after async import");

    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.getByText("Outfit", { exact: false }).click();
    await page.getByPlaceholder("この階層内を検索").fill("Summer 1");
    await page.getByRole("button", { name: "検索", exact: true }).click();
    await page.getByPlaceholder("カテゴリ / サブカテゴリ / ラベル / 説明 / prompt を検索").fill("row-one-query");
    await page.getByRole("button", { name: "一覧", exact: true }).click();
    assert.equal(await page.getByPlaceholder("この階層内を検索").inputValue(), "Summer 1", "Matrix row keeps internal navigation state");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();

    await page.getByRole("button", { name: "ポジティブ候補" }).nth(1).click();
    await page.getByRole("button", { name: "検索", exact: true }).click();
    assert.equal(await page.getByPlaceholder("カテゴリ / サブカテゴリ / ラベル / 説明 / prompt を検索").inputValue(), "", "Matrix rows do not share popup state");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();

    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.getByRole("button", { name: "検索", exact: true }).click();
    assert.equal(await page.getByPlaceholder("カテゴリ / サブカテゴリ / ラベル / 説明 / prompt を検索").inputValue(), "", "explicit Matrix picker close resets that row session");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();

    await page.getByPlaceholder("名前").nth(0).fill("Reopen Name");
    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        node.widgets.find((widget) => widget.sceneRole === "matrix_rows").callback();
    });
    assert.equal(await page.locator(".pc-popup").count(), 1, "reopening Matrix rows while a picker is open leaves one root editor");
    assert.equal(await page.getByPlaceholder("名前").nth(0).inputValue(), "Reopen Name", "reopening Matrix rows preserves the root row-name draft");
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[0].name), "Reopen Name", "reopening commits the prior root editor before reading new drafts");

    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.evaluate(() => {
        const root = [...document.querySelectorAll(".pc-popup")].find((popup) => !popup.sceneSecondaryPopup);
        [...root.querySelectorAll("button")].find((button) => button.textContent === "行を追加").click();
    });
    assert.equal(await page.locator(".pc-popup").count(), 1, "a structural action closes its Matrix picker before committing");
    assert.deepEqual(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets.map((line) => line.name)), ["Reopen Name", "Line Two", "行 3"], "the structural action preserves root drafts and commits the new row");
    await page.getByRole("button", { name: "削除", exact: true }).nth(2).click();

    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.getByText("Outfit", { exact: false }).click();
    await page.getByTitle("summer dress", { exact: true }).click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value.includes("summer")), false, "selecting a candidate does not write Matrix state during picker navigation");
    await page.getByRole("button", { name: "行編集へ戻る" }).click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value.includes("summer")), true, "行編集へ戻る commits the positive Matrix candidate");
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(0).locator(".pc-candidate-desc").allTextContents(),
        ["blue_hair / Summer", "bad_hands"],
        "a selected positive candidate follows its Matrix base prompt",
    );
    await page.getByRole("button", { name: "ネガティブ候補" }).nth(1).click();
    await page.getByText("Outfit", { exact: false }).click();
    await page.getByTitle("summer dress", { exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[1].negative_json.includes("summer")), false, "the negative candidate remains a draft before the picker closes");
    await page.getByRole("button", { name: "行編集へ戻る" }).click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[1].negative_json.includes("summer")), true, "行編集へ戻る commits the negative Matrix candidate");

    await page.getByRole("button", { name: "↑", exact: true }).nth(1).click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets.map((line) => line.name)), ["Line Two", "Reopen Name"], "reordering Matrix rows commits without a Save button");
    await page.getByRole("button", { name: "↑", exact: true }).nth(1).click();
    await page.getByRole("button", { name: "有効", exact: true }).nth(0).click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[0].enabled), false, "toggling a Matrix row commits without a Save button");
    await page.getByRole("button", { name: "ファイル名付与: OFF", exact: true }).nth(0).click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[0].filename_enabled), true, "filename toggles commit without a Save button");
    await page.getByRole("button", { name: "行を追加", exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets.length), 3, "adding a Matrix row commits without a Save button");
    await page.getByRole("button", { name: "削除", exact: true }).nth(2).click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets.length), 2, "deleting a Matrix row commits without a Save button");

    const writesBeforeNameClose = await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount);
    await page.getByPlaceholder("名前").nth(0).fill("Renamed One");
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[0].name), "Reopen Name", "typing a Matrix row name remains a draft until the editor closes");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    const matrixState = await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        const widget = node.widgets.find((candidateWidget) => candidateWidget.name === "matrix_json");
        return {
            state: JSON.parse(widget.value),
            stored: JSON.parse(node.widgets_values[node.widgets.indexOf(widget)]),
            property: JSON.parse(node.properties.scene_matrix_json),
            writes: node.matrixWriteCount,
        };
    });
    assert.equal(matrixState.state.sets.length, 2);
    assert.equal(matrixState.state.sets[0].positive_json.includes("summer"), true);
    assert.equal(matrixState.state.sets[1].negative_json.includes("summer"), true);
    assert.equal(matrixState.state.sets[0].display_labels.includes("Summer"), true);
    assert.equal(matrixState.state.sets[1].display_labels.includes("Summer"), true);
    assert.equal(matrixState.state.sets[0].name, "Renamed One");
    assert.deepEqual(matrixState.stored, matrixState.state);
    assert.deepEqual(matrixState.property, matrixState.state);
    assert.equal(matrixState.state.sets.every((line) => !Object.hasOwn(line, "sceneScheduleRenderSummaries")), true);
    assert.equal(matrixState.writes, writesBeforeNameClose + 1, "closing the Matrix editor commits the row name once");

    await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.sceneRole === "matrix_rows").callback());
    assert.equal(await page.getByPlaceholder("名前").nth(0).inputValue(), "Renamed One", "reopened Matrix rows show the saved row name");
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(0).locator(".pc-candidate-desc").allTextContents(),
        ["blue_hair / Summer", "bad_hands"],
        "saved Matrix base and candidate summaries reappear after reopening",
    );
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(1).locator(".pc-candidate-desc").allTextContents(),
        ["Summer"],
        "a saved whitespace-only base prompt remains hidden from the row summary",
    );
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount), matrixState.writes, "closing an unchanged Matrix editor does not write again");

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

    const callbackUi = await page.evaluate(async () => {
        class CallbackNode {
            constructor(type, widgets) {
                this.id = type === "ScenePromptCallback" ? 201 : 202;
                this.type = type;
                this.comfyClass = type;
                this.title = type;
                this.size = [300, 180];
                this.inputs = type === "ScenePromptCallback"
                    ? [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }, { name: "callback", type: "SCENE_CALLBACK", link: null }]
                    : [];
                this.outputs = type === "ScenePromptCallback" ? [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }] : [{ name: "callback", type: "SCENE_CALLBACK", links: [] }];
                this.graph = window.app.graph;
                this.widgets = widgets;
                this.widgets_values = widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            setDirtyCanvas() {}
            setSize(size) { this.size = [...size]; }
        }
        const callback = new CallbackNode("ScenePromptCallback", [
            { name: "frequency", type: "combo", value: "毎回", options: {} },
            { name: "timeout_seconds", type: "number", value: 10, options: {} },
            { name: "failure_mode", type: "combo", value: "続行", options: {} },
        ]);
        const request = new CallbackNode("ScenePromptCallbackRequest", [
            { name: "method", type: "combo", value: "GET", options: {} },
            { name: "url", type: "text", value: "https://example.invalid", options: {} },
            { name: "text", type: "text", value: "unused", options: {} },
            { name: "body_type", type: "combo", value: "text", options: {} },
            { name: "headers_json", type: "text", value: "{}", options: {} },
        ]);
        await window.__scenePromptExtension.beforeRegisterNodeDef(CallbackNode, { name: "ScenePromptCallback" });
        callback.onNodeCreated();
        await window.__scenePromptExtension.beforeRegisterNodeDef(CallbackNode, { name: "ScenePromptCallbackRequest" });
        request.onNodeCreated();
        window.app.graph._nodes.push(callback, request);
        callback.title = "Before Matrix";
        window.__scenePromptPopupTestHooks.syncAllScenePromptNames();
        const apiPrompt = { output: {
            "201": { class_type: "ScenePromptCallback", inputs: {} },
            "202": { class_type: "ScenePromptCallbackRequest", inputs: {} },
            "203": { class_type: "KSampler", inputs: {} },
        } };
        window.__scenePromptPopupTestHooks.applySceneSourceNodeNames(apiPrompt);
        const before = {
            callbackOutput: callback.outputs[0].type,
            callbackInputOptional: callback.inputs.find((input) => input.name === "scene_prompt").link === null,
            apiCallbackName: apiPrompt.output["201"].inputs.source_node_name,
            apiProducerName: apiPrompt.output["202"].inputs.source_node_name,
            callbackVisible: callback.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            getHiddenText: request.widgets.find((widget) => widget.name === "text").hidden,
        };
        const method = request.widgets.find((widget) => widget.name === "method");
        method.value = "POST";
        method.callback();
        return {
            ...before,
            postVisibleText: !request.widgets.find((widget) => widget.name === "text").hidden,
            requestWidgets: request.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
        };
    });
    assert.equal(callbackUi.callbackOutput, "SCENE_PROMPT");
    assert.equal(callbackUi.callbackInputOptional, true, "Callback accepts an unconnected first Scene input");
    assert.equal(callbackUi.apiCallbackName, undefined, "Callback itself is excluded from Scene path names");
    assert.equal(callbackUi.apiProducerName, undefined, "Callback configuration is not mistaken for a Scene-path node");
    assert.deepEqual(callbackUi.callbackVisible, ["frequency", "timeout_seconds", "failure_mode"]);
    assert.equal(callbackUi.getHiddenText, true, "GET hides its unused request body");
    assert.equal(callbackUi.postVisibleText, true, "POST restores the request body input");
    assert.deepEqual(callbackUi.requestWidgets, ["method", "url", "text", "body_type", "headers_json"]);

    await page.evaluate(async () => {
        const originalGraphToPrompt = window.app.graphToPrompt;
        window.app.graphToPrompt = async () => ({ output: {
            "201": { class_type: "ScenePromptCallback", inputs: { callback: ["202", 0] } },
            "202": { class_type: "ScenePromptCallbackRequest", inputs: {} },
            "301": { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["201", 0] } },
        } });
        await window.__scenePromptPopupTestHooks.saveScenePreset({
            id: 301,
            graph: window.app.graph,
            widgets: [
                { name: "preset_id", value: "callback-preset" },
                { name: "preset_name", value: "Callback Preset" },
            ],
        });
        window.app.graphToPrompt = originalGraphToPrompt;
    });
    const callbackPresetSave = await page.evaluate(() => {
        const call = window.__scenePromptCalls.findLast((entry) => entry.url.includes("/scene_presets/save"));
        return JSON.parse(call.options.body).api_graph.output;
    });
    assert.equal(
        callbackPresetSave["201"].inputs.source_node_name,
        undefined,
        "Preset saving does not inject an unsupported source_node_name into Scene Prompt Callback",
    );

    await createPreparedRun(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.waitForTimeout(50);
    assert.equal((await releaseCalls(page)).length, 0);

    customScriptsAutocompleteAvailable = false;
    const unavailablePage = await browser.newPage();
    await unavailablePage.goto(`http://127.0.0.1:${address.port}/`);
    await unavailablePage.waitForFunction(() => window.__scenePromptBrowserReady === true, null, { timeout: 5_000 });
    const unavailableAutocomplete = await unavailablePage.evaluate(async () => {
        const input = document.createElement("textarea");
        input.value = "plain text";
        document.body.append(input);
        window.__scenePromptPopupTestHooks.attachMatrixTextAreaAutocomplete(input);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        return {
            value: input.value,
            state: input.dataset.scenePromptMatrixAutocomplete,
            instances: window.__customScriptsAutocompleteInstances?.length || 0,
        };
    });
    assert.deepEqual(unavailableAutocomplete, {
        value: "plain text",
        state: "unavailable",
        instances: 0,
    }, "a missing Custom-Scripts autocomplete leaves Matrix textareas usable");
    await unavailablePage.close();
    customScriptsAutocompleteAvailable = true;

    const closingPage = await browser.newPage();
    await closingPage.goto(`http://127.0.0.1:${address.port}/`);
    await closingPage.waitForFunction(() => window.__scenePromptBrowserReady === true, null, { timeout: 5_000 });
    await createPreparedRun(closingPage);
    await closingPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await closingPage.waitForTimeout(50);
    const releases = await releaseCalls(closingPage);
    assert.equal(releases.length, 0, "pagehide preserves an accepted ordinary run for queued generation");
    await closingPage.close();
    console.log("Scene Prompt browser integration tests passed.");
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolveServer) => server.close(resolveServer));
}
