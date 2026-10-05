import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
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
try {
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
from server import PromptServer
executions = []
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
    async def api_get(path, params=None, *, missing_ok=False):
        lookup_calls.append({"path": path, "missing_ok": missing_ok})
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
    page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/\/scene_prompt\/(?:expand\/resources|loras\/info|models\/)/u.test(path)) resourceRequests.push(path);
        if (path.endsWith("/civitai/by-hash")) metadataRequests.push({ url: request.url(), method: request.method() });
        if (/^https:\/\/civitai\.(?:com|red)\//u.test(request.url())) directCivitaiRequests.push(request.url());
    });
    let deferredGeneration;
    let failNextGeneration = false;
    const runtimeCandidate = { model_id: 100, version_id: 200, file_id: 300, name: "Runtime Hat", version_name: "v1", base_model: "Illustrious",
        file_name: "runtime-hat.safetensors", size_kb: 1000, sha256: "a".repeat(64), triggers: ["runtime_hat"], stats: { thumbsUpCount: 10 }, acquired: true, lora_name: "runtime-hat.safetensors" };
    await page.route("**/scene_prompt/llm/**", async (route) => {
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
    await page.route("**/scene_prompt/civitai/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/u, "");
        if (path.endsWith("/settings")) { settingsRequests.push(path); return route.continue(); }
        if (path.endsWith("/by-hash")) return route.continue();
        llmRequests.push({ path, body: route.request().method() === "POST" ? route.request().postDataJSON() : null });
        if (path.endsWith("/search")) return route.fulfill({ json: { items: [runtimeCandidate], query: "hat", sort: "Most Downloaded" } });
        if (path.endsWith("/download")) return route.fulfill({ json: { candidate: runtimeCandidate, lora_name: runtimeCandidate.lora_name } });
        throw new Error(`Unexpected Civitai runtime request ${path}`);
    });
    await page.route("**/prompt", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        seedRequests.push(route.request().postDataJSON());
        await route.fulfill({ json: { prompt_id: `seed-test-${seedRequests.length}`, number: 0, node_errors: {} } });
    });
    await page.route("**/scene_prompt/runs/**", (route) => {
        runRequests.push(route.request().url());
        return route.fulfill({ json: { run_handle: "seed-runtime-test", claimed: true, released: true } });
    });
    await page.route("**/scene_prompt_ui.js", async (route) => {
        const response = await route.fetch();
        const sourceUI = (await response.text()).replace("onError: showAPIError,", "onError: (error, query, retry) => { window.__sceneLLMRuntimeError = error.stack; showAPIError(error, query, retry); },");
        await route.fulfill({ response, body: `${sourceUI}
window.__sceneSeedRuntimeTest = {
    updateLLMExpand(node) { updateSceneExpandButton(node); },
    presetSourceSnapshot() { return JSON.stringify([...scenePresetDisplayGraphs]); },
    tracker() { return sceneActiveWorkflow()?.changeTracker; },
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
        await app.loadGraphData(old, true, true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const oldNode = app.graph.getNodeById(random.id);
        const oldValue = oldNode.widgets.find((widget) => widget.name === "preserve_join")?.value;
        const frozen = structuredClone(initial);
        frozen.nodes.find((entry) => String(entry.id) === String(random.id)).widgets_values = [encoded, true];
        await app.loadGraphData(frozen, true, true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const restored = app.graph.getNodeById(random.id);
        const serialized = app.graph.serialize().nodes.find((entry) => String(entry.id) === String(random.id));
        const prompt = await app.graphToPrompt();
        return {
            widgetNames: restored.widgets.map((widget) => widget.name),
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
    assert.equal(randomWorkflowRoundTrip.oldValue, false, "legacy one-widget Random workflows default preserve_join to false");
    assert.equal(randomWorkflowRoundTrip.newValue, true, "frozen PNG workflow restores preserve_join");
    assert.equal(randomWorkflowRoundTrip.hidden, true, "preserve_join remains hidden in the node UI");
    assert.deepEqual(randomWorkflowRoundTrip.widgetNames.slice(0, 2), ["weights_json", "preserve_join"]);
    assert.deepEqual(randomWorkflowRoundTrip.serialized.slice(0, 2), ["[10000,0,0,0,0,0,0,0,0,0]", true]);
    assert.equal(randomWorkflowRoundTrip.apiInputs?.preserve_join, true,
        "graphToPrompt retains the frozen Random Queue boundary after PNG-style restoration");
    assert.deepEqual(randomWorkflowRoundTrip.queueControls.map((entry) => entry.value), ["input_order", 1, "multiply"],
        "frozen one-arm Random preserves a closing Queue and normalizes obsolete controls");
    assert.ok(randomWorkflowRoundTrip.queueControls.every((entry) => entry.disabled));
    console.log("real ComfyUI Random legacy and frozen workflow widget round trips passed");
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
        const beforeReload = { llm: prompt.output[String(llm.id)]?.inputs, lora: prompt.output[String(managed.id)]?.inputs,
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
        field(restored, "positive").value = "user edited prompt";
        await role(restoredExpand, "expand_llm_generate").callback();
        return { empty, order, enabled, bypassDisabled, description: description.value, undone, redone,
            beforeReload, restored: { llm: after.output[String(ids.llm)]?.inputs, lora: after.output[String(ids.lora)]?.inputs,
                queueInput: after.output[String(ids.branch)]?.inputs.scene_prompt2, provenance: restoredLora.properties.scene_civitai },
            reusedPositive: field(restored, "positive").value,
            nodeCount: app.graph._nodes.filter((node) => node.comfyClass === "SceneApplyLora").length,
            stateHidden: field(restored, "generation_state_json").hidden };
    });
    assert.deepEqual(llmRuntime.empty, { own: true, expand: true });
    assert.equal(llmRuntime.order, true);
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
        const editor = { loras: nativeLoras.map((node) => api.output[String(node.id)]?.inputs), prompts: prompts.map((node) => api.output[String(node.id)]?.inputs) };
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
            loadedPrompts: app.graph._nodes.filter((node) => node.comfyClass === "ScenePromptLLM").map((node) => loadedAPI.output[String(node.id)]?.inputs) };
    });
    assert.equal(presetLLMRuntime.untouched, true, "Reference generation never writes the shared Preset file");
    assert.equal(presetLLMRuntime.retryEnabled, true, "failed native Reference generation restores the Generate button");
    assert.equal(presetLLMRuntime.compactUnchanged, true, "failed/retried generation never promotes full bodies into the global source list");
    assert.equal(presetLLMRuntime.retained, true, "Reference customization survives native owning-workflow reload");
    assert.equal(presetLLMRuntime.editor.loras.length, 2);
    assert.equal(presetLLMRuntime.loadedLoras.length, 2);
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
    await page.evaluate(async () => {
        const { app } = await import("/scripts/app.js"); app.graph.clear();
        const llm = window.LiteGraph.createNode("ScenePromptLLM"); app.graph.add(llm);
        await llm.widgets.find(widget=>widget.sceneRole==='llm_settings').callback();
    });
    const llmSettings = page.getByRole('dialog',{name:'LLM接続設定',exact:true});
    await llmSettings.getByRole('button',{name:'保存',exact:true}).waitFor();
    assert.deepEqual(await llmSettings.locator('input').evaluateAll(inputs=>inputs.map(input=>input.name)), ['base_url','port','model','api_key']);
    assert.equal(await llmSettings.locator('input[name="base_url"]').evaluate(input=>input.required),true);
    assert.equal(await llmSettings.locator('.pc-required-star').evaluate(star=>getComputedStyle(star).color),'rgb(255, 91, 91)');
    assert(await llmSettings.locator('form').evaluate(form=>parseFloat(getComputedStyle(form).paddingTop))>=20);
    await llmSettings.locator('input[name="model"]').fill('');
    await llmSettings.locator('input[name="port"]').fill('');
    await llmSettings.getByRole('button',{name:'保存',exact:true}).click();
    await llmSettings.getByText('保存しました',{exact:true}).waitFor();
    const savedLLMSettings = await page.evaluate(async()=>await (await fetch('/scene_prompt/llm/settings')).json());
    assert.equal(savedLLMSettings.model,''); assert.equal(savedLLMSettings.port,null);
    assert.equal(savedLLMSettings.civitai_api_key_set,undefined);
    await llmSettings.getByRole('button',{name:'接続テスト・モデル取得'}).click();
    await llmSettings.getByText('接続成功: settings-fixture',{exact:true}).waitFor();
    await page.setViewportSize({width:360,height:740});
    assert.equal(await llmSettings.evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1280,height:720});
    await page.evaluate(async()=>{
        const { app }=await import('/scripts/app.js');
        const lora=window.LiteGraph.createNode('SceneApplyLora'); app.graph.add(lora);
        lora.properties.scene_civitai={query:'hat'};
        await lora.widgets.find(widget=>widget.sceneRole==='lora_select').callback();
    });
    const nativeSearch=page.getByRole('dialog',{name:'Civitai Search',exact:true});
    await nativeSearch.locator('.pc-civitai-card').first().waitFor();
    assert.equal(await nativeSearch.getByRole('button',{name:'Civitai設定',exact:true}).count(),0);
    assert.equal(await page.getByRole('dialog',{name:'Civitai設定',exact:true}).count(),0);
    assert.equal(await page.evaluate(async()=> 'openCivitaiSettings' in await import('/extensions/scene-prompt-tools-browser-smoke/scene_prompt_civitai.js')),false);
    await page.keyboard.press('Escape');
    assert.equal(llmRequests.length-servicesBeforeSettings,1,'opening the search requests only public Civitai results');
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
    await nativeModelCard.getByText("Metadata fixture offline", { exact: true }).waitFor();
    await fetch(`${url}/scene_test/civitai_lookup`, { method: "POST", body: JSON.stringify({ mode: "found" }), headers: { "Content-Type": "application/json" } });
    await nativeModelCard.getByRole("button", { name: "Civitaiを確認" }).click();
    await nativeModelCard.getByRole("link", { name: "Civitaiで見る" }).waitFor();
    assert.equal(await nativeModelCard.getByRole("link", { name: "Civitaiで見る" }).getAttribute("href"), "https://civitai.red/models/12?modelVersionId=23");
    await page.keyboard.press("Escape");
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
    await rm(directory, { recursive: true, force: true });
}
