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
        const candidate=(id)=>({model_id:id,version_id:id+10,file_id:id+20,name:'LoRA '+id,version_name:'v'+id,base_model:'Illustrious',triggers:['tag'+id],size_kb:1200,image_url:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3C/svg%3E',model_url:'https://civitai.com/models/'+id,stats:{downloadCount:id},acquired:id===2,lora_name:'llm/'+id+'.safetensors'});
        window.calls=[];window.fail=false;
        const graph={getNodeById:()=>window.node,beforeChange(){window.transactions=(window.transactions||0)+1},afterChange(){}};
        window.node={id:1,graph,properties:{scene_civitai:{query:'hat',sort:'Most Downloaded',...candidate(2),managed_triggers:['tag2']}},widgets:Object.entries({model_mode:'Illustrious',positive:'manual, tag2',lora_name:'llm/2.safetensors'}).map(([name,value])=>({name,value}))};
        window.api={async fetchApi(path,options={}){window.calls.push({path,body:options.body&&JSON.parse(options.body)});let data;
        if(window.fail&&path.includes('search?'))return {ok:false,status:503,json:async()=>({error:'Network unavailable'})};
        if(path.includes('search?'))data={items:[candidate(1),candidate(2)]};
        else if(path.endsWith('/download'))data={candidate:candidate(1),lora_name:'llm/1.safetensors'};
        else if(path.endsWith('/test'))data={ok:true,models:[{id:'model-a'},{id:'model-b'}]};
        else data={base_url:'http://127.0.0.1:8080/v1',model:'model-a',api_key_set:true,civitai_api_key_set:true,response_format:'json_object',timeout_seconds:120,max_tokens:8192,reasoning_effort:'',civitai_host:'civitai.com'};
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
    assert.deepEqual(await modal.locator(".pc-civitai-card strong").allTextContents(), ["LoRA 1", "LoRA 2"], "selected item stays in server order");
    assert.equal(await modal.locator(".pc-lora-selected strong").textContent(), "LoRA 2");
    assert.equal(await modal.locator("img").first().getAttribute("loading"), "lazy");
    await page.waitForFunction(() => document.querySelector('.pc-civitai-card img')?.naturalWidth > 0);
    await modal.getByRole("button", { name: "詳細確認" }).first().click();
    const details = page.getByRole("dialog", { name: "LoRA 1", exact: true }); await details.waitFor();
    assert.match(await details.textContent(), /tag1/); await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" }); assert.equal(await modal.count(), 1, "Escape only closes top modal");
    await modal.getByRole("button", { name: "取得して選択", exact: true }).click();
    assert.equal(await modal.locator(".pc-lora-selected strong").textContent(), "LoRA 1");
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
    await settings.getByRole("button", { name: "接続テスト・モデル取得" }).click(); await settings.getByText("接続成功:", { exact: false }).waitFor();
    await settings.getByRole("button", { name: "保存", exact: true }).click(); await settings.getByText("保存しました", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.at(-1).body.api_key), "");
    await page.screenshot({ path: resolve(reviewDirectory, "llm-settings.png") });
    await page.keyboard.press("Escape");
    console.log("Actual Chromium Civitai search, download, error/retry, focus and masked settings tests passed.");
} finally { await browser.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
