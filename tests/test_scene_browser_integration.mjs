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
export const app = {
  graph,
  canvas: {},
  extensionManager: { workflow: { activeWorkflow, openWorkflows: [activeWorkflow, inactiveWorkflow, workflowWithoutTracker] } },
  registerExtension(extension) {
    window.__scenePromptExtension = extension;
    for (const setting of extension.settings || []) setting.onChange?.(setting.defaultValue);
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
      mtime_ns: loraCatalog.find((item) => url.includes(encodeURIComponent(item.path)))?.mtime_ns,
    };
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
                + `  openSavePromptPopup,\n`
                + `  openCreatePromptPopup,\n`
                + `  openSearchPopup, openPromptCandidatePopup, loadFavorites, setMatrixLineDraftContext,\n`
                + `  attachMatrixTextAreaAutocomplete,\n`
                + `  syncAllScenePromptNames,\n`
                + `  applySceneSourceNodeNames,\n`
                + `  saveScenePreset,\n`
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
        window.__sceneApplyLoraRoundTrip = {
            visible: applyLora.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            labels: ["positive", "negative"].map((name) => applyLora.widgets.find((widget) => widget.name === name).label),
            saved: savedLora.widgets_values,
            restored: restoredLora.serialize().widgets_values,
            legacy: legacyLora.serialize().widgets_values,
            linked: linkedLora.serialize().widgets_values,
            copied: (() => { const copy = new SceneApplyLoraNode(); copy.onNodeCreated(); copy.configure(linkedLora.serialize()); return copy.serialize().widgets_values; })(),
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
                    { name: "model_mode", type: "combo", value: "Illustrious", options: {} },
                ];
            }
            serialize() { return { widgets_values: this.widgets.map((widget) => widget.value) }; }
            setDirtyCanvas() {}
        }
        await window.__scenePromptExtension.beforeRegisterNodeDef(ScenePromptToTextNode, { name: "ScenePromptToText" });
        const toText = new ScenePromptToTextNode();
        toText.onNodeCreated();
        toText.configure({ widgets_values: ["直前のノードのみ", 7, 12345, true] });
        const legacyRestored = toText.serialize().widgets_values;
        toText.widgets.find((widget) => widget.name === "model_mode").value = "Anima";
        const reloadedToText = new ScenePromptToTextNode();
        reloadedToText.onNodeCreated();
        reloadedToText.configure(toText.serialize());
        window.__sceneToTextLegacyRoundTrip = {
            visible: toText.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            restored: legacyRestored,
            reloaded: reloadedToText.serialize().widgets_values,
        };
        window.__sceneLoraTestNode = applyLora;
        window.__scenePromptTestNode = node;
        node.widgets.find((widget) => widget.sceneRole === "positive_open").callback();
    });
    const loraRoundTrip = await page.evaluate(() => window.__sceneApplyLoraRoundTrip);
    assert.deepEqual(loraRoundTrip.visible, ["model_mode", "LoRA", "LoRAを選択", "strength_model", "strength_clip", "詳細確認", "positive", "ポジティブ候補", "ポジティブ選択済み", "negative", "ネガティブ候補", "ネガティブ選択済み"]);
    assert.deepEqual(loraRoundTrip.labels, ["positiveテキスト", "negativeテキスト"]);
    const emptyLoraSelection = '{"version":1,"categories":{}}';
    assert.deepEqual(loraRoundTrip.saved, ["style.safetensors", 0.8, 0.7, "Anima", "(belle zzz:1.2), {blue, red|green}, Belle ZZZ extra", "bad", emptyLoraSelection, emptyLoraSelection, ""]);
    assert.deepEqual(loraRoundTrip.restored, loraRoundTrip.saved);
    assert.deepEqual(loraRoundTrip.legacy, ["old.safetensors", 0.4, 0.3, "Illustrious", "", "", emptyLoraSelection, emptyLoraSelection, ""]);
    assert.deepEqual(loraRoundTrip.linked, ["linked.safetensors", 0.6, 0.5, null, "front", "back", emptyLoraSelection, emptyLoraSelection, ""]);
    assert.deepEqual(loraRoundTrip.copied, loraRoundTrip.linked);
    const toTextLegacy = await page.evaluate(() => window.__sceneToTextLegacyRoundTrip);
    assert.deepEqual(toTextLegacy.visible, ["scope", "model_mode"]);
    assert.deepEqual(toTextLegacy.restored, ["直前のノードのみ", 7, 12345, true, "Illustrious"],
        "legacy four-value To Text workflows retain index and seed and use the default model");
    assert.deepEqual(toTextLegacy.reloaded, ["直前のノードのみ", 7, 12345, true, "Anima"],
        "a selected fifth value round-trips without shifting legacy values");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.some((call) => call.url.startsWith("/scene_prompt/loras/info?"))), false);
    await page.route("https://civitai.com/api/v1/model-versions/by-hash/*", (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ id: 20, modelId: 10, name: "Version One", model: { name: "Civitai Style" }, trainedWords: ["Belle ZZZ", "Civitai Tag", "Belle"] }),
    }));
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback());
    const loraPicker = page.getByRole("dialog", { name: "LoRAを選択" });
    await loraPicker.getByRole("button", { name: /style\.safetensors/u }).waitFor();
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), 0,
        "opening the picker reads only the cheap local catalog");
    await loraPicker.getByRole("searchbox", { name: "パス・名前で検索" }).fill("folder/");
    assert.equal(await loraPicker.locator(".pc-lora-row").count(), 1, "path search narrows the list");
    await loraPicker.getByRole("searchbox", { name: "パス・名前で検索" }).fill("Local Style");
    assert.equal(await loraPicker.locator(".pc-lora-row").count(), 1, "display-name search narrows the list");
    await loraPicker.locator(".pc-lora-row").click();
    await page.waitForFunction(() => window.__sceneLoraTestNode.sceneLoraSummary?.title === "Civitai Style");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), 1);
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.serialize().widgets_values[0]), "style.safetensors",
        "the execution value stays the relative file path");
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_details").callback());
    const loraDialog = page.getByRole("dialog", { name: "LoRA 詳細確認" });
    await loraDialog.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await loraDialog.getByRole("link", { name: "Civitaiで見る" }).getAttribute("href"),
        "https://civitai.com/models/10?modelVersionId=20");
    assert.equal(await loraDialog.locator(".pc-lora-word").count(), 4, "local and Civitai words are deduplicated");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), 1,
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
    await loraPicker.getByRole("button", { name: /style\.safetensors/u }).waitFor();
    assert.equal(await loraPicker.locator(".pc-lora-row").first().locator(".pc-lora-title").textContent(), "Local Style",
        "changed file metadata invalidates the Civitai display name");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), 1,
        "refreshing the catalog does not hash files");
    await loraPicker.locator(".pc-lora-row").first().click();
    await page.waitForFunction(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length === 2);
    await page.waitForFunction(() => window.__sceneLoraTestNode.sceneLoraSummary.title === "Civitai Style");
    await page.route("https://civitai.com/api/v1/model-versions/by-hash/*", (route) => route.fulfill({ status: 503, body: "offline" }), { times: 1 });
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback());
    const offlineLookup = page.waitForResponse((response) => response.url().includes("/model-versions/by-hash/") && response.status() === 503);
    await loraPicker.getByRole("button", { name: /other\.safetensors/u }).click();
    await offlineLookup;
    await page.waitForFunction(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length === 3);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scene_prompt_lora_names_v1") || "[]").some((entry) => entry.key.startsWith("folder/other.safetensors") && !entry.title));
    assert.equal(await page.evaluate(() => window.__sceneLoraTestNode.sceneLoraSummary.title), "Other Local", "offline Civitai uses labelled local title");
    await page.evaluate(() => window.__sceneLoraTestNode.widgets.find((widget) => widget.sceneRole === "lora_select").callback());
    await loraPicker.getByRole("button", { name: /other\.safetensors/u }).click();
    await page.waitForFunction(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length === 4);
    await page.waitForFunction(() => window.__sceneLoraTestNode.sceneLoraSummary.title === "Civitai Style");
    assert.equal(await page.evaluate(() => window.__scenePromptCalls.filter((call) => call.url.startsWith("/scene_prompt/loras/info?")).length), 4,
        "offline name lookup retries on a later selection");
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
    await checkFavorites(browser, `http://127.0.0.1:${address.port}/`);
    console.log("Scene Prompt browser integration tests passed.");
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolveServer) => server.close(resolveServer));
}
