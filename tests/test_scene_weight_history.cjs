const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.SCENE_NATIVE_UI_SOURCE || path.join(__dirname, '../web/scene_prompt_ui.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    assert(start >= 0, name);
    const body = source.indexOf(') {', start) + 2;
    let depth = 0;
    for (let i = body; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(name);
}
const clone = value => JSON.parse(JSON.stringify(value));
const promptNames = ['prompt_name', 'positive_base', 'positive_json', 'negative_base', 'negative_json', 'category_order', 'seed', 'control_after_generate', 'randomize', 'run_handle', 'filename_enabled', 'model_mode'];
const loraNames = ['lora_name', 'strength_model', 'strength_clip', 'model_mode', 'positive', 'negative', 'positive_json', 'negative_json', 'category_order'];
const selection = weight => JSON.stringify({ version: 1, categories: { Test: [{ id: 'x', prompt: 'tag', weight }] } });

async function main() {
    const context = vm.createContext({ document: { activeElement: null }, formatWeight: value => String(Number(value)), showSceneBatchError: error => { throw error; }, Number, Object, Array, Set, clearTimeout });
    for (const name of ['flushSceneWeightDraft', 'bindSceneWeightDraft']) vm.runInContext(extract(name), context);
    const input = () => ({ value: '1', handlers: {}, addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }, setCustomValidity() {}, emit(type) { for (const handler of this.handlers[type] || []) handler(); } });
    const control = input(), commits = [];
    context.bindSceneWeightDraft(control, value => commits.push(value));
    context.document.activeElement = control;
    for (let i = 1; i <= 11; i++) { control.value = String(1 + i / 20); control.emit('input'); }
    assert.equal(commits.length, 0, 'spinner input events never save');
    control.emit('change'); control.emit('blur');
    assert.deepEqual(commits, ['1.55'], 'one native hold produces one commit');
    for (const value of ['1.6', '1.65']) { control.value = value; control.emit('input'); control.emit('change'); }
    assert.equal(commits.length, 3, 'distinct native changes retain distinct history steps');
    for (const value of ['', '-', 'NaN', 'Infinity']) {
        control.value = value; control.emit('input'); context.flushSceneWeightDraft();
        assert.equal(control.value, '1.65');
    }
    control.value = '1.700'; control.emit('input'); context.flushSceneWeightDraft(); control.emit('blur');
    assert.deepEqual(commits, ['1.55', '1.6', '1.65', '1.7']);
    context.flushSceneWeightDraft({ contains: () => false });
    assert.equal(commits.length, 4);

    Object.assign(context, {
        SCENE_PROMPT_SERIALIZED_WIDGET_NAMES: promptNames, SCENE_LORA_STORED_WIDGET_NAMES: loraNames,
        parseSelectionState: JSON.parse, parseMatrixState: JSON.parse,
        nodeClassName: node => node.type, findWidget: (node, name) => node.widgets.find(widget => widget.name === name),
        collectDownstreamSceneNodes: () => {}, clearSceneFitHeightTimer: () => {}, clearSceneComputedCaches: () => {}, refreshNode: () => {},
        activePopupContext: null, popupContextReferencesNode: (context, node) => context?.node === node, isScenePromptQueueNode: () => false,
        sceneWorkflowLoadDepth: 0, sceneWorkflowLoadSources: new Set(),
    });
    for (const name of ['sceneWorkflowsMatch', 'sceneHistoryEqual', 'sceneSelectionHistoryPlan', 'restoreSceneSelectionHistory', 'installSceneWorkflowLoadGuard']) vm.runInContext(extract(name), context);
    function setup() {
        const graph = { rootData: { id: 'root', links: [], groups: [], extra: {} }, subgraphs: new Map(), getNodeById(id) { return this.nodes.find(node => node.id === id); }, serialize() { return { ...clone(this.rootData), nodes: this.nodes.map(node => node.serialize()) }; } };
        graph.nodes = ['ScenePrompter', 'SceneApplyLora', 'SceneMatrix'].map((type, index) => {
            const names = index === 0 ? promptNames : index === 1 ? loraNames : ['matrix_json', 'run_handle'];
            const values = names.map(name => name.endsWith('_json') ? name === 'matrix_json' ? '{"version":1,"sets":[]}' : selection(1) : '');
            const node = { graph, id: index + 1, type, size: [400, 300], pos: [100, 100], properties: index === 2 ? { scene_matrix_json: values[0] } : {},
                // UI-only buttons precede serialized widgets deliberately.
                widgets: [{ name: 'extra button', serialize: false }, ...names.map((name, i) => ({ name, value: values[i] }))], widgets_values: [],
                serialize() { const values = names.map(name => this.widgets.find(widget => widget.name === name).value); return { id: this.id, type: this.type, pos: this.pos.slice(), size: this.size.slice(), properties: { ...this.properties }, widgets_values: values, widgets_values_named: Object.fromEntries(names.map((name, i) => [name, values[i]])) }; },
            };
            return node;
        });
        const workflow = { path: 'workflows/fixture.json', changeTracker: { _restoringState: true, activeState: clone(graph.serialize()) } };
        workflow.changeTracker.workflow = workflow;
        context.sceneActiveWorkflow = () => workflow;
        const app = context.app = { graph, rootGraph: graph, canvas: { graph }, fullLoads: 0, async loadGraphData(target) {
            this.fullLoads++;
            const { nodes, ...rootData } = clone(target); graph.rootData = rootData;
            // A full native configure restores the target after a partial failure.
            graph.nodes = target.nodes.map(saved => ({ id: saved.id, graph, type: saved.type, serialize: () => clone(saved) }));
            workflow.changeTracker.activeState = clone(target); return true;
        } };
        context.installSceneWorkflowLoadGuard();
        return { app, graph, workflow, before: clone(graph.serialize()), args: target => [target, false, false, workflow, { checkForRerouteMigration: false, silentAssetErrors: true }] };
    }
    function edit(target, index, name, value) {
        const node = target.nodes[index], slot = Object.keys(node.widgets_values_named).indexOf(name);
        node.widgets_values[slot] = value; node.widgets_values_named[name] = value;
        if (name === 'matrix_json') node.properties.scene_matrix_json = value;
    }
    {
        const { app, graph, workflow, before, args } = setup(), identities = graph.nodes.slice(), target = clone(before);
        edit(target, 0, 'positive_json', selection(1.3)); edit(target, 1, 'negative_json', selection(1.4));
        edit(target, 2, 'matrix_json', '{"version":1,"sets":[{"name":"new"}]}'); target.nodes[0].size = [400, 320];
        const visits = new Map(), shared = new Map([[identities[0], [identities[1], identities[2]]], [identities[1], [identities[2]]]]);
        context.downstreamNodes = node => { visits.set(node, (visits.get(node) || 0) + 1); return shared.get(node) || []; };
        context.isRerouteNode = () => false; context.isPromptMatrixNode = () => false;
        context.isScenePromptSourceNode = () => true; context.isSceneExpandNode = () => false;
        vm.runInContext(extract('collectDownstreamSceneNodes'), context);
        assert.equal(await app.loadGraphData(...args(target)), true);
        assert.equal(app.fullLoads, 0); assert.deepEqual(graph.nodes, identities);
        assert.equal(visits.size, 3); assert([...visits.values()].every(count => count === 1), 'all changed nodes share one downstream traversal');
        assert.deepEqual(graph.serialize(), target); assert.equal(workflow.changeTracker.activeState, target);
        assert.equal(await app.loadGraphData(...args(before)), true);
        assert.equal(app.fullLoads, 0); assert.deepEqual(graph.serialize(), before);
        context.collectDownstreamSceneNodes = () => {};
    }
    {
        const x = setup(), target = clone(x.before); edit(target, 0, 'positive_json', selection(2));
        x.graph.rootData.undefinedNativeField = undefined;
        const args = x.args(target); args[3] = { path: x.workflow.path, changeTracker: x.workflow.changeTracker };
        await x.app.loadGraphData(...args); assert.equal(x.app.fullLoads, 0, 'native raw/Proxy workflow and JSON snapshot equality');
    }
    {
        const x = setup(), target = clone(x.before); edit(target, 0, 'positive_json', selection(2));
        const args = x.args(target); args[3] = { path: x.workflow.path, changeTracker: {} };
        await x.app.loadGraphData(...args); assert.equal(x.app.fullLoads, 1, 'same path does not authorize a different tracker');
    }
    {
        const x = setup(), target = clone(x.before); edit(target, 0, 'positive_json', selection(2));
        context.activePopupContext = { node: x.graph.nodes[0] };
        await x.app.loadGraphData(...x.args(target)); assert.equal(x.app.fullLoads, 1);
        context.activePopupContext = null;
    }
    {
        const x = setup(), target = clone(x.before); edit(target, 0, 'positive_json', selection(2));
        context.refreshNode = node => { node.size[1]++; };
        await x.app.loadGraphData(...x.args(target)); assert.equal(x.app.fullLoads, 1, 'postcheck repairs refresh side effects');
        assert.deepEqual(x.graph.serialize(), target);
        context.refreshNode = () => {};
    }
    for (const mutate of [
        t => { t.nodes[0].pos[0]++; }, t => { t.nodes[0].mode = 4; }, t => { t.links.push([1, 1, 0, 2, 0, 'SCENE_PROMPT']); },
        t => { t.nodes.push(clone(t.nodes[0])); }, t => { t.nodes.pop(); }, t => { t.nodes.reverse(); },
        t => { t.groups.push({ title: 'group' }); }, t => { t.extra.zoom = 1.5; },
        t => edit(t, 0, 'model_mode', 'Anima'),
        t => edit(t, 1, 'strength_model', 0.5), t => { t.nodes[1].size[1]++; },
        t => { t.nodes[0].widgets_values_named.positive_json = selection(5); },
        t => { t.nodes[0].widgets_values[2] = null; t.nodes[0].widgets_values_named.positive_json = null; },
        t => { t.definitions = { subgraphs: [{ id: 'nested' }] }; },
    ]) {
        const { app, graph, before, args } = setup(), target = clone(before);
        edit(target, 0, 'positive_json', selection(1.3)); mutate(target);
        await app.loadGraphData(...args(target)); assert.equal(app.fullLoads, 1, mutate.toString());
        assert.deepEqual(graph.serialize(), target);
    }
    for (const alter of [
        x => { x.workflow.changeTracker._restoringState = false; },
        x => { x.app.canvas.graph = {}; }, x => { x.app.graph = {}; },
        x => { x.graph.subgraphs.set('nested', {}); },
        x => { x.workflow.changeTracker.activeState.extra.changed = true; },
    ]) {
        const state = setup(), target = clone(state.before); edit(target, 0, 'positive_json', selection(2)); alter(state);
        await state.app.loadGraphData(...state.args(target)); assert.equal(state.app.fullLoads, 1);
    }
    for (const plain of [true, false]) {
        const x = setup(), target = clone(x.before); edit(target, 0, 'positive_json', selection(2));
        const args = x.args(target); if (plain) args[1] = true; else args[3] = {};
        await x.app.loadGraphData(...args); assert.equal(x.app.fullLoads, 1);
    }
    {
        const { app, graph, before, args } = setup(), target = clone(before);
        edit(target, 0, 'positive_json', selection(2)); edit(target, 1, 'negative_json', selection(3));
        const widget = graph.nodes[1].widgets.find(widget => widget.name === 'negative_json');
        Object.defineProperty(widget, 'value', { get: () => before.nodes[1].widgets_values_named.negative_json, set() { throw new Error('apply failed'); } });
        await app.loadGraphData(...args(target)); assert.equal(app.fullLoads, 1); assert.deepEqual(graph.serialize(), target);
    }
    console.log('weight draft commit counts and atomic native selection history fast path passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
