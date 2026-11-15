import assert from 'node:assert/strict';

export async function verifySceneWeightHistory(page) {
    const candidate = { id: 'weight-history', label: 'Weight History', prompt: 'benchmark tag, other tag', category_path: ['Modal Undo Runtime'], category_key: 'Modal Undo Runtime', category_label: 'Modal Undo Runtime' };
    const items = route => route.fulfill({ json: { items: [candidate] } });
    const saved = route => route.fulfill({ json: { saved_prompts: [] } });
    await page.route('**/scene_prompt/items*', items);
    await page.route('**/scene_prompt/saved_prompts*', saved);
    const settle = () => page.waitForTimeout(300);
    const close = () => page.locator('.pc-popup').last().getByRole('button', { name: '閉じる', exact: true }).click();
    try {
        for (const count of [129, 400]) {
            const id = await page.evaluate(async count => {
                const app = window.app; app.graph.clear();
                let first, previous;
                for (let i = 0; i < count; i++) {
                    const node = window.LiteGraph.createNode('ScenePrompter'); app.graph.add(node);
                    node.pos = [100 + (i % 10) * 450, 100 + Math.floor(i / 10) * 350];
                    node.properties.fixturePadding = 'x'.repeat(700);
                    if (previous) previous.connect(0, node, node.inputs.findIndex(input => input.name === 'scene_prompt'));
                    first ??= node; previous = node;
                }
                await app.loadGraphData(JSON.parse(JSON.stringify(app.graph.serialize())), true, true);
                await window.__sceneSeedRuntimeTest.reloadCandidateItems();
                await window.__sceneSeedRuntimeTest.openCandidatePicker(first.id);
                return first.id;
            }, count);
            await page.locator('.pc-candidate input[type=checkbox]').first().check();
            await settle();
            const input = page.locator('.pc-weight-input').first();
            await input.focus();
            await input.evaluate(input => {
                const graph = window.app.graph, tracker = window.__sceneSeedRuntimeTest.tracker();
                window.__weightHistoryProbe = { inputs: 0, changes: 0, premature: 0, serializes: 0, before: tracker.undoQueue.length };
                const probe = window.__weightHistoryProbe, serialize = graph.serialize;
                probe.originalSerialize = serialize;
                graph.serialize = function (...args) { probe.serializes++; return serialize.apply(this, args); };
                input.addEventListener('input', () => { probe.inputs++; if (tracker.undoQueue.length !== probe.before) probe.premature++; });
                input.addEventListener('change', () => probe.changes++);
            });
            const box = await input.boundingBox();
            await page.mouse.move(box.x + box.width - 6, box.y + box.height * 0.25);
            await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
            await settle();
            const hold = await page.evaluate(() => {
                const probe = window.__weightHistoryProbe, tracker = window.__sceneSeedRuntimeTest.tracker();
                window.app.graph.serialize = probe.originalSerialize;
                return { inputs: probe.inputs, changes: probe.changes, premature: probe.premature, serializes: probe.serializes, history: tracker.undoQueue.length - probe.before };
            });
            assert(hold.inputs > 1, `${count}: native number spinner must repeat`);
            assert.equal(hold.changes, 1); assert.equal(hold.premature, 0); assert.equal(hold.history, 1);
            assert(hold.serializes <= 5, `${count}: saving spinner draft serializes ${hold.serializes} times`);
            await close(); await settle();
            const restore = await page.evaluate(async id => {
                const app = window.app, graph = app.graph, tracker = window.__sceneSeedRuntimeTest.tracker();
                const identities = [...graph._nodes], expected = JSON.stringify(graph.serialize());
                let configured = 0;
                const configure = graph.configure;
                graph.configure = function (...args) { configured++; return configure.apply(this, args); };
                const countBefore = tracker.undoQueue.length, started = performance.now();
                await tracker.undo();
                const undoMs = performance.now() - started;
                const undoValue = graph.getNodeById(id).widgets.find(widget => widget.name === 'positive_json').value;
                const redoStart = performance.now(); await tracker.redo();
                const redoMs = performance.now() - redoStart;
                const same = identities.every((node, index) => node === graph._nodes[index]);
                const result = { configured, same, undoMs, redoMs, undoValue,
                    exact: JSON.stringify(graph.serialize()) === expected, history: tracker.undoQueue.length, countBefore };
                graph.configure = configure;
                window.__weightHistorySettled = { expected, history: tracker.undoQueue.length };
                return result;
            }, id);
            assert.equal(restore.configured, 0, `${count}: native history must not configure the graph`);
            assert.equal(restore.same, true); assert.equal(restore.exact, true); assert.equal(restore.history, restore.countBefore);
            assert.equal(JSON.parse(restore.undoValue).categories['Modal Undo Runtime'][0].weight, undefined);
            await settle();
            assert.deepEqual(await page.evaluate(() => ({ exact: JSON.stringify(window.app.graph.serialize()) === window.__weightHistorySettled.expected,
                history: window.__sceneSeedRuntimeTest.tracker().undoQueue.length === window.__weightHistorySettled.history })), { exact: true, history: true });
            if (count === 129) {
                await page.evaluate(() => document.activeElement?.blur());
                await page.keyboard.press('Control+z');
                await page.waitForFunction(id => !JSON.parse(window.app.graph.getNodeById(id).widgets.find(widget => widget.name === 'positive_json').value).categories['Modal Undo Runtime'][0].weight, id);
                await page.keyboard.press('Control+y');
                await page.waitForFunction(() => JSON.stringify(window.app.graph.serialize()) === window.__weightHistorySettled.expected);
            }
            console.log(`native weight spinner/history ${count} nodes: ${JSON.stringify({ ...hold, undoMs: restore.undoMs, redoMs: restore.redoMs })}`);

            // Typing remains a draft; prompt capture flushes once, blur is a no-op.
            await page.evaluate(id => window.__sceneSeedRuntimeTest.openCandidatePicker(id), id);
            let weight = page.locator('.pc-weight-input').first(); await weight.fill('1.875');
            const beforeCapture = await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undoQueue.length);
            const apiValue = await page.evaluate(async id => (await window.app.graphToPrompt()).output[String(id)].inputs.positive_json, id);
            assert.equal(JSON.parse(apiValue).categories['Modal Undo Runtime'][0].weight, 1.875);
            await weight.press('Tab');
            assert.equal(await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undoQueue.length), beforeCapture + 1);
            await weight.fill(''); await weight.press('Tab');
            assert.equal(await weight.inputValue(), '1.875');
            assert.equal(await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undoQueue.length), beforeCapture + 1);
            await weight.fill('1.95');
            // Programmatic dismissal must flush even if the browser never blurs.
            await page.evaluate(() => document.querySelector('.pc-popup .pc-close')?.click());
            if (await page.locator('.pc-popup').count()) await close();
            const captured = await page.evaluate(async id => (await window.app.graphToPrompt()).output[String(id)].inputs.positive_json, id);
            assert.equal(JSON.parse(captured).categories['Modal Undo Runtime'][0].weight, 1.95);
        }

        const loraId = await page.evaluate(() => {
            const node = window.LiteGraph.createNode('SceneApplyLora'); window.app.graph.add(node);
            return node.id;
        });
        for (const side of ['positive', 'negative']) {
            await page.evaluate(({ id, side }) => window.__sceneSeedRuntimeTest.openCandidatePicker(id, side), { id: loraId, side });
            await page.locator('.pc-candidate input[type=checkbox]').first().check(); await settle();
            const weight = page.locator('.pc-weight-input').first(); await weight.fill('1.35');
            const read = () => page.evaluate(({ id, side }) => ({ state: JSON.parse(window.app.graph.getNodeById(id).widgets.find(widget => widget.name === side + '_json').value), history: window.__sceneSeedRuntimeTest.tracker().undoQueue.length }), { id: loraId, side });
            const draft = await read();
            assert.equal(draft.state.categories['Modal Undo Runtime'][0].weight, undefined);
            await weight.dispatchEvent('change'); await weight.dispatchEvent('blur');
            const committed = await read();
            assert.equal(committed.state.categories['Modal Undo Runtime'][0].weight, 1.35);
            assert.equal(committed.history, draft.history + 1);
            await page.getByRole('button', { name: '個別選択', exact: true }).first().click();
            const part = page.locator('.pc-part-row .pc-weight-input').first();
            await part.fill('1.6');
            const beforePart = await read();
            await part.dispatchEvent('change'); await part.dispatchEvent('blur');
            const afterPart = await read();
            assert.equal(afterPart.history, beforePart.history + 1);
            assert.equal(afterPart.state.categories['Modal Undo Runtime'][0].selected_parts[0].weight, 1.6);
            await close();
        }

        const mixed = await page.evaluate(async candidate => {
            const app = window.app; app.graph.clear();
            const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
            const prompt = add('ScenePrompter'), lora = add('SceneApplyLora'), matrix = add('SceneMatrix'), text = add('ScenePromptToText');
            prompt.connect(0, lora, lora.inputs.findIndex(input => input.name === 'scene_prompt'));
            lora.connect(0, matrix, matrix.inputs.findIndex(input => input.name === 'scene_prompt'));
            matrix.connect(0, text, text.inputs.findIndex(input => input.name === 'scene_prompt'));
            await app.loadGraphData(JSON.parse(JSON.stringify(app.graph.serialize())), true, true);
            await new Promise(done => setTimeout(done, 300));
            const ids = [prompt.id, lora.id, matrix.id], nodes = ids.map(id => app.graph.getNodeById(id));
            const graph = app.graph, tracker = window.__sceneSeedRuntimeTest.tracker(); tracker.captureCanvasState();
            const before = JSON.stringify(graph.serialize()), links = JSON.stringify(graph.serialize().links);
            graph.beforeChange(); app.canvas.emitBeforeChange();
            try {
                const state = { version: 1, categories: { 'Modal Undo Runtime': [{ ...candidate, weight: 1.4 }] } };
                window.__sceneSeedRuntimeTest.writeSelection(nodes[0], state);
                window.__sceneSeedRuntimeTest.writeSelection(nodes[1], state, 'negative_json');
                window.__sceneSeedRuntimeTest.writeMatrix(nodes[2], { version: 1, sets: [{ ...window.__sceneSeedRuntimeTest.matrixLine('Mixed'), positive_base: 'matrix tag', positive_parts: ['matrix tag'] }] });
            } finally { graph.afterChange(); app.canvas.emitAfterChange(); }
            await new Promise(done => setTimeout(done, 300));
            const after = JSON.stringify(graph.serialize()); let configured = 0;
            const configure = graph.configure; graph.configure = function (...args) { configured++; return configure.apply(this, args); };
            await tracker.undo(); const undone = JSON.stringify(graph.serialize());
            await tracker.redo(); const redone = JSON.stringify(graph.serialize());
            const same = nodes.every((node, index) => graph.getNodeById(ids[index]) === node);
            graph.configure = configure;
            const api = await app.graphToPrompt();
            const apiValues = [api.output[String(ids[0])].inputs.positive_json, api.output[String(ids[1])].inputs.negative_json, api.output[String(ids[2])].inputs.matrix_json];
            await app.loadGraphData(JSON.parse(after), true, true);
            const reload = await app.graphToPrompt();
            return { configured, same, exactUndo: undone === before, exactRedo: redone === after, links: JSON.stringify(graph.serialize().links) === links,
                apiExact: JSON.stringify(apiValues) === JSON.stringify([reload.output[String(ids[0])].inputs.positive_json, reload.output[String(ids[1])].inputs.negative_json, reload.output[String(ids[2])].inputs.matrix_json]), ids };
        }, candidate);
        assert.deepEqual(Object.fromEntries(Object.entries(mixed).filter(([key]) => key !== 'ids')), { configured: 0, same: true, exactUndo: true, exactRedo: true, links: true, apiExact: true });

        // Position + selection is indivisible: one unsupported edit forces full restore.
        const fallback = await page.evaluate(async ({ ids, candidate }) => {
            const app = window.app, graph = app.graph, node = graph.getNodeById(ids[0]), tracker = window.__sceneSeedRuntimeTest.tracker();
            tracker.captureCanvasState(); const target = JSON.stringify(graph.serialize());
            graph.beforeChange(); app.canvas.emitBeforeChange();
            try { node.pos[0] += 10; window.__sceneSeedRuntimeTest.writeSelection(node, { version: 1, categories: { 'Modal Undo Runtime': [{ ...candidate, weight: 2 }] } }); }
            finally { graph.afterChange(); app.canvas.emitAfterChange(); }
            let configured = 0; const configure = graph.configure;
            graph.configure = function (...args) { configured++; return configure.apply(this, args); };
            await tracker.undo(); graph.configure = configure;
            return { configured, exact: JSON.stringify(graph.serialize()) === target };
        }, { ids: mixed.ids, candidate });
        assert.equal(fallback.configured, 1); assert.equal(fallback.exact, true);

        // With an editing popup open native restoration owns disposal of old drafts.
        await page.evaluate(({ ids, candidate }) => window.__sceneSeedRuntimeTest.writeSelection(window.app.graph.getNodeById(ids[0]),
            { version: 1, categories: { 'Modal Undo Runtime': [{ ...candidate, weight: 2.5 }] } }), { ids: mixed.ids, candidate });
        await page.evaluate(id => window.__sceneSeedRuntimeTest.openCandidatePicker(id), mixed.ids[0]);
        const popupFallback = await page.evaluate(async () => {
            const graph = window.app.graph, configure = graph.configure; let configured = 0;
            graph.configure = function (...args) { configured++; return configure.apply(this, args); };
            await window.__sceneSeedRuntimeTest.tracker().undo(); graph.configure = configure;
            return configured;
        });
        assert.equal(popupFallback, 1); assert.equal(await page.locator('.pc-popup').count(), 0);
        const queueHistory = await page.evaluate(async () => {
            const app = window.app, api = window.__sceneSeedRuntimeTest;
            app.graph.clear();
            const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
            const link = (from, to, name) => from.connect(0, to, to.inputs.findIndex(input => input.name === name));
            const input = add('ScenePresetInput'), a = add('ScenePrompter'), b = add('ScenePrompter'), inner = add('ScenePrompterQueue'), output = add('ScenePresetOutput');
            link(input, a, 'scene_prompt'); link(input, b, 'scene_prompt'); link(a, inner, 'scene_prompt1'); link(b, inner, 'scene_prompt2'); link(inner, output, 'scene_prompt');
            const presetGraph = await app.graphToPrompt();
            const saved = await fetch('/scene_presets/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                preset_id: 'weight-history-queue', name: 'Weight History Queue', output_node_id: String(output.id), api_graph: presetGraph, workflow: presetGraph.workflow,
            }) });
            if (!saved.ok) throw new Error(await saved.text());
            await api.reloadPresets(); app.graph.clear();
            const seed = add('ScenePrompter'), matrix = add('SceneMatrix'), queue = add('ScenePrompterQueue'), expand = add('ScenePrompterExpand');
            seed.widgets.find(widget => widget.name === 'positive_base').value = 'seed tag';
            link(seed, matrix, 'scene_prompt'); link(matrix, queue, 'scene_prompt1'); link(queue, expand, 'scene_prompt');
            const normal = { ...api.matrixLine('Normal'), positive_base: 'normal tag', positive_parts: ['normal tag'] }, preset = { ...api.matrixLine('Preset Queue'), row_kind: 'preset', preset_id: 'weight-history-queue', switch_settings_json: '[]', enabled: false };
            api.writeMatrix(matrix, { version: 1, sets: [normal, preset] });
            await app.loadGraphData(JSON.parse(JSON.stringify(app.graph.serialize())), true, true);
            await new Promise(done => setTimeout(done, 300));
            const ids = { matrix: matrix.id, queue: queue.id, expand: expand.id }, tracker = api.tracker(); tracker.captureCanvasState();
            const snapshot = () => {
                const queue = app.graph.getNodeById(ids.queue), expand = app.graph.getNodeById(ids.expand);
                const controls = ['order_mode', 'alternate_block_size', 'downstream_count_mode'].filter(name => queue.widgets.some(widget => widget.name === name));
                return { lock: queue.sceneQueueControlLock || '', disabled: controls.map(name => queue.widgets.find(widget => widget.name === name).disabled),
                    total: api.expandCounts(expand).totalBatches, displayed: expand.widgets.find(widget => widget.sceneRole === 'expand_total_count')?.sceneTotalCount, label: expand.widgets.find(widget => widget.sceneRole === 'expand_run_all')?.name };
            };
            const before = snapshot();
            api.writeMatrix(app.graph.getNodeById(ids.matrix), { version: 1, sets: [normal, { ...preset, enabled: true }] });
            await new Promise(done => setTimeout(done, 300)); const edited = snapshot();
            await tracker.undo(); const undone = snapshot();
            await tracker.redo(); const redone = snapshot();
            return { before, edited, undone, redone };
        });
        assert.equal(queueHistory.before.lock, ''); assert.equal(queueHistory.before.total, 1); assert.equal(queueHistory.before.displayed, 1);
        assert.equal(queueHistory.edited.lock, 'upstream'); assert.equal(queueHistory.edited.total, 3); assert.equal(queueHistory.edited.displayed, 3);
        assert(queueHistory.edited.disabled.length > 0 && queueHistory.edited.disabled.every(Boolean));
        assert.deepEqual(queueHistory.undone, queueHistory.before);
        assert.deepEqual(queueHistory.redone, queueHistory.edited);
        console.log('native mixed-node history, capture/close draft flush, fallback and settled-state checks passed');
    } finally {
        await page.unroute('**/scene_prompt/items*', items);
        await page.unroute('**/scene_prompt/saved_prompts*', saved);
        await page.evaluate(() => window.__sceneSeedRuntimeTest.reloadCandidateItems());
    }
}
