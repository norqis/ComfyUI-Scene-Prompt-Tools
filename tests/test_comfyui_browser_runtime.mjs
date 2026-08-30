import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

if (process.env.RUN_REAL_COMFYUI_BROWSER_SMOKE !== "1") {
    console.log("real ComfyUI browser smoke skipped");
    process.exit(0);
}

const source = resolve(process.env.COMFYUI_SOURCE || "");
const python = process.env.COMFYUI_PYTHON;
assert.ok(python, "COMFYUI_PYTHON is required for the real ComfyUI browser smoke.");
assert.ok(source, "COMFYUI_SOURCE is required for the real ComfyUI browser smoke.");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

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
        filter: (entry) => ![".git", ".venv", "node_modules", "__pycache__", ".pytest_cache"].includes(entry.split(/[\\/]/u).at(-1)),
    });
    child = spawn(python, [
        "main.py",
        "--cpu",
        "--listen", "127.0.0.1",
        "--port", String(port),
        "--disable-auto-launch",
        "--base-directory", directory,
    ], { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    await waitForServer(url, child, output);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForFunction(
        () => window.LiteGraph?.registered_node_types?.ScenePrompter && window.app?.graph,
        null,
        { timeout: 30_000 },
    );
    const result = await page.evaluate(() => {
        const names = ["filename_enabled", "positive_base", "positive_json", "negative_base", "negative_json", "category_order", "seed", "randomize", "run_handle"];
        const values = [true, "positive, {A|B}", '{"version":1,"categories":{"Outfit":[{"id":"summer","label":"Summer"}]}}', "negative", '{"version":1,"categories":{"Mood":[{"id":"calm","label":"Calm"}]}}', "Outfit", 99, false, "new run"];
        const legacyNames = ["prompt_name", "positive_base", "positive_json", "negative_base", "negative_json", "category_order", "seed", "control_after_generate", "randomize", "run_handle"];
        const legacyValues = ["v0.3 name", "v0.3 positive, {A|B}", "v0.3-positive-json", "v0.3 negative", "v0.3-negative-json", "Outfit", 77, "randomize", false, "v0.3 run"];
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
        positive_json: '{"version":1,"categories":{"Outfit":[{"id":"summer","label":"Summer"}]}}',
        negative_base: "negative",
        negative_json: '{"version":1,"categories":{"Mood":[{"id":"calm","label":"Calm"}]}}',
        category_order: "Outfit",
        seed: 99,
        randomize: false,
        run_handle: "new run",
    });
    assert.deepEqual(result.legacyInput, ["v0.3 name", "v0.3 positive, {A|B}", "v0.3-positive-json", "v0.3 negative", "v0.3-negative-json", "Outfit", 77, "randomize", false, "v0.3 run"]);
    assert.deepEqual(result.legacy, {
        prompt_name: "v0.3 name",
        positive_base: "v0.3 positive, {A|B}",
        positive_json: "v0.3-positive-json",
        negative_base: "v0.3 negative",
        negative_json: "v0.3-negative-json",
        category_order: "Outfit",
        seed: 77,
        control_after_generate: "randomize",
        randomize: false,
        run_handle: "v0.3 run",
    });
    assert.deepEqual(result.legacyAfterFirst, result.legacy, "a second configure must not alter v0.3 values");
    assert.equal(result.legacyFilename, false);
    console.log("real ComfyUI LGraphNode legacy choice widget round-trip passed");
} finally {
    await browser?.close();
    if (child?.exitCode === null) {
        child.kill();
        await new Promise((resolveChild) => child.once("exit", resolveChild));
    }
    await rm(directory, { recursive: true, force: true });
}
