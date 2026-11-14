import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const server = http.createServer(async (request, response) => {
    if (request.url.startsWith("/web/")) {
        response.setHeader("Content-Type", "application/javascript"); response.end(await readFile(resolve(`.${request.url}`), "utf8")); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<body><button id="launch">Open</button><script type="module">
        import {openCivitaiSearch,openCivitaiDetail,openCivitaiImage,openModal} from '/web/scene_prompt_civitai.js';
        import {injectStyle} from '/web/scene_prompt_style.js'; injectStyle();
        const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#36556c"/><circle cx="300" cy="350" r="180" fill="#abcde0"/></svg>');
        window.calls=[];window.downloads=0;window.authenticated=false;window.activeGallery=0;window.maxGallery=0;window.galleryDelay=true;window.galleryReleases=[];
        window.graph={getNodeById:()=>window.node,beforeChange(){window.transactions=(window.transactions||0)+1;},afterChange(){}};
        window.makeNode=()=>({id:1,graph:window.graph,properties:{},widgets:Object.entries({model_mode:'Illustrious',lora_name:'',positive:'manual'}).map(([name,value])=>({name,value}))});
        window.node=window.makeNode();
        const preview=id=>({id,url:image+'#'+id,width:600,height:800});
        const candidate=(id,query)=>({model_id:id,version_id:id===2?11:id+10,file_id:id+20,name:'Model '+id+' '+query+' long title for responsive layout',version_name:'v1',base_model:'Illustrious',model_type:'LORA',installable:true,apply_model_mode:'Illustrious',triggers:['trigger'],gallery:[],image_url:'',model_stats:id===2?{downloadCount:null,collectedCount:'invalid',thumbsUpCount:null}:{downloadCount:5200,collectedCount:1200,thumbsUpCount:0},updated_at:id===2?null:'2026-11-15T12:00:00Z'});
        window.api={async fetchApi(path,options={}){
            window.calls.push({path,body:options.body?JSON.parse(options.body):null});
            const url=new URL(path,'http://fixture'), body=options.body?JSON.parse(options.body):{}, reply=(data,status=200)=>({ok:status===200,status,text:async()=>JSON.stringify(data)});
            if(url.pathname.endsWith('/options'))return reply({model_types:['Checkpoint','TextualInversion','Hypernetwork','AestheticGradient','LORA','LoCon','DoRA','Controlnet','Upscaler','MotionModule','VAE','TextEncoder','UNet','CLIPVision','Poses','Wildcards','Workflows','ComfyWorkflows','Detection','VisionLanguage','CLIP','LLM','Other']});
            if(url.pathname.endsWith('/tags')){if(window.deferTags){window.deferTags=false;await new Promise(done=>window.releaseTags=done);}return reply({items:['Style','Action',url.searchParams.get('query')]});}
            if(url.pathname.endsWith('/search')){
                if(window.deferSearch){window.deferSearch=false;await new Promise(done=>window.releaseSearch=done);}
                return reply({items:Array.from({length:30},(_,index)=>({...candidate(index+1,url.searchParams.get('query')||''),installable:url.searchParams.get('model_type')==='LORA'}))});
            }
            if(url.pathname.endsWith('/gallery')){
                window.activeGallery++;window.maxGallery=Math.max(window.maxGallery,window.activeGallery);
                if(window.galleryDelay)await new Promise(done=>window.galleryReleases.push(done));
                window.activeGallery--;
                if(window.failGallery){window.failGallery=false;return reply({error:'gallery offline'},503);}
                return reply(url.searchParams.has('cursor')?{items:[preview(103),preview(104)],next_cursor:null}:{items:[preview(101),preview(102),preview(103)],next_cursor:'next'});
            }
            if(url.pathname.endsWith('/image')){
                if(window.deferImage){window.deferImage=false;await new Promise(done=>window.releaseImage=done);}
                return reply({image:preview(Number(url.searchParams.get('image_id'))),resources:[{name:'Resource <img src=x onerror=window.injected=true>',type:'LORA',strength:0.7,url:'https://civitai.red/models/1'}],prompt:'positive only <script>text<'+'/script>',negative_prompt:'negative separate',tags:null,other:{seed:5,workflow:{nodes:[{id:1}]}},partial:false});
            }
            if(url.pathname.endsWith('/details'))return reply({...candidate(1,''),gallery:[preview(101)],image_url:image});
            if(url.pathname.endsWith('/auth/clear')){window.authenticated=false;return reply({configured:false,username:''});}
            if(url.pathname.endsWith('/auth')){
                if(options.body){if(window.deferAuth){window.deferAuth=false;await new Promise(done=>window.releaseAuth=done);}window.authenticated=true;}
                return reply({configured:window.authenticated,username:window.authenticated?'fixture-user':''});
            }
            if(url.pathname.endsWith('/download')){
                window.downloads++;
                if(window.disabledDownload)return reply({error:'Creator disabled',code:'civitai_download_disabled'},401);
                if(!window.authenticated)return reply({error:'Authentication required',code:'civitai_auth_required'},401);
                return reply({candidate:candidate(body.model_id,''),lora_name:'llm/fixture.safetensors'});
            }
            throw new Error('Unexpected API '+path);
        }};
        window.open=()=>window.current=openCivitaiSearch({node:window.node,api:window.api,activeGraph:()=>window.graph});
        window.local=()=>window.localParent=openModal('LoRA 詳細確認');
        window.detail=()=>openCivitaiDetail({api:window.api,modelID:1,versionID:11});
        window.noID=()=>openCivitaiImage({api:window.api,preview:{url:image,meta:{prompt:'fallback positive',negativePrompt:'fallback negative',resources:[{name:'untrusted',url:'javascript:window.injected=true'},{model:{id:4,name:'safe resource'}}]}},index:9,host:'civitai.red'});
        document.querySelector('#launch').onclick=window.open;window.ready=true;
    </script></body>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true });
const screenshots = resolve(tmpdir(), "scene-civitai-details-review");
await mkdir(screenshots, { recursive: true });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const search = page.locator(".pc-civitai-search-dialog"), cards = search.locator(".pc-civitai-card");
    await cards.first().waitFor();
    await page.waitForFunction(() => window.activeGallery >= 1);
    assert((await page.evaluate(() => window.maxGallery)) <= 3);
    assert((await page.evaluate(() => window.calls.filter(call => call.path.includes('/gallery?')).length)) < 30);
    await page.evaluate(() => { window.galleryDelay=false; window.galleryReleases.splice(0).forEach(done=>done()); });
    await cards.first().locator("img").waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.path.includes('/gallery?') && new URL(call.path,'http://fixture').searchParams.get('version_id')==='11').length), 1);
    assert.deepEqual(await cards.first().locator(".pc-civitai-card-stats > span").evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Downloads: 5.2K','Bookmarks: 1.2K','Likes: 0']);
    assert.deepEqual(await cards.nth(1).locator(".pc-civitai-card-stats > span").evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Downloads: —','Bookmarks: —','Likes: —']);
    assert.match(await cards.first().locator(".pc-civitai-card-updated").textContent(), /2026\/11\/15/);
    assert.equal(await cards.nth(1).locator(".pc-civitai-card-updated").textContent(), 'Updated: —');
    const boxes = await cards.evaluateAll(nodes => nodes.slice(0,4).map(node => node.getBoundingClientRect().y));
    assert(boxes.slice(0,3).every(y => y === boxes[0])); assert(boxes[3] > boxes[0]);
    assert.deepEqual(await search.locator('.pc-civitai-controls select,.pc-civitai-controls [role=combobox]').evaluateAll(nodes => nodes.map(node=>node.getAttribute('aria-label'))), ['接続先','Base Model','Model Type','Category','並び順']);
    await page.screenshot({ path: resolve(screenshots, 'search-desktop.png') });
    const galleryBefore = await page.evaluate(() => window.calls.filter(call => call.path.includes('/gallery?')).length);
    await cards.first().click();
    assert.equal(await search.getAttribute('aria-label'), 'Civitai Detail');
    const detail = search.locator('.pc-civitai-detail');
    await detail.getByRole('button',{name:'Next',exact:true}).click();
    await detail.getByRole('button',{name:'Civitai Image #3',exact:true}).click();
    const image = page.getByRole('dialog',{name:'Civitai Image #3',exact:true});
    await image.getByText('positive only <script>text</script>',{exact:true}).waitFor();
    assert.deepEqual(await image.locator('h3').allTextContents(), ['RESOURCES USED','PROMPT','TAG','NEGATIVE PROMPT','OTHER METADATA']);
    assert.equal(await image.locator('script,img[onerror]').count(),0);
    assert.equal(await image.locator('details pre').textContent(),'');
    await image.locator('summary').click(); await page.waitForFunction(()=>document.querySelector('.pc-civitai-generation-data details pre')?.textContent.includes('nodes')); assert.match(await image.locator('details pre').textContent(), /nodes/);
    assert.equal(await search.evaluate(node=>node.parentElement.inert), true);
    await page.screenshot({ path: resolve(screenshots, 'image-desktop.png') });
    await page.keyboard.press('Escape'); assert.equal(await image.count(),0); assert.equal(await search.count(),1);
    assert.equal(await detail.getByRole('button',{name:'Civitai Image #3'}).evaluate(node=>document.activeElement===node),true);
    await detail.getByRole('button',{name:'Load more'}).click();
    await page.waitForFunction(()=>document.querySelector('.pc-civitai-pages span').textContent.endsWith('/ 4'));
    assert.equal(await detail.locator('.pc-civitai-pages span').textContent(), '3–4 / 4');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/gallery?')).length),galleryBefore+1);
    await page.screenshot({ path: resolve(screenshots, 'detail-desktop.png') });
    await detail.getByRole('button',{name:/取得.*選択/}).click();
    const failure = page.getByRole('dialog',{name:'取得に失敗しました'}); await failure.waitFor();
    assert.equal(await failure.getByRole('button',{name:'再試行',exact:true}).count(),0,'auth-required error waits for authentication before retry');
    await failure.getByRole('button',{name:'認証',exact:true}).click();
    const auth = page.getByRole('dialog',{name:'Civitai 認証',exact:true});
    await auth.getByText('未認証',{exact:true}).waitFor();
    await auth.getByLabel('Civitai APIキー',{exact:true}).fill('fixture-secret');
    await page.screenshot({ path: resolve(screenshots, 'auth.png') });
    const downloads = await page.evaluate(()=>window.downloads);
    await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.downloads), downloads);
    await failure.getByRole('button',{name:'再取得',exact:true}).click();
    await page.waitForFunction(()=>window.node.widgets.find(widget=>widget.name==='lora_name').value==='llm/fixture.safetensors');
    assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(window.node.properties)), /fixture-secret|gallery|description|image_url/);
    await detail.getByRole('button',{name:'戻る',exact:true}).click(); assert.equal(await search.getAttribute('aria-label'),'Civitai Search');
    await search.locator('.pc-civitai-results').evaluate(node=>node.scrollTop=650);
    const scroll = await search.locator('.pc-civitai-results').evaluate(node=>node.scrollTop);
    await page.evaluate(()=>window.originalGrid=document.querySelector('.pc-civitai-results'));
    const before = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.keyboard.press('Escape');
    await page.evaluate(()=>window.open()); await cards.first().waitFor();
    await page.waitForFunction(scroll=>document.querySelector('.pc-civitai-results').scrollTop===scroll,scroll);
    assert.equal(await page.evaluate(()=>document.querySelector('.pc-civitai-results')===window.originalGrid),false);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),before);
    await search.getByRole('searchbox',{name:'検索語'}).fill('draft without search');
    await page.keyboard.press('Escape'); await page.evaluate(()=>window.open()); await cards.first().waitFor();
    await search.getByText('前回成功した条件の検索結果',{exact:true}).waitFor();
    assert.equal(await search.getByRole('searchbox',{name:'検索語'}).inputValue(),'draft without search');
    await page.setViewportSize({width:360,height:740});
    assert.equal(await search.locator('.pc-civitai-results').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await page.screenshot({path:resolve(screenshots,'search-narrow.png')});
    await page.keyboard.press('Escape');
    // All keeps the browse filter while only an explicit compatible selection changes the node mode.
    await page.setViewportSize({width:1600,height:1000});
    await page.evaluate(()=>{window.node.widgets.find(widget=>widget.name==='model_mode').value='Anima';window.open();});
    await search.getByRole('combobox',{name:'Base Model',exact:true}).selectOption('');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('model_mode')==='');
    await cards.first().click();
    await detail.getByRole('button',{name:/取得.*選択/}).click();
    await page.waitForFunction(()=>window.node.widgets.find(widget=>widget.name==='model_mode').value==='Illustrious');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.model_mode),'Illustrious');
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    assert.equal(await search.getByRole('combobox',{name:'Base Model',exact:true}).inputValue(),'');
    await search.getByRole('combobox',{name:'Model Type',exact:true}).selectOption('Checkpoint');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('model_type')==='Checkpoint');
    await cards.first().click(); assert.equal(await detail.getByRole('button',{name:/取得.*選択/}).count(),0);
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    const searchesBeforeTag = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await search.getByRole('combobox',{name:'Category',exact:true}).fill('Style');
    await page.waitForFunction(()=>window.calls.some(call=>call.path.includes('/tags?')));
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),searchesBeforeTag);
    await search.getByRole('combobox',{name:'Category',exact:true}).press('Enter');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('category')==='Style');
    for (const host of ['civitai.com','civitai.red','civitai.com']) {
        await search.getByRole('combobox',{name:'接続先',exact:true}).selectOption(host);
        await page.waitForFunction(host=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('host')===host,host);
        assert.equal(await search.getByRole('combobox',{name:'Model Type',exact:true}).locator('option').count(),23);
    }
    await search.getByRole('combobox',{name:'Model Type',exact:true}).selectOption('LORA');
    await cards.first().click();
    await page.evaluate(()=>{window.authenticated=false;window.disabledDownload=true;});
    await detail.getByRole('button',{name:/取得.*選択/}).click(); await failure.waitFor();
    assert.equal(await failure.getByRole('button',{name:'認証',exact:true}).count(),0);
    await page.keyboard.press('Escape'); await page.evaluate(()=>window.disabledDownload=false);
    await detail.getByRole('button',{name:/取得.*選択/}).click(); await failure.waitFor();
    await failure.getByRole('button',{name:'認証',exact:true}).click();
    await auth.getByLabel('Civitai APIキー',{exact:true}).fill('pending-secret');
    await page.evaluate(()=>{window.deferAuth=true;window.releaseAuth=null;window.beforeStaleTransactions=window.transactions;});
    await auth.getByRole('button',{name:'認証',exact:true}).click();
    await page.waitForFunction(()=>window.releaseAuth);
    await page.evaluate(()=>{window.current.dismiss();window.releaseAuth();});
    await page.waitForTimeout(20);
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await page.evaluate(()=>window.transactions),await page.evaluate(()=>window.beforeStaleTransactions));
    // Equal IDs on replacement node objects do not share transient browse results.
    const beforeReplacement = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>{window.previousNode=window.node;window.node=window.makeNode();window.open();});
    await cards.first().waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),beforeReplacement+1);
    assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(window.node.properties)),/gallery|snapshot|draft|scroll|secret/);
    await page.keyboard.press('Escape');
    // Failed shared gallery requests are evicted, and only Detail exposes an explicit retry action.
    await page.evaluate(()=>{window.node=window.makeNode();window.failGallery=true;window.open();});
    await cards.first().getByText('画像を取得できませんでした。クリックして再試行',{exact:true}).waitFor();
    assert.equal(await cards.first().locator('button').count(),0);
    await page.evaluate(()=>window.failGallery=true); await cards.first().click();
    await detail.getByRole('button',{name:'再試行',exact:true}).click();
    await detail.getByRole('button',{name:'Civitai Image #1',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    // Older windows and late searches cannot overwrite the latest successful cache owner.
    await page.evaluate(()=>{window.old=window.open();window.deferSearch=true;window.releaseSearch=null;});
    await search.getByRole('searchbox',{name:'検索語'}).fill('old request');
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseSearch);
    await page.evaluate(()=>window.newer=window.open());
    const newest = page.locator('.pc-civitai-search-dialog').last();
    await newest.getByRole('searchbox',{name:'検索語'}).fill('new owner');
    await newest.getByRole('button',{name:'検索',exact:true}).click();
    await newest.locator('.pc-civitai-card strong').first().filter({hasText:'new owner'}).waitFor();
    await page.evaluate(()=>{window.old.dismiss();window.releaseSearch();}); await page.waitForTimeout(20);
    const searchesAfterLate = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>window.open()); await cards.first().waitFor();
    assert.match(await cards.first().locator('strong').textContent(), /new owner/);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),searchesAfterLate);
    await page.keyboard.press('Escape');
    // Unknown image IDs use the existing public metadata without inventing a lookup or unsafe link.
    const imagesBefore = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/image?')).length);
    await page.evaluate(()=>{window.local();window.noID();});
    const noID = page.getByRole('dialog',{name:'Civitai Image #10',exact:true});
    await noID.getByText('fallback positive',{exact:true}).waitFor();
    await noID.getByText('fallback negative',{exact:true}).waitFor();
    assert.deepEqual(await noID.locator('a').evaluateAll(links=>links.map(link=>link.href)),['https://civitai.red/models/4']);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/image?')).length),imagesBefore);
    await noID.locator('..').click({position:{x:2,y:2}});
    assert.equal(await noID.count(),0); assert.equal(await page.locator('[role="dialog"][aria-label="LoRA 詳細確認"]').count(),1, JSON.stringify(await page.locator('[role="dialog"]').evaluateAll(nodes=>nodes.map(node=>({title:node.getAttribute('aria-label'),inert:node.parentElement.inert})))));
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{window.local();window.detail();});
    const local = page.getByRole('dialog',{name:'LoRA 詳細確認',exact:true}), localDetail = page.getByRole('dialog',{name:'Civitai Detail',exact:true});
    await localDetail.getByRole('button',{name:'Civitai Image #1',exact:true}).click();
    await page.getByRole('dialog',{name:'Civitai Image #1',exact:true}).waitFor();
    await page.evaluate(()=>window.localParent.dismiss());
    assert.equal(await page.getByRole('dialog').count(),0,'parent dismissal cascades through detail/image');
    assert.deepEqual(errors, []);
    console.log('Civitai gallery sharing, responsive cards, nested image data, auth/retry and in-session search restoration passed. Screenshots: '+screenshots);
} finally { await browser.close(); await new Promise(done=>server.close(done)); }
