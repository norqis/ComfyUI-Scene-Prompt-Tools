import assert from "node:assert/strict";

export async function verifyCandidateReloadSelections(page) {
    let candidate;
    const items = route => route.fulfill({ json: { items: [candidate] } });
    const saved = route => route.fulfill({ json: { saved_prompts: [] } });
    await page.route("**/scene_prompt/items*", items);
    await page.route("**/scene_prompt/saved_prompts*", saved);
    try {
        for (const [side, before, after, parts, expected] of [
            ["positive", "alpha, beta", "beta, gamma", [{ index: 0, text: "alpha", weight: 1.3 }, { index: 1, text: "beta", weight: 1.2 }], "(beta:1.2)"],
            ["negative", "alpha, alpha", "beta, alpha", [{ index: 1, text: "alpha", weight: 1.2 }], ""],
        ]) {
            candidate = { id: "reload-parts", label: "Reload Parts", prompt: before, category_path: ["Modal Undo Runtime"], category_key: "Modal Undo Runtime", category_label: "Modal Undo Runtime" };
            const ids = await page.evaluate(async ({ candidate, parts, side }) => {
                const app = window.app; app.graph.clear();
                const source = window.LiteGraph.createNode("ScenePrompter"), text = window.LiteGraph.createNode("ScenePromptToText");
                app.graph.add(source); app.graph.add(text); source.connect(0, text, text.inputs.findIndex(input => input.name === "scene_prompt"));
                source.widgets.find(widget => widget.name === side + "_json").value = JSON.stringify({ version: 1, categories: { "Modal Undo Runtime": [{ ...candidate, selected_parts: parts }] } });
                await app.loadGraphData(app.graph.serialize(), true, true);
                await window.__sceneSeedRuntimeTest.reloadCandidateItems();
                await window.__sceneSeedRuntimeTest.openCandidatePicker(source.id, side);
                return { source: source.id, text: text.id };
            }, { candidate, parts, side });
            const snapshot = () => page.evaluate(async ({ ids, side }) => {
                const graph = await window.app.graphToPrompt();
                const response = await fetch("/scene_test/preset_metadata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ graph, text_id: String(ids.text) }) });
                if (!response.ok) throw new Error(await response.text());
                const state = JSON.parse(graph.output[String(ids.source)].inputs[side + "_json"]);
                return { parts: state.categories["Modal Undo Runtime"][0].selected_parts, text: (await response.json()).text[side === "positive" ? 0 : 1] };
            }, { ids, side });
            const original = await snapshot();
            candidate = { ...candidate, prompt: after };
            await page.getByRole("button", { name: "設定再読み込み", exact: true }).click();
            await page.locator('.pc-candidate[title="' + after + '"]').waitFor();
            const edited = await snapshot();
            assert.equal(edited.text, expected);
            assert.equal(new Set(edited.parts.map(part => part.index)).size, parts.length);
            assert(edited.parts.some(part => part.missing));
            assert.deepEqual(edited.parts.map(part => part.weight), parts.map(part => part.weight));
            await page.getByRole("button", { name: "設定再読み込み", exact: true }).click();
            await page.locator('.pc-candidate[title="' + after + '"]').waitFor();
            assert.deepEqual(await snapshot(), edited, "unchanged reload never revives a removed occurrence");
            candidate = { ...candidate, prompt: before };
            await page.getByRole("button", { name: "設定再読み込み", exact: true }).click();
            await page.locator('.pc-candidate[title="' + before + '"]').waitFor();
            assert.deepEqual(await snapshot(), original, "restoring the candidate restores the selected occurrence weights");
            await page.locator(".pc-popup").last().getByRole("button", { name: "閉じる", exact: true }).click();
        }
    } finally {
        await page.unroute("**/scene_prompt/items*", items);
        await page.unroute("**/scene_prompt/saved_prompts*", saved);
    }
    console.log("real ComfyUI candidate reload preserves partial occurrence identities through deletion, repeated reload, restoration and backend ToText");
}

export async function verifySceneModalHistory(page) {
    await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const input = window.LiteGraph.createNode("ScenePresetInput");
        const output = window.LiteGraph.createNode("ScenePresetOutput");
        app.graph.add(input); app.graph.add(output); input.connect(0, output, 0);
        const graph = await app.graphToPrompt();
        const response = await fetch("/scene_presets/save", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: "native-history", name: "Native History", output_node_id: String(output.id),
                api_graph: graph, workflow: graph.workflow }),
        });
        if (!response.ok) throw new Error(await response.text());
    });

    const cases = [
        { type: "ScenePresetReference", role: "scene_preset_select", field: "preset_id", before: "", after: "native-history" },
        { type: "SceneApplyLora", role: "lora_select", field: "lora_name", before: "runtime-hat.safetensors", after: "runtime-local.safetensors" },
        { type: "SceneApplyLora", role: "lora_details", field: "positive", before: "manual", after: "manual, native_metadata_trigger" },
        { type: "ScenePromptRandomRoute", role: "random_settings", field: "weights_json",
            before: "[10000,0,0,0,0,0,0,0,0,0]", after: "[5000,5000,0,0,0,0,0,0,0,0]" },
    ];
    for (const scenario of cases) {
        const id = await page.evaluate(async scenario => {
            const app = window.app; app.graph.clear();
            const node = window.LiteGraph.createNode(scenario.type); app.graph.add(node);
            node.widgets.find(widget => widget.name === scenario.field).value = scenario.before;
            if (scenario.role === "lora_details") node.widgets.find(widget => widget.name === "lora_name").value = "runtime-hat.safetensors";
            node.pos = [380, 80]; app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
            if (scenario.type === "ScenePresetReference") await window.__sceneSeedRuntimeTest.refreshPresetReference(node);
            await app.loadGraphData(JSON.parse(JSON.stringify(app.graph.serialize())), true, true);
            await new Promise(done => setTimeout(done, 150));
            app.canvas.draw(true, true);
            window.__sceneSeedRuntimeTest.tracker().captureCanvasState();
            return node.id;
        }, scenario);
        const snapshot = () => page.evaluate(({ id, field }) => {
            const node = window.app.graph.getNodeById(id), tracker = window.__sceneSeedRuntimeTest.tracker();
            const widget = node?.widgets?.find(widget => widget.name === field);
            const serialized = node?.serialize();
            return { exists: !!node, value: widget?.value, stored: serialized?.widgets_values_named?.[field] ?? serialized?.widgets_values[node.widgets.indexOf(widget)],
                undo: tracker.undoQueue.length, redo: tracker.redoQueue.length };
        }, { id, field: scenario.field });
        const open = async () => {
            await page.waitForFunction(({ id, role }) => window.app.graph.getNodeById(id)?.widgets.some(widget => widget.sceneRole === role), { id, role: scenario.role });
            const point = await page.evaluate(async ({ id, role }) => {
                await new Promise(requestAnimationFrame);
                const node = window.app.graph.getNodeById(id), canvas = window.app.canvas;
                canvas.draw(true, true);
                const widget = node.widgets.find(widget => widget.sceneRole === role), rect = canvas.canvas.getBoundingClientRect();
                return { x: rect.left + (node.pos[0] + node.size[0] / 2 + canvas.ds.offset[0]) * canvas.ds.scale,
                    y: rect.top + (node.pos[1] + widget.last_y + window.LiteGraph.NODE_WIDGET_HEIGHT / 2 + canvas.ds.offset[1]) * canvas.ds.scale };
            }, { id, role: scenario.role });
            await page.mouse.click(point.x, point.y);
        };
        const choose = async changed => {
            await open();
            if (scenario.type === "ScenePresetReference") {
                await page.locator(".pc-popup").getByRole("button", { name: "Native History", exact: true }).click();
            } else if (scenario.role === "lora_select") {
                await page.locator(".pc-lora-picker .pc-lora-row").filter({ hasText: changed ? scenario.after : scenario.before }).locator(".pc-lora-select").click();
            } else if (scenario.role === "lora_details") {
                const dialog = page.getByRole("dialog", { name: "LoRA 詳細確認", exact: true });
                await dialog.locator(".pc-lora-word").filter({ hasText: "native_metadata_trigger" }).getByRole("button", { name: "注入" }).click();
                await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
            } else {
                const dialog = page.locator(".pc-random-dialog");
                if (changed) {
                    await dialog.locator("input").nth(0).fill("50");
                    await dialog.locator("input").nth(1).fill("50");
                }
                await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
            }
        };
        const restore = async direction => {
            await page.evaluate(async direction => {
                await window.__sceneSeedRuntimeTest.tracker()[direction]();
                await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            }, direction);
        };
        const before = await snapshot();
        await choose(true);
        const selected = await snapshot();
        assert.equal(selected.value, scenario.after, scenario.type);
        assert.equal(selected.undo, before.undo + 1, `${scenario.type} adds one native checkpoint`);
        await restore("undo");
        const undone = await snapshot();
        assert(undone.exists, `${scenario.type} Undo keeps the node`);
        assert.equal(undone.value, scenario.before);
        assert.equal(undone.redo, 1);
        if (["lora_select", "random_settings"].includes(scenario.role)) {
            await choose(false);
            assert.deepEqual(await snapshot(), undone, `${scenario.type} unchanged close/selection preserves Redo`);
        }
        await restore("redo");
        const redone = await snapshot();
        assert.equal(redone.value, scenario.after);
        assert.equal(redone.stored, scenario.after);
        await choose(true);
        assert.deepEqual(await snapshot(), redone, `${scenario.type} selecting current values adds no history`);
        await page.evaluate(async () => {
            const workflow = JSON.parse(JSON.stringify(window.app.graph.serialize()));
            await window.app.loadGraphData(workflow, true, true);
        });
        const reloaded = await snapshot();
        assert.equal(reloaded.value, scenario.after);
        assert.equal(reloaded.stored, scenario.after);
    }
    console.log("real ComfyUI Preset/local-LoRA selection, Trigger Word injection and Random probability DOM edits preserve Undo/Redo, no-op history and reload");
}
