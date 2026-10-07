import assert from "node:assert/strict";

export async function verifyPublicWidgetInputs(page) {
    const result = await page.evaluate(async () => {
        const app = window.app;
        const definitions = await (await fetch('/object_info')).json();
        app.graph.clear();
        const types = Object.keys(definitions).filter(type => definitions[type].category?.startsWith('Scene/'));
        const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const fields = [], missing = [], failedLinks = [];
        for (const type of types) {
            const node = add(type);
            const schema = { ...definitions[type].input.required, ...definitions[type].input.optional };
            for (const [name, spec] of Object.entries(schema)) {
                const widget = node.widgets?.find(item => item.name === name);
                if (!widget || widget.hidden || widget.options?.hidden || spec[1]?.hidden) continue;
                const kind = Array.isArray(spec[0]) ? 'COMBO' : spec[0];
                const providerType = { INT: 'PrimitiveInt', FLOAT: 'PrimitiveFloat', BOOLEAN: 'PrimitiveBoolean',
                    STRING: 'PrimitiveStringMultiline', COMBO: 'PrimitiveNode' }[kind];
                if (!providerType) continue;
                const slot = node.inputs.findIndex(input => input.name === name && input.widget?.name === name);
                if (slot < 0) { missing.push(`${type}.${name}`); continue; }
                const provider = add(providerType), expected = widget.value;
                if (kind !== 'COMBO') provider.widgets.find(item => item.name === 'value').value = expected;
                if (!provider.connect(0, node, slot)) { failedLinks.push(`${type}.${name}`); continue; }
                fields.push({ type, id: node.id, name, providerId: provider.id, kind, expected });
            }
        }
        const check = async () => {
            const prompt = await app.graphToPrompt(), errors = [];
            for (const field of fields) {
                const node = app.graph.getNodeById(field.id);
                const slot = node.inputs.findIndex(input => input.name === field.name);
                const input = node.inputs[slot], link = app.graph.links[input?.link];
                if (!link || input.widget?.name !== field.name || link.target_slot !== slot || link.target_id !== node.id)
                    errors.push(`${field.type}.${field.name}: lost link/widget/slot`);
                const value = prompt.output[String(field.id)]?.inputs[field.name];
                if (field.kind === 'COMBO' ? value !== field.expected
                    : !Array.isArray(value) || String(value[0]) !== String(field.providerId) || value[1] !== 0)
                    errors.push(`${field.type}.${field.name}: wrong API value ${JSON.stringify(value)}`);
            }
            return errors;
        };
        const before = await check();
        await app.loadGraphData(app.graph.serialize(), true, true);
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        const reloaded = await check();
        app.graph.clear();
        return { types: types.length, fields: fields.length, missing, failedLinks, before, reloaded };
    });
    assert.deepEqual(result.missing, [], `public input sockets missing: ${JSON.stringify(result)}`);
    assert.deepEqual(result.failedLinks, [], JSON.stringify(result));
    assert.deepEqual(result.before, [], JSON.stringify(result));
    assert.deepEqual(result.reloaded, [], JSON.stringify(result));
    assert.equal(result.types, 24);
    assert.equal(result.fields, 49, 'exercise all public scalar widgets, not only Queue');
    console.log(`real ComfyUI public widget inputs: ${result.fields} arguments / ${result.types} node classes retain links and API values after reload`);
}

export async function verifyLinkedInputSemantics(page) {
    const result = await page.evaluate(async () => {
        const app = window.app, { api } = await import('/scripts/api.js'); app.graph.clear();
        const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const field = (node, name) => node.widgets.find(widget => widget.name === name);
        const edit = (node, name, value) => { const widget = field(node, name); widget.value = value; widget.callback?.(value); };
        const link = (from, to, name, slot = 0) => {
            if (!from.connect(slot, to, to.inputs.findIndex(input => input.name === name))) throw new Error(`Cannot connect ${name}`);
        };
        const input = add('ScenePresetInput'), a = add('ScenePrompter'), b = add('ScenePrompter');
        const queue = add('ScenePrompterQueue'), count = add('ScenePromptCounter'), later = add('ScenePromptCounter');
        const expand = add('ScenePrompterExpand'), number = add('PrimitiveInt');
        edit(number, 'value', 3); edit(queue, 'alternate_block_size', 7); edit(queue, 'order_mode', 'alternate');
        edit(count, 'count', 3); edit(count, 'enable_downstream_count', false); edit(later, 'count', 10);
        link(input, a, 'scene_prompt'); link(input, b, 'scene_prompt'); link(a, queue, 'scene_prompt1'); link(b, queue, 'scene_prompt2');
        link(number, queue, 'alternate_block_size'); link(queue, count, 'scene_prompt'); link(count, later, 'scene_prompt'); link(later, expand, 'scene_prompt');
        const ids = Object.fromEntries(Object.entries({input,queue,count,later,expand,number}).map(([key,node]) => [key,node.id]));
        const current = key => app.graph.getNodeById(ids[key]);
        const snapshot = async () => {
            await new Promise(done => setTimeout(done, 220)); app.canvas.draw(true, true);
            const prompt = await app.graphToPrompt();
            const response = await api.fetchApi('/scene_prompt/runs/prepare', {method:'POST', body:JSON.stringify({
                api_graph:prompt, workflow:prompt.workflow, expand_node_id:String(ids.expand)})});
            const prepared = await response.json();
            if (!response.ok) throw new Error(JSON.stringify(prepared));
            await api.fetchApi('/scene_prompt/runs/release', {method:'POST', body:JSON.stringify({run_handle:prepared.run_handle})});
            return {preview:window.__sceneSeedRuntimeTest.countStats(current('later')).total,
                displayed:current('expand').widgets.find(w => w.sceneRole === 'expand_total_count')?.sceneTotalCount,
                actual:prepared.total_batches};
        };
        const multiply = await snapshot(); edit(number,'value',2); const changed = await snapshot();
        edit(number,'value',3); edit(queue,'downstream_count_mode','fixed'); const fixed = await snapshot();
        edit(queue,'downstream_count_mode','multiply');
        const reroute = add('Reroute'); link(number,reroute,reroute.inputs[0].name); link(reroute,queue,'alternate_block_size');
        const rerouted = await snapshot();
        await app.loadGraphData(app.graph.serialize(),true,true); const reloaded = await snapshot();
        const bundleTarget = add('ScenePresetReference'), boolTarget = add('ScenePromptCounter');
        link(current('input'),bundleTarget,'switches',11); link(current('input'),boolTarget,'enable_downstream_count',1);
        const switchIds = [bundleTarget.id,boolTarget.id];
        const layout = () => {
            const node = current('input'); app.canvas.draw(true,true);
            const positions = node.outputs.map((output,slot) => ({name:output.name,slot,pos:Array.from(node.getOutputPos(slot))}));
            const hits = positions.map(({slot,pos}) => node.getSlotInPosition(pos[0],pos[1])?.slot === slot);
            const widgets = node.widgets.filter(w => !w.hidden && w.type !== 'hidden' && w.last_y != null);
            return {order:positions.toSorted((a,b)=>a.pos[1]-b.pos[1]).map(p=>p.name), hits,
                right:positions.every(p=>Math.abs(p.pos[0]-(node.pos[0]+node.size[0]+1-window.LiteGraph.NODE_SLOT_HEIGHT/2))<0.1),
                below:widgets.every(w=>w.last_y > Math.max(...positions.map(p=>p.pos[1]-node.pos[1]))),
                slots:switchIds.map((id,i)=>app.graph.links[app.graph.getNodeById(id).inputs.find(v=>v.name===(i?'enable_downstream_count':'switches')).link].origin_slot)};
        };
        const initialLayout = layout();
        current('input').setSize([500,current('input').size[1]]); const resizedLayout = layout();
        await app.loadGraphData(app.graph.serialize(),true,true); const reloadedLayout = layout();
        app.graph.remove(app.graph.getNodeById(switchIds[0])); app.graph.remove(app.graph.getNodeById(switchIds[1]));
        const output = add('ScenePresetOutput'), id = add('PrimitiveString'), title = add('PrimitiveString');
        edit(output,'preset_id','stale_id'); edit(output,'preset_name','stale title');
        edit(id,'value','linked_native'); edit(title,'value','Linked native title');
        link(current('later'),output,'scene_prompt'); link(id,output,'preset_id'); link(title,output,'preset_name');
        const saveResponse = new Promise(resolve => {
            const fetchApi = api.fetchApi;
            api.fetchApi = async function (url,options) {
                const response = await fetchApi.call(this,url,options);
                if (url === '/scene_presets/save') { api.fetchApi = fetchApi; resolve({status:response.status,payload:JSON.parse(options.body),body:await response.clone().json()}); }
                return response;
            };
        });
        await output.widgets.find(w => w.sceneRole === 'scene_preset_save').callback();
        const saved = await saveResponse;
        const response = await api.fetchApi('/scene_presets/load?preset_id=linked_native');
        const stored = await response.json();
        app.graph.clear();
        const llm = add('ScenePromptLLM'), description = add('PrimitiveStringMultiline'), llmExpand = add('ScenePrompterExpand');
        edit(llm,'description','stale fallback'); edit(description,'value','');
        link(description,llm,'description'); link(llm,llmExpand,'scene_prompt');
        const llmButtons = async () => {
            await new Promise(done=>setTimeout(done,220)); app.canvas.draw(true,true);
            return [llm.widgets.find(w=>w.sceneRole==='llm_generate').disabled,
                llmExpand.widgets.find(w=>w.sceneRole==='expand_llm_generate').disabled];
        };
        const llmEmpty = await llmButtons(); edit(description,'value','connected scene'); const llmReady = await llmButtons();
        edit(description,'value',''); const llmCleared = await llmButtons();
        app.graph.clear();
        return {multiply,changed,fixed,rerouted,reloaded,initialLayout,resizedLayout,reloadedLayout,
            llmEmpty,llmReady,llmCleared,
            save:{status:saved.status,id:saved.payload.preset_id,name:saved.payload.name,body:saved.body,storedStatus:response.status,stored}};
    });
    for (const [key,total] of [['multiply',18],['changed',12],['fixed',6],['rerouted',18],['reloaded',18]])
        assert.deepEqual(result[key], {preview:total,displayed:total,actual:total}, `${key}: ${JSON.stringify(result[key])}`);
    for (const key of ['initialLayout','resizedLayout','reloadedLayout']) {
        const layout = result[key];
        assert.deepEqual(layout.order,['scene_prompt','switches',...Array.from({length:10},(_,i)=>`switch_${i+1}`)],key);
        assert(layout.hits.every(Boolean), `${key} hit tests`); assert(layout.right, `${key} right alignment`);
        assert(layout.below, `${key} widgets below output sockets`); assert.deepEqual(layout.slots,[11,1],key);
    }
    assert.equal(result.save.status,200,JSON.stringify(result.save));
    assert.equal(result.save.id,'linked_native'); assert.equal(result.save.name,'Linked native title');
    assert.equal(result.save.storedStatus,200,JSON.stringify(result.save));
    assert.deepEqual(result.llmEmpty,[true,true]); assert.deepEqual(result.llmReady,[false,false]);
    assert.deepEqual(result.llmCleared,[true,true]);
    console.log('real ComfyUI linked Queue counts, fixed/multiply, Reroute/reload, Preset output name save and switch layout/resize/hit-test compatibility passed');
}
