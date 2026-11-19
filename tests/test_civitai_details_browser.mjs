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
        window.calls=[];window.downloads=0;window.authenticated=true;window.activeGallery=0;window.maxGallery=0;window.galleryDelay=true;window.galleryReleases=[];
        window.graph={getNodeById:()=>window.node,beforeChange(){window.transactions=(window.transactions||0)+1;},afterChange(){}};
        window.makeNode=()=>({id:1,graph:window.graph,properties:{},widgets:Object.entries({model_mode:'Illustrious',lora_name:'',positive:'manual',negative:' negative,  keep\\n'}).map(([name,value])=>({name,value}))});
        window.node=window.makeNode();
        const preview=id=>({id,url:image+'#'+id,width:600,height:800});
        const description=prefix=>'<p>'+prefix+' paragraph <code>inline outfit</code></p><pre><code>'+prefix+'1\\n'+prefix+'2 &lt;literal&gt;</code></pre><script>window.descriptionInjected=true<'+'/script><img src="x" onerror="window.descriptionInjected=true"><a href="javascript:window.descriptionInjected=true">unsafe link</a><a href="https://example.com/reference">Reference</a>';
        const candidate=(id,query)=>({sha256:id.toString(16).padStart(64,'0'),size_kb:10,model_id:id,version_id:id===2?11:id+10,file_id:id+20,name:'Model '+id+' '+query+' long title for responsive layout',version_name:'v1',creator_name:id===2?'':id===3?'Author with a very long Unicode 名前 which must truncate':'作者 <script>literal<'+'/script>',base_model:id===3?'Illustrious XL with a very long model family name':'Illustrious',model_type:'LORA',installable:true,apply_model_mode:'Illustrious',triggers:['trigger'],description:description('outfit'),version_description:description('version'),gallery:[],image_url:'',model_stats:id===2?{downloadCount:null,collectedCount:'invalid',thumbsUpCount:null}:{downloadCount:5200,collectedCount:1200,thumbsUpCount:0},updated_at:id===2?null:'2026-11-15T12:00:00Z'});
        window.api={async fetchApi(path,options={}){
            window.calls.push({path,body:options.body?JSON.parse(options.body):null});
            const url=new URL(path,'http://fixture'), body=options.body?JSON.parse(options.body):{}, reply=(data,status=200)=>({ok:status===200,status,text:async()=>JSON.stringify(data)});
            if(url.pathname.endsWith('/directories'))return reply({directories:['','a','a/b','c','c/local','c/local/bin','c/local/lib','llm',...Array.from({length:20},(_,i)=>'z'+String(i).padStart(2,'0'))]});
            if(url.pathname.endsWith('/owned')){
                const matches=body.items.filter(item=>window.acquiredItems||(window.ownedItems||[]).includes(parseInt(item.sha256,16))).map(item=>({sha256:item.sha256,owned:true,lora_name:window.hiddenOwned===parseInt(item.sha256,16)?'':'folder/'+parseInt(item.sha256,16)+'.safetensors'}));
                window.ownershipSignals||=[];window.ownershipSignals.push(options.signal);
                if(window.deferOwned){window.deferOwned=false;await new Promise(done=>window.releaseOwned=done);}
                if(window.failOwned)return reply({error:'ownership offline'},500);
                return reply({items:matches});
            }
            if(url.pathname.endsWith('/options')){if(window.failOptions){window.failOptions=false;return reply({error:'options offline'},503);}const data={model_types:window.modelTypesByHost?.[url.searchParams.get('host')]||['Checkpoint','TextualInversion','Hypernetwork','AestheticGradient','LORA','LoCon','DoRA','Controlnet','Upscaler','MotionModule','VAE','TextEncoder','UNet','CLIPVision','Poses','Wildcards','Workflows','ComfyWorkflows','Detection','VisionLanguage','CLIP','LLM','Other'],categories:window.categoriesByHost?.[url.searchParams.get('host')]||window.categories||['Style','Action','Concept']};if(window.deferOptions){window.deferOptions=false;await new Promise(done=>window.releaseOptions=done);}if(window.failOptionsAfterWait){window.failOptionsAfterWait=false;return reply({error:'delayed options offline'},503);}return reply(data);}
            if(url.pathname.endsWith('/tags')){if(window.deferTags){window.deferTags=false;await new Promise(done=>window.releaseTags=done);}return reply({items:['Style','Action',url.searchParams.get('query')]});}
            if(url.pathname.endsWith('/search')){
                if(window.failSearchAuth){window.failSearchAuth=false;return reply({error:'Red authentication required',code:'civitai_auth_required'},401);}
                if(window.failSearch){window.failSearch=false;return reply({error:'search offline'},503);}
                if(window.deferSearch){window.deferSearch=false;await new Promise(done=>window.releaseSearch=done);}
                return reply({items:Array.from({length:30},(_,index)=>({...candidate(index+1,url.searchParams.get('query')||''),installable:url.searchParams.get('model_type')==='LORA',...(window.acquiredItems?{acquired:true,lora_name:'folder/'+(index+1)+'.safetensors'}:{})}))});
            }
            if(url.pathname.endsWith('/gallery')){
                if(window.failGalleryAuth)return reply({error:'Gallery authentication required',code:'civitai_auth_required'},401);
                window.activeGallery++;window.maxGallery=Math.max(window.maxGallery,window.activeGallery);
                if(window.galleryDelay)await new Promise(done=>window.galleryReleases.push(done));
                window.activeGallery--;
                if(window.failGallery){window.failGallery=false;return reply({error:'gallery offline'},503);}
                return reply(url.searchParams.has('cursor')?{items:[preview(103),preview(104)],next_cursor:null}:{items:[preview(101),preview(102),preview(103)],next_cursor:'next'});
            }
            if(url.pathname.endsWith('/image')){
                if(window.failImageAuth)return reply({error:'Image authentication required',code:'civitai_auth_required'},401);
                if(window.deferImage){window.deferImage=false;await new Promise(done=>window.releaseImage=done);}
                return reply({image:preview(Number(url.searchParams.get('image_id'))),resources:[{name:'Resource <img src=x onerror=window.injected=true>',type:'LORA',strength:0.7,url:'https://civitai.red/models/1'}],prompt:'positive only <script>text<'+'/script>',negative_prompt:'negative separate',tags:['public tag',{name:'named <script>tag<'+'/script>'},{bad:'skip'},7],other:{workflow:{nodes:[{id:1}]},width:600,height:800,createdAt:'2026-11-15',seed:0,sampler:'Euler',steps:20,cfgScale:0,user:'excluded',url:'excluded'},partial:false});
            }
            if(url.pathname.endsWith('/details')&&window.failDetailAuth)return reply({error:'Details authentication required',code:'civitai_auth_required'},401);
            if(url.pathname.endsWith('/details'))return reply({...candidate(1,''),gallery:[preview(101)],image_url:image});
            if(url.pathname.endsWith('/auth/clear')){window.authenticated=false;return reply({configured:false,username:''});}
            if(url.pathname.endsWith('/auth')){
                if(!options.body&&window.deferAuthStatus){window.deferAuthStatus=false;const data={configured:window.authenticated,username:''};await new Promise(done=>window.releaseAuthStatus=done);return reply(data);}
                if(options.body){if(window.deferAuth){window.deferAuth=false;await new Promise(done=>window.releaseAuth=done);}window.authenticated=true;}
                return reply({configured:window.authenticated,username:window.authenticated?'fixture-user':''});
            }
            if(url.pathname.endsWith('/download')){
                window.downloads++;
                if(window.deferDownload){window.deferDownload=false;await new Promise(done=>window.releaseDownload=done);}
                if(window.downloadError)return reply({error:'download offline'},503);
                if(window.disabledDownload)return reply({error:'Creator disabled',code:'civitai_download_disabled'},401);
                if(!window.authenticated)return reply({error:'Authentication required',code:'civitai_auth_required'},401);
                if(window.fileExists&&body.existing_action==='ask')return reply({error:'既に存在します。再取得しますか？',code:'civitai_file_exists',existing_name:(body.directory?body.directory+'/':'')+'fixture.safetensors'},409);
                if(window.fileExists&&body.existing_action==='select'&&window.existingDifferent)return reply({candidate:null,lora_name:body.existing_name});
                return reply({candidate:candidate(body.model_id,''),lora_name:(body.directory?body.directory+'/':'')+'fixture.safetensors'});
            }
            throw new Error('Unexpected API '+path);
        }};
        const events=new EventTarget(); window.api.clientId="fixture-client"; window.progressListeners=new Set(); window.api.addEventListener=(name,listener)=>{window.progressListeners.add(listener);events.addEventListener(name,listener);}; window.api.removeEventListener=(name,listener)=>{window.progressListeners.delete(listener);events.removeEventListener(name,listener);}; window.progress=data=>events.dispatchEvent(new CustomEvent("scene_prompt_civitai_download_progress",{detail:data}));
        window.open=()=>window.current=openCivitaiSearch({node:window.node,api:window.api,activeGraph:()=>window.graph,onAcquired:()=>{window.catalogRefresh=(window.catalogRefresh||0)+1;}});
        window.local=()=>window.localParent=openModal('LoRA 詳細確認');
        window.detail=()=>openCivitaiDetail({api:window.api,modelID:1,versionID:11});
        window.noID=()=>openCivitaiImage({api:window.api,preview:{url:image,width:600,height:800,createdAt:'preview date',meta:{width:null,height:0,createdAt:null,seed:0,steps:{bad:1},workflow:{nodes:[]},meta:{seed:null},prompt:'fallback positive',negativePrompt:'fallback negative',resources:[{name:'untrusted',url:'javascript:window.injected=true'},{model:{id:4,name:'safe resource'},modelVersionId:12,id:13},{modelId:5,id:14},{modelId:6,modelVersionId:'15',id:16},{modelId:7,modelVersionId:0},{modelId:8,modelVersionId:-1},{modelId:9,modelVersionId:2.5},{modelId:10,modelVersionId:null,id:20},{modelId:11,modelVersionId:9007199254740992}]}},index:9,host:'civitai.red'});
        document.querySelector('#launch').onclick=window.open;window.ready=true;
    </script></body>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true });
const screenshots = resolve(tmpdir(), "scene-civitai-details-review");
await mkdir(screenshots, { recursive: true });
async function verifyOwnership() {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
    await page.evaluate(() => { window.galleryDelay=false; window.deferOwned=true; window.ownedItems=[1,2]; window.hiddenOwned=2; window.node.widgets.find(widget=>widget.name==='lora_name').value='folder/1.safetensors'; window.beforeOwned=JSON.stringify(window.node); });
    await page.getByRole('button',{name:'Open',exact:true}).click();
    const search=page.locator('.pc-civitai-search-dialog'), cards=search.locator('.pc-civitai-card'), badges=cards.locator('.pc-civitai-card-owned:visible');
    await page.waitForFunction(()=>window.releaseOwned);
    assert.equal(await cards.count(),30,'grid renders before local hash lookup completes');
    assert.equal(await badges.count(),0);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/owned')).length),1,'one ownership batch for the result');
    assert.equal(await page.evaluate(()=>window.calls.find(call=>call.path.endsWith('/owned')).body.items.length),30);
    await cards.nth(3).focus();
    await page.evaluate(()=>{window.focusedOwned=document.activeElement;window.firstOwned=document.querySelector('.pc-civitai-card');window.releaseOwned();});
    await badges.first().waitFor();
    assert.equal(await badges.count(),2);
    assert.match(await cards.first().getAttribute('aria-label'),/所持済み/);
    assert.equal(await cards.first().evaluate(card=>card===window.firstOwned),true,'ownership updates the existing card');
    assert.equal(await page.evaluate(()=>document.activeElement===window.focusedOwned),true,'ownership preserves keyboard focus');
    assert.equal(await cards.first().evaluate(card=>card.classList.contains('pc-lora-selected')),true);
    assert.equal(await cards.nth(1).evaluate(card=>card.classList.contains('pc-lora-selected')),false,'hidden root ownership does not select a wrong path');
    assert.equal(await badges.locator('button,a,[tabindex]').count(),0,'static owned badge has no extra tab stop');
    assert.equal(await page.evaluate(()=>JSON.stringify(window.node)===window.beforeOwned),true,'ownership does not apply LoRA, triggers, or graph edits');
    for (const width of [1600,420]) {
        await page.setViewportSize({width,height:1000});
        const geometry=await cards.first().evaluate(card=>{
            const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};};
            return {preview:rect(card.querySelector('.pc-civitai-card-preview')),badge:rect(card.querySelector('.pc-civitai-card-owned')),base:rect(card.querySelector('.pc-civitai-card-base')),overflow:card.scrollWidth>card.clientWidth};
        });
        assert.equal(geometry.badge.left,geometry.preview.left); assert.equal(geometry.badge.top,geometry.preview.top);
        assert(geometry.base.top>=geometry.badge.bottom,'base model label sits below the owned badge'); assert.equal(geometry.overflow,false);
        await page.screenshot({path:resolve(screenshots,`owned-${width}.png`)});
    }
    await page.setViewportSize({width:1600,height:1000});
    // A cached reopen rechecks disk state, including deletion, without repeating provider search.
    await page.evaluate(()=>{window.node.sceneCivitaiSearchCleanup();window.ownedItems=[];window.open();});
    await cards.first().waitFor(); await page.waitForFunction(()=>window.calls.filter(call=>call.path.endsWith('/owned')).length===2);
    assert.equal(await badges.count(),0);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),1);
    await page.evaluate(()=>window.failOwned=true); await search.getByRole('button',{name:'検索',exact:true}).click();
    await search.locator('.pc-civitai-ownership-status').filter({hasText:'確認できませんでした'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1,'local lookup errors stay inline');
    assert.equal(await badges.count(),0);
    await page.evaluate(()=>{window.failOwned=false;window.deferOwned=true;window.ownedItems=[1];window.releaseOwned=null;});
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseOwned);
    await page.evaluate(()=>{window.oldOwnedRelease=window.releaseOwned;window.oldOwnedSignal=window.ownershipSignals.at(-1);window.ownedItems=[3];});
    await search.getByRole('searchbox',{name:'検索語'}).fill('replacement'); await search.getByRole('button',{name:'検索',exact:true}).click();
    await cards.nth(2).locator('.pc-civitai-card-owned').waitFor({state:'visible'});
    await page.evaluate(()=>window.oldOwnedRelease());
    assert.equal(await page.evaluate(()=>window.oldOwnedSignal.aborted),true);
    assert.equal(await cards.first().locator('.pc-civitai-card-owned').isVisible(),false,'replaced search ignores a late ownership reply');
    assert.equal(await cards.nth(2).locator('.pc-civitai-card-owned').isVisible(),true);
    // Close/reopen cannot publish the prior generation's response.
    await page.evaluate(()=>{window.deferOwned=true;window.ownedItems=[1];window.releaseOwned=null;});
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseOwned);
    await page.evaluate(()=>{window.oldOwnedRelease=window.releaseOwned;window.oldOwnedSignal=window.ownershipSignals.at(-1);window.node.sceneCivitaiSearchCleanup();window.ownedItems=[];window.open();});
    await cards.first().waitFor(); await page.evaluate(()=>window.oldOwnedRelease());
    assert.equal(await page.evaluate(()=>window.oldOwnedSignal.aborted),true);
    assert.equal(await badges.count(),0,'closed generation cannot restore stale ownership');
    // Download-only success is immediately owned; a pre-download lookup cannot clear it.
    await page.evaluate(()=>{window.deferOwned=true;window.releaseOwned=null;});
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseOwned);
    await page.evaluate(()=>{window.oldOwnedRelease=window.releaseOwned;window.oldOwnedSignal=window.ownershipSignals.at(-1);});
    await cards.first().click();
    await search.getByRole('button',{name:'取得',exact:true}).click();
    const destination=page.getByRole('dialog',{name:'LoRAを取得',exact:true});
    await destination.getByRole('button',{name:'取得',exact:true}).click();
    await destination.waitFor({state:'detached'});
    await page.evaluate(()=>window.oldOwnedRelease());
    await search.getByRole('button',{name:'戻る',exact:true}).click();
    await cards.first().locator('.pc-civitai-card-owned').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.oldOwnedSignal.aborted),true);
    assert.equal(await cards.first().evaluate(card=>card.classList.contains('pc-lora-selected')),false,'download-only does not select the acquired file');
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='lora_name').value),'folder/1.safetensors');
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='positive').value),'manual');
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='negative').value),' negative,  keep\n');
    // A failed download resumes a fresh ownership check for every result item.
    await cards.nth(1).click(); await search.getByRole('button',{name:'取得',exact:true}).click();
    const before=await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/owned')).length);
    await page.evaluate(()=>{window.downloadError=true;window.ownedItems=[2];});
    await destination.getByRole('button',{name:'取得',exact:true}).click();
    await page.waitForFunction(before=>window.calls.filter(call=>call.path.endsWith('/owned')).length>before,before);
    await page.getByRole('dialog',{name:'取得に失敗しました',exact:true}).getByRole('button',{name:'閉じる',exact:true}).click();
    await page.keyboard.press('Escape'); await search.getByRole('button',{name:'戻る',exact:true}).click();
    await cards.nth(1).locator('.pc-civitai-card-owned').waitFor({state:'visible'});
    assert.equal(await cards.nth(1).evaluate(card=>card.classList.contains('pc-lora-selected')),false);
    // Authentication changes abort and discard local ownership work too.
    await page.evaluate(()=>{window.deferOwned=true;window.ownedItems=[1];window.releaseOwned=null;});
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseOwned);
    await page.evaluate(()=>{window.oldOwnedRelease=window.releaseOwned;window.oldOwnedSignal=window.ownershipSignals.at(-1);});
    await search.getByRole('button',{name:'認証',exact:true}).click();
    const auth=page.getByRole('dialog',{name:'Civitai 認証',exact:true});
    await auth.getByRole('button',{name:'認証解除',exact:true}).click();
    await auth.getByText('未認証',{exact:true}).waitFor(); await page.keyboard.press('Escape');
    await page.evaluate(()=>window.oldOwnedRelease());
    assert.equal(await page.evaluate(()=>window.oldOwnedSignal.aborted),true);
    assert.equal(await cards.count(),0,'authentication change discards the prior result');
    assert.deepEqual(errors,[]);
    await page.close();
}
try {
    await verifyOwnership();
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
    const boxes = await cards.evaluateAll(nodes => nodes.slice(0,7).map(node => node.getBoundingClientRect().y));
    assert(boxes.slice(0,6).every(y => y === boxes[0])); assert(boxes[6] > boxes[0]);
    assert.deepEqual(await search.locator('.pc-civitai-controls select,.pc-civitai-controls [role=combobox]').evaluateAll(nodes => nodes.map(node=>node.getAttribute('aria-label'))), ['接続先','Base Model','Model Type','Category','並び順']);
    async function checkCardGeometry(expectedColumns) {
        const geometry = await cards.first().evaluate(card=>{
            const box = node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
            const title=card.querySelector('.pc-civitai-card-title'), version=card.querySelector('.pc-civitai-card-version'), base=card.querySelector('.pc-civitai-card-base'), author=card.querySelector('.pc-civitai-card-author'), stats=card.querySelector('.pc-civitai-card-stats');
            return {card:box(card),image:box(card.querySelector('img')),title:box(title),version:box(version),base:box(base),author:box(author),baseText:base.textContent,titleText:title.textContent,authorText:author.textContent,stats:box(stats),metrics:[...stats.children].map(box),font:parseFloat(getComputedStyle(card).fontSize),titleFont:parseFloat(getComputedStyle(title).fontSize),overflow:card.scrollWidth>card.clientWidth};
        });
        assert(geometry.title.top>=geometry.image.bottom);assert(geometry.version.top>=geometry.title.bottom);assert.equal(geometry.base.left,geometry.image.left);assert.equal(geometry.base.top,geometry.image.top);assert.equal(geometry.baseText,'Illustrious');assert.match(geometry.titleText,/Model 1/);assert.equal(geometry.authorText,'作者 <script>literal</script>');assert(geometry.author.left<geometry.stats.left);assert(geometry.author.width>=32&&geometry.author.right<=geometry.stats.left,JSON.stringify(geometry));assert(geometry.stats.right<=geometry.card.right);assert(geometry.metrics.every(metric=>metric.top===geometry.metrics[0].top));assert(geometry.font>=14);assert(geometry.titleFont>=16);assert.equal(geometry.overflow,false);
        const rows=await cards.evaluateAll(nodes=>nodes.slice(0,7).map(node=>node.getBoundingClientRect().top));assert(rows.slice(0,expectedColumns).every(y=>y===rows[0]));assert(rows[expectedColumns]>rows[0]);
        const toolbar=await search.locator('.pc-civitai-controls > *').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));assert(toolbar.every(y=>y===toolbar[0]),'toolbar stays on one row');
    }
    await checkCardGeometry(6);
    for (const [width,columns] of [[1400,6],[960,4],[520,2]]) { await page.setViewportSize({width,height:1000}); await checkCardGeometry(columns); }
    await page.setViewportSize({width:1600,height:1000});
    assert((await cards.first().boundingBox()).width<270,'six-column cards are about half the old three-column width');
    assert.equal(await cards.nth(2).locator('.pc-civitai-card-base').getAttribute('title'),'Illustrious XL with a very long model family name');
    assert.equal(await cards.nth(2).locator('.pc-civitai-card-base').evaluate(node=>getComputedStyle(node).textOverflow),'ellipsis');
    assert.equal(await cards.nth(2).locator('.pc-civitai-card-author').evaluate(node=>getComputedStyle(node).textOverflow),'ellipsis');
    assert.equal(await cards.nth(1).locator('.pc-civitai-card-author').textContent(),'—');
    assert.match(await cards.nth(2).locator('.pc-civitai-card-author').getAttribute('title'),/Unicode 名前/);
    assert.deepEqual(await search.getByRole('combobox',{name:'並び順',exact:true}).locator('option').evaluateAll(nodes=>nodes.map(node=>node.value)),['Relevancy','Highest Rated','Most Downloaded','Most Liked','Most Collected','Newest']);
    await page.screenshot({ path: resolve(screenshots, 'search-desktop.png') });
    const galleryBefore = await page.evaluate(() => window.calls.filter(call => call.path.includes('/gallery?')).length);
    await cards.first().click();
    assert.equal(await search.getAttribute('aria-label'), 'Civitai Detail');
    assert.match(await search.locator('.pc-civitai-metadata').textContent(), /AUTHOR.*作者 <script>literal<\/script>.*UPDATED.*2026-11-15T12:00:00Z/s);
    const detail = search.locator('.pc-civitai-detail');
    async function assertDescriptionFormatting(scope) {
        const descriptions = scope.locator('.pc-civitai-metadata dd .pc-civitai-description');
        assert.equal(await descriptions.count(), 2);
        for (const [index, prefix] of ['outfit', 'version'].entries()) {
            const description = descriptions.nth(index);
            assert.equal(await description.locator('pre > code').textContent(), prefix + '1\n' + prefix + '2 <literal>');
            assert.equal(await description.locator('p > code').textContent(), 'inline outfit');
            assert.match(await description.locator('p').textContent(), new RegExp(prefix + ' paragraph'));
            assert.equal(await description.locator('script,img,[onerror],a[href^="javascript:"]').count(), 0);
        }
        assert.equal(await scope.getByRole('button', { name: '注入', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.descriptionInjected === true), false);
    }
    await assertDescriptionFormatting(detail);
    async function assertMetadataStripes(width) {
        await page.setViewportSize({ width, height: 1000 });
        const rows = await detail.locator('.pc-civitai-metadata-row').evaluateAll(nodes => {
            const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = color => rgb(color).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; })
                .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
            const contrast = (front, back) => { const a = luminance(front), b = luminance(back); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
            return nodes.map(row => {
                const term = row.querySelector('dt'), value = row.querySelector('dd'), style = getComputedStyle(row);
                const label = term.getBoundingClientRect(), content = value.getBoundingClientRect(), bounds = row.getBoundingClientRect();
                return { background: style.backgroundColor, termColor: getComputedStyle(term).color, valueColor: getComputedStyle(value).color,
                    backgrounds: [term, value].map(node => getComputedStyle(node).backgroundColor),
                    contrast: [term, value, ...row.querySelectorAll('a')].map(node => contrast(getComputedStyle(node).color, style.backgroundColor)),
                    inside: label.left >= bounds.left && content.right <= bounds.right + 1,
                    stacked: content.top >= label.bottom - 1, autoColors: style.forcedColorAdjust };
            });
        });
        assert(rows.length >= 9);
        assert.notEqual(rows[0].background, rows[1].background);
        for (const [index, row] of rows.entries()) {
            assert.equal(row.background, rows[index % 2].background, 'all metadata rows alternate gray fills');
            assert.equal(row.termColor, row.valueColor, 'term and value share the row foreground');
            assert.deepEqual(row.backgrounds, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
            assert(row.contrast.every(value => value >= 4.5), `metadata text/link contrast: ${row.contrast}`);
            assert(row.inside); assert.equal(row.stacked, width <= 520); assert.equal(row.autoColors, 'auto');
        }
        await assertDescriptionFormatting(detail);
        assert.equal(await detail.locator('a[href="https://example.com/reference"]').count(), 2);
        await detail.locator(".pc-civitai-metadata-row").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(screenshots, `metadata-stripes-${width}.png`) });
    }
    await assertMetadataStripes(1600);
    await assertMetadataStripes(420);
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await detail.locator('.pc-civitai-metadata-row').first().evaluate(node => getComputedStyle(node).forcedColorAdjust), 'auto');
    await page.emulateMedia({ forcedColors: 'none' });
    await page.setViewportSize({ width: 1600, height: 1000 });
    const acquireAndSelect = async () => {
        if (!await page.getByRole('dialog',{name:'LoRAを取得',exact:true}).count()) await detail.getByRole('button',{name:'取得',exact:true}).click();
        await page.getByRole('dialog',{name:'LoRAを取得',exact:true}).getByRole('button',{name:'取得して選択',exact:true}).click();
    };
    const assertPromptTextsUnchanged = async () => assert.deepEqual(await page.evaluate(() => Object.fromEntries(
        window.node.widgets.filter(widget => ['positive', 'negative'].includes(widget.name)).map(widget => [widget.name, widget.value])
    )), { positive: 'manual', negative: ' negative,  keep\n' });
    await detail.getByRole('button',{name:'Next',exact:true}).click();
    await detail.getByRole('button',{name:'Civitai Image #3',exact:true}).click();
    const image = page.getByRole('dialog',{name:'Civitai Image #3',exact:true});
    await image.getByText('positive only <script>text</script>',{exact:true}).waitFor();
    assert.deepEqual(await image.locator('h3').allTextContents(), ['RESOURCES USED','PROMPT','TAG','NEGATIVE PROMPT','OTHER METADATA']);
    assert.equal(await image.locator('script,img[onerror]').count(),0);
    assert.equal(await image.locator('pre > code').count(),2);
    assert.equal(await image.locator('details,summary').count(),0);
    assert.deepEqual(await image.locator('.pc-civitai-tag').allTextContents(),['public tag','named <script>tag</script>']);
    assert.equal(await image.locator('.pc-civitai-tags button,.pc-civitai-tags a').count(),0);
    assert.deepEqual(await image.locator('.pc-civitai-generation-data > p').allTextContents(),['width: 600','height: 800','createdAt: 2026-11-15','seed: 0','sampler: Euler','steps: 20','cfgScale: 0']);
    assert.doesNotMatch(await image.textContent(),/workflow|nodes|excluded/);
    assert.equal(await search.evaluate(node=>node.parentElement.inert), true);
    await page.screenshot({ path: resolve(screenshots, 'image-desktop.png') });
    await page.keyboard.press('Escape'); assert.equal(await image.count(),0); assert.equal(await search.count(),1);
    assert.equal(await detail.getByRole('button',{name:'Civitai Image #3'}).evaluate(node=>document.activeElement===node),true);
    await detail.getByRole('button',{name:'Load more'}).click();
    await page.waitForFunction(()=>document.querySelector('.pc-civitai-pages span').textContent.endsWith('/ 4'));
    assert.equal(await detail.locator('.pc-civitai-pages span').textContent(), '3–4 / 4');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/gallery?')).length),galleryBefore+1);
    await page.screenshot({ path: resolve(screenshots, 'detail-desktop.png') });
    for (const outcome of ['success','error','auth','stale','stale-error']) {
        await detail.getByRole('button',{name:'取得',exact:true}).click();
        const destination = page.getByRole('dialog',{name:'LoRAを取得',exact:true});
        await page.evaluate(outcome=>{window.deferDownload=true;window.releaseDownload=null;window.downloadError=outcome==='error'||outcome==='stale-error';window.authenticated=outcome!=='auth';window.busyDownloads=window.downloads;window.busyNode=window.node;window.busyState=JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions});},outcome);
        await destination.getByRole('button',{name:'取得',exact:true}).click(); await page.waitForFunction(()=>window.releaseDownload);
        await page.evaluate(()=>{const body=window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body;window.progress({download_id:'wrong-id',received:99,total:100});});
        assert.equal(await destination.locator('progress').isVisible(),true);
        assert.equal(await destination.locator('progress').getAttribute('value'),null,'wrong id cannot set the initial indeterminate progress');
        await page.evaluate(()=>{const body=window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body;window.progress({download_id:body.download_id,received:5,total:10});});
        assert.equal(await destination.locator('progress').getAttribute('value'),'5');
        assert.match(await destination.locator('.pc-civitai-download-progress').textContent(),/50%/);
        if(outcome==='success') { await page.waitForTimeout(350); await page.screenshot({path:resolve(screenshots,'download-progress.png')}); }
        await page.evaluate(()=>{const body=window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body;window.progress({download_id:body.download_id,received:10,total:10});});
        assert.match(await destination.locator('.pc-civitai-download-progress').textContent(),/100%.*確認・保存中/);
        await page.evaluate(()=>{const body=window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body;window.progress({download_id:body.download_id,received:11,total:null});});
        assert.equal(await destination.locator('progress').getAttribute('value'),null);
        assert.match(await destination.locator('.pc-civitai-download-progress').textContent(),/11 bytes/);
        assert.equal(await destination.getAttribute('aria-busy'),'true'); assert.equal(await destination.evaluate(dialog=>dialog.inert),true);
        assert.equal(await destination.getByRole('button',{name:'閉じる',exact:true}).isDisabled(),true);
        assert.equal(await destination.locator('input,button').evaluateAll(nodes=>nodes.every(node=>node.disabled)),true);
        assert.equal(await destination.locator('.pc-civitai-download-actions button').first().evaluate(node=>getComputedStyle(node).color),'rgb(133, 137, 147)','busy actions are visibly gray');
        await destination.getByRole('button',{name:'閉じる',exact:true}).evaluate(button=>button.click());
        await destination.evaluate(dialog=>dialog.parentElement.click()); await page.keyboard.press('Escape');
        await page.evaluate(()=>window.current.dismiss());
        assert.equal(await destination.count(),1); assert.equal(await search.count(),1);
        await destination.getByRole('button',{name:'取得して選択',exact:true}).evaluate(button=>button.click());
        assert.equal(await page.evaluate(()=>window.downloads),await page.evaluate(()=>window.busyDownloads+1));
        await page.evaluate(outcome=>{if(outcome.startsWith('stale'))window.node=window.makeNode();window.releaseDownload();},outcome);
        if(outcome==='error'||outcome==='auth') {
            const error = page.getByRole('dialog',{name:'取得に失敗しました',exact:true}); await error.waitFor();
            assert.equal(await destination.getAttribute('aria-busy'),'false'); assert.equal(await destination.evaluate(dialog=>dialog.inert),false);
            assert.equal(await error.getByRole('button',{name:'認証',exact:true}).count(),outcome==='auth'?1:0);
            await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
        } else {
            await destination.waitFor({state:'detached'});
            assert.equal(await page.getByRole('dialog',{name:'取得に失敗しました',exact:true}).count(),0);
        }
        assert.equal(await page.evaluate(()=>JSON.stringify({widgets:window.busyNode.widgets,properties:window.busyNode.properties,transactions:window.transactions})),await page.evaluate(()=>window.busyState));
        assert.equal(await page.evaluate(()=>window.progressListeners.size),0,'listener released on every result');
        await page.evaluate(()=>{window.node=window.busyNode;window.authenticated=true;window.downloadError=false;});
        if (!await search.count()) { await page.evaluate(()=>window.open()); await cards.first().waitFor(); await cards.first().click(); }
    }
    await page.evaluate(()=>window.authenticated=false);
    await detail.getByRole('button',{name:'取得',exact:true}).click();
    await page.getByRole('dialog',{name:'LoRAを取得',exact:true}).getByRole('combobox',{name:'保存先',exact:true}).fill('auth/snapshot');
    await acquireAndSelect();
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
    await page.waitForFunction(()=>window.node.widgets.find(widget=>widget.name==='lora_name').value==='auth/snapshot/fixture.safetensors');
    await assertPromptTextsUnchanged();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.directory),'auth/snapshot');
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
    await page.setViewportSize({width:1000,height:800}); await checkCardGeometry(4); await page.screenshot({path:resolve(screenshots,'search-medium.png')});
    await page.setViewportSize({width:760,height:800}); await checkCardGeometry(2); await page.screenshot({path:resolve(screenshots,'search-two-columns.png')});
    await page.setViewportSize({width:360,height:740}); await checkCardGeometry(1);
    assert.equal(await search.locator('.pc-civitai-controls').evaluate(node=>node.scrollWidth>node.clientWidth),true);
    assert.equal(await search.locator('.pc-civitai-results').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await page.screenshot({path:resolve(screenshots,'search-narrow.png')});
    await page.keyboard.press('Escape');
    // All keeps the browse filter while only an explicit compatible selection changes the node mode.
    await page.setViewportSize({width:1600,height:1000});
    await page.evaluate(()=>{window.node.widgets.find(widget=>widget.name==='model_mode').value='Anima';window.open();});
    await search.getByRole('combobox',{name:'Base Model',exact:true}).selectOption('');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('model_mode')==='');
    await cards.first().click();
    await acquireAndSelect();
    await page.waitForFunction(()=>window.node.widgets.find(widget=>widget.name==='model_mode').value==='Illustrious');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.model_mode),'Illustrious');
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    assert.equal(await search.getByRole('combobox',{name:'Base Model',exact:true}).inputValue(),'');
    await search.getByRole('combobox',{name:'Model Type',exact:true}).selectOption('Checkpoint');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('model_type')==='Checkpoint');
    await cards.first().click(); assert.equal(await detail.getByRole('button',{name:'取得',exact:true}).count(),0);
    await detail.getByRole('button',{name:'戻る',exact:true}).click();
    assert.equal(await search.locator('input[aria-label="Category"],datalist,small').count(),0);
    await search.getByRole('combobox',{name:'Category',exact:true}).selectOption('Style');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('category')==='Style');
    for (const host of ['civitai.com','civitai.red','civitai.com']) {
        await search.getByRole('combobox',{name:'接続先',exact:true}).selectOption(host);
        await page.waitForFunction(host=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('host')===host,host);
        assert.equal(await search.getByRole('combobox',{name:'Model Type',exact:true}).locator('option').count(),23);
    }
    await search.getByRole('combobox',{name:'Model Type',exact:true}).selectOption('LORA');
    await cards.first().click();
    await page.evaluate(()=>{window.authenticated=false;window.disabledDownload=true;});
    await acquireAndSelect(); await failure.waitFor();
    assert.equal(await failure.getByRole('button',{name:'認証',exact:true}).count(),0);
    await page.keyboard.press('Escape'); await page.evaluate(()=>window.disabledDownload=false);
    await acquireAndSelect(); await failure.waitFor();
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
    // Destination picker supports typed/new folders, tree keys, root and download-only without undo.
    await page.evaluate(()=>{window.node.sceneCivitaiSearchCleanup?.();window.node=window.makeNode();window.authenticated=true;window.open();});
    await cards.first().click(); await detail.getByRole('button',{name:'取得',exact:true}).click();
    const destination = page.getByRole('dialog',{name:'LoRAを取得',exact:true}), directory = destination.getByRole('combobox',{name:'保存先',exact:true});
    await destination.getByText('空欄はLoRAフォルダ直下。新しい保存先も入力できます。',{exact:true}).waitFor();
    assert.equal(await directory.inputValue(),'llm');
    await destination.getByRole('button',{name:'保存先を選択',exact:true}).click();
    const lastDirectory = destination.getByRole('option',{name:'z19',exact:true});
    await lastDirectory.scrollIntoViewIfNeeded();
    assert.equal(await lastDirectory.evaluate(node=>{const rect=node.getBoundingClientRect();return node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}),true,'last folder remains clickable inside the modal');
    await page.screenshot({path:resolve(screenshots,'download-destination-tree.png')});
    assert((await destination.getByRole('listbox').evaluate(node=>node.scrollTop))>0,'long tree scrolls within its own list');
    await lastDirectory.click(); assert.equal(await directory.inputValue(),'z19');
    await destination.getByRole('button',{name:'保存先を選択',exact:true}).click();
    assert.deepEqual(await destination.getByRole('option').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['ルート','a','a/b','c','c/local','c/local/bin','c/local/lib','llm',...Array.from({length:20},(_,i)=>'z'+String(i).padStart(2,'0'))]);
    await directory.press('ArrowDown'); await directory.press('Escape'); assert.equal(await destination.count(),1); assert.equal(await directory.getAttribute('aria-expanded'),'false');
    await destination.getByRole('button',{name:'保存先を選択',exact:true}).click();
    await destination.getByRole('option',{name:'a/b',exact:true}).click(); assert.equal(await directory.inputValue(),'a/b');
    await directory.press('ArrowDown'); await directory.press('Enter'); assert.equal(await directory.getAttribute('aria-expanded'),'false');
    await page.setViewportSize({width:360,height:740});
    assert.equal(await destination.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await destination.getByRole('button',{name:'保存先を選択',exact:true}).click();
    await lastDirectory.scrollIntoViewIfNeeded();
    assert.equal(await lastDirectory.evaluate(node=>{const rect=node.getBoundingClientRect();return node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}),true,'last folder is clickable on narrow screens');
    for (const button of await destination.locator('.pc-civitai-download-actions button').all()) assert.equal(await button.evaluate(node=>{const rect=node.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight&&node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));}),true,'footer actions stay visible and clickable with dropdown open');
    await page.screenshot({path:resolve(screenshots,'download-destination-narrow.png')});
    await lastDirectory.click();
    await page.setViewportSize({width:1600,height:1000});
    await directory.fill('new/A/B');
    const valuesBeforeOnly = await page.evaluate(()=>JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions}));
    await destination.getByRole('button',{name:'取得',exact:true}).click(); await destination.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions})),valuesBeforeOnly);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.directory),'new/A/B');
    assert((await page.evaluate(()=>window.catalogRefresh))>0);
    await detail.getByRole('button',{name:'取得',exact:true}).click(); assert.equal(await directory.inputValue(),'new/A/B');
    await directory.fill(''); await destination.getByRole('button',{name:'取得して選択',exact:true}).click(); await destination.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='lora_name').value),'fixture.safetensors');
    await assertPromptTextsUnchanged();
    // Same-object newer search invalidates an older pending acquisition before any mutation/catalog refresh.
    await detail.getByRole('button',{name:'取得',exact:true}).click();
    await page.evaluate(()=>{window.deferDownload=true;window.releaseDownload=null;window.oldValues=JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions,catalogRefresh:window.catalogRefresh});window.oldWindow=window.current;});
    await destination.getByRole('button',{name:'取得して選択',exact:true}).click(); await page.waitForFunction(()=>window.releaseDownload);
    await page.evaluate(()=>{window.newWindow=window.open();window.newFocus=document.activeElement;window.releaseDownload();}); await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>window.newWindow.overlay.isConnected && document.activeElement===window.newFocus),true,"stale owner cleanup preserves the independent new Search and its focus");
    assert.equal(await search.count(),1);
    assert.equal(await page.evaluate(()=>window.oldWindow.overlay.isConnected),false);
    assert.equal(await page.evaluate(()=>JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions,catalogRefresh:window.catalogRefresh})),await page.evaluate(()=>window.oldValues));
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // Red has an inline authentication gate; authentication never starts a search automatically.
    const optionsBeforeGate=await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/options?')).length);
    const gateBefore = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>{window.node=window.makeNode();window.authenticated=false;window.open();});
    await search.getByText('civitai.redで検索するには認証が必要です。右上の「認証」からAPIキーを登録してください。',{exact:true}).waitFor();
    assert.equal(await search.getByRole('button',{name:'検索',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/options?')).length),optionsBeforeGate,'unconfigured red never loads options');
    assert.equal(await page.getByRole('dialog',{name:'Civitai 認証',exact:true}).count(),0);
    await search.getByRole('button',{name:'認証',exact:true}).click(); await auth.getByLabel('Civitai APIキー',{exact:true}).fill('gate-key'); await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),gateBefore);
    await search.getByRole('button',{name:'検索',exact:true}).click(); await cards.first().click();
    await search.getByRole('button',{name:'認証',exact:true}).click(); await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    assert.equal(await search.getAttribute('aria-label'),'Civitai Search'); assert.equal(await cards.count(),0,'authentication changes discard previous result ownership');
    await search.getByRole('button',{name:'認証',exact:true}).click(); await auth.getByRole('button',{name:'認証解除',exact:true}).click(); await auth.getByText('未認証',{exact:true}).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await cards.first().isVisible(),false); assert.equal(await search.getAttribute('aria-label'),'Civitai Search');
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    const queriesBeforeCacheGate = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>window.open());
    await search.getByText('civitai.redで検索するには認証が必要です。右上の「認証」からAPIキーを登録してください。',{exact:true}).waitFor();
    assert.equal(await cards.count(),0,'cached red results stay unrendered while unauthenticated');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),queriesBeforeCacheGate);
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // Slow pre-auth status cannot undo a new successful authentication.
    await page.evaluate(()=>{window.node=window.makeNode();window.deferAuthStatus=true;window.releaseAuthStatus=null;window.open();}); await page.waitForFunction(()=>window.releaseAuthStatus);
    await search.getByRole('button',{name:'認証',exact:true}).click(); await auth.getByLabel('Civitai APIキー',{exact:true}).fill('latest-key'); await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    await page.evaluate(()=>window.releaseAuthStatus()); await page.waitForTimeout(20); assert.equal(await search.getByRole('button',{name:'検索',exact:true}).isDisabled(),false);
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // A late red status response cannot block anonymous com after a host change.
    await page.evaluate(()=>{window.node=window.makeNode();window.authenticated=false;window.deferAuthStatus=true;window.releaseAuthStatus=null;window.open();}); await page.waitForFunction(()=>window.releaseAuthStatus);
    await search.getByRole('combobox',{name:'接続先',exact:true}).selectOption('civitai.com'); await cards.first().waitFor();
    await page.evaluate(()=>window.releaseAuthStatus()); await page.waitForTimeout(20); assert.equal(await search.getByRole('button',{name:'検索',exact:true}).isDisabled(),false);
    await page.evaluate(()=>{window.node.sceneCivitaiSearchCleanup();window.authenticated=true;});
    // Search 401 uses authentication plus a manual re-search and the original snapshot.
    await page.evaluate(()=>{window.node=window.makeNode();window.failSearchAuth=true;window.open();});
    const searchFailure = page.getByRole('dialog',{name:'検索に失敗しました',exact:true}); await searchFailure.waitFor();
    await searchFailure.getByRole('button',{name:'認証',exact:true}).click(); await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    await searchFailure.getByText('認証しました。再検索してください。',{exact:true}).waitFor();
    await searchFailure.getByRole('button',{name:'再検索',exact:true}).click(); await cards.first().waitFor();
    // Failed replacement search resumes lazy gallery loading on the retained offscreen grid.
    assert.equal(await cards.last().locator('img').count(),0);
    await search.getByRole('searchbox',{name:'検索語'}).fill('failed new query'); await page.evaluate(()=>window.failSearch=true);
    await search.getByRole('button',{name:'検索',exact:true}).click(); await failure.waitFor(); await page.keyboard.press('Escape');
    const bottomBefore = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/gallery?')&&new URL(call.path,'http://fixture').searchParams.get('version_id')==='40').length);
    await search.locator('.pc-civitai-results').evaluate(node=>node.scrollTop=node.scrollHeight); await cards.last().locator('img').waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/gallery?')&&new URL(call.path,'http://fixture').searchParams.get('version_id')==='40').length),bottomBefore+1);
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // Authentication discards old search/options replies while retaining draft filters until real categories load.
    await page.evaluate(()=>{window.node=window.makeNode();window.node.properties.scene_civitai={category:'Legacy'};window.categories=['Legacy'];window.deferOptions=true;window.releaseOptions=null;window.open();});
    await page.waitForFunction(()=>window.releaseOptions);
    const optionsPendingSearches = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await search.getByRole('button',{name:'検索',exact:true}).click();
    await page.waitForTimeout(20);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),optionsPendingSearches,'initial and manual search both wait for the shared options request');
    await search.getByRole('button',{name:'認証',exact:true}).click(); await page.evaluate(()=>window.categories=['Style','Action']);
    await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.querySelector('select[aria-label="Category"]').value==='');
    await page.evaluate(()=>window.releaseOptions()); await page.waitForTimeout(20);
    assert.equal(await cards.count(),0,'a search started before authentication cannot restore old results');
    assert.deepEqual(await search.getByRole('combobox',{name:'Category',exact:true}).locator('option').evaluateAll(nodes=>nodes.map(node=>node.value)),['','Style','Action']);
    await search.getByRole('combobox',{name:'Category',exact:true}).selectOption('Style'); await cards.first().waitFor();
    await page.evaluate(()=>{window.deferSearch=true;window.releaseSearch=null;});
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseSearch);
    await search.getByRole('button',{name:'認証',exact:true}).click(); await auth.getByRole('button',{name:'認証',exact:true}).click(); await auth.waitFor({state:'detached'});
    await page.evaluate(()=>window.releaseSearch()); await page.waitForTimeout(20); assert.equal(await cards.count(),0,'authentication discards a previously started search');

    await search.getByRole('button',{name:'認証',exact:true}).click(); await page.evaluate(()=>window.categories=[]);
    await auth.getByRole('button',{name:'認証解除',exact:true}).click(); await auth.getByText('未認証',{exact:true}).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await search.getByRole('combobox',{name:'Category',exact:true}).inputValue(),'Style','empty unauthenticated category lists preserve the draft');
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    await page.evaluate(()=>{window.authenticated=true;window.categories=null;});
    // Configured initial loads and host changes search only after official options normalize saved filters.
    await page.evaluate(()=>{window.node=window.makeNode();window.node.properties.scene_civitai={category:'Removed category',model_type:'Removed type'};window.open();}); await cards.first().waitFor();
    assert.equal(await search.getByRole('combobox',{name:'Category',exact:true}).inputValue(),'');
    assert.equal(await search.getByRole('combobox',{name:'Model Type',exact:true}).inputValue(),'Checkpoint');
    const normalizedInitial = await page.evaluate(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.toString());
    assert.match(normalizedInitial,/category=$/);assert.match(normalizedInitial,/model_type=Checkpoint/);assert.doesNotMatch(normalizedInitial,/Removed/);
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    await page.evaluate(()=>{window.node=window.makeNode();window.node.properties.scene_civitai={category:'Style'};window.categoriesByHost={'civitai.red':['Style'],'civitai.com':['Concept']};window.modelTypesByHost={'civitai.com':['LORA']};window.open();}); await cards.first().waitFor();
    const beforeHostWait = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>{window.deferOptions=true;window.releaseOptions=null;}); await search.getByRole('combobox',{name:'接続先',exact:true}).selectOption('civitai.com'); await page.waitForFunction(()=>window.releaseOptions);
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForTimeout(20);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),beforeHostWait,'host/manual search cannot run ahead of delayed host options');
    await page.evaluate(()=>window.releaseOptions()); await page.waitForFunction(()=>window.calls.filter(call=>call.path.includes('/search?')).length>0&&new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('host')==='civitai.com');
    await page.waitForFunction(()=>!document.querySelector('.pc-civitai-results').inert);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),beforeHostWait+1,'waiting automatic/manual intents share options and submit only the current search');
    assert.equal(await search.getByRole('combobox',{name:'Category',exact:true}).inputValue(),'');
    assert.equal(await page.evaluate(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('category')),'');
    // Reopening cached results can normalize an obsolete draft without silently re-searching.
    await search.getByRole('combobox',{name:'Category',exact:true}).selectOption('Concept'); await page.waitForFunction(()=>!document.querySelector('.pc-civitai-results').inert);
    await page.evaluate(()=>{window.node.sceneCivitaiSearchCleanup();window.node.properties.scene_civitai={};});
    // Normalize a cached obsolete draft without silently re-running the successful search.
    await page.evaluate(()=>{window.categoriesByHost=null;window.modelTypesByHost=null;window.node=window.makeNode();window.node.properties.scene_civitai={category:'Style'};window.open();}); await cards.first().waitFor();
    const cachedConditionSearches = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await search.getByRole('combobox',{name:'Category',exact:true}).evaluate(node=>{const option=document.createElement('option');option.value='obsolete draft';option.textContent='obsolete draft';node.append(option);node.value=option.value;});
    await page.keyboard.press('Escape'); await page.evaluate(()=>window.open()); await cards.first().waitFor();
    await page.waitForFunction(()=>document.querySelector('select[aria-label="Category"]').value==='');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),cachedConditionSearches);
    await search.getByText('前回成功した条件の検索結果',{exact:true}).waitFor();
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // An older search cannot publish while a new host is still waiting for options.
    for (const optionsFail of [false,true]) {
    await page.evaluate(()=>{window.node=window.makeNode();window.node.properties.scene_civitai={query:'stable baseline'};window.open();}); await cards.first().waitFor();
    await search.getByRole('searchbox',{name:'検索語'}).fill('obsolete red response'); await page.evaluate(()=>{window.deferSearch=true;window.releaseSearch=null;});
    await search.getByRole('button',{name:'検索',exact:true}).click(); await page.waitForFunction(()=>window.releaseSearch);
    const beforeOldHostRelease = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>{window.deferOptions=true;window.releaseOptions=null;}); await search.getByRole('combobox',{name:'接続先',exact:true}).selectOption('civitai.com'); await page.waitForFunction(()=>window.releaseOptions);
    assert.equal(await search.locator('.pc-civitai-results').evaluate(node=>node.inert),false,'retained successful results remain usable during option preparation');
    await page.evaluate(()=>window.releaseSearch()); await page.waitForTimeout(20);
    assert.match(await cards.first().locator('strong').textContent(),/stable baseline/);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),beforeOldHostRelease);
    await cards.first().click(); assert.equal(await search.getAttribute('aria-label'),'Civitai Detail'); await detail.getByRole('button',{name:'戻る',exact:true}).click();
    await page.evaluate(optionsFail=>{window.failOptionsAfterWait=optionsFail;window.releaseOptions();},optionsFail);
    if (optionsFail) { await failure.waitFor(); await page.keyboard.press('Escape'); assert.match(await cards.first().locator('strong').textContent(),/stable baseline/); assert.equal(await search.locator('.pc-civitai-results').evaluate(node=>node.inert),false); await cards.first().click(); assert.equal(await search.getAttribute('aria-label'),'Civitai Detail'); await detail.getByRole('button',{name:'戻る',exact:true}).click(); assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),beforeOldHostRelease); }
    else {
    await page.waitForFunction(()=>!document.querySelector('.pc-civitai-results').inert);
    await page.waitForFunction(()=>window.calls.filter(call=>call.path.includes('/search?')).length>0&&new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('host')==='civitai.com');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),beforeOldHostRelease+1);
    }
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    }
    // Failed options never start a search; retrying options alone does not submit one either.
    const optionsFailureSearches = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.evaluate(()=>{window.node=window.makeNode();window.failOptions=true;window.open();}); await failure.waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),optionsFailureSearches);
    await failure.getByRole('button',{name:'再試行',exact:true}).click();
    await search.getByRole('combobox',{name:'Category',exact:true}).locator('option[value="Style"]').waitFor({state:'attached'});
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),optionsFailureSearches);
    await search.getByRole('button',{name:'検索',exact:true}).click(); await cards.first().waitFor();
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // Relevancy remains a distinct saved UI value while the backend omits the upstream sort parameter.
    await page.evaluate(()=>{window.node=window.makeNode();window.open();}); await cards.first().waitFor();
    assert.equal(await search.getByRole('combobox',{name:'並び順',exact:true}).inputValue(),'Most Downloaded');
    await search.getByRole('combobox',{name:'並び順',exact:true}).selectOption('Relevancy');
    await page.waitForFunction(()=>new URL(window.calls.filter(call=>call.path.includes('/search?')).at(-1).path,'http://fixture').searchParams.get('sort')==='Relevancy');
    await page.waitForFunction(()=>!document.querySelector('.pc-civitai-results').inert);
    const searchesBeforeRelevancyReopen = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length);
    await page.keyboard.press('Escape'); await page.evaluate(()=>window.open()); await cards.first().waitFor();
    assert.equal(await search.getByRole('combobox',{name:'並び順',exact:true}).inputValue(),'Relevancy');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/search?')).length),searchesBeforeRelevancyReopen);
    await page.evaluate(()=>window.node.sceneCivitaiSearchCleanup());
    // Unknown image IDs use the existing public metadata without inventing a lookup or unsafe link.
    const imagesBefore = await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/image?')).length);
    await page.evaluate(()=>{window.local();window.noID();});
    const noID = page.getByRole('dialog',{name:'Civitai Image #10',exact:true});
    await noID.getByText('fallback positive',{exact:true}).waitFor();
    await noID.getByText('fallback negative',{exact:true}).waitFor();
    assert.deepEqual(await noID.locator('.pc-civitai-generation-data > p').allTextContents(),['width: 600','height: 0','createdAt: preview date','seed: 0']);
    assert.equal(await noID.locator('pre > code').count(),2);
    assert.doesNotMatch(await noID.textContent(),/workflow|nodes|bad/);
    assert.deepEqual(await noID.locator('a').evaluateAll(links=>links.map(link=>link.href)),['https://civitai.red/models/4?modelVersionId=12','https://civitai.red/models/5?modelVersionId=14','https://civitai.red/models/6','https://civitai.red/models/7','https://civitai.red/models/8','https://civitai.red/models/9','https://civitai.red/models/10?modelVersionId=20','https://civitai.red/models/11']);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.includes('/image?')).length),imagesBefore);
    await noID.locator('..').click({position:{x:2,y:2}});
    assert.equal(await noID.count(),0); assert.equal(await page.locator('[role="dialog"][aria-label="LoRA 詳細確認"]').count(),1, JSON.stringify(await page.locator('[role="dialog"]').evaluateAll(nodes=>nodes.map(node=>({title:node.getAttribute('aria-label'),inert:node.parentElement.inert})))));
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{window.local();window.detail();});
    const local = page.getByRole('dialog',{name:'LoRA 詳細確認',exact:true}), localDetail = page.getByRole('dialog',{name:'Civitai Detail',exact:true});
    await localDetail.locator('.pc-civitai-metadata').waitFor();
    await assertDescriptionFormatting(localDetail);
    await localDetail.getByRole('button',{name:'Civitai Image #1',exact:true}).click();
    await page.getByRole('dialog',{name:'Civitai Image #1',exact:true}).waitFor();
    await page.evaluate(()=>window.localParent.dismiss());
    assert.equal(await page.getByRole('dialog').count(),0,'parent dismissal cascades through detail/image');
    // API authentication errors from a user-opened Detail/Image/gallery share explicit authentication and retry.
    async function authenticateRequest() {
        const failed=page.getByRole('dialog',{name:'取得に失敗しました',exact:true});await failed.waitFor();
        await failed.getByRole('button',{name:'認証',exact:true}).click();
        await auth.getByLabel('Civitai APIキー',{exact:true}).fill('metadata-fixture');
        const before=await page.evaluate(()=>window.calls.length);
        await auth.getByRole('button',{name:'認証',exact:true}).click();await auth.waitFor({state:'detached'});
        assert.equal(await page.evaluate(()=>window.calls.length),before+1,'authentication does not repeat the failed operation');
        return failed;
    }
    await page.evaluate(()=>{window.failDetailAuth=true;window.local();window.detail();});
    let failedMetadata=await authenticateRequest();
    await page.evaluate(()=>window.failDetailAuth=false);await failedMetadata.getByRole('button',{name:'再試行',exact:true}).click();
    const standalone=page.getByRole('dialog',{name:'Civitai Detail',exact:true});await standalone.locator('h2').getByText('Model 1',{exact:false}).waitFor();
    await page.evaluate(()=>window.failImageAuth=true);await standalone.getByRole('button',{name:'Civitai Image #1',exact:true}).click();
    failedMetadata=await authenticateRequest();await failedMetadata.getByRole('button',{name:'再試行',exact:true}).click();
    failedMetadata=await authenticateRequest();
    assert.equal(await page.getByRole('dialog',{name:'Civitai Image #1',exact:true}).locator('.pc-civitai-generation-data > p').filter({hasText:'生成情報を取得できませんでした'}).count(),1,'repeated 401 reuses the one status node');
    await page.evaluate(()=>window.failImageAuth=false);await failedMetadata.getByRole('button',{name:'再試行',exact:true}).click();
    await page.getByRole('dialog',{name:'Civitai Image #1',exact:true}).getByText('positive only <script>text<'+'/script>',{exact:true}).waitFor();
    await page.evaluate(()=>window.localParent.dismiss());
    await page.evaluate(()=>{window.node=window.makeNode();window.failGalleryAuth=true;window.open();});
    await cards.first().getByText('画像の取得には認証が必要です。右上の認証から登録してください。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog',{name:'取得に失敗しました',exact:true}).count(),0,'background gallery failures never open multiple auth popups');
    await cards.first().click();failedMetadata=await authenticateRequest();
    await page.evaluate(()=>window.failGalleryAuth=false);await failedMetadata.getByRole('button',{name:'再試行',exact:true}).click();
    await detail.getByRole('button',{name:'Civitai Image #1',exact:true}).waitFor();await page.keyboard.press('Escape');

    // Actual selected local paths, rather than provenance alone, determine the green card.
    await page.evaluate(()=>{window.node=window.makeNode();window.acquiredItems=true;window.node.widgets.find(widget=>widget.name==='lora_name').value='folder\\1.safetensors';window.open();});
    await cards.first().waitFor();
    assert.equal(await cards.first().evaluate(node=>node.classList.contains('pc-lora-selected')),true);
    await cards.first().click();await detail.getByRole('button',{name:'戻る',exact:true}).click();
    assert.equal(await cards.first().evaluate(node=>node.classList.contains('pc-lora-selected')),true);
    await page.keyboard.press('Escape');await page.evaluate(()=>window.open());await cards.first().waitFor();
    assert.equal(await cards.first().evaluate(node=>node.classList.contains('pc-lora-selected')),true);
    await cards.first().click();await detail.getByRole('button',{name:'取得',exact:true}).click();
    await page.evaluate(()=>{window.fileExists=true;window.existingDifferent=true;window.collisionBefore=JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions});});
    await destination.getByRole('button',{name:'取得',exact:true}).click();
    const exists=page.getByRole('dialog',{name:'既に存在します。再取得しますか？',exact:true});await exists.waitFor();
    assert.deepEqual(await exists.locator('.pc-civitai-download-actions button').allTextContents(),['キャンセル','選択のみ','再取得']);
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.existing_action),'ask');
    await exists.getByRole('button',{name:'キャンセル',exact:true}).click();
    assert.equal(await destination.getAttribute('aria-busy'),'false');assert.doesNotMatch(await destination.textContent(),/取得中…/);
    assert.equal(await destination.locator('progress').isVisible(),false);
    assert.equal(await page.evaluate(()=>JSON.stringify({widgets:window.node.widgets,properties:window.node.properties,transactions:window.transactions})),await page.evaluate(()=>window.collisionBefore));
    await destination.getByRole('button',{name:'取得',exact:true}).click();await exists.waitFor();await exists.getByRole('button',{name:'選択のみ',exact:true}).click();await destination.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.existing_action),'select');
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='positive').value),'manual');
    assert.deepEqual(await page.evaluate(()=>window.node.properties),{},'different local bytes do not acquire the Civitai identity or triggers');
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='lora_name').value),'folder/fixture.safetensors');
    assert.equal(await page.evaluate(()=>window.progressListeners.size),0);
    // Replace keeps the user's initial action and directory, and unlocks after completion.
    await detail.getByRole('button',{name:'取得',exact:true}).click();await directory.fill('a/b');await destination.getByRole('button',{name:'取得して選択',exact:true}).click();await exists.waitFor();
    await exists.getByRole('button',{name:'再取得',exact:true}).click();await destination.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.existing_action),'replace');
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.path.endsWith('/download')).at(-1).body.directory),'a/b');
    assert.equal(await page.evaluate(()=>window.node.widgets.find(widget=>widget.name==='positive').value),'manual');
    await assertPromptTextsUnchanged();
    assert.deepEqual(await page.evaluate(()=>window.node.properties.scene_civitai.managed_triggers),[]);
    await detail.getByRole('button',{name:'戻る',exact:true}).click();assert.equal(await cards.first().evaluate(node=>node.classList.contains('pc-lora-selected')),true);
    await page.evaluate(()=>{window.node.sceneCivitaiSearchCleanup();window.acquiredItems=false;window.fileExists=false;});

    // A delayed collision belongs to its download modal, not a newer independent root.
    await page.evaluate(()=>{window.node=window.makeNode();window.fileExists=true;window.oldCollisionNode=window.node;window.oldCollisionRoot=window.open();});
    await cards.first().click();await detail.getByRole('button',{name:'取得',exact:true}).click();
    await page.evaluate(()=>{window.deferDownload=true;window.releaseDownload=null;});
    await destination.getByRole('button',{name:'取得',exact:true}).click();await page.waitForFunction(()=>window.releaseDownload);
    await page.evaluate(()=>{
        const old=window.oldCollisionNode;window.node=window.makeNode();window.node.id=2;
        window.graph.getNodeById=id=>id===old.id?old:window.node;
        window.independentRoot=window.open();window.releaseDownload();
    });
    await exists.waitFor();await page.evaluate(()=>window.oldCollisionRoot.dismiss());
    assert.equal(await exists.count(),0);assert.equal(await destination.count(),0);
    assert.equal(await page.locator('.pc-civitai-search-dialog').count(),1,'closing the old collision parent preserves the new independent search');
    assert.equal(await page.locator('.pc-civitai-search-dialog').evaluate(node=>node.parentElement.inert),false);
    assert.equal(await page.evaluate(()=>window.progressListeners.size),0);
    await page.evaluate(()=>{window.independentRoot.dismiss();window.fileExists=false;window.graph.getNodeById=()=>window.node;});

    assert.deepEqual(errors, []);
    console.log('Civitai gallery sharing, responsive cards, nested image data, auth/retry and in-session search restoration passed. Screenshots: '+screenshots);
} finally { await browser.close(); await new Promise(done=>server.close(done)); }
