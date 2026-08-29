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
export const api = {
  fetchApi: async (url) => new Response(JSON.stringify(url.includes("saved_prompts") ? { saved_prompts: [] } : { items: [] }), { status: 200 }),
  queuePrompt: async () => ({ prompt_id: "browser-test" }),
  addEventListener() {},
};
window.api = api;
`;
const index = `<!doctype html><script type="module">
  import { injectStyle } from "/extensions/scene-prompt/web/scene_prompt_style.js";
  import "/extensions/scene-prompt/web/scene_prompt_ui.js";
  injectStyle();
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
    console.log("Scene Prompt browser integration tests passed.");
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolveServer) => server.close(resolveServer));
}
