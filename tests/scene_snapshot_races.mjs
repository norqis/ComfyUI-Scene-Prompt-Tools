import assert from "node:assert/strict";

export async function testSnapshotRaces(browser, url) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(url);
        await page.waitForFunction(() => window.__scenePromptBrowserReady);
        // Both kinds of tab switching: a separate graph, or native graph reuse.
        for (const reuseGraph of [false, true]) {
            await page.evaluate(async (reuse) => {
                const item = { id: "summer", label: "Summer", prompt: "summer dress", description: "", category_path: ["Outfit"], category_key: "Outfit", category_label: "Outfit" };
                const state = JSON.stringify({ version: 1, categories: { Outfit: [item] } });
                function graph(name) {
                    return { name, _nodes: [], links: {}, getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)); }, setDirtyCanvas() {}, change() {},
                        serialize() { return { version: 1, nodes: [], extra: { owner: name } }; } };
                }
                function node(g) {
                    const n = { id: 1, type: "ScenePrompter", graph: g, size: [420, 300], pos: [0, 0], properties: {}, inputs: [], outputs: [],
                        widgets: [{ name: "positive_json", value: state }, { name: "negative_json", value: '{"version":1,"categories":{}}' }], setDirtyCanvas() {} };
                    n.widgets_values = n.widgets.map((w) => w.value); g._nodes.push(n); return n;
                }
                const a = graph("A"), b = reuse ? a : graph("B");
                const originalNodes = a._nodes;
                const na = node(a);
                if (reuse) a._nodes = [];
                const nb = node(b);
                const replacementNodes = b._nodes;
                if (reuse) a._nodes = originalNodes;
                window.race = { a, b, na, nb, replacementNodes };
                window.app.graph = a;
                window.raceOriginalFetch ||= window.api.fetchApi;
                window.api.fetchApi = async (path, options = {}) => {
                    if (path === "/scene_prompt/items" && options.method === "POST") {
                        const body = JSON.parse(options.body);
                        await new Promise((resolve) => { window.race.release = resolve; });
                        return new Response(JSON.stringify({ items: [{ ...item, prompt: body.prompt }], item: { ...item, prompt: body.prompt } }), { status: 200 });
                    }
                    return window.raceOriginalFetch(path, options);
                };
                const addListener = HTMLButtonElement.prototype.addEventListener;
                HTMLButtonElement.prototype.addEventListener = function (type, listener, options) {
                    if (type === "click" && this.textContent === "保存") {
                        return addListener.call(this, type, (event) => { window.race.editDone = listener.call(this, event); }, options);
                    }
                    return addListener.call(this, type, listener, options);
                };
                try { await window.__scenePromptPopupTestHooks.openEditPromptItemPopup(na, item); }
                finally { HTMLButtonElement.prototype.addEventListener = addListener; }
            }, reuseGraph);
            await page.locator(".pc-form textarea").first().fill("changed by A");
            const save = page.getByRole("button", { name: "保存", exact: true });
            await save.click();
            await page.waitForFunction(() => !!window.race.release);
            const result = await page.evaluate(async (reuse) => {
                const { a, b, na, nb, replacementNodes } = window.race;
                window.__scenePromptPopupTestHooks.closeAllPopups();
                if (reuse) { a._nodes = replacementNodes; na.graph = null; }
                window.app.graph = b;
                window.race.release();
                await window.race.editDone;
                return { a: JSON.parse(na.widgets[0].value).categories.Outfit[0].prompt,
                    b: JSON.parse(nb.widgets[0].value).categories.Outfit[0].prompt,
                    popups: document.querySelectorAll(".pc-popup").length };
            }, reuseGraph);
            assert.equal(result.b, "summer dress", "an edit response must never replace another tab's selected text");
            assert.equal(result.a, reuseGraph ? "summer dress" : "changed by A");
            assert.equal(result.popups, 0, "a completed background edit must not reopen its popup");
        }

        const result = await page.evaluate(async () => {
            const hooks = window.__scenePromptPopupTestHooks;
            window.api.fetchApi = window.raceOriginalFetch;
            const vector = [true, false, false, false, false, false, false, false, false, false];
            const graph = window.race.a;
            const input = { id: 1, type: "ScenePresetInput", title: "A Input", graph, properties: { scene_switch_values: [...vector] } };
            const prompt = { id: 2, type: "ScenePrompter", title: "A Prompt", graph, properties: {} };
            const output = { id: 3, type: "ScenePresetOutput", graph, widgets: [{ name: "preset_id", value: "audit" }, { name: "preset_name", value: "Audit" }] };
            graph._nodes = [input, prompt, output]; window.app.graph = graph;
            graph.serialize = () => ({ nodes: graph._nodes.map((n) => ({ id: n.id, type: n.type, title: n.title, properties: structuredClone(n.properties || {}) })), extra: { owner: "A" } });
            let release;
            window.app.graphToPrompt = async () => {
                const workflow = graph.serialize();
                await new Promise((resolve) => { release = resolve; });
                return { workflow, output: { "1": { class_type: "ScenePresetInput", inputs: {} }, "2": { class_type: "ScenePrompter", inputs: {} }, "3": { class_type: "ScenePresetOutput", inputs: { scene_prompt: ["1", 0] } },
                    "4": { class_type: "SceneMatrix", inputs: { matrix_json: "captured-A" } } } };
            };
            hooks.installScenePresetSwitchBindings();
            const saving = hooks.saveScenePreset(output);
            // Simulate ComfyUI loading a different workflow into the same graph.
            graph._nodes = [{ id: 1, type: "ScenePresetInput", title: "B Input", properties: { scene_switch_values: [false, true, ...vector.slice(2)] } },
                { id: 2, type: "ScenePrompter", title: "B Prompt", graph },
                { id: 4, type: "SceneMatrix", graph, widgets: [{ name: "matrix_json", value: '{"version":1,"sets":[]}' }] }];
            graph.serialize = () => ({ nodes: [], extra: { owner: "B" } });
            release(); await saving;
            const payload = JSON.parse(window.__scenePromptCalls.findLast((call) => call.url === "/scene_presets/save").options.body);
            hooks.syncSceneMatrixPromptInputs(payload.api_graph);
            await hooks.prepareSceneRunContext(payload.api_graph);
            const prepared = JSON.parse(window.__scenePromptCalls.findLast((call) => call.url === "/scene_prompt/runs/prepare").options.body);
            return { owner: payload.workflow.extra.owner, name: payload.api_graph.output["2"].inputs.source_node_name,
                switches: payload.api_graph.output["1"].inputs.switch_values.values, matrix: payload.api_graph.output["4"].inputs.matrix_json,
                preparedOwner: prepared.workflow.extra.owner };
        });
        assert.equal(result.owner, "A");
        assert.equal(result.name, "A Prompt");
        assert.deepEqual(result.switches, [true, false, false, false, false, false, false, false, false, false]);
        assert.equal(result.matrix, "captured-A");
        assert.equal(result.preparedOwner, "A");
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
}
