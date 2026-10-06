import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { parseSelectionState } from "../web/scene_prompt_state.js";

if (process.env.RUN_REAL_COMFYUI_BROWSER_SMOKE !== "1") {
    console.log("real ComfyUI browser smoke skipped");
    process.exit(0);
}

const source = resolve(process.env.COMFYUI_SOURCE || "");
const python = process.env.COMFYUI_PYTHON;
assert.ok(python, "COMFYUI_PYTHON is required for the real ComfyUI browser smoke.");
assert.ok(source, "COMFYUI_SOURCE is required for the real ComfyUI browser smoke.");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const harnessSource = await readFile(fileURLToPath(import.meta.url), "utf8");
for (const match of harnessSource.matchAll(/'(\{"version":1,"categories":.+?\})'/gu)) parseSelectionState(match[1]);

async function freePort() {
    const server = http.createServer();
    await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    const { port } = server.address();
    await new Promise((resolveServer) => server.close(resolveServer));
    return port;
}

async function waitForServer(url, child, output) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`ComfyUI stopped before starting.\n${output.join("").slice(-4000)}`);
        }
        try {
            const response = await fetch(`${url}/object_info`);
            const objects = await response.json();
            if (response.ok && objects.ScenePrompter) {
                return;
            }
        } catch (_error) {
        }
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
    }
    throw new Error(`ComfyUI did not start.\n${output.join("").slice(-4000)}`);
}

const directory = await mkdtemp(resolve(tmpdir(), "scene-prompt-browser-"));
const nodeDirectory = resolve(directory, "custom_nodes", "scene-prompt-tools-browser-smoke");
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const output = [];
let child;
let browser;
let gpuProvider;
let gpuLoaded = true;
const gpuEvents = [];
try {
    gpuProvider = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        gpuEvents.push({ path: request.url, method: request.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/v1/status") return response.end(JSON.stringify({ service: "strata", loaded: gpuLoaded, model: "gpu-fixture", activity: { in_flight: 0 } }));
        if (request.url === "/v1/unload") { gpuLoaded = false; return response.end(JSON.stringify({ status: "unloaded" })); }
        if (request.url === "/image_started") return response.end("{}");
        if (request.url === "/v1/chat/completions") {
            gpuLoaded = true;
            return response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ positive: "fixture prompt", negative: "fixture exclusion", lora_queries: [] }) } }] }));
        }
        response.writeHead(404); response.end("{}");
    });
    await new Promise((done) => gpuProvider.listen(0, "127.0.0.1", done));
    const gpuProviderUrl = `http://127.0.0.1:${gpuProvider.address().port}`;
    await mkdir(dirname(nodeDirectory), { recursive: true });
    await cp(root, nodeDirectory, {
        recursive: true,
        filter: (entry) => ![".git", ".venv", ".venv-http", ".venv-test", ".venv-audit", "node_modules", "__pycache__", ".pytest_cache", "test-results"].includes(entry.split(/[\\/]/u).at(-1)),
    });
    const fixtureLoras = resolve(directory, "models", "loras");
    await mkdir(fixtureLoras, { recursive: true });
    const header = Buffer.from('{"__metadata__":{}}'.padEnd(24, " "));
    const headerLength = Buffer.alloc(8); headerLength.writeBigUInt64LE(BigInt(header.length));
    await writeFile(resolve(fixtureLoras, "runtime-hat.safetensors"), Buffer.concat([headerLength, header]));
    const localBytes = Buffer.concat([headerLength, header, Buffer.from('local')]);
    const unknownBytes = Buffer.concat([headerLength, header, Buffer.from('unknown')]);
    const localHash = createHash('sha256').update(localBytes).digest('hex');
    const unknownHash = createHash('sha256').update(unknownBytes).digest('hex');
    await writeFile(resolve(fixtureLoras, "runtime-local.safetensors"), localBytes);
    await writeFile(resolve(fixtureLoras, "runtime-unknown.safetensors"), unknownBytes);
    for (const [folder, name] of [["checkpoints", "runtime-checkpoint"], ["diffusion_models", "runtime-diffusion"], ["text_encoders", "runtime-clip"], ["vae", "runtime-vae"]]) {
        const path = resolve(directory, "models", folder);
        await mkdir(path, { recursive: true });
        await writeFile(resolve(path, `${name}.safetensors`), Buffer.concat([headerLength, header]));
    }
    // Keep actual standard node schemas and classes; mark their execution entry
    // points before any file/tensor load. A regression can never load real weights.
    const markerDirectory = resolve(directory, "custom_nodes", "scene-runtime-load-markers");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(resolve(markerDirectory, "__init__.py"), `import nodes
import importlib
from aiohttp import web
import json
import urllib.request
from server import PromptServer
executions = []
gpu_checks = False
empty_generate = nodes.EmptyImage.generate
def checked_empty_image(self, *args, **kwargs):
    if gpu_checks:
        with urllib.request.urlopen("${gpuProviderUrl}/v1/status") as response:
            state = json.load(response)
        if state["loaded"]:
            raise RuntimeError("Image execution began before the LLM was released")
        request = urllib.request.Request("${gpuProviderUrl}/image_started", data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request) as response:
            response.read()
    return empty_generate(self, *args, **kwargs)
nodes.EmptyImage.generate = checked_empty_image
@PromptServer.instance.routes.post("/scene_test/gpu_checks")
async def set_gpu_checks(request):
    global gpu_checks
    gpu_checks = (await request.json()).get("enabled") is True
    return web.json_response({"enabled": gpu_checks})
for name in ("CheckpointLoaderSimple", "UNETLoader", "CLIPLoader", "VAELoader", "LoraLoader"):
    node_type = nodes.NODE_CLASS_MAPPINGS[name]
    def marked(self, *args, _name=name, **kwargs):
        executions.append(_name)
        raise RuntimeError("Prompt generation attempted model execution: " + _name)
    setattr(node_type, node_type.FUNCTION, marked)
@PromptServer.instance.routes.get("/scene_test/model_executions")
async def model_executions(request):
    return web.json_response(executions)
lookup_calls = []
@PromptServer.instance.routes.post("/scene_test/civitai_lookup")
async def civitai_lookup(request):
    fixture = await request.json()
    package = nodes.NODE_CLASS_MAPPINGS["SceneApplyLora"].__module__.rsplit(".", 1)[0]
    civitai = importlib.import_module(package + ".civitai")
    async def api_get(path, params=None, *, missing_ok=False, host="civitai.red"):
        lookup_calls.append({"path": path, "missing_ok": missing_ok, "host": host})
        if fixture.get("mode") == "picker":
            if path.endswith("${localHash}"):
                return civitai._NOT_FOUND
            if path.endswith("${unknownHash}"):
                raise civitai.ServiceError("Metadata fixture offline")
        if fixture.get("mode") == "fallback" and host == "civitai.red":
            raise civitai.ServiceError("Red fixture offline")
        if fixture.get("mode") == "error":
            raise civitai.ServiceError("Metadata fixture offline")
        if fixture.get("mode") == "missing":
            return civitai._NOT_FOUND
        return {"id": 23, "modelId": 12, "name": "Fixture v1", "model": {"name": "Native metadata"},
                "trainedWords": ["native_metadata_trigger"], "private_upstream_field": "omitted"}
    civitai.api_get = api_get
    return web.json_response({"calls": lookup_calls})
NODE_CLASS_MAPPINGS = {}
`);
    child = spawn(python, [
        "main.py",
        "--cpu",
        "--listen", "127.0.0.1",
        "--port", String(port),
        "--disable-auto-launch",
        "--base-directory", directory,
        "--database-url", "sqlite:///:memory:",
    ], { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    await waitForServer(url, child, output);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    const seedRequests = [];
    const llmRequests = [];
    const settingsRequests = [];
    const runRequests = [], resourceRequests = [], metadataRequests = [], directCivitaiRequests = [];
    let nativeRunChecks = false;
    page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/\/scene_prompt\/(?:expand\/resources|loras\/info|models\/)/u.test(path)) resourceRequests.push(path);
        if (path.endsWith("/civitai/by-hash")) metadataRequests.push({ url: request.url(), method: request.method() });
        if (/^https:\/\/civitai\.(?:com|red)\//u.test(request.url())) directCivitaiRequests.push(request.url());
    });
    let deferredGeneration;
    let failNextGeneration = false;
    let nativeGPUChecks = false;
    const nativeGPURequests = [], nativeResourceRequests = [];
    page.on("request", (request) => {
        const path = new URL(request.url()).pathname.replace(/^\/api/u, "");
        if (nativeGPUChecks && /\/scene_prompt\/(?:gpu\/|llm\/(?:begin|end|generate|select_loras))/u.test(path)) {
            nativeResourceRequests.push({ path, body: request.postDataJSON() });
        }
    });
    const runtimeCandidate = { model_id: 100, version_id: 200, file_id: 300, name: "Runtime Hat", version_name: "v1", base_model: "Illustrious",
        file_name: "runtime-hat.safetensors", size_kb: 1000, sha256: "a".repeat(64), triggers: ["runtime_hat"], stats: { thumbsUpCount: 10 }, acquired: true, lora_name: "runtime-hat.safetensors" };
    await page.route("**/scene_prompt/llm/**", async (route) => {
        if (nativeGPUChecks) return route.continue();
        const path = new URL(route.request().url()).pathname.replace(/^\/api/u, "");
        if (path.endsWith("/settings")) { settingsRequests.push(path); return route.continue(); }
        if (path.endsWith("/test")) { settingsRequests.push(path); return route.fulfill({ json: { ok: true, models: [{ id: "settings-fixture" }] } }); }
        const body = route.request().postDataJSON();
        llmRequests.push({ path, body });
        if (path.endsWith("/generate")) {
            if (failNextGeneration) {
                failNextGeneration = false;
                return route.fulfill({ status: 503, json: { error: "Runtime retry fixture" } });
            }
            if (deferredGeneration) { const gate = deferredGeneration; gate.started(); await gate.pending; }
            return route.fulfill({ json: { positive: "1girl, hat", negative: "blurry", lora_queries: ["hat"], template_version: "scene-llm-v1" } });
        }
        if (path.endsWith("/select_loras")) return route.fulfill({ json: { selected: [{ model_id: 100, version_id: 200, file_id: 300 }] } });
        throw new Error(`Unexpected LLM runtime request ${path}`);
    });
    let nativeCivitaiGallery = false;
    await page.route("**/scene_prompt/civitai/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/u, "");
        if (path.endsWith("/settings")) { settingsRequests.push(path); return route.continue(); }
        if (path.endsWith("/by-hash")) return route.continue();
        llmRequests.push({ path, body: route.request().method() === "POST" ? route.request().postDataJSON() : null });
        if (path.endsWith("/search")) {
            const preview = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="400"%3E%3Crect width="300" height="400" fill="%23366387"/%3E%3Ccircle cx="150" cy="160" r="80" fill="%23b3d9c4"/%3E%3C/svg%3E';
            const items = nativeCivitaiGallery ? Array.from({length:12}, (_, index) => ({ ...runtimeCandidate, model_id:100+index, name:'Native LoRA '+(index+1), image_url:preview,
                gallery:[{url:preview,width:300,height:400},{url:preview,width:300,height:400},{url:preview,width:300,height:400}], description:'<p>Native model description</p>',
                version_description:'Native version notes', published_at:'2026-08-02', model_stats:{downloadCount:90}, version_stats:{downloadCount:12} })) : [runtimeCandidate];
            return route.fulfill({ json: { items, query: "hat", sort: "Most Downloaded" } });
        }
        if (path.endsWith("/download")) return route.fulfill({ json: { candidate: runtimeCandidate, lora_name: runtimeCandidate.lora_name } });
        throw new Error(`Unexpected Civitai runtime request ${path}`);
    });
    await page.route("**/prompt", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        if (nativeGPUChecks) { nativeGPURequests.push(route.request().postDataJSON()); return route.continue(); }
        seedRequests.push(route.request().postDataJSON());
        await route.fulfill({ json: { prompt_id: `seed-test-${seedRequests.length}`, number: 0, node_errors: {} } });
    });
    await page.route("**/scene_prompt/runs/**", (route) => {
        runRequests.push(route.request().url());
        if (nativeRunChecks) return route.continue();
        return route.fulfill({ json: { run_handle: "seed-runtime-test", claimed: true, released: true } });
    });
    await page.route("**/scene_prompt_ui.js", async (route) => {
        const response = await route.fetch();
        const sourceUI = (await response.text()).replace("onError: showAPIError,", "onError: (error, query, retry) => { window.__sceneLLMRuntimeError = error.stack; showAPIError(error, query, retry); },");
        await route.fulfill({ response, body: `${sourceUI}
window.__sceneSeedRuntimeTest = {
    llmWidgets(node) {
        const names = ["model_mode", "description", "positive", "negative", "generation_state_json"];
        return { firstRole: node.widgets[0]?.sceneRole, settingsCount: node.widgets.filter(widget => widget.sceneRole === "llm_settings").length,
            settingsSerialize: node.widgets.find(widget => widget.sceneRole === "llm_settings")?.serialize,
            names: node.widgets.filter(widget => names.includes(widget.name)).map(widget => widget.name), values: node.serialize().widgets_values };
    },
    updateLLMExpand(node) { updateSceneExpandButton(node); },
    countStats(node) { return scenePromptStats(node); },
    sourceKey(node) { return scenePromptSourceCacheKey(node); },
    latentConfig(node) { return sceneEmptyLatentConfig(node); },
    matrixState(node) { return readMatrixState(node); },
    commitMatrixDrafts(node, drafts) { return commitMatrixLineDrafts(node, drafts); },
    async presetAdapter(definition) { const { createPresetGraph } = await import("./scene_llm_presets.js"); return createPresetGraph(definition, app.graph); },
    async splicePresetLoras(graph, id, candidates) {
        const { insertLoras } = await import("./scene_prompt_llm.js");
        return insertLoras(graph, graph.getNodeById(id), candidates, (type) => globalThis.LiteGraph.createNode(type));
    },
    countPreview(node) { return sceneSchedulePrefix(sceneScheduleForNode(node), 40).map(entry => entry.parts.join("")); },
    presetSourceSnapshot() { return JSON.stringify([...scenePresetDisplayGraphs]); },
    tracker() { return sceneActiveWorkflow()?.changeTracker; },
    openCandidatePicker(id) { return openPromptCandidatePopup(app.graph.getNodeById(id), ["Modal Undo Runtime"], { stateWidgetName: "positive_json" }); },
    reloadCandidateItems() { return loadPromptItems(true); },
    writeSelection(node, state) { return writeState(node, state, { stateWidgetName: "positive_json" }); },
    async refreshPresetReference(node) { await loadScenePresetList(true); refreshScenePresetReference(node); },
    async openFavoritePicker(favorites = false) {
        const node = window.LiteGraph.createNode("ScenePrompter");
        window.app.graph.add(node);
        if (favorites) {
            await openSearchPopup(node, { favorites: true, stateWidgetName: "positive_json" });
            return null;
        }
        const [item] = await loadPromptItems();
        if (!item) throw new Error("The isolated package has no prompt candidates");
        await openPromptCandidatePopup(node, itemPath(item), { stateWidgetName: "positive_json" });
        return { key: itemKey(item), selection: findWidget(node, "positive_json").value, nodeId: node.id };
    },
    async readFavorites() { return (await api.getUserData(FAVORITES_USER_DATA_FILE)).json(); },
    async queueBatch(node) {
        const run = createSceneBatchRun(node, 3);
        try {
            run.firstPromptSnapshot = await run.promptCapturePromise;
            if (!run.firstPromptSnapshot) throw run.promptCaptureError;
            run.firstApiPending = true;
            sceneBatchRun = run;
            await queueSingleScenePrompt();
            if (!run.cachedPrompt) throw new Error("Missing cached prompt");
            for (let index = 1; index < 3; index += 1) {
                run.nextIndex = index;
                run.currentSeed = 1000 + index;
                await queueSingleScenePrompt();
            }
        } finally {
            sceneBatchRun = null;
            sceneBatchRunsById.delete(run.runId);
            resetSceneExpandRunControls(node, { mark: false });
        }
    },
};` });
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForFunction(
        () => window.LiteGraph?.registered_node_types?.ScenePrompter && window.app?.graph,
        null,
        { timeout: 30_000 },
    );
    await page.keyboard.press("Escape");
    const screenshotDirectory = process.env.SCENE_BROWSER_SCREENSHOTS_DIR || resolve(tmpdir(), 'scene-prompt-civitai-review');
    await mkdir(screenshotDirectory, { recursive: true });
    if (process.env.SCENE_NATIVE_SWITCH_ONLY !== '1') {
    nativeGPUChecks = true;
    try {
        const snapshot = () => page.evaluate(async () => {
            const { app } = await import("/scripts/app.js");
            return ["ScenePrompt.ReleaseComfyBeforeLLM", "ScenePrompt.ReleaseLLMBeforeImage"].map((id) => app.extensionManager.setting.get(id));
        });
        const setGPU = (llm, image) => page.evaluate(async ({ llm, image }) => {
            const { app } = await import("/scripts/app.js");
            await app.extensionManager.setting.set("ScenePrompt.ReleaseComfyBeforeLLM", llm);
            await app.extensionManager.setting.set("ScenePrompt.ReleaseLLMBeforeImage", image);
        }, { llm, image });
        assert.deepEqual(await snapshot(), [false, false], "native GPU settings default independently off");
        await setGPU(true, true);
        await setGPU(true, false);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForFunction(() => window.LiteGraph?.registered_node_types?.ScenePrompter && window.app?.graph);
        assert.deepEqual(await snapshot(), [true, false], "native setting values survive browser reload");
        const storedGPUSettings = JSON.parse(await readFile(resolve(directory, "user", "default", "comfy.settings.json"), "utf8"));
        assert.equal(storedGPUSettings["ScenePrompt.ReleaseComfyBeforeLLM"], true);
        assert.equal(storedGPUSettings["ScenePrompt.ReleaseLLMBeforeImage"], false);
        assert.equal(nativeResourceRequests.length, 0, "setting registration, changes and reload do not touch resources");
        const originalConnection = await page.evaluate(async () => {
            const { api } = await import("/scripts/api.js");
            return (await api.fetchApi("/scene_prompt/llm/settings")).json();
        });
        await page.evaluate(async ({ baseUrl, port }) => {
            const { api } = await import("/scripts/api.js");
            const response = await api.fetchApi("/scene_prompt/llm/settings", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ base_url: baseUrl, port, model: "gpu-fixture", api_key: "" }) });
            if (!response.ok) throw new Error(JSON.stringify(await response.json()));
        }, { baseUrl: "http://127.0.0.1/v1", port: gpuProvider.address().port });
        const modulePath = await page.evaluate(async () => {
            const { api } = await import("/scripts/api.js");
            return (await api.getExtensions()).find((path) => path.endsWith("/scene_prompt_ui.js")).replace("scene_prompt_ui.js", "scene_prompt_gpu.js");
        });
        const promptOperation = await page.evaluate(async () => {
            const { app } = await import("/scripts/app.js"); app.graph.clear();
            const target = window.LiteGraph.createNode("ScenePromptLLM"); app.graph.add(target);
            target.widgets.find((widget) => widget.name === "description").value = "native controlled prompt";
            await target.widgets.find((widget) => widget.sceneRole === "llm_generate").callback();
            return { positive: target.widgets.find((widget) => widget.name === "positive").value,
                state: JSON.stringify(target.serialize()), status: target.sceneLLMStatus };
        });
        assert.equal(promptOperation.positive, "fixture prompt", promptOperation.status);
        assert.deepEqual(nativeResourceRequests.map(({ path }) => path),
            ["/scene_prompt/llm/begin", "/scene_prompt/llm/generate", "/scene_prompt/llm/end"], "native HTTP controls surround one actual UI prompt operation");
        assert(nativeResourceRequests[1].body.session_id);
        assert.equal(nativeResourceRequests[1].body.session_id, nativeResourceRequests[2].body.session_id);
        assert.doesNotMatch(promptOperation.state, /session_id|scene_gpu_policy/);
        assert.equal(gpuLoaded, true, "prompt completion keeps the mock LLM loaded");
        assert.equal(gpuEvents.filter(({ path }) => path.endsWith("/unload")).length, 0);
        await setGPU(false, true);
        await fetch(`${url}/scene_test/gpu_checks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
        const queueImage = (color) => page.evaluate(async (color) => {
            const { api } = await import("/scripts/api.js");
            return api.queuePrompt(0, { output: {
                1: { class_type: "EmptyImage", inputs: { width: 16, height: 16, batch_size: 1, color } },
                2: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "gpu-browser-fixture" } },
            }, workflow: { nodes: [], links: [], extra: {} } });
        }, color);
        const imageResult = await queueImage(0);
        async function completedHistory(promptId) {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const history = await page.evaluate(async (promptId) => {
                    const { api } = await import("/scripts/api.js");
                    return (await api.fetchApi(`/history/${promptId}`)).json();
                }, promptId);
                if (history[promptId]?.status) return history;
                await new Promise((done) => setTimeout(done, 100));
            }
            throw new Error(`Native GPU image did not complete: ${promptId}\n${output.join("").slice(-4000)}`);
        }
        const imageHistory = await completedHistory(imageResult.prompt_id);
        assert.equal(imageHistory[imageResult.prompt_id].status.status_str, "success", JSON.stringify(imageHistory));
        const policyId = nativeGPURequests.at(-1).extra_data.scene_gpu_policy;
        assert(policyId, "official api.queuePrompt puts the opaque policy into the actual /prompt request");
        assert.doesNotMatch(JSON.stringify(nativeGPURequests.at(-1).extra_data.extra_pnginfo), /scene_gpu_policy/);
        assert(!JSON.stringify(imageHistory).includes(policyId), "private policy is stripped before history retains the prompt");
        assert.doesNotMatch(JSON.stringify(imageHistory), /scene_gpu_policy/);
        assert.deepEqual(gpuEvents.filter(({ path }) => ["/v1/unload", "/image_started"].includes(path)).map(({ path }) => path),
            ["/v1/unload", "/image_started"], "LLM release is confirmed before the first image node executes");
        // A policy prepared from a previously captured ON setting survives OFF.
        const capturedPolicy = await page.evaluate(async (modulePath) => {
            const { app } = await import("/scripts/app.js"); const { api } = await import("/scripts/api.js");
            const { createGPUController } = await import(modulePath);
            const resources = createGPUController({ app, api });
            const captured = resources.snapshot();
            await app.extensionManager.setting.set("ScenePrompt.ReleaseLLMBeforeImage", false);
            const policyId = await resources.prepareImage(captured, { continuous: true });
            await resources.releaseImage(policyId);
            return !!policyId;
        }, modulePath);
        assert.equal(capturedPolicy, true, "an ON FIFO snapshot can prepare after the setting changes to OFF");
        const resourceCount = nativeResourceRequests.length, providerCount = gpuEvents.length;
        gpuLoaded = true;
        await fetch(`${url}/scene_test/gpu_checks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
        const offResult = await queueImage(1);
        const offHistory = await completedHistory(offResult.prompt_id);
        assert.equal(offHistory[offResult.prompt_id].status.status_str, "success");
        assert(!nativeGPURequests.at(-1).extra_data.scene_gpu_policy);
        assert.equal(nativeResourceRequests.length, resourceCount, "native OFF queue adds no resource-control requests");
        assert.equal(gpuEvents.length, providerCount, "native OFF queue never touches the provider resource API");
        await setGPU(false, false);
        await page.evaluate(async (connection) => {
            const { api } = await import("/scripts/api.js");
            await api.fetchApi("/scene_prompt/llm/settings", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ base_url: connection.base_url, port: connection.port ?? "", model: connection.model, api_key: "" }) });
            window.app.graph.clear();
        }, originalConnection);
        console.log("real ComfyUI native GPU settings persistence, prompt control, scoped POST policy, release-before-image and OFF compatibility passed");
    } finally { nativeGPUChecks = false; }
    if (process.env.COMFYUI_WORKFLOW_PNG) {
        const extracted = spawnSync(python, [
            "-c",
            "from PIL import Image; import sys; im=Image.open(sys.argv[1]); sys.stdout.write(im.text['workflow'])",
            process.env.COMFYUI_WORKFLOW_PNG,
        ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
        assert.equal(extracted.status, 0, extracted.stderr || "Could not extract workflow metadata from PNG.");
        const workflow = JSON.parse(extracted.stdout);
        const pngBase64 = (await readFile(process.env.COMFYUI_WORKFLOW_PNG)).toString("base64");
        const savedExpand = workflow.nodes.find((node) => node.type === "ScenePrompterExpand" || node.type === "Scene Prompt Expand");
        const savedWidgets = savedExpand?.widgets_values || [];
        const hasCounter = ["先頭", "最後"].includes(savedWidgets[5])
            || (savedWidgets[5] == null && savedExpand?.inputs?.some((input) => input.name === "counter_position"));
        const hasCurrentMode = hasCounter && (["Illustrious", "Anima"].includes(savedWidgets[6])
            || (savedWidgets[6] == null && savedExpand?.inputs?.some((input) => input.name === "model_mode")));
        const expectedConversionOptions = hasCounter
            ? savedWidgets.slice(hasCurrentMode ? 7 : 6, hasCurrentMode ? 9 : 8)
            : ["Illustrious", "Anima"].includes(savedWidgets[5])
                ? [savedWidgets[5] === "Anima", savedWidgets[5] === "Anima"]
                : savedWidgets.slice(5, 7);
        const dropResult = await page.evaluate(async ({ content, name, expectedNodes }) => {
            const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
            const file = new File([bytes], name, { type: "image/png" });
            if (typeof window.app.handleFile !== "function") {
                return {
                    error: "window.app.handleFile is unavailable",
                    fileMethods: Object.keys(window.app).filter((key) => key.toLowerCase().includes("file")),
                };
            }
            try {
                let settled = false;
                Promise.resolve(window.app.handleFile(file)).finally(() => { settled = true; });
                const deadline = Date.now() + 15_000;
                while ((window.app.graph?._nodes?.length || 0) !== expectedNodes && Date.now() < deadline) {
                    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
                }
                const expandNode = window.app.graph?._nodes?.find(
                    (node) => node.type === "ScenePrompterExpand" || node.type === "Scene Prompt Expand",
                );
                const prompt = await window.app.graphToPrompt();
                return {
                    nodes: window.app.graph?._nodes?.length || 0,
                    settled,
                    conversionOptions: [
                        expandNode?.widgets?.find((widget) => widget.name === "replace_underscores")?.value,
                        expandNode?.widgets?.find((widget) => widget.name === "convert_anima_weights")?.value,
                    ],
                    modelMode: expandNode?.widgets?.find((widget) => widget.name === "model_mode")?.value,
                    currentIndex: expandNode?.widgets?.find((widget) => widget.name === "current_index")?.value,
                    promptCurrentIndex: prompt.output?.[String(expandNode?.id)]?.inputs?.current_index,
                };
            } catch (error) {
                return {
                    error: error?.stack || error?.message || String(error),
                    bodyText: document.body.innerText.slice(0, 5000),
                    dialogs: [...document.querySelectorAll('[role="dialog"], .p-dialog, .p-confirmdialog')].map((element) => ({
                        className: element.className,
                        text: element.innerText,
                    })),
                    overlays: [...document.querySelectorAll('.p-component-overlay, .p-dialog-mask')].map((element) => element.className),
                };
            }
        }, { content: pngBase64, name: basename(process.env.COMFYUI_WORKFLOW_PNG), expectedNodes: workflow.nodes.length });
        assert.equal(dropResult.error, undefined, `${dropResult.error}\n${JSON.stringify(dropResult, null, 2)}`);
        assert.equal(dropResult.nodes, workflow.nodes.length, "drag-style PNG loading must restore every node");
        if (expectedConversionOptions.length === 2 && expectedConversionOptions.every((value) => typeof value === "boolean")) {
            assert.deepEqual(dropResult.conversionOptions, expectedConversionOptions, "drag-style PNG loading must preserve Expand conversion options");
        }
        assert.ok(["Illustrious", "Anima"].includes(dropResult.modelMode), "Expand restores a model selector");
        assert.equal(dropResult.currentIndex, 0, "PNG loading resets a transient Expand cursor to its first Scene row");
        assert.equal(dropResult.promptCurrentIndex, 0, "normal Queue after PNG loading serializes the first Scene row");
        assert.deepEqual(pageErrors, [], `PNG handling raised browser errors:\n${pageErrors.join("\n")}`);
        console.log(`real ComfyUI PNG handleFile passed (${dropResult.nodes} nodes)`);

        const loadResult = await page.evaluate(async (savedWorkflow) => {
            try {
                const started = performance.now();
                await Promise.race([
                    window.app.loadGraphData(savedWorkflow),
                    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("loadGraphData timed out")), 15_000)),
                ]);
                const loadMilliseconds = performance.now() - started;
                const expandNode = window.app.graph?._nodes?.find(
                    (node) => node.type === "ScenePrompterExpand" || node.type === "Scene Prompt Expand",
                );
                const prompt = await window.app.graphToPrompt();
                return {
                    loadMilliseconds,
                    nodes: window.app.graph?._nodes?.length || 0,
                    currentIndex: expandNode?.widgets?.find((widget) => widget.name === "current_index")?.value,
                    promptCurrentIndex: prompt.output?.[String(expandNode?.id)]?.inputs?.current_index,
                };
            } catch (error) {
                return { error: error?.stack || error?.message || String(error) };
            }
        }, workflow);
        assert.equal(loadResult.error, undefined, loadResult.error);
        assert.equal(loadResult.nodes, workflow.nodes.length, "the PNG workflow must load every serialized node");
        assert.equal(loadResult.currentIndex, 0, "JSON workflow loading resets a transient Expand cursor to its first Scene row");
        assert.equal(loadResult.promptCurrentIndex, 0, "normal Queue after JSON workflow loading serializes the first Scene row");
        assert.deepEqual(pageErrors, [], `workflow load raised browser errors:\n${pageErrors.join("\n")}`);
        assert.equal(llmRequests.length, 0, "legacy PNG loading never calls LLM or Civitai services");
        console.log(`real ComfyUI PNG workflow load passed (${loadResult.nodes} nodes, ${loadResult.loadMilliseconds.toFixed(1)} ms, no LLM/Civitai calls)`);
    }
    const result = await page.evaluate(() => {
        const names = ["filename_enabled", "positive_base", "positive_json", "negative_base", "negative_json", "category_order", "seed", "randomize", "run_handle"];
        const values = [true, "positive, {A|B}", '{"version":1,"categories":{"Outfit":[{"prompt":"summer","label":"Summer"}]}}', "negative", '{"version":1,"categories":{"Mood":[{"prompt":"calm","label":"Calm"}]}}', "Outfit", 99, false, "new run"];
        const legacyNames = ["prompt_name", "positive_base", "positive_json", "negative_base", "negative_json", "category_order", "seed", "control_after_generate", "randomize", "run_handle"];
        const legacyValues = ["v0.3 name", "v0.3 positive, {A|B}", '{"version":1,"categories":{"Legacy":[{"label":"Legacy positive","prompt":"old positive"}]}}', "v0.3 negative", '{"version":1,"categories":{"Legacy":[{"label":"Legacy negative","prompt":"old negative"}]}}', "Outfit", 77, "randomize", false, "v0.3 run"];
        const node = window.LiteGraph.createNode("ScenePrompter");
        window.app.graph.add(node);
        const setValue = (name, value) => {
            const widget = node.widgets.find((candidate) => candidate.name === name);
            if (!widget) throw new Error(`missing widget: ${name}`);
            widget.value = value;
        };
        names.forEach((name, index) => setValue(name, values[index]));
        const serialized = node.serialize();
        const restored = window.LiteGraph.createNode("ScenePrompter");
        window.app.graph.add(restored);
        restored.configure(serialized);
        const legacy = { widgets_values: [...legacyValues] };
        const legacyRestored = window.LiteGraph.createNode("ScenePrompter");
        window.app.graph.add(legacyRestored);
        legacyRestored.configure(legacy);
        const legacyAfterFirst = Object.fromEntries(legacyNames.map((name) => {
            const widget = legacyRestored.widgets.find((candidate) => candidate.name === name);
            return [name, widget?.value];
        }));
        legacyRestored.configure(legacy);
        return {
            top: node.widgets[0]?.name,
            serialized: serialized.widgets_values,
            values: Object.fromEntries(names.map((name) => {
                const widget = restored.widgets.find((candidate) => candidate.name === name);
                return [name, widget?.value];
            })),
            legacyInput: legacy.widgets_values,
            legacyAfterFirst,
            legacy: Object.fromEntries(legacyNames.map((name) => {
                const widget = legacyRestored.widgets.find((candidate) => candidate.name === name);
                return [name, widget?.value];
            })),
            legacyFilename: legacyRestored.widgets.find((candidate) => candidate.name === "filename_enabled")?.value,
        };
    });
    assert.equal(result.top, "filename_enabled");
    assert.ok(Array.isArray(result.serialized), "the real LGraphNode must use positional widget values");
    assert.deepEqual(result.values, {
        filename_enabled: true,
        positive_base: "positive, {A|B}",
        positive_json: '{"version":1,"categories":{"Outfit":[{"prompt":"summer","label":"Summer"}]}}',
        negative_base: "negative",
        negative_json: '{"version":1,"categories":{"Mood":[{"prompt":"calm","label":"Calm"}]}}',
        category_order: "Outfit",
        seed: 99,
        randomize: false,
        run_handle: "new run",
    });
    assert.deepEqual(result.legacyInput, ["v0.3 name", "v0.3 positive, {A|B}", '{"version":1,"categories":{"Legacy":[{"label":"Legacy positive","prompt":"old positive"}]}}', "v0.3 negative", '{"version":1,"categories":{"Legacy":[{"label":"Legacy negative","prompt":"old negative"}]}}', "Outfit", 77, "randomize", false, "v0.3 run"]);
    assert.deepEqual(result.legacy, {
        prompt_name: "v0.3 name",
        positive_base: "v0.3 positive, {A|B}",
        positive_json: '{"version":1,"categories":{"Legacy":[{"label":"Legacy positive","prompt":"old positive"}]}}',
        negative_base: "v0.3 negative",
        negative_json: '{"version":1,"categories":{"Legacy":[{"label":"Legacy negative","prompt":"old negative"}]}}',
        category_order: "Outfit",
        seed: 77,
        control_after_generate: "randomize",
        randomize: false,
        run_handle: "v0.3 run",
    });
    assert.deepEqual(result.legacyAfterFirst, result.legacy, "a second configure must not alter v0.3 values");
    assert.equal(result.legacyFilename, false);
    console.log("real ComfyUI LGraphNode legacy choice widget round-trip passed");
    const loraErrors = [];
    page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("Sceneノードの初期化に失敗しました")) {
            loraErrors.push(message.text());
        }
    });
    const oldLora = await page.evaluate(async () => {
        const app = window.app;
        const results = [];
        for (const withNamed of [false, true]) {
            app.graph.clear();
            const node = window.LiteGraph.createNode("SceneApplyLora");
            app.graph.add(node);
            const workflow = app.graph.serialize();
            const saved = workflow.nodes.find((entry) => String(entry.id) === String(node.id));
            saved.widgets_values = ["style.safetensors", null, null, "Illustrious", "Yuzu Soft style", ""];
            if (withNamed) {
                saved.widgets_values_named = {
                    lora_name: "style.safetensors", strength_model: null, strength_clip: null,
                    model_mode: "Illustrious", positive: "Yuzu Soft style", negative: "",
                };
            } else {
                delete saved.widgets_values_named;
            }
            await app.loadGraphData(workflow, true, true);
            const restored = app.graph.getNodeById(node.id);
            const read = (name) => restored.widgets.find((widget) => widget.name === name)?.value;
            const serialized = restored.serialize();
            results.push({ withNamed, positive: read("positive"), positiveJson: read("positive_json"),
                strengthModel: read("strength_model"), strengthClip: read("strength_clip"),
                savedPositive: serialized.widgets_values_named?.positive });
        }
        return results;
    });
    for (const item of oldLora) {
        assert.equal(item.positive, "Yuzu Soft style", `old six-widget LoRA positive must load (named=${item.withNamed})`);
        assert.equal(JSON.parse(item.positiveJson).version, 1, "old positive text must not shift into selection JSON");
        assert.equal(item.savedPositive, "Yuzu Soft style");
        assert.equal(item.strengthModel, null);
        assert.equal(item.strengthClip, null);
    }
    assert.deepEqual(loraErrors, [], "old Scene Apply LoRA workflow must not log an initialization failure");
    console.log("real ComfyUI six-widget Scene Apply LoRA workflow load passed");
    const conversionRoundTrips = await page.evaluate(() => {
        const make = () => {
            const node = window.LiteGraph.createNode("ScenePrompterExpand");
            window.app.graph.add(node);
            return node;
        };
        const read = (node) => Object.fromEntries([
            "counter_position", "model_mode", "replace_underscores", "convert_anima_weights",
            "callback_failure_mode", "seed_base_literal",
        ].map((name) => [name, node.widgets.find((widget) => widget.name === name)?.value]));
        const results = [];
        for (const underscores of [false, true]) {
            for (const weights of [false, true]) {
                const node = make();
                node.widgets.find((widget) => widget.name === "replace_underscores").value = underscores;
                node.widgets.find((widget) => widget.name === "convert_anima_weights").value = weights;
                const restored = make();
                restored.configure(node.serialize());
                results.push({ expected: [underscores, weights], actual: read(restored) });
            }
        }
        const legacyResults = [];
        for (const timeout of [0, 13, false, true]) {
            for (const controls of [["Anima"], [true, true], ["先頭", true, true]]) {
                const old = make();
                const legacy = { ...old.serialize(), widgets_values: [0, "", 7, true, "prefix", ...controls, timeout, "停止", true] };
                const original = [...legacy.widgets_values];
                old.configure(legacy);
                const migrated = read(old);
                old.configure(legacy);
                const restoredLegacy = make();
                restoredLegacy.configure(old.serialize());
                legacyResults.push({ timeout, controls, migrated, repeated: read(old), reloaded: read(restoredLegacy),
                    original, after: legacy.widgets_values,
                    obsoleteExists: old.widgets.some((widget) => widget.name === "callback_timeout_seconds") });
            }
        }
        return { results, legacyResults };
    });
    for (const result of conversionRoundTrips.results) {
        assert.deepEqual([result.actual.replace_underscores, result.actual.convert_anima_weights], result.expected);
    }
    for (const legacy of conversionRoundTrips.legacyResults) {
        const migratedOptions = { counter_position: legacy.controls[0] === "先頭" ? "先頭" : "最後",
            model_mode: legacy.controls[0] === "Anima" ? "Anima" : "Illustrious",
            replace_underscores: true, convert_anima_weights: true, callback_failure_mode: "停止", seed_base_literal: true };
        assert.deepEqual(legacy.migrated, migratedOptions);
        assert.deepEqual(legacy.repeated, migratedOptions);
        assert.deepEqual(legacy.reloaded, migratedOptions);
        assert.deepEqual(legacy.after, legacy.original, "legacy input is never mutated");
        assert.equal(legacy.obsoleteExists, false);
    }
    console.log("real ComfyUI Expand options and legacy Callback/replay widget migration passed");
    const modelModes = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const expand = window.LiteGraph.createNode("ScenePrompterExpand");
        const lora = window.LiteGraph.createNode("SceneApplyLora");
        app.graph.add(expand);
        app.graph.add(lora);
        const contract = {
            expandWidgets: expand.widgets.map((widget) => widget.name).filter((name) => !name.startsWith("scene_")),
            loraWidgets: lora.widgets.map((widget) => widget.name),
            visible: [expand, lora].map((node) => !node.widgets.find((widget) => widget.name === "model_mode").hidden),
        };
        const linked = [];
        for (const legacy of [true, false]) {
            app.graph.clear();
            const node = window.LiteGraph.createNode("ScenePrompterExpand");
            const primitive = window.LiteGraph.createNode("PrimitiveNode");
            app.graph.add(node);
            app.graph.add(primitive);
            const workflow = app.graph.serialize();
            const stored = workflow.nodes.find((item) => String(item.id) === String(node.id));
            stored.inputs = stored.inputs.filter((input) => input.name !== "model_mode" && (!legacy || input.name !== "counter_position"));
            stored.widgets_values = legacy
                ? [0, "", 7, false, "", null, 13, "停止", true]
                : [0, "", 7, false, "", "最後", null, false, true, "停止", true];
            const slot = stored.inputs.length;
            const link = workflow.last_link_id + 1;
            stored.inputs.push({ name: "model_mode", type: "COMBO", link, widget: { name: "model_mode" } });
            workflow.links.push([link, primitive.id, 0, node.id, slot, "COMBO"]);
            workflow.last_link_id = link;
            const sourceNode = workflow.nodes.find((item) => String(item.id) === String(primitive.id));
            sourceNode.outputs[0] = { ...sourceNode.outputs[0], name: "COMBO", type: "COMBO", links: [link] };
            sourceNode.widgets_values = ["Anima"];
            const original = JSON.stringify(stored);
            await app.loadGraphData(workflow, true, true);
            await new Promise((resolve) => setTimeout(resolve, 250));
            const first = await app.graphToPrompt();
            const saved = app.graph.serialize();
            await app.loadGraphData(saved, true, true);
            await new Promise((resolve) => setTimeout(resolve, 250));
            const second = await app.graphToPrompt();
            const restored = app.graph.getNodeById(node.id);
            linked.push({ legacy, first: first.output[String(node.id)].inputs, second: second.output[String(node.id)].inputs,
                sameInput: JSON.stringify(stored) === original,
                literal: restored.widgets.find((widget) => widget.name === "seed_base_literal").value,
                linked: restored.inputs.find((input) => input.name === "model_mode")?.link != null });
        }
        return { contract, linked };
    });
    assert.deepEqual(modelModes.contract.expandWidgets.slice(0, 11), ["current_index", "run_id", "seed_base", "timestamp_dir", "prefix",
        "counter_position", "model_mode", "replace_underscores", "convert_anima_weights", "callback_failure_mode", "seed_base_literal"]);
    assert.deepEqual(modelModes.contract.loraWidgets, ["model_mode", "LoRAを選択", "strength_model", "strength_clip", "詳細確認",
        "positive", "ポジティブ候補", "ポジティブ選択済み", "negative", "ネガティブ候補", "ネガティブ選択済み",
        "lora_name", "positive_json", "negative_json", "category_order"]);
    assert.deepEqual(modelModes.contract.visible, [true, true]);
    for (const result of modelModes.linked) {
        for (const inputs of [result.first, result.second]) {
            assert.equal(inputs.model_mode, "Anima");
            assert.equal(inputs.replace_underscores, false);
            assert.equal(inputs.convert_anima_weights, !result.legacy);
        }
        assert.equal(result.sameInput, true);
        assert.equal(result.literal, true);
        assert.equal(result.linked, true);
    }
    console.log("real ComfyUI model widgets and linked old/current model mode round trips passed");
    const toTextMigration = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const text = window.LiteGraph.createNode("ScenePromptToText");
        const scene = window.LiteGraph.createNode("ScenePrompter");
        const primitive = window.LiteGraph.createNode("PrimitiveNode");
        app.graph.add(text);
        app.graph.add(scene);
        app.graph.add(primitive);
        scene.connect(0, text, text.inputs.findIndex((input) => input.name === "scene_prompt"));
        const workflow = app.graph.serialize();
        const saved = workflow.nodes.find((node) => String(node.id) === String(text.id));
        saved.widgets_values = ["直前のノードのみ", 7, 12345, true, "Anima"];
        saved.widgets_values_named = { model_mode: "Anima" };
        const slot = saved.inputs.length;
        const linkId = workflow.last_link_id + 1;
        saved.inputs.push({ name: "model_mode", type: "COMBO", link: linkId, widget: { name: "model_mode" } });
        workflow.links.push([linkId, primitive.id, 0, text.id, slot, "COMBO"]);
        workflow.last_link_id = linkId;
        const savedPrimitive = workflow.nodes.find((node) => String(node.id) === String(primitive.id));
        savedPrimitive.outputs[0] = { ...savedPrimitive.outputs[0], type: "COMBO", links: [linkId] };
        await app.loadGraphData(workflow, true, true);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const restored = app.graph.getNodeById(text.id);
        const first = app.graph.serialize().nodes.find((node) => String(node.id) === String(text.id));
        const api = await app.graphToPrompt();
        await app.loadGraphData(app.graph.serialize(), true, true);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const second = app.graph.getNodeById(text.id);
        return {
            first: first.widgets_values,
            second: app.graph.serialize().nodes.find((node) => String(node.id) === String(text.id)).widgets_values,
            inputs: restored.inputs.map((input) => input.name),
            secondInputs: second.inputs.map((input) => input.name),
            visible: second.widgets.filter((widget) => !widget.hidden).map((widget) => widget.name),
            apiInputs: api.output[String(text.id)]?.inputs,
        };
    });
    assert.deepEqual(toTextMigration.first, ["直前のノードのみ", 7, 12345, true]);
    assert.deepEqual(toTextMigration.second, toTextMigration.first);
    assert.deepEqual(toTextMigration.inputs, ["scene_prompt", "scope", "current_index", "seed_base", "seed_base_literal"]);
    assert.deepEqual(toTextMigration.secondInputs, toTextMigration.inputs);
    assert.deepEqual(toTextMigration.visible, ["scope"]);
    assert.equal(toTextMigration.apiInputs?.model_mode, undefined);
    console.log("real ComfyUI legacy To Text model input and widget migration passed");
    const linkedTimeoutResults = await page.evaluate(async () => {
        const app = window.app;
        const results = [];
        for (const timeout of [13, null]) {
            app.graph.clear();
            const make = (type) => {
                const node = window.LiteGraph.createNode(type);
                app.graph.add(node);
                return node;
            };
            const scene = make("ScenePrompter");
            const expand = make("ScenePrompterExpand");
            const callback = make("ScenePromptCallbackDesktop");
            const primitive = make("PrimitiveNode");
            scene.connect(0, expand, expand.inputs.findIndex((input) => input.name === "scene_prompt"));
            callback.connect(0, expand, expand.inputs.findIndex((input) => input.name === "callback_first"));
            const workflow = app.graph.serialize();
            const savedExpand = workflow.nodes.find((node) => String(node.id) === String(expand.id));
            if (!savedExpand) throw new Error(JSON.stringify({ expected: expand.id, nodes: workflow.nodes.map(({ id, type }) => ({ id, type })) }));
            savedExpand.widgets_values = [0, "", 0, true, "prefix", "最後", true, false, timeout, "停止", true];
            const timeoutSlot = savedExpand.inputs.findIndex((input) => input.name === "callback_first");
            const timeoutLink = workflow.last_link_id + 1;
            savedExpand.inputs.splice(timeoutSlot, 0, { name: "callback_timeout_seconds", type: "FLOAT", link: timeoutLink, widget: { name: "callback_timeout_seconds" } });
            for (const link of workflow.links) {
                if (link[3] === expand.id && link[4] >= timeoutSlot) link[4] += 1;
            }
            workflow.links.push([timeoutLink, primitive.id, 0, expand.id, timeoutSlot, "FLOAT"]);
            workflow.last_link_id = timeoutLink;
            const savedPrimitive = workflow.nodes.find((node) => String(node.id) === String(primitive.id));
            savedPrimitive.outputs[0] = { ...savedPrimitive.outputs[0], name: "FLOAT", type: "FLOAT", links: [timeoutLink] };
            savedPrimitive.widgets_values = [13, "fixed"];
            await app.loadGraphData(workflow, true, true);
            await new Promise((resolve) => setTimeout(resolve, 350));
            const restored = app.graph.getNodeById(expand.id);
            const apiGraph = await app.graphToPrompt();
            const restoredWorkflow = app.graph.serialize();
            results.push({
                timeout,
                inputs: restored.inputs.map((input) => input.name),
                values: Object.fromEntries(["callback_failure_mode", "seed_base_literal"].map((name) => [name, restored.widgets.find((widget) => widget.name === name)?.value])),
                apiInputs: apiGraph.output[String(expand.id)].inputs,
                expectedScene: [String(scene.id), 0], expectedCallback: [String(callback.id), 0],
                timeoutLinkExists: !!app.graph.links[timeoutLink],
                savedInputExists: restoredWorkflow.nodes.find((node) => String(node.id) === String(expand.id)).inputs.some((input) => input.name === "callback_timeout_seconds"),
                linksAligned: Object.values(app.graph.links).filter((link) => link.target_id === expand.id).every((link) => restored.inputs[link.target_slot]?.link === link.id),
            });
        }
        return results;
    });
    for (const result of linkedTimeoutResults) {
        assert.equal(result.inputs.includes("callback_timeout_seconds"), false);
        assert.equal(result.savedInputExists, false);
        assert.equal(result.timeoutLinkExists, false);
        assert.equal(result.linksAligned, true);
        assert.deepEqual(result.values, { callback_failure_mode: "停止", seed_base_literal: true });
        assert.equal(result.apiInputs.callback_timeout_seconds, undefined);
        assert.deepEqual(result.apiInputs.scene_prompt, result.expectedScene);
        assert.deepEqual(result.apiInputs.callback_first, result.expectedCallback);
    }
    console.log("real ComfyUI linked legacy timeout removal preserves surviving links and replay values");

    const failureModeInputRoundTrips = await page.evaluate(async () => {
        const app = window.app;
        const results = [];
        for (const [legacyTimeout, linkedCounter] of [[false, false], [true, false], [false, true], [true, true]]) {
            app.graph.clear();
            const expand = window.LiteGraph.createNode("ScenePrompterExpand");
            const failureSource = window.LiteGraph.createNode("PrimitiveNode");
            app.graph.add(expand);
            app.graph.add(failureSource);
            const workflow = app.graph.serialize();
            const stored = workflow.nodes.find((node) => String(node.id) === String(expand.id));
            stored.widgets_values = [0, "", 0, true, "prefix", linkedCounter ? null : "最後", false, false, ...(legacyTimeout ? [null] : []), null, true];
            let failureSlot = stored.inputs.findIndex((input) => input.name === "callback_failure_mode");
            if (failureSlot < 0) {
                failureSlot = stored.inputs.length;
                stored.inputs.push({ name: "callback_failure_mode", type: "COMBO", widget: { name: "callback_failure_mode" } });
            }
            const failureLink = workflow.last_link_id + 1;
            stored.inputs[failureSlot].link = failureLink;
            workflow.links.push([failureLink, failureSource.id, 0, expand.id, failureSlot, "COMBO"]);
            workflow.last_link_id = failureLink;
            const storedSource = workflow.nodes.find((node) => String(node.id) === String(failureSource.id));
            storedSource.outputs[0] = { ...storedSource.outputs[0], name: "COMBO", type: "COMBO", links: [failureLink] };
            storedSource.widgets_values = ["停止"];
            if (legacyTimeout) {
                const timeoutSource = window.LiteGraph.createNode("PrimitiveNode");
                app.graph.add(timeoutSource);
                const storedTimeoutSource = timeoutSource.serialize();
                const timeoutSlot = stored.inputs.length;
                const timeoutLink = failureLink + 1;
                stored.inputs.push({ name: "callback_timeout_seconds", type: "FLOAT", link: timeoutLink, widget: { name: "callback_timeout_seconds" } });
                storedTimeoutSource.outputs[0] = { ...storedTimeoutSource.outputs[0], name: "FLOAT", type: "FLOAT", links: [timeoutLink] };
                storedTimeoutSource.widgets_values = [13, "fixed"];
                workflow.nodes.push(storedTimeoutSource);
                workflow.links.push([timeoutLink, timeoutSource.id, 0, expand.id, timeoutSlot, "FLOAT"]);
                workflow.last_link_id = timeoutLink;
                workflow.last_node_id = app.graph.last_node_id;
            }
            if (linkedCounter) {
                const counterSource = window.LiteGraph.createNode("PrimitiveNode");
                app.graph.add(counterSource);
                const storedCounterSource = counterSource.serialize();
                const counterSlot = stored.inputs.findIndex((input) => input.name === "counter_position");
                if (counterSlot < 0) throw new Error("Missing native counter_position input");
                const counterLink = workflow.last_link_id + 1;
                stored.inputs[counterSlot].link = counterLink;
                storedCounterSource.outputs[0] = { ...storedCounterSource.outputs[0], name: "COMBO", type: "COMBO", links: [counterLink] };
                storedCounterSource.widgets_values = ["先頭"];
                workflow.nodes.push(storedCounterSource);
                workflow.links.push([counterLink, counterSource.id, 0, expand.id, counterSlot, "COMBO"]);
                workflow.last_link_id = counterLink;
                workflow.last_node_id = app.graph.last_node_id;
            }
            const originalValues = [...stored.widgets_values];
            await app.loadGraphData(workflow, true, true);
            await new Promise((resolve) => setTimeout(resolve, 350));
            const restored = app.graph.getNodeById(expand.id);
            const first = restored.serialize();
            const apiGraph = await app.graphToPrompt();
            const savedWorkflow = app.graph.serialize();
            await app.loadGraphData(savedWorkflow, true, true);
            await new Promise((resolve) => setTimeout(resolve, 350));
            const reloaded = app.graph.getNodeById(expand.id);
            const reloadedApi = await app.graphToPrompt();
            results.push({
                legacyTimeout, linkedCounter, originalValues, inputAfterLoad: stored.widgets_values,
                firstValues: first.widgets_values,
                reloadedValues: reloaded.serialize().widgets_values,
                literalSeed: reloaded.widgets.find((widget) => widget.name === "seed_base_literal").value,
                literalIndex: reloaded.widgets.findIndex((widget) => widget.name === "seed_base_literal"),
                failureMode: apiGraph.output[String(expand.id)].inputs.callback_failure_mode,
                reloadedFailureMode: reloadedApi.output[String(expand.id)].inputs.callback_failure_mode,
                counterPosition: reloadedApi.output[String(expand.id)].inputs.counter_position,
                failureLinked: reloaded.inputs.find((input) => input.name === "callback_failure_mode")?.link != null,
                timeoutInputExists: reloaded.inputs.some((input) => input.name === "callback_timeout_seconds"),
            });
        }
        return results;
    });
    for (const result of failureModeInputRoundTrips) {
        assert.equal(result.originalValues.length, result.legacyTimeout ? 11 : 10);
        assert.equal(result.originalValues.at(-2), null, "linked failure widgets may be stored as null");
        assert.deepEqual(result.inputAfterLoad, result.originalValues, "loading does not rewrite the source workflow");
        assert.equal(result.firstValues.length, 11, "Expand has no trailing serializable UI controls");
        assert.equal(result.firstValues[10], true);
        assert.equal(result.reloadedValues.length, 11);
        assert.equal(result.reloadedValues[10], true);
        assert.equal(result.literalSeed, true);
        assert.equal(result.literalIndex, 10);
        assert.equal(result.failureMode, "停止");
        assert.equal(result.reloadedFailureMode, "停止");
        assert.equal(result.counterPosition, result.linkedCounter ? "先頭" : "最後");
        assert.equal(result.failureLinked, true);
        assert.equal(result.timeoutInputExists, false);
    }
    console.log("real ComfyUI linked failure-mode widgets preserve current/legacy null layouts and literal seed round trips");

    await page.evaluate(() => window.app.graph.clear());
    await page.evaluate(async () => {
        const response = await fetch("/scene_prompt/items", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: "Favorites Runtime", name: "Runtime favorite", prompt: "runtime favorite prompt", description: "Isolated browser fixture" }),
        });
        if (!response.ok) throw new Error(await response.text());
    });
    const favorite = await page.evaluate(() => window.__sceneSeedRuntimeTest.openFavoritePicker());
    await page.waitForFunction((key) => [...document.querySelectorAll(".pc-favorite")].some((button) => button.dataset.favoriteKey === key && !button.disabled), favorite.key);
    await page.locator(".pc-favorite").evaluateAll((buttons, key) => buttons.find((button) => button.dataset.favoriteKey === key).click(), favorite.key);
    await page.waitForFunction((key) => [...document.querySelectorAll(".pc-favorite")].some((button) => button.dataset.favoriteKey === key && button.getAttribute("aria-pressed") === "true"), favorite.key);
    assert.deepEqual(await page.evaluate(() => window.__sceneSeedRuntimeTest.readFavorites()), [favorite.key], "the real userdata endpoint stores the favorite");
    assert.equal(await page.evaluate((id) => window.app.graph.getNodeById(id).widgets.find((widget) => widget.name === "positive_json").value, favorite.nodeId), favorite.selection);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__sceneSeedRuntimeTest && window.app?.graph && window.LiteGraph?.registered_node_types?.ScenePrompter);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__sceneSeedRuntimeTest.openFavoritePicker(true));
    await page.waitForFunction((key) => [...document.querySelectorAll(".pc-favorite")].some((button) => button.dataset.favoriteKey === key && button.getAttribute("aria-pressed") === "true"), favorite.key);
    assert.equal(await page.locator(".pc-candidate").count(), 1);
    await page.locator(".pc-popup").getByRole("button", { name: "閉じる", exact: true }).click();
    console.log("real ComfyUI userdata favorite persistence survives a page reload");
    const applyModelInputOrder = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const scene = window.LiteGraph.createNode("ScenePrompter");
        const applyModel = window.LiteGraph.createNode("SceneApplyModel");
        app.graph.add(scene);
        app.graph.add(applyModel);
        const inputIndex = applyModel.inputs.findIndex((input) => input.name === "scene_prompt");
        scene.connect(0, applyModel, inputIndex);
        const workflow = app.graph.serialize();
        const applyModelId = applyModel.id;
        const sceneId = scene.id;
        await app.loadGraphData(workflow, true, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const restored = app.graph.getNodeById(applyModelId);
        const link = Object.values(app.graph.links).find((candidate) => (
            candidate.origin_id === sceneId && candidate.target_id === applyModelId
        ));
        return {
            created: applyModel.inputs.map((input) => input.name),
            restored: restored.inputs.map((input) => input.name),
            targetSlot: link?.target_slot,
        };
    });
    assert.deepEqual(applyModelInputOrder.created, ["scene_prompt", "model", "clip", "vae"]);
    assert.deepEqual(applyModelInputOrder.restored, ["scene_prompt", "model", "clip", "vae"]);
    assert.equal(applyModelInputOrder.targetSlot, 0, "restored Scene link follows reordered input slot");
    console.log("real ComfyUI Scene Apply Model input order passed");
    const bypassPreset = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const create = (type) => {
            const node = window.LiteGraph.createNode(type);
            app.graph.add(node);
            return node;
        };
        const input = create("ScenePresetInput");
        const prompt = create("ScenePrompter");
        const reverse = create("ScenePromptReverse");
        const output = create("ScenePresetOutput");
        const connect = (source, target) => source.connect(0, target, target.inputs.findIndex((slot) => slot.name === "scene_prompt"));
        connect(input, prompt);
        connect(prompt, reverse);
        connect(reverse, output);
        reverse.mode = 4;
        output.widgets.find((widget) => widget.name === "preset_id").value = "runtime-bypass";
        const apiGraph = await app.graphToPrompt();
        if (apiGraph.output[String(reverse.id)]) throw new Error("ComfyUI should bypass Reverse in API graph");
        const workflow = app.graph.serialize();
        const response = await fetch("/scene_presets/save", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: "runtime-bypass", name: "Runtime Bypass", output_node_id: String(output.id), api_graph: apiGraph, workflow }),
        });
        const saved = await response.json();
        if (!response.ok) throw new Error(saved.error);
        const loadedResponse = await fetch("/scene_presets/load?preset_id=runtime-bypass");
        const loaded = await loadedResponse.json();
        if (!loadedResponse.ok) throw new Error(loaded.error);
        await app.loadGraphData(loaded.workflow, true, true);
        const restored = app.graph.getNodeById(reverse.id);
        const restoredApi = await app.graphToPrompt();
        const restoredLinks = Object.values(app.graph.links).map((link) => [link.origin_id, link.target_id]);
        app.graph.clear();
        const nestedInput = create("ScenePresetInput");
        const reference = create("ScenePresetReference");
        const nestedOutput = create("ScenePresetOutput");
        reference.widgets.find((widget) => widget.name === "preset_id").value = "runtime-bypass";
        connect(nestedInput, reference);
        connect(reference, nestedOutput);
        reference.mode = 4;
        nestedOutput.widgets.find((widget) => widget.name === "preset_id").value = "runtime-bypass-reference";
        const referenceApi = await app.graphToPrompt();
        if (referenceApi.output[String(reference.id)]) throw new Error("ComfyUI should bypass Preset Reference in API graph");
        const referenceWorkflow = app.graph.serialize();
        const referenceResponse = await fetch("/scene_presets/save", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: "runtime-bypass-reference", name: "Runtime Bypass Reference", output_node_id: String(nestedOutput.id), api_graph: referenceApi, workflow: referenceWorkflow }),
        });
        const referenceSaved = await referenceResponse.json();
        if (!referenceResponse.ok) throw new Error(referenceSaved.error);
        const referenceLoadedResponse = await fetch("/scene_presets/load?preset_id=runtime-bypass-reference");
        const referenceLoaded = await referenceLoadedResponse.json();
        if (!referenceLoadedResponse.ok) throw new Error(referenceLoaded.error);
        await app.loadGraphData(referenceLoaded.workflow, true, true);
        const restoredReference = app.graph.getNodeById(reference.id);
        const restoredReferenceApi = await app.graphToPrompt();
        const restoredReferenceMode = restoredReference?.mode;
        restoredReference.mode = 0;
        const unbypassedReferenceApi = await app.graphToPrompt();
        return {
            bypassMode: restored?.mode,
            links: restoredLinks,
            expectedLinks: [[input.id, prompt.id], [prompt.id, reverse.id], [reverse.id, output.id]],
            apiContainsReverse: Boolean(restoredApi.output[String(reverse.id)]),
            outputSource: restoredApi.output[String(output.id)].inputs.scene_prompt,
            expectedSource: [String(prompt.id), 0],
            reference: {
                mode: restoredReferenceMode,
                presetId: restoredReference?.widgets?.find((widget) => widget.name === "preset_id")?.value,
                links: Object.values(app.graph.links).map((link) => [link.origin_id, link.target_id]),
                expectedLinks: [[nestedInput.id, reference.id], [reference.id, nestedOutput.id]],
                bypassed: Boolean(restoredReferenceApi.output[String(reference.id)]),
                unbypassed: Boolean(unbypassedReferenceApi.output[String(reference.id)]),
            },
        };
    });
    assert.equal(bypassPreset.bypassMode, 4);
    assert.deepEqual(bypassPreset.links, bypassPreset.expectedLinks);
    assert.equal(bypassPreset.apiContainsReverse, false);
    assert.deepEqual(bypassPreset.outputSource, bypassPreset.expectedSource);
    assert.equal(bypassPreset.reference.mode, 4);
    assert.equal(bypassPreset.reference.presetId, "runtime-bypass");
    assert.deepEqual(bypassPreset.reference.links, bypassPreset.reference.expectedLinks);
    assert.equal(bypassPreset.reference.bypassed, false);
    assert.equal(bypassPreset.reference.unbypassed, true);
    console.log("real ComfyUI bypass Preset save/load preserves mode, physical links and execution routing");
    const randomWorkflowRoundTrip = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const add = (type) => {
            const node = window.LiteGraph.createNode(type);
            if (!node) throw new Error(`Missing native node ${type}`);
            app.graph.add(node);
            return node;
        };
        const scene = add("ScenePrompter");
        const random = add("ScenePromptRandomRoute");
        const freshValue = random.widgets.find((widget) => widget.name === "preserve_join")?.value;
        const queue = add("ScenePrompterQueue");
        const expand = add("ScenePrompterExpand");
        scene.connect(0, random, random.inputs.findIndex((input) => input.name === "scene_prompt"));
        random.connect(0, queue, queue.inputs.findIndex((input) => input.name === "scene_prompt1"));
        queue.connect(0, expand, expand.inputs.findIndex((input) => input.name === "scene_prompt"));
        queue.widgets.find((widget) => widget.name === "order_mode").value = "alternate";
        queue.widgets.find((widget) => widget.name === "alternate_block_size").value = 9;
        queue.widgets.find((widget) => widget.name === "downstream_count_mode").value = "fixed";
        const encoded = "[10000,0,0,0,0,0,0,0,0,0]";
        const initial = app.graph.serialize();
        const old = structuredClone(initial);
        const oldRandom = old.nodes.find((entry) => String(entry.id) === String(random.id));
        if (!oldRandom) throw new Error(`Random node missing from workflow: ${JSON.stringify({ id: random.id, nodes: old.nodes.map((entry) => [entry.id, entry.type]) })}`);
        oldRandom.widgets_values = [encoded];
        delete oldRandom.widgets_values_named;
        await app.loadGraphData(old, true, true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const oldNode = app.graph.getNodeById(random.id);
        const oldValue = oldNode.widgets.find((widget) => widget.name === "preserve_join")?.value;
        const explicitFalse = structuredClone(initial);
        explicitFalse.nodes.find((entry) => String(entry.id) === String(random.id)).widgets_values = [encoded, false];
        delete explicitFalse.nodes.find((entry) => String(entry.id) === String(random.id)).widgets_values_named;
        await app.loadGraphData(explicitFalse, true, true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const savedFalse = app.graph.getNodeById(random.id).widgets.find((widget) => widget.name === "preserve_join")?.value;
        const named = structuredClone(explicitFalse);
        named.nodes.find((entry) => String(entry.id) === String(random.id)).widgets_values_named = { weights_json: encoded, preserve_join: true };
        await app.loadGraphData(named, true, true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const namedTrue = app.graph.getNodeById(random.id).widgets.find((widget) => widget.name === "preserve_join")?.value;
        const frozen = structuredClone(initial);
        frozen.nodes.find((entry) => String(entry.id) === String(random.id)).widgets_values = [encoded, true];
        await app.loadGraphData(frozen, true, true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const restored = app.graph.getNodeById(random.id);
        const serialized = app.graph.serialize().nodes.find((entry) => String(entry.id) === String(random.id));
        const prompt = await app.graphToPrompt();
        return {
            widgetNames: restored.widgets.map((widget) => widget.name),
            freshValue, savedFalse, namedTrue,
            oldValue,
            newValue: restored.widgets.find((widget) => widget.name === "preserve_join")?.value,
            hidden: restored.widgets.find((widget) => widget.name === "preserve_join")?.hidden,
            serialized: serialized.widgets_values,
            apiInputs: prompt.output?.[String(random.id)]?.inputs,
            queueControls: ["order_mode", "alternate_block_size", "downstream_count_mode"].map((name) => {
                const widget = app.graph.getNodeById(queue.id).widgets.find((item) => item.name === name);
                return { value: widget?.value, disabled: widget?.disabled };
            }),
        };
    });
    assert.equal(randomWorkflowRoundTrip.freshValue, true, "fresh Input preserves its own join boundary");
    assert.equal(randomWorkflowRoundTrip.savedFalse, false, "saved explicit false stays false");
    assert.equal(randomWorkflowRoundTrip.namedTrue, true, "named saved values override positional compatibility fields");
    assert.equal(randomWorkflowRoundTrip.oldValue, false, "legacy one-widget Random workflows default preserve_join to false");
    assert.equal(randomWorkflowRoundTrip.newValue, true, "frozen PNG workflow restores preserve_join");
    assert.equal(randomWorkflowRoundTrip.hidden, true, "preserve_join remains hidden in the node UI");
    assert.deepEqual(randomWorkflowRoundTrip.widgetNames.slice(0, 2), ["weights_json", "preserve_join"]);
    assert.deepEqual(randomWorkflowRoundTrip.serialized.slice(0, 2), ["[10000,0,0,0,0,0,0,0,0,0]", true]);
    assert.equal(randomWorkflowRoundTrip.apiInputs?.preserve_join, true,
        "graphToPrompt retains the frozen Random Queue boundary after PNG-style restoration");
    assert.deepEqual(randomWorkflowRoundTrip.queueControls.map((entry) => entry.value), ["alternate", 9, "fixed"],
        "frozen one-arm Random disables Queue controls while preserving their saved values");
    assert.ok(randomWorkflowRoundTrip.queueControls.every((entry) => entry.disabled));
    console.log("real ComfyUI Random legacy and frozen workflow widget round trips passed");
    nativeRunChecks = true;
    const randomOutputRuntime = await page.evaluate(async () => {
        const app = window.app;
        const { api } = await import('/scripts/api.js');
        app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); if (!node) throw new Error(`Missing ${type}`); app.graph.add(node); return node; };
        const connect = (from, slot, to, name) => from.connect(slot, to, to.inputs.findIndex(input => input.name === name));
        const outer = add('ScenePromptRandomRoute'), inner = add('ScenePromptRandomRoute');
        const a = add('ScenePrompter'), b = add('ScenePrompter');
        const inside = add('ScenePromptRandomRouteOutput'), output = add('ScenePromptRandomRouteOutput');
        const count = add('ScenePromptCounter'), expand = add('ScenePrompterExpand');
        outer.widgets.find(widget => widget.name === 'weights_json').value = '[5000,5000,0,0,0,0,0,0,0,0]';
        count.widgets.find(widget => widget.name === 'count').value = 10;
        connect(outer, 0, inner, 'scene_prompt'); connect(inner, 0, inside, 'scene_prompt10');
        connect(inside, 0, a, 'scene_prompt'); connect(outer, 1, b, 'scene_prompt');
        connect(b, 0, output, 'scene_prompt1'); connect(a, 0, output, 'scene_prompt10');
        connect(output, 0, count, 'scene_prompt'); connect(count, 0, expand, 'scene_prompt');
        await new Promise(done => setTimeout(done, 300));
        const plan = await app.graphToPrompt();
        const schema = { inputs: output.inputs.map(input => [input.name, input.type]), outputs: output.outputs.map(out => out.type),
            widgets: (output.widgets || []).map(widget => widget.name), inputTitle: outer.title, outputTitle: output.title };
        const preview = expand.widgets.find(widget => widget.sceneRole === 'expand_total_count')?.sceneTotalCount;
        const response = await api.fetchApi('/scene_prompt/runs/prepare', { method:'POST', body:JSON.stringify({api_graph:plan, workflow:plan.workflow, expand_node_id:String(expand.id)}) });
        const prepared = await response.json(); if (!response.ok) throw new Error(JSON.stringify(prepared));
        await api.fetchApi('/scene_prompt/runs/release', {method:'POST',body:JSON.stringify({run_handle:prepared.run_handle})});
        const serialized = app.graph.serialize();
        await app.loadGraphData(serialized, true, true); await new Promise(done=>setTimeout(done,300));
        const restored = app.graph.getNodeById(output.id);
        const after = await app.graphToPrompt();
        const missing = structuredClone(after); delete missing.output[String(output.id)].inputs.scene_prompt10;
        const bad = await api.fetchApi('/scene_prompt/runs/prepare',{method:'POST',body:JSON.stringify({api_graph:missing,expand_node_id:String(expand.id)})});
        return {schema, preview, total:prepared.total_batches, restoredWidgets:(restored.widgets || []).map(widget=>widget.name),
            restoredInputs:Object.keys(after.output[String(output.id)].inputs), missingStatus:bad.status, missing:await bad.json()};
    });
    nativeRunChecks = false;
    assert.equal(randomOutputRuntime.schema.inputs.length,10);
    assert(randomOutputRuntime.schema.inputs.every(([name,type])=>/^scene_prompt\d+$/u.test(name)&&type==='SCENE_PROMPT'));
    assert.deepEqual(randomOutputRuntime.schema.outputs,['SCENE_PROMPT']);
    assert.deepEqual(randomOutputRuntime.schema.widgets,[]);
    assert.deepEqual(randomOutputRuntime.restoredWidgets,[]);
    assert.equal(randomOutputRuntime.schema.inputTitle,'Scene Prompt Random Route Input');
    assert.equal(randomOutputRuntime.schema.outputTitle,'Scene Prompt Random Route Output');
    assert.equal(randomOutputRuntime.preview,10); assert.equal(randomOutputRuntime.total,10);
    assert(randomOutputRuntime.restoredInputs.includes('scene_prompt10'));
    assert(randomOutputRuntime.missingStatus>=400); assert.match(JSON.stringify(randomOutputRuntime.missing),/出力1|ランダム分岐/u);
    console.log('real ComfyUI nested 100% Input/Output UI, Count10, preflight and serialization passed');
    const queueModeRuntime = await page.evaluate(async () => {
        const app=window.app; app.graph.clear();
        const add=type=>{const node=window.LiteGraph.createNode(type);app.graph.add(node);return node;};
        const link=(from,to,name)=>from.connect(0,to,to.inputs.findIndex(input=>input.name===name));
        const source=add('ScenePrompter'), upstream=add('ScenePrompterQueue'), middle=add('ScenePrompter');
        const receiver=add('ScenePrompterQueue'), count=add('ScenePromptCounter'), expand=add('ScenePrompterExpand');
        const field=(node,name)=>node.widgets.find(widget=>widget.name===name);
        field(upstream,'alternate_block_size').value=2;
        const settings=['order_mode','alternate_block_size','downstream_count_mode'];
        ['alternate',3,'fixed'].forEach((value,index)=>{field(receiver,settings[index]).value=value;});
        field(count,'count').value=10;
        link(source,upstream,'scene_prompt1');link(upstream,middle,'scene_prompt');link(middle,receiver,'scene_prompt1');
        link(receiver,count,'scene_prompt');link(count,expand,'scene_prompt');
        const snapshot=async()=>{await new Promise(done=>setTimeout(done,250));return {
            values:settings.map(name=>field(receiver,name).value),disabled:settings.map(name=>field(receiver,name).disabled),
            total:expand.widgets.find(widget=>widget.sceneRole==='expand_total_count')?.sceneTotalCount,
            mode:upstream.mode,lock:receiver.sceneQueueControlLock};};
        const bypass=async node=>{
            app.canvas.deselectAllNodes(); app.canvas.selectNode(node);
            await app.extensionManager.command.execute('Comfy.Canvas.ToggleSelectedNodes.Bypass');
        };
        const active=await snapshot();await bypass(upstream);const bypassed=await snapshot();
        await bypass(upstream);const resumed=await snapshot();
        const second=add('ScenePrompterQueue');field(second,'alternate_block_size').value=4;
        link(source,second,'scene_prompt1');link(second,receiver,'scene_prompt2');
        await bypass(upstream);const anotherActive=await snapshot();await bypass(second);const allBypassed=await snapshot();
        const workflow=app.graph.serialize();await app.loadGraphData(workflow,true,true);await new Promise(done=>setTimeout(done,300));
        const restored=app.graph.getNodeById(receiver.id);
        return {active,bypassed,resumed,anotherActive,allBypassed,
            reloaded:settings.map(name=>({value:field(restored,name).value,disabled:field(restored,name).disabled}))};
    });
    for(const state of Object.values(queueModeRuntime).filter(item=>Array.isArray(item?.values)))assert.deepEqual(state.values,['alternate',3,'fixed']);
    assert(queueModeRuntime.active.disabled.every(Boolean)); assert.equal(queueModeRuntime.active.total,20);
    assert.equal(queueModeRuntime.bypassed.mode,4); assert.equal(queueModeRuntime.resumed.mode,0);
    assert(queueModeRuntime.bypassed.disabled.every(value=>!value),JSON.stringify(queueModeRuntime)); assert.equal(queueModeRuntime.bypassed.total,3);
    assert(queueModeRuntime.resumed.disabled.every(Boolean)); assert.equal(queueModeRuntime.resumed.total,20);
    assert(queueModeRuntime.anotherActive.disabled.every(Boolean)); assert.equal(queueModeRuntime.anotherActive.total,50);
    assert(queueModeRuntime.allBypassed.disabled.every(value=>!value)); assert.equal(queueModeRuntime.allBypassed.total,6);
    assert.deepEqual(queueModeRuntime.reloaded.map(item=>item.value),['alternate',3,'fixed']);
    assert(queueModeRuntime.reloaded.every(item=>!item.disabled));
    console.log('real ComfyUI bypass action updates downstream Queue controls/counts and preserves saved settings');
    nativeRunChecks = true;
    const countPolicyRuntime = await page.evaluate(async () => {
        const app = window.app, { api } = await import('/scripts/api.js'); app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const link = (from, to, name) => from.connect(0, to, to.inputs.findIndex(input => input.name === name));
        const a = add('ScenePrompter'), b = add('ScenePrompter'), ca = add('ScenePromptCounter'), cb = add('ScenePromptCounter');
        const queue = add('ScenePrompterQueue'), count = add('ScenePromptCounter'), expand = add('ScenePrompterExpand');
        a.title = 'A'; b.title = 'B'; field(a, 'prompt_name').value = 'A'; field(b, 'prompt_name').value = 'B';
        field(ca, 'count').value = 3; field(ca, 'enable_downstream_count').value = false;
        field(cb, 'count').value = 2; field(count, 'count').value = 10;
        link(a, ca, 'scene_prompt'); link(b, cb, 'scene_prompt');
        link(ca, queue, 'scene_prompt1'); link(cb, queue, 'scene_prompt2'); link(queue, count, 'scene_prompt'); link(count, expand, 'scene_prompt');
        const ids = { ca: ca.id, count: count.id, queue: queue.id, expand: expand.id };
        const current = () => app.graph.getNodeById(ids.ca);
        const snapshot = async () => { await new Promise(done => setTimeout(done, 250)); return {
            total: window.__sceneSeedRuntimeTest.countStats(app.graph.getNodeById(ids.count)).total,
            preview: window.__sceneSeedRuntimeTest.countPreview(app.graph.getNodeById(ids.count)),
            displayed: app.graph.getNodeById(ids.expand).widgets.find(widget => widget.sceneRole === 'expand_total_count')?.sceneTotalCount,
            enabled: field(current(), 'enable_downstream_count').value,
            locked: app.graph.getNodeById(ids.queue).sceneQueueControlLock,
        }; };
        await app.loadGraphData(app.graph.serialize(), true, true);
        const initial = await snapshot();
        const tracker = window.__sceneSeedRuntimeTest.tracker(); tracker.captureCanvasState();
        tracker.beforeChange(); field(current(), 'enable_downstream_count').value = true;
        field(current(), 'enable_downstream_count').callback?.(true); tracker.afterChange();
        const enabled = await snapshot(); await tracker.undo(); const undone = await snapshot();
        await tracker.redo(); const redone = await snapshot();
        field(current(), 'enable_downstream_count').value = false; field(current(), 'enable_downstream_count').callback?.(false);
        app.canvas.deselectAllNodes(); app.canvas.selectNode(current());
        await app.extensionManager.command.execute('Comfy.Canvas.ToggleSelectedNodes.Bypass'); const bypassed = await snapshot();
        await app.extensionManager.command.execute('Comfy.Canvas.ToggleSelectedNodes.Bypass'); const resumed = await snapshot();
        const serialized = app.graph.serialize(); await app.loadGraphData(serialized, true, true); const reloaded = await snapshot();
        const fresh = add('ScenePromptCounter');
        const freshFlag = field(fresh, 'enable_downstream_count').value;
        const names = fresh.widgets.filter(widget => !widget.hidden && widget.serialize !== false).map(widget => widget.name);
        const saved = current().serialize();
        current().configure({ ...saved, widgets_values: [3, 'legacy-source', 'legacy-title'], widgets_values_named: { count: 3 } });
        const legacy = await snapshot(); const legacySources = current().serialize().widgets_values_named;
        current().configure({ ...saved, widgets_values: [3, true], widgets_values_named: { count: 3, enable_downstream_count: false } });
        const named = await snapshot();
        const prompt = await app.graphToPrompt();
        const response = await api.fetchApi('/scene_prompt/runs/prepare', { method: 'POST', body: JSON.stringify({api_graph:prompt,workflow:prompt.workflow,expand_node_id:String(expand.id)}) });
        const prepared = await response.json(); if (!response.ok) throw new Error(JSON.stringify(prepared));
        await api.fetchApi('/scene_prompt/runs/release', {method:'POST',body:JSON.stringify({run_handle:prepared.run_handle})});
        // A Merge has two sources and must preserve either source's strict policy.
        const merge = add('ScenePrompterMerge'), extra = add('ScenePrompter');
        link(app.graph.getNodeById(ids.queue), merge, 'scene_prompt1'); link(extra, merge, 'scene_prompt2');
        link(merge, app.graph.getNodeById(ids.count), 'scene_prompt'); const merged = await snapshot();
        return {initial,enabled,undone,redone,bypassed,resumed,reloaded,legacy,named,merged,freshFlag,names,legacySources,
            apiFlag:prompt.output[String(ids.ca)].inputs.enable_downstream_count,total:prepared.total_batches};
    });
    nativeRunChecks = false;
    for (const key of ['initial','undone','resumed','reloaded','named','merged']) {
        assert.equal(countPolicyRuntime[key].total, 23, JSON.stringify(countPolicyRuntime));
        assert.equal(countPolicyRuntime[key].displayed, 23);
    }
    for (const key of ['enabled','redone','legacy']) assert.equal(countPolicyRuntime[key].total, 50);
    assert.equal(countPolicyRuntime.bypassed.total, 30);
    assert.deepEqual(countPolicyRuntime.initial.preview, [...Array(3).fill('A'), ...Array(20).fill('B')]);
    assert.equal(countPolicyRuntime.initial.locked, '');
    assert.equal(countPolicyRuntime.freshFlag, true); assert.deepEqual(countPolicyRuntime.names.slice(0,2), ['count','enable_downstream_count']);
    assert.equal(countPolicyRuntime.legacySources.source_node_id, 'legacy-source');
    assert.equal(countPolicyRuntime.legacySources.source_node_name, 'legacy-title');
    assert.equal(countPolicyRuntime.apiFlag, false); assert.equal(countPolicyRuntime.total, 23);
    console.log('real ComfyUI Count path policy, cache refresh, native defaults/legacy/named migration, bypass, undo/redo, reload and Merge passed');
    nativeRunChecks = true;
    const primitivePlanRuntime = await page.evaluate(async () => {
        const app = window.app, { api } = await import('/scripts/api.js'); app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); if (!node) throw new Error(`Missing ${type}`); app.graph.add(node); return node; };
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const link = (from, to, name, type = 'SCENE_PROMPT') => {
            if (!to.inputs.some(input => input.name === name)) to.addInput(name, type, { widget: { name } });
            const connected = from.connect(0, to, to.inputs.findIndex(input => input.name === name));
            if (!connected) throw new Error(`Cannot connect ${from.type} to ${name}`);
        };
        const seed = add('ScenePrompter'), count = add('ScenePromptCounter'), downstream = add('ScenePromptCounter');
        const latent = add('SceneEmptyLatent'), expand = add('ScenePrompterExpand');
        const number = add('PrimitiveInt'), flag = add('PrimitiveBoolean'), batch = add('PrimitiveInt');
        const width = add('PrimitiveInt'), height = add('PrimitiveInt');
        field(count, 'count').value = 99; field(count, 'enable_downstream_count').value = true;
        field(downstream, 'count').value = 5; field(latent, 'batch_size').value = 99;
        field(number, 'value').value = 3; field(flag, 'value').value = false; field(batch, 'value').value = 4;
        field(width, 'value').value = 768; field(height, 'value').value = 640;
        link(seed, count, 'scene_prompt'); link(count, downstream, 'scene_prompt'); link(downstream, latent, 'scene_prompt'); link(latent, expand, 'scene_prompt');
        link(number, count, 'count', 'INT'); link(flag, count, 'enable_downstream_count', 'BOOLEAN');
        link(batch, latent, 'batch_size', 'INT'); link(width, latent, 'width', 'INT'); link(height, latent, 'height', 'INT');
        const ids = Object.fromEntries(Object.entries({ count, latent, expand, number, flag, batch, width, height }).map(([name,node]) => [name,node.id]));
        const current = name => app.graph.getNodeById(ids[name]);
        const edit = (name, value) => { const widget = field(current(name), 'value'); widget.value = value; widget.callback?.(value); };
        const snapshot = async () => {
            app.graph.setDirtyCanvas(true, true); app.canvas.draw(true, true);
            await new Promise(done => setTimeout(done, 250));
            app.canvas.draw(true, true);
            const stats = window.__sceneSeedRuntimeTest.countStats(current('latent'));
            const prompt = await app.graphToPrompt();
            const response = await api.fetchApi('/scene_prompt/runs/prepare', { method: 'POST', body: JSON.stringify({
                api_graph: prompt, workflow: prompt.workflow, expand_node_id: String(ids.expand),
            }) });
            const prepared = await response.json(); if (!response.ok) throw new Error(JSON.stringify(prepared));
            await api.fetchApi('/scene_prompt/runs/release', { method: 'POST', body: JSON.stringify({ run_handle: prepared.run_handle }) });
            return { total: stats.total, images: stats.totalImages, error: stats.error,
                displayed: current('expand').widgets.find(widget => widget.sceneRole === 'expand_total_count')?.sceneTotalCount,
                config: window.__sceneSeedRuntimeTest.latentConfig(current('latent')),
                prepared: { total: prepared.total_batches, images: prepared.total_images },
                key: window.__sceneSeedRuntimeTest.sourceKey(current('latent')), inputs: prompt.output[String(ids.count)]?.inputs || {} };
        };
        await app.loadGraphData(app.graph.serialize(), true, true);
        const off = await snapshot(); edit('flag', true); const on = await snapshot();
        edit('number', 2); edit('batch', 5); edit('width', 640); edit('height', 768); const edited = await snapshot();
        const boolReroute = add('Reroute'), batchReroute = add('Reroute');
        link(current('flag'), boolReroute, boolReroute.inputs[0].name, 'BOOLEAN');
        link(boolReroute, current('count'), 'enable_downstream_count', 'BOOLEAN');
        link(current('batch'), batchReroute, batchReroute.inputs[0].name, 'INT');
        link(batchReroute, current('latent'), 'batch_size', 'INT');
        edit('flag', false); const rerouted = await snapshot();
        app.canvas.deselectAllNodes(); app.canvas.selectNode(current('count'));
        await app.extensionManager.command.execute('Comfy.Canvas.ToggleSelectedNodes.Bypass'); const bypassed = await snapshot();
        await app.extensionManager.command.execute('Comfy.Canvas.ToggleSelectedNodes.Bypass'); const resumed = await snapshot();
        const workflow = app.graph.serialize(); await app.loadGraphData(workflow, true, true); const reloaded = await snapshot();
        return { off, on, edited, rerouted, bypassed, resumed, reloaded };
    });
    nativeRunChecks = false;
    for (const [name, total, images] of [['off',3,12], ['on',15,60], ['edited',10,50], ['rerouted',2,10], ['bypassed',5,25], ['resumed',2,10], ['reloaded',2,10]]) {
        const result = primitivePlanRuntime[name];
        assert.equal(result.error, undefined, JSON.stringify(primitivePlanRuntime));
        assert.equal(result.total, total, name); assert.equal(result.images, images, name);
        assert.equal(result.displayed, total, `${name} native canvas count`);
        assert.deepEqual(result.prepared, { total, images }, `${name} frontend/backend parity`);
    }
    assert.deepEqual(primitivePlanRuntime.off.config, { width: 768, height: 640, batch_size: 4 });
    assert.deepEqual(primitivePlanRuntime.reloaded.config, { width: 640, height: 768, batch_size: 5 });
    assert.notEqual(primitivePlanRuntime.off.key, primitivePlanRuntime.on.key);
    assert.notEqual(primitivePlanRuntime.on.key, primitivePlanRuntime.edited.key);
    assert(Array.isArray(primitivePlanRuntime.off.inputs.count));
    assert(Array.isArray(primitivePlanRuntime.off.inputs.enable_downstream_count));
    console.log('real ComfyUI Primitive Count/Boolean/latent dimensions and batch edits, Reroute, native bypass/reload, visible canvas and backend plan parity passed');
    const nativeLineageMeasurements = await page.evaluate(async () => {
        const app = window.app, measurements = [];
        for (const depth of [2, 4, 8]) {
            app.graph.clear();
            const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
            let root = add('ScenePrompter');
            for (let index = 0; index < depth; index++) {
                const merge = add('ScenePrompterMerge');
                root.connect(0, merge, merge.inputs.findIndex(input => input.name === 'scene_prompt1'));
                root.connect(0, merge, merge.inputs.findIndex(input => input.name === 'scene_prompt2'));
                root = merge;
            }
            const rootId = root.id;
            await app.loadGraphData(app.graph.serialize(), true, true);
            await new Promise(done => setTimeout(done, 300));
            root = app.graph.getNodeById(rootId);
            const key = window.__sceneSeedRuntimeTest.sourceKey(root), stats = window.__sceneSeedRuntimeTest.countStats(root);
            const start = performance.now();
            for (let draw = 0; draw < 100; draw++) window.__sceneSeedRuntimeTest.countStats(root);
            const warm100ms = performance.now() - start;
            app.canvas.draw(true, true);
            measurements.push({ nodes: app.graph._nodes.length, edges: depth * 2, chars: key.length,
                descriptors: JSON.parse(key).length, total: stats.total, warm100ms });
        }
        return measurements;
    });
    for (const result of nativeLineageMeasurements) {
        assert.equal(result.descriptors, result.nodes); assert.equal(result.total, 1);
        assert(result.chars < result.nodes * 500, JSON.stringify(nativeLineageMeasurements));
    }
    console.log('real ComfyUI shared Merge load, redraw and warm count measurements', JSON.stringify(nativeLineageMeasurements));
    const executionRequestsBefore = { prompts: seedRequests.length, runs: runRequests.length, resources: resourceRequests.length };
    const llmRuntime = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const llm = window.LiteGraph.createNode("ScenePromptLLM");
        const expand = window.LiteGraph.createNode("ScenePrompterExpand");
        const branch = window.LiteGraph.createNode("ScenePrompterQueue");
        if (!llm || !expand || !branch) throw new Error("Actual LLM/Expand/Queue registration missing");
        for (const node of [llm, expand, branch]) app.graph.add(node);
        const field = (node, name) => node.widgets.find((widget) => widget.name === name);
        const role = (node, name) => node.widgets.find((widget) => widget.sceneRole === name);
        const add = (type) => { const node = window.LiteGraph.createNode(type); if (!node) throw new Error(`Standard loader ${type} missing`); app.graph.add(node); return node; };
        const checkpoint = add("CheckpointLoaderSimple"), nativeLora = add("LoraLoader"), checkpointApply = add("SceneApplyModel");
        const diffusion = add("UNETLoader"), clip = add("CLIPLoader"), vae = add("VAELoader"), diffusionApply = add("SceneApplyModel");
        const port = (node, name) => node.inputs.findIndex((input) => input.name === name);
        field(checkpoint, "ckpt_name").value = "runtime-checkpoint.safetensors";
        field(nativeLora, "lora_name").value = "runtime-hat.safetensors";
        field(diffusion, "unet_name").value = "runtime-diffusion.safetensors";
        field(clip, "clip_name").value = "runtime-clip.safetensors";
        field(vae, "vae_name").value = "runtime-vae.safetensors";
        checkpoint.connect(0, nativeLora, port(nativeLora, "model")); checkpoint.connect(1, nativeLora, port(nativeLora, "clip"));
        nativeLora.connect(0, checkpointApply, port(checkpointApply, "model")); nativeLora.connect(1, checkpointApply, port(checkpointApply, "clip"));
        checkpoint.connect(2, checkpointApply, port(checkpointApply, "vae"));
        checkpointApply.connect(0, diffusionApply, port(diffusionApply, "scene_prompt"));
        diffusion.connect(0, diffusionApply, port(diffusionApply, "model")); clip.connect(0, diffusionApply, port(diffusionApply, "clip"));
        vae.connect(0, diffusionApply, port(diffusionApply, "vae")); diffusionApply.connect(0, llm, port(llm, "scene_prompt"));
        const own = role(llm, "llm_generate"), description = field(llm, "description"), generate = role(expand, "expand_llm_generate");
        if (!own || !generate || !description?.inputEl) throw new Error("Native LLM widgets / description textarea unavailable");
        const empty = { own: own.disabled, expand: generate.disabled };
        const order = llm.widgets.indexOf(own) === llm.widgets.indexOf(description) + 1 && expand.widgets.indexOf(generate) + 1 === expand.widgets.indexOf(role(expand, "expand_run_all"));
        description.inputEl.value = "a girl wearing a hat";
        description.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        description.callback?.(description.value);
        llm.connect(0, branch, branch.inputs.findIndex((input) => input.name === "scene_prompt2"));
        branch.connect(0, expand, expand.inputs.findIndex((input) => input.name === "scene_prompt"));
        window.__sceneSeedRuntimeTest.updateLLMExpand(expand);
        const enabled = { own: !own.disabled, expand: !generate.disabled };
        llm.mode = 4;
        window.__sceneSeedRuntimeTest.updateLLMExpand(expand);
        const bypassDisabled = generate.disabled;
        llm.mode = 0;
        window.__sceneSeedRuntimeTest.updateLLMExpand(expand);
        const tracker = window.__sceneSeedRuntimeTest.tracker();
        if (!tracker?.undo || !tracker?.redo) throw new Error("Native ChangeTracker unavailable");
        tracker.captureCanvasState();
        const trackerBefore = { changeCount: tracker.changeCount, nodes: tracker.activeState?.nodes?.map((node) => [node.id, node.type]), history: tracker.undoQueue.length };
        await generate.callback();
        const managed = app.graph._nodes.find((node) => node.comfyClass === "SceneApplyLora" && node.properties?.scene_civitai?.origin === String(llm.id));
        if (!managed) throw new Error(`Generated native ApplyLoRA missing; status=${llm.sceneLLMStatus}`);
        const prompt = await app.graphToPrompt();
        const beforeReload = { llm: prompt.output[String(llm.id)]?.inputs, widgets: window.__sceneSeedRuntimeTest.llmWidgets(llm), lora: prompt.output[String(managed.id)]?.inputs,
            queueInput: prompt.output[String(branch.id)]?.inputs.scene_prompt2, managed: managed.properties.scene_civitai,
            serial: app.graph.serialize(), ids: { llm: llm.id, lora: managed.id, expand: expand.id, branch: branch.id } };
        const ids = beforeReload.ids;
        await tracker.undo();
        if (!field(app.graph.getNodeById(ids.llm), "positive")) throw new Error(JSON.stringify({ trackerBefore, ids, afterUndo: app.graph._nodes.map((node) => ({id:node.id,type:node.type,widgets:node.widgets?.map((widget)=>widget.name)})), history: tracker.undoQueue.length, changeCount: tracker.changeCount }));
        const undone = { positive: field(app.graph.getNodeById(ids.llm), "positive").value,
            loras: app.graph._nodes.filter((node) => node.comfyClass === "SceneApplyLora").length,
            queueOrigin: app.graph.links[app.graph.getNodeById(ids.branch).inputs.find((input) => input.name === "scene_prompt2").link]?.origin_id };
        await tracker.redo();
        const redone = { positive: field(app.graph.getNodeById(ids.llm), "positive").value,
            loras: app.graph._nodes.filter((node) => node.comfyClass === "SceneApplyLora").length,
            queueOrigin: app.graph.links[app.graph.getNodeById(ids.branch).inputs.find((input) => input.name === "scene_prompt2").link]?.origin_id };
        await app.loadGraphData(beforeReload.serial, true, true);
        const restored = app.graph.getNodeById(ids.llm), restoredLora = app.graph.getNodeById(ids.lora), restoredExpand = app.graph.getNodeById(ids.expand);
        const after = await app.graphToPrompt();
        const restoredWidgets = window.__sceneSeedRuntimeTest.llmWidgets(restored);
        field(restored, "positive").value = "user edited prompt";
        await role(restoredExpand, "expand_llm_generate").callback();
        return { empty, order, enabled, bypassDisabled, description: description.value, undone, redone,
            beforeReload, restored: { llm: after.output[String(ids.llm)]?.inputs, widgets: restoredWidgets, lora: after.output[String(ids.lora)]?.inputs,
                queueInput: after.output[String(ids.branch)]?.inputs.scene_prompt2, provenance: restoredLora.properties.scene_civitai },
            reusedPositive: field(restored, "positive").value,
            nodeCount: app.graph._nodes.filter((node) => node.comfyClass === "SceneApplyLora").length,
            stateHidden: field(restored, "generation_state_json").hidden };
    });
    assert.deepEqual(llmRuntime.empty, { own: true, expand: true });
    assert.equal(llmRuntime.order, true);
    const llmStoredNames = ["model_mode", "description", "positive", "negative", "generation_state_json"];
    function assertLLMWidgetContract(snapshot, inputs) {
        assert.equal(snapshot.firstRole, "llm_settings");
        assert.equal(snapshot.settingsCount, 1);
        assert.equal(snapshot.settingsSerialize, false);
        assert.deepEqual(snapshot.names, llmStoredNames);
        assert.deepEqual(snapshot.values, llmStoredNames.map(name => inputs[name]));
    }
    assertLLMWidgetContract(llmRuntime.beforeReload.widgets, llmRuntime.beforeReload.llm);
    assertLLMWidgetContract(llmRuntime.restored.widgets, llmRuntime.restored.llm);
    assert.deepEqual(llmRuntime.enabled, { own: true, expand: true });
    assert.equal(llmRuntime.bypassDisabled, true);
    assert.equal(llmRuntime.description, "a girl wearing a hat");
    assert.equal(llmRuntime.beforeReload.llm.positive, "1girl, hat");
    assert.equal(llmRuntime.beforeReload.llm.negative, "blurry");
    assert.equal(llmRuntime.beforeReload.lora.lora_name, runtimeCandidate.lora_name);
    assert.equal(llmRuntime.beforeReload.lora.positive, "runtime_hat");
    assert.deepEqual(llmRuntime.undone, { positive: "", loras: 0, queueOrigin: llmRuntime.beforeReload.ids.llm });
    assert.deepEqual(llmRuntime.redone, { positive: "1girl, hat", loras: 1, queueOrigin: llmRuntime.beforeReload.ids.lora });
    assert.deepEqual(llmRuntime.beforeReload.queueInput, [String(llmRuntime.beforeReload.ids.lora), 0]);
    assert.equal(llmRuntime.restored.llm.positive, "1girl, hat");
    assert.equal(llmRuntime.restored.llm.negative, "blurry");
    assert.equal(llmRuntime.restored.llm.description, "a girl wearing a hat");
    assert.equal(llmRuntime.restored.llm.model_mode, "Illustrious");
    assert.deepEqual(JSON.parse(llmRuntime.restored.llm.generation_state_json), { description: "a girl wearing a hat", model_mode: "Illustrious", template_version: "scene-llm-v1", lora_queries: ["hat"] });
    assert.equal(llmRuntime.restored.lora.lora_name, runtimeCandidate.lora_name);
    assert.deepEqual(llmRuntime.restored.queueInput, llmRuntime.beforeReload.queueInput);
    assert.deepEqual(llmRuntime.restored.provenance, llmRuntime.beforeReload.managed);
    assert.equal(llmRuntime.reusedPositive, "user edited prompt");
    assert.equal(llmRuntime.nodeCount, 1);
    assert.equal(llmRuntime.stateHidden, true);
    assert.deepEqual(llmRequests.map((request) => request.path), ["/scene_prompt/llm/generate", "/scene_prompt/civitai/search", "/scene_prompt/llm/select_loras", "/scene_prompt/civitai/download"], "workflow load and converted Expand never invoke any service");
    assert.deepEqual(llmRequests[0].body, { description: "a girl wearing a hat", model_mode: "Illustrious" });
    assert.equal(seedRequests.length, executionRequestsBefore.prompts, "prompt generation never posts a Comfy prompt");
    assert.equal(runRequests.length, executionRequestsBefore.runs, "prompt generation never prepares or claims an image run");
    assert.equal(resourceRequests.length, executionRequestsBefore.resources, "prompt generation never inspects or hashes connected resource files");
    const loaderExecutions = await (await fetch(`${url}/scene_test/model_executions`)).json();
    assert.deepEqual(loaderExecutions, [], "connected standard checkpoint/diffusion/CLIP/VAE/LoRA loaders never execute");
    const isolatedQueue = await (await fetch(`${url}/queue`)).json();
    assert.equal(isolatedQueue.queue_running.length, 0);
    assert.equal(isolatedQueue.queue_pending.length, 0);
    console.log("real ComfyUI prompt generation leaves connected checkpoint/diffusion/CLIP/VAE/LoRA loaders unexecuted, queue empty and resource inspection untouched");
    assert.doesNotMatch(JSON.stringify(llmRuntime.beforeReload.serial), /image_url|api_key|conversation_history/);
    console.log("real ComfyUI LLM widget controls, explicit generation, native LoRA insertion and workflow/API reload passed");

    const physicalPresetRuntime = await page.evaluate(async () => {
        const app = window.app; app.graph.clear();
        const field = (node,name) => node.widgets.find(widget => widget.name === name);
        const add = type => { const node = window.LiteGraph.createNode(type); if (!node) throw new Error(`Missing ${type}`); app.graph.add(node); return node; };
        const link = (source,target,name='scene_prompt') => source.connect(0,target,target.inputs.findIndex(input => input.name === name));
        const input = add('ScenePresetInput'), llm = add('ScenePromptLLM'), bypass = add('ScenePrompter');
        const reference = add('ScenePresetReference'), reroute = add('Reroute'), output = add('ScenePresetOutput');
        const note = add('Note'), muted = add('ScenePrompter'), manual = add('SceneApplyLora'), queue = add('ScenePrompterQueue');
        field(llm,'description').value = 'local physical fixture'; field(llm,'positive').value = 'before';
        field(reference,'preset_id').value = 'never-requested';
        field(manual,'lora_name').value = 'runtime-hat.safetensors'; manual.properties.manual_fixture = true;
        muted.mode = 2; note.title = 'Keep Note';
        link(input,llm); link(llm,bypass); link(bypass,reference); link(reference,reroute,reroute.inputs[0].name); link(reroute,output);
        link(llm,manual); link(manual,queue,'scene_prompt5');
        for (const node of [bypass,reference]) {
            app.canvas.deselectAllNodes(); app.canvas.selectNode(node);
            await app.extensionManager.command.execute('Comfy.Canvas.ToggleSelectedNodes.Bypass');
        }
        const initialWorkflow = app.graph.serialize();
        initialWorkflow.groups = [{ title: 'Keep Group', bounding: [0,0,1300,500], color: '#334455', font_size: 24, flags: {} }];
        await app.loadGraphData(initialWorkflow,true,true);
        const original = { metadata: { preset_id: 'physical-native',sha256: 'fixture' },
            workflow: app.graph.serialize(),api_graph: await app.graphToPrompt() };
        const ids = { input: input.id,llm: llm.id,bypass: bypass.id,reference: reference.id,reroute: reroute.id,output: output.id,
            note: note.id,muted: muted.id,manual: manual.id,queue: queue.id };
        if (original.api_graph.output[String(ids.bypass)] || original.api_graph.output[String(ids.reference)])
            throw new Error('Native command must contract both bypassed nodes in API');
        const adapter = await window.__sceneSeedRuntimeTest.presetAdapter(original);
        field(adapter.getNodeById(ids.llm),'positive').value = 'local edit';
        const edited = adapter.definition();
        const topology = workflow => ({ links: workflow.links,groups: workflow.groups,
            nodes: workflow.nodes.map(node => ({ id:node.id,type:node.type,mode:node.mode,inputs:node.inputs,outputs:node.outputs })) });
        const promptPreserved = JSON.stringify(topology(edited.workflow)) === JSON.stringify(topology(original.workflow));
        await app.loadGraphData(edited.workflow,true,true);
        const editedAPI = await app.graphToPrompt();
        const candidates = [1,2].map(id => ({ model_id:id,version_id:id,file_id:id,lora_name:'runtime-hat.safetensors',triggers:[`physical${id}`],
            search_state:{ model_mode:'Illustrious' } }));
        const placed = await window.__sceneSeedRuntimeTest.splicePresetLoras(adapter,ids.llm,candidates);
        const spliced = adapter.definition();
        const reused = await window.__sceneSeedRuntimeTest.splicePresetLoras(adapter,ids.llm,candidates);
        const newTail = placed.at(-1).id;
        const originalFanout = original.workflow.links.filter(link => String(link[1]) === String(ids.llm) && link[2] === 0);
        const preservedFanout = originalFanout.every(link => {
            const actual = spliced.workflow.links.find(candidate => candidate[0] === link[0]);
            return JSON.stringify(actual) === JSON.stringify([link[0],newTail,link[2],...link.slice(3)]);
        });
        const changedNodes = original.workflow.nodes.filter(node => String(node.id) !== String(ids.llm)).flatMap(node => {
            const after=spliced.workflow.nodes.find(candidate=>String(candidate.id)===String(node.id));
            return JSON.stringify(after)===JSON.stringify(node)?[]:[{before:node,after}];
        });
        const unchangedNodes = changedNodes.length === 0;
        await app.loadGraphData(spliced.workflow,true,true); const api = await app.graphToPrompt();
        const current = id => app.graph.getNodeById(id);
        const snapshot = { nodes: app.graph.serialize().nodes.map(node => ({id:node.id,type:node.type,mode:node.mode})),
            physicalLinks: app.graph.serialize().links,groups: app.graph.serialize().groups,
            apiOutput: api.output[String(ids.output)].inputs.scene_prompt,apiManual:api.output[String(ids.manual)].inputs.scene_prompt,
            llmPositive:api.output[String(ids.llm)].inputs.positive,loras:placed.map(node=>api.output[String(node.id)]?.inputs),
            bypassModes:[current(ids.bypass).mode,current(ids.reference).mode], mutedMode:current(ids.muted).mode,
            note:current(ids.note).title, manualProperty:current(ids.manual).properties.manual_fixture };
        const reloadedAdapter = await window.__sceneSeedRuntimeTest.presetAdapter({ ...spliced,workflow:app.graph.serialize(),api_graph:api });
        const reusedAfterReload = await window.__sceneSeedRuntimeTest.splicePresetLoras(reloadedAdapter,ids.llm,candidates);
        const third = await window.__sceneSeedRuntimeTest.splicePresetLoras(reloadedAdapter,ids.llm,[...candidates,
            { model_id:3,version_id:3,file_id:3,lora_name:'runtime-hat.safetensors',triggers:['physical3'] }]);
        const extended = reloadedAdapter.definition();
        await app.loadGraphData(extended.workflow,true,true); const extendedAPI = await app.graphToPrompt();
        return { ids,promptPreserved,preservedFanout,unchangedNodes,
            editedPositive:editedAPI.output[String(ids.llm)].inputs.positive,snapshot,changedNodes,
            originalLinks:original.workflow.links.length, originalNodes:original.workflow.nodes.length,newTail,
            reused:reused.length,reusedAfterReload:reusedAfterReload.length,
            third:third.length,extendedTail:third[0].id,extendedOutput:extendedAPI.output[String(ids.output)].inputs.scene_prompt,
            extendedManual:extendedAPI.output[String(ids.manual)].inputs.scene_prompt,
            preservedIds:original.workflow.links.every(link=>extended.workflow.links.some(candidate=>candidate[0]===link[0])) };
    });
    assert(physicalPresetRuntime.promptPreserved); assert.equal(physicalPresetRuntime.editedPositive,'local edit');
    assert(physicalPresetRuntime.preservedFanout); assert(physicalPresetRuntime.unchangedNodes,JSON.stringify(physicalPresetRuntime.changedNodes)); assert(physicalPresetRuntime.preservedIds);
    assert.equal(physicalPresetRuntime.snapshot.nodes.length,physicalPresetRuntime.originalNodes+2);
    assert.equal(physicalPresetRuntime.snapshot.physicalLinks.length,physicalPresetRuntime.originalLinks+2);
    assert.deepEqual(physicalPresetRuntime.snapshot.apiOutput,[String(physicalPresetRuntime.newTail),0]);
    assert.deepEqual(physicalPresetRuntime.snapshot.apiManual,[String(physicalPresetRuntime.newTail),0]);
    assert.equal(physicalPresetRuntime.snapshot.llmPositive,'local edit');
    assert.deepEqual(physicalPresetRuntime.snapshot.bypassModes,[4,4]); assert.equal(physicalPresetRuntime.snapshot.mutedMode,2);
    assert.equal(physicalPresetRuntime.snapshot.note,'Keep Note'); assert.equal(physicalPresetRuntime.snapshot.manualProperty,true);
    assert.equal(physicalPresetRuntime.snapshot.groups[0].title,'Keep Group');
    assert(physicalPresetRuntime.snapshot.loras.every(inputs=>inputs.lora_name==='runtime-hat.safetensors'));
    assert.equal(physicalPresetRuntime.reused,0); assert.equal(physicalPresetRuntime.reusedAfterReload,0); assert.equal(physicalPresetRuntime.third,1);
    assert.deepEqual(physicalPresetRuntime.extendedOutput,[String(physicalPresetRuntime.extendedTail),0]);
    assert.deepEqual(physicalPresetRuntime.extendedManual,[String(physicalPresetRuntime.extendedTail),0]);
    console.log('real ComfyUI Preset local edit/insertion retains bypassed Prompt/Reference, Reroute, Note, mute, group, manual branch and physical IDs through native reload/API; adjacent chains reuse and extend');

    const nativeMatrixIds = await page.evaluate(() => {
        const app=window.app; app.graph.clear();
        const add=type=>{const node=window.LiteGraph.createNode(type);app.graph.add(node);return node;};
        const seed=add('ScenePrompter'),matrix=add('SceneMatrix'),expand=add('ScenePrompterExpand');
        seed.connect(0,matrix,matrix.inputs.findIndex(input=>input.name==='scene_prompt'));
        matrix.connect(0,expand,expand.inputs.findIndex(input=>input.name==='scene_prompt'));
        window.__sceneSeedRuntimeTest.tracker().captureCanvasState();
        matrix.widgets.find(widget=>widget.sceneRole==='matrix_rows').callback();
        return {matrix:matrix.id,expand:expand.id};
    });
    await page.getByRole('button',{name:'行を追加',exact:true}).click();
    await page.getByRole('button',{name:'行を追加',exact:true}).click();
    await page.getByPlaceholder('名前').nth(0).fill('Native One'); await page.getByPlaceholder('名前').nth(1).fill('Native Two');
    await page.getByRole('button',{name:'ポジティブ候補',exact:true}).nth(0).click();
    await page.getByPlaceholder('ポジティブ基本文').fill('(native prompt:1.25)');
    await page.locator('.pc-popup').last().getByRole('button',{name:'閉じる',exact:true}).click();
    await page.getByRole('button',{name:'ネガティブ候補',exact:true}).nth(1).click();
    await page.getByPlaceholder('ネガティブ基本文').fill('(native exclusion:.5)');
    await page.locator('.pc-popup').last().getByRole('button',{name:'閉じる',exact:true}).click();
    const matrixPopupBounds=await page.locator('.pc-popup').last().evaluate(element=>{
        const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,viewport:innerWidth};
    });
    assert(matrixPopupBounds.left>=0&&matrixPopupBounds.right<=matrixPopupBounds.viewport+2);
    await page.locator('.pc-popup').last().getByRole('button',{name:'閉じる',exact:true}).click();
    const matrixSnapshot=()=>page.evaluate(async ids=>{
        await new Promise(done=>setTimeout(done,150)); const node=window.app.graph.getNodeById(ids.matrix);
        const widget=node.widgets.find(widget=>widget.name==='matrix_json');
        window.app.canvas.draw(true,true);
        const lines=window.__sceneSeedRuntimeTest.matrixState(node).sets;
        const api=await window.app.graphToPrompt();
        return { names:lines.map(row=>row.name), lines,
            total:window.__sceneSeedRuntimeTest.countStats(node).total,
            api:api.output[String(ids.matrix)].inputs.matrix_json,
            raw:[widget.value,node.properties.scene_matrix_json,node.widgets_values[node.widgets.indexOf(widget)]] };
    },nativeMatrixIds);
    const matrixEdited=await matrixSnapshot(); assert.deepEqual(matrixEdited.names,['Native One','Native Two']); assert.equal(matrixEdited.total,2);
    assert.equal(matrixEdited.lines[0].positive_base,'(native prompt:1.25)');
    assert.equal(matrixEdited.lines[1].negative_base,'(native exclusion:.5)');
    assert(matrixEdited.raw.every(value=>value===matrixEdited.raw[0]));
    await page.evaluate(ids=>{
        window.app.graph.getNodeById(ids.matrix).widgets.find(widget=>widget.sceneRole==='matrix_rows').callback();
    },nativeMatrixIds);
    await page.getByRole('button',{name:'削除',exact:true}).nth(0).click();
    await page.getByRole('button',{name:'削除',exact:true}).nth(0).click();
    await page.locator('.pc-popup').last().getByRole('button',{name:'閉じる',exact:true}).click();
    const matrixEmpty=await matrixSnapshot(); assert.deepEqual(matrixEmpty.names,[]); assert.equal(matrixEmpty.total,1);
    assert(matrixEmpty.raw.every(value=>value===matrixEmpty.raw[0]));
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());
    const matrixPartialUndo=await matrixSnapshot(); assert.deepEqual(matrixPartialUndo.names,['Native Two']); assert.equal(matrixPartialUndo.total,1);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());
    const matrixUndone=await matrixSnapshot(); assert.deepEqual(matrixUndone.names,['Native One','Native Two']); assert.equal(matrixUndone.total,2);
    assert.deepEqual(matrixUndone.lines,matrixEdited.lines);
    assert(matrixUndone.raw.every(value=>value===matrixUndone.raw[0]));
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());
    const matrixPartialRedo=await matrixSnapshot(); assert.deepEqual(matrixPartialRedo.names,['Native Two']); assert.equal(matrixPartialRedo.total,1);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());
    const matrixRedone=await matrixSnapshot(); assert.deepEqual(matrixRedone.names,[]); assert.equal(matrixRedone.total,1);
    await page.evaluate(async()=>{const app=window.app;await app.loadGraphData(app.graph.serialize(),true,true);});
    const matrixReloaded=await matrixSnapshot(); assert.deepEqual(matrixReloaded.names,[]); assert.equal(matrixReloaded.total,1);
    assert(matrixReloaded.raw.every(value=>value===matrixReloaded.raw[0]));
    const staleMatrix=await page.evaluate(async({ids,drafts})=>{
        const app=window.app,oldNode=app.graph.getNodeById(ids.matrix);
        await app.loadGraphData(JSON.parse(JSON.stringify(app.graph.serialize())),true,true);
        const current=app.graph.getNodeById(ids.matrix),tracker=window.__sceneSeedRuntimeTest.tracker();
        const raw=()=>{const widget=current.widgets.find(w=>w.name==='matrix_json');return [widget.value,current.properties.scene_matrix_json,current.widgets_values[current.widgets.indexOf(widget)]];};
        const before=raw(),history=tracker.undoQueue.length;
        const committed=window.__sceneSeedRuntimeTest.commitMatrixDrafts(oldNode,drafts);
        return {sameNode:oldNode===current,committed,before,after:raw(),history,afterHistory:tracker.undoQueue.length};
    },{ids:nativeMatrixIds,drafts:matrixEdited.lines});
    assert.equal(staleMatrix.sameNode,false);assert.equal(staleMatrix.committed,false);
    assert.deepEqual(staleMatrix.after,staleMatrix.before);assert.equal(staleMatrix.afterHistory,staleMatrix.history);
    const matrixAfterStale=await matrixSnapshot();assert.deepEqual(matrixAfterStale.raw,matrixReloaded.raw);
    assert.equal(matrixAfterStale.api,matrixReloaded.api);assert.equal(matrixAfterStale.total,1);
    const matrixNoopHistory=await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undoQueue.length);
    await page.evaluate(ids=>window.app.graph.getNodeById(ids.matrix).widgets.find(widget=>widget.sceneRole==='matrix_rows').callback(),nativeMatrixIds);
    await page.locator('.pc-popup').last().getByRole('button',{name:'閉じる',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undoQueue.length),matrixNoopHistory);
    console.log('real ComfyUI Matrix ordinary DOM edit/close/delete-all Undo/Redo and reload preserve fields, weights, synchronized state and counts; unchanged close adds no history');

    await page.evaluate(async()=>{
        const response=await fetch('/scene_prompt/items',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({category:'Modal Undo Runtime',name:'Runtime modal candidate',prompt:'modal prompt',description:'Isolated undo fixture'})});
        if (!response.ok) throw new Error(await response.text());
        await window.__sceneSeedRuntimeTest.reloadCandidateItems();
    });
    const modalCandidateId=await page.evaluate(()=>{
        const app=window.app;app.graph.clear();const node=window.LiteGraph.createNode('ScenePrompter');app.graph.add(node);
        window.__sceneSeedRuntimeTest.tracker().captureCanvasState();return node.id;
    });
    const openModalCandidate=()=>page.evaluate(id=>window.__sceneSeedRuntimeTest.openCandidatePicker(id),modalCandidateId);
    const closeModalCandidate=()=>page.locator('.pc-popup').last().getByRole('button',{name:'閉じる',exact:true}).click();
    const modalCandidateSnapshot=()=>page.evaluate(async id=>{
        await new Promise(done=>setTimeout(done,100));const node=window.app.graph.getNodeById(id),widget=node.widgets.find(widget=>widget.name==='positive_json');
        const state=JSON.parse(widget.value), api=await window.app.graphToPrompt();
        return {items:Object.values(state.categories).flat(),raw:widget.value,stored:node.widgets_values[node.widgets.indexOf(widget)],
            api:api.output[String(id)].inputs.positive_json,history:window.__sceneSeedRuntimeTest.tracker().undoQueue.length};
    },modalCandidateId);
    await openModalCandidate();
    await page.locator('.pc-popup .pc-candidate input[type="checkbox"]').check();await closeModalCandidate();
    const modalSelected=await modalCandidateSnapshot();assert.equal(modalSelected.items.length,1);assert.equal(modalSelected.items[0].weight,undefined);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());assert.equal((await modalCandidateSnapshot()).items.length,0);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());assert.equal((await modalCandidateSnapshot()).items.length,1);
    await openModalCandidate();await page.locator('.pc-popup .pc-weight-input').fill('1.35');await page.locator('.pc-popup .pc-weight-input').press('Tab');await closeModalCandidate();
    const modalWeighted=await modalCandidateSnapshot();assert.equal(modalWeighted.items[0].weight,1.35);
    assert.equal(modalWeighted.raw,modalWeighted.stored);assert.equal(modalWeighted.raw,modalWeighted.api);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());assert.equal((await modalCandidateSnapshot()).items[0].weight,undefined);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());assert.equal((await modalCandidateSnapshot()).items[0].weight,1.35);
    await page.evaluate(async()=>window.app.loadGraphData(window.app.graph.serialize(),true,true));
    assert.equal((await modalCandidateSnapshot()).items[0].weight,1.35);
    await openModalCandidate();await page.locator('.pc-popup .pc-candidate input[type="checkbox"]').uncheck();await closeModalCandidate();
    assert.equal((await modalCandidateSnapshot()).items.length,0);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());assert.equal((await modalCandidateSnapshot()).items[0].weight,1.35);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());assert.equal((await modalCandidateSnapshot()).items.length,0);
    await openModalCandidate();await page.locator('.pc-popup .pc-candidate input[type="checkbox"]').check();await closeModalCandidate();
    await openModalCandidate();await page.getByRole('button',{name:'選択クリア',exact:true}).click();await closeModalCandidate();
    assert.equal((await modalCandidateSnapshot()).items.length,0);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());assert.equal((await modalCandidateSnapshot()).items.length,1);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());assert.equal((await modalCandidateSnapshot()).items.length,0);
    const modalNoop=await modalCandidateSnapshot();
    await openModalCandidate();await page.getByRole('button',{name:'選択クリア',exact:true}).click();await closeModalCandidate();
    assert.equal((await modalCandidateSnapshot()).history,modalNoop.history);
    const inactiveCandidate=await page.evaluate(async({id,state})=>{
        const oldNode=window.app.graph.getNodeById(id);
        await window.app.loadGraphData(JSON.parse(JSON.stringify(window.app.graph.serialize())),true,true);
        const tracker=window.__sceneSeedRuntimeTest.tracker(),history=tracker.undoQueue.length;
        const current=window.app.graph.getNodeById(id),oldRaw=oldNode.widgets.find(widget=>widget.name==='positive_json').value;
        const committed=window.__sceneSeedRuntimeTest.writeSelection(oldNode,state);
        return {sameNode:oldNode===current,committed,history,after:tracker.undoQueue.length,beforeRaw:oldRaw,oldRaw:oldNode.widgets.find(widget=>widget.name==='positive_json').value};
    },{id:modalCandidateId,state:JSON.parse(modalSelected.raw)});
    assert.equal(inactiveCandidate.sameNode,false);assert.equal(inactiveCandidate.committed,false);
    assert.equal(inactiveCandidate.after,inactiveCandidate.history);assert.equal(inactiveCandidate.oldRaw,inactiveCandidate.beforeRaw);
    const modalAfterStale=await modalCandidateSnapshot();assert.equal(modalAfterStale.items.length,0);
    assert.equal(modalAfterStale.raw,modalNoop.raw);assert.equal(modalAfterStale.stored,modalNoop.stored);assert.equal(modalAfterStale.api,modalNoop.api);
    console.log('real ComfyUI candidate ordinary check/uncheck/weight/clear Undo/Redo and reload preserve selection; no-op and removed-owner edits add no active history');

    failNextGeneration = true;
    const presetLLMRuntime = await page.evaluate(async () => {
        const app = window.app, field = (node, name) => node.widgets.find((widget) => widget.name === name), role = (node, name) => node.widgets.find((widget) => widget.sceneRole === name);
        app.graph.clear();
        const add = (type) => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const connect = (from, to) => from.connect(0, to, to.inputs.findIndex((input) => input.name === "scene_prompt"));
        const input = add("ScenePresetInput"), first = add("ScenePromptLLM"), second = add("ScenePromptLLM"), output = add("ScenePresetOutput");
        field(first, "description").value = "a girl with a hat"; field(second, "description").value = "a second girl with a hat";
        connect(input, first); connect(first, second); connect(second, output);
        const presetId = "runtime-llm-reference"; field(output, "preset_id").value = presetId;
        const savedResponse = await fetch("/scene_presets/save", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: presetId, name: "Native LLM Reference", output_node_id: String(output.id), api_graph: await app.graphToPrompt(), workflow: app.graph.serialize() }) });
        if (!savedResponse.ok) throw new Error((await savedResponse.json()).error);
        app.graph.clear();
        const reference = add("ScenePresetReference"), expand = add("ScenePrompterExpand");
        field(reference, "preset_id").value = presetId; connect(reference, expand);
        await window.__sceneSeedRuntimeTest.refreshPresetReference(reference);
        window.__sceneSeedRuntimeTest.updateLLMExpand(expand);
        if (role(expand, "expand_llm_generate").disabled) throw new Error("Native Reference LLM discovery disabled");
        const compactBefore = window.__sceneSeedRuntimeTest.presetSourceSnapshot();
        await role(expand, "expand_llm_generate").callback();
        const retryEnabled = !role(expand, "expand_llm_generate").disabled;
        const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "再試行");
        if (!retry || !retryEnabled) throw new Error("Failed Preset operation lost generation availability");
        retry.click();
        const retryDeadline = Date.now() + 10_000;
        while (role(expand, "expand_llm_generate").disabled) {
            if (Date.now() > retryDeadline) throw new Error("Native Preset retry did not settle");
            await new Promise((done) => setTimeout(done, 10));
        }
        const compactUnchanged = compactBefore === window.__sceneSeedRuntimeTest.presetSourceSnapshot();
        const local = JSON.parse(field(reference, "llm_presets_json").value);
        if (!local.presets?.["."]) throw new Error(`Reference commit missing: ${window.__sceneLLMRuntimeError || expand.sceneLLMStatus}`);
        const originalResponse = await fetch(`/scene_presets/load?preset_id=${presetId}`), original = await originalResponse.json();
        const untouched = original.workflow.nodes.filter((node) => node.type === "SceneApplyLora").length === 0;
        const ownerWorkflow = app.graph.serialize(), referenceId = reference.id;
        await app.loadGraphData(ownerWorkflow, true, true);
        const restoredReference = app.graph.getNodeById(referenceId);
        const retained = field(restoredReference, "llm_presets_json").value;
        await role(restoredReference, "scene_preset_edit").callback();
        const api = await app.graphToPrompt();
        const nativeLoras = app.graph._nodes.filter((node) => node.comfyClass === "SceneApplyLora");
        const prompts = app.graph._nodes.filter((node) => node.comfyClass === "ScenePromptLLM");
        const editor = { loras: nativeLoras.map((node) => api.output[String(node.id)]?.inputs), prompts: prompts.map((node) => api.output[String(node.id)]?.inputs),
            widgets: prompts.map(node => window.__sceneSeedRuntimeTest.llmWidgets(node)) };
        const editorOutput = app.graph._nodes.find((node) => node.comfyClass === "ScenePresetOutput");
        const saveReply = new Promise((resolve) => {
            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
                const response = await originalFetch(...args);
                if (String(args[0]).includes("/scene_presets/save")) {
                    window.fetch = originalFetch;
                    resolve({ ok: response.ok, data: await response.clone().json() });
                }
                return response;
            };
        });
        await role(editorOutput, "scene_preset_save").callback();
        const savedEditor = await saveReply;
        if (!savedEditor.ok) throw new Error(`Native Preset Save rejected: ${JSON.stringify(savedEditor.data)}`);
        const loadedResponse = await fetch(`/scene_presets/load?preset_id=${presetId}`), loaded = await loadedResponse.json();
        if (!loadedResponse.ok) throw new Error(loaded.error);
        await app.loadGraphData(loaded.workflow, true, true);
        const loadedAPI = await app.graphToPrompt();
        return { untouched, retained: retained === JSON.stringify(local), retryEnabled, compactUnchanged, editor,
            loadedLoras: app.graph._nodes.filter((node) => node.comfyClass === "SceneApplyLora").map((node) => loadedAPI.output[String(node.id)]?.inputs),
            loadedPrompts: app.graph._nodes.filter((node) => node.comfyClass === "ScenePromptLLM").map((node) => loadedAPI.output[String(node.id)]?.inputs),
            loadedWidgets: app.graph._nodes.filter(node => node.comfyClass === "ScenePromptLLM").map(node => window.__sceneSeedRuntimeTest.llmWidgets(node)) };
    });
    assert.equal(presetLLMRuntime.untouched, true, "Reference generation never writes the shared Preset file");
    assert.equal(presetLLMRuntime.retryEnabled, true, "failed native Reference generation restores the Generate button");
    assert.equal(presetLLMRuntime.compactUnchanged, true, "failed/retried generation never promotes full bodies into the global source list");
    assert.equal(presetLLMRuntime.retained, true, "Reference customization survives native owning-workflow reload");
    assert.equal(presetLLMRuntime.editor.loras.length, 2);
    assert.equal(presetLLMRuntime.loadedLoras.length, 2);
    presetLLMRuntime.editor.widgets.forEach((snapshot, index) => assertLLMWidgetContract(snapshot, presetLLMRuntime.editor.prompts[index]));
    presetLLMRuntime.loadedWidgets.forEach((snapshot, index) => assertLLMWidgetContract(snapshot, presetLLMRuntime.loadedPrompts[index]));
    for (const lora of [...presetLLMRuntime.editor.loras, ...presetLLMRuntime.loadedLoras]) {
        assert.equal(lora.lora_name, runtimeCandidate.lora_name); assert.equal(lora.positive, "runtime_hat"); assert.equal(lora.model_mode, "Illustrious");
    }
    for (const prompt of [...presetLLMRuntime.editor.prompts, ...presetLLMRuntime.loadedPrompts]) {
        assert.equal(prompt.positive, "1girl, hat"); assert.equal(prompt.negative, "blurry"); assert.equal(prompt.model_mode, "Illustrious");
        assert.ok(prompt.description.includes("girl")); assert.equal(JSON.parse(prompt.generation_state_json).template_version, "scene-llm-v1");
    }
    assert.equal(llmRequests.filter((request) => request.path.endsWith("/generate")).length, 4, "only standalone, failed explicit attempt, and two retried Preset LLMs generate");
    await page.waitForTimeout(300);
    assert.deepEqual(pageErrors, [], `native LLM/Preset lifecycle raised browser errors:\n${pageErrors.join("\n")}`);
    console.log("real ComfyUI instance-local Preset LLM generation, native LoRA editor widgets and explicit Save/reload passed");
    for (const change of ["disconnect", "mute-root", "bypass-middle", "replace-middle", "parallel", "unrelated"]) {
        let started, finish;
        const began = new Promise((done) => { started = done; });
        deferredGeneration = { started, pending: new Promise((done) => { finish = done; }) };
        const beforeRequests = llmRequests.length;
        await page.evaluate(async () => {
            const { app } = await import("/scripts/app.js"); app.graph.clear();
            const add = (type) => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
            const llm = add("ScenePromptLLM"), a = add("ScenePrompterQueue"), b = add("ScenePrompterQueue"), expand = add("ScenePrompterExpand");
            llm.widgets.find((widget) => widget.name === "description").value = "stale path girl";
            llm.widgets.find((widget) => widget.name === "positive").value = "";
            llm.widgets.find((widget) => widget.name === "generation_state_json").value = "{}";
            const scene = (node) => node.inputs.findIndex((input) => /^scene_prompt\d*$/.test(input.name));
            llm.connect(0, a, scene(a)); a.connect(0, b, scene(b)); b.connect(0, expand, scene(expand));
            window.__nativeRouteNodes = { llm, a, b, expand, scene };
            window.__sceneSeedRuntimeTest.updateLLMExpand(expand);
            window.__nativeRoutePromise = expand.widgets.find((widget) => widget.sceneRole === "expand_llm_generate").callback();
        });
        await began;
        await page.evaluate(async (change) => {
            const { app } = await import("/scripts/app.js"); const { a, b, expand, scene } = window.__nativeRouteNodes;
            if (change === "disconnect") b.disconnectInput(scene(b));
            if (change === "mute-root") expand.mode = 2;
            if (change === "bypass-middle") b.mode = 4;
            if (change === "replace-middle") { const replacement = window.LiteGraph.createNode("ScenePrompterQueue"); replacement.id = b.id; replacement.graph = app.graph; replacement.inputs = b.inputs; replacement.outputs = b.outputs; app.graph._nodes[app.graph._nodes.indexOf(b)] = replacement; app.graph._nodes_by_id[b.id] = replacement; }
            if (change === "parallel") a.connect(0, b, b.inputs.findIndex((input) => input.name === "scene_prompt2"));
            if (change === "unrelated") { const extra = window.LiteGraph.createNode("ScenePrompterQueue"); app.graph.add(extra); extra.connect(0, a, a.inputs.findIndex((input) => input.name === "scene_prompt2")); }
        }, change);
        deferredGeneration = null; finish();
        const result = await page.evaluate(async () => { await window.__nativeRoutePromise; const { llm } = window.__nativeRouteNodes; return { positive: llm.widgets.find(widget=>widget.name==='positive').value, status: llm.sceneLLMStatus }; });
        assert.equal(result.positive, change === "unrelated" ? "1girl, hat" : "", `native ${change}: ${result.status}`);
        if (change !== "unrelated") assert.equal(llmRequests.length - beforeRequests, 1, "native stale route stops before LoRA search");
    }
    console.log("real ComfyUI deferred routing changes reject stale output and allow unrelated branch edits");

    const seedNodes = await page.evaluate(async () => {
        window.app.graph.clear();
        const add = (type) => {
            const node = window.LiteGraph.createNode(type);
            if (!node) throw new Error(`Missing native node ${type}`);
            window.app.graph.add(node);
            return node;
        };
        const scene = add("ScenePrompter");
        const expand = add("ScenePrompterExpand");
        const text = add("ScenePromptToText");
        const deletion = add("ScenePromptDelete");
        const encoder = add("CLIPTextEncode");
        const sampler = add("KSampler");
        const decode = add("VAEDecode");
        const save = add("SceneSaveImage");
        const connect = (from, output, to, input) => {
            const link = from.connect(from.outputs.findIndex((slot) => slot.name === output),
                to, to.inputs.findIndex((slot) => slot.name === input));
            if (!link) throw new Error(`Cannot connect ${output} to ${input}`);
        };
        scene.connect(0, deletion, deletion.inputs.findIndex((slot) => slot.name === "scene_prompt"));
        deletion.connect(0, expand, expand.inputs.findIndex((slot) => slot.name === "scene_prompt"));
        deletion.connect(0, text, text.inputs.findIndex((slot) => slot.name === "scene_prompt"));
        text.connect(0, encoder, encoder.inputs.findIndex((slot) => slot.name === "text"));
        encoder.connect(0, sampler, sampler.inputs.findIndex((slot) => slot.name === "positive"));
        sampler.connect(0, decode, decode.inputs.findIndex((slot) => slot.name === "samples"));
        decode.connect(0, save, save.inputs.findIndex((slot) => slot.name === "images"));
        // Keep Expand on the saved image's execution path without linking its seed.
        connect(expand, "メタ情報", save, "scene_info");
        sampler.widgets.find((widget) => widget.name === "seed").value = 123;
        const control = sampler.widgets.find((widget) => widget.name === "control_after_generate");
        if (!control) throw new Error("Missing native seed control");
        control.value = "randomize";
        // Freeze the native lifecycle to verify Scene's submission hook itself.
        control.beforeQueued = () => {};
        control.afterQueued = () => {};
        await window.app.queuePrompt(0, 1);
        await window.app.queuePrompt(0, 1);
        await window.__sceneSeedRuntimeTest.queueBatch(expand);
        return { textId: text.id, expandId: expand.id, deleteId: deletion.id, visible: text.widgets.filter(widget => !widget.hidden).map(widget => widget.name), deleteVisible: deletion.widgets.filter(widget => !widget.hidden).map(widget => widget.name), samplerId: sampler.id, seedIndex: sampler.widgets.findIndex((widget) => widget.name === "seed") };
    });
    assert.equal(seedRequests.length, 5, "two normal submissions and three batch submissions reach the API");
    assert.deepEqual(seedNodes.visible, ["scope"]);
    assert.deepEqual(seedNodes.deleteVisible, ["positive", "negative"]);
    for (const [index, request] of seedRequests.entries()) {
        const text = request.prompt[String(seedNodes.textId)];
        const expand = request.prompt[String(seedNodes.expandId)];
        assert.equal(text.inputs.seed_base, expand.inputs.seed_base);
        assert.equal(text.inputs.seed_base_literal, false);
        assert.equal(text.inputs.current_index, index < 3 ? 0 : index - 2);
        if (index >= 3) {
            assert.equal(text.inputs.scene_prompt, undefined);
            assert.equal(request.prompt[String(seedNodes.deleteId)], undefined);
        }
    }
    const sentSeeds = seedRequests.map((request) => {
        const seed = request.prompt[String(seedNodes.samplerId)].inputs.seed;
        assert.ok(Number.isSafeInteger(seed));
        assert.notEqual(seed, 123, "the original literal seed must not be reused");
        const workflow = request.extra_data.extra_pnginfo.workflow;
        const node = workflow.nodes.find((entry) => String(entry.id) === String(seedNodes.samplerId));
        assert.equal(node.widgets_values[seedNodes.seedIndex], seed, "saved workflow matches the submitted sampler seed");
        return seed;
    });
    assert.equal(new Set(sentSeeds).size, 5, "normal Queue, first snapshot, and cached repeats receive fresh seeds");
    await page.waitForTimeout(300);
    assert.deepEqual(pageErrors, [], `complete native harness raised browser errors:\n${pageErrors.join("\n")}`);
    console.log("real ComfyUI normal Queue and cached batch sampler seed submissions passed");

    const servicesBeforeSettings = llmRequests.length;
    const generationsBeforeSettings = llmRequests.filter(request=>request.path.endsWith('/generate')).length;
    const initialLLMSettings = await page.evaluate(async () => await (await fetch('/scene_prompt/llm/settings')).json());
    const nativeSettingsNode = await page.evaluate(async () => {
        const { app } = await import("/scripts/app.js"); app.graph.clear();
        const llm = window.LiteGraph.createNode("ScenePromptLLM"); app.graph.add(llm);
        const names = ["model_mode", "description", "positive", "negative", "generation_state_json"];
        const values = ["Anima", "saved description", "saved positive", "saved negative", '{"fixture":true}'];
        names.forEach((name, index) => { llm.widgets.find(widget => widget.name === name).value = values[index]; });
        const before = window.__sceneSeedRuntimeTest.llmWidgets(llm), id = llm.id;
        await app.loadGraphData(app.graph.serialize(), true, true);
        const restored = app.graph.getNodeById(id);
        await restored.widgets.find(widget=>widget.sceneRole==='llm_settings').callback();
        return { id, inputs: Object.fromEntries(names.map((name, index) => [name, values[index]])), before,
            after: window.__sceneSeedRuntimeTest.llmWidgets(restored) };
    });
    assertLLMWidgetContract(nativeSettingsNode.before, nativeSettingsNode.inputs);
    assertLLMWidgetContract(nativeSettingsNode.after, nativeSettingsNode.inputs);
    const llmSettings = page.getByRole('dialog',{name:'LLM接続設定',exact:true});
    await llmSettings.getByRole('button',{name:'保存',exact:true}).waitFor();
    assert.equal(await llmSettings.getByRole('button', { name: /API Key.*削除/u }).count(), 0);
    assert.deepEqual(await llmSettings.locator('input').evaluateAll(inputs=>inputs.map(input=>input.name)), ['base_url','port','model','api_key']);
    assert.equal(await llmSettings.locator('input[name="base_url"]').evaluate(input=>input.required),true);
    assert.equal(await llmSettings.locator('.pc-required-star').evaluate(star=>getComputedStyle(star).color),'rgb(255, 91, 91)');
    assert(await llmSettings.locator('form').evaluate(form=>parseFloat(getComputedStyle(form).paddingTop))>=20);
    async function saveNativeLLMSettings() {
        const completed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/scene_prompt/llm/settings') && response.request().method() === 'POST');
        await llmSettings.getByRole('button', { name: '保存', exact: true }).click();
        const response = await completed;
        assert.equal(response.ok(), true);
        assert.deepEqual(Object.keys(response.request().postDataJSON()).sort(), ['api_key', 'base_url', 'model', 'port']);
        await llmSettings.getByText('保存しました', { exact: true }).waitFor();
        return response.json();
    }
    const persistedConnection = { base_url: 'http://127.0.0.1/proxy/v1', port: 9417, model: 'native-persisted-model' };
    await llmSettings.locator('input[name="base_url"]').fill(persistedConnection.base_url);
    await llmSettings.locator('input[name="port"]').fill(String(persistedConnection.port));
    await llmSettings.locator('input[name="model"]').fill(persistedConnection.model);
    const savedConnection = await saveNativeLLMSettings();
    assert.deepEqual(Object.fromEntries(Object.keys(persistedConnection).map(name => [name, savedConnection[name]])), persistedConnection);
    assert.equal(savedConnection.api_key_set, initialLLMSettings.api_key_set, 'blank key preserves the backend key flag');
    const privateConnection = JSON.parse(await readFile(resolve(directory, 'user', 'default', 'scene_prompt_tools', 'llm_settings.json'), 'utf8'));
    assert.deepEqual(Object.fromEntries(Object.keys(persistedConnection).map(name => [name, privateConnection[name]])), persistedConnection,
        'the real backend atomically persisted URL, nondefault port and model to its private fixture file');
    await page.keyboard.press('Escape');
    await page.evaluate(id => window.app.graph.getNodeById(id).widgets[0].callback(), nativeSettingsNode.id);
    await llmSettings.getByRole('button', { name: '保存', exact: true }).waitFor();
    assert.deepEqual(await llmSettings.locator('input').evaluateAll(inputs => inputs.map(input => input.value)),
        [persistedConnection.base_url, String(persistedConnection.port), persistedConnection.model, ''], 'native settings close and reopen retain the real saved connection');
    const reopenedConnection = await page.evaluate(async () => await (await fetch('/scene_prompt/llm/settings')).json());
    assert.deepEqual(Object.fromEntries(Object.keys(persistedConnection).map(name => [name, reopenedConnection[name]])), persistedConnection);
    assert.equal(Object.hasOwn(reopenedConnection, 'api_key'), false, 'settings GET exposes only the saved-key flag');
    await llmSettings.locator('input[name="model"]').fill('');
    await llmSettings.locator('input[name="port"]').fill('');
    const savedLLMSettings = await saveNativeLLMSettings();
    assert.equal(savedLLMSettings.model,''); assert.equal(savedLLMSettings.port,null);
    assert.equal(savedLLMSettings.civitai_api_key_set,undefined);
    await page.keyboard.press('Escape');
    await page.evaluate(id => window.app.graph.getNodeById(id).widgets[0].callback(), nativeSettingsNode.id);
    await llmSettings.getByRole('button', { name: '保存', exact: true }).waitFor();
    assert.equal(await llmSettings.locator('input[name="port"]').inputValue(), '', 'the native saved protocol-default port stays blank on reopen');
    assert.equal(await llmSettings.locator('input[name="model"]').inputValue(), '');
    await llmSettings.getByRole('button',{name:'接続テスト・モデル取得'}).click();
    await llmSettings.getByText('接続成功: settings-fixture',{exact:true}).waitFor();
    await page.setViewportSize({width:360,height:740});
    assert.equal(await llmSettings.evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    await llmSettings.locator('input[name="base_url"]').fill(initialLLMSettings.base_url);
    await llmSettings.locator('input[name="port"]').fill(initialLLMSettings.port == null ? '' : String(initialLLMSettings.port));
    await llmSettings.locator('input[name="model"]').fill(initialLLMSettings.model);
    const restoredConnection = await saveNativeLLMSettings();
    assert.deepEqual(Object.fromEntries(['base_url', 'port', 'model'].map(name => [name, restoredConnection[name]])),
        Object.fromEntries(['base_url', 'port', 'model'].map(name => [name, initialLLMSettings[name]])), 'native tests restore their original endpoint and model before subsequent cases');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1280,height:720});
    await fetch(`${url}/scene_test/civitai_lookup`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:'picker'}) });
    nativeCivitaiGallery = true;
    const queryOnlyLora = await page.evaluate(async()=>{
        const { app }=await import('/scripts/app.js');
        const lora=window.LiteGraph.createNode('SceneApplyLora'); app.graph.add(lora);
        lora.properties.scene_civitai={query:'hat'};
        await lora.widgets.find(widget=>widget.sceneRole==='lora_select').callback();
        return lora.id;
    });
    const queryOnlyPicker=page.getByRole('dialog',{name:'LoRAを選択',exact:true});
    await queryOnlyPicker.waitFor();
    assert.equal(await page.getByRole('dialog',{name:'Civitai Search',exact:true}).count(),0,'query-only history opens the local picker');
    await queryOnlyPicker.getByRole('button',{name:'Civitai Search',exact:true}).click();
    const nativeSearch=page.getByRole('dialog',{name:'Civitai Search',exact:true});
    await nativeSearch.locator('.pc-civitai-card').first().waitFor();
    assert.equal(await nativeSearch.locator('.pc-civitai-status').textContent(), '', 'query-only search state is not a selected LoRA');
    assert.doesNotMatch(await nativeSearch.textContent(), /undefined/);
    await page.setViewportSize({width:1600,height:950});
    assert.equal(await nativeSearch.locator('.pc-civitai-card').count(),12);
    const nativeCardRows=await nativeSearch.locator('.pc-civitai-card').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));
    assert(nativeCardRows.slice(0,10).every(top=>top===nativeCardRows[0])); assert(nativeCardRows[10]>nativeCardRows[0]);
    await page.screenshot({path:resolve(screenshotDirectory,'native-ten-columns.png')});
    const nativeSearchRequests=llmRequests.length;
    await nativeSearch.locator('.pc-civitai-card').first().focus(); await page.keyboard.press('Enter');
    assert.equal(await nativeSearch.locator('.pc-civitai-gallery img').count(),2);
    assert.match(await nativeSearch.locator('.pc-civitai-metadata').textContent(),/Native model description.*2026-08-02.*Model Stats.*90.*Version Stats.*12/s);
    await page.screenshot({path:resolve(screenshotDirectory,'native-details.png')});
    await nativeSearch.getByRole('button',{name:'Next',exact:true}).click();
    assert.equal(await nativeSearch.locator('.pc-civitai-gallery img').count(),1);
    await nativeSearch.getByRole('button',{name:'戻る',exact:true}).click();
    assert.equal(llmRequests.length,nativeSearchRequests,'native Back makes no request');
    await page.setViewportSize({width:360,height:740});
    assert.equal(await nativeSearch.evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    assert.equal(await nativeSearch.locator('.pc-civitai-results').evaluate(list=>list.scrollWidth>list.clientWidth),true);
    await page.screenshot({path:resolve(screenshotDirectory,'native-narrow.png')});
    await page.setViewportSize({width:1280,height:720});

    assert.equal(await nativeSearch.getByRole('button',{name:'Civitai設定',exact:true}).count(),0);
    assert.equal(await page.getByRole('dialog',{name:'Civitai設定',exact:true}).count(),0);
    assert.equal(await page.evaluate(async()=> 'openCivitaiSettings' in await import('/extensions/scene-prompt-tools-browser-smoke/scene_prompt_civitai.js')),false);
    await page.keyboard.press('Escape');
    await page.evaluate(async id=>{
        const node=window.app.graph.getNodeById(id);
        node.properties.scene_civitai={query:'hat',lora_name:'runtime-hat.safetensors',model_id:1,version_id:2,file_id:3};
        node.widgets.find(widget=>widget.name==='lora_name').value='runtime-hat.safetensors';
        await node.widgets.find(widget=>widget.sceneRole==='lora_select').callback();
    },queryOnlyLora);
    await page.getByRole('dialog',{name:'Civitai Search',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(async id=>{
        const node=window.app.graph.getNodeById(id);
        node.widgets.find(widget=>widget.name==='lora_name').value='runtime-local.safetensors';
        await node.widgets.find(widget=>widget.sceneRole==='lora_select').callback();
    },queryOnlyLora);
    await queryOnlyPicker.waitFor();
    assert.equal(await page.getByRole('dialog',{name:'Civitai Search',exact:true}).count(),0,'manual local B after Civitai A opens local picker');
    assert.equal(await page.evaluate(id=>window.app.graph.getNodeById(id).properties.scene_civitai.lora_name,queryOnlyLora),'runtime-hat.safetensors','manual selection retains provenance history');
    await page.keyboard.press('Escape');
    nativeCivitaiGallery = false;
    assert.equal(llmRequests.length-servicesBeforeSettings,2,'the two intentional search openings request only public Civitai results');
    assert.equal(llmRequests.filter(request=>request.path.endsWith('/generate')).length,generationsBeforeSettings,'settings never request inference');
    assert(settingsRequests.includes('/scene_prompt/llm/settings'));
    assert(!settingsRequests.includes('/scene_prompt/civitai/settings'));
    const retiredSettingsStatuses=await page.evaluate(async()=>[
        (await fetch('/scene_prompt/civitai/settings')).status,
        (await fetch('/scene_prompt/civitai/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,
    ]);
    assert.equal(retiredSettingsStatuses[0],404);
    assert([404,405].includes(retiredSettingsStatuses[1]),'removed POST route may fall through to ComfyUI static GET handling');
    assert.deepEqual(await page.evaluate(async()=>await(await fetch('/scene_test/model_executions')).json()),[]);
    assert.deepEqual(pageErrors,[]);
    console.log('real ComfyUI four-field LLM settings, anonymous Civitai search and absent Civitai settings passed');

    const metadataBefore = { prompts: seedRequests.length, runs: runRequests.length, services: llmRequests.length };
    assert.equal((await fetch(`${url}/scene_test/civitai_lookup`, { method: "POST", body: JSON.stringify({ mode: "found" }), headers: { "Content-Type": "application/json" } })).status, 200);
    const metadataNodes = await page.evaluate(async () => {
        const { app } = await import("/scripts/app.js"); app.graph.clear();
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const lora = window.LiteGraph.createNode("SceneApplyLora"); app.graph.add(lora);
        field(lora, "lora_name").value = "runtime-hat.safetensors";
        field(lora, "positive").value = "manual trigger";
        field(lora, "negative").value = "manual negative";
        const expand = window.LiteGraph.createNode("ScenePrompterExpand"); app.graph.add(expand);
        const model = window.LiteGraph.createNode("SceneApplyModel"); app.graph.add(model);
        const checkpoint = window.LiteGraph.createNode("CheckpointLoaderSimple"); app.graph.add(checkpoint);
        field(checkpoint, "ckpt_name").value = "runtime-checkpoint.safetensors";
        for (const [slot, name] of [[0, "model"], [1, "clip"], [2, "vae"]]) checkpoint.connect(slot, model, model.inputs.findIndex(input => input.name === name));
        model.connect(0, lora, lora.inputs.findIndex(input => input.name === "scene_prompt"));
        lora.connect(0, expand, expand.inputs.findIndex(input => input.name === "scene_prompt"));
        const before = lora.serialize().widgets_values;
        await lora.widgets.find(widget => widget.sceneRole === "lora_details").callback();
        return { lora: lora.id, expand: expand.id, before };
    });
    const nativeDetail = page.getByRole("dialog", { name: "LoRA 詳細確認", exact: true });
    await nativeDetail.getByText("Native metadata / Fixture v1", { exact: true }).waitFor();
    assert.equal(await nativeDetail.getByRole("link", { name: "Civitaiで見る" }).getAttribute("href"), "https://civitai.red/models/12?modelVersionId=23");
    assert.deepEqual(await page.evaluate(id => window.app.graph.getNodeById(id).serialize().widgets_values, metadataNodes.lora), metadataNodes.before);
    await nativeDetail.locator(".pc-lora-word").filter({ hasText: "native_metadata_trigger" }).getByRole("button", { name: "注入" }).click();
    assert.deepEqual(await page.evaluate(id => {
        const node = window.app.graph.getNodeById(id);
        return [node.widgets.find(widget => widget.name === "lora_name").value, node.widgets.find(widget => widget.name === "positive").value, node.widgets.find(widget => widget.name === "negative").value];
    }, metadataNodes.lora), ["runtime-hat.safetensors", "manual trigger, native_metadata_trigger", "manual negative"]);
    await page.keyboard.press("Escape");
    const lookupsBeforeResources = metadataRequests.length;
    await page.evaluate(id => window.app.graph.getNodeById(id).widgets.find(widget => widget.sceneRole === "expand_resources").callback(), metadataNodes.expand);
    const nativeResources = page.getByRole("dialog", { name: "生成情報", exact: true });
    const nativeModelCard = nativeResources.locator(".pc-resource-card").filter({ hasText: "runtime-checkpoint.safetensors" });
    await nativeModelCard.getByRole("button", { name: "Civitaiを確認" }).waitFor();
    assert.equal(metadataRequests.length, lookupsBeforeResources, "opening resource information does not start a hash metadata lookup");
    await fetch(`${url}/scene_test/civitai_lookup`, { method: "POST", body: JSON.stringify({ mode: "error" }), headers: { "Content-Type": "application/json" } });
    await nativeModelCard.getByRole("button", { name: "Civitaiを確認" }).click();
    await nativeModelCard.getByText("Metadata fixture offline", { exact: false }).waitFor();
    await fetch(`${url}/scene_test/civitai_lookup`, { method: "POST", body: JSON.stringify({ mode: "found" }), headers: { "Content-Type": "application/json" } });
    await nativeModelCard.getByRole("button", { name: "Civitaiを確認" }).click();
    await nativeModelCard.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await nativeModelCard.getByRole("link", { name: "Civitaiで見る" }).getAttribute("href"), "https://civitai.red/models/12?modelVersionId=23");
    await page.keyboard.press("Escape");
    await fetch(`${url}/scene_test/civitai_lookup`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({mode:"fallback"}) });
    const fallbackResult = await (await fetch(`${url}/scene_prompt/civitai/by-hash?sha256=${"a".repeat(64)}`)).json();
    assert.equal(fallbackResult.found,true,'fresh native by-hash route falls back to com after red fails');
    await fetch(`${url}/scene_test/civitai_lookup`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({mode:"picker"}) });
    await page.evaluate(id=>window.app.graph.getNodeById(id).widgets.find(widget=>widget.sceneRole==='lora_select').callback(),metadataNodes.lora);
    const nativePicker=page.getByRole('dialog',{name:'LoRAを選択',exact:true});
    await nativePicker.locator('.pc-lora-row').filter({hasText:'runtime-local.safetensors'}).locator('.pc-lora-source').getByText('Local',{exact:true}).waitFor();
    await nativePicker.locator('.pc-lora-row').filter({hasText:'runtime-unknown.safetensors'}).locator('.pc-lora-source').getByText('再確認',{exact:true}).waitFor();
    assert.equal(await nativePicker.locator('.pc-lora-row').filter({hasText:'runtime-local.safetensors'}).locator('.pc-lora-title').textContent(),'runtime-local.safetensors');
    assert.equal(await nativePicker.locator('.pc-lora-row').filter({hasText:'runtime-unknown.safetensors'}).locator('.pc-lora-title').textContent(),'runtime-unknown.safetensors');
    assert.equal(await nativePicker.locator('.pc-lora-row').filter({hasText:'runtime-hat.safetensors'}).locator('.pc-lora-title').textContent(),'Native metadata');
    assert.deepEqual(await nativePicker.locator('.pc-lora-head-actions button').allTextContents(),['Civitai Search','閉じる']);
    await page.screenshot({path:resolve(screenshotDirectory,'native-local-fallback.png')});
    await page.setViewportSize({width:360,height:740});
    assert.equal(await nativePicker.getByRole('button',{name:'閉じる',exact:true}).evaluate(button=>button.getBoundingClientRect().right<=innerWidth),true);
    await page.screenshot({path:resolve(screenshotDirectory,'native-local-narrow.png')});
    await page.setViewportSize({width:1280,height:720});
    await page.keyboard.press('Escape');
    await fetch(`${url}/scene_test/civitai_lookup`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({mode:"found"}) });
    const directResult = await (await fetch(`${url}/scene_prompt/civitai/by-hash?sha256=${"a".repeat(64)}`)).json();
    assert.deepEqual(directResult, { found: true, version: { id: 23, modelId: 12, name: "Fixture v1", model: { name: "Native metadata" }, trainedWords: ["native_metadata_trigger"] } });
    await fetch(`${url}/scene_test/civitai_lookup`, { method: "POST", body: JSON.stringify({ mode: "missing" }), headers: { "Content-Type": "application/json" } });
    assert.deepEqual(await (await fetch(`${url}/scene_prompt/civitai/by-hash?sha256=${"a".repeat(64)}`)).json(), { found: false, version: null });
    assert(metadataRequests.length >= lookupsBeforeResources + 2);
    assert(metadataRequests.every(request => request.method === "GET" && /^[a-fA-F0-9]{64}$/u.test(new URL(request.url).searchParams.get("sha256"))));
    assert.deepEqual(directCivitaiRequests, [], "native metadata never requests the provider directly from the browser");
    assert.deepEqual({ prompts: seedRequests.length, runs: runRequests.length, services: llmRequests.length }, metadataBefore,
        "metadata-only dialogs never queue, prepare a run, infer or download weights");
    assert.deepEqual(await (await fetch(`${url}/scene_test/model_executions`)).json(), []);

    }
    nativeRunChecks = true;
    const switchEditor = await page.evaluate(async () => {
        const app = window.app; app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); if (!node) throw new Error(`Missing native ${type}`); app.graph.add(node); return node; };
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const link = (from, slot, to, name, type = 'SCENE_PROMPT') => {
            if (!to.inputs.some(input => input.name === name)) to.addInput(name, type, { widget: { name } });
            if (!from.connect(slot, to, to.inputs.findIndex(input => input.name === name))) throw new Error(`Native connection failed: ${from.type}[${slot}] -> ${to.type}.${name}`);
        };
        const input = add('ScenePresetInput'), off = add('ScenePrompter'), on = add('ScenePrompter');
        const offCount = add('ScenePromptCounter'), onCount = add('ScenePromptCounter'), select = add('ComfySwitchNode'), output = add('ScenePresetOutput');
        off.title = 'browser_false'; on.title = 'browser_true';
        field(off, 'prompt_name').value = 'browser_false'; field(off, 'positive_base').value = 'browser_false'; field(off, 'randomize').value = false;
        field(on, 'prompt_name').value = 'browser_true'; field(on, 'positive_base').value = 'browser_true'; field(on, 'randomize').value = false;
        field(offCount, 'count').value = 2; field(onCount, 'count').value = 3;
        field(offCount, 'enable_downstream_count').value = true; field(onCount, 'enable_downstream_count').value = true;
        field(output, 'preset_id').value = 'browser-native-switch'; field(output, 'preset_name').value = 'Native switch names';
        link(input, 0, off, 'scene_prompt'); link(input, 0, on, 'scene_prompt');
        link(off, 0, offCount, 'scene_prompt'); link(on, 0, onCount, 'scene_prompt');
        link(offCount, 0, select, 'on_false'); link(onCount, 0, select, 'on_true');
        link(input, 3, select, 'switch', 'BOOLEAN'); link(select, 0, output, 'scene_prompt');
        const ids = { input: input.id, select: select.id, output: output.id };
        await app.loadGraphData(app.graph.serialize(), true, true);
        window.__sceneSeedRuntimeTest.tracker().captureCanvasState();
        return ids;
    });
    const openSwitchModal = (id, kind) => page.evaluate(({ id, kind }) => {
        const node = window.app.graph.getNodeById(id);
        node.widgets.find(widget => widget.sceneRole === `preset_switch_${kind}`).callback();
    }, { id, kind });
    const namesModal = page.locator('[data-scene-preset-switch-modal="names"]');
    const settingsModal = page.locator('[data-scene-preset-switch-modal="settings"]');
    const inputSwitchSnapshot = id => page.evaluate(async id => {
        const node = window.app.graph.getNodeById(id), prompt = await window.app.graphToPrompt();
        return { ports: node.outputs.map(output => ({ name: output.name, type: output.type, label: output.label })),
            inputNames: node.inputs.map(input => input.name), raw: node.widgets.find(widget => widget.name === 'switch_names_json').value,
            serialized: node.serialize(), api: prompt.output[String(id)]?.inputs,
            history: window.__sceneSeedRuntimeTest.tracker().undoQueue.length };
    }, id);
    const switchBeforeNames = await inputSwitchSnapshot(switchEditor.input);
    assert.deepEqual(switchBeforeNames.ports.map(port => port.name), ['scene_prompt', ...Array.from({ length: 10 }, (_, index) => `switch_${index + 1}`), 'switches']);
    assert.deepEqual(switchBeforeNames.ports.map(port => port.type), ['SCENE_PROMPT', ...Array(10).fill('BOOLEAN'), 'SCENE_SWITCHES']);
    assert(!switchBeforeNames.inputNames.includes('switch_values'), 'internal binding never appears as a user socket');
    await openSwitchModal(switchEditor.input, 'names');
    assert.equal(await namesModal.locator('input[data-scene-switch-index]').count(), 10);
    const longSwitchName = '非常に長い日本語のスイッチ名：髪色と衣装と背景の選択をまとめて切り替える';
    for (const [index, value] of [[1, '入口'], [2, '同名'], [3, '同名'], [4, ''], [5, longSwitchName]])
        await namesModal.locator(`[data-scene-switch-index="${index}"]`).fill(value);
    await namesModal.screenshot({ path: resolve(screenshotDirectory, 'native-preset-switch-names.png') });
    assert.equal((await inputSwitchSnapshot(switchEditor.input)).raw, switchBeforeNames.raw, 'editing a modal only changes its draft');
    const nativeSwitchErrors = await page.locator('[role="dialog"][aria-labelledby="global-error"]').allTextContents();
    assert.deepEqual(nativeSwitchErrors, [], 'native switch editor load/API error: ' + JSON.stringify(nativeSwitchErrors));
    await namesModal.locator('[data-scene-switch-save="names"]').click();
    const switchNamed = await inputSwitchSnapshot(switchEditor.input);
    assert.deepEqual(switchNamed.ports.slice(1, 6).map(port => port.label), ['入口', '同名', '同名', 'スイッチ4', longSwitchName]);
    assert.equal(switchNamed.history, switchBeforeNames.history + 1, 'one modal save owns one native history transaction');
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undo());
    assert.equal((await inputSwitchSnapshot(switchEditor.input)).raw, switchBeforeNames.raw);
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().redo());
    assert.equal((await inputSwitchSnapshot(switchEditor.input)).raw, switchNamed.raw);
    await openSwitchModal(switchEditor.input, 'names');
    assert.equal(await namesModal.locator('[data-scene-switch-index="3"]').inputValue(), '同名');
    await namesModal.locator('[data-scene-switch-save="names"]').click();
    assert.equal((await inputSwitchSnapshot(switchEditor.input)).history, switchNamed.history, 'a no-op save adds no history');
    await openSwitchModal(switchEditor.input, 'names');
    await namesModal.locator('[data-scene-switch-index="1"]').fill('閉じると破棄');
    await namesModal.getByRole('button', { name: '閉じる', exact: true }).click();
    assert.equal((await inputSwitchSnapshot(switchEditor.input)).raw, switchNamed.raw);
    await page.evaluate(id => {
        const app = window.app, node = app.graph.getNodeById(id);
        app.graph._nodes.forEach((other, index) => { other.pos = other === node ? [540, 100] : [1800 + index * 300, 100]; });
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0]; app.canvas.draw(true, true);
    }, switchEditor.input);
    await page.screenshot({ path: resolve(screenshotDirectory, 'native-preset-switch-input-ports.png') });
    const switchSaved = await page.evaluate(async ids => {
        const app = window.app, input = app.graph.getNodeById(ids.input), clone = input.clone();
        const prompt = await app.graphToPrompt();
        const response = await fetch('/scene_presets/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            preset_id: 'browser-native-switch', name: 'Native switch names', output_node_id: String(ids.output), api_graph: prompt, workflow: app.graph.serialize(),
        }) });
        const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
        const restoredResponse = await fetch('/scene_presets/load?preset_id=browser-native-switch');
        const restored = await restoredResponse.json(); if (!restoredResponse.ok) throw new Error(JSON.stringify(restored));
        return { clonePorts: clone.outputs.map(output => ({ name: output.name, label: output.label })),
            cloneNames: clone.widgets.find(widget => widget.name === 'switch_names_json').value,
            switchInputs: prompt.output[String(ids.select)].inputs, restored };
    }, switchEditor);
    assert.deepEqual(switchSaved.switchInputs.switch, [String(switchEditor.input), 3]);
    assert.equal(switchSaved.cloneNames, switchNamed.raw);
    assert.deepEqual(switchSaved.clonePorts, switchNamed.ports.map(({ name, label }) => ({ name, label })));
    await page.evaluate(async workflow => window.app.loadGraphData(workflow, true, true), switchSaved.restored.workflow);
    assert.equal((await inputSwitchSnapshot(switchEditor.input)).raw, switchNamed.raw, 'actual saved Preset workflow restores names');

    const switchLive = await page.evaluate(async () => {
        const app = window.app; app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const link = (from, slot, to, name) => { if (!from.connect(slot, to, to.inputs.findIndex(input => input.name === name))) throw new Error(`Cannot connect ${name}`); };
        const input = add('ScenePresetInput'), first = add('ScenePresetReference'), second = add('ScenePresetReference');
        const queue = add('ScenePrompterQueue'), count = add('ScenePromptCounter'), expand = add('ScenePrompterExpand');
        field(queue, 'order_mode').value = 'input_order'; field(queue, 'alternate_block_size').value = 1;
        field(queue, 'downstream_count_mode').value = 'multiply'; field(queue, 'input_repeats_json').value = '{}';
        field(input, 'switch_names_json').value = '["親の入口", "親の予備"]'; field(input, 'switch_names_json').callback?.();
        input.properties.scene_switch_values = [true, false, false, false, false, false, false, false, false, false];
        for (const node of [first, second]) { field(node, 'preset_id').value = 'browser-native-switch'; field(node, 'switch_settings_json').value = '[]'; await window.__sceneSeedRuntimeTest.refreshPresetReference(node); }
        link(input, 11, second, 'switches'); link(input, 0, second, 'scene_prompt');
        link(first, 0, queue, 'scene_prompt1'); link(second, 0, queue, 'scene_prompt2');
        field(count, 'count').value = 2; field(count, 'enable_downstream_count').value = true;
        link(queue, 0, count, 'scene_prompt'); link(count, 0, expand, 'scene_prompt');
        const ids = Object.fromEntries(Object.entries({ input, first, second, queue, count, expand }).map(([name, node]) => [name, node.id]));
        await app.loadGraphData(app.graph.serialize(), true, true);
        for (const id of [ids.first, ids.second]) await window.__sceneSeedRuntimeTest.refreshPresetReference(app.graph.getNodeById(id));
        window.__sceneSeedRuntimeTest.tracker().captureCanvasState();
        return ids;
    });
    const switchPlanSnapshot = () => page.evaluate(async ids => {
        const app = window.app, { api } = await import('/scripts/api.js'), current = name => app.graph.getNodeById(ids[name]);
        app.graph.setDirtyCanvas(true, true); app.canvas.draw(true, true); await new Promise(done => setTimeout(done, 250)); app.canvas.draw(true, true);
        const stats = window.__sceneSeedRuntimeTest.countStats(current('count')), prompt = await app.graphToPrompt();
        const response = await api.fetchApi('/scene_prompt/runs/prepare', { method: 'POST', body: JSON.stringify({ api_graph: prompt, workflow: prompt.workflow, expand_node_id: String(ids.expand) }) });
        const prepared = await response.json(); if (!response.ok) throw new Error(JSON.stringify(prepared));
        await api.fetchApi('/scene_prompt/runs/release', { method: 'POST', body: JSON.stringify({ run_handle: prepared.run_handle }) });
        return { total: stats.total, error: stats.error, prepared: prepared.total_batches,
            preview: window.__sceneSeedRuntimeTest.countPreview(current('count')),
            firstTotal: window.__sceneSeedRuntimeTest.countStats(current('first')).total,
            secondTotal: window.__sceneSeedRuntimeTest.countStats(current('second')).total,
            displayed: current('expand').widgets.find(widget => widget.sceneRole === 'expand_total_count')?.sceneTotalCount,
            settings: current('second').widgets.find(widget => widget.name === 'switch_settings_json').value,
            names: current('input').widgets.find(widget => widget.name === 'switch_names_json').value,
            api: prompt.output, history: window.__sceneSeedRuntimeTest.tracker().undoQueue.length };
    }, switchLive);
    const switchIdentity = await switchPlanSnapshot();
    assert.equal(switchIdentity.error, undefined, JSON.stringify(switchIdentity));
    assert.equal(switchIdentity.total, 8, JSON.stringify(switchIdentity)); assert.equal(switchIdentity.prepared, 8); assert.equal(switchIdentity.displayed, 8);
    assert.deepEqual(switchIdentity.preview, Array(8).fill('Scene Prompt'), 'compact Preset preview retains its existing generic labels');
    assert.equal(switchIdentity.firstTotal, 2); assert.equal(switchIdentity.secondTotal, 2);
    assert.deepEqual(switchIdentity.api[String(switchLive.input)].inputs.switch_values, { values: [true, ...Array(9).fill(false)] });
    await openSwitchModal(switchLive.first, 'settings');
    assert.match(await settingsModal.textContent(), /入力スイッチ1〜10はすべてOFF/);
    await settingsModal.getByRole('button', { name: '閉じる', exact: true }).click();
    await openSwitchModal(switchLive.second, 'settings');
    assert.equal(await settingsModal.locator('select[data-scene-switch-index]').count(), 10);
    assert.match(await settingsModal.locator('[data-scene-switch-index="3"]').locator('..').textContent(), /設定先 3: 同名/);
    assert.match(await settingsModal.locator('[data-scene-switch-index="3"] option[value="1"]').textContent(), /入力 1: 親の入口/);
    await settingsModal.screenshot({ path: resolve(screenshotDirectory, 'native-preset-switch-settings.png') });
    await settingsModal.locator('[data-scene-switch-index="3"]').selectOption('1');
    assert.equal((await switchPlanSnapshot()).settings, switchIdentity.settings, 'mapping draft cannot change the plan');
    await settingsModal.locator('[data-scene-switch-save="settings"]').click();
    const switchMapped = await switchPlanSnapshot();
    assert.equal(switchMapped.history, switchIdentity.history + 1);
    for (const key of ['total', 'prepared', 'displayed']) assert.equal(switchMapped[key], 10, key);
    assert.equal(switchMapped.firstTotal, 2); assert.equal(switchMapped.secondTotal, 3);
    assert.deepEqual(switchMapped.preview, Array(10).fill('Scene Prompt'));
    assert.equal(JSON.parse(switchMapped.settings)[2], 1);
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undo());
    const switchMappingUndo = await switchPlanSnapshot();
    assert.equal(switchMappingUndo.total, 8); assert.equal(switchMappingUndo.prepared, 8); assert.equal(switchMappingUndo.settings, switchIdentity.settings);
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().redo());
    const switchMappingRedo = await switchPlanSnapshot(); assert.equal(switchMappingRedo.total, 10); assert.equal(switchMappingRedo.prepared, 10);
    await openSwitchModal(switchLive.input, 'names');
    await namesModal.locator('[data-scene-switch-index="1"]').fill('親の変更後');
    await namesModal.locator('[data-scene-switch-save="names"]').click();
    const switchRenamed = await switchPlanSnapshot(); assert.equal(switchRenamed.total, 10); assert.equal(switchRenamed.settings, switchMapped.settings);
    await openSwitchModal(switchLive.second, 'settings');
    assert.equal(await settingsModal.locator('[data-scene-switch-index="3"]').inputValue(), '1');
    assert.match(await settingsModal.locator('[data-scene-switch-index="3"] option[value="1"]').textContent(), /親の変更後/);
    await settingsModal.locator('[data-scene-switch-save="settings"]').click();
    assert.equal((await switchPlanSnapshot()).history, switchRenamed.history);
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undo());
    assert.equal((await switchPlanSnapshot()).total, 10, 'undoing only a name never changes switch values');
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().redo());
    const switchReloadWorkflow = await page.evaluate(() => window.app.graph.serialize());
    await openSwitchModal(switchLive.second, 'settings');
    await settingsModal.locator('[data-scene-switch-index="3"]').selectOption('false');
    await page.evaluate(id => {
        window.__sceneStaleSwitchSave = document.querySelector('[data-scene-switch-save="settings"]');
        window.__sceneStaleSwitchNode = window.app.graph.getNodeById(id);
    }, switchLive.second);
    await page.evaluate(async workflow => window.app.loadGraphData(workflow, true, true), switchReloadWorkflow);
    // Invoke the detached old DOM action to prove it cannot edit either old or replacement nodes.
    const staleMappingResult = await page.evaluate(() => {
        const save = window.__sceneStaleSwitchSave, node = window.__sceneStaleSwitchNode;
        const raw = () => node.widgets.find(widget => widget.name === 'switch_settings_json').value;
        const before = raw(), history = window.__sceneSeedRuntimeTest.tracker().undoQueue.length; save.click();
        delete window.__sceneStaleSwitchSave; delete window.__sceneStaleSwitchNode;
        return { history, after: window.__sceneSeedRuntimeTest.tracker().undoQueue.length, before, raw: raw() };
    });
    assert.equal(staleMappingResult.after, staleMappingResult.history); assert.equal(staleMappingResult.raw, staleMappingResult.before);
    const switchReloaded = await switchPlanSnapshot(); assert.equal(switchReloaded.total, 10); assert.equal(switchReloaded.prepared, 10);
    assert.equal(switchReloaded.settings, switchMapped.settings);
    const oldSwitchWorkflow = structuredClone(switchReloadWorkflow);
    for (const node of oldSwitchWorkflow.nodes) {
        if (node.type === 'ScenePresetInput') { node.outputs = node.outputs.slice(0, 1); node.widgets_values = []; delete node.widgets_values_named; delete node.properties.scene_switch_values; }
        if (node.type === 'ScenePresetReference') { node.widgets_values = ['browser-native-switch', 'legacy-run', '{"version":1,"presets":{}}']; delete node.widgets_values_named; }
    }
    oldSwitchWorkflow.links = oldSwitchWorkflow.links.filter(link => link[2] !== 11);
    for (const node of oldSwitchWorkflow.nodes) for (const input of node.inputs || []) if (input.name === 'switches') input.link = null;
    await page.evaluate(async workflow => window.app.loadGraphData(workflow, true, true), oldSwitchWorkflow);
    const switchLegacy = await switchPlanSnapshot(); assert.equal(switchLegacy.total, 8); assert.equal(switchLegacy.prepared, 8);
    assert.equal(switchLegacy.settings, '[]');
    assert.deepEqual(switchLegacy.api[String(switchLive.second)].inputs.scene_prompt, [String(switchLive.input), 0], 'legacy Input keeps its original Scene slot 0 link');
    const oldReference = await page.evaluate(id => window.app.graph.getNodeById(id).serialize().widgets_values_named, switchLive.second);
    assert.equal(oldReference.run_handle, 'legacy-run'); assert.equal(oldReference.llm_presets_json, '{"version":1,"presets":{}}');
    assert.equal((await inputSwitchSnapshot(switchLive.input)).ports.length, 12, 'legacy one-output Input appends fixed slots');
    await page.evaluate(async workflow => window.app.loadGraphData(workflow, true, true), switchReloadWorkflow);
    const settingsBeforeSwitchReload = await page.evaluate(async () => {
        const settings = window.app.extensionManager.setting, ids = ['ScenePrompt.UndoHistoryLimit', 'ScenePrompt.ReleaseComfyBeforeLLM', 'ScenePrompt.ReleaseLLMBeforeImage'];
        const before = Object.fromEntries(ids.map(id => [id, settings.get(id)])); await settings.set(ids[0], 300);
        return { before, expected: Object.fromEntries(ids.map(id => [id, settings.get(id)])) };
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__sceneSeedRuntimeTest && window.LiteGraph?.registered_node_types?.ComfySwitchNode && window.app?.graph);
    await page.keyboard.press('Escape');
    await page.evaluate(async workflow => window.app.loadGraphData(workflow, true, true), switchReloadWorkflow);
    const switchBrowserReloaded = await switchPlanSnapshot(); assert.equal(switchBrowserReloaded.total, 10); assert.equal(switchBrowserReloaded.prepared, 10);
    assert.equal(switchBrowserReloaded.settings, switchMapped.settings); assert.equal(switchBrowserReloaded.names, switchRenamed.names);
    const switchSettings = await page.evaluate(() => ({
        values: Object.fromEntries(Object.keys(window.app.ui.settings.settingsLookup).filter(id => id.startsWith('ScenePrompt.')).map(id => [id, window.app.extensionManager.setting.get(id)])),
        categories: Object.entries(window.app.ui.settings.settingsLookup).filter(([id]) => id.startsWith('ScenePrompt.')).map(([id, setting]) => ({ id, category: setting.category })),
    }));
    assert.deepEqual(switchSettings.values, settingsBeforeSwitchReload.expected, 'existing setting IDs and values survive reload');
    assert(switchSettings.categories.every(setting => setting.category?.[0] === 'Scene Prompt Tools'), JSON.stringify(switchSettings));
    await page.evaluate(() => window.app.extensionManager.command.execute('Comfy.ShowSettingsDialog'));
    await page.getByText('Scene Prompt Tools', { exact: true }).waitFor();
    assert.equal(await page.getByText('Scene Prompt Tools', { exact: true }).count(), 1, 'native settings sidebar has one category');
    assert.equal(await page.getByText('ScenePrompt', { exact: true }).count(), 0, 'old derived settings category is absent');
    await page.keyboard.press('Escape');
    await page.evaluate(async before => { for (const [id, value] of Object.entries(before)) await window.app.extensionManager.setting.set(id, value); }, settingsBeforeSwitchReload.before);
    assert.deepEqual(await (await fetch(`${url}/scene_test/model_executions`)).json(), []);
    nativeRunChecks = false;
    console.log('real ComfyUI standard Switch MatchType, fixed slots, names/mapping DOM saves, siblings, count/selected preview, Undo/Redo, clone, legacy restore, reload and one settings category passed');

    const weightedInput = "first, ((TAG:4):0.5), (tag:1.2), (equal:1.), (EQUAL:1e0), (science:1_2e-1), (SCIENCE:1.1), (blocked:99)";
    const nativeMatrixId = await page.evaluate(async () => {
        const { app } = await import("/scripts/app.js");
        const matrix = window.LiteGraph.createNode("SceneMatrix"); app.graph.add(matrix);
        matrix.widgets.find(widget => widget.sceneRole === "matrix_rows").callback();
        return matrix.id;
    });
    await page.getByRole("button", { name: "行を追加", exact: true }).click();
    await page.getByRole("button", { name: "ポジティブ候補", exact: true }).click();
    await page.getByPlaceholder("ポジティブ基本文").fill(weightedInput);
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    await page.getByRole("button", { name: "ネガティブ候補", exact: true }).click();
    await page.getByPlaceholder("ネガティブ基本文").fill("(blocked:.1)");
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    const nativeWeightedLine = await page.evaluate(id => JSON.parse(window.app.graph.getNodeById(id).widgets.find(widget => widget.name === "matrix_json").value).sets[0], nativeMatrixId);
    assert.equal(nativeWeightedLine.positive_base, weightedInput);
    assert.deepEqual(nativeWeightedLine.positive_parts, ["first", "((TAG:4):0.5)", "(equal:1.)", "(science:1_2e-1)"]);
    assert.deepEqual(nativeWeightedLine.negative_parts, ["(blocked:.1)"]);
    await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(pageErrors, []);
    console.log("real ComfyUI local metadata HTTP, model/LoRA dialogs, retry, red links and weighted Matrix input preservation passed");
} finally {
    await browser?.close();
    if (child?.exitCode === null) {
        child.kill();
        await new Promise((resolveChild) => child.once("exit", resolveChild));
    }
    if (gpuProvider) {
        gpuProvider.closeAllConnections();
        await new Promise((done) => gpuProvider.close(done));
    }
    await rm(directory, { recursive: true, force: true });
}
