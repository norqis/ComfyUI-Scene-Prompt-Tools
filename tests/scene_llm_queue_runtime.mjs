import assert from 'node:assert/strict';

// Runs against the actual ComfyUI widgets and controller. The caller's isolated
// local LLM provider handles inference; no production models are involved.
export async function verifyNativeLLMQueue(page) {
    let finish;
    let requests = 0;
    const gate = new Promise(done => { finish = done; });
    const holdFirst = async route => {
        requests++;
        if (requests === 1) await gate;
        await route.continue();
    };
    await page.route('**/scene_prompt/llm/generate', holdFirst);
    try {
        const queued = await page.evaluate(() => {
            const app = window.app; app.graph.clear();
            const add = type => { const node = window.LiteGraph.createNode(type); app.graph.add(node); return node; };
            const field = (node, name) => node.widgets.find(widget => widget.name === name);
            const button = node => node.widgets.find(widget => ['llm_generate', 'expand_llm_generate'].includes(widget.sceneRole));
            const a = add('ScenePromptLLM'), b = add('ScenePromptLLM'), c = add('ScenePromptLLM'), expand = add('ScenePrompterExpand');
            [a,b,c].forEach((node,index) => { field(node,'description').value = `Independent block ${index}`; });
            b.connect(0,c,c.inputs.findIndex(input=>input.name==='scene_prompt'));
            c.connect(0,expand,expand.inputs.findIndex(input=>input.name==='scene_prompt'));
            const idleTexts=[];
            a.widgets.find(widget=>widget.sceneRole==='llm_status').draw({fillText:text=>idleTexts.push(text)},a,300,0);
            const promises=[button(a).callback(),button(b).callback(),button(expand).callback()];
            window.__llmQueueProbe={nodes:[a,b,c,expand],promises};
            return {idleTexts,first:button(a).name,second:button(b).name,expand:button(expand).name,
                waiting:b.sceneLLMStatus,disabled:[a,b,expand].map(node=>button(node).disabled)};
        });
        assert.deepEqual(queued,{idleTexts:[''],first:'プロンプト生成中…',second:'待機中',expand:'待機中',waiting:'待機中',disabled:[true,true,true]});
        await page.waitForFunction(() => window.__llmQueueProbe.nodes[0].sceneLLMStatus === '生成中…');
        finish();
        const completed = await page.evaluate(async () => {
            const {nodes,promises}=window.__llmQueueProbe;
            await Promise.all(promises);
            const result=nodes.map(node=>({positive:node.widgets.find(widget=>widget.name==='positive')?.value,
                status:node.sceneLLMStatus,button:node.widgets.find(widget=>['llm_generate','expand_llm_generate'].includes(widget.sceneRole))?.name}));
            delete window.__llmQueueProbe;
            return result;
        });
        assert.equal(requests,3,'Expand reuses its completed shared node and sends only the remaining node');
        assert.deepEqual(completed.slice(0,3).map(node=>node.positive),Array(3).fill('fixture prompt'));
        assert(completed.every(node=>node.button==='プロンプト生成'));
        assert(completed.every(node=>['完了','生成済み'].includes(node.status)));
    } finally { finish(); await page.unroute('**/scene_prompt/llm/generate',holdFirst); }
    console.log('real ComfyUI LLM FIFO: queued node/Expand labels, empty idle status, shared-node reuse and individual requests passed');
}

export async function verifyNativeContinuousRelease(page, provider) {
    const before = provider.events().length;
    provider.load();
    let submitted = 0;
    const reloadExternally = async route => {
        if (++submitted === 2) provider.load();
        await route.fallback();
    };
    await page.route('**/prompt', reloadExternally);
    try {
        await page.evaluate(async () => {
            const {api}=await import('/scripts/api.js');
            const app=window.app; app.graph.clear();
            const add=type=>{const node=window.LiteGraph.createNode(type);app.graph.add(node);return node;};
            const set=(node,name,value)=>{node.widgets.find(widget=>widget.name===name).value=value;};
            const link=(source,slot,target,name)=>source.connect(slot,target,target.inputs.findIndex(input=>input.name===name));
            const count=add('ScenePromptCounter'),expand=add('ScenePrompterExpand'),image=add('EmptyImage'),save=add('SceneSaveImage');
            set(count,'count',3);set(image,'width',16);set(image,'height',16);set(expand,'timestamp_dir',false);
            link(count,0,expand,'scene_prompt');link(expand,2,save,'scene_info');link(image,0,save,'images');
            const state=window.__llmReleaseProbe={expand,results:[],errors:[]};
            const executed=({detail})=>{if(String(detail.node)===String(save.id))state.results.push(detail.prompt_id);};
            const failed=({detail})=>state.errors.push(detail);
            api.addEventListener('executed',executed);api.addEventListener('execution_error',failed);
            state.cleanup=()=>{api.removeEventListener('executed',executed);api.removeEventListener('execution_error',failed);};
            expand.widgets.find(widget=>widget.sceneRole==='expand_run_all').callback();
        });
        await page.waitForFunction(()=>{
            const state=window.__llmReleaseProbe;
            return state.errors.length || state.results.length===3 && !state.expand.widgets.find(widget=>widget.name==='run_id').value;
        },null,{timeout:30_000});
        const result=await page.evaluate(()=>({results:window.__llmReleaseProbe.results,errors:window.__llmReleaseProbe.errors}));
        assert.deepEqual(result.errors,[]);
        assert.equal(result.results.length,3);assert.equal(submitted,3);
        const events=provider.events().slice(before);
        assert.equal(events.filter(({path})=>path==='/v1/unload').length,2,'initial loaded model and external reload both release; already-unloaded third image sends no unload');
        assert.equal(provider.loaded(),false);
        for(const id of result.results){
            const history=await page.evaluate(async id=>{
                const {api}=await import('/scripts/api.js');return (await api.fetchApi(`/history/${id}`)).json();
            },id);
            assert.equal(history[id].status.status_str,'success');
            assert(!JSON.stringify(history).includes('scene_gpu_policy'));
        }
    } finally {
        await page.unroute('**/prompt',reloadExternally);
        await page.evaluate(()=>{window.__llmReleaseProbe?.cleanup();delete window.__llmReleaseProbe;});
    }
    console.log('real ComfyUI Expand continuous generation releases externally reloaded LLM and skips redundant unloads');
}
