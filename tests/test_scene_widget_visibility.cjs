const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.SCENE_NATIVE_UI_SOURCE || path.join(__dirname, '../web/scene_prompt_ui.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`function ${name}(`), body = source.indexOf(') {', start) + 2;
    assert(start >= 0, name);
    let depth = 0;
    for (let i = body; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(name);
}
const context = vm.createContext({
    Object, Set, app: { graph: { _nodes: [] } }, NODE_NAMES: new Set(['SceneApplyLora']),
    nodeClassNames: node => [node.type], isSceneExpandNodeName: () => false,
    SCENE_APPLY_LORA_NODE_NAMES: new Set(['SceneApplyLora']),
    ...Object.fromEntries(['SCENE_PROMPT_TO_TEXT_NODE_NAMES', 'SCENE_PROMPT_DELETE_NODE_NAMES', 'SCENE_SAVE_IMAGE_NODE_NAMES', 'SCENE_EMPTY_LATENT_NODE_NAMES', 'SCENE_PROMPT_REVERSE_NODE_NAMES'].map(name => [name, new Set()])),
});
for (const name of ['hideWidget', 'showWidget', 'hideSceneUtilityWidgets', 'hideInternalDomWidgets']) vm.runInContext(extract(name), context);
function dom(display = 'inline-flex', priority = 'important', owned = false) {
    const classes = new Set(owned ? ['scene-prompt-owned-widget'] : []);
    return {
        style: { display, priority, getPropertyValue() { return this.display; }, getPropertyPriority() { return this.priority; },
            setProperty(_name, value, priority) { this.display = value; this.priority = priority || ''; }, removeProperty() { this.display = ''; this.priority = ''; } },
        classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value) },
    };
}
for (const nativeHidden of [false, true]) {
    const draw = () => 'native draw', computeSize = () => [400, 24];
    const publicWidgets = ['strength_model', 'strength_clip', 'model_mode', 'positive', 'negative'].map(name => ({ name, hidden: nativeHidden, type: 'number', draw, computeSize, options: { hidden: nativeHidden }, element: dom() }));
    const internal = { name: 'positive_json', type: 'customtext', draw, computeSize, options: {}, element: dom() };
    const node = { type: 'SceneApplyLora', widgets: [...publicWidgets, internal] };
    context.app.graph._nodes = [node];
    const before = publicWidgets.map(widget => ({ ...widget, options: { ...widget.options } }));
    context.hideSceneUtilityWidgets(node, node.type); context.hideInternalDomWidgets(); context.hideInternalDomWidgets();
    publicWidgets.forEach((widget, index) => {
        assert.equal(widget.hidden, before[index].hidden); assert.deepEqual(widget.options, before[index].options);
        assert.equal(widget.type, 'number'); assert.equal(widget.draw, draw); assert.equal(widget.computeSize, computeSize);
        assert.equal(widget.sceneHiddenState, undefined); assert.equal(widget.element.style.display, 'inline-flex');
    });
    const snapshot = internal.sceneHiddenState;
    assert(snapshot); assert.equal(internal.type, 'hidden'); assert.equal(internal.element.style.display, 'none');
    assert.deepEqual([...internal.computeSize()], [0, 0]); assert.equal(internal.sceneHiddenState, snapshot, 'rehide never snapshots hidden methods');
    context.showWidget(internal);
    assert.equal(internal.type, 'customtext'); assert.equal(internal.draw, draw); assert.equal(internal.computeSize, computeSize);
    assert.equal(Object.hasOwn(internal, 'hidden'), false); assert.equal(Object.hasOwn(internal.options, 'hidden'), false);
    assert.equal(internal.element.style.display, 'inline-flex'); assert.equal(internal.element.style.priority, 'important');
    assert.equal(internal.element.classList.contains('scene-prompt-owned-widget'), false); assert.equal(internal.sceneHiddenState, undefined);
}
for (const owned of [false, true]) {
    let hidden = true, optionsHidden = false;
    const widget = Object.assign(Object.create({ get hidden() { return hidden; }, set hidden(value) { hidden = value; } }), {
        type: 'converted-widget', draw: undefined, computeSize: undefined,
        options: Object.create({ get hidden() { return optionsHidden; }, set hidden(value) { optionsHidden = value; } }),
        element: dom('', '', owned),
    });
    context.hideWidget(widget); context.hideWidget(widget);
    context.showWidget(widget);
    assert.equal(hidden, true); assert.equal(optionsHidden, false);
    assert.equal(Object.hasOwn(widget, 'hidden'), false); assert.equal(Object.hasOwn(widget.options, 'hidden'), false);
    assert.equal(widget.type, 'converted-widget'); assert.equal(widget.draw, undefined); assert.equal(widget.computeSize, undefined);
    assert.equal(widget.element.style.display, ''); assert.equal(widget.element.classList.contains('scene-prompt-owned-widget'), owned);
}
{
    const widget = { type: 'customtext', options: {}, draw() {}, computeSize() { return [100, 80]; } };
    const draw = widget.draw, compute = widget.computeSize;
    context.hideWidget(widget);
    const snapshot = widget.sceneHiddenState;
    widget.inputEl = dom('grid', 'important', true);
    context.hideWidget(widget);
    assert.equal(widget.sceneHiddenState, snapshot);
    assert.equal(snapshot.container, widget.inputEl);
    assert.equal(widget.inputEl.style.display, 'none');
    const replacement = dom('flex', '', false);
    widget.inputEl = replacement;
    context.hideWidget(widget);
    assert.equal(snapshot.container, replacement, 'replaced DOM is not retained by the state');
    context.showWidget(widget);
    assert.equal(replacement.style.display, 'flex'); assert.equal(replacement.style.priority, '');
    assert.equal(replacement.classList.contains('scene-prompt-owned-widget'), false);
    assert.equal(widget.draw, draw); assert.equal(widget.computeSize, compute);
}
const native = { name: 'strength_model', hidden: true, type: 'hidden', options: { hidden: true }, draw: () => {}, computeSize: () => [20, 24] };
const original = { ...native };
context.showWidget(native);
context.app.graph._nodes = [{ type: 'SceneApplyLora', widgets: [native] }];
context.hideSceneUtilityWidgets(context.app.graph._nodes[0], 'SceneApplyLora');
context.hideInternalDomWidgets();
assert.deepEqual(native, original, 'show without Scene ownership is a complete no-op');
console.log('Scene hidden ownership preserves native public widgets and restores exact original hidden state, methods and DOM styling');
