import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const server = http.createServer(async (request, response) => {
    if (request.url.startsWith("/web/")) {
        response.setHeader("Content-Type", "application/javascript"); response.end(await readFile(resolve(`.${request.url}`), "utf8"));
    } else {
        response.setHeader("Content-Type", "text/html"); response.end(`<body><button id="launch">Launch</button><script type="module">
        import {openCivitaiSearch,openLLMSettings} from '/web/scene_prompt_civitai.js';
        import {injectStyle} from '/web/scene_prompt_style.js';
        injectStyle();
        const candidate=(id)=>({model_id:id,version_id:id+10,file_id:id+20,name:'LoRA '+id,version_name:'v'+id,base_model:'Illustrious',triggers:['tag'+id],size_kb:1200,image_url:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="%23366387"/%3E%3Ccircle cx="10" cy="8" r="5" fill="%23b3d9c4"/%3E%3C/svg%3E',model_url:'https://civitai.red/models/'+id,stats:{downloadCount:id},acquired:id===2,lora_name:'llm/'+id+'.safetensors'});
        window.calls=[];window.fail=false;window.resultCount=12;window.rawResponse=null;window.bodyReads=0;window.savedSettings={base_url:'http://127.0.0.1/v1',port:8080,model:'model-a',api_key_set:true};
        const graph={getNodeById:()=>window.node,beforeChange(){window.transactions=(window.transactions||0)+1},afterChange(){}};
        window.node={id:1,graph,properties:{scene_civitai:{query:'hat',sort:'Most Downloaded',...candidate(2),managed_triggers:['tag2']}},widgets:Object.entries({model_mode:'Illustrious',positive:'manual, tag2',lora_name:'llm/2.safetensors'}).map(([name,value])=>({name,value}))};
        window.api={async fetchApi(path,options={}){window.calls.push({path,body:options.body&&JSON.parse(options.body)});let data;
        const submitted=options.body&&JSON.parse(options.body);
        if(window.deferSettings&&path.endsWith('/settings')&&submitted){window.deferSettings=false;await new Promise(done=>window.finishSettings=done);}
        const params=new URL(path,'http://local').searchParams;const searchHost=params.get('host')||'civitai.red';
        if(window.deferSettingsGet&&path.endsWith('/settings')&&!submitted){window.deferSettingsGet=false;await new Promise(done=>window.finishSettingsGet=done);}
        if(window.deferTest&&path.endsWith('/test')){window.deferTest=false;await new Promise(done=>window.finishTest=done);}
        const searchQuery=new URL(path,'http://local').searchParams.get('query');
        if(window.deferSearch&&path.includes('search?')){window.deferSearch=false;await new Promise(done=>window.finishSearch=done);}
        if(window.rawResponse&&path.includes('search?'))return {ok:window.rawResponse.status===200,status:window.rawResponse.status,text:async()=>{window.bodyReads++;return window.rawResponse.text;}};
        if(window.fail&&path.includes('search?'))return {ok:false,status:503,text:async()=>JSON.stringify({error:'Network unavailable'})};
        if(path.includes('search?'))data={items:Array.from({length:window.resultCount},(_,index)=>candidate(index+1)).map(item=>({...item,base_model:params.get('model_mode')||'Illustrious',description:'<img src=x onerror=window.injected=true> Model description',version_description:'Version notes',published_at:'2026-08-02',model_stats:{downloadCount:90},version_stats:{downloadCount:12},gallery:Array.from({length:item.model_id===2?0:item.model_id===3?1:5},(_,index)=>({url:item.image_url+'#'+index,width:600,height:800})),name:item.name+' '+searchHost+(window.queryLabels?' '+searchQuery:'')}))};
        else if(path.endsWith('/download')){if(window.failDownload){window.failDownload=false;return {ok:false,status:502,text:async()=>JSON.stringify({error:'Download unavailable'})};}if(window.deferDownload){window.deferDownload=false;await new Promise(done=>window.finishDownload=done);}data={candidate:candidate(submitted.model_id),lora_name:'llm/'+submitted.model_id+'.safetensors'};}
        else if(path.endsWith('/test'))data={ok:true,models:[{id:'model-a'},{id:'model-b'}]};
        else if(path==='/scene_prompt/llm/settings'){if(submitted){if(submitted.api_key)window.savedSettings.api_key_set=true;for(const field of ['base_url','model'])window.savedSettings[field]=submitted[field];window.savedSettings.port=submitted.port===''?null:Number(submitted.port);}data={...window.savedSettings,template_version:'scene-llm-v1'};}
        else throw new Error('Unexpected service route: '+path);
        return {ok:true,status:200,text:async()=>{window.bodyReads++;return JSON.stringify(data);}};}};
        window.search=()=>openCivitaiSearch({node:window.node,api:window.api});window.settings=()=>openLLMSettings(window.api);
        document.querySelector('#launch').onclick=window.search;window.ready=true;
        </script></body>`);
    }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
    assert.equal(await page.evaluate(() => window.calls.length), 0, "loading modules never calls inference/search");
    await page.getByRole("button", { name: "Launch" }).click();
    const modal = page.getByRole("dialog", { name: "Civitai Search" });
    await modal.locator(".pc-civitai-card").first().waitFor();
    assert.deepEqual(await modal.locator(".pc-civitai-card strong").allTextContents(), Array.from({length:12},(_,index)=>`LoRA ${index+1} civitai.red`), "selected item stays in server order");
    assert.equal(await modal.locator(".pc-lora-selected strong").textContent(), "LoRA 2 civitai.red");
    assert.equal(await modal.locator("img").first().getAttribute("loading"), "lazy");
    await page.waitForFunction(() => document.querySelector('.pc-civitai-card img')?.naturalWidth > 0);
    const reviewDirectory = resolve(tmpdir(), "scene-prompt-llm-review");
    await mkdir(reviewDirectory, { recursive: true });
    await page.setViewportSize({ width: 1600, height: 850 });
    const cards = modal.locator('.pc-civitai-card');
    assert.equal(await cards.count(), 12);
    const boxes = await cards.evaluateAll(nodes => nodes.map(node => { const box=node.getBoundingClientRect(); return {x:box.x,y:box.y}; }));
    assert(boxes.slice(0,10).every(box => box.y === boxes[0].y)); assert(boxes[10].y > boxes[0].y);
    assert.equal(await cards.locator('button,a').count(), 0, 'cards contain no nested actions');
    await page.screenshot({ path: resolve(reviewDirectory, "civitai-ten-columns.png") });
    await page.evaluate(() => { window.originalCard=document.querySelector('.pc-civitai-card'); window.originalGrid=document.querySelector('.pc-civitai-results'); window.searchCount=window.calls.length; });
    await cards.first().focus(); await page.keyboard.press('Enter');
    const detail = modal.locator('.pc-civitai-detail');
    assert.equal(await detail.locator('.pc-civitai-gallery img').count(), 2);
    assert.equal(await detail.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
    await detail.getByRole('button',{name:'Next',exact:true}).click();
    assert.equal(await detail.locator('.pc-civitai-pages span').textContent(),'3–4 / 5');
    await detail.getByRole('button',{name:'Next',exact:true}).click();
    assert.equal(await detail.locator('.pc-civitai-gallery img').count(),1);
    assert.equal(await detail.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
    await detail.getByRole('button',{name:'Previous',exact:true}).click();
    assert.match(await detail.textContent(), /Model description.*Version notes.*2026-08-02.*Model Stats.*90.*Version Stats.*12/s);
    assert.equal(await detail.locator('.pc-civitai-metadata img').count(),0); assert.equal(await page.evaluate(()=>window.injected),undefined);
    await page.screenshot({ path: resolve(reviewDirectory, "civitai-details.png") });
    await detail.getByRole('button',{name:'取得して選択',exact:true}).click();
    await page.waitForFunction(()=>window.node.widgets.find(widget=>widget.name==='positive').value==='manual, tag1');
    assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(window.node.properties)),/gallery|description|image_url|stats/);
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.querySelector('.pc-civitai-card')===window.originalCard && document.querySelector('.pc-civitai-results')===window.originalGrid),true);
    assert.equal(await cards.first().evaluate(node=>node===document.activeElement),true);
    assert.equal(await modal.locator('.pc-lora-selected strong').textContent(),'LoRA 1 civitai.red');
    for (const [index,count] of [[1,0],[2,1]]) {
        await cards.nth(index).focus(); await page.keyboard.press('Space');
        assert.equal(await detail.locator('.pc-civitai-gallery img').count(),count);
        assert.equal(await detail.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
        await detail.getByRole('button',{name:'戻る',exact:true}).click();
    }
    await page.setViewportSize({ width: 360, height: 740 });
    assert.equal(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    assert.equal(await modal.locator('.pc-civitai-results').evaluate(node=>node.scrollWidth>node.clientWidth),true);
    await modal.locator('.pc-civitai-results').evaluate(node=>{node.scrollLeft=420;node.scrollTop=80;});
    const scrolled=await modal.locator('.pc-civitai-results').evaluate(node=>[node.scrollLeft,node.scrollTop]);
    const callsBeforeBack=await page.evaluate(()=>window.calls.length);
    await cards.nth(4).evaluate(node=>node.click());
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    assert.deepEqual(await modal.locator('.pc-civitai-results').evaluate(node=>[node.scrollLeft,node.scrollTop]),scrolled);
    assert.equal(await page.evaluate(()=>window.calls.length),callsBeforeBack,'Back never requests search or details');
    assert.equal(await modal.locator('.pc-civitai-controls button').evaluate(node=>node.getBoundingClientRect().right<=innerWidth),true);
    await page.screenshot({ path: resolve(reviewDirectory, "civitai-narrow.png") });
    await page.setViewportSize({width:1100,height:850});
    await modal.getByRole('combobox',{name:'接続先',exact:true}).selectOption('civitai.com');
    await page.waitForFunction(()=>document.querySelector('.pc-civitai-card strong')?.textContent.includes('civitai.com'));
    await modal.getByRole('combobox',{name:'Base Model',exact:true}).selectOption('Anima');
    await page.waitForFunction(()=>document.querySelector('.pc-civitai-card')?.textContent.includes('Anima'));
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='model_mode').value),'Illustrious','searching never edits node');
    await cards.first().click();
    assert.match(await detail.getByRole('link',{name:'Civitaiで開く'}).getAttribute('href'),/^https:\/\/civitai.com\//);
    await page.evaluate(()=>{window.deferDownload=true;window.finishDownload=null;});
    await detail.getByRole('button',{name:/取得.*選択/}).click();
    await page.waitForFunction(()=>window.finishDownload);
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    await page.evaluate(()=>window.finishDownload()); await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='model_mode').value),'Illustrious','Back invalidates in-flight selection');
    await cards.first().click(); await detail.getByRole('button',{name:/取得.*選択/}).click();
    await page.waitForFunction(()=>window.node.widgets.find(widget=>widget.name==='model_mode').value==='Anima');
    assert.deepEqual(await page.evaluate(()=>[window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.host,window.node.properties.scene_civitai.host]),['civitai.com','civitai.com']);
    await page.evaluate(()=>window.failDownload=true);
    await detail.getByRole('button',{name:/取得.*選択/}).click();
    const downloadFailure=page.getByRole('dialog',{name:'取得に失敗しました'}); await downloadFailure.waitFor();
    assert.match(await downloadFailure.textContent(),/API \/scene_prompt\/civitai\/download.*HTTP 502.*Download unavailable/s);
    await downloadFailure.getByRole('button',{name:'再試行'}).click();
    await page.waitForFunction(()=>!document.querySelector('.pc-civitai-detail-actions button').disabled);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.model_mode),'Anima');

    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    await modal.getByRole('combobox',{name:'並び順'}).selectOption('Highest Rated');
    await page.waitForFunction(()=>window.calls.some(call=>call.path.includes('sort=Highest+Rated')));
    await modal.getByRole('searchbox',{name:'検索語'}).fill('different');
    await page.evaluate(()=>window.fail=true); await modal.getByRole('button',{name:'検索',exact:true}).click();
    const failure=page.getByRole('dialog',{name:'取得に失敗しました'}); await failure.waitFor();
    assert.match(await failure.textContent(),/different.*HTTP 503.*Network unavailable/s);
    assert.equal(await modal.locator('.pc-civitai-card').count(),12,'failed search preserves previous DOM');
    await page.keyboard.press('Escape');
    await cards.first().click(); assert.equal(await detail.isVisible(),true,'previous cards remain usable after a failed search');
    assert.match(await detail.getByRole('link',{name:'Civitaiで開く'}).getAttribute('href'),/^https:\/\/civitai.com\//);
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    await page.evaluate(()=>window.fail=false); await modal.getByRole('button',{name:'検索',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.pc-civitai-results').inert);
    for(const raw of [{status:200,text:''},{status:200,text:'{"items":['},{status:502,text:'<html>upstream error</html>'},{status:404,text:''}]) {
        await page.evaluate(raw=>window.rawResponse=raw,raw);
        await modal.getByRole('button',{name:'検索',exact:true}).click(); await failure.waitFor();
        assert.match(await failure.textContent(),new RegExp('API /scene_prompt/civitai/search.*HTTP '+raw.status));
        assert.doesNotMatch(await failure.textContent(),/SyntaxError|Unexpected end|upstream error/);
        if(raw.status===404) assert.match(await failure.textContent(),/再起動/);
        await page.evaluate(()=>window.rawResponse=null); await failure.getByRole('button',{name:'再試行'}).click();
        await page.waitForFunction(()=>!document.querySelector('.pc-civitai-results').inert);
    }
    await page.evaluate(()=>window.resultCount=2);
    await page.keyboard.press('Escape'); await modal.waitFor({state:'detached'});
    for(const action of ['close','delete']) {
        await page.evaluate(()=>{window.staleNode=window.node;window.beforeTransactions=window.transactions;window.search();});
        await modal.locator('.pc-civitai-card').first().waitFor(); await modal.locator('.pc-civitai-card').first().click();
        await page.evaluate(()=>{window.deferDownload=true;window.finishDownload=null;});
        await detail.getByRole('button',{name:/取得.*選択/}).click(); await page.waitForFunction(()=>window.finishDownload);
        assert.equal(await detail.getByRole('button',{name:/取得.*選択/}).isDisabled(),true);
        if(action==='close') await page.keyboard.press('Escape');
        else await page.evaluate(()=>window.node=null);
        await page.evaluate(()=>window.finishDownload()); await page.waitForTimeout(30);
        assert.equal(await page.evaluate(()=>window.transactions),await page.evaluate(()=>window.beforeTransactions),'dismissed/deleted action never applies');
        await page.evaluate(()=>window.node=window.staleNode);
        if(action==='delete') await page.keyboard.press('Escape');
    }

    assert.equal(await page.locator('#launch').evaluate(node=>node===document.activeElement),true);
    await page.evaluate(() => window.settings());
    const settings = page.getByRole("dialog", { name: "LLM接続設定" }); await settings.getByRole("button", { name: "保存", exact: true }).waitFor();
    assert.equal(await settings.getByRole("button", { name: /API Key.*削除/u }).count(), 0);
    assert.equal(await settings.locator('input[name="api_key"]').inputValue(), "");
    assert.deepEqual(await settings.locator('input').evaluateAll(inputs=>inputs.map(input=>input.name)), ['base_url','port','model','api_key']);
    assert.equal(await settings.locator('input[name="base_url"]').getAttribute('aria-required'), 'true');
    assert.equal(await settings.locator('input[name="base_url"]').evaluate(input=>input.required), true);
    assert.equal(await settings.locator('.pc-required-star').evaluate(star=>getComputedStyle(star).color), 'rgb(255, 91, 91)');
    assert(await settings.locator('form').evaluate(form=>parseFloat(getComputedStyle(form).paddingTop)) >= 20);
    assert.match(await settings.textContent(), /Codexのキーではありません/);
    await settings.locator('input[name="model"]').fill('');
    await settings.locator('input[name="port"]').fill('');
    await page.evaluate(()=>{window.deferTest=true;window.finishTest=null;});
    await settings.getByRole('button',{name:'接続テスト・モデル取得'}).click();
    await page.waitForFunction(()=>window.finishTest);
    assert.equal(await settings.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
    assert.equal(await settings.getByRole('button',{name:'接続テスト・モデル取得'}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.calls.at(-1).body.model),'');
    assert.equal(await page.evaluate(()=>window.calls.at(-1).body.port),'');
    await page.evaluate(()=>window.finishTest());
    await settings.getByText('接続成功:',{exact:false}).waitFor();

    await settings.getByRole("button", { name: "接続テスト・モデル取得" }).click(); await settings.getByText("接続成功:", { exact: false }).waitFor();
    await settings.getByRole("button", { name: "保存", exact: true }).click(); await settings.getByText("保存しました", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.at(-1).body.api_key), "");
    const key = settings.locator('input[name="api_key"]');
    await settings.getByRole("button", { name: "接続テスト・モデル取得" }).click();
    await page.waitForFunction(() => window.calls.filter(call=>call.path.endsWith('/test')).length===3);
    assert.equal(await settings.locator("datalist").count(), 1, "connection tests reuse one datalist");
    assert.equal(await key.getAttribute("placeholder"), "保存済み（空欄で保持）");
    assert.equal(await page.evaluate(() => window.savedSettings.api_key_set), true, "blank saves retain the saved key flag");
    await key.fill("replacement"); await settings.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name="api_key"]').value==='');
    assert.equal(await key.getAttribute("placeholder"), "保存済み（空欄で保持）");
    assert.equal(await page.evaluate(() => window.savedSettings.api_key_set), true);
    await key.fill("submitted"); await page.evaluate(() => window.deferSettings=true);
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => window.finishSettings);
    const submittedCount = await page.evaluate(() => window.calls.filter(call=>call.path.endsWith('/settings')&&call.body).length);
    await key.fill("newer draft");
    await settings.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(await page.evaluate(() => window.calls.filter(call=>call.path.endsWith('/settings')&&call.body).length), submittedCount, "overlapping submit is ignored");
    await page.evaluate(() => window.finishSettings());
    await page.waitForFunction(() => !document.querySelector('form button').disabled);
    assert.equal(await key.inputValue(), "newer draft", "delayed save preserves newer key draft");
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name="api_key"]').value === '');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.endsWith('/settings') && call.body).at(-1).body.api_key), "newer draft",
        "a newer key draft can be saved after the earlier request settles");
    await settings.locator('input[name="base_url"]').fill('http://127.0.0.1/proxy/v1');
    await settings.locator('input[name="port"]').fill('9417');
    await settings.locator('input[name="model"]').fill('saved-model');
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => window.savedSettings.base_url === 'http://127.0.0.1/proxy/v1' && window.savedSettings.port === 9417 && window.savedSettings.model === 'saved-model');
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.settings());
    await settings.getByRole("button", { name: "保存", exact: true }).waitFor();
    assert.deepEqual(await settings.locator('input').evaluateAll(inputs => inputs.map(input => input.value)),
        ['http://127.0.0.1/proxy/v1', '9417', 'saved-model', ''], "URL, nondefault port and model survive save and reopen");
    assert.equal(await key.getAttribute("placeholder"), "保存済み（空欄で保持）");
    assert(await page.evaluate(() => window.calls.filter(call => call.body && /\/(settings|test)$/u.test(call.path))
        .every(call => Object.keys(call.body).sort().join(',') === 'api_key,base_url,model,port')), "save and test send only the four declared fields");
    await page.screenshot({ path: resolve(reviewDirectory, "llm-settings.png") });
    await page.setViewportSize({width:360,height:740});
    assert.equal(await settings.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    assert.equal(await settings.locator('input[name="base_url"]').evaluate(input=>input.getBoundingClientRect().right<=window.innerWidth),true);
    await page.screenshot({path:resolve(reviewDirectory,'llm-settings-mobile.png')});
    await page.setViewportSize({width:1100,height:850});
    await page.keyboard.press("Escape");
    for(const [url,base,port] of [['http://localhost:80/v1','http://localhost/v1','80'], ['https://host:443/proxy/v1','https://host/proxy/v1','443'], ['http://[::1]:9090/v1','http://[::1]/v1','9090']]) {
        await page.evaluate(()=>{window.savedSettings.port=8080;void window.settings();});
        await settings.getByRole('button',{name:'保存',exact:true}).waitFor();
        await settings.locator('input[name="base_url"]').fill(url);
        await settings.locator('input[name="base_url"]').blur();
        assert.equal(await settings.locator('input[name="base_url"]').inputValue(),base);
        assert.equal(await settings.locator('input[name="port"]').inputValue(),port);
        await page.keyboard.press('Escape');
    }
    await page.evaluate(()=>{void window.settings();});
    await settings.getByRole('button',{name:'保存',exact:true}).waitFor();
    await settings.locator('input[name="port"]').fill('9443');
    await settings.locator('input[name="base_url"]').fill('https://[::1]:443/proxy/v1');
    await settings.locator('input[name="base_url"]').blur();
    assert.equal(await settings.locator('input[name="port"]').inputValue(),'9443');
    await settings.locator('input[name="port"]').fill('');
    await settings.getByRole('button',{name:'保存',exact:true}).click();
    await page.waitForFunction(() => window.savedSettings.port === null);
    await page.keyboard.press('Escape'); await page.evaluate(()=>{void window.settings();});
    await settings.getByRole('button',{name:'保存',exact:true}).waitFor();
    assert.equal(await settings.locator('input[name="port"]').inputValue(),'','a saved protocol-default port stays blank');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.settings(); });
    await settings.getByRole('button', { name: '保存', exact: true }).waitFor();
    await page.evaluate(() => { window.deferSettings = true; window.finishSettings = null; });
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => window.finishSettings);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.settings(); });
    await settings.getByRole('button', { name: '保存', exact: true }).waitFor();
    await key.fill('reopened draft');
    await page.evaluate(() => window.finishSettings());
    await page.waitForTimeout(30);
    assert.equal(await key.inputValue(), 'reopened draft', 'a dismissed save cannot clear input in a newer settings modal');
    assert.equal(await settings.getByText('保存しました', { exact: true }).count(), 0, 'a dismissed save cannot publish status into the new modal');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{window.deferSettingsGet=true;window.finishSettingsGet=null;window.pendingSettings=window.settings();});
    await page.waitForFunction(()=>window.finishSettingsGet); await page.keyboard.press('Escape');
    await page.evaluate(async()=>{window.finishSettingsGet();const modal=await window.pendingSettings;window.closedSettings=modal;});
    assert.equal(await page.evaluate(()=>window.closedSettings.dialog.querySelectorAll('input').length),0,'close during GET does not attach orphan controls');
    await page.evaluate(() => {window.deferSearch=true;window.finishSearch=null;window.search();});
    await page.waitForFunction(() => window.finishSearch);
    await page.evaluate(() => window.settings());
    await settings.getByRole("button", { name: "保存", exact: true }).waitFor();
    await settings.getByRole('button',{name:'保存',exact:true}).click(); await settings.getByText('保存しました',{exact:true}).waitFor();
    await page.keyboard.press('Escape'); await page.evaluate(()=>window.finishSearch());
    await modal.locator('.pc-civitai-card').first().waitFor();
    assert.equal(await modal.locator('.pc-civitai-card').count(),2,'LLM saves do not invalidate Civitai search');
    await page.evaluate(()=>{window.deferSearch=true;window.finishSearch=null;});
    await modal.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.finishSearch);
    assert.equal(await modal.getByRole('button', {name:'Civitai設定',exact:true}).count(), 0);
    assert.equal(await page.getByRole('dialog', {name:'Civitai設定',exact:true}).count(), 0);
    assert.equal(await page.evaluate(async () => 'openCivitaiSettings' in await import('/web/scene_prompt_civitai.js')), false);
    assert.equal(await page.evaluate(() => window.calls.some(call => call.path.includes('/civitai/settings'))), false);
    await page.keyboard.press("Escape"); await page.evaluate(() => window.finishSearch());
    await page.waitForTimeout(30);
    assert.equal(await page.getByRole('dialog').count(), 0, "late search remains owned by its dismissed modal");
    const beforeReopen = await page.evaluate(() => window.calls.filter(call=>call.path.includes('search?')).length);
    await page.evaluate(() => window.search()); await modal.locator('.pc-civitai-card').first().waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call=>call.path.includes('search?')).length), beforeReopen+1, "old in-flight response cannot restore dismissed search state");
    assert.match(await modal.locator('.pc-civitai-card strong').first().textContent(), /civitai.com/);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        window.queryLabels=true; window.deferSearch=true; window.finishSearch=null;
        window.node.properties.scene_civitai.query='older-query'; window.pendingModal=window.search();
    });
    await page.waitForFunction(() => window.finishSearch);
    await modal.getByRole("searchbox", { name: "検索語" }).fill("newer-query");
    await modal.getByRole("button", { name: "検索", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pc-civitai-card strong')?.textContent.includes('newer-query'));
    await page.evaluate(() => window.finishSearch()); await page.waitForTimeout(30);
    assert((await modal.locator('.pc-civitai-card strong').allTextContents()).every((title)=>title.includes('newer-query')),
        "superseded search cannot replace the modal's current result");
    await page.evaluate(() => window.pendingModal.dismiss());
    assert.equal(await page.evaluate(() => window.pendingModal.dialog.querySelector('.pc-civitai-results').childElementCount), 0,
        "dismissal releases result DOM even when a caller still holds the modal facade");
    await page.evaluate(() => {
        window.deferSearch=true; window.finishSearch=null; window.node.properties.scene_civitai.query='closed-query'; window.closedModal=window.search();
    });
    await page.waitForFunction(() => window.finishSearch);
    await page.evaluate(() => { window.closedModal.dismiss(); window.finishSearch(); });
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => window.closedModal.dialog.querySelector('.pc-civitai-results').childElementCount), 0,
        "late search cannot repopulate a dismissed modal");
    const closedSearches = await page.evaluate(() => window.calls.filter(call=>call.path.includes('query=closed-query')).length);
    await page.evaluate(() => window.search()); await modal.locator('.pc-civitai-card').first().waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call=>call.path.includes('query=closed-query')).length), closedSearches+1,
        "a new modal fetches its own current result rather than closed result history");
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
        window.ownedModals=[];
        for(let index=0;index<24;index++) {
            window.node.properties.scene_civitai.query='current-modal-'+index;
            const current=window.search(); window.ownedModals.push(current);
            while(!current.dialog.querySelector('.pc-civitai-card')) await new Promise(done=>setTimeout(done,0));
        }
    });
    assert.equal(await page.evaluate(() => window.ownedModals.filter(current=>current.dialog.querySelectorAll('.pc-civitai-card').length===2).length), 24,
        "concurrent open modals retain all current results without a capacity cap");
    assert.match(await page.evaluate(() => window.ownedModals[0].dialog.querySelector('.pc-civitai-card strong').textContent), /current-modal-0$/);
    await page.evaluate(() => [...window.ownedModals].reverse().forEach(current=>current.dismiss()));
    assert.equal(await page.evaluate(() => window.ownedModals.reduce((sum,current)=>sum+current.dialog.querySelector('.pc-civitai-results').childElementCount,0)), 0,
        "ending each owner releases all modal results");
    console.log("Actual Chromium Civitai search, download, error/retry, focus and masked settings tests passed.");
} finally { await browser.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
