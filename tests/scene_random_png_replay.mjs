import assert from 'node:assert/strict';

export async function testRandomPngReplay(page) {
    const result = await page.evaluate(async () => {
        const app = window.app;
        const { api } = await import('/scripts/api.js');
        const add = (type) => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const set = (node, name, value) => { node.widgets.find(widget => widget.name === name).value = value; };
        const connect = (from, to, name = 'scene_prompt', slot = 0) => from.connect(slot, to, to.inputs.findIndex(input => input.name === name));
        const post = async (path, body) => {
            const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!response.ok) throw new Error(await response.text());
            return response.json();
        };
        const execute = async (ordinary = false) => {
            const prompt = await app.graphToPrompt();
            let handle;
            try {
                let queued;
                if (ordinary) {
                    queued = await api.queuePrompt(0, prompt);
                } else {
                    handle = (await post('/scene_prompt/runs/prepare', { api_graph: prompt, workflow: prompt.workflow })).run_handle;
                    for (const node of Object.values(prompt.output)) {
                        if (['ScenePrompter', 'SceneMatrix', 'ScenePresetReference', 'ScenePrompterExpand', 'ScenePromptToText'].includes(node.class_type)) node.inputs.run_handle = handle;
                    }
                    queued = await post('/prompt', { prompt: prompt.output, extra_data: { extra_pnginfo: { workflow: prompt.workflow } } });
                }
                const deadline = Date.now() + 20000;
                while (Date.now() < deadline) {
                    const history = (await (await fetch(`/history/${queued.prompt_id}`)).json())[queued.prompt_id];
                    if (history?.status) {
                        if (history.status.status_str !== 'success') throw new Error(JSON.stringify(history.status));
                        return history.outputs;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error('Random PNG replay did not complete');
            } finally {
                if (handle) await post('/scene_prompt/runs/release', { run_handle: handle });
            }
        };
        const reloadPng = async (image) => {
            const blob = await (await fetch(`/view?${new URLSearchParams(image)}`)).blob();
            await app.handleFile(new File([blob], 'random-replay.png', { type: 'image/png' }));
        };

        app.graph.clear();
        const input = add('ScenePresetInput'), gate = add('ScenePromptRandomRoute');
        const a = add('ScenePrompter'), b = add('ScenePrompter'), join = add('ScenePromptRandomRouteOutput'), output = add('ScenePresetOutput');
        set(gate, 'weights_json', JSON.stringify([5000, 5000, ...Array(8).fill(0)]));
        set(gate, 'preserve_join', true);
        set(a, 'positive_base', 'ARM_A'); set(b, 'positive_base', 'ARM_B');
        set(output, 'preset_id', 'random-png-replay');
        connect(input, gate); connect(gate, a); connect(gate, b, 'scene_prompt', 1);
        connect(a, join, 'scene_prompt1'); connect(b, join, 'scene_prompt2'); connect(join, output);
        const definition = await app.graphToPrompt();
        await post('/scene_presets/save', { preset_id: 'random-png-replay', name: 'Random PNG', output_node_id: String(output.id), api_graph: definition, workflow: definition.workflow });
        const preset = await (await fetch('/scene_presets/load?preset_id=random-png-replay&include_api_graph=1')).json();
        const results = [];
        for (const [mode, ordinary] of [['ワークフロー全体', false], ['生成経路ノードのみ', false], ['生成経路ノードのみ', true]]) {
            app.graph.clear();
            const reference = add('ScenePresetReference'), first = add('ScenePromptToText'), second = add('ScenePromptToText');
            const image = add('TestSceneTextImage'), save = add('SceneSaveImage');
            set(reference, 'preset_id', 'random-png-replay');
            for (const node of [first, second]) { set(node, 'scope', '全てのノード'); set(node, 'seed_base', 1); set(node, 'seed_base_literal', true); connect(reference, node); }
            connect(first, image, 'positive'); connect(second, image, 'negative'); connect(image, save, 'images');
            set(save, 'metadata_mode', mode); set(save, 'expand_preset_contents', true);
            const graph = await app.graphToPrompt();
            const expanded = await post('/scene_test/preset_metadata', { graph, presets: { 'random-png-replay': preset }, expand: true, text_id: String(first.id) });
            const firstText = expanded.text[0];
            let secondSeed;
            for (let seed = 2; seed <= 32; seed++) {
                expanded.output[String(second.id)].inputs.seed_base = seed;
                const candidate = await post('/scene_test/preset_metadata', { graph: expanded, text_id: String(second.id) });
                if (candidate.text[0] !== firstText) { secondSeed = seed; break; }
            }
            if (!secondSeed) throw new Error('Fixture failed to select both Random arms');
            set(second, 'seed_base', secondSeed);
            let execution = await execute(ordinary);
            const expected = execution[image.id].text;
            const rows = [expected];
            for (let iteration = 0; iteration < 2; iteration++) {
                await reloadPng(execution[save.id].images[0]);
                execution = await execute();
                rows.push(execution[image.id].text);
            }
            const random = app.graph._nodes.find(node => node.type === 'ScenePromptRandomRoute');
            const captured = await app.graphToPrompt();
            const originalSeed = captured.output[String(random.id)].inputs.seed_source_id;
            const clone = random.clone(); clone.id = -1; app.graph.add(clone);
            const cloned = await app.graphToPrompt();
            results.push({ mode, ordinary, rows, originalSeed, cloneId: clone.id, originalId: random.id,
                cloneRegistered: app.graph.getNodeById(clone.id) === clone,
                cloneSeed: cloned.output[String(clone.id)]?.inputs.seed_source_id,
                weights: captured.output[String(random.id)].inputs.weights_json });
        }
        return results;
    });
    for (const entry of result) {
        if (entry.ordinary) assert.equal(entry.rows[0][0], entry.rows[0][1], 'ordinary Queue assigns a common fresh seed');
        else assert.notEqual(entry.rows[0][0], entry.rows[0][1], 'two consumers must exercise different Random arms');
        assert.deepEqual(entry.rows[1], entry.rows[0], `${entry.mode}: PNG load must preserve both draws`);
        assert.deepEqual(entry.rows[2], entry.rows[0], `${entry.mode}: second PNG save/load must preserve both draws`);
        assert(entry.originalSeed, 'expanded workflow preserves the draw identity');
        assert(entry.cloneRegistered && entry.cloneId != null && String(entry.cloneId) !== String(entry.originalId), `clone receives a real independent node ID: ${JSON.stringify(entry)}`);
        assert.equal(entry.cloneSeed, undefined, 'cloned Random uses a new identity');
        if (entry.ordinary) assert.equal(JSON.parse(entry.weights).filter(Boolean).length, 1, 'ordinary Queue freezes the selected arm through named-widget reload');
        else assert.deepEqual(JSON.parse(entry.weights), [5000, 5000, ...Array(8).fill(0)], 'conflicting consumers must not freeze one arm');
    }
    console.log('real ComfyUI full/selected expanded Preset PNG import and second save preserve distinct Random consumers and independent clones');
}
