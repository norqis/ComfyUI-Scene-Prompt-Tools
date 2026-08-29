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
export const app = {
  graph: { _nodes: [] },
  canvas: {},
  registerExtension(extension) { window.__scenePromptExtension = extension; },
  queuePrompt: async () => ({ prompt_id: "browser-test" }),
};
window.app = app;
`;
const apiModule = `
const listeners = new Map();
const calls = [];
export const api = {
  fetchApi: async (url, options = {}) => {
    calls.push({ url, options });
    let payload = { items: [] };
    if (url.includes("/runs/prepare")) payload = { run_handle: "browser-run" };
    if (url.includes("/runs/claim")) payload = { claimed: true };
    if (url.includes("/runs/release")) payload = { released: true };
    if (url.includes("saved_prompts")) payload = { saved_prompts: [] };
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
                1: { class_type: "ScenePrompt", inputs: {} },
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
