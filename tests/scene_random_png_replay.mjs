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

        const switches = [];
        const linkedText = [];
        for (const mode of ['ワークフロー全体', '生成経路ノードのみ']) {
            for (const literal of [false, true]) {
                app.graph.clear();
                const prelude = add('ScenePrompter'), selected = add('ScenePrompter'), matrix = add('SceneMatrix'), queue = add('ScenePrompterQueue');
                const text = add('ScenePromptToText'), image = add('TestSceneTextImage'), save = add('SceneSaveImage');
                set(prelude, 'positive_base', 'PRUNED_A'); set(selected, 'positive_base', 'SAVED_B');
                set(matrix, 'matrix_json', JSON.stringify({ version: 1, sets: [
                    { row_id: 'red', name: 'Red', path_label: 'Red', positive_base: 'RED' }, { row_id: 'blue', name: 'Blue', path_label: 'Blue', positive_base: 'BLUE' },
                ] }));
                for (const [name, type, value] of [['current_index', 'INT', 1], ['seed_base', 'INT', 0], ['seed_base_literal', 'BOOLEAN', literal]]) {
                    const provider = add(type === 'INT' ? 'PrimitiveInt' : 'PrimitiveBoolean'); set(provider, 'value', value);
                    text.addInput(name, type, { widget: { name } }); connect(provider, text, name);
                }
                connect(prelude, queue, 'scene_prompt1'); connect(selected, matrix); connect(matrix, queue, 'scene_prompt2');
                connect(queue, text); connect(text, image, 'positive'); connect(image, save, 'images'); set(save, 'metadata_mode', mode);
                let execution = await execute(); const rows = [execution[image.id].text];
                await reloadPng(execution[save.id].images[0]);
                const reloaded = await app.graphToPrompt();
                execution = await execute(); rows.push(execution[image.id].text);
                linkedText.push({ mode, literal, rows, controls: reloaded.output[String(text.id)].inputs });
            }
        }
        const linkedRandom = [];
        for (const mode of ['ワークフロー全体', '生成経路ノードのみ']) {
            app.graph.clear();
            const weights = add('PrimitiveString'), preserve = add('PrimitiveBoolean'), random = add('ScenePromptRandomRoute');
            const a = add('ScenePrompter'), b = add('ScenePrompter'), join = add('ScenePromptRandomRouteOutput');
            const expand = add('ScenePrompterExpand'), image = add('TestSceneTextImage'), save = add('SceneSaveImage');
            set(weights, 'value', JSON.stringify([5000, 5000, ...Array(8).fill(0)])); set(preserve, 'value', false);
            for (const [source, name, type] of [[weights, 'weights_json', 'STRING'], [preserve, 'preserve_join', 'BOOLEAN']]) {
                random.addInput(name, type, { widget: { name } }); connect(source, random, name);
            }
            set(a, 'positive_base', 'LINKED_RANDOM_A'); set(b, 'positive_base', 'LINKED_RANDOM_B');
            set(expand, 'seed_base', 123); set(expand, 'timestamp_dir', false); set(save, 'metadata_mode', mode);
            connect(random, a); connect(random, b, 'scene_prompt', 1);
            connect(a, join, 'scene_prompt1'); connect(b, join, 'scene_prompt2'); connect(join, expand);
            connect(expand, image, 'positive'); connect(expand, save, 'scene_info', 2); connect(image, save, 'images');
            const graph = await app.graphToPrompt();
            const prepared = await post('/scene_prompt/runs/prepare', { api_graph: graph, workflow: graph.workflow, expand_node_id: String(expand.id) });
            await post('/scene_prompt/runs/release', { run_handle: prepared.run_handle });
            let execution = await execute();
            const rows = [execution[image.id].text];
            await reloadPng(execution[save.id].images[0]);
            const reloaded = await app.graphToPrompt();
            execution = await execute(); rows.push(execution[image.id].text);
            linkedRandom.push({ mode, rows, controls: reloaded.output[String(random.id)].inputs, total: prepared.total_batches });
        }
        for (const mode of ['ワークフロー全体', '生成経路ノードのみ']) {
            for (const selected of [true, false]) {
                app.graph.clear();
                const source = add('ScenePrompter'), expand = add('ScenePrompterExpand');
                const textSource = add('ScenePrompter'), text = add('ScenePromptToText');
                const literal = add('PrimitiveString'), gate = add('ComfySwitchNode');
                const image = add('TestSceneTextImage'), save = add('SceneSaveImage');
                set(source, 'positive_base', 'IMAGE_CONTEXT'); set(textSource, 'positive_base', 'TEXT_SELECTED');
                set(literal, 'value', 'LITERAL_SELECTED'); set(gate, 'switch', selected);
                set(expand, 'timestamp_dir', false); set(expand, 'seed_base', 123); set(text, 'seed_base', 123);
                set(save, 'metadata_mode', mode);
                connect(source, expand); connect(textSource, text);
                connect(literal, gate, 'on_true'); connect(text, gate, 'on_false');
                connect(gate, image, 'positive'); connect(image, save, 'images'); connect(expand, save, 'scene_info', 2);
                let execution = await execute();
                const rows = [execution[image.id].text];
                await reloadPng(execution[save.id].images[0]);
                const reloaded = await app.graphToPrompt();
                execution = await execute();
                rows.push(execution[image.id].text);
                switches.push({ mode, selected, rows, retained: Object.values(reloaded.output).map(node => node.class_type) });
            }
        }

        app.graph.clear();
        const input = add('ScenePresetInput'), gate = add('ScenePromptRandomRoute');
        const a = add('ScenePrompter'), b = add('ScenePrompter'), c = add('ScenePrompter');
        const join = add('ScenePromptRandomRouteOutput'), output = add('ScenePresetOutput');
        set(gate, 'weights_json', JSON.stringify([3333, 3333, 3334, ...Array(7).fill(0)]));
        set(gate, 'preserve_join', true);
        set(a, 'positive_base', 'ARM_A'); set(b, 'positive_base', 'ARM_B'); set(c, 'positive_base', 'ARM_C');
        set(output, 'preset_id', 'random-png-replay');
        connect(input, gate); connect(gate, a); connect(gate, b, 'scene_prompt', 1); connect(gate, c, 'scene_prompt', 2);
        connect(a, join, 'scene_prompt1'); connect(b, join, 'scene_prompt2'); connect(c, join, 'scene_prompt3'); connect(join, output);
        const definition = await app.graphToPrompt();
        await post('/scene_presets/save', { preset_id: 'random-png-replay', name: 'Random PNG', output_node_id: String(output.id), api_graph: definition, workflow: definition.workflow });
        const preset = await (await fetch('/scene_presets/load?preset_id=random-png-replay&include_api_graph=1')).json();
        const results = [];
        for (const [mode, ordinary] of [['ワークフロー全体', false], ['生成経路ノードのみ', false], ['生成経路ノードのみ', true]]) {
            app.graph.clear();
            const reference = add('ScenePresetReference'), prelude = add('ScenePrompter'), queue = add('ScenePrompterQueue');
            const first = add('ScenePrompterExpand'), second = add('ScenePromptToText');
            const image = add('TestSceneTextImage'), save = add('SceneSaveImage');
            set(reference, 'preset_id', 'random-png-replay');
            set(prelude, 'positive_base', 'UNSELECTED_PRELUDE');
            set(queue, 'order_mode', 'input_order'); set(queue, 'alternate_block_size', 1); set(queue, 'downstream_count_mode', 'multiply');
            connect(prelude, queue, 'scene_prompt1'); connect(reference, queue, 'scene_prompt2');
            set(first, 'timestamp_dir', false); set(second, 'scope', '全てのノード');
            for (const node of [first, second]) { set(node, 'current_index', 1); set(node, 'seed_base', 1); set(node, 'seed_base_literal', true); connect(queue, node); }
            connect(first, image, 'positive'); connect(second, image, 'negative'); connect(image, save, 'images');
            set(save, 'metadata_mode', mode); set(save, 'expand_preset_contents', true);
            const graph = await app.graphToPrompt();
            const expanded = await post('/scene_test/preset_metadata', { graph, presets: { 'random-png-replay': preset }, expand: true, text_id: String(second.id) });
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
                index: captured.output[String(first.id)].inputs.current_index,
                weights: captured.output[String(random.id)].inputs.weights_json });
        }
        return { random: results, switches, linkedRandom, linkedText };
    });
    for (const entry of result.linkedText) {
        assert.deepEqual(entry.rows.map(row => row[0]), ['SAVED_B, RED', 'SAVED_B, RED']);
        if (entry.mode === '生成経路ノードのみ') {
            assert.equal(entry.controls.current_index, 0);
            assert.equal(typeof entry.controls.seed_base, 'number');
            assert.equal(entry.controls.seed_base_literal, false);
            if (entry.literal) assert.equal(entry.controls.seed_base, 1);
        } else {
            for (const name of ['current_index', 'seed_base', 'seed_base_literal']) assert(Array.isArray(entry.controls[name]));
        }
    }
    for (const entry of result.linkedRandom) {
        assert.equal(entry.total, 1);
        assert.deepEqual(entry.rows[0], entry.rows[1], `${entry.mode}: linked Random controls preserve the selected PNG output`);
        if (entry.mode === '生成経路ノードのみ') {
            assert.equal(typeof entry.controls.weights_json, 'string');
            assert.equal(JSON.parse(entry.controls.weights_json).filter(Boolean).length, 1);
            assert.equal(entry.controls.preserve_join, true);
        } else {
            assert(Array.isArray(entry.controls.weights_json));
            assert(Array.isArray(entry.controls.preserve_join));
        }
    }
    for (const entry of result.switches) {
        const expected = entry.selected ? 'LITERAL_SELECTED' : 'TEXT_SELECTED';
        assert.deepEqual(entry.rows.map(row => row[0]), [expected, expected], 'native PNG import preserves the actual generic Switch branch');
        if (entry.mode === '生成経路ノードのみ') {
            assert(!entry.retained.includes('ComfySwitchNode'));
            assert.equal(entry.retained.includes('ScenePromptToText'), !entry.selected);
        } else assert(entry.retained.includes('ComfySwitchNode'));
    }
    for (const entry of result.random) {
        if (entry.ordinary) assert.equal(entry.rows[0][0], entry.rows[0][1], 'ordinary Queue assigns a common fresh seed');
        else assert.notEqual(entry.rows[0][0], entry.rows[0][1], 'two consumers must exercise different Random arms');
        assert.deepEqual(entry.rows[1], entry.rows[0], `${entry.mode}: PNG load must preserve both draws`);
        assert.deepEqual(entry.rows[2], entry.rows[0], `${entry.mode}: second PNG save/load must preserve both draws`);
        assert.equal(entry.index, entry.mode === 'ワークフロー全体' ? 1 : 0, 'full workflow preserves the index; selected mode rebases after removing the prelude');
        assert(entry.rows.flat().every(text => ['ARM_A', 'ARM_B', 'ARM_C'].includes(text)), 'replay never selects the unconsumed prelude');
        assert(entry.originalSeed, 'expanded workflow preserves the draw identity');
        assert(entry.cloneRegistered && entry.cloneId != null && String(entry.cloneId) !== String(entry.originalId), `clone receives a real independent node ID: ${JSON.stringify(entry)}`);
        assert.equal(entry.cloneSeed, undefined, 'cloned Random uses a new identity');
        if (entry.ordinary) assert.equal(JSON.parse(entry.weights).filter(Boolean).length, 1, 'ordinary Queue freezes the selected arm through named-widget reload');
        else assert.deepEqual(JSON.parse(entry.weights), [3333, 3333, 3334, ...Array(7).fill(0)], 'conflicting consumers retain the original distribution including the third arm');
    }
    console.log('real ComfyUI full/selected PNG import preserves generic Switch selection, distinct Random consumers and independent clones');
}
