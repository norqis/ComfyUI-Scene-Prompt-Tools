import assert from 'node:assert/strict';

export async function verifyLinkedControlCache(page) {
    await page.request.post(new URL('/scene_test/cache_probe_start', page.url()).href, { data: {} });
    const result = await page.evaluate(async () => {
        const app = window.app;
        app.graph.clear();
        const add = type => {
            const node = window.LiteGraph.createNode(type);
            app.graph.add(node);
            return node;
        };
        const set = (node, name, value) => { node.widgets.find(widget => widget.name === name).value = value; };
        const link = (from, to, name, slot = 0) => from.connect(slot, to, to.inputs.findIndex(input => input.name === name));
        const count = add('ScenePromptCounter'), queue = add('ScenePrompterQueue');
        const latent = add('SceneEmptyLatent'), lora = add('SceneApplyLora');
        const text = add('ScenePromptToText'), probe = add('SceneCacheProbe');
        const amount = add('PrimitiveInt'), block = add('PrimitiveInt'), width = add('PrimitiveInt');
        const strength = add('PrimitiveFloat'), scope = add('PrimitiveString');
        set(amount, 'value', 2); set(block, 'value', 2); set(width, 'value', 512); set(strength, 'value', 0.8);
        set(scope, 'value', text.widgets.find(widget => widget.name === 'scope').value);
        set(queue, 'order_mode', 'alternate'); set(lora, 'lora_name', 'runtime-hat.safetensors');
        set(text, 'seed_base', 7);
        link(amount, count, 'count'); link(count, queue, 'scene_prompt1'); link(block, queue, 'alternate_block_size');
        link(queue, latent, 'scene_prompt'); link(width, latent, 'width'); link(latent, lora, 'scene_prompt');
        link(strength, lora, 'strength_model'); link(lora, text, 'scene_prompt'); link(scope, text, 'scope');
        link(lora, probe, 'scene_prompt'); link(text, probe, 'positive');
        const response = await fetch('/scene_prompt/runs/prepare', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_graph: await app.graphToPrompt() }),
        });
        const prepared = await response.json();
        if (!response.ok || !prepared.run_handle) throw new Error(JSON.stringify(prepared));
        let autoSeed = false;
        const execute = async () => {
            const graph = await app.graphToPrompt();
            graph.output[String(text.id)].inputs.run_handle = prepared.run_handle;
            if (autoSeed) {
                // Bypass normal UI seed materialization to exercise ComfyUI's
                // linked None signature and runtime automatic seed semantics.
                for (const node of Object.values(graph.output)) {
                    if (['ScenePromptToText', 'ScenePrompterExpand'].includes(node.class_type)) {
                        node.inputs.seed_base_literal = false;
                    }
                }
            }
            const posted = await fetch('/prompt', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph.output }),
            });
            const queued = await posted.json();
            if (!posted.ok || !queued.prompt_id) throw new Error(JSON.stringify(queued));
            const started = performance.now();
            while (performance.now() - started < 10_000) {
                const history = (await (await fetch('/history/' + queued.prompt_id)).json())[queued.prompt_id];
                if (history?.status) {
                    if (history.status.status_str !== 'success') throw new Error(JSON.stringify(history));
                    return {
                        text: history.outputs[String(probe.id)].text,
                        counts: await (await fetch('/scene_test/cache_probe_counts')).json(),
                    };
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            throw new Error('Linked control cache probe timed out');
        };
        try {
            const first = await execute(), same = await execute();
            set(amount, 'value', 3);
            const changed = await execute();
            const seed = add('PrimitiveInt'), expand = add('ScenePrompterExpand');
            set(seed, 'value', 0);
            link(seed, text, 'seed_base'); link(seed, expand, 'seed_base');
            link(lora, expand, 'scene_prompt'); link(expand, probe, 'seed', 3);
            autoSeed = true;
            const automaticFirst = await execute(), automaticSecond = await execute();
            return { first, same, changed, automaticFirst, automaticSecond };
        } finally {
            await fetch('/scene_prompt/runs/release', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run_handle: prepared.run_handle }),
            });
            app.graph.clear();
        }
    });
    for (const name of ['ScenePromptCounter', 'ScenePrompterQueue', 'SceneEmptyLatent', 'SceneApplyLora', 'ScenePromptToText']) {
        assert.equal(result.first.counts[name], 1, `${name}: first execution`);
        assert.equal(result.same.counts[name], 1, `${name}: unchanged linked input reuses cache`);
        assert.equal(result.changed.counts[name], 2, `${name}: changed ancestor invalidates cache`);
    }
    assert.equal(JSON.parse(result.same.text[0]).total_batches, 4);
    assert.equal(JSON.parse(result.changed.text[0]).total_batches, 6);
    for (const name of ['ScenePromptToText', 'ScenePrompterExpand']) {
        assert.equal(result.automaticSecond.counts[name], result.automaticFirst.counts[name] + 1, `${name}: linked zero seed reruns`);
    }
    assert.notEqual(result.automaticFirst.text[2], result.automaticSecond.text[2], 'automatic Expand seeds stay fresh');
    console.log('real ComfyUI linked controls reuse cache, ancestor edits invalidate it, and linked zero seeds remain automatic');
}

export async function verifyCompactPresetRuntime(page) {
    const result = await page.evaluate(async () => {
        const post = async (path, data) => {
            const response = await fetch(path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(JSON.stringify(result));
            return result;
        };
        const node = (class_type, inputs) => ({ class_type, inputs });
        const leaf = { input: node('ScenePresetInput', {}) };
        let source = 'input';
        for (let index = 0; index < 18; index++) {
            const id = `tag${index}`;
            leaf[id] = node('ScenePrompter', {
                scene_prompt: [source, 0], positive_base: `probe_${index}`, positive_json: '{"version":1,"categories":{}}',
                negative_base: '', negative_json: '{"version":1,"categories":{}}', category_order: '',
                prompt_name: id, seed: 0, randomize: true, source_node_id: id,
            });
            source = id;
        }
        leaf.lora = node('SceneApplyLora', {
            scene_prompt: [source, 0], lora_name: 'runtime-hat.safetensors', strength_model: 0.7, strength_clip: 0.4,
        });
        leaf.output = node('ScenePresetOutput', { scene_prompt: ['lora', 0] });
        await post('/scene_presets/save', {
            preset_id: 'native-compact-leaf', name: 'Compact leaf', output_node_id: 'output',
            api_graph: { output: leaf }, workflow: { nodes: [] },
        });
        const parent = { input: node('ScenePresetInput', {}) };
        source = 'input';
        for (let index = 0; index < 6; index++) {
            const id = `ref${index}`;
            parent[id] = node('ScenePresetReference', {
                preset_id: 'native-compact-leaf', scene_prompt: [source, 0], source_node_name: id,
            });
            source = id;
        }
        parent.count = node('ScenePromptCounter', { count: 1400, scene_prompt: [source, 0] });
        parent.output = node('ScenePresetOutput', { scene_prompt: ['count', 0] });
        await post('/scene_presets/save', {
            preset_id: 'native-compact-parent', name: 'Compact parent', output_node_id: 'output',
            api_graph: { output: parent }, workflow: { nodes: [] },
        });
        const graph = {
            checkpoint: node('CheckpointLoaderSimple', { ckpt_name: 'runtime-checkpoint.safetensors' }),
            model: node('SceneApplyModel', { model: ['checkpoint', 0], clip: ['checkpoint', 1], vae: ['checkpoint', 2] }),
            reference: node('ScenePresetReference', { preset_id: 'native-compact-parent', scene_prompt: ['model', 0] }),
            expand: node('ScenePrompterExpand', { scene_prompt: ['reference', 0], seed_base: 7 }),
            text: node('ScenePromptToText', { scene_prompt: ['reference', 0], scope: '全てのノード', seed_base: 7 }),
            probe: node('SceneCacheProbe', { scene_prompt: ['reference', 0], positive: ['text', 0] }),
        };
        const prepared = await post('/scene_prompt/runs/prepare', { api_graph: { output: graph }, expand_node_id: 'expand' });
        for (const id of ['reference', 'text']) graph[id].inputs.run_handle = prepared.run_handle;
        await post('/scene_test/execution_probe', { enabled: true });
        try {
            const queued = await post('/prompt', { prompt: graph });
            const started = performance.now();
            while (performance.now() - started < 15_000) {
                const history = (await (await fetch('/history/' + queued.prompt_id)).json())[queued.prompt_id];
                if (history?.status) {
                    if (history.status.status_str !== 'success') throw new Error(JSON.stringify(history));
                    const executed = await post('/scene_test/execution_probe', { enabled: false });
                    return { prepared, text: history.outputs.probe.text, executed, rootIds: Object.keys(graph) };
                }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Compact Preset runtime timed out');
        } finally {
            await post('/scene_test/execution_probe', { enabled: false });
            await post('/scene_prompt/runs/release', { run_handle: prepared.run_handle });
        }
    });
    assert.equal(result.prepared.total_batches, 1400);
    assert.equal(JSON.parse(result.text[0]).total_batches, 1400);
    assert(result.executed.includes('reference') && result.executed.includes('probe'));
    assert(result.executed.every(id => result.rootIds.includes(id)), 'Preset planning never registers internal nodes with ComfyUI');
    const details = JSON.parse(result.text[3]);
    assert.deepEqual(details.model_links, { model: ['checkpoint', 0], clip: ['checkpoint', 1], vae: ['checkpoint', 2] });
    assert.equal(details.loras.length, 6);
    assert.deepEqual(details.loras.map(lora => lora.source_node_id), Array.from({ length: 6 }, (_, i) => `reference/ref${i}/lora`));
    assert(details.source_node_ids.includes('reference/ref5/tag17'));
    assert(!details.source_node_ids.includes('tag17'), 'saved source IDs are scoped to their Reference occurrence');
    assert.deepEqual(await (await page.request.get(new URL('/scene_test/model_executions', page.url()).href)).json(), [], 'Reference planning never loads image models');
    console.log('real ComfyUI nested 1400-scene Preset plan stays compact, preserves model links and ordered LoRAs, and never registers internal nodes');
}
