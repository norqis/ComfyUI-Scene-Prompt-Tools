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
        const candidate=(id)=>({model_id:id,version_id:id+10,file_id:id+20,name:'LoRA '+id,version_name:'v'+id,base_model:'Illustrious',triggers:['tag'+id],size_kb:1200,image_url:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3C/svg%3E',model_url:'https://civitai.red/models/'+id,stats:{downloadCount:id},acquired:id===2,lora_name:'llm/'+id+'.safetensors'});
        window.calls=[];window.fail=false;window.savedSettings={base_url:'http://127.0.0.1/v1',port:8080,model:'model-a',api_key_set:true};
        const graph={getNodeById:()=>window.node,beforeChange(){window.transactions=(window.transactions||0)+1},afterChange(){}};
        window.node={id:1,graph,properties:{scene_civitai:{query:'hat',sort:'Most Downloaded',...candidate(2),managed_triggers:['tag2']}},widgets:Object.entries({model_mode:'Illustrious',positive:'manual, tag2',lora_name:'llm/2.safetensors'}).map(([name,value])=>({name,value}))};
        window.api={async fetchApi(path,options={}){window.calls.push({path,body:options.body&&JSON.parse(options.body)});let data;
        const submitted=options.body&&JSON.parse(options.body);
        if(window.deferSettings&&path.endsWith('/settings')&&submitted){window.deferSettings=false;await new Promise(done=>window.finishSettings=done);}
        const searchHost='civitai.red';
        if(window.deferSettingsGet&&path.endsWith('/settings')&&!submitted){window.deferSettingsGet=false;await new Promise(done=>window.finishSettingsGet=done);}
        if(window.deferTest&&path.endsWith('/test')){window.deferTest=false;await new Promise(done=>window.finishTest=done);}
        const searchQuery=new URL(path,'http://local').searchParams.get('query');
        if(window.deferSearch&&path.includes('search?')){window.deferSearch=false;await new Promise(done=>window.finishSearch=done);}
        if(window.fail&&path.includes('search?'))return {ok:false,status:503,json:async()=>({error:'Network unavailable'})};
        if(path.includes('search?'))data={items:[candidate(1),candidate(2)].map(item=>({...item,name:item.name+' '+searchHost+(window.queryLabels?' '+searchQuery:'')}))};
        else if(path.endsWith('/download'))data={candidate:candidate(1),lora_name:'llm/1.safetensors'};
        else if(path.endsWith('/test'))data={ok:true,models:[{id:'model-a'},{id:'model-b'}]};
        else if(path==='/scene_prompt/llm/settings'){if(submitted){if(submitted.clear_api_key)window.savedSettings.api_key_set=false;else if(submitted.api_key)window.savedSettings.api_key_set=true;for(const field of ['base_url','port','model'])window.savedSettings[field]=submitted[field];}data={...window.savedSettings,template_version:'scene-llm-v1'};}
        else throw new Error('Unexpected service route: '+path);
        return {ok:true,json:async()=>data};}};
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
    assert.deepEqual(await modal.locator(".pc-civitai-card strong").allTextContents(), ["LoRA 1 civitai.red", "LoRA 2 civitai.red"], "selected item stays in server order");
    assert.equal(await modal.locator(".pc-lora-selected strong").textContent(), "LoRA 2 civitai.red");
    assert.equal(await modal.locator("img").first().getAttribute("loading"), "lazy");
    await page.waitForFunction(() => document.querySelector('.pc-civitai-card img')?.naturalWidth > 0);
    await modal.getByRole("button", { name: "詳細確認" }).first().click();
    const details = page.getByRole("dialog", { name: "LoRA 1 civitai.red", exact: true }); await details.waitFor();
    assert.match(await details.textContent(), /tag1/); await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" }); assert.equal(await modal.count(), 1, "Escape only closes top modal");
    await modal.getByRole("button", { name: "取得して選択", exact: true }).click();
    assert.equal(await modal.locator(".pc-lora-selected strong").textContent(), "LoRA 1 civitai.red");
    assert.equal(await page.evaluate(() => window.node.widgets.find((widget) => widget.name === 'positive').value), "manual, tag1");
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.node.properties)), /image_url|stats/);
    await modal.getByRole("combobox", { name: "並び順" }).selectOption("Highest Rated");
    await page.waitForFunction(() => window.calls.some((call) => call.path.includes('sort=Highest+Rated')));
    await modal.getByRole("searchbox", { name: "検索語" }).fill("different");
    await page.evaluate(() => window.fail=true); await modal.getByRole("button", { name: "検索", exact: true }).click();
    const failure = page.getByRole("dialog", { name: "取得に失敗しました" }); await failure.waitFor();
    assert.match(await failure.textContent(), /different.*Network unavailable/s);
    await page.evaluate(() => window.fail=false); await failure.getByRole("button", { name: "再試行" }).click();
    await modal.locator(".pc-civitai-card").first().waitFor();
    const reviewDirectory = resolve(tmpdir(), "scene-prompt-llm-review");
    await mkdir(reviewDirectory, { recursive: true }); await page.screenshot({ path: resolve(reviewDirectory, "llm-civitai-search.png") });
    await page.setViewportSize({ width: 360, height: 740 });
    assert.equal(await modal.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "mobile dialog has no horizontal overflow");
    await page.screenshot({ path: resolve(reviewDirectory, "llm-civitai-mobile.png") });
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" }); assert.equal(await page.locator("#launch").evaluate((node)=>node===document.activeElement), true);
    await page.evaluate(() => window.settings());
    const settings = page.getByRole("dialog", { name: "LLM接続設定" }); await settings.getByRole("button", { name: "保存", exact: true }).waitFor();
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
    const key = settings.locator('input[name="api_key"]'), clearKey = settings.locator('button[aria-pressed]');
    await settings.getByRole("button", { name: "接続テスト・モデル取得" }).click();
    await page.waitForFunction(() => window.calls.filter(call=>call.path.endsWith('/test')).length===3);
    assert.equal(await settings.locator("datalist").count(), 1, "connection tests reuse one datalist");
    await clearKey.click(); assert.equal(await clearKey.textContent(),'API Key削除を取り消す'); await settings.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-pressed]').getAttribute('aria-pressed')==='false');
    assert.equal(await key.getAttribute("placeholder"), "未設定");
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
    await clearKey.click(); await page.evaluate(() => {window.deferSettings=true;window.finishSettings=null;});
    await settings.getByRole("button", { name: "保存", exact: true }).click(); await page.waitForFunction(()=>window.finishSettings);
    await clearKey.click(); await clearKey.click(); await page.evaluate(()=>window.finishSettings());
    await page.waitForFunction(() => !document.querySelector('form button').disabled);
    assert.equal(await clearKey.getAttribute('aria-pressed'), "true", "real clear-action edits during save remain a newer draft");
    await clearKey.click();
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
    await settings.getByText('保存しました',{exact:true}).waitFor();
    await page.keyboard.press('Escape'); await page.evaluate(()=>{void window.settings();});
    await settings.getByRole('button',{name:'保存',exact:true}).waitFor();
    assert.equal(await settings.locator('input[name="port"]').inputValue(),'','a saved protocol-default port stays blank');
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
    assert.match(await modal.locator('.pc-civitai-card strong').first().textContent(), /civitai.red/);
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
