import assert from "node:assert/strict";
import { resolve } from "node:path";

export async function verifyMakeSwitch(page, screenshotDirectory) {
    const ids = await page.evaluate(async () => {
        const app=window.app; app.graph.clear();
        const add=type=>{const n=window.LiteGraph.createNode(type);app.graph.add(n);return n;};
        const field=(n,name)=>n.widgets.find(w=>w.name===name);
        const link=(a,b,name,slot=0)=>{if(!a.connect(slot,b,b.inputs.findIndex(i=>i.name===name)))throw new Error(`Cannot connect ${name}`);};
        const input=add('ScenePresetInput'), a=add('ScenePrompter'), b=add('ScenePrompter');
        const off=add('ScenePromptCounter'), on=add('ScenePromptCounter'), gate=add('ComfySwitchNode'), output=add('ScenePresetOutput');
        field(off,'count').value=3; field(on,'count').value=7;
        link(input,a,'scene_prompt');link(input,b,'scene_prompt');link(a,off,'scene_prompt');link(b,on,'scene_prompt');
        link(off,gate,'on_false');link(on,gate,'on_true');link(input,gate,'switch',1);link(gate,output,'scene_prompt');
        const response=await fetch('/scene_presets/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            preset_id:'native-maker-child',name:'Make Switch child',output_node_id:String(output.id),api_graph:await app.graphToPrompt(),workflow:app.graph.serialize()})});
        if(!response.ok)throw new Error(await response.text());
        app.graph.clear();
        const maker=add('ScenePromptMakeSwitch'), reroute=add('Reroute'), ref=add('ScenePresetReference'), expand=add('ScenePrompterExpand');
        field(ref,'preset_id').value='native-maker-child';field(ref,'preset_id').callback?.('native-maker-child');
        field(ref,'switch_settings_json').value=JSON.stringify([3,...Array(9).fill(false)]);
        link(maker,reroute,reroute.inputs[0].name);link(reroute,ref,'switches');link(ref,expand,'scene_prompt');
        const ids=Object.fromEntries(Object.entries({maker,ref,expand}).map(([key,n])=>[key,n.id]));
        await app.loadGraphData(app.graph.serialize(),true,true);
        await window.__sceneSeedRuntimeTest.refreshPresetReference(app.graph.getNodeById(ids.ref));
        window.__sceneSeedRuntimeTest.tracker().captureCanvasState();
        return ids;
    });
    await page.waitForFunction(id=>window.__sceneSeedRuntimeTest.countStats(window.app.graph.getNodeById(id)).total===3,ids.ref);
    const snapshot=()=>page.evaluate(async ids=>{
        const app=window.app,{api}=await import('/scripts/api.js'),maker=app.graph.getNodeById(ids.maker),ref=app.graph.getNodeById(ids.ref);
        await new Promise(done=>setTimeout(done,250));app.canvas.draw(true,true);
        const prompt=await app.graphToPrompt();
        const response=await api.fetchApi('/scene_prompt/runs/prepare',{method:'POST',body:JSON.stringify({api_graph:prompt,workflow:prompt.workflow,expand_node_id:String(ids.expand)})});
        const prepared=await response.json();if(!response.ok)throw new Error(JSON.stringify(prepared));
        await api.fetchApi('/scene_prompt/runs/release',{method:'POST',body:JSON.stringify({run_handle:prepared.run_handle})});
        return {names:maker.widgets.find(w=>w.name==='switch_names_json').value,values:maker.widgets.find(w=>w.name==='switch_values_json').value,
            inputs:maker.inputs.length,outputs:maker.outputs.map(o=>({name:o.name,type:o.type,label:o.label})),
            buttons:maker.widgets.filter(w=>w.sceneRole).map(w=>w.sceneRole),
            history:window.__sceneSeedRuntimeTest.tracker().undoQueue.length,
            total:window.__sceneSeedRuntimeTest.countStats(ref).total,actual:prepared.total_batches,
            displayed:app.graph.getNodeById(ids.expand).widgets.find(w=>w.sceneRole==='expand_total_count').sceneTotalCount};
    },ids);
    const open=()=>page.evaluate(id=>window.app.graph.getNodeById(id).widgets.find(w=>w.sceneRole==='make_switch_settings').callback(),ids.maker);
    const modal=page.locator('[data-scene-preset-switch-modal="make"]');
    const toggle=modal.getByRole('switch',{name:'スイッチ3',exact:true});
    const checkToggle=async enabled=>{
        assert.equal(await toggle.getAttribute('aria-checked'),String(enabled));
        assert.equal(await toggle.textContent(),enabled?'ON':'OFF');
        assert.deepEqual(await toggle.evaluate(el=>({border:getComputedStyle(el).borderWidth,background:getComputedStyle(el).backgroundColor})),
            {border:'0px',background:'rgba(0, 0, 0, 0)'},'ON/OFF area has no enclosing frame or fill');
    };
    const before=await snapshot();
    assert.equal(before.inputs,0);assert.deepEqual(before.outputs,[{name:'switches',type:'SCENE_SWITCHES',label:'スイッチ一式'}]);
    assert.deepEqual(before.buttons,['make_switch_settings']);
    assert.equal(before.total,3);assert.equal(before.actual,3);assert.equal(before.displayed,3);
    await open();assert.equal(await modal.locator('[data-scene-switch-name]').count(),10);
    assert.equal(await modal.getByRole('switch').count(),10);
    assert.equal(await modal.locator('input[type="checkbox"]').count(),0);
    await checkToggle(false);
    assert.equal(await modal.getByRole('button',{name:'保存',exact:true}).count(),0);
    await modal.getByRole('button',{name:'閉じる',exact:true}).click();
    assert.equal((await snapshot()).history,before.history,'unchanged defaults do not add an Undo entry');
    await open();await modal.locator('[data-scene-switch-name="3"]').fill('背景セット');
    const renamed=await snapshot();
    assert.equal(JSON.parse(renamed.names)[2],'背景セット','name persists before closing');
    assert.equal(renamed.values,before.values,'editing a name leaves the Boolean JSON unchanged');
    await toggle.click();
    await checkToggle(true);
    const changed=await snapshot();
    assert.equal(changed.total,7);assert.equal(changed.actual,7);assert.equal(changed.displayed,7);
    assert.equal(changed.history,before.history+2,'name and ON/OFF each commit immediately');
    await modal.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());
    const undone=await snapshot();assert.equal(undone.names,renamed.names);assert.equal(undone.values,before.values);assert.equal(undone.total,3);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().undo());
    assert.equal((await snapshot()).names,before.names);
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());
    await page.evaluate(()=>window.__sceneSeedRuntimeTest.tracker().redo());
    const redone=await snapshot();assert.equal(redone.names,changed.names);assert.equal(redone.values,changed.values);assert.equal(redone.total,7);
    await page.evaluate(id=>window.app.graph.getNodeById(id).widgets.find(w=>w.sceneRole==='preset_switch_settings').callback(),ids.ref);
    const mapping=page.locator('[data-scene-preset-switch-modal="settings"]');
    assert.match(await mapping.locator('[data-scene-switch-index="1"] option[value="3"]').textContent(),/背景セット/,'source names pass through native Reroute');
    await mapping.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.evaluate(async()=>{const app=window.app;await app.loadGraphData(app.graph.serialize(),true,true);});
    const loaded=await snapshot();assert.equal(loaded.names,changed.names);assert.equal(loaded.values,changed.values);assert.equal(loaded.total,7);assert.equal(loaded.actual,7);
    await open();assert.equal(await modal.locator('[data-scene-switch-name="3"]').inputValue(),'背景セット');
    await checkToggle(true);
    let keyboardHistory=(await snapshot()).history;
    for(const [key,enabled,total] of [['Space',false,3],['Enter',true,7]]){
        await toggle.press(key);await checkToggle(enabled);
        const current=await snapshot();
        assert.equal(current.history,++keyboardHistory,'each keyboard activation creates one history entry');
        assert.equal(current.total,total);assert.equal(current.actual,total);assert.equal(current.displayed,total);
        assert.equal(await toggle.locator('.pc-switch-track').evaluate(el=>getComputedStyle(el).outlineStyle),'solid','keyboard focus remains visible on the track');
    }
    await toggle.evaluate(el=>el.blur());
    if(screenshotDirectory)await modal.screenshot({path:resolve(screenshotDirectory,'native-make-switch-toggle.png')});
    await modal.evaluate(el=>{el.style.width='420px';});
    const layout=await modal.evaluate(el=>({overflow:el.scrollWidth>el.clientWidth,
        rows:[...el.querySelectorAll('.pc-switch-row')].map(row=>({overflow:row.scrollWidth>row.clientWidth,
            nameWidth:row.querySelector('input').getBoundingClientRect().width}))}));
    assert.equal(layout.overflow,false);
    assert(layout.rows.every(row=>!row.overflow && row.nameWidth>=140),'narrow rows retain a usable name field without horizontal overflow');
    if(screenshotDirectory)await modal.screenshot({path:resolve(screenshotDirectory,'native-make-switch-toggle-narrow.png')});
    await modal.locator('[data-scene-switch-name="3"]').fill('閉じても保持');
    await modal.getByRole('button',{name:'閉じる',exact:true}).click();
    assert.equal(JSON.parse((await snapshot()).names)[2],'閉じても保持');
    await page.evaluate(()=>window.app.graph.clear());
    console.log('real ComfyUI Make Switch single bundle, accessible mouse/keyboard toggles, narrow layout, native Undo/Redo, Reroute labels, live count3/7, backend prepare and reload passed');
}

export async function verifyPublicWidgetInputs(page) {
    const result = await page.evaluate(async () => {
        const app = window.app;
        const definitions = await (await fetch('/object_info')).json();
        app.graph.clear();
        const types = Object.keys(definitions).filter(type => definitions[type].category?.startsWith('Scene/'));
        const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
        const legacyFields = {ScenePrompter:['positive_base','negative_base','filename_enabled'],
            ScenePath:['path_mode'], ScenePrompterQueue:['order_mode','alternate_block_size','downstream_count_mode']};
        for (const type of Object.keys(legacyFields)) add(type);
        const legacy = app.graph.serialize();
        for (const node of legacy.nodes) node.inputs = node.inputs.filter(input=>!legacyFields[node.type]?.includes(input.name));
        await app.loadGraphData(legacy,true,true);
        const legacyMissing = app.graph._nodes.flatMap(node=>(legacyFields[node.type] || [])
            .filter(name=>!node.inputs.some(input=>input.name===name && input.widget?.name===name)).map(name=>`${node.type}.${name}`));
        app.graph.clear();
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
        return { types: types.length, fields: fields.length, legacyMissing, missing, failedLinks, before, reloaded };
    });
    assert.deepEqual(result.missing, [], `public input sockets missing: ${JSON.stringify(result)}`);
    assert.deepEqual(result.legacyMissing, [], `old workflows restore widget inputs: ${JSON.stringify(result)}`);
    assert.deepEqual(result.failedLinks, [], JSON.stringify(result));
    assert.deepEqual(result.before, [], JSON.stringify(result));
    assert.deepEqual(result.reloaded, [], JSON.stringify(result));
    assert.equal(result.types, 25);
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
        const path = add('ScenePath'), order = add('PrimitiveNode'), mode = add('PrimitiveNode'), pathMode = add('PrimitiveNode');
        link(order,current('queue'),'order_mode'); link(mode,current('queue'),'downstream_count_mode'); link(pathMode,path,'path_mode');
        link(current('later'),path,'scene_prompt');
        edit(output,'preset_id','stale_id'); edit(output,'preset_name','stale title');
        edit(id,'value','linked_native'); edit(title,'value','Linked native title');
        link(path,output,'scene_prompt'); link(id,output,'preset_id'); link(title,output,'preset_name');
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
        if (response.ok) await app.loadGraphData(stored.workflow,true,true);
        const comboReload = [order.id,mode.id,pathMode.id].map(id => {
            const node = app.graph.getNodeById(id), edges = node?.outputs?.[0]?.links || [];
            return node?.type === 'PrimitiveNode' && edges.length === 1 && !!app.graph.links[edges[0]];
        });
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
            llmEmpty,llmReady,llmCleared,comboReload,
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
    assert.deepEqual(result.comboReload,[true,true,true], 'Queue and Path native COMBO providers survive Preset save/load');
    assert.deepEqual(result.llmEmpty,[true,true]); assert.deepEqual(result.llmReady,[false,false]);
    assert.deepEqual(result.llmCleared,[true,true]);
    console.log('real ComfyUI linked Queue counts, fixed/multiply, Reroute/reload, Preset output name save and switch layout/resize/hit-test compatibility passed');
}
