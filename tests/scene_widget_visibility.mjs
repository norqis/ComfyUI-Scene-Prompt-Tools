import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function verifySceneWidgetVisibility(page) {
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1500, height: 950 });
    const ids = await page.evaluate(async () => {
        const app = window.app; app.graph.clear();
        const add = (type, pos) => { const node = window.LiteGraph.createNode(type); app.graph.add(node); node.pos = pos; return node; };
        const prompt = add('ScenePrompter', [30, 40]), lora = add('SceneApplyLora', [480, 40]);
        const queue = add('ScenePrompterQueue', [960, 40]), count = add('ScenePromptCounter', [960, 350]);
        prompt.connect(0, lora, lora.inputs.findIndex(input => input.name === 'scene_prompt'));
        lora.connect(0, queue, queue.inputs.findIndex(input => input.name === 'scene_prompt1'));
        queue.connect(0, count, count.inputs.findIndex(input => input.name === 'scene_prompt'));
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        field(lora, 'strength_model').value = 0.65; field(lora, 'strength_clip').value = 0.85;
        field(prompt, 'positive_base').value = 'visible prompt';
        app.canvas.ds.scale = 0.85; app.canvas.ds.offset = [0, 0];
        await new Promise(done => setTimeout(done, 350));
        const a = app.extensionManager.workflow.activeWorkflow; a.changeTracker.captureCanvasState();
        window.__sceneVisibility = {
            ids: { prompt: prompt.id, lora: lora.id, queue: queue.id, count: count.id },
            inspect() {
                const node = app.graph.getNodeById(this.ids.lora); app.canvas.draw(true, true);
                const fields = ['strength_model', 'strength_clip'].map(name => {
                    const widget = field(node, name); let owner = widget;
                    while (owner && !Object.getOwnPropertyDescriptor(owner, 'hidden')) owner = Object.getPrototypeOf(owner);
                    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'hidden');
                    return { name, type: widget.type, hidden: widget.hidden, optionsHidden: !!widget.options?.hidden,
                        sceneOwned: !!widget.sceneHiddenState, height: (widget.computeSize?.(400)?.[1] ?? widget.computedHeight), value: widget.value,
                        hiddenOwn: Object.hasOwn(widget, 'hidden'), hiddenSetter: !!descriptor?.set };
                });
                const sockets = ['strength_model', 'strength_clip'].map(name => {
                    const index = node.inputs.findIndex(input => input.name === name);
                    return { name, linked: node.inputs[index].link != null, y: node.getConnectionPos(true, index)[1] };
                });
                const internals = [this.ids.prompt, this.ids.lora, this.ids.queue, this.ids.count].flatMap(id => app.graph.getNodeById(id).widgets
                    .filter(widget => ['positive_json', 'negative_json', 'category_order', 'run_handle', 'input_repeats_json', 'source_node_id', 'source_node_name'].includes(widget.name))
                    .map(widget => ({ name: widget.name, type: widget.type, hidden: widget.hidden, height: (widget.computeSize?.(400)?.[1] ?? widget.computedHeight), owned: !!widget.sceneHiddenState })));
                const publicFields = [[this.ids.prompt, ['positive_base', 'negative_base']], [this.ids.count, ['count', 'enable_downstream_count']], [this.ids.queue, ['order_mode', 'alternate_block_size', 'downstream_count_mode']]]
                    .flatMap(([id, names]) => names.map(name => {
                        const widget = field(app.graph.getNodeById(id), name);
                        return { name, type: widget.type, sceneOwned: !!widget.sceneHiddenState, height: (widget.computeSize?.(400)?.[1] ?? widget.computedHeight) };
                    }));
                const buttons = node.widgets.filter(widget => ['lora_details', 'positive_open', 'negative_open'].includes(widget.sceneRole))
                    .map(widget => ({ role: widget.sceneRole, bottom: (widget.last_y ?? widget.y) + 24 }));
                return { fields, sockets, internals, publicFields, buttons, height: node.size[1] };
            },
            drawLabels() {
                const labels = ['モデル強度', 'CLIP強度'], texts = [], prototype = CanvasRenderingContext2D.prototype;
                const original = prototype.fillText;
                let suppress = false;
                prototype.fillText = function (text, ...args) {
                    if (labels.some(label => String(text).includes(label))) {
                        texts.push(String(text)); if (suppress) return;
                    }
                    return original.call(this, text, ...args);
                };
                try {
                    const canvas = app.canvas.canvas, ctx = canvas.getContext('2d');
                    app.canvas.draw(true, true); const normal = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    suppress = true; app.canvas.draw(true, true); const without = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let changed = 0; for (let i = 0; i < normal.length; i += 4) if (normal[i] !== without[i] || normal[i + 1] !== without[i + 1] || normal[i + 2] !== without[i + 2]) changed++;
                    return { labels: labels.map(label => texts.some(text => text.includes(label))), pixels: changed };
                } finally { prototype.fillText = original; app.canvas.draw(true, true); }
            },
        };
        // Open a distinct real workflow tab. The test navigates via its tab UI.
        const workflow = JSON.parse(JSON.stringify(app.graph.serialize()));
        await app.loadGraphData({ ...workflow, id: crypto.randomUUID(), nodes: [], links: [], last_node_id: 0, last_link_id: 0 }, true, true);
        return window.__sceneVisibility.ids;
    });
    const tabs = page.getByRole('tab');
    const names = await tabs.allTextContents();
    assert.equal(names.length, 2, `native workflow tabs: ${names.join(', ')}`);
    const a = tabs.nth(0), b = tabs.nth(1);
    const read = () => page.evaluate(() => window.__sceneVisibility.inspect());
    const check = async (stage, connected) => {
        const value = await read();
        for (const widget of value.fields) {
            assert.equal(widget.type, 'number', `${stage}: ${widget.name} native type`);
            assert.equal(widget.sceneOwned, false, `${stage}: Scene must not own native hiding`);
            assert.equal(widget.optionsHidden, false); assert.equal(widget.height, 24);
        }
        assert(value.sockets.every(input => input.linked === connected), `${stage}: ${JSON.stringify(value.sockets)}`);
        assert.equal(Math.abs(value.sockets[1].y - value.sockets[0].y), 24, `${stage}: separate native input rows`);
        assert(value.buttons.length >= 3 && value.buttons.every(button => Number.isFinite(button.bottom) && button.bottom <= value.height + 1), `${stage}: public buttons fit the node: ${JSON.stringify(value.buttons)}/${value.height}`);
        assert(value.internals.length > 0 && value.internals.every(widget => widget.hidden && widget.type === 'hidden' && widget.height === 0), `${stage}: internal fields stay hidden`);
        assert(value.publicFields.every(widget => !widget.sceneOwned && widget.type !== 'hidden' && (widget.height == null || widget.height > 0)), `${stage}: other public controls survive`);
        const drawing = await page.evaluate(() => window.__sceneVisibility.drawLabels());
        assert.deepEqual(drawing.labels, [true, true], `${stage}: both labels reach actual canvas text drawing`);
        assert(drawing.pixels > 20, `${stage}: label drawing changes visible pixels`);
        return value;
    };
    const cycle = async (stage, connected) => {
        for (let i = 0; i < 3; i++) {
            await a.click(); await page.waitForTimeout(350); await check(`${stage} A${i}`, connected);
            await b.click(); await page.waitForTimeout(150);
        }
        await a.click(); await page.waitForTimeout(350);
    };
    await cycle('unconnected', false);
    await page.evaluate(ids => {
        const app = window.app, node = app.graph.getNodeById(ids.lora), tracker = window.__sceneSeedRuntimeTest.tracker();
        tracker.captureCanvasState(); app.graph.beforeChange(); app.canvas.emitBeforeChange();
        try {
            for (const [i, name] of ['strength_model', 'strength_clip'].entries()) {
                const widget = node.widgets.find(widget => widget.name === name); widget.value = [0.7, 0.9][i]; widget.callback?.(widget.value);
            }
        } finally { app.graph.afterChange(); app.canvas.emitAfterChange(); }
    }, ids);
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().undo());
    assert.deepEqual((await check('unconnected undo', false)).fields.map(widget => widget.value), [0.65, 0.85]);
    await page.evaluate(() => window.__sceneSeedRuntimeTest.tracker().redo());
    await check('unconnected redo', false);
    await page.evaluate(ids => {
        const app = window.app, node = app.graph.getNodeById(ids.lora);
        for (const [i, name] of ['strength_model', 'strength_clip'].entries()) {
            const primitive = window.LiteGraph.createNode('PrimitiveFloat'); app.graph.add(primitive); primitive.pos = [270, 70 + i * 120];
            primitive.widgets.find(widget => widget.name === 'value').value = [0.7, 0.9][i];
            primitive.connect(0, node, node.inputs.findIndex(input => input.name === name));
        }
    }, ids);
    await cycle('connected', true);
    await page.screenshot({ path: join(tmpdir(), 'scene-native-widgets-connected.png') });
    const linked = await page.evaluate(async ids => {
        const api = await window.app.graphToPrompt(), values = api.output[String(ids.lora)].inputs;
        return ['strength_model', 'strength_clip'].map(name => ({ link: values[name], value: api.output[String(values[name][0])].inputs.value }));
    }, ids);
    assert.deepEqual(linked.map(item => item.value), [0.7, 0.9]);
    await page.evaluate(async () => window.app.loadGraphData(JSON.parse(JSON.stringify(window.app.graph.serialize())), false, false, window.app.extensionManager.workflow.activeWorkflow));
    await page.waitForTimeout(350); await check('connected save/reload', true);
    await page.evaluate(ids => {
        const node = window.app.graph.getNodeById(ids.lora);
        for (const name of ['strength_model', 'strength_clip']) node.disconnectInput(node.inputs.findIndex(input => input.name === name));
        window.__sceneSeedRuntimeTest.tracker().captureCanvasState();
    }, ids);
    await check('immediately disconnected', false);
    await cycle('disconnected', false);
    await page.evaluate(async () => window.app.loadGraphData(JSON.parse(JSON.stringify(window.app.graph.serialize())), false, false, window.app.extensionManager.workflow.activeWorkflow));
    await page.waitForTimeout(350); await check('disconnected save/reload', false);
    await page.screenshot({ path: join(tmpdir(), 'scene-native-widgets-disconnected.png') });
    await page.setViewportSize(viewport);
    console.log('native widget visibility: actual A/B tabs ×3 for unconnected, connected and disconnected LoRA; canvas labels/pixels, 24px sockets, public controls, hidden JSON, history and API survive');
}
