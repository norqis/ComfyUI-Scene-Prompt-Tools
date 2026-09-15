const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { deflateSync } = require("node:zlib");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

function functionSource(name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed function: ${name}`);
}

function chunk(type, data) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 4, "ascii");
    return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function compressedWorkflowFile(workflow) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const payload = Buffer.concat([
        Buffer.from("workflow\0\0", "latin1"),
        deflateSync(Buffer.from(JSON.stringify(workflow), "utf8")),
    ]);
    const file = new Blob([signature, chunk("zTXt", payload), chunk("IEND", Buffer.alloc(0))], { type: "image/png" });
    file.name = "compressed.png";
    return file;
}

async function run() {
    const loaded = [];
    let originalCalls = 0;
    const context = {
        Array, Blob, DataView, DecompressionStream, JSON, Response, String, TextDecoder, Uint8Array,
        console: { warn() {} },
        app: {
            async handleFile() { originalCalls += 1; },
            async loadGraphData(...args) { loaded.push(args); },
        },
    };
    vm.createContext(context);
    vm.runInContext(functionSource("sceneCompressedPngWorkflow"), context);
    vm.runInContext(functionSource("installSceneCompressedPngWorkflowLoader"), context);

    const workflow = { version: 0.4, nodes: [{ id: 1, type: "ScenePrompter" }], links: [] };
    const file = compressedWorkflowFile(workflow);
    assert.deepEqual(JSON.parse(await context.sceneCompressedPngWorkflow(file)), workflow);

    context.installSceneCompressedPngWorkflowLoader();
    await context.app.handleFile(file, "file_button", { deferWarnings: true });
    assert.equal(originalCalls, 0, "compressed workflow PNG bypasses ComfyUI's unsupported zTXt parser");
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0][0], workflow);
    assert.deepEqual(JSON.parse(JSON.stringify(loaded[0].slice(1))), [
        true,
        true,
        "compressed",
        { openSource: "file_button", deferWarnings: true },
    ]);

    const ordinary = new Blob([Buffer.from("not a PNG")], { type: "image/png" });
    ordinary.name = "ordinary.png";
    await context.app.handleFile(ordinary);
    assert.equal(originalCalls, 1, "ordinary files stay on ComfyUI's native loader");
}

run()
    .then(() => console.log("Scene Prompt compressed PNG workflow tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
