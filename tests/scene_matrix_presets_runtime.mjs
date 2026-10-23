import assert from 'node:assert/strict';

export async function testMatrixPresetRows(page) {
    const ids = await page.evaluate(async () => {
        const app = window.app; app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const set = (node, name, value) => { node.widgets.find(widget => widget.name === name).value = value; };
        const link = (from, to, name = 'scene_prompt', slot = 0) => from.connect(slot, to, to.inputs.findIndex(input => input.name === name));
        const rows = names => JSON.stringify({ version: 1, sets: names.map(name => ({ row_id: name, name, path_label: name, positive_base: name })) });
        const input = add('ScenePresetInput'), matrix = add('SceneMatrix'), doubled = add('ScenePromptCounter'), gate = add('ComfySwitchNode'), output = add('ScenePresetOutput');
        set(input, 'switch_names_json', '["倍にする"]'); set(matrix, 'matrix_json', rows(['Y', 'Z'])); set(doubled, 'count', 2); set(doubled, 'enable_downstream_count', true);
        link(input, matrix); link(matrix, doubled); link(matrix, gate, 'on_false'); link(doubled, gate, 'on_true'); link(input, gate, 'switch', 1); link(gate, output);
        const graph = await app.graphToPrompt();
        const response = await fetch('/scene_presets/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset_id: 'matrix-child', name: 'MatrixChild', output_node_id: String(output.id), api_graph: graph, workflow: graph.workflow }) });
        if (!response.ok) throw new Error(await response.text());
        app.graph.clear();
        const upstream = add('SceneMatrix'), target = add('SceneMatrix'), maker = add('ScenePromptMakeSwitch'), expand = add('ScenePrompterExpand');
        const image = add('TestSceneTextImage'), save = add('SceneSaveImage');
        set(upstream, 'matrix_json', rows(['A', 'B'])); set(target, 'matrix_json', rows(['X']));
        set(maker, 'switch_values_json', '[true,false,false,false,false,false,false,false,false,false]');
        set(expand, 'timestamp_dir', false); set(expand, 'prefix', 'MATRIX');
        link(upstream, target); link(maker, target, 'switches'); link(target, expand); link(expand, image, 'positive'); link(expand, image, 'negative', 1); link(image, save, 'images'); link(expand, save, 'scene_info', 2);
        await window.__sceneSeedRuntimeTest.refreshPresetReference(target);
        target.widgets.find(widget => widget.sceneRole === 'matrix_rows').callback();
        return { target: target.id, expand: expand.id, image: image.id, save: save.id };
    });
    const editor = page.locator('.pc-popup').filter({ has: page.getByText('Matrix 行を編集', { exact: true }) });
    assert.equal(await editor.getByRole('button', { name: '通常行を追加', exact: true }).count(), 1);
    await editor.getByRole('button', { name: 'Preset行を追加', exact: true }).click();
    const row = editor.locator('.pc-candidate').nth(1);
    await row.getByRole('button', { name: 'Presetを選択', exact: true }).click();
    await page.getByRole('button', { name: 'MatrixChild', exact: true }).click();
    await row.locator('input').fill('PresetRow');
    await row.getByRole('button', { name: 'スイッチ設定', exact: true }).click();
    const switches = page.locator('[data-scene-preset-switch-modal="settings"]');
    assert.match(await switches.textContent(), /倍にする/);
    await switches.locator('[data-scene-switch-index="1"]').selectOption('false');
    await switches.getByRole('button', { name: '閉じる', exact: true }).click();
    const stats = () => page.evaluate(async id => {
        const node = window.app.graph.getNodeById(id);
        return window.__sceneSeedRuntimeTest.countStats(node).total;
    }, ids.target);
    assert.equal(await stats(), 6);
    assert.deepEqual(await page.evaluate(id => window.__sceneSeedRuntimeTest.nodePreview(window.app.graph.getNodeById(id)), ids.target),
        ['AX', 'AYPresetRow', 'AZPresetRow', 'BX', 'BYPresetRow', 'BZPresetRow']);
    assert.deepEqual(await row.getByRole('button').allTextContents(), ['有効', '↑', 'Preset: MatrixChild', 'スイッチ設定', 'ポジティブ候補', 'ネガティブ候補', 'ファイル名付与: OFF', '複製', '削除']);
    for (const [button, placeholder, value] of [['ポジティブ候補', 'ポジティブ基本文', '(extra:1.3)'], ['ネガティブ候補', 'ネガティブ基本文', 'blocked']]) {
        await row.getByRole('button', { name: button, exact: true }).click();
        await page.getByPlaceholder(placeholder).fill(value);
        await page.locator('.pc-popup').last().getByRole('button', { name: '閉じる', exact: true }).click();
    }
    assert.match(await row.textContent(), /extra:1.3/); assert.match(await row.textContent(), /blocked/);
    await row.getByRole('button', { name: '複製', exact: true }).click();
    assert.equal(await stats(), 10);
    const copied = await page.evaluate(id => {
        const state = JSON.parse(window.app.graph.getNodeById(id).widgets.find(widget => widget.name === 'matrix_json').value);
        return state.sets.map(row => row.row_id);
    }, ids.target);
    assert.equal(new Set(copied).size, 3);
    await editor.locator('.pc-candidate').nth(2).getByRole('button', { name: '削除', exact: true }).click();
    assert.equal(await stats(), 6);
    await row.getByRole('button', { name: 'ファイル名付与: OFF', exact: true }).click();
    await row.getByRole('button', { name: 'スイッチ設定', exact: true }).click();
    await switches.locator('[data-scene-switch-index="1"]').selectOption('true');
    assert.equal(await stats(), 10, 'switch mapping saves immediately and updates the total');
    await switches.locator('[data-scene-switch-index="1"]').selectOption('false');
    await switches.getByRole('button', { name: '閉じる', exact: true }).click();
    await editor.getByRole('button', { name: '閉じる', exact: true }).click();
    const colors = await page.evaluate(id => {
        const node = window.app.graph.getNodeById(id);
        window.app.canvas.ds.scale = 1; node.size = [499, 500];
        const canvas = document.createElement('canvas'); canvas.width = 499; canvas.height = 300;
        const context = canvas.getContext('2d');
        const prototype = CanvasRenderingContext2D.prototype, fillText = prototype.fillText, badges = [];
        try {
            prototype.fillText = function (text, x, ...args) {
                if (text === 'ファイル名ON') badges.push({ right: x + this.measureText(text).width });
                return fillText.call(this, text, x, ...args);
            };
            node.widgets.find(widget => widget.sceneRole === 'matrix_connected_list').draw(context, node, 499, 0, 300);
        } finally { prototype.fillText = fillText; }
        const pixels = context.getImageData(0, 0, 499, 300).data;
        const counts = { blue: 0, purple: 0, yellow: 0 };
        for (let offset = 0; offset < pixels.length; offset += 4) {
            const rgb = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
            if (rgb === '109,160,194') counts.blue++;
            if (rgb === '196,167,231') counts.purple++;
            if (rgb === '216,184,70') counts.yellow++;
        }
        return { ...counts, badges };
    }, ids.target);
    assert(colors.blue > 0 && colors.purple > 0 && colors.yellow > 0, `native Matrix row colors ${JSON.stringify(colors)}`);
    assert.equal(colors.badges.length, 1); assert.equal(colors.badges[0].right, 483, 'filename ON is right-aligned inside the native node row');
    const result = await page.evaluate(async ids => {
        const app = window.app, { api } = await import('/scripts/api.js');
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const original = app.graph.serialize();
        const execute = async () => {
            const graph = await app.graphToPrompt();
            const queued = await api.queuePrompt(0, graph);
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                const history = (await (await fetch(`/history/${queued.prompt_id}`)).json())[queued.prompt_id];
                if (history?.status) {
                    if (history.status.status_str !== 'success') throw new Error(JSON.stringify(history.status));
                    return history.outputs;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Matrix Preset execution did not complete');
        };
        const order = [], negatives = [];
        for (let index = 0; index < 6; index++) {
            field(app.graph.getNodeById(ids.expand), 'current_index').value = index;
            const text = (await execute())[String(ids.image)].text;
            order.push(text[0]); negatives.push(text[1]);
        }
        const replay = [];
        for (const mode of ['ワークフロー全体', '生成経路ノードのみ']) for (const expanded of [false, true]) {
            await app.loadGraphData(original, true, true);
            field(app.graph.getNodeById(ids.expand), 'current_index').value = 4;
            field(app.graph.getNodeById(ids.save), 'metadata_mode').value = mode;
            field(app.graph.getNodeById(ids.save), 'expand_preset_contents').value = expanded;
            let outputs = await execute();
            const first = outputs[String(ids.image)].text[0], firstNegative = outputs[String(ids.image)].text[1], saved = outputs[String(ids.save)].images[0];
            const blob = await (await fetch(`/view?${new URLSearchParams(saved)}`)).blob();
            await app.handleFile(new File([blob], 'matrix-preset.png', { type: 'image/png' }));
            outputs = await execute();
            replay.push({ mode, expanded, first, firstNegative, second: outputs[String(ids.image)].text[0], secondNegative: outputs[String(ids.image)].text[1], filenames: [saved.filename, outputs[String(ids.save)].images[0].filename] });
        }
        await app.loadGraphData(original, true, true);
        await window.__sceneSeedRuntimeTest.refreshPresetReference(app.graph.getNodeById(ids.target));
        const beforeUpdate = window.__sceneSeedRuntimeTest.countStats(app.graph.getNodeById(ids.target)).total;
        const child = await (await fetch('/scene_presets/load?preset_id=matrix-child&include_api_graph=1')).json();
        const childMatrix = Object.values(child.api_graph.output).find(node => node.class_type === 'SceneMatrix');
        const state = JSON.parse(childMatrix.inputs.matrix_json); state.sets.push({ row_id: 'W', name: 'W', path_label: 'W', positive_base: 'W' });
        childMatrix.inputs.matrix_json = JSON.stringify(state);
        const outputId = Object.keys(child.api_graph.output).find(key => child.api_graph.output[key].class_type === 'ScenePresetOutput');
        const response = await fetch('/scene_presets/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preset_id: 'matrix-child', name: 'MatrixChild', output_node_id: outputId, api_graph: child.api_graph, workflow: child.workflow }) });
        if (!response.ok) throw new Error(await response.text());
        await window.__sceneSeedRuntimeTest.refreshPresetReference(app.graph.getNodeById(ids.target));
        const afterUpdate = window.__sceneSeedRuntimeTest.countStats(app.graph.getNodeById(ids.target)).total;
        return { order, negatives, replay, beforeUpdate, afterUpdate };
    }, ids);
    assert.deepEqual(result.order, ['A, X', 'A, Y, (extra:1.3)', 'A, Z, (extra:1.3)', 'B, X', 'B, Y, (extra:1.3)', 'B, Z, (extra:1.3)']);
    assert.deepEqual(result.negatives, ['', 'blocked', 'blocked', '', 'blocked', 'blocked']);
    assert.equal(result.beforeUpdate, 6); assert.equal(result.afterUpdate, 8, 'Preset updates invalidate the visible total');
    for (const entry of result.replay) {
        assert.equal(entry.first, 'B, Y, (extra:1.3)', JSON.stringify(entry));
        assert.equal(entry.second, entry.first, JSON.stringify(entry));
        assert.equal(entry.firstNegative, 'blocked'); assert.equal(entry.secondNegative, 'blocked');
        assert(entry.filenames.every(name => name.includes('PresetRow')), JSON.stringify(entry));
    }
    console.log('real ComfyUI Matrix normal/Preset rows, picker, immediate switch mapping, duplicate/delete, counts, AX..BZ order and all four PNG replay modes passed');
}
