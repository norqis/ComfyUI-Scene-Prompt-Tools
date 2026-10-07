import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assets = new Map([
    ["/extensions/scene-prompt/web/scene_prompt_ui.js", "web/scene_prompt_ui.js"],
    ["/extensions/scene-prompt/web/scene_prompt_state.js", "web/scene_prompt_state.js"],
    ["/extensions/scene-prompt/web/scene_prompt_style.js", "web/scene_prompt_style.js"],
    ["/extensions/scene-prompt/web/scene_prompt_llm.js", "web/scene_prompt_llm.js"],
    ["/extensions/scene-prompt/web/scene_prompt_gpu.js", "web/scene_prompt_gpu.js"],
    ["/extensions/scene-prompt/web/scene_prompt_switches.js", "web/scene_prompt_switches.js"],
    ["/extensions/scene-prompt/web/scene_prompt_civitai.js", "web/scene_prompt_civitai.js"],
    ["/extensions/scene-prompt/web/scene_llm_presets.js", "web/scene_llm_presets.js"],
]);

const appModule = `
const desktopNotificationMock = { available: true, permission: "default", requestedPermission: "granted", requestCalls: 0, mode: "manual", notifications: [] };
class MockNotification {
  static get permission() { return desktopNotificationMock.permission; }
  static requestPermission() {
    desktopNotificationMock.requestCalls += 1;
    desktopNotificationMock.permission = desktopNotificationMock.requestedPermission;
    return Promise.resolve(desktopNotificationMock.permission);
  }
  constructor(title, options = {}) {
    if (desktopNotificationMock.mode === "throw") throw new Error("display failed");
    this.title = title;
    this.options = options;
    this.onshow = null;
    this.onerror = null;
    desktopNotificationMock.notifications.push(this);
    if (desktopNotificationMock.mode === "show" || desktopNotificationMock.mode === "error") {
      queueMicrotask(() => this[desktopNotificationMock.mode === "show" ? "onshow" : "onerror"]?.());
    }
  }
}
function installDesktopNotificationMock() {
  Object.defineProperty(window, "Notification", { value: desktopNotificationMock.available ? MockNotification : undefined, configurable: true });
}
installDesktopNotificationMock();
window.__sceneDesktopNotificationMock = {
  configure({ available, permission, requestedPermission, mode } = {}) {
    if (available !== undefined) desktopNotificationMock.available = available;
    if (permission !== undefined) desktopNotificationMock.permission = permission;
    if (requestedPermission !== undefined) desktopNotificationMock.requestedPermission = requestedPermission;
    if (mode !== undefined) desktopNotificationMock.mode = mode;
    installDesktopNotificationMock();
  },
  emit(event) { desktopNotificationMock.notifications.at(-1)?.[event === "show" ? "onshow" : "onerror"]?.(); },
  snapshot() { return { ...desktopNotificationMock, notifications: desktopNotificationMock.notifications.map(({ title, options }) => ({ title, options })) }; },
};
const graph = {
  _nodes: [],
  getNodeById(id) { return this._nodes.find((node) => String(node.id) === String(id)); },
  extra: { original_tab: true },
  serialize() { return { version: 1, nodes: [], extra: structuredClone(this.extra) }; },
};
const loadedGraphs = [];
const activeWorkflow = {
  changeTracker: {
    undoQueue: Array.from({ length: 240 }, (_value, index) => "active-undo-" + index),
    redoQueue: Array.from({ length: 240 }, (_value, index) => "active-redo-" + index),
  },
};
const inactiveWorkflow = {
  changeTracker: {
    undoQueue: Array.from({ length: 240 }, (_value, index) => "inactive-undo-" + index),
    redoQueue: Array.from({ length: 240 }, (_value, index) => "inactive-redo-" + index),
  },
};
const workflowWithoutTracker = {};
const settingDefinitions = new Map();
const nativeSettings = {
  get(id) { const saved = localStorage.getItem("native-setting:" + id); return saved === null ? settingDefinitions.get(id)?.defaultValue : JSON.parse(saved); },
  async set(id, value) { localStorage.setItem("native-setting:" + id, JSON.stringify(value)); await settingDefinitions.get(id)?.onChange?.(value); },
};
export const app = {
  graph,
  canvas: {},
  extensionManager: { setting: nativeSettings, workflow: { activeWorkflow, openWorkflows: [activeWorkflow, inactiveWorkflow, workflowWithoutTracker] } },
  registerExtension(extension) {
    window.__scenePromptExtension = extension;
    for (const setting of extension.settings || []) { settingDefinitions.set(setting.id, setting); setting.onChange?.(nativeSettings.get(setting.id)); }
  },
  queuePrompt: async () => ({ prompt_id: "browser-test" }),
  graphToPrompt: async () => ({ output: {} }),
  async loadGraphData(workflow, ...args) { loadedGraphs.push({ workflow, args }); },
};
window.app = app;
window.__scenePromptLoadedGraphs = loadedGraphs;
window.__scenePromptUndoHistoryWorkflows = { activeWorkflow, inactiveWorkflow, workflowWithoutTracker };
`;
const changeTrackerModule = `
export class ChangeTracker {
  static MAX_HISTORY = 50;
}
window.__scenePromptChangeTracker = ChangeTracker;
`;
const apiModule = `
const listeners = new Map();
const calls = [];
let releaseFavoriteSave = null;
const favoriteMock = { loadStatuses: [], saveStatuses: [], delayNextSave: false, writes: 0, activeWrites: 0, maxActiveWrites: 0 };
window.__favoriteMock = favoriteMock;
window.__releaseFavoriteSave = () => releaseFavoriteSave?.();
let releaseDelayedItems = null;
let releaseDelayedLoraInfo = null;
let releaseDelayedLoraList = null;
let releaseDelayedModelHash = null;
const baseItem = {
  id: "summer",
  label: "Summer",
  prompt: "summer dress",
  description: "",
  category_path: ["Outfit"],
  category_key: "Outfit",
  category_label: "Outfit",
};
const weightItem = {
  ...baseItem,
  id: "weight-test",
  label: "Weight Test",
  prompt: "alpha, beta",
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
const promptItems = [baseItem, weightItem, nestedItem, ...Array.from({ length: 60 }, (_value, index) => ({
  ...baseItem,
  id: "summer-" + index,
  label: "Summer " + index,
  prompt: "summer dress " + index,
}))];
const loraCatalog = [
  { path: "style.safetensors", title: "Local Style", source: "local", size: 100, mtime_ns: 1 },
  { path: "folder/other.safetensors", title: "Other Local", source: "local", size: 200, mtime_ns: 2 },
];
window.__sceneLoraCatalog = loraCatalog;
window.__sceneResourceResponse = null;
const savedPrompt = { id: "browser-set", name: "Browser Set", description: "", items: [baseItem] };
export const api = {
  clientId: "browser-client",
  async getUserData(file) {
    calls.push({ url: "getUserData:" + file, options: {} });
    return fetch("/userdata/" + encodeURIComponent(file), { headers: { "x-test-status": String(favoriteMock.loadStatuses.shift() || 200) } });
  },
  async storeUserData(file, data, options) {
    calls.push({ url: "storeUserData:" + file, data, options });
    favoriteMock.writes += 1;
    favoriteMock.activeWrites += 1;
    favoriteMock.maxActiveWrites = Math.max(favoriteMock.maxActiveWrites, favoriteMock.activeWrites);
    try {
      if (favoriteMock.delayNextSave) {
        favoriteMock.delayNextSave = false;
        await new Promise((resolve) => { releaseFavoriteSave = resolve; });
        releaseFavoriteSave = null;
      }
      const response = await fetch("/userdata/" + encodeURIComponent(file), {
        method: "POST", body: JSON.stringify(data),
        headers: { "x-test-status": String(favoriteMock.saveStatuses.shift() || 200) },
      });
      if (response.status !== 200 && options.throwOnError !== false) throw new Error("HTTP " + response.status);
      return response;
    } finally { favoriteMock.activeWrites -= 1; }
  },
  fileURL(route) {
    calls.push({ url: "fileURL:" + route, options: {} });
    return route;
  },
  fetchApi: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith("/scene_prompt/civitai/by-hash?")) return fetch(url, options);
    if (url === "/scene_prompt/loras/list" && window.__delayNextSceneLoraList) {
      window.__delayNextSceneLoraList = false;
      await new Promise((resolveDelay) => { releaseDelayedLoraList = resolveDelay; });
      releaseDelayedLoraList = null;
    }
    if (url.startsWith("/scene_prompt/loras/info?") && window.__delayNextSceneLoraInfo) {
      window.__delayNextSceneLoraInfo = false;
      await new Promise((resolveDelay) => { releaseDelayedLoraInfo = resolveDelay; });
      releaseDelayedLoraInfo = null;
    }
    if (url.startsWith("/scene_prompt/models/hash?") && window.__delayNextSceneModelHash) {
      window.__delayNextSceneModelHash = false;
      await new Promise((resolveDelay) => { releaseDelayedModelHash = resolveDelay; });
      releaseDelayedModelHash = null;
    }
    if (url.includes("/scene_prompt/items") && options.method !== "POST" && window.__delayNextScenePromptItems) {
      window.__delayNextScenePromptItems = false;
      await new Promise((resolveDelay) => { releaseDelayedItems = resolveDelay; });
      releaseDelayedItems = null;
    }
    let payload = { items: [] };
    let status = 200;
    if (url.includes("/scene_prompt/items")) payload = { items: promptItems };
    if (url === "/scene_prompt/loras/list") payload = loraCatalog;
    if (url.startsWith("/scene_prompt/loras/info?")) payload = {
      name: decodeURIComponent(url.split("name=")[1] || ""), sha256: "A".repeat(64), trigger_phrases: ["Local Tag", "BELLE ZZZ"],
      size: loraCatalog.find((item) => url.includes(encodeURIComponent(item.path)))?.size,
      mtime_ns: window.__sceneLoraInfoVersionOverride ?? loraCatalog.find((item) => url.includes(encodeURIComponent(item.path)))?.mtime_ns,
    };
    if (url === "/scene_prompt/expand/resources" && window.__sceneResourceResponse) payload = window.__sceneResourceResponse;
    if (url.startsWith("/scene_prompt/models/hash?")) payload = { sha256: "B".repeat(64), size: 100, mtime_ns: 1 };
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
    if (url.includes("/scene_presets/list")) payload = { presets: [{ metadata: { preset_id: "browser-preset", name: "Browser Preset" } }], errors: [] };
    if (url.includes("/scene_presets/load")) payload = {
      metadata: { preset_id: "browser-preset", name: "Browser Preset" },
      schema_version: 1,
      api_graph: { output: { "1": { class_type: "ScenePresetInput", inputs: {} } } },
      workflow: { id: "stored-workflow", version: 1, nodes: [{ id: 1, type: "ScenePresetInput" }], extra: { stored: true, scene_preset_editor: { preset_id: "browser-preset", revision: 3 } } },
    };
    if (url.includes("/scene_presets/save")) payload = { metadata: { preset_id: "browser-preset", name: "Browser Preset" } };
    return new Response(JSON.stringify(payload), { status });
  },
  queuePrompt: async () => ({ prompt_id: "browser-prompt" }),
  addEventListener(name, callback) { listeners.set(name, callback); },
};
window.api = api;
window.__scenePromptCalls = calls;
window.__scenePromptItems = promptItems;
window.__scenePromptListeners = listeners;
window.__delayScenePromptItems = () => { window.__delayNextScenePromptItems = true; };
window.__releaseScenePromptItems = () => releaseDelayedItems?.();
window.__scenePromptItemsDelayed = () => !!releaseDelayedItems;
window.__releaseSceneLoraInfo = () => releaseDelayedLoraInfo?.();
window.__sceneLoraInfoDelayed = () => !!releaseDelayedLoraInfo;
window.__releaseSceneLoraList = () => releaseDelayedLoraList?.();
window.__sceneLoraListDelayed = () => !!releaseDelayedLoraList;
window.__releaseSceneModelHash = () => releaseDelayedModelHash?.();
window.__sceneModelHashDelayed = () => !!releaseDelayedModelHash;
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
let storedFavorites = null;
const index = `<!doctype html><script type="module">
  import { injectStyle } from "/extensions/scene-prompt/web/scene_prompt_style.js";
  import "/extensions/scene-prompt/web/scene_prompt_ui.js";
  injectStyle();
  window.__scenePromptExtension.setup();
  window.__scenePromptBrowserReady = true;
</script>`;

const server = http.createServer(async (request, response) => {
    if (request.url === "/userdata/scene_prompt_tools%2Ffavorites.json") {
        const status = Number(request.headers["x-test-status"] || 200);
        if (status !== 200) {
            response.writeHead(status);
            response.end("User data unavailable");
            return;
        }
        if (request.method === "POST") {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            storedFavorites = JSON.parse(Buffer.concat(chunks).toString());
        }
        response.writeHead(storedFavorites === null ? 404 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(storedFavorites));
        return;
    }
    if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(index);
        return;
    }
    if (request.url === "/extensions/scripts/app.js" || request.url === "/extensions/scripts/api.js" || request.url === "/extensions/scripts/changeTracker.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(request.url.endsWith("app.js") ? appModule : request.url.endsWith("api.js") ? apiModule : changeTrackerModule);
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
                + `  openSavePromptPopup, openSceneLoraDetails, openEditPromptItemPopup, closeAllPopups,\n`
                + `  openCreatePromptPopup,\n`
                + `  openSearchPopup, openPromptCandidatePopup, openCategoryLevelPicker, loadFavorites, setMatrixLineDraftContext,\n`
                + `  attachMatrixTextAreaAutocomplete, readMatrixState,\n`
                + `  openScenePresetSwitchNames, openScenePresetSwitchSettings, commitScenePresetSwitchJSON, refreshScenePresetSwitchLabels, applyScenePresetSwitchBindings,\n`
                + `  syncAllScenePromptNames,\n`
                + `  applySceneSourceNodeNames,\n`
                + `  saveScenePreset, installScenePresetSwitchBindings, prepareSceneRunContext, syncSceneMatrixPromptInputs,\n`
                + `  ensureSceneExpandControls,\n`
                + `  installSceneNodeRemovalCleanup,\n`
                + `  pendingDesktopNotifications() { return sceneDesktopNotificationRequests.size; },\n`
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

async function prepareFavoriteFixture(page, url) {
    await page.goto(url);
    await page.waitForFunction(() => window.__scenePromptBrowserReady === true);
    await page.evaluate(() => {
        const node = {
            id: 901, type: "FavoriteFixture", graph: window.app.graph, size: [420, 300], properties: {},
            widgets: ["positive_json", "negative_json"].map((name) => ({ name, value: '{"version":1,"categories":{}}' })),
            setDirtyCanvas() {},
        };
        node.widgets_values = node.widgets.map((widget) => widget.value);
        window.app.graph._nodes.push(node);
        window.__favoriteNode = node;
    });
}

async function checkFavorites(browser, url) {
    const page = await browser.newPage();
    await prepareFavoriteFixture(page, url);
    await page.evaluate(async () => {
        window.__favoriteMock.loadStatuses = [503];
        await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode, { favorites: true });
    });
    await page.getByText(/お気に入りを読み込めませんでした。HTTP 503/).waitFor();
    assert.equal(storedFavorites, null, "load failures do not overwrite the user data with an empty list");
    await page.getByRole("button", { name: "お気に入りを再読み込み", exact: true }).click();
    await page.getByText("お気に入りはありません。候補の☆から追加できます。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "検索", exact: true }).click();
    const search = page.locator(".pc-searchbox");
    await search.fill("Summer");
    const baseStar = page.locator('.pc-favorite[data-favorite-key="Outfit::summer"]');
    const originalSelection = await page.evaluate(() => JSON.stringify(window.__favoriteNode.widgets_values));
    await baseStar.click();
    await page.waitForFunction(() => document.querySelector('.pc-favorite[data-favorite-key="Outfit::summer"]')?.getAttribute("aria-pressed") === "true");
    assert.equal(await page.evaluate(() => JSON.stringify(window.__favoriteNode.widgets_values)), originalSelection, "star clicks do not change positive/negative selection or weights");
    assert.equal(await page.locator('.pc-candidate[title="summer dress"] input[type="checkbox"]').isChecked(), false);
    const firstSave = await page.evaluate(() => window.__scenePromptCalls.find((call) => call.url.startsWith("storeUserData:")));
    assert.deepEqual(firstSave.options, { overwrite: true, stringify: true, throwOnError: true });
    assert.deepEqual(storedFavorites, ["Outfit::summer"]);

    await page.evaluate(() => { window.__favoriteMock.saveStatuses = [500]; });
    await baseStar.click();
    await page.getByText(/お気に入りを保存できませんでした。HTTP 500/).waitFor();
    assert.equal(await baseStar.getAttribute("aria-pressed"), "true", "failed removal remains committed as a favorite");
    assert.deepEqual(storedFavorites, ["Outfit::summer"]);
    await page.evaluate(() => {
        window.__favoriteMock.delayNextSave = true;
        const button = document.querySelector('.pc-favorite[data-favorite-key="Outfit::summer"]');
        button.click(); button.click(); button.click();
    });
    await page.waitForFunction(() => window.__favoriteMock.activeWrites === 1);
    assert.equal(await baseStar.getAttribute("aria-pressed"), "true", "pending saves never show uncommitted star state");
    await page.evaluate(() => window.__releaseFavoriteSave());
    await page.waitForFunction(() => window.__favoriteMock.writes === 5 && window.__favoriteMock.activeWrites === 0);
    assert.equal(await baseStar.getAttribute("aria-pressed"), "false", "three queued toggles are applied in order after a failed save");
    assert.deepEqual(storedFavorites, []);
    assert.equal(await page.evaluate(() => window.__favoriteMock.maxActiveWrites), 1);

    await page.evaluate(() => {
        window.__favoriteMock.saveStatuses = [503, 200];
        const button = document.querySelector('.pc-favorite[data-favorite-key="Outfit::summer"]');
        button.click(); button.click();
    });
    await page.waitForFunction(() => window.__favoriteMock.writes === 7 && window.__favoriteMock.activeWrites === 0);
    assert.equal(await baseStar.getAttribute("aria-pressed"), "true", "the next queued toggle starts from the committed state after its predecessor fails");

    // Identical ids in different categories are distinct, while labels may change.
    await page.evaluate(() => {
        window.__scenePromptItems.push({ ...window.__scenePromptItems[0], category_key: "Other", category_path: ["Other"], category_label: "Other", label: "Other Summer" });
        window.__scenePromptItems[0].label = "Renamed Summer";
    });
    await page.getByRole("button", { name: "設定再読み込み", exact: true }).click();
    await search.fill("Summer");
    assert.equal(await baseStar.getAttribute("aria-pressed"), "true", "a label edit retains favorites by id");
    assert.equal(await page.locator('.pc-favorite[data-favorite-key="Other::summer"]').getAttribute("aria-pressed"), "false");
    await page.locator('.pc-favorite[data-favorite-key="Other::summer"]').click();
    await page.waitForFunction(() => window.__favoriteMock.writes === 8 && window.__favoriteMock.activeWrites === 0);
    await page.getByRole("button", { name: "お気に入り", exact: true }).click();
    assert.equal(await search.inputValue(), "");
    assert.equal(await page.locator(".pc-candidate").count(), 2);
    await search.fill("Other");
    assert.equal(await page.locator(".pc-candidate").count(), 1);
    await page.locator(".pc-favorite").click();
    await page.getByText("一致なし", { exact: true }).waitFor();
    await page.getByRole("button", { name: "検索", exact: true }).click();
    assert.equal(await search.inputValue(), "Summer", "normal search retains its own query");
    await search.fill("Search Detail");
    await page.locator(".pc-favorite").click();
    await page.waitForFunction(() => window.__favoriteMock.activeWrites === 0 && document.querySelector(".pc-favorite")?.getAttribute("aria-pressed") === "true");
    await page.getByRole("button", { name: "お気に入り", exact: true }).click();
    assert.equal(await search.inputValue(), "Other", "favorite search retains its separate query");
    await search.fill("Search Detail");
    for (const action of ["個別選択", "編集"]) {
        await page.getByRole("button", { name: action, exact: true }).click();
        await page.getByRole("button", { name: "←戻る", exact: true }).click();
        assert.equal(await page.locator(".pc-popup-title").textContent(), "お気に入り");
        assert.equal(await search.inputValue(), "Search Detail");
        assert.equal(await page.getByRole("button", { name: "お気に入り", exact: true }).evaluate((element) => element.classList.contains("pc-on")), true);
    }
    await page.getByRole("button", { name: "設定再読み込み", exact: true }).click();
    await page.locator(".pc-popup-title").filter({ hasText: /^お気に入り$/ }).waitFor();
    assert.equal(await search.inputValue(), "Search Detail", "popup reopen retains favorite mode and query");

    await page.getByRole("button", { name: "検索", exact: true }).click();
    await search.fill("Summer");
    const savedBeforeBatch = await page.evaluate(() => window.__favoriteMock.writes);
    await page.evaluate(() => {
        for (const button of [...document.querySelectorAll('.pc-favorite[aria-pressed="false"]')].slice(0, 14)) button.click();
    });
    await page.waitForFunction((writes) => window.__favoriteMock.writes === writes + 14 && window.__favoriteMock.activeWrites === 0, savedBeforeBatch);
    await page.getByRole("button", { name: "お気に入り", exact: true }).click();
    await search.fill("Summer");
    const scroll = await page.locator(".pc-popup-list").evaluate((element) => {
        element.scrollTop = 240;
        element.dispatchEvent(new Event("scroll"));
        return element.scrollTop;
    });
    assert.ok(scroll > 0);
    await page.getByRole("button", { name: "検索", exact: true }).click();
    await page.getByRole("button", { name: "お気に入り", exact: true }).click();
    await page.waitForFunction((scroll) => document.querySelector(".pc-popup-list")?.scrollTop === scroll, scroll);
    assert.equal(await search.inputValue(), "Summer");

    await page.evaluate(async () => {
        await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode, { favorites: true, stateWidgetName: "negative_json" });
    });
    assert.equal(await search.inputValue(), "", "the negative side starts with an independent query");
    assert.equal(await baseStar.getAttribute("aria-pressed"), "true", "positive and negative use the same saved favorites");
    await page.locator('.pc-candidate[title="summer dress"] input[type="checkbox"]').click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__favoriteNode.widgets[1].value).categories.Outfit[0].id), "summer");
    assert.equal(await page.evaluate(() => window.__favoriteNode.widgets[0].value), '{"version":1,"categories":{}}');

    await page.evaluate(async () => {
        const draft = { row_id: "favorites-matrix", positive_json: '{"version":1,"categories":{}}', negative_json: '{"version":1,"categories":{}}' };
        window.__favoriteMatrixDraft = draft;
        const stateWidgetName = window.__scenePromptPopupTestHooks.setMatrixLineDraftContext(window.__favoriteNode, 0, draft, "positive", () => {}, () => {});
        await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode, { favorites: true, stateWidgetName });
    });
    const matrixPopup = page.locator(".pc-popup").last();
    assert.equal(await matrixPopup.locator('.pc-favorite[data-favorite-key="Outfit::summer"]').getAttribute("aria-pressed"), "true");
    await matrixPopup.locator('.pc-candidate[title="summer dress"] input[type="checkbox"]').click();
    assert.equal(await page.evaluate(() => JSON.parse(window.__favoriteMatrixDraft.positive_json).categories.Outfit[0].id), "summer", "favorites use the existing Matrix row draft path");
    assert.equal(await page.evaluate(() => window.__favoriteNode.widgets[0].value), '{"version":1,"categories":{}}', "the Matrix picker does not write normal selections");
    await matrixPopup.getByRole("button", { name: "行編集へ戻る", exact: true }).click();

    await page.evaluate(async () => {
        const item = window.__scenePromptItems[0];
        item.label = "非常に長いお気に入り候補の名前".repeat(12);
        item.prompt = "long_unbroken_prompt_".repeat(30);
        window.__scenePromptPopupTestHooks.clearPromptItemsCache();
        await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode, { favorites: true, stateWidgetName: "positive_json" });
    });
    for (const width of [420, 556, 760]) {
        await page.locator(".pc-popup").evaluate((element, width) => { element.style.width = `${width}px`; }, width);
        const overflow = await page.locator(".pc-candidate").evaluateAll((rows) => rows.map((row) => {
            const rect = row.getBoundingClientRect();
            const star = row.querySelector(".pc-favorite").getBoundingClientRect();
            return { overflow: row.scrollWidth > row.clientWidth, starInside: star.right <= rect.right && star.left >= rect.left };
        }));
        assert.ok(overflow.length);
        assert.equal(overflow.some(({ overflow, starInside }) => overflow || !starInside), false, `favorite star and long text stay inside ${width}px candidates`);
        if (process.env.SCENE_BROWSER_SCREENSHOTS_DIR && width !== 556) {
            await mkdir(process.env.SCENE_BROWSER_SCREENSHOTS_DIR, { recursive: true });
            const screenshot = resolve(process.env.SCENE_BROWSER_SCREENSHOTS_DIR, `favorites-${width}.png`);
            await page.locator(".pc-popup").screenshot({ path: screenshot });
            console.log(`Favorite UI review: ${screenshot}`);
        }
    }
    const loads = await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("getUserData:")).length);
    assert.equal(loads, 2, "failed load retries once; every subsequent picker shares the successful cache");
    const finalFavorites = [...storedFavorites];
    assert.equal(JSON.stringify(await page.evaluate(() => window.__favoriteNode.widgets_values)).includes("favorite"), false, "favorites are not serialized in the workflow");
    await page.close();

    const reloadedPage = await browser.newPage();
    await prepareFavoriteFixture(reloadedPage, url);
    await reloadedPage.evaluate(async () => {
        await Promise.all(Array.from({ length: 5 }, () => window.__scenePromptPopupTestHooks.loadFavorites()));
        await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode, { favorites: true });
    });
    assert.equal(await reloadedPage.locator('.pc-favorite[aria-pressed="true"]').count(), finalFavorites.length);
    assert.equal(await reloadedPage.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("getUserData:")).length), 1, "a fresh page shares concurrent loads and restores persistent favorites");
    await reloadedPage.close();
    console.log("Favorite persistence, failure recovery, navigation, Matrix draft, and responsive layout passed.");
}

async function checkProgressiveCandidates(browser, url) {
    const page = await browser.newPage();
    const previousFavorites = storedFavorites;
    try {
        storedFavorites = Array.from({ length: 1200 }, (_, id) => `Bulk > Leaf::${id}`);
        await prepareFavoriteFixture(page, url);
        const initial = await page.evaluate(async () => {
            const items = Array.from({ length: 1200 }, (_, id) => ({ id: String(id), label: `Chunk item ${id}`,
                prompt: `chunk_tag_${id}`, category_path: ["Bulk", "Leaf"], category_key: "Bulk > Leaf", category_label: "Bulk > Leaf" }));
            window.__scenePromptItems.splice(0, window.__scenePromptItems.length, ...items);
            const hooks = window.__scenePromptPopupTestHooks, node = window.__favoriteNode;
            await hooks.openSearchPopup(node);
            const input = document.querySelector(".pc-searchbox"); input.value = "chunk"; input.dispatchEvent(new Event("input"));
            const first = document.querySelectorAll(".pc-candidate").length;
            document.querySelector('.pc-candidate input[type="checkbox"]').click();
            const state = JSON.parse(node.widgets[0].value);
            state.categories["Bulk > Leaf"].push({ ...items[900], weight: 1.6 });
            node.widgets[0].value = JSON.stringify(state);
            return first;
        });
        assert(initial > 0 && initial < 1200, "broad search returns after a small first chunk");
        const ready = (expected = 1200) => page.waitForFunction(expected => document.querySelectorAll(".pc-candidate").length === expected
            && !document.querySelector(".pc-popup-list").sceneListRender, expected);
        await ready();
        assert.deepEqual(await page.locator(".pc-candidate-title").allTextContents(), Array.from({ length: 1200 }, (_, id) => `Chunk item ${id}`));
        const lastSelected = page.locator('.pc-candidate[title="chunk_tag_900"]');
        assert.equal(await lastSelected.locator('input[type="checkbox"]').isChecked(), true, "later chunks see selections changed after the first chunk");
        assert.equal(await lastSelected.locator('.pc-weight-input').inputValue(), "1.6", "later chunks preserve fresh weights");
        await page.locator('.pc-candidate[title="chunk_tag_0"] .pc-weight-input').fill("1.25");
        await page.locator('.pc-candidate[title="chunk_tag_0"] .pc-weight-input').dispatchEvent("change");
        await page.locator('.pc-candidate[title="chunk_tag_0"] .pc-favorite').click();
        await page.waitForFunction(() => window.__favoriteMock.activeWrites === 0);
        await page.getByRole("button", { name: "お気に入り", exact: true }).click();
        await ready(1199);
        assert.equal(await page.locator('.pc-candidate[title="chunk_tag_0"]').count(), 0, "favorite toggling keeps identities across chunked results");
        assert.equal(await page.locator('.pc-candidate[title="chunk_tag_900"] .pc-weight-input').inputValue(), "1.6");
        await page.getByRole("button", { name: "検索", exact: true }).click(); await ready();

        const savedScroll = await page.locator(".pc-popup-list").evaluate(list => {
            list.scrollTop = 16000; list.dispatchEvent(new Event("scroll")); return list.scrollTop;
        });
        await page.evaluate(() => [...document.querySelector('.pc-candidate').querySelectorAll('button')].find(button => button.textContent === "編集").click());
        await page.getByRole("button", { name: "←戻る", exact: true }).click(); await ready();
        await page.waitForFunction(top => document.querySelector(".pc-popup-list")?.scrollTop === top, savedScroll);
        assert.equal(await page.locator('.pc-searchbox').inputValue(), "chunk", "edit/back restores the broad query and deep scroll");
        await page.getByRole("button", { name: "選択済み一覧", exact: true }).click();
        await page.getByRole("button", { name: "検索", exact: true }).click(); await ready();
        await page.waitForFunction(top => document.querySelector(".pc-popup-list")?.scrollTop === top, savedScroll);

        for (const action of ["wheel", "keydown", "manual"]) {
            await page.locator(".pc-popup-list").evaluate(list => { list.scrollTop = 16000; list.dispatchEvent(new Event("scroll")); });
            const pending = await page.evaluate(async action => {
                await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode);
                const list = document.querySelector(".pc-popup-list"), restoring = !!list.scenePendingScrollRestore;
                if (action !== "manual") list.dispatchEvent(new Event(action));
                list.scrollTop = 37; list.dispatchEvent(new Event("scroll"));
                return restoring;
            }, action);
            assert.equal(pending, true, "a deep restore remains pending while only the first chunk exists");
            await ready();
            assert.equal(await page.locator(".pc-popup-list").evaluate(list => list.scrollTop), 37,
                `${action} scrolling cancels the pending restore`);
        }

        const filtered = await page.evaluate(async () => {
            await window.__scenePromptPopupTestHooks.openPromptCandidatePopup(window.__favoriteNode, ["Bulk", "Leaf"]);
            const popup = document.querySelector(".pc-popup"), list = popup.querySelector(".pc-popup-list");
            const oldTask = popup.sceneListRender;
            const filter = popup.querySelector(".pc-searchbox"); filter.value = "chunk_tag_1199"; filter.dispatchEvent(new Event("input"));
            return { first: list.querySelectorAll(".pc-candidate").length, cancelled: oldTask !== popup.sceneListRender };
        });
        assert.deepEqual(filtered, { first: 1, cancelled: true });
        await page.waitForTimeout(100);
        assert.deepEqual(await page.locator(".pc-candidate-title").allTextContents(), ["Chunk item 1199"], "old candidate chunks cannot append after filtering");

        await page.evaluate(async () => {
            await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode, { stateWidgetName: "negative_json" });
            const input = document.querySelector(".pc-searchbox"); input.value = "chunk"; input.dispatchEvent(new Event("input"));
            document.querySelector('.pc-candidate input[type="checkbox"]').click();
        }); await ready();
        assert.equal(await page.evaluate(() => JSON.parse(window.__favoriteNode.widgets[1].value).categories["Bulk > Leaf"][0].id), "0");
        assert.equal(await page.evaluate(() => JSON.parse(window.__favoriteNode.widgets[0].value).categories["Bulk > Leaf"][0].weight), 1.25,
            "negative chunked selection keeps the positive weight");
        await page.evaluate(async () => {
            const node = window.__favoriteNode, hooks = window.__scenePromptPopupTestHooks;
            const draft = { row_id: "large-matrix", positive_json: '{"version":1,"categories":{}}', negative_json: '{"version":1,"categories":{}}' };
            window.__largeMatrixDraft = draft; window.__largeMatrixCommits = 0;
            const stateWidgetName = hooks.setMatrixLineDraftContext(node, 0, draft, "positive", () => {}, () => { window.__largeMatrixCommits++; });
            await hooks.openPromptCandidatePopup(node, ["Bulk", "Leaf"], { stateWidgetName });
            document.querySelector('.pc-popup:last-child .pc-candidate input[type="checkbox"]').click();
        });
        await page.waitForFunction(() => document.querySelector('.pc-popup:last-child .pc-popup-list')?.querySelectorAll(".pc-candidate").length === 1200);
        const matrixPopup = page.locator(".pc-popup").last();
        await matrixPopup.getByRole("button", { name: "閉じる", exact: true }).click();
        assert.equal(await page.evaluate(() => JSON.parse(window.__largeMatrixDraft.positive_json).categories["Bulk > Leaf"][0].id), "0");
        assert(await page.evaluate(() => window.__largeMatrixCommits > 0), "closing the progressive Matrix picker commits its draft");

        const closed = await page.evaluate(async () => {
            await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode);
            const input = document.querySelector(".pc-searchbox"); input.value = "chunk"; input.dispatchEvent(new Event("input"));
            const popup = document.querySelector(".pc-popup"), list = popup.querySelector(".pc-popup-list");
            window.__oldChunkList = list;
            const before = list.querySelectorAll(".pc-candidate").length;
            [...popup.querySelectorAll("button")].find(button => button.textContent === "閉じる").click();
            return { before, task: popup.sceneListRender, fit: popup.sceneFitFrame };
        });
        assert(closed.before < 1200); assert.equal(closed.task, null); assert.equal(closed.fit, null);
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.__oldChunkList.querySelectorAll(".pc-candidate").length), closed.before);
        assert.equal(await page.locator(".pc-popup").count(), 0, "close leaves no old DOM tasks or reopened popup");

        await page.evaluate(async () => {
            await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode);
            const input = document.querySelector(".pc-searchbox"); input.value = "chunk"; input.dispatchEvent(new Event("input"));
            window.__reloadOldPopup = document.querySelector(".pc-popup");
            window.__delayScenePromptItems();
            window.__scenePromptItems.push({ ...window.__scenePromptItems[0], id: "replacement", label: "Replacement only", prompt: "replacement_only" });
            [...window.__reloadOldPopup.querySelectorAll("button")].find(button => button.textContent === "設定再読み込み").click();
        });
        await page.waitForFunction(() => window.__scenePromptItemsDelayed());
        assert.equal(await page.evaluate(() => window.__reloadOldPopup.sceneListRender), null, "reload cancels old catalog rendering before the request finishes");
        await page.evaluate(() => window.__releaseScenePromptItems());
        await page.waitForFunction(() => document.querySelector(".pc-popup") !== window.__reloadOldPopup);
        await page.locator('.pc-searchbox').fill("replacement_only");
        assert.deepEqual(await page.locator(".pc-candidate-title").allTextContents(), ["Replacement only"]);
        await page.waitForTimeout(100);
        assert.equal(await page.locator(".pc-candidate").count(), 1, "reload uses the replacement array without late old results");
        await page.evaluate(async () => {
            await window.__scenePromptPopupTestHooks.openSearchPopup(window.__favoriteNode);
            const input = document.querySelector(".pc-searchbox"); input.value = "chunk"; input.dispatchEvent(new Event("input"));
            const node = window.__favoriteNode;
            window.__scenePromptPopupTestHooks.installSceneNodeRemovalCleanup(node, "ScenePrompter"); node.onRemoved();
        });
        await page.waitForTimeout(100);
        assert.equal(await page.locator(".pc-popup").count(), 0, "node removal cancels pending chunks and popup ownership");
        console.log("Progressive positive/negative/Matrix candidates, order, fresh weights/favorites, deep scroll/user cancellation, filter/reload/close/removal passed");
    } finally { storedFavorites = previousFavorites; await page.close(); }
}

await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
async function checkPresetSwitchModals(browser, url) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(url); await page.waitForFunction(() => window.__scenePromptBrowserReady);
    await page.evaluate(async () => {
        const graph = window.app.graph;
        const history = window.__switchHistory = { graphBefore: 0, graphAfter: 0, canvasBefore: 0, canvasAfter: 0 };
        graph.beforeChange = () => history.graphBefore++;
        graph.afterChange = () => history.graphAfter++;
        window.app.canvas = { graph, emitBeforeChange() { history.canvasBefore++; }, emitAfterChange() { history.canvasAfter++; } };
        class PresetNode {
            constructor(type, id, values) {
                this.id = id; this.type = type; this.comfyClass = type; this.graph = graph; this.properties = {};
                this.pos = [10, 10]; this.size = [400, 300]; this.mode = 0;
                this.widgets = Object.entries(values).map(([name, value]) => ({ name, value, type: "text", options: {} }));
                this.widgets_values = this.widgets.map(widget => widget.value);
                this.inputs = type === "ScenePresetInput" ? [{ name: "switch_values", type: "SCENE_SWITCHES", link: null }]
                    : [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }, { name: "switches", type: "SCENE_SWITCHES", link: null }];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                if (type === "ScenePresetInput") this.outputs.push(...Array.from({ length: 10 }, (_, i) => ({ name: `switch_${i + 1}`, type: "BOOLEAN", links: [] })), { name: "switches", type: "SCENE_SWITCHES", links: [] });
            }
            addWidget(type, name, value, callback, options) { const widget = { type, name, value, callback, options }; this.widgets.push(widget); return widget; }
            setDirtyCanvas() {}
            configure(data) {
                this.widgets_values = data.widgets_values;
                this.widgets.forEach((widget, i) => { if (data.widgets_values[i] !== undefined) widget.value = data.widgets_values[i]; });
                if (data.outputs) this.outputs = structuredClone(data.outputs);
            }
            serialize() { return { id: this.id, type: this.type, widgets_values: this.widgets_values, outputs: structuredClone(this.outputs), properties: structuredClone(this.properties) }; }
        }
        class Input extends PresetNode { constructor(id = 810) { super("ScenePresetInput", id, { switch_names_json: "[]" }); } }
        class Reference extends PresetNode { constructor(id = 811) { super("ScenePresetReference", id, { preset_id: "browser-preset", run_handle: "", llm_presets_json: "", switch_settings_json: "[]" }); } }
        await window.__scenePromptExtension.beforeRegisterNodeDef(Input, { name: "ScenePresetInput" });
        await window.__scenePromptExtension.beforeRegisterNodeDef(Reference, { name: "ScenePresetReference" });
        const input = window.__switchInput = new Input(), reference = window.__switchReference = new Reference();
        graph._nodes.push(input, reference); input.onNodeCreated(); reference.onNodeCreated();
        window.__switchNodeClasses = { Input, Reference };
    });
    await page.evaluate(() => window.__switchInput.widgets.find(widget => widget.sceneRole === "preset_switch_names").callback());
    const names = page.locator('[data-scene-preset-switch-modal="names"]');
    assert.equal(await names.locator("input").count(), 10);
    await names.locator('[data-scene-switch-save="names"]').click();
    assert.equal(await page.evaluate(() => window.__switchHistory.graphBefore), 0, "unchanged name defaults create no history");
    await page.evaluate(() => window.__switchInput.widgets.find(widget => widget.sceneRole === "preset_switch_names").callback());
    await names.locator('[data-scene-switch-index="1"]').fill("光");
    await names.locator('[data-scene-switch-index="3"]').fill("光");
    await names.locator('[data-scene-switch-save="names"]').click();
    assert.deepEqual(await page.evaluate(() => window.__switchHistory), { graphBefore: 1, graphAfter: 1, canvasBefore: 1, canvasAfter: 1 });
    assert.deepEqual(await page.evaluate(() => window.__switchInput.outputs.map(port => [port.name, port.type, port.label])), [
        ["scene_prompt", "SCENE_PROMPT", undefined], ...Array.from({ length: 10 }, (_, i) => [`switch_${i + 1}`, "BOOLEAN", i === 0 || i === 2 ? "光" : `スイッチ${i + 1}`]), ["switches", "SCENE_SWITCHES", "スイッチ一式"],
    ]);
    await page.evaluate(() => {
        const graph = window.app.graph, reference = window.__switchReference, input = window.__switchInput;
        reference.scenePresetGraph = { api_graph: { output: { 1: { class_type: "ScenePresetInput", inputs: { switch_names_json: '["子", "", "子"]' } } } } };
        graph.links = { 1: { id: 1, origin_id: input.id, origin_slot: 11, target_id: reference.id, target_slot: 1, type: "SCENE_SWITCHES" } };
        reference.inputs[1].link = 1; input.outputs[11].links = [1];
        reference.widgets.find(widget => widget.sceneRole === "preset_switch_settings").callback();
    });
    const settings = page.locator('[data-scene-preset-switch-modal="settings"]');
    assert.equal(await settings.locator("select").count(), 10);
    assert.equal(await settings.locator('[data-scene-switch-index="3"]').locator("..").textContent().then(text => text.startsWith("設定先 3: 子")), true);
    assert.equal(await settings.locator('[data-scene-switch-index="3"] option[value="1"]').textContent(), "入力 1: 光");
    await settings.locator('[data-scene-switch-save="settings"]').click();
    assert.equal(await page.evaluate(() => window.__switchHistory.graphBefore), 1, "identity mapping is a no-op");
    await page.evaluate(() => window.__switchReference.widgets.find(widget => widget.sceneRole === "preset_switch_settings").callback());
    await settings.locator('[data-scene-switch-index="3"]').selectOption("1");
    await settings.locator('[data-scene-switch-index="1"]').selectOption("true");
    await settings.locator('[data-scene-switch-save="settings"]').click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(window.__switchReference.widgets.find(widget => widget.name === "switch_settings_json").value)), [true, 2, 1, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(await page.evaluate(() => window.__switchHistory), { graphBefore: 2, graphAfter: 2, canvasBefore: 2, canvasAfter: 2 });
    const migrations = await page.evaluate(() => {
        const { Input, Reference } = window.__switchNodeClasses;
        const input = new Input(812); input.configure(window.__switchInput.serialize());
        const old = new Reference(813); old.configure({ widgets_values: ["legacy", "handle", "{}", "Presetを選択", "Preset編集"] });
        const legacyInput = new Input(814);
        legacyInput.outputs[0].widget = { _node: legacyInput };
        legacyInput.configure({ widgets_values: [], outputs: [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [42], preserved: "slot0 metadata" }] });
        return { clonedName: input.outputs[1].label, clonedSlot: input.outputs[3].name, legacy: old.widgets.find(widget => widget.name === "switch_settings_json").value,
            id: old.widgets.find(widget => widget.name === "preset_id").value, handle: old.widgets.find(widget => widget.name === "run_handle").value,
            legacyInput: { count: legacyInput.outputs.length, slot0: JSON.parse(JSON.stringify(legacyInput.outputs[0])) },
            settingsAboveEdit: window.__switchReference.widgets.findIndex(widget => widget.sceneRole === "preset_switch_settings") < window.__switchReference.widgets.findIndex(widget => widget.sceneRole === "scene_preset_edit") };
    });
    assert.deepEqual(migrations, { clonedName: "光", clonedSlot: "switch_3", legacy: "[]", id: "legacy", handle: "handle", settingsAboveEdit: true,
        legacyInput: { count: 12, slot0: { name: "scene_prompt", type: "SCENE_PROMPT", links: [42], preserved: "slot0 metadata" } } });
    await page.evaluate(() => {
        const input = window.__switchInput, graph = window.app.graph;
        window.__scenePromptPopupTestHooks.openScenePresetSwitchNames(input);
        graph._nodes = graph._nodes.filter(node => node !== input);
        const replacement = new window.__switchNodeClasses.Input(input.id); graph._nodes.push(replacement); window.__switchReplacement = replacement;
    });
    await names.locator('[data-scene-switch-index="1"]').fill("stale"); await names.locator('[data-scene-switch-save="names"]').click();
    assert.deepEqual(await page.evaluate(() => [window.__switchReplacement.widgets[0].value, window.__switchInput.widgets[0].value, window.__switchHistory.graphBefore]), ["[]", JSON.stringify(["光", "", "光", "", "", "", "", "", "", ""]), 2]);
    const binding = await page.evaluate(() => {
        const graph = window.app.graph, input = window.__switchReplacement;
        input.properties.scene_switch_values = Array.from({ length: 10 }, (_, i) => i === 2);
        const payload = { output: { [input.id]: { class_type: "ScenePresetInput", inputs: {} } } };
        return window.__scenePromptPopupTestHooks.applyScenePresetSwitchBindings(payload, graph).output[input.id].inputs.switch_values;
    });
    assert.deepEqual(binding, { values: Array.from({ length: 10 }, (_, i) => i === 2) });
    assert.equal(await page.evaluate(() => window.__scenePromptExtension.settings.every(setting => setting.category[0] === "Scene Prompt Tools")), true);
    await page.close();
    console.log("Chromium Preset switch names/mapping, source/target labels, no-op/history balance, stale owner, legacy migration and replay binding passed.");
}

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => window.__scenePromptBrowserReady === true, null, { timeout: 5_000 });
    const gpuDefaults = await page.evaluate(async () => {
        const { createGPUController } = await import("/extensions/scene-prompt/web/scene_prompt_gpu.js");
        const resources = createGPUController({ app: window.app, api: window.api });
        const defaults = resources.snapshot();
        await window.app.extensionManager.setting.set("ScenePrompt.ReleaseComfyBeforeLLM", true);
        await window.app.extensionManager.setting.set("ScenePrompt.ReleaseLLMBeforeImage", false);
        return { defaults, changed: resources.snapshot(), definitions: window.__scenePromptExtension.settings
            .filter(({ id }) => id.startsWith("ScenePrompt.Release")).map(({ id, type, defaultValue }) => ({ id, type, defaultValue })) };
    });
    assert.deepEqual(gpuDefaults.defaults, { releaseComfyBeforeLLM: false, releaseLLMBeforeImage: false });
    assert.deepEqual(gpuDefaults.changed, { releaseComfyBeforeLLM: true, releaseLLMBeforeImage: false });
    assert.equal(gpuDefaults.definitions.length, 2);
    assert(gpuDefaults.definitions.every(({ type, defaultValue }) => type === "boolean" && defaultValue === false));
    await page.reload();
    await page.waitForFunction(() => window.__scenePromptBrowserReady === true);
    assert.deepEqual(await page.evaluate(async () => {
        const { createGPUController } = await import("/extensions/scene-prompt/web/scene_prompt_gpu.js");
        return createGPUController({ app: window.app, api: window.api }).snapshot();
    }), gpuDefaults.changed, "resource controller reads persisted native settings after reload");
    assert(!await page.evaluate(() => window.__scenePromptCalls.some(({ url }) => /\/gpu\/|\/llm\/(begin|end)/.test(url))),
        "registration and reload do not acquire or release resources");
    await page.evaluate(() => window.app.extensionManager.setting.set("ScenePrompt.ReleaseComfyBeforeLLM", false));
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

    const undoHistory = await page.evaluate(() => {
        const setting = window.__scenePromptExtension.settings.find(({ id }) => id === "ScenePrompt.UndoHistoryLimit");
        const { activeWorkflow, inactiveWorkflow } = window.__scenePromptUndoHistoryWorkflows;
        const queue = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
        const snapshot = () => ({
            limit: window.__scenePromptChangeTracker.MAX_HISTORY,
            activeUndo: [...activeWorkflow.changeTracker.undoQueue],
            activeRedo: [...activeWorkflow.changeTracker.redoQueue],
            inactiveUndo: [...inactiveWorkflow.changeTracker.undoQueue],
            inactiveRedo: [...inactiveWorkflow.changeTracker.redoQueue],
        });
        const initial = snapshot();
        setting.onChange(49);
        const lowerClamped = snapshot();
        activeWorkflow.changeTracker.undoQueue = queue("active-next-undo", 600);
        activeWorkflow.changeTracker.redoQueue = queue("active-next-redo", 600);
        inactiveWorkflow.changeTracker.undoQueue = queue("inactive-next-undo", 600);
        inactiveWorkflow.changeTracker.redoQueue = queue("inactive-next-redo", 600);
        setting.onChange(550);
        const upperClamped = snapshot();
        setting.onChange(199.6);
        const rounded = snapshot();
        setting.onChange(Number.NaN);
        const invalid = snapshot();
        return {
            schema: {
                name: setting.name,
                type: setting.type,
                defaultValue: setting.defaultValue,
                min: setting.attrs.min,
                max: setting.attrs.max,
                step: setting.attrs.step,
                tooltip: setting.tooltip,
            },
            initial,
            lowerClamped,
            upperClamped,
            rounded,
            invalid,
        };
    });
    assert.deepEqual(undoHistory.schema, {
        name: "Scene Prompt Tools: Undo履歴数",
        type: "number",
        defaultValue: 200,
        min: 50,
        max: 500,
        step: 50,
        tooltip: "全ワークフロー共通です。増やすほど Ctrl+Z で戻せる回数は増えますが、ブラウザのメモリ使用量も増えます。",
    });
    assert.equal(undoHistory.initial.limit, 200, "the default is applied during extension registration");
    for (const queue of [
        undoHistory.initial.activeUndo,
        undoHistory.initial.activeRedo,
        undoHistory.initial.inactiveUndo,
        undoHistory.initial.inactiveRedo,
    ]) {
        assert.equal(queue.length, 200, "the default trims every loaded workflow");
        assert.match(queue.at(-1), /-239$/, "the newest undo state is retained");
    }
    assert.equal(undoHistory.lowerClamped.limit, 50);
    for (const queue of [
        undoHistory.lowerClamped.activeUndo,
        undoHistory.lowerClamped.activeRedo,
        undoHistory.lowerClamped.inactiveUndo,
        undoHistory.lowerClamped.inactiveRedo,
    ]) {
        assert.equal(queue.length, 50, "lowering the limit trims each history queue in place");
        assert.match(queue.at(-1), /-239$/, "lowering the limit keeps the newest entries");
    }
    assert.equal(undoHistory.upperClamped.limit, 500);
    for (const queue of [
        undoHistory.upperClamped.activeUndo,
        undoHistory.upperClamped.activeRedo,
        undoHistory.upperClamped.inactiveUndo,
        undoHistory.upperClamped.inactiveRedo,
    ]) {
        assert.equal(queue.length, 500, "the maximum setting keeps the newest 500 entries");
        assert.match(queue.at(-1), /-599$/);
    }
    assert.equal(undoHistory.rounded.limit, 200, "decimal values are rounded to an integer");
    assert.equal(undoHistory.rounded.activeUndo.length, 200);
    assert.match(undoHistory.rounded.inactiveRedo.at(-1), /-599$/);
    assert.equal(undoHistory.invalid.limit, 200, "an invalid value restores the safe default");

    await page.evaluate(async () => {
        class LGraphNode {
            serialize() { return { widgets_values: structuredClone(this.widgets_values) }; }
            configure(serialized) {
                const widgets = this.widgets.filter((widget) => widget.serialize !== false);
                for (const [index, value] of (serialized.widgets_values || []).entries()) {
                    if (widgets[index]) widgets[index].value = structuredClone(value);
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
        class SceneApplyLoraNode extends LGraphNode {
            constructor() {
                super();
                this.id = 2;
                this.type = "SceneApplyLora";
                this.comfyClass = "SceneApplyLora";
                this.size = [300, 180];
                this.inputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.graph = window.app.graph;
                this.widgets = [
                    { name: "lora_name", type: "combo", value: "style.safetensors", options: {} },
                    { name: "strength_model", type: "number", value: 0.8, options: {} },
                    { name: "strength_clip", type: "number", value: 0.7, options: {} },
                    { name: "model_mode", type: "combo", value: "Anima", options: {} },
                    { name: "positive", type: "text", value: "", options: {} },
                    { name: "negative", type: "text", value: "", options: {} },
                    { name: "positive_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "negative_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "category_order", type: "text", value: "", options: {} },
                ];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            setDirtyCanvas() {}
            setSize(size) { this.size = [...size]; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(SceneApplyLoraNode, { name: "SceneApplyLora" });
        const applyLora = new SceneApplyLoraNode();
        applyLora.onNodeCreated();
        for (const [name, value] of [["positive", "(belle zzz:1.2), {blue, red|green}, Belle ZZZ extra"], ["negative", "bad"]]) {
            const widget = applyLora.widgets.find((candidate) => candidate.name === name);
            widget.value = value;
            applyLora.widgets_values[applyLora.widgets.indexOf(widget)] = value;
        }
        const savedLora = applyLora.serialize();
        const restoredLora = new SceneApplyLoraNode();
        restoredLora.onNodeCreated();
        restoredLora.configure(savedLora);
        const legacyLora = new SceneApplyLoraNode();
        legacyLora.onNodeCreated();
        legacyLora.configure({ widgets_values: ["old.safetensors", 0.4, 0.3, "Illustrious"] });
        const linkedLora = new SceneApplyLoraNode();
        linkedLora.onNodeCreated();
        linkedLora.inputs.push({ name: "model_mode", link: 17 });
        linkedLora.configure({ widgets_values: ["linked.safetensors", 0.6, 0.5, null, "front", "back"] });
        const oldSixLora = new SceneApplyLoraNode();
        oldSixLora.onNodeCreated();
        oldSixLora.configure({ widgets_values: ["yuzu.safetensors", null, null, "Illustrious", "Yuzu Soft style", ""] });
        const namedSixLora = new SceneApplyLoraNode();
        namedSixLora.onNodeCreated();
        namedSixLora.configure({ widgets_values: ["wrong.safetensors", 1, 1, "Anima", "wrong", "wrong"], widgets_values_named: {
            lora_name: "yuzu.safetensors", strength_model: null, strength_clip: null,
            model_mode: "Illustrious", positive: "Yuzu Soft style", negative: "",
        } });
        const displayNineLora = new SceneApplyLoraNode();
        displayNineLora.onNodeCreated();
        displayNineLora.configure({ widgets_values: ["Anima", 0.4, 0.3, "display positive", "display negative", "display.safetensors",
            '{"version":1,"categories":{}}', '{"version":1,"categories":{}}', ""] });
        const emptyLora = new SceneApplyLoraNode();
        emptyLora.widgets.find((widget) => widget.name === "lora_name").value = "";
        emptyLora.onNodeCreated();
        const emptyButton = emptyLora.widgets.find((widget) => widget.sceneRole === "lora_select");
        const initialEmptyButton = { name: emptyButton.name, label: emptyButton.label, tooltip: emptyButton.tooltip };
        const emptyName = emptyLora.widgets.find((widget) => widget.name === "lora_name");
        emptyName.value = "folder\\updated.safetensors";
        emptyName.callback?.(emptyName.value);
        const changedButton = { name: emptyButton.name, label: emptyButton.label, tooltip: emptyButton.tooltip };
        const linkedNameLora = new SceneApplyLoraNode();
        linkedNameLora.onNodeCreated();
        linkedNameLora.inputs.push({ name: "lora_name", link: 18 });
        linkedNameLora.onConnectionsChange();
        const longLora = new SceneApplyLoraNode();
        longLora.onNodeCreated();
        const longPath = `folder/${"very_long_lora_name_".repeat(6)}.safetensors`;
        const longName = longLora.widgets.find((widget) => widget.name === "lora_name");
        longName.value = longPath;
        longName.callback?.(longPath);
        const selectLabel = (node) => {
            const widget = node.widgets.find((entry) => entry.sceneRole === "lora_select");
            return { name: widget.name, label: widget.label, tooltip: widget.tooltip };
        };
        const namedRoundTrip = new SceneApplyLoraNode();
        namedRoundTrip.onNodeCreated();
        namedRoundTrip.configure(JSON.parse(JSON.stringify(namedSixLora.serialize())));
        window.__sceneApplyLoraRoundTrip = {
            visible: applyLora.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            serializableOrder: applyLora.widgets.filter((widget) => widget.serialize !== false).map((widget) => widget.name),
            labels: ["positive", "negative"].map((name) => applyLora.widgets.find((widget) => widget.name === name).label),
            saved: savedLora.widgets_values,
            restored: restoredLora.serialize().widgets_values,
            legacy: legacyLora.serialize().widgets_values,
            linked: linkedLora.serialize().widgets_values,
            copied: (() => { const copy = new SceneApplyLoraNode(); copy.onNodeCreated(); copy.configure(linkedLora.serialize()); return copy.serialize().widgets_values; })(),
            oldSix: oldSixLora.serialize().widgets_values,
            namedSix: namedSixLora.serialize().widgets_values,
            displayNine: displayNineLora.serialize().widgets_values,
            namedRoundTrip: namedRoundTrip.serialize().widgets_values,
            namedFields: namedSixLora.serialize().widgets_values_named,
            oldSixPositiveJson: oldSixLora.widgets.find((widget) => widget.name === "positive_json").value,
            namedSixPositiveJson: namedSixLora.widgets.find((widget) => widget.name === "positive_json").value,
            buttons: {
                initial: selectLabel(applyLora), empty: initialEmptyButton, changed: changedButton, restored: selectLabel(restoredLora),
                legacy: selectLabel(legacyLora), named: selectLabel(namedSixLora), linked: selectLabel(linkedNameLora),
                long: selectLabel(longLora), longPath,
            },
        };
        class ScenePromptToTextNode extends LGraphNode {
            constructor() {
                super();
                this.type = "ScenePromptToText";
                this.comfyClass = "ScenePromptToText";
                this.size = [280, 160];
                this.inputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }];
                this.graph = window.app.graph;
                this.widgets = [
                    { name: "scope", type: "combo", value: "全てのノード", options: {} },
                    { name: "current_index", type: "number", value: 0, options: {} },
                    { name: "seed_base", type: "number", value: 0, options: {} },
                    { name: "seed_base_literal", type: "toggle", value: false, options: {} },
                ];
            }
            configure(serialized) {
                if (serialized.inputs) this.inputs = structuredClone(serialized.inputs);
                super.configure(serialized);
            }
            serialize() { return { widgets_values: this.widgets.map((widget) => widget.value), inputs: structuredClone(this.inputs) }; }
            removeInput(index) { this.inputs.splice(index, 1); }
            setDirtyCanvas() {}
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(ScenePromptToTextNode, { name: "ScenePromptToText" });
        const toText = new ScenePromptToTextNode();
        toText.onNodeCreated();
        toText.configure({ widgets_values: ["直前のノードのみ", 7, 12345, true, "Anima"],
            widgets_values_named: { model_mode: "Anima" } });
        const legacyRestored = toText.serialize().widgets_values;
        const reloadedToText = new ScenePromptToTextNode();
        reloadedToText.onNodeCreated();
        window.app.graph.links = { 211: { target_id: 0, target_slot: 0 } };
        reloadedToText.id = 212;
        reloadedToText.configure({ widgets_values: ["直前のノードのみ", 7, 12345, true, "Illustrious"],
            widgets_values_named: { model_mode: "Illustrious" },
            inputs: [{ name: "model_mode", type: "COMBO", link: 210 },
                { name: "scene_prompt", type: "SCENE_PROMPT", link: 211 }] });
        window.__sceneToTextLegacyRoundTrip = {
            visible: toText.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            restored: legacyRestored,
            reloaded: reloadedToText.serialize().widgets_values,
            inputs: reloadedToText.inputs.map((input) => input.name),
            linkTargetSlot: window.app.graph.links[211].target_slot,
        };
        window.__sceneLoraTestNode = applyLora;
        window.app.graph._nodes.push(applyLora);
        window.__scenePromptTestNode = node;
        node.widgets.find((widget) => widget.sceneRole === "positive_open").callback();
    });
    const loraRoundTrip = await page.evaluate(() => window.__sceneApplyLoraRoundTrip);
    assert.deepEqual(loraRoundTrip.visible, ["model_mode", "LoRAを選択", "strength_model", "strength_clip", "詳細確認", "positive", "ポジティブ候補", "ポジティブ選択済み", "negative", "ネガティブ候補", "ネガティブ選択済み"]);
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.widgets.some((widget) => widget.sceneRole === "lora_summary")), false,
        "the LoRA node has no path, name, or Civitai summary widget on its canvas");
    assert.deepEqual(loraRoundTrip.serializableOrder, ["model_mode", "strength_model", "strength_clip", "positive", "negative", "lora_name", "positive_json", "negative_json", "category_order"]);
    assert.deepEqual(loraRoundTrip.labels, ["positiveテキスト", "negativeテキスト"]);
    assert.deepEqual(loraRoundTrip.buttons.empty, { name: "LoRAを選択", label: "LoRAを選択", tooltip: "" });
    assert.deepEqual(loraRoundTrip.buttons.changed,
        { name: "LoRAを選択", label: "LoRAを選択: updated.safetensors", tooltip: "folder\\updated.safetensors" });
    assert.deepEqual(loraRoundTrip.buttons.initial, { name: "LoRAを選択", label: "LoRAを選択: style.safetensors", tooltip: "style.safetensors" });
    assert.deepEqual(loraRoundTrip.buttons.restored, loraRoundTrip.buttons.initial);
    assert.equal(loraRoundTrip.buttons.legacy.label, "LoRAを選択: old.safetensors");
    assert.equal(loraRoundTrip.buttons.named.label, "LoRAを選択: yuzu.safetensors");
    assert.equal(loraRoundTrip.buttons.linked.label, "LoRAを選択（入力接続）");
    assert.equal(loraRoundTrip.buttons.long.name, "LoRAを選択", "a visual label does not change the button's serialized name");
    assert.match(loraRoundTrip.buttons.long.label, /^LoRAを選択: .*…$/u);
    assert.equal(loraRoundTrip.buttons.long.tooltip, loraRoundTrip.buttons.longPath);
    const emptyLoraSelection = '{"version":1,"categories":{}}';
    assert.deepEqual(loraRoundTrip.saved, ["style.safetensors", 0.8, 0.7, "Anima", "(belle zzz:1.2), {blue, red|green}, Belle ZZZ extra", "bad", emptyLoraSelection, emptyLoraSelection, ""]);
    assert.deepEqual(loraRoundTrip.restored, loraRoundTrip.saved);
    assert.deepEqual(loraRoundTrip.legacy, ["old.safetensors", 0.4, 0.3, "Illustrious", "", "", emptyLoraSelection, emptyLoraSelection, ""]);
    assert.deepEqual(loraRoundTrip.linked, ["linked.safetensors", 0.6, 0.5, null, "front", "back", emptyLoraSelection, emptyLoraSelection, ""]);
    assert.deepEqual(loraRoundTrip.copied, loraRoundTrip.linked);
    const yuzuValues = ["yuzu.safetensors", null, null, "Illustrious", "Yuzu Soft style", "", emptyLoraSelection, emptyLoraSelection, ""];
    assert.deepEqual(loraRoundTrip.oldSix, yuzuValues, "v0.6.3 six-value workflow keeps the positive prompt and linked strengths");
    assert.deepEqual(loraRoundTrip.namedSix, yuzuValues, "named widget fields override stale positional values");
    assert.deepEqual(loraRoundTrip.namedRoundTrip, yuzuValues, "LoRA settings survive JSON save/load");
    assert.equal(loraRoundTrip.namedFields.positive, "Yuzu Soft style");
    assert.equal(loraRoundTrip.namedFields.strength_model, null);
    assert.equal(JSON.parse(loraRoundTrip.oldSixPositiveJson).version, 1);
    assert.equal(JSON.parse(loraRoundTrip.namedSixPositiveJson).version, 1);
    assert.deepEqual(loraRoundTrip.displayNine, ["display.safetensors", 0.4, 0.3, "Anima", "display positive", "display negative", emptyLoraSelection, emptyLoraSelection, ""]);
    const toTextLegacy = await page.evaluate(() => window.__sceneToTextLegacyRoundTrip);
    assert.deepEqual(toTextLegacy.visible, ["scope"]);
    assert.deepEqual(toTextLegacy.restored, ["直前のノードのみ", 7, 12345, true]);
    assert.deepEqual(toTextLegacy.reloaded, ["直前のノードのみ", 7, 12345, true]);
    assert.deepEqual(toTextLegacy.inputs, ["scene_prompt"]);
    assert.equal(toTextLegacy.linkTargetSlot, 0);
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.some((call) => call.url.startsWith("/scene_prompt/loras/info?"))), false);
    let civitaiLookupCount = 0;
    await page.route("**/scene_prompt/civitai/by-hash?*", (route) => { civitaiLookupCount += 1; return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ found: true, version: { id: 20, modelId: 10, name: "Version One", model: { name: "Civitai Style" }, trainedWords: ["Belle ZZZ", "Civitai Tag", "Belle"] } }),
    }); });
    await page.evaluate(() => {
        window.__sceneLoraTestNode.properties ||= {};
        window.__sceneLoraTestNode.properties.scene_civitai = { query: "remembered query" };
        return window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback();
    });
    const loraPicker = page.getByRole("dialog", { name: "LoRAを選択" });
    assert.equal(await page.getByRole("dialog", { name: "Civitai Search", exact: true }).count(), 0, "query-only Civitai history keeps local picker entry");
    await loraPicker.locator(".pc-lora-select").filter({ hasText: "style.safetensors" }).waitFor();
    await loraPicker.locator(".pc-lora-row").first().locator(".pc-lora-title").getByText("Civitai Style").waitFor();
    assert.equal(await loraPicker.locator(".pc-lora-select").first().locator(":scope > :first-child").getAttribute("class"), "pc-lora-title",
        "the Civitai title leads each picker row and the path is subordinate");
    assert.equal(await loraPicker.locator(".pc-lora-row").first().locator(".pc-lora-source").textContent(), "Civitai",
        "the picker title is the resolved Civitai model name");
    const pickerRows = loraPicker.locator(".pc-lora-row");
    assert.deepEqual(await pickerRows.locator(".pc-lora-path").allTextContents(), ["style.safetensors", "folder/other.safetensors"]);
    assert.equal(await pickerRows.first().locator(".pc-lora-select").getAttribute("aria-pressed"), "true");
    await pickerRows.first().getByText("選択中", { exact: true }).waitFor();
    assert.equal(await pickerRows.locator("button button").count(), 0, "selection and detail buttons are siblings");
    assert.equal(await pickerRows.first().locator(":scope > button").count(), 2);
    const selectedColor = await pickerRows.first().evaluate((row) => getComputedStyle(row).backgroundColor);
    await pickerRows.first().hover();
    assert.equal(await pickerRows.first().evaluate((row) => getComputedStyle(row).backgroundColor), selectedColor);
    await pickerRows.first().locator(".pc-lora-select").focus();
    assert.equal(await pickerRows.first().evaluate((row) => getComputedStyle(row).backgroundColor), selectedColor);
    const beforePreview = await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values);
    const otherDetails = pickerRows.last().locator(".pc-lora-source");
    await otherDetails.click();
    const previewDialog = page.getByRole("dialog", { name: "LoRA 詳細確認" });
    await previewDialog.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values), beforePreview,
        "preview does not change the selected file or prompts");
    assert.equal(await previewDialog.locator(".pc-lora-word button:enabled").count(), 0);
    assert.match(await previewDialog.locator(".pc-lora-word button").first().getAttribute("title"), /選択/u);
    assert.equal(await loraPicker.evaluate((dialog) => dialog.parentElement.inert), true);
    const previewClose = previewDialog.getByRole("button", { name: "閉じる" });
    await previewClose.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await previewDialog.getByRole("link", { name: "Civitaiで見る" }).evaluate((link) => document.activeElement === link), true);
    await page.keyboard.press("Tab");
    assert.equal(await previewClose.evaluate((button) => document.activeElement === button), true);
    await page.keyboard.press("Escape");
    assert.equal(await previewDialog.count(), 0);
    assert.equal(await loraPicker.count(), 1, "Escape closes only the upper modal");
    assert.equal(await loraPicker.evaluate((dialog) => dialog.parentElement.inert), false);
    assert.equal(await otherDetails.evaluate((button) => document.activeElement === button), true);
    for (let i = 0; i < 2; i += 1) {
        await otherDetails.click();
        await previewDialog.getByRole("link", { name: "Civitaiで見る" }).waitFor();
        await previewDialog.locator("..").click({ position: { x: 2, y: 2 } });
        assert.equal(await previewDialog.count(), 0);
        assert.equal(await otherDetails.evaluate((button) => document.activeElement === button), true);
    }
    await pickerRows.first().locator(".pc-lora-source").click();
    await previewDialog.locator(".pc-lora-word button:enabled").first().waitFor();
    assert.equal(await previewDialog.locator(".pc-lora-word button:disabled").count(), 0);
    if (process.env.SCENE_BROWSER_SCREENSHOTS_DIR) {
        await mkdir(process.env.SCENE_BROWSER_SCREENSHOTS_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.SCENE_BROWSER_SCREENSHOTS_DIR, "lora-preview.png") });
    }
    await page.keyboard.press("Escape");
    if (process.env.SCENE_BROWSER_SCREENSHOTS_DIR) await page.screenshot({ path: resolve(process.env.SCENE_BROWSER_SCREENSHOTS_DIR, "lora-picker.png") });
    await loraPicker.getByRole("searchbox", { name: "パス・取得済みCivitai名で検索" }).fill("folder/");
    assert.equal(await loraPicker.locator(".pc-lora-row").count(), 1, "path search narrows the list");
    await loraPicker.getByRole("searchbox", { name: "パス・取得済みCivitai名で検索" }).fill("Civitai Style");
    assert.ok(await loraPicker.locator(".pc-lora-row").count() >= 1, "resolved Civitai-name search finds rows");
    await loraPicker.getByRole("searchbox", { name: "パス・取得済みCivitai名で検索" }).fill("style.safetensors");
    await loraPicker.locator(".pc-lora-select").click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]").some((entry) => entry.title === "Civitai Style"));
    const loraInfoCalls = await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length);
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values[0]), "style.safetensors",
        "the execution value stays the relative file path");
    await page.evaluate(() => { window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_details").callback(); });
    const loraDialog = page.getByRole("dialog", { name: "LoRA 詳細確認" });
    await loraDialog.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await loraDialog.getByRole("link", { name: "Civitaiで見る" }).getAttribute("href"),
        "https://civitai.red/models/10?modelVersionId=20");
    assert.equal(await loraDialog.locator(".pc-lora-word").count(), 4, "local and Civitai words are deduplicated");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), loraInfoCalls,
        "details reuse the selected LoRA cache");
    const injectWord = async (word) => loraDialog.locator(".pc-lora-word")
        .filter({ has: page.locator("span").filter({ hasText: new RegExp(`^${word}$`, "i") }) })
        .getByRole("button", { name: "注入" }).click();
    await injectWord("Belle ZZZ");
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.name === "positive").value),
        "(belle zzz:1.2), {blue, red|green}, Belle ZZZ extra", "weighted identity is not added twice");
    await injectWord("Local Tag");
    await injectWord("Belle");
    const afterInjection = await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values);
    assert.equal(afterInjection[4], "(belle zzz:1.2), {blue, red|green}, Belle ZZZ extra, Local Tag, Belle");
    assert.equal(afterInjection[5], "bad", "injection leaves negative unchanged");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog", { name: "LoRA 詳細確認" }).count(), 0);
    await page.evaluate(() => { window.__sceneLoraCatalog[0].mtime_ns = 3; window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback(); });
    await loraPicker.locator(".pc-lora-select").filter({ hasText: "style.safetensors" }).waitFor();
    await loraPicker.locator(".pc-lora-row").first().locator(".pc-lora-title").getByText("Civitai Style").waitFor();
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]")
        .some((entry) => entry.key === "style.safetensors\u0000100\u00003")),
    "changed file metadata resolves and caches the new identity");
    await loraPicker.locator(".pc-lora-select").first().click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]").some((entry) => entry.key.startsWith("style.safetensors") && entry.title === "Civitai Style"));
    await page.route("**/scene_prompt/civitai/by-hash?*", (route) => route.fulfill({ status: 503, json: { error: "offline" } }), { times: 1 });
    await page.evaluate(() => { window.__sceneLoraCatalog[1].mtime_ns = 4; });
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback());
    const offlineLookup = page.waitForResponse((response) => response.url().includes("/civitai/by-hash?") && response.status() === 503);
    await offlineLookup;
    await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).locator(".pc-lora-source").getByText("再確認").waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]")
        .some((entry) => entry.key === "folder/other.safetensors\u0000200\u00004")), false,
    "transient Civitai failures are not cached as missing models");
    assert.equal(await loraPicker.locator(".pc-lora-source").count(), 2, "failed lookup retains both detail buttons");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback());
    await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).locator(".pc-lora-title").getByText("Civitai Style").waitFor();
    await loraPicker.locator(".pc-lora-select").filter({ hasText: "other.safetensors" }).click();
    assert.deepEqual(await page.evaluate(() => {
        const widget = window.__sceneLoraTestNode.widgets.find((entry) => entry.sceneRole === "lora_select");
        return { label: widget.label, tooltip: widget.tooltip };
    }), { label: "LoRAを選択: other.safetensors", tooltip: "folder/other.safetensors" },
    "picker selection updates the button before metadata lookup completes");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]").some((entry) => entry.key.startsWith("folder/other.safetensors") && entry.title === "Civitai Style"));
    assert.ok(civitaiLookupCount >= 3, "offline name lookup retries on a later picker open");
    for (const [index, failure] of [
        { status: 401, json: { error: "Authentication required" } },
        { status: 429, json: { error: "Rate limited" } },
        { status: 200, contentType: "application/json", body: "not JSON" },
        { status: 200, json: { found: true, version: {} } },
        null,
    ].entries()) {
        const revision = 30 + index;
        await page.route("**/scene_prompt/civitai/by-hash?*", (route) => failure ? route.fulfill(failure) : route.abort("failed"), { times: 1 });
        await page.evaluate((revision) => {
            window.__sceneLoraCatalog[1].mtime_ns = revision;
            window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback();
        }, revision);
        await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).locator(".pc-lora-source")
            .getByText("再確認").waitFor();
        assert.equal(await page.evaluate((revision) => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]")
            .some((entry) => entry.key === `folder/other.safetensors\u0000200\u0000${revision}`), revision), false,
        "authentication, rate limits, malformed JSON, malformed metadata and network failures cannot become negative caches");
        await page.keyboard.press("Escape");
        await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback());
        await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).locator(".pc-lora-title").getByText("Civitai Style").waitFor();
        await page.keyboard.press("Escape");
    }
    const byHashCalls = await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/civitai/by-hash?")));
    assert.ok(byHashCalls.length > 0);
    assert.ok(byHashCalls.every((call) => call.url === `/scene_prompt/civitai/by-hash?sha256=${"A".repeat(64)}`
        && (!call.options.method || call.options.method === "GET")), "LoRA metadata uses only the local hash GET endpoint");
    await page.route("**/scene_prompt/civitai/by-hash?*", (route) => route.fulfill({ json: { found: false, version: null } }), { times: 1 });
    await page.evaluate(() => { window.__sceneLoraCatalog[1].mtime_ns = 5; window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback(); });
    await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).locator(".pc-lora-source").getByText("Local").waitFor();
    assert.equal(await loraPicker.locator(".pc-lora-row").first().locator(".pc-lora-path").textContent(), "folder/other.safetensors", "reopening moves the current selection first");
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]")
        .some((entry) => entry.key === "folder/other.safetensors\u0000200\u00005" && entry.status === "not_found")),
    "confirmed 404 is cached as not registered");
    const beforeMissingDetails = await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values);
    assert.equal(await loraPicker.locator(".pc-lora-row").filter({hasText:"folder/other.safetensors"}).locator(".pc-lora-title").textContent(), "other.safetensors");
    assert.equal(await loraPicker.locator(".pc-lora-local").getAttribute("role"), "status");
    if (process.env.SCENE_BROWSER_SCREENSHOTS_DIR) await page.screenshot({ path: resolve(process.env.SCENE_BROWSER_SCREENSHOTS_DIR, "lora-local-fallback.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__sceneLoraTestNode.widgets.find(widget => widget.sceneRole === "lora_details").callback(); });
    const missingDetails = page.getByRole("dialog", { name: "LoRA 詳細確認" });
    await missingDetails.locator(".pc-lora-word").filter({ hasText: "Local Tag" }).getByRole("button", { name: "注入" }).waitFor();
    assert.equal(await missingDetails.locator(".pc-lora-word button:disabled").count(), 0, "a normal missing Civitai record retains local trigger injection");
    assert.equal(await missingDetails.getByRole("link", { name: "Civitaiで見る" }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values), beforeMissingDetails,
        "opening a missing-record detail leaves selection and input intact");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        window.__sceneLoraCatalog[1].mtime_ns = 6;
        window.__sceneLoraInfoVersionOverride = 7;
        window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback();
    });
    await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).locator(".pc-lora-source")
        .getByText("再表示").waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__sceneLoraInfoVersionOverride = null; });
    const infoBeforeConcurrentDetails = await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?") && call.url.includes("other.safetensors")).length);
    await page.evaluate(() => {
        window.__sceneLoraCatalog[1].mtime_ns = 9;
        window.__delayNextSceneLoraInfo = true;
        window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback();
    });
    const lookupsBeforeConcurrentDetails = civitaiLookupCount;
    const delayedPreviewBefore = await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values);
    await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).waitFor();
    await page.evaluate(() => { window.__sceneLoraTestNode.widgets.find(widget => widget.sceneRole === "lora_details").callback(); });
    await page.waitForFunction(() => window.__sceneLoraInfoDelayed());
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?") && call.url.includes("other.safetensors")).length), infoBeforeConcurrentDetails + 1,
        "selection and details share the in-flight metadata and hash lookup");
    await page.evaluate(() => window.__releaseSceneLoraInfo());
    await page.getByRole("dialog", { name: "LoRA 詳細確認" }).getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(civitaiLookupCount, lookupsBeforeConcurrentDetails + 1, "selection and details share one Civitai request");
    assert.deepEqual(await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values), delayedPreviewBefore, "delayed preview leaves node widgets intact");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "positive_open").callback());
    await page.locator(".pc-popup").getByText("Outfit", { exact: false }).click();
    await page.getByTitle("summer dress", { exact: true }).click();
    const loraPositive = await page.evaluate(() => {
        const node = window.__sceneLoraTestNode;
        return { selected: JSON.parse(node.widgets.find((widget) => widget.name === "positive_json").value),
            list: node.widgets.find((widget) => widget.sceneRole === "positive_selected_list").value };
    });
    assert.equal(loraPositive.selected.categories.Outfit[0].id, "summer", "LoRA positive candidate is stored");
    assert.match(loraPositive.list, /1候補/u, "selected LoRA candidate appears beside its field");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "negative_open").callback());
    await page.locator(".pc-popup").getByText("Outfit", { exact: false }).click();
    await page.getByTitle("summer dress", { exact: true }).click();
    const loraCandidateRoundTrip = await page.evaluate(() => {
        const node = window.__sceneLoraTestNode;
        const stored = node.serialize().widgets_values;
        const copy = new node.constructor();
        copy.onNodeCreated();
        copy.configure(node.serialize());
        return { stored, restored: copy.serialize().widgets_values,
            negativeList: node.widgets.find((widget) => widget.sceneRole === "negative_selected_list").value };
    });
    assert.equal(JSON.parse(loraCandidateRoundTrip.stored[7]).categories.Outfit[0].id, "summer", "LoRA negative candidate is stored");
    assert.match(loraCandidateRoundTrip.negativeList, /1候補/u);
    assert.deepEqual(loraCandidateRoundTrip.restored, loraCandidateRoundTrip.stored, "both LoRA candidate lists survive save and reload");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        const OriginalObserver = window.IntersectionObserver, held = [];
        // Hold only the new row's visibility notification so the late request
        // that raced the old global-count baseline is deterministic.
        window.IntersectionObserver = class extends OriginalObserver {
            constructor(callback, options) {
                super((entries, observer) => {
                    const third = entries.filter(entry => entry.isIntersecting
                        && entry.target.querySelector('.pc-lora-path')?.textContent === 'third.safetensors');
                    callback(entries.filter(entry => !third.includes(entry)), observer);
                    if (third.length) held.push({ entries: third, observer, callback });
                }, options);
            }
        };
        window.__thirdLoraObservationHeld = () => held.some(job => job.entries.some(entry => entry.target.isConnected));
        window.__releaseThirdLoraObservation = () => {
            window.IntersectionObserver = OriginalObserver;
            for (const job of held.splice(0)) job.callback(job.entries.filter(entry => entry.target.isConnected), job.observer);
            delete window.__thirdLoraObservationHeld;
            delete window.__releaseThirdLoraObservation;
        };
        window.__sceneLoraCatalog.push({ path: "third.safetensors", size: 300, mtime_ns: 1 });
        window.__delayNextSceneLoraInfo = true;
        const node = window.__sceneLoraTestNode;
        const widget = node.widgets.find((entry) => entry.name === "lora_name");
        widget.value = "folder\\other.safetensors";
        widget.callback?.();
        node.widgets.find((entry) => entry.sceneRole === "lora_select").callback();
    });
    await loraPicker.locator(".pc-lora-row").first().getByText("選択中", { exact: true }).waitFor();
    assert.deepEqual(await loraPicker.locator(".pc-lora-path").allTextContents(),
        ["folder/other.safetensors", "style.safetensors", "third.safetensors"], "slash identity promotes selected while preserving other catalog order");
    await loraPicker.getByRole("searchbox").fill("safetensors");
    assert.equal(await loraPicker.locator(".pc-lora-path").first().textContent(), "folder/other.safetensors");
    await page.waitForFunction(() => window.__thirdLoraObservationHeld());
    const unsettledCalls = await page.evaluate(() => window.__scenePromptCalls.filter(call => call.url.startsWith('/scene_prompt/loras/info?')).length);
    await page.evaluate(() => window.__releaseThirdLoraObservation());
    await page.waitForFunction(() => window.__sceneLoraInfoDelayed());
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter(call => call.url.startsWith('/scene_prompt/loras/info?')).length), unsettledCalls + 1,
        'the new row metadata request can start after the old premature global-count baseline');
    const thirdRow = loraPicker.locator('.pc-lora-row').filter({ hasText: 'third.safetensors' });
    assert.equal(await thirdRow.locator('.pc-lora-source').textContent(), '確認中…', 'a delayed metadata response has not resolved the new row yet');
    await page.evaluate(() => window.__releaseSceneLoraInfo());
    await thirdRow.locator('.pc-lora-title').getByText('Civitai Style', { exact: true }).waitFor();
    await thirdRow.locator('.pc-lora-source').getByText('Civitai', { exact: true }).waitFor();
    const normalizedBefore = await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values);
    const normalizedCalls = await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length);
    await loraPicker.locator(".pc-lora-source").first().focus();
    await page.keyboard.press("Enter");
    await loraDialog.locator(".pc-lora-word button:enabled").first().waitFor();
    assert.deepEqual(await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values), normalizedBefore, "slash normalization never rewrites serialized paths");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), normalizedCalls, "row preview retains size and mtime cache identity");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__sceneLoraCatalog.pop());
    const positiveBeforeChangedPreview = await page.evaluate(() => {
        const node = window.__sceneLoraTestNode;
        const widget = node.widgets.find((entry) => entry.name === "lora_name");
        widget.value = "style.safetensors";
        widget.callback?.();
        window.__sceneLoraCatalog[1].mtime_ns = 10;
        window.__delayNextSceneLoraInfo = true;
        node.widgets.find((entry) => entry.sceneRole === "lora_select").callback();
        return node.widgets.find((entry) => entry.name === "positive").value;
    });
    await loraPicker.locator(".pc-lora-row").filter({ hasText: "folder/other.safetensors" }).waitFor();
    await page.evaluate(() => { void window.__scenePromptPopupTestHooks.openSceneLoraDetails(window.__sceneLoraTestNode, { ...window.__sceneLoraCatalog.find(item => item.path === "folder/other.safetensors") }); });
    await page.waitForFunction(() => window.__sceneLoraInfoDelayed());
    await page.evaluate(() => {
        const widget = window.__sceneLoraTestNode.widgets.find((entry) => entry.name === "lora_name");
        widget.value = "folder/other.safetensors";
        widget.callback?.();
        window.__releaseSceneLoraInfo();
    });
    await loraDialog.locator(".pc-lora-word button:disabled").first().waitFor();
    assert.equal(await loraDialog.locator(".pc-lora-word button:enabled").count(), 0,
        "selecting the previewed row during its delayed lookup does not grant injection eligibility");
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((entry) => entry.name === "positive").value), positiveBeforeChangedPreview);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const positiveBeforeStaleDetails = await page.evaluate(() => {
        const node = window.__sceneLoraTestNode;
        const widget = node.widgets.find((entry) => entry.name === "lora_name");
        widget.value = "stale.safetensors";
        node.widgets_values[node.widgets.indexOf(widget)] = widget.value;
        window.__delayNextSceneLoraInfo = true;
        node.widgets.find((entry) => entry.sceneRole === "lora_details").callback();
        return node.widgets.find((entry) => entry.name === "positive").value;
    });
    await page.waitForFunction(() => window.__sceneLoraInfoDelayed());
    await page.evaluate(() => {
        const node = window.__sceneLoraTestNode;
        const widget = node.widgets.find((entry) => entry.name === "lora_name");
        widget.value = "folder/other.safetensors";
        node.widgets_values[node.widgets.indexOf(widget)] = widget.value;
        window.__releaseSceneLoraInfo();
    });
    await page.getByRole("dialog", { name: "LoRA 詳細確認" }).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((entry) => entry.name === "positive").value), positiveBeforeStaleDetails,
        "a stale LoRA cannot expose Trigger Words to inject into the new selection");
    await page.evaluate(() => window.__scenePromptTestNode.widgets.find((widget) => widget.sceneRole === "positive_open").callback());
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_details").callback());
    await loraDialog.waitFor();
    await page.evaluate(() => window.__sceneLoraTestNode.onRemoved());
    assert.equal(await loraDialog.count(), 0, "removing the node cleans up its modal");
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

    const weightCandidate = page.getByTitle("alpha, beta", { exact: true });
    await weightCandidate.click();
    await page.getByTitle("alpha, beta", { exact: true }).getByRole("button", { name: "個別選択", exact: true }).click();
    let partWeights = page.locator(".pc-part-row .pc-weight-input");
    await partWeights.nth(0).fill("1.3");
    await partWeights.nth(0).press("Tab");
    let partSelection = await page.evaluate(() => JSON.parse(window.__scenePromptTestNode.widgets.find((widget) => widget.name === "positive_json").value).categories.Outfit.find((item) => item.id === "weight-test"));
    assert.deepEqual(partSelection.selected_parts, [{ index: 0, text: "alpha", weight: 1.3 }, { index: 1, text: "beta" }], "a changed individual weight remains a per-part selection");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    await page.getByRole("button", { name: "選択済み一覧", exact: true }).click();
    let weightChip = page.locator('.pc-selected-chip[title="alpha, beta"]');
    assert.equal(await weightChip.locator(".pc-weight-input").isDisabled(), true, "the whole-item weight stays disabled while individual weights differ");
    await weightChip.getByRole("button", { name: "個別", exact: true }).click();
    partWeights = page.locator(".pc-part-row .pc-weight-input");
    await partWeights.nth(1).fill("1.3");
    await partWeights.nth(1).press("Tab");
    partSelection = await page.evaluate(() => JSON.parse(window.__scenePromptTestNode.widgets.find((widget) => widget.name === "positive_json").value).categories.Outfit.find((item) => item.id === "weight-test"));
    assert.equal(partSelection.weight, 1.3, "matching all individual weights restores the whole-item weight");
    assert.equal(partSelection.selected_parts, undefined, "matching all individual weights removes selected_parts");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    weightChip = page.locator('.pc-selected-chip[title="alpha, beta"]');
    assert.equal(await weightChip.locator(".pc-weight-input").isDisabled(), false, "the whole-item weight becomes editable after individual weights match");
    assert.equal(await weightChip.locator(".pc-weight-input").inputValue(), "1.3");
    await weightChip.locator('input[type="checkbox"]').click();
    await page.getByRole("button", { name: "一覧", exact: true }).click();

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
            node_id: `node-${rowId}`,
            category: `category-${rowId}`,
            name,
            path_label: name,
            enabled: true,
            filename_enabled: false,
            positive_base: "",
            positive_json: emptySelection,
            negative_base: "",
            negative_json: emptySelection,
            category_order: `order-${rowId}`,
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

    const weightedBase = "first, ((TAG:4):0.5), (tag:1.2), (equal:1.), (EQUAL:1e0), (science:1_2e-1), (SCIENCE:1.1), (blocked:99), (tag), [tag], (invalid:NaN), <lora:tag:1>";
    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.getByPlaceholder("ポジティブ基本文").fill(weightedBase);
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    await page.getByRole("button", { name: "ネガティブ候補" }).nth(0).click();
    await page.getByPlaceholder("ネガティブ基本文").fill("(blocked: .1 )");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    const weightedLine = await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[0]);
    assert.equal(weightedLine.positive_base, weightedBase, "computing the summary preserves the exact manual input");
    assert.deepEqual(weightedLine.positive_parts, ["first", "((TAG:4):0.5)", "(equal:1.)", "(science:1_2e-1)", "(tag)", "[tag]", "(invalid:NaN)", "<lora:tag:1>"]);
    assert.deepEqual(weightedLine.negative_parts, ["(blocked: .1 )"]);
    assert.equal(await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(0).locator(".pc-candidate-desc").first().textContent(), weightedBase,
        "the editable row summary retains the saved input spelling");
    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.getByPlaceholder("ポジティブ基本文").fill("blue_hair");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    await page.getByRole("button", { name: "ネガティブ候補" }).nth(0).click();
    await page.getByPlaceholder("ネガティブ基本文").fill("bad_hands");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();

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
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(0).locator(".pc-candidate-desc").allTextContents(),
        ["blue_hair / Summer", "bad_hands"],
        "a selected positive candidate follows its Matrix base prompt",
    );
    const writesBeforeWeightCommit = await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount);
    await page.locator(".pc-popup").last().locator(".pc-weight-input").first().fill("1.35");
    await page.locator(".pc-popup").last().locator(".pc-weight-input").first().press("Tab");
    assert.equal(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value).sets[0].positive_json.includes('"weight":1.35')), true, "leaving a Matrix weight field commits the selected candidate and its weight");
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount), writesBeforeWeightCommit + 1, "weight blur makes one effective Matrix state write");
    await page.getByRole("button", { name: "行編集へ戻る" }).click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value.includes("summer")), true, "行編集へ戻る keeps the already committed positive Matrix candidate");
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount), writesBeforeWeightCommit + 1, "secondary and outer close do not add a duplicate Matrix state write");

    const matrixJsonBeforePartWeights = await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value);
    await page.getByRole("button", { name: "ポジティブ候補" }).nth(0).click();
    await page.getByText("Outfit", { exact: false }).click();
    await page.getByTitle("alpha, beta", { exact: true }).click();
    await page.getByTitle("alpha, beta", { exact: true }).getByRole("button", { name: "個別選択", exact: true }).click();
    let matrixPartWeights = page.locator(".pc-part-row .pc-weight-input");
    await matrixPartWeights.nth(0).fill("1.3");
    await matrixPartWeights.nth(0).press("Tab");
    assert.deepEqual(await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.sceneMatrixLineDraftContext.draft.positive_json).categories.Outfit.find((item) => item.id === "weight-test").selected_parts), [{ index: 0, text: "alpha", weight: 1.3 }, { index: 1, text: "beta" }], "Matrix keeps differing individual weights in its row draft");
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value), matrixJsonBeforePartWeights, "changing Matrix individual weights does not commit the row draft yet");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    await page.getByRole("button", { name: "選択済み一覧", exact: true }).click();
    let matrixWeightChip = page.locator('.pc-selected-chip[title="alpha, beta"]');
    assert.equal(await matrixWeightChip.locator(".pc-weight-input").isDisabled(), true, "Matrix selected list disables whole-item weight while individual weights differ");
    await matrixWeightChip.getByRole("button", { name: "個別", exact: true }).click();
    matrixPartWeights = page.locator(".pc-part-row .pc-weight-input");
    await matrixPartWeights.nth(1).fill("1.3");
    await matrixPartWeights.nth(1).press("Tab");
    assert.deepEqual(await page.evaluate(() => {
        const state = JSON.parse(window.__sceneMatrixTestNode.sceneMatrixLineDraftContext.draft.positive_json);
        const item = state.categories.Outfit.find((candidateItem) => candidateItem.id === "weight-test");
        return { weight: item.weight, selected_parts: item.selected_parts };
    }), { weight: 1.3, selected_parts: undefined }, "Matrix collapses matching individual weights to the whole-item representation in its draft");
    await page.getByRole("button", { name: "←戻る", exact: true }).click();
    matrixWeightChip = page.locator('.pc-selected-chip[title="alpha, beta"]');
    assert.equal(await matrixWeightChip.locator(".pc-weight-input").isDisabled(), false, "Matrix selected list enables whole-item weight after individual weights match");
    await matrixWeightChip.locator('input[type="checkbox"]').click();
    await page.getByRole("button", { name: "行編集へ戻る" }).click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value), matrixJsonBeforePartWeights, "removing the draft-only test candidate leaves the committed Matrix row unchanged");

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
        ["blue_hair / Summer:1.35", "bad_hands"],
        "saved Matrix base and candidate summaries reappear after reopening",
    );
    assert.deepEqual(
        await page.locator(".pc-popup .pc-popup-list > .pc-candidate").nth(1).locator(".pc-candidate-desc").allTextContents(),
        ["Summer"],
        "a saved whitespace-only base prompt remains hidden from the row summary",
    );

    const writesBeforeDuplicate = await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount);
    const matrixRows = page.locator(".pc-popup .pc-popup-list > .pc-candidate");
    await matrixRows.nth(0).getByPlaceholder("名前").fill("Duplicate Source Draft");
    await matrixRows.nth(0).getByRole("button", { name: "複製", exact: true }).click();
    const duplicatedState = await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        const state = JSON.parse(node.widgets.find((widget) => widget.name === "matrix_json").value);
        const comparable = (line) => {
            const copy = JSON.parse(JSON.stringify(line));
            delete copy.row_id;
            return copy;
        };
        const actions = [...document.querySelector(".pc-popup .pc-popup-list > .pc-candidate")?.querySelectorAll("button") || []];
        const remove = actions.find((button) => button.textContent === "削除");
        return {
            source: comparable(state.sets[0]),
            duplicate: comparable(state.sets[1]),
            rowIds: state.sets.slice(0, 2).map((line) => line.row_id),
            length: state.sets.length,
            actionLabels: actions.map((button) => button.textContent),
            deleteDanger: remove?.classList.contains("pc-danger"),
            deleteStyle: remove ? {
                background: getComputedStyle(remove).backgroundColor,
                border: getComputedStyle(remove).borderTopColor,
                color: getComputedStyle(remove).color,
            } : null,
        };
    });
    assert.equal(duplicatedState.length, 3, "duplicating immediately commits the expanded Matrix state");
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount), writesBeforeDuplicate + 1, "duplicating commits once");
    assert.deepEqual(duplicatedState.source, duplicatedState.duplicate, "duplicating keeps every Matrix setting and computed prompt field");
    assert.notEqual(duplicatedState.rowIds[0], duplicatedState.rowIds[1], "duplicated Matrix rows receive a fresh row id");
    assert.deepEqual(duplicatedState.actionLabels.slice(-2), ["複製", "削除"], "duplicate precedes delete in Matrix row controls");
    assert.equal(duplicatedState.deleteDanger, true, "Matrix delete uses the danger button class");
    assert.deepEqual(duplicatedState.deleteStyle, { background: "rgb(74, 32, 38)", border: "rgb(163, 78, 90)", color: "rgb(255, 235, 238)" }, "Matrix delete has a visible danger treatment");
    await matrixRows.nth(0).getByRole("button", { name: "削除", exact: true }).hover();
    assert.deepEqual(await matrixRows.nth(0).getByRole("button", { name: "削除", exact: true }).evaluate((button) => ({
        background: getComputedStyle(button).backgroundColor,
        border: getComputedStyle(button).borderTopColor,
        color: getComputedStyle(button).color,
    })), { background: "rgb(104, 42, 52)", border: "rgb(237, 102, 119)", color: "rgb(255, 247, 248)" }, "danger hover overrides the generic button hover");
    await matrixRows.nth(0).getByPlaceholder("名前").fill("Source Changed After Duplicate");
    assert.equal(await matrixRows.nth(1).getByPlaceholder("名前").inputValue(), "Duplicate Source Draft", "duplicated Matrix drafts stay independent after source edits");
    await matrixRows.nth(1).getByRole("button", { name: "削除", exact: true }).click();
    const afterDuplicateDelete = await page.evaluate(() => JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value));
    assert.equal(afterDuplicateDelete.sets.length, 2, "deleting a duplicated Matrix row still works");
    assert.equal(afterDuplicateDelete.sets[0].name, "Source Changed After Duplicate", "editing the source after duplication does not mutate the copy");
    assert.equal(afterDuplicateDelete.sets[1].name, "Line Two", "deleting the duplicate keeps its adjacent original neighbor");

    await matrixRows.nth(0).getByPlaceholder("名前").fill("");
    await matrixRows.nth(0).getByRole("button", { name: "複製", exact: true }).click();
    const fallbackDuplicate = await page.evaluate(() => {
        const state = JSON.parse(window.__sceneMatrixTestNode.widgets.find((widget) => widget.name === "matrix_json").value);
        return { state, visibleNames: [...document.querySelectorAll('.pc-popup .pc-popup-list > .pc-candidate input[placeholder="名前"]')].map((input) => input.value) };
    });
    assert.deepEqual(fallbackDuplicate.state.sets.slice(0, 2).map((line) => line.name), ["行 1", "行 2"], "clearing then duplicating saves positional fallback names immediately");
    assert.deepEqual(fallbackDuplicate.state.sets.slice(0, 2).map((line) => line.path_label), ["行 1", "行 2"], "fallback names are also the saved Matrix path labels");
    assert.deepEqual(fallbackDuplicate.visibleNames.slice(0, 2), ["行 1", "行 2"], "the Matrix editor reloads saved fallback names after duplication");
    await matrixRows.nth(0).getByPlaceholder("名前").fill("Independent Source");
    assert.equal(await matrixRows.nth(1).getByPlaceholder("名前").inputValue(), "行 2", "fallback-named duplicates remain independently editable");

    const writesBeforeFallbackClose = await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount);
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__sceneMatrixTestNode.matrixWriteCount), writesBeforeFallbackClose + 1, "closing the independently edited Matrix source commits once");

    await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        const widget = node.widgets.find((item) => item.name === "matrix_json");
        window.__matrixOverflowOriginal = { value: widget.value, property: node.properties.scene_matrix_json, writes: node.matrixWriteCount };
        const state = JSON.parse(widget.value);
        state.sets[0].positive_base = "long_prompt_".repeat(400);
        state.sets[0].negative_base = "negative prompt, ".repeat(400);
        widget.value = JSON.stringify(state);
        node.properties.scene_matrix_json = widget.value;
        node.widgets.find((item) => item.sceneRole === "matrix_rows").callback();
    });
    for (const width of [420, 556, 760]) {
        const bounds = await page.evaluate((width) => {
            const popup = document.querySelector(".pc-popup");
            popup.style.width = `${width}px`;
            const list = popup.querySelector(".pc-popup-list");
            const row = list.querySelector(".pc-candidate");
            const rect = row.getBoundingClientRect();
            return {
                scrollWidth: list.scrollWidth, clientWidth: list.clientWidth,
                controls: [...row.querySelectorAll("button")].map((button) => {
                    const buttonRect = button.getBoundingClientRect();
                    return { text: button.textContent, inside: buttonRect.left >= rect.left && buttonRect.right <= rect.right, width: buttonRect.width };
                }),
            };
        }, width);
        assert.ok(bounds.scrollWidth <= bounds.clientWidth, `long Matrix prompts must not create horizontal overflow at ${width}px`);
        assert.equal(bounds.controls.length, 7);
        assert.ok(bounds.controls.every((button) => button.inside && button.width > 0), `all Matrix buttons fit at ${width}px: ${JSON.stringify(bounds.controls)}`);
    }
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        const original = window.__matrixOverflowOriginal;
        node.widgets.find((item) => item.name === "matrix_json").value = original.value;
        node.properties.scene_matrix_json = original.property;
        node.matrixWriteCount = original.writes;
    });

    await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode;
        const state = window.__scenePromptPopupTestHooks.readMatrixState(node);
        const widget = node.widgets.find(item => item.name === 'matrix_json');
        window.__matrixCacheSaved = { value: widget.value, property: node.properties.scene_matrix_json,
            slot: node.widgets_values[node.widgets.indexOf(widget)] };
        if (!state.sets.length) throw new Error('Matrix baseline rows missing');
        node.widgets.find(item => item.sceneRole === 'matrix_rows').callback();
    });
    while (await page.locator('.pc-popup').last().getByRole('button', { name: '削除', exact: true }).count()) {
        await page.locator('.pc-popup').last().getByRole('button', { name: '削除', exact: true }).first().click();
    }
    await page.locator('.pc-popup').last().getByRole('button', { name: '閉じる', exact: true }).click();
    const matrixCacheRoundTrip = await page.evaluate(() => {
        const node = window.__sceneMatrixTestNode, hooks = window.__scenePromptPopupTestHooks;
        const widget = node.widgets.find(item => item.name === 'matrix_json'), index = node.widgets.indexOf(widget);
        const empty = hooks.readMatrixState(node), deleted = { value: widget.value, property: node.properties.scene_matrix_json, slot: node.widgets_values[index] };
        let warm = true; for (let draw = 0; draw < 1000; draw++) warm &&= hooks.readMatrixState(node) === empty;
        const restore = saved => { widget.value = saved.value; node.properties.scene_matrix_json = saved.property; node.widgets_values[index] = saved.slot; };
        restore(window.__matrixCacheSaved); const restored = hooks.readMatrixState(node);
        restore(deleted); const redone = hooks.readMatrixState(node);
        restore(window.__matrixCacheSaved); const original = hooks.readMatrixState(node);
        node.onRemoved();
        const reloaded = new node.constructor();
        const loadedWidget = reloaded.widgets.find(item => item.name === 'matrix_json');
        loadedWidget.value = window.__matrixCacheSaved.value;
        reloaded.properties = { scene_matrix_json: window.__matrixCacheSaved.property };
        reloaded.widgets_values[reloaded.widgets.indexOf(loadedWidget)] = window.__matrixCacheSaved.slot;
        window.app.graph._nodes[window.app.graph._nodes.indexOf(node)] = reloaded;
        reloaded.onNodeCreated(); window.__sceneMatrixTestNode = reloaded;
        const loaded = hooks.readMatrixState(reloaded);
        return { empty: empty.sets.length, warm, sourcesEmpty: [deleted.value, deleted.property, deleted.slot].every(raw => JSON.parse(raw).sets.length === 0),
            restoredNames: restored.sets.map(line => line.name), redone: redone.sets.length,
            loadedNames: loaded.sets.map(line => line.name), oldReleased: node.sceneMatrixStateCache === null,
            distinct: original !== loaded, widgetOwned: reloaded.sceneMatrixStateCache.widget === loadedWidget };
    });
    assert.equal(matrixCacheRoundTrip.empty, 0); assert.equal(matrixCacheRoundTrip.sourcesEmpty, true);
    assert.equal(matrixCacheRoundTrip.warm, true, 'delete-all reuses the current empty state on warm redraws');
    assert(matrixCacheRoundTrip.restoredNames.length > 0, 'restoring pre-deletion fields reconstructs rows');
    assert.equal(matrixCacheRoundTrip.redone, 0, 'restoring the saved empty fields keeps all rows deleted');
    assert.deepEqual(matrixCacheRoundTrip.loadedNames, matrixCacheRoundTrip.restoredNames);
    assert.equal(matrixCacheRoundTrip.oldReleased, true); assert.equal(matrixCacheRoundTrip.distinct, true); assert.equal(matrixCacheRoundTrip.widgetOwned, true);
    console.log('Chromium Matrix edit/close/delete-all, direct field restoration, reload and cache release passed');

    await page.evaluate(async () => {
        class ScenePresetReferenceNode {
            constructor() {
                this.id = 5;
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
        error: document.querySelector(".pc-popup")?.textContent,
        liveNodes: window.app.graph._nodes.map((node) => ({ id: node.id, type: node.type })),
    }));
    assert.equal(editor.loadsRequested, 1);
    assert.equal(editor.loads.length, 1, JSON.stringify(editor));
    assert.deepEqual(editor.loads[0].args, [true, true, "Preset - Browser Preset"]);
    assert.notEqual(editor.loads[0].workflow.id, "stored-workflow");
    assert.match(editor.loads[0].workflow.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(editor.loads[0].workflow.extra, { stored: true });
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
        return { request: JSON.parse(save.options.body), extra: window.app.graph.extra };
    });
    assert.equal(savedEditor.request.expected_revision, undefined);
    assert.equal(savedEditor.request.workflow.extra.scene_preset_editor, undefined);
    assert.deepEqual(savedEditor.extra, { scene_preset_editor: { preset_id: "browser-preset", revision: 3 } });

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
        const desktop = new CallbackNode("ScenePromptCallbackDesktop", [
            { name: "title", type: "text", value: "完了", options: {} },
            { name: "text", type: "text", value: "{all_positive}", options: {} },
        ]);
        class ExpandNode {
            constructor(id, currentIndex, seedBase, seedBaseLiteral) {
                this.id = id;
                this.type = "ScenePrompterExpand";
                this.comfyClass = this.type;
                this.title = this.type;
                this.size = [300, 180];
                this.graph = window.app.graph;
                this.inputs = [
                    { name: "callback_first", type: "SCENE_CALLBACK", link: null },
                    { name: "callback_each", type: "SCENE_CALLBACK", link: null },
                    { name: "callback_last", type: "SCENE_CALLBACK", link: null },
                ];
                this.outputs = [];
                this.widgets = [
                    { name: "current_index", type: "number", value: currentIndex, options: {} },
                    { name: "run_id", type: "text", value: "saved-run", options: {} },
                    { name: "seed_base", type: "number", value: seedBase, options: {} },
                    { name: "timestamp_dir", type: "toggle", value: true, options: {} },
                    { name: "prefix", type: "text", value: "", options: {} },
                    { name: "counter_position", type: "combo", value: "最後", options: {} },
                    { name: "model_mode", type: "combo", value: "Illustrious", options: {} },
                    { name: "replace_underscores", type: "toggle", value: false, options: {} },
                    { name: "convert_anima_weights", type: "toggle", value: false, options: {} },
                    { name: "callback_failure_mode", type: "combo", value: "続行", options: {} },
                    { name: "seed_base_literal", type: "toggle", value: seedBaseLiteral, options: {} },
                ];
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            addCustomWidget(widget) { this.widgets.push(widget); return widget; }
            serialize() { return { widgets_values: this.widgets.map((widget) => widget.value) }; }
            configure(serialized) {
                for (const [index, value] of (serialized.widgets_values || []).entries()) {
                    this.widgets[index].value = structuredClone(value);
                }
                this.widgets_values = structuredClone(serialized.widgets_values || []);
            }
            setDirtyCanvas() {}
            setSize(size) { this.size = [...size]; }
        }
        const expand = new ExpandNode(203, 0, 0, false);
        const zeroReplayExpand = new ExpandNode(204, 0, 0, true);
        await window.__scenePromptExtension.beforeRegisterNodeDef(CallbackNode, { name: "ScenePromptCallback" });
        callback.onNodeCreated();
        await window.__scenePromptExtension.beforeRegisterNodeDef(CallbackNode, { name: "ScenePromptCallbackRequest" });
        request.onNodeCreated();
        await window.__scenePromptExtension.beforeRegisterNodeDef(CallbackNode, { name: "ScenePromptCallbackDesktop" });
        desktop.onNodeCreated();
        await window.__scenePromptExtension.beforeRegisterNodeDef(ExpandNode, { name: "ScenePrompterExpand" });
        expand.configure({ widgets_values: [15, "saved-run", 41, true, "", false, false, 10, "続行", false] });
        expand.onNodeCreated();
        zeroReplayExpand.onNodeCreated();
        window.__sceneResourceExpand = expand;
        window.app.graph._nodes.push(callback, request, desktop, expand, zeroReplayExpand);
        callback.title = "Before Matrix";
        window.__scenePromptPopupTestHooks.syncAllScenePromptNames();
        const apiPrompt = { output: {
            "201": { class_type: "ScenePromptCallback", inputs: {} },
            "202": { class_type: "ScenePromptCallbackRequest", inputs: {} },
            "203": { class_type: "ScenePromptCallbackDesktop", inputs: {} },
            "204": { class_type: "KSampler", inputs: {} },
        } };
        window.__scenePromptPopupTestHooks.applySceneSourceNodeNames(apiPrompt);
        const before = {
            callbackOutput: callback.outputs[0].type,
            callbackInputOptional: callback.inputs.find((input) => input.name === "scene_prompt").link === null,
            apiCallbackName: apiPrompt.output["201"].inputs.source_node_name,
            apiProducerName: apiPrompt.output["202"].inputs.source_node_name,
            apiDesktopName: apiPrompt.output["203"].inputs.source_node_name,
            callbackVisible: callback.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            getHiddenText: request.widgets.find((widget) => widget.name === "text").hidden,
            desktopVisible: desktop.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            desktopPermission: desktop.widgets.find((widget) => widget.sceneRole === "scene_desktop_notification_permission")?.name,
            desktopPermissionRequestsBeforeClick: window.__sceneDesktopNotificationMock.snapshot().requestCalls,
            expandCallbackInputs: expand.inputs.map((input) => ({ name: input.name, type: input.type, link: input.link })),
            expandCallbackWidgets: expand.widgets
                .filter((widget) => ["callback_timeout_seconds", "callback_failure_mode"].includes(widget.name))
                .map((widget) => ({ name: widget.name, label: widget.label, hidden: !!widget.hidden })),
            loadedReplay: ["current_index", "seed_base", "seed_base_literal", "run_id"].map((name) => expand.widgets.find((widget) => widget.name === name).value),
            loadedReplaySerialized: expand.serialize().widgets_values.slice(0, 3).concat(expand.serialize().widgets_values[10]),
            zeroReplay: ["current_index", "seed_base", "seed_base_literal", "run_id"].map((name) => zeroReplayExpand.widgets.find((widget) => widget.name === name).value),
            replaySeedLiteralHidden: zeroReplayExpand.widgets.find((widget) => widget.name === "seed_base_literal").hidden,
            zeroReplaySerialized: zeroReplayExpand.serialize().widgets_values.slice(0, 3).concat(zeroReplayExpand.serialize().widgets_values[10]),
        };
        const method = request.widgets.find((widget) => widget.name === "method");
        method.value = "POST";
        method.callback();
        window.__sceneDesktopNotificationMock.configure({ permission: "default", requestedPermission: "granted" });
        await desktop.widgets.find((widget) => widget.sceneRole === "scene_desktop_notification_permission").callback();
        return {
            ...before,
            postVisibleText: !request.widgets.find((widget) => widget.name === "text").hidden,
            requestWidgets: request.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            desktopPermissionAfterClick: desktop.widgets.find((widget) => widget.sceneRole === "scene_desktop_notification_permission")?.name,
            desktopPermissionRequestsAfterClick: window.__sceneDesktopNotificationMock.snapshot().requestCalls,
        };
    });
    assert.equal(callbackUi.callbackOutput, "SCENE_PROMPT");
    assert.equal(callbackUi.callbackInputOptional, true, "Callback accepts an unconnected first Scene input");
    assert.equal(callbackUi.apiCallbackName, undefined, "Callback itself is excluded from Scene path names");
    assert.equal(callbackUi.apiProducerName, undefined, "Callback configuration is not mistaken for a Scene-path node");
    assert.equal(callbackUi.apiDesktopName, undefined, "Desktop callback configuration is not mistaken for a Scene-path node");
    assert.deepEqual(callbackUi.callbackVisible, ["frequency", "timeout_seconds", "failure_mode"]);
    assert.equal(callbackUi.getHiddenText, true, "GET hides its unused request body");
    assert.deepEqual(callbackUi.desktopVisible, ["title", "text", "デスクトップ通知を許可"]);
    assert.equal(callbackUi.desktopPermissionRequestsBeforeClick, 0, "Desktop permission is never requested while a node is attached");
    assert.equal(callbackUi.desktopPermissionRequestsAfterClick, 1, "Desktop permission is requested only by the node button");
    assert.equal(callbackUi.desktopPermissionAfterClick, "通知：許可済み");
    assert.equal(callbackUi.postVisibleText, true, "POST restores the request body input");
    assert.deepEqual(callbackUi.requestWidgets, ["method", "url", "text", "body_type", "headers_json"]);
    assert.deepEqual(callbackUi.expandCallbackInputs, [
        { name: "callback_first", type: "SCENE_CALLBACK", link: null },
        { name: "callback_each", type: "SCENE_CALLBACK", link: null },
        { name: "callback_last", type: "SCENE_CALLBACK", link: null },
    ], "Expand registers three optional Callback sockets");
    assert.deepEqual(callbackUi.expandCallbackWidgets, [
        { name: "callback_failure_mode", label: "Callback失敗時", hidden: false },
    ], "Expand shows Japanese Callback settings");
    assert.deepEqual(callbackUi.loadedReplay, [0, 41, false, ""], "loading resets the transient saved index while preserving the seed and clearing stale run state");
    assert.deepEqual(callbackUi.loadedReplaySerialized, [0, "", 41, false], "normal replay serialization starts from the first Scene row after load");
    assert.deepEqual(callbackUi.zeroReplay, [0, 0, true, ""], "loading keeps literal seed 0 for one normal replay");
    assert.equal(callbackUi.replaySeedLiteralHidden, true, "literal seed replay state stays internal");
    assert.deepEqual(callbackUi.zeroReplaySerialized, [0, "", 0, true], "normal replay serialization keeps literal seed mode");

    await page.evaluate(() => {
        const listener = window.__scenePromptListeners.get("scene_prompt_desktop_notification");
        window.__sceneDesktopNotificationMock.configure({ permission: "granted", mode: "manual" });
        listener({ detail: { request_id: "desktop-show", title: "Scene done", text: "image ready", timeout_seconds: 1 } });
        listener({ detail: { request_id: "desktop-show", title: "duplicate", text: "must not show", timeout_seconds: 1 } });
        window.__sceneDesktopNotificationMock.emit("show");
    });
    await page.waitForFunction(() => window.__scenePromptCalls.some((call) => (
        call.url === "/scene_prompt/callbacks/desktop/ack"
        && JSON.parse(call.options.body).request_id === "desktop-show"
    )));
    const desktopShow = await page.evaluate(() => ({
        notifications: window.__sceneDesktopNotificationMock.snapshot().notifications,
        acknowledgements: window.__scenePromptCalls
            .filter((call) => call.url === "/scene_prompt/callbacks/desktop/ack")
            .map((call) => JSON.parse(call.options.body)),
        pending: window.__scenePromptPopupTestHooks.pendingDesktopNotifications(),
    }));
    assert.deepEqual(desktopShow.notifications, [{ title: "Scene done", options: { body: "image ready" } }], "duplicate targeted event creates one browser Notification");
    assert.deepEqual(desktopShow.acknowledgements, [{ request_id: "desktop-show", success: true, error: "" }], "show acknowledges success without waiting for dismissal");
    assert.equal(desktopShow.pending, 0, "shown notification is removed from bounded pending state");

    await page.evaluate(() => {
        const listener = window.__scenePromptListeners.get("scene_prompt_desktop_notification");
        window.__sceneDesktopNotificationMock.configure({ permission: "granted", mode: "error" });
        listener({ detail: { request_id: "desktop-error", title: "Error", text: "", timeout_seconds: 1 } });
    });
    await page.waitForFunction(() => window.__scenePromptCalls.some((call) => (
        call.url === "/scene_prompt/callbacks/desktop/ack"
        && JSON.parse(call.options.body).request_id === "desktop-error"
    )));
    await page.evaluate(() => {
        const listener = window.__scenePromptListeners.get("scene_prompt_desktop_notification");
        window.__sceneDesktopNotificationMock.configure({ permission: "granted", mode: "throw" });
        listener({ detail: { request_id: "desktop-throw", title: "Throw", text: "", timeout_seconds: 1 } });
        window.__sceneDesktopNotificationMock.configure({ permission: "denied", mode: "manual" });
        listener({ detail: { request_id: "desktop-denied", title: "Denied", text: "", timeout_seconds: 1 } });
        window.__sceneDesktopNotificationMock.configure({ permission: "granted", mode: "manual" });
        listener({ detail: { request_id: "desktop-timeout", title: "Timeout", text: "", timeout_seconds: 0.001 } });
        window.__sceneDesktopNotificationMock.configure({ available: false });
        listener({ detail: { request_id: "desktop-unavailable", title: "Unavailable", text: "", timeout_seconds: 1 } });
        window.__sceneDesktopNotificationMock.configure({ available: true, permission: "granted", mode: "manual" });
    });
    await page.waitForFunction(() => window.__scenePromptCalls.filter((call) => (
        call.url === "/scene_prompt/callbacks/desktop/ack"
        && ["desktop-throw", "desktop-denied", "desktop-timeout", "desktop-unavailable"].includes(JSON.parse(call.options.body).request_id)
    )).length === 4);
    const desktopFailures = await page.evaluate(() => ({
        acknowledgements: window.__scenePromptCalls
            .filter((call) => call.url === "/scene_prompt/callbacks/desktop/ack")
            .map((call) => JSON.parse(call.options.body))
            .filter((body) => body.request_id !== "desktop-show"),
        pending: window.__scenePromptPopupTestHooks.pendingDesktopNotifications(),
    }));
    assert.deepEqual(desktopFailures.acknowledgements, [
        { request_id: "desktop-error", success: false, error: "display_failed" },
        { request_id: "desktop-throw", success: false, error: "display_failed" },
        { request_id: "desktop-denied", success: false, error: "permission_denied" },
        { request_id: "desktop-unavailable", success: false, error: "unavailable" },
        { request_id: "desktop-timeout", success: false, error: "timeout" },
    ], "error, throw, denied permission, timeout, and unavailable browser each send one fixed failure acknowledgement");
    assert.equal(desktopFailures.pending, 0, "all failed desktop requests clear listeners and pending state");

    await page.evaluate(async () => {
        const originalGraphToPrompt = window.app.graphToPrompt;
        window.app.graphToPrompt = async () => ({ output: {
            "201": { class_type: "ScenePromptCallback", inputs: { callback: ["202", 0] } },
            "202": { class_type: "ScenePromptCallbackDesktop", inputs: {} },
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
    assert.equal(
        callbackPresetSave["202"].inputs.source_node_name,
        undefined,
        "Preset saving serializes Desktop callback configuration without a source node name",
    );

    await createPreparedRun(page);
    const preparedClientId = await page.evaluate(() => {
        const prepare = window.__scenePromptCalls.findLast((call) => call.url.includes("/runs/prepare"));
        return JSON.parse(prepare.options.body).client_id;
    });
    assert.equal(preparedClientId, "browser-client", "run preparation sends the originating browser client id without a node widget");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.waitForTimeout(50);
    assert.equal((await releaseCalls(page)).length, 0);

    await page.reload();
    await page.waitForFunction(() => window.__scenePromptBrowserReady === true);
    await page.evaluate(async () => {
        class RestoredLoraNode {
            constructor() {
                this.id = 43; this.type = "SceneApplyLora"; this.comfyClass = "SceneApplyLora";
                this.size = [380, 240]; this.graph = window.app.graph;
                this.inputs = [{ name: "scene_prompt", link: null }]; this.outputs = [{ name: "scene_prompt", links: [] }];
                this.widgets = [
                    { name: "lora_name", type: "combo", value: "style.safetensors", options: {} },
                    { name: "strength_model", type: "number", value: 1, options: {} },
                    { name: "strength_clip", type: "number", value: 1, options: {} },
                    { name: "model_mode", type: "combo", value: "Anima", options: {} },
                    { name: "positive", type: "text", value: "", options: {} },
                    { name: "negative", type: "text", value: "", options: {} },
                    { name: "positive_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "negative_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "category_order", type: "text", value: "", options: {} },
                ];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget); return widget;
            }
            setDirtyCanvas() {}
            setSize(size) { this.size = size; }
            serialize() { return { widgets_values: this.widgets_values }; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(RestoredLoraNode, { name: "SceneApplyLora" });
        window.__restoredLoraNode = new RestoredLoraNode();
        window.__restoredLoraNode.onNodeCreated();
    });
    assert.equal(await page.evaluate(() => window.__restoredLoraNode.widgets.some((widget) => widget.sceneRole === "lora_summary")), false);
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), 0,
        "reload restores the cached name from the cheap catalog without hashing");

    await page.evaluate(() => localStorage.removeItem("scene_prompt_lora_names_v1"));
    await page.addInitScript(() => { window.__delayNextSceneLoraList = true; });
    await page.reload();
    await page.waitForFunction(() => window.__scenePromptBrowserReady === true);
    await page.evaluate(async () => {
        class BootstrapLoraNode {
            constructor() {
                this.id = 44; this.type = "SceneApplyLora"; this.comfyClass = "SceneApplyLora";
                this.size = [380, 240]; this.graph = window.app.graph;
                this.inputs = [{ name: "scene_prompt", link: null }]; this.outputs = [{ name: "scene_prompt", links: [] }];
                this.widgets = [
                    { name: "lora_name", type: "combo", value: "style.safetensors", options: {} },
                    { name: "strength_model", type: "number", value: 1, options: {} },
                    { name: "strength_clip", type: "number", value: 1, options: {} },
                    { name: "model_mode", type: "combo", value: "Anima", options: {} },
                    { name: "positive", type: "text", value: "", options: {} },
                    { name: "negative", type: "text", value: "", options: {} },
                    { name: "positive_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "negative_json", type: "text", value: '{"version":1,"categories":{}}', options: {} },
                    { name: "category_order", type: "text", value: "", options: {} },
                ];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget); return widget;
            }
            setDirtyCanvas() {}
            setSize(size) { this.size = size; }
            serialize() { return { widgets_values: this.widgets_values }; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(BootstrapLoraNode, { name: "SceneApplyLora" });
        window.__bootstrapLoraNode = new BootstrapLoraNode();
        window.__bootstrapLoraNode.onNodeCreated();
        window.__bootstrapLoraNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback();
    });
    await page.waitForFunction(() => window.__sceneLoraListDelayed());
    await page.evaluate(() => {
        window.__delayNextSceneLoraInfo = true;
        window.__bootstrapLoraNode.widgets.find((widget) => widget.sceneRole === "lora_details").callback();
    });
    await page.waitForFunction(() => window.__sceneLoraInfoDelayed());
    await page.evaluate(() => window.__releaseSceneLoraList());
    const bootstrapPicker = page.getByRole("dialog", { name: "LoRAを選択" });
    await bootstrapPicker.locator(".pc-lora-select").filter({ hasText: "style.safetensors" }).evaluate((button) => button.click());
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?") && call.url.includes("style.safetensors")).length), 2,
        "catalog metadata creates a distinct in-flight key from the earlier path-only detail request");
    await page.evaluate(() => window.__releaseSceneLoraInfo());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]").some((entry) => entry.title === "Civitai Style"));

    const queueControls = await page.evaluate(async () => {
        class QueueNode {
            constructor() {
                this.id = 9001;
                this.type = "ScenePrompterQueue";
                this.comfyClass = "ScenePrompterQueue";
                this.size = [360, 200];
                this.graph = window.app.graph;
                this.inputs = Array.from({ length: 10 }, (_, index) =>
                    ({ name: `scene_prompt${index + 1}`, type: "SCENE_PROMPT", link: null }));
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.widgets = [
                    { name: "order_mode", type: "combo", value: "alternate", options: {} },
                    { name: "alternate_block_size", type: "number", value: 3, options: {} },
                    { name: "input_repeats_json", type: "text", value: '{"scene_prompt1":3}', options: {} },
                    { name: "downstream_count_mode", type: "combo", value: "fixed", options: {} },
                ];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget);
                return widget;
            }
            addCustomWidget(widget) { this.widgets.push(widget); return widget; }
            addInput(name, type) { this.inputs.push({ name, type, link: null }); }
            setDirtyCanvas() {}
            setSize(size) { this.size = size; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(QueueNode, { name: "ScenePrompterQueue" });
        const graph = window.app.graph;
        const previous = { id: 9002, type: "ScenePrompterQueue", inputs: [], outputs: [], graph };
        const middle = { id: 9003, type: "ScenePrompter", inputs: [{ name: "scene_prompt", link: 90002 }], outputs: [], graph };
        const queue = new QueueNode();
        graph._nodes.push(previous, middle, queue);
        graph.links = { ...(graph.links || {}), 90001: { id: 90001, origin_id: middle.id },
            90002: { id: 90002, origin_id: previous.id } };
        graph.getNodeById = (id) => graph._nodes.find((node) => String(node.id) === String(id));
        queue.onNodeCreated();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
        queue.inputs[0].link = 90001;
        queue.onConnectionsChange?.();
        const locked = queue.widgets.slice(0, 4).map((widget) =>
            ({ value: widget.value, disabled: widget.disabled, label: widget.label }));
        queue.inputs[0].link = null;
        queue.onConnectionsChange?.();
        const unlocked = queue.widgets.slice(0, 4).map((widget) =>
            ({ value: widget.value, disabled: widget.disabled }));
        queue.widgets[0].value = "alternate";
        queue.widgets[1].value = 2;
        queue.widgets[2].value = '{"scene_prompt1":4}';
        queue.widgets[3].value = "fixed";
        queue.inputs[0].link = 90001;
        window.__scenePromptExtension.afterConfigureGraph();
        const reloaded = queue.widgets.slice(0, 4).map((widget) => widget.value);
        const reference = {
            id: 9004, type: "ScenePresetReference", graph,
            inputs: [{ name: "scene_prompt", link: null }], outputs: [],
            widgets: [{ name: "preset_id", value: "queue-preset" }],
            scenePresetGraph: { api_graph: { output: {
                1: { class_type: "ScenePresetInput", inputs: {} },
                2: { class_type: "ScenePrompterQueue", inputs: {
                    scene_prompt1: ["1", 0], order_mode: "alternate", alternate_block_size: 2,
                    input_repeats_json: '{"scene_prompt1":3}', downstream_count_mode: "fixed",
                } },
                3: { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["2", 0] } },
            } } },
        };
        graph._nodes.push(reference);
        graph.links[90003] = { id: 90003, origin_id: reference.id };
        queue.inputs[0].link = 90003;
        window.__scenePromptExtension.afterConfigureGraph();
        const presetLocked = queue.widgets.slice(0, 4).map((widget) =>
            ({ value: widget.value, disabled: widget.disabled }));
        queue.onConfigure?.();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
        const reattachedLabels = queue.widgets.slice(0, 4).map((widget) => widget.label);
        reference.scenePresetGraph.api_graph.output[2] = {
            class_type: "ScenePrompter", inputs: { scene_prompt: ["1", 0], prompt_name: "plain" },
        };
        queue.widgets.find((widget) => widget.name === "input_repeats_json").value = '{"scene_prompt1":4}';
        window.__scenePromptExtension.afterConfigureGraph();
        const plainPreset = queue.widgets.slice(0, 4).map((widget) =>
            ({ value: widget.value, disabled: widget.disabled }));
        return { locked, unlocked, reloaded, presetLocked, reattachedLabels, plainPreset };
    });
    assert.deepEqual(queueControls.locked.map(({ value }) => value), ["alternate", 3, "{}", "fixed"]);
    assert.ok(queueControls.locked.filter((_, index) => index !== 2).every(({ disabled, label }) => disabled && label.includes("上流Queueあり")),
        "Queue → Scene Prompt → Queue greys the three active controls");
    assert.equal(queueControls.unlocked[0].disabled, false);
    assert.equal(queueControls.unlocked[1].disabled, false, "row repeat works in input order mode");
    assert.equal(queueControls.unlocked[3].disabled, false);
    assert.deepEqual(queueControls.unlocked.map(({ value }) => value), ["alternate", 3, "{}", "fixed"],
        "disconnect retains the Queue's own settings");
    assert.deepEqual(queueControls.reloaded, ["alternate", 2, "{}", "fixed"],
        "graph reload retains visible settings and clears only obsolete per-input repeats");
    assert.deepEqual(queueControls.presetLocked.map(({ value }) => value), ["alternate", 2, "{}", "fixed"]);
    assert.ok(queueControls.presetLocked.filter((_, index) => index !== 2).every(({ disabled }) => disabled),
        "saved Preset-internal Queue locks the active controls after rehydration");
    assert.ok(queueControls.reattachedLabels.filter((_, index) => index !== 2).every((label) => label.includes("上流Queueあり")),
        "post-load Queue reattachment preserves locked control labels");
    assert.equal(queueControls.plainPreset[2].value, "{}",
        "a Preset without an internal Queue clears obsolete per-input repeats");

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
    await page.route("**/scene_prompt/civitai/by-hash?*", (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ found: true, version: { id: 23, modelId: 12, name: "v1", model: { name: "Base Model" }, trainedWords: [] } }),
    }));
    const resourceSetup = await page.evaluate(() => {
        const node = {
            id: 230, type: "ScenePrompterExpand", title: "ScenePrompterExpand", graph: window.app.graph,
            size: [300, 180], inputs: [], outputs: [],
            widgets: [{ name: "model_mode", type: "combo", value: "Anima", options: {} }],
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options };
                this.widgets.push(widget);
                return widget;
            },
            addCustomWidget(widget) { this.widgets.push(widget); return widget; },
            serialize() { return { widgets_values: this.widgets.filter((widget) => widget.serialize !== false).map((widget) => widget.value) }; },
            setDirtyCanvas() {},
        };
        window.__sceneResourceExpand = node;
        const before = node.serialize().widgets_values.slice(0, 11);
        window.__scenePromptPopupTestHooks.ensureSceneExpandControls(node);
        window.__scenePromptPopupTestHooks.ensureSceneExpandControls(node);
        window.__sceneResourceResponse = {
            model_mode: "Anima",
            models: [
                { kind: "diffusion_model", name: "anima.safetensors", roles: ["model"], source_class: "UNETLoader" },
                { kind: "clip", name: "text-encoder.safetensors", roles: ["clip"], source_class: "CLIPLoader" },
                { kind: "vae", name: "vae.safetensors", roles: ["vae"], source_class: "VAELoader" },
            ],
            loras: [{ name: "inactive.safetensors", variants: [
                { model_mode: "Illustrious", strength_model: 0.5, strength_clip: 0.5, roles: ["model", "clip"], applies: false },
            ] }, { name: "unknown-before.safetensors", variants: [{ model_mode: null, applies: null }] },
            { name: "style.safetensors", variants: [
                { model_mode: "Illustrious", strength_model: 1, strength_clip: 1, roles: ["model", "clip"], applies: false },
                { model_mode: null, strength_model: 0.4, roles: ["model"], applies: null },
                { model_mode: "Anima", strength_model: 0.8, strength_clip: 0.6, roles: ["model", "clip"], applies: true },
                { model_mode: null, strength_model: 0.45, roles: ["model"], applies: null },
                { model_mode: "Anima", strength_model: 0.9, strength_clip: 0.7, roles: ["model", "clip"], applies: true },
            ] }, { name: "applied-peer.safetensors", variants: [{ model_mode: "Anima", strength_model: 0.2, applies: true }] },
            { name: "unknown-after.safetensors", variants: [] }],
        };
        window.__sceneResourceOriginal = JSON.stringify(window.__sceneResourceResponse);
        window.__originalResourceGraphToPrompt = window.app.graphToPrompt;
        window.app.graphToPrompt = async () => ({ output: { [node.id]: { class_type: "ScenePrompterExpand", inputs: {} } } });
        return {
            order: node.widgets.filter((widget) => ["expand_resources", "expand_run_all"].includes(widget.sceneRole)).map((widget) => widget.sceneRole),
            counts: ["expand_resources", "expand_run_all"].map((role) => node.widgets.filter((widget) => widget.sceneRole === role).length),
            serialized: node.serialize().widgets_values.slice(0, 11), before,
            infoSerialize: node.widgets.find((widget) => widget.sceneRole === "expand_resources").serialize,
        };
    });
    assert.deepEqual(resourceSetup.order, ["expand_resources", "expand_run_all"], "generation info stays directly above continuous generation");
    assert.deepEqual(resourceSetup.counts, [1, 1], "hot reload does not duplicate Expand buttons");
    assert.deepEqual(resourceSetup.serialized, resourceSetup.before, "the new button does not shift legacy saved settings");
    assert.equal(resourceSetup.infoSerialize, false, "generation info is not serialized");
    await page.evaluate(() => window.__sceneResourceExpand.widgets.find((widget) => widget.sceneRole === "expand_resources").callback());
    const resources = page.getByRole("dialog", { name: "生成情報" });
    await resources.getByText("Expand のモデル: Anima").waitFor();
    assert.equal(await resources.getByText("拡散モデル: anima.safetensors").count(), 1);
    assert.equal(await resources.getByText("CLIP: text-encoder.safetensors").count(), 1);
    assert.equal(await resources.getByText("VAE: vae.safetensors").count(), 1);
    assert.equal(await resources.getByText("style.safetensors", { exact: true }).count(), 1, "one LoRA card groups strength and mode variants");
    assert.equal(await resources.getByText(/モデル種別が異なるため適用外/u).count(), 2);
    const loraCard = resources.locator(".pc-resource-card").filter({ hasText: "style.safetensors" });
    const inactiveCard = resources.locator(".pc-resource-card").filter({ hasText: "inactive.safetensors" });
    const loraNames = await resources.locator(".pc-resource-name").allTextContents();
    assert.deepEqual(loraNames.slice(-5), ["style.safetensors", "applied-peer.safetensors", "unknown-before.safetensors", "unknown-after.safetensors", "inactive.safetensors"],
        "applicable, unknown and inapplicable cards preserve same-group order");
    assert.equal(new Set(loraNames).size, loraNames.length, "resource cards remain duplicate-free");
    const details = await loraCard.locator(".pc-resource-detail").allTextContents();
    assert.match(details[0], /モデル強度 0.8.*適用対象/u); assert.match(details[1], /モデル強度 0.9.*適用対象/u);
    assert.match(details[2], /モデル強度 0.4.*適用可否を取得不可/u); assert.match(details[3], /モデル強度 0.45.*適用可否を取得不可/u);
    assert.match(details[4], /モデル強度 1.*適用外/u);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__sceneResourceResponse) === window.__sceneResourceOriginal), true,
        "display sorting does not mutate response arrays or variants");
    assert.equal(await inactiveCard.evaluate((node) => node.classList.contains("pc-resource-unapplied")), true, "entire inapplicable LoRA row is muted");
    assert.equal(await inactiveCard.getByRole("button", { name: "Civitaiを確認" }).isEnabled(), true, "gray resource rows retain usable lookup buttons");
    assert.equal(await loraCard.evaluate((node) => node.classList.contains("pc-resource-unapplied")), false, "mixed LoRA variants preserve active row appearance");
    const inactiveVariant = loraCard.locator(".pc-resource-detail.pc-resource-unapplied");
    assert.equal(await inactiveVariant.evaluate((node) => getComputedStyle(node).color), "rgb(144, 150, 159)");
    assert.notEqual(await loraCard.locator(".pc-resource-detail:not(.pc-resource-unapplied)").first().evaluate((node) => getComputedStyle(node).color), "rgb(144, 150, 159)");
    await loraCard.getByRole("button", { name: "Civitaiを確認" }).click();
    await loraCard.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/models/hash?")).length), 0,
        "opening the modal does not hash large diffusion models");
    const modelCard = resources.locator(".pc-resource-card").filter({ hasText: "anima.safetensors" });
    await modelCard.getByRole("button", { name: "Civitaiを確認" }).click();
    await modelCard.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await modelCard.getByRole("link", { name: "Civitaiで見る" }).getAttribute("href"), "https://civitai.red/models/12?modelVersionId=23");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/models/hash?")).length), 1);
    await page.keyboard.press("Escape");
    assert.equal(await resources.count(), 0);
    await page.evaluate(() => {
        window.__sceneResourceResponse.models = [{ kind: "checkpoint", name: "illustration.safetensors", roles: ["model", "clip", "vae"], source_class: "CheckpointLoaderSimple" }];
        window.__sceneResourceExpand.widgets.find((widget) => widget.sceneRole === "expand_resources").callback();
    });
    const checkpointCard = resources.locator(".pc-resource-card").filter({ hasText: "illustration.safetensors" });
    await checkpointCard.getByText("出力: model / clip / vae").waitFor();
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/models/hash?")).length), 1,
        "checkpoint hashing also waits for its explicit confirmation");
    await checkpointCard.getByRole("button", { name: "Civitaiを確認" }).click();
    await checkpointCard.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/models/hash?")).length), 2);
    assert.equal(await page.evaluate(() => {
        const call = window.__scenePromptCalls.findLast((entry) => entry.url === "/scene_prompt/expand/resources");
        return JSON.parse(call.options.body).expand_node_id;
    }), "230", "resource discovery targets only the clicked Expand");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        window.__sceneResourceResponse.model_mode = null;
        window.__sceneResourceResponse.models = [{ kind: "diffusion_model", name: "取得不可 (#44)", unresolved: true, roles: ["model"], source_class: "UNETLoader" }];
        window.__sceneResourceResponse.loras = [{ name: "取得不可 (#45)", unresolved: true, variants: [
            { model_mode: null, strength_model: null, strength_clip: null, roles: ["model", "clip"], applies: null },
            { model_mode: null, strength_model: 0.7, strength_clip: null, roles: ["model"], applies: true },
        ] }];
        window.__sceneResourceExpand.widgets.find((widget) => widget.sceneRole === "expand_resources").callback();
    });
    await resources.getByText("Expand のモデル: 取得不可").waitFor();
    const unresolvedModel = resources.locator(".pc-resource-card").filter({ hasText: "取得不可 (#44)" });
    assert.equal(await unresolvedModel.getByText("UNETLoader のファイル名は取得できません。").count(), 1);
    assert.equal(await unresolvedModel.getByRole("button", { name: "Civitaiを確認" }).count(), 0,
        "an unresolved linked diffusion model is not hashed as a real file");
    const unresolvedLora = resources.locator(".pc-resource-card").filter({ hasText: "取得不可 (#45)" });
    assert.equal(await unresolvedLora.getByText(/モデル強度 取得不可/u).count(), 1);
    assert.equal(await unresolvedLora.getByText(/適用可否を取得不可/u).count(), 1);
    assert.equal(await unresolvedLora.getByText(/標準LoRA \/ モデル強度 0.7 \/ 適用対象/u).count(), 1,
        "an unknown linked filename does not erase a known standard LoRA mode");
    assert.equal(await unresolvedLora.getByRole("button", { name: "Civitaiを確認" }).count(), 0,
        "an unresolved linked LoRA is not mistaken for a real file");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        window.__sceneResourceResponse.model_mode = "Anima";
        window.__sceneResourceResponse.models = [{ kind: "checkpoint", name: "illustration.safetensors", roles: ["model", "clip", "vae"], source_class: "CheckpointLoaderSimple" }];
        window.__scenePromptPopupTestHooks.installSceneNodeRemovalCleanup(window.__sceneResourceExpand, "ScenePrompterExpand");
        window.__delayNextSceneModelHash = true;
        window.__sceneResourceExpand.widgets.find((widget) => widget.sceneRole === "expand_resources").callback();
    });
    await resources.getByText("Checkpoint: illustration.safetensors").waitFor();
    await resources.getByRole("button", { name: "Civitaiを確認" }).first().click();
    await page.waitForFunction(() => window.__sceneModelHashDelayed());
    await page.evaluate(() => window.__sceneResourceExpand.onRemoved());
    assert.equal(await resources.count(), 0, "removing Expand closes its resource modal");
    await page.evaluate(() => window.__releaseSceneModelHash());
    await page.waitForTimeout(50);
    assert.equal(await resources.count(), 0, "a late hash response cannot reopen a removed node's modal");
    await page.evaluate(() => { window.app.graphToPrompt = window.__originalResourceGraphToPrompt; });
    await checkFavorites(browser, `http://127.0.0.1:${address.port}/`);
    await checkProgressiveCandidates(browser, `http://127.0.0.1:${address.port}/`);
    await checkPresetSwitchModals(browser, `http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
        class RandomNode {
            constructor() {
                this.id = 9701;
                this.type = this.comfyClass = "ScenePromptRandomRoute";
                this.graph = window.app.graph;
                this.size = [260, 160];
                this.inputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }];
                this.outputs = Array.from({ length: 10 }, (_, index) => ({ name: `scene_prompt${index + 1}`, links: index < 2 ? [index + 1] : [] }));
                this.widgets = [{ name: "weights_json", type: "text", value: "[10000,0,0,0,0,0,0,0,0,0]", options: {} }];
                this.widgets_values = this.widgets.map((widget) => widget.value);
            }
            addWidget(type, name, value, callback, options = {}) {
                const widget = { type, name, value, callback, options, computeSize: () => [100, 20] };
                this.widgets.push(widget); return widget;
            }
            setDirtyCanvas() {}
            setSize(size) { this.size = size; }
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(RandomNode, { name: "ScenePromptRandomRoute" });
        window.__sceneRandomTestNode = new RandomNode();
        window.app.graph._nodes.push(window.__sceneRandomTestNode);
        window.__sceneRandomTestNode.onNodeCreated();
        window.__sceneRandomTestNode.widgets.find((widget) => widget.sceneRole === "random_settings").callback();
    });
    const randomDialog = page.getByRole("dialog", { name: "Scene Prompt Random Route Input 設定" });
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt1 の確率（%）" }).fill("60");
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt2 の確率（%）" }).fill("40");
    assert.equal(await page.evaluate(() => window.__sceneRandomTestNode.widgets[0].value), "[10000,0,0,0,0,0,0,0,0,0]",
        "editing random percentages does not mutate the saved workflow before closing");
    await randomDialog.getByRole("button", { name: "閉じる" }).click();
    assert.equal(await page.evaluate(() => window.__sceneRandomTestNode.widgets[0].value), "[6000,4000,0,0,0,0,0,0,0,0]");
    await page.evaluate(() => window.__sceneRandomTestNode.widgets.find((widget) => widget.sceneRole === "random_settings").callback());
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt2 の確率（%）" }).fill("30");
    assert.match(await randomDialog.locator(".pc-random-total").textContent(), /90\.00%/u);
    assert.ok(await randomDialog.locator(".pc-random-total").evaluate((element) => element.classList.contains("pc-random-invalid")));
    await randomDialog.getByRole("button", { name: "閉じる" }).click();
    assert.equal(await page.evaluate(() => window.__sceneRandomTestNode.widgets[0].value), "[6000,3000,0,0,0,0,0,0,0,0]",
        "an invalid sum remains saved and visibly invalid until corrected");
    assert.equal(await page.evaluate(() => window.__sceneRandomTestNode.boxcolor), "#e24c4c");
    await page.evaluate(() => window.__sceneRandomTestNode.widgets.find((widget) => widget.sceneRole === "random_settings").callback());
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt2 の確率（%）" }).fill("12.345");
    await randomDialog.getByRole("button", { name: "閉じる" }).click();
    assert.equal(await page.evaluate(() => window.__sceneRandomTestNode.widgets[0].value), "[6000,3000,0,0,0,0,0,0,0,0]",
        "malformed percentages can be discarded without trapping the modal");
    await page.evaluate(() => window.__sceneRandomTestNode.widgets.find((widget) => widget.sceneRole === "random_settings").callback());
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt1 の確率（%）" }).fill("0.29");
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt2 の確率（%）" }).fill("16.67");
    await randomDialog.getByRole("spinbutton", { name: "scene_prompt3 の確率（%）" }).fill("83.04");
    assert.match(await randomDialog.locator(".pc-random-total").textContent(), /100\.00%/u);
    await randomDialog.getByRole("button", { name: "閉じる" }).click();
    assert.equal(await page.evaluate(() => window.__sceneRandomTestNode.widgets[0].value), "[29,1667,8304,0,0,0,0,0,0,0]",
        "two-decimal percentages persist as exact integer basis points");
    await page.evaluate(() => window.__sceneRandomTestNode.widgets.find((widget) => widget.sceneRole === "random_settings").callback());
    assert.equal(await randomDialog.getByRole("spinbutton", { name: "scene_prompt1 の確率（%）" }).inputValue(), "0.29");
    assert.equal(await randomDialog.getByRole("spinbutton", { name: "scene_prompt2 の確率（%）" }).inputValue(), "16.67");
    await randomDialog.getByRole("button", { name: "閉じる" }).click();

    const llmControls = await page.evaluate(async () => {
        class Node {
            constructor(type, id) {
                this.type = this.comfyClass = this.title = type; this.id = id; this.graph = window.app.graph; this.mode = 0; this.size = [340, 300];
                this.inputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", link: null }];
                this.outputs = [{ name: "scene_prompt", type: "SCENE_PROMPT", links: [] }];
                this.widgets = Object.entries(type === "ScenePromptLLM" ? { model_mode: "Illustrious", description: "", positive: "", negative: "", generation_state_json: "{}" }
                    : { model_mode: "Illustrious", current_index: 0, run_id: "", seed_base: 0 }).map(([name, value]) => ({ name, value, type: "text", options: {} }));
            }
            addWidget(type,name,value,callback,options={}) { const widget={type,name,value,callback,options};this.widgets.push(widget);return widget; }
            addCustomWidget(widget) {this.widgets.push(widget);return widget;}
            setDirtyCanvas(){} setSize(size){this.size=size;} computeSize(){return this.size;}
        }
        class LLM extends Node { constructor(){super("ScenePromptLLM",9901);} }
        class Expand extends Node { constructor(){super("ScenePrompterExpand",9902);} }
        await window.__scenePromptExtension.beforeRegisterNodeDef(LLM,{name:"ScenePromptLLM"});
        await window.__scenePromptExtension.beforeRegisterNodeDef(Expand,{name:"ScenePrompterExpand"});
        const llm=new LLM(),expand=new Expand();window.app.graph._nodes.push(llm,expand);
        window.app.graph.getNodeById=(id)=>window.app.graph._nodes.find((node)=>String(node.id)===String(id));
        const calls=window.__scenePromptCalls.length;
        llm.onNodeCreated();expand.onNodeCreated();
        const generate=expand.widgets.find((widget)=>widget.sceneRole==="expand_llm_generate"),run=expand.widgets.find((widget)=>widget.sceneRole==="expand_run_all");
        const emptyDisabled=generate.disabled;
        llm.widgets.find((widget)=>widget.name==="description").value="a girl with a hat";
        window.app.graph.links ||= {};window.app.graph.links[9903]={id:9903,origin_id:llm.id,origin_slot:0,target_id:expand.id,target_slot:0};
        llm.outputs[0].links=[9903];expand.inputs[0].link=9903;
        expand.onNodeCreated();const reachableDisabled=generate.disabled;
        llm.mode=4;expand.onNodeCreated();const bypassDisabled=generate.disabled;
        return {emptyDisabled,reachableDisabled,bypassDisabled,order:expand.widgets.indexOf(generate)+1===expand.widgets.indexOf(run),
            noCalls:calls===window.__scenePromptCalls.length,hidden:llm.widgets.find((widget)=>widget.name==="generation_state_json").hidden,
            settingsFirst:llm.widgets[0].sceneRole==="llm_settings" && llm.widgets[0].serialize===false,
            own:llm.widgets.filter((widget)=>widget.sceneRole?.startsWith("llm_")).map((widget)=>widget.sceneRole)};
    });
    assert.deepEqual(llmControls,{emptyDisabled:true,reachableDisabled:false,bypassDisabled:true,order:true,noCalls:true,hidden:true,settingsFirst:true,own:["llm_settings","llm_generate","llm_status"]});
    const { testSnapshotRaces, testPopupFormSubmissionRaces } = await import("./scene_snapshot_races.mjs");
    await testSnapshotRaces(browser, page.url());
    await testPopupFormSubmissionRaces(browser, page.url());
    console.log("Scene Prompt browser integration tests passed.");
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolveServer) => server.close(resolveServer));
}
